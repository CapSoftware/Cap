//! Who is who at the end of a meeting: the speaker-embedding labels decide
//! where speech, echoes and the call's leak into the microphone are, and who
//! is who; the Nemotron voices (see `nemotron`) correct the count where they
//! hear a track's people differently.
//!
//! Per track, each existing speaker id gets the Nemotron voice covering most
//! of its non-echo speech; voices are counted over that speech only (the
//! call's leak into the microphone is not a person). People count with at
//! least `BIG_MS` of speech, or `PERSON_SHARE` of the track's speech on a
//! track too short for that (never under `MIN_PERSON_MS`): in a 30 s meeting
//! nobody but the main talker reaches 10 s.
//! - More voices than ids: a voice of at least `NEW_VOICE_MS` that is nobody's
//!   main voice is cut out of the id holding most of it (if it is at least
//!   `P_SPLIT` of that id): someone had been folded into someone else. At
//!   most as many as Nemotron hears more people than there are ids, biggest
//!   first, so a track never ends with more people than the model heard.
//! - Fewer voices than ids: a minor id (under `MINOR_MS` and `MINOR_SHARE` of
//!   the track) whose speech is at least `P_MERGE` one voice joins the biggest
//!   id with that main voice: a fragment of a person. Bigger ids never merge:
//!   on codec-degraded call audio Nemotron hears fewer people than there are,
//!   and merging two real people is the worst error.
//! - Equal counts: nothing moves.
//!
//! Echo spans never move. A track whose model filled all its voices keeps the
//! old labels (the model holds 8 voices per track), as does a track it never
//! heard.

use std::collections::{BTreeMap, HashMap};

use crate::nemotron::{TrackVoices, track_slot};
use crate::{FinalPass, Span, SpeakerId, SpeakerInfo, Track};

/// Speech a Nemotron voice needs before it may become a new person.
pub const NEW_VOICE_MS: u64 = 10_000;
/// Speech an id or a voice needs to count as a person on its track.
pub const BIG_MS: u64 = 10_000;
/// Share of the holder's speech a new voice must hold to be cut out.
pub const P_SPLIT: f64 = 0.2;
/// Share of a fragment's speech one voice must hold for it to merge.
pub const P_MERGE: f64 = 0.8;
/// A fragment: less speech than this, and less than `MINOR_SHARE` of its track.
pub const MINOR_MS: u64 = 60_000;
pub const MINOR_SHARE: f64 = 0.15;
/// On a short track a person needs this share of its speech (at most
/// `BIG_MS`, so tracks with 66.7 s of speech or more use `BIG_MS` as before).
pub const PERSON_SHARE: f64 = 0.15;
/// Least speech anyone counts as a person with, however short the track.
pub const MIN_PERSON_MS: u64 = 3_000;

/// Speech an id or a voice needs to count as a person on a track holding
/// `track_ms` of speech.
pub fn person_ms(track_ms: u64) -> u64 {
    ((track_ms as f64 * PERSON_SHARE) as u64).clamp(MIN_PERSON_MS, BIG_MS)
}

/// A microphone voice heard this share of its time while the call is talking
/// (the call's spans widened by `CALL_SLACK_MS`) is chatter or the call in
/// the room, never the user: the same test the speaker model's end-of-meeting
/// choice of the user makes.
const HEARD_WITH_CALL: f64 = 0.6;
const CALL_SLACK_MS: u64 = 1_000;

/// Shortest piece a microphone span is cut into.
const MIN_PIECE_MS: u64 = 300;
const SPEAKERS: usize = crate::nemotron::cache::SPEAKERS;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HybridStats {
    pub relabelled_ms: u64,
    pub new_voices: u32,
    pub merged_ids: u32,
    pub tracks_kept: u32,
}

pub fn apply(pass: &mut FinalPass, voices: &[TrackVoices; 2]) -> HybridStats {
    let mut stats = HybridStats::default();
    let mut next_id = pass
        .speakers
        .iter()
        .map(|s| s.id.0)
        .chain(pass.merged.iter().flat_map(|(a, b)| [a.0, b.0]))
        .chain(pass.segments.iter().flat_map(|s| s.spans.iter().map(|sp| sp.speaker.0)))
        .max()
        .unwrap_or(0)
        + 1;
    for track in [Track::Mic, Track::System] {
        let tv = &voices[track_slot(track)];
        let used = tv.voices();
        if tv.frames() == 0 || used == 0 || used >= SPEAKERS {
            stats.tracks_kept += 1;
            continue;
        }
        relabel_track(pass, tv, track, &mut next_id, &mut stats);
    }
    recount(pass);
    stats
}

fn relabel_track(pass: &mut FinalPass, tv: &TrackVoices, track: Track, next_id: &mut u32, stats: &mut HybridStats) {
    // speech and Nemotron voices of each id on this track
    let mut speech: HashMap<SpeakerId, u64> = HashMap::new();
    let mut share: HashMap<SpeakerId, [u64; SPEAKERS]> = HashMap::new();
    for seg in pass.segments.iter().filter(|s| s.track == track) {
        for sp in seg.spans.iter().filter(|s| !s.echo && s.end_ms > s.start_ms) {
            *speech.entry(sp.speaker).or_default() += sp.end_ms - sp.start_ms;
            let c = tv.cover(sp.start_ms, sp.end_ms);
            let e = share.entry(sp.speaker).or_insert([0; SPEAKERS]);
            for v in 0..SPEAKERS {
                e[v] += c[v];
            }
        }
    }
    // voices over this track's non-echo speech only
    let mut size = [0u64; SPEAKERS];
    for c in share.values() {
        for v in 0..SPEAKERS {
            size[v] += c[v];
        }
    }
    let person = person_ms(speech.values().sum());
    let n_app = speech.values().filter(|&&n| n >= person).count();
    let n_nem = size.iter().filter(|&&n| n >= person).count();
    let main_of = |c: &[u64; SPEAKERS]| -> Option<usize> {
        let (v, n) = c.iter().enumerate().max_by_key(|(v, n)| (**n, std::cmp::Reverse(*v)))?;
        (*n > 0).then_some(v)
    };
    let share_of = |c: &[u64; SPEAKERS], v: usize| -> f64 {
        let total: u64 = c.iter().sum();
        if total == 0 { 0.0 } else { c[v] as f64 / total as f64 }
    };
    let mut ids: Vec<SpeakerId> = share.keys().copied().collect();
    ids.sort();
    if n_nem < n_app {
        // fragments of one person
        let track_ms: u64 = speech.values().sum::<u64>().max(1);
        let mut groups: BTreeMap<usize, Vec<SpeakerId>> = BTreeMap::new();
        for id in &ids {
            let c = &share[id];
            if let Some(v) = main_of(c).filter(|&v| share_of(c, v) >= P_MERGE) {
                groups.entry(v).or_default().push(*id);
            }
        }
        for members in groups.values().filter(|m| m.len() > 1) {
            let keep = *members.iter().max_by_key(|id| (speech[*id], std::cmp::Reverse(id.0))).unwrap();
            for &old in members.iter().filter(|id| **id != keep) {
                let minor = speech[&old] < MINOR_MS && (speech[&old] as f64) < MINOR_SHARE * track_ms as f64;
                if !minor {
                    continue;
                }
                for seg in pass.segments.iter_mut().filter(|s| s.track == track) {
                    for sp in seg.spans.iter_mut().filter(|s| !s.echo && s.speaker == old) {
                        stats.relabelled_ms += sp.end_ms.saturating_sub(sp.start_ms);
                        sp.speaker = keep;
                    }
                }
                pass.merged.push((old, keep));
                stats.merged_ids += 1;
                if pass.user == Some(old) {
                    pass.user = Some(keep);
                }
            }
        }
    } else if n_nem > n_app {
        // someone folded into someone else
        let mains: Vec<Option<usize>> = ids.iter().map(|id| main_of(&share[id])).collect();
        let mut candidates: Vec<usize> = (0..SPEAKERS)
            .filter(|&v| size[v] >= NEW_VOICE_MS.min(person) && !mains.contains(&Some(v)))
            .collect();
        candidates.sort_by_key(|&v| (std::cmp::Reverse(size[v]), v));
        let mut room = n_nem - n_app;
        for v in candidates {
            if room == 0 {
                break;
            }
            let Some(&holder) = ids.iter().max_by_key(|id| (share[*id][v], std::cmp::Reverse(id.0))) else {
                continue;
            };
            if share_of(&share[&holder], v) < P_SPLIT {
                continue;
            }
            let new = SpeakerId(*next_id);
            *next_id += 1;
            stats.new_voices += 1;
            room -= 1;
            for seg in pass.segments.iter_mut().filter(|s| s.track == track) {
                let mut out: Vec<Span> = Vec::with_capacity(seg.spans.len());
                for sp in std::mem::take(&mut seg.spans) {
                    if sp.echo || sp.speaker != holder || sp.end_ms <= sp.start_ms {
                        out.push(sp);
                        continue;
                    }
                    let pieces = if track == Track::Mic { cut(tv, sp.start_ms, sp.end_ms) } else { Vec::new() };
                    if pieces.len() > 1 {
                        for (a, b, pv) in pieces {
                            let speaker = if pv == Some(v) { new } else { holder };
                            if speaker == new {
                                stats.relabelled_ms += b - a;
                            }
                            out.push(Span { start_ms: a, end_ms: b, speaker, echo: false });
                        }
                    } else {
                        let c = tv.cover(sp.start_ms, sp.end_ms);
                        let moved = main_of(&c) == Some(v);
                        if moved {
                            stats.relabelled_ms += sp.end_ms - sp.start_ms;
                        }
                        out.push(Span { speaker: if moved { new } else { holder }, ..sp });
                    }
                }
                seg.spans = join_spans(out);
            }
            // The user's id held two voices: the user stays with the part
            // that talks when the call is quiet, not with chatter heard over it.
            if track == Track::Mic
                && pass.user == Some(holder)
                && heard_with_call(pass, holder) >= HEARD_WITH_CALL
                && heard_with_call(pass, new) < HEARD_WITH_CALL
            {
                pass.user = Some(new);
            }
        }
    }
}

/// Share of a microphone id's speech the call is talking through.
fn heard_with_call(pass: &FinalPass, id: SpeakerId) -> f64 {
    let mut call: Vec<(u64, u64)> = pass
        .segments
        .iter()
        .filter(|s| s.track == Track::System)
        .flat_map(|s| s.spans.iter())
        .filter(|s| !s.echo && s.end_ms > s.start_ms)
        .map(|s| {
            (
                s.start_ms.saturating_sub(CALL_SLACK_MS),
                s.end_ms + CALL_SLACK_MS,
            )
        })
        .collect();
    call.sort_unstable();
    let (mut covered, mut total) = (0u64, 0u64);
    for sp in pass
        .segments
        .iter()
        .filter(|s| s.track == Track::Mic)
        .flat_map(|s| s.spans.iter())
        .filter(|s| !s.echo && s.speaker == id && s.end_ms > s.start_ms)
    {
        total += sp.end_ms - sp.start_ms;
        let mut until = sp.start_ms;
        for &(a, b) in &call {
            if a >= sp.end_ms {
                break;
            }
            let from = a.max(until);
            let to = b.min(sp.end_ms);
            if to > from {
                covered += to - from;
                until = to;
            }
        }
    }
    if total == 0 {
        0.0
    } else {
        covered as f64 / total as f64
    }
}

fn join_spans(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_by_key(|s| (s.start_ms, s.end_ms));
    let mut merged: Vec<Span> = Vec::new();
    for s in spans {
        match merged.last_mut() {
            Some(last) if last.speaker == s.speaker && last.echo == s.echo && last.end_ms >= s.start_ms => {
                last.end_ms = last.end_ms.max(s.end_ms);
            }
            _ => merged.push(s),
        }
    }
    merged
}

/// Pieces of a microphone span where one Nemotron voice holds at least
/// `MIN_PIECE_MS`; silent frames join the piece before them.
fn cut(tv: &TrackVoices, start_ms: u64, end_ms: u64) -> Vec<(u64, u64, Option<usize>)> {
    let turns = tv.turns(start_ms, end_ms);
    let mut runs: Vec<(u64, u64, usize)> = Vec::new();
    for (ms, v) in turns {
        let Some(v) = v else { continue };
        match runs.last_mut() {
            Some((_, e, rv)) if *rv == v => *e = ms + 10,
            _ => runs.push((ms, ms + 10, v)),
        }
    }
    // runs shorter than MIN_PIECE_MS join a neighbour
    let mut kept: Vec<(u64, u64, usize)> = Vec::new();
    for r in runs {
        if r.1 - r.0 < MIN_PIECE_MS {
            if let Some(last) = kept.last_mut() {
                last.1 = r.1;
                continue;
            }
        }
        match kept.last_mut() {
            Some(last) if last.2 == r.2 => last.1 = r.1,
            _ => kept.push(r),
        }
    }
    if kept.len() < 2 {
        return Vec::new();
    }
    let mut out: Vec<(u64, u64, Option<usize>)> = Vec::new();
    for (i, (a, _, v)) in kept.iter().enumerate() {
        let a = if i == 0 { start_ms } else { *a };
        let b = kept.get(i + 1).map_or(end_ms, |n| n.0);
        if b > a {
            out.push((a, b, Some(*v)));
        }
    }
    out
}

/// Speakers list from the rewritten spans.
fn recount(pass: &mut FinalPass) {
    let mut info: BTreeMap<u32, SpeakerInfo> = BTreeMap::new();
    for seg in &pass.segments {
        for s in &seg.spans {
            if s.echo || s.end_ms <= s.start_ms {
                continue;
            }
            let e = info.entry(s.speaker.0).or_insert(SpeakerInfo {
                id: s.speaker,
                track: seg.track,
                first_ms: s.start_ms,
                speech_ms: 0,
                is_user: false,
            });
            e.first_ms = e.first_ms.min(s.start_ms);
            e.speech_ms += s.end_ms - s.start_ms;
        }
    }
    for i in info.values_mut() {
        i.is_user = pass.user == Some(i.id);
    }
    pass.speakers = info.into_values().collect();
}

#[cfg(test)]
mod tests;
