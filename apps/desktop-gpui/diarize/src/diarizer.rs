use std::time::{Duration, Instant};

use crate::cluster::{Centroid, dot, greedy_match, normalize};
use crate::{
    Embed, Error, FinalPass, SegmentLabels, Span, SpeakerId, SpeakerInfo, Track, VoiceProfile,
};

#[cfg(test)]
mod tests;

const SAMPLES_PER_MS: u64 = 16;
const MAX_SPLITS: usize = 8;
const WINDOW_GRID_MS: u64 = 250;
const ECHO_COVERAGE: f64 = 0.6;
const SPLIT_SEEDS: usize = 6;
/// Speech level is kept every 20 ms of each segment, as 0.5 dB steps above
/// -100 dB, to tell the call heard through the speakers from a person.
const LEVEL_MS: u64 = 20;
/// The microphone hears the speakers up to this much after the call track
/// (output and room delay), or up to 100 ms before it: the call track can
/// arrive later than the sound leaves the speakers (about 50 ms measured on
/// a MacBook). Much earlier than that, the call track is the copy instead
/// (the user's voice returned by the far end), which the reverse check
/// below catches.
const LEAK_LAG_FRAMES: (i64, i64) = (-5, 20);
/// A copy is the quieter of the two against its own track's speech: a
/// microphone stretch this much louder (dB, relative to the microphone's
/// usual level) than the call is (relative to the call's) is the original.
const LEAK_LOUDER_DB: f32 = 3.0;
const LEAK_MIN_FRAMES: u64 = 10;
/// Share of a microphone stretch the call must be speaking through for the
/// stretch to be compared with it.
const LEAK_MIN_COVER: f64 = 0.5;
/// Level frames kept per track (about 5.5 hours of speech).
const LEVELS_MAX: usize = 1_000_000;
/// A microphone voice is judged on its speech from this far back that the
/// call's levels can be compared with: mostly the call's rhythm (the share
/// below) and it is the call heard through the speakers, hardly ever and
/// it is a person.
const LEAK_REVIEW_MS: u64 = 120_000;
const LEAK_DECIDE_MS: u64 = 4_000;
/// A stretch that starts this soon after a voice's last one, with no one
/// else in between, carries on that voice's turn.
const SAME_TURN_MS: u64 = 2_000;
/// At the end, a microphone that followed the call through a stretch this
/// long (a sentence, not a word said back) hears the call.
const ECHO_HEARD_MS: u64 = 2_000;
const LEAK_VOICE_SHARE: f64 = 0.8;
const PERSON_DECIDE_MS: u64 = 8_000;
/// A microphone voice heard this long and this share of its reviewed speech
/// while the call is silent, in at least this many of the call's silences,
/// is a person: the speakers only play the call while it speaks. "Silent" is known once the call's levels run this far
/// past the stretch, and means the call speaks through at most
/// `CALL_SILENT_COVER` of it (its delay either side included).
const ALONE_PERSON_SHARE: f64 = 0.25;
const ALONE_PERSON_SILENCES: usize = 2;
const CALL_KNOWN_AFTER_MS: u64 = 1_000;
const CALL_SILENT_COVER: f64 = 0.1;
const PERSON_VOICE_SHARE: f64 = 0.2;
/// At the end, a whole microphone voice heard mostly while the call talks
/// (this share of its speech comparable with the call) whose speech follows
/// the call's levels this closely on average is the call too: what is left
/// of the speakers once someone talks over them.
const LEAK_VOICE_TESTED: f64 = 0.6;
const LEAK_VOICE_MEAN: f32 = 0.45;
/// A minor microphone voice heard this much inside the call's speech is no
/// one new: the call through the speakers, or the user talking over it.
const OVER_CALL_COVERAGE: f64 = 0.9;
const OVER_CALL_MAX_MS: u64 = 60_000;
/// A voice whose transcribed speech holds fewer words a second than this,
/// and well under the track's talker, is laughter, music or noise in a
/// voice of its own, not a person: it folds into the nearest person.
const WORDLESS_RATE: f64 = 1.0;
const WORDLESS_OF_MAIN: f64 = 0.35;
const WORDLESS_MIN_MS: u64 = 5_000;
const WORDLESS_TRANSCRIBED: f64 = 0.6;
/// It folds into the nearest voice that talks: at least this share of the
/// track's best rate.
const TALKER_OF_MAIN: f64 = 0.5;
/// How far back `transcribed` looks for its segment's stretches.
const TRANSCRIBED_LOOKBACK: usize = 2_000;

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// Long segments are embedded in windows this long, `hop_ms` apart.
    pub window_ms: u64,
    pub hop_ms: u64,
    /// Segments up to this long are embedded whole.
    pub whole_max_ms: u64,
    /// Shorter segments are not embedded; they inherit a neighbour's speaker.
    pub min_embed_ms: u64,
    /// Cosine similarity at which a window joins a speaker and refines them.
    pub assign: f32,
    /// Below this similarity to every speaker, a long enough stretch of
    /// speech becomes a new speaker. Between the two it joins the nearest
    /// speaker without refining them.
    pub new_speaker: f32,
    pub new_min_ms: u64,
    /// A new voice is shown as a new person once this much of it arrives in
    /// one go, or once a later stretch of speech confidently matches it.
    /// Until then its speech is shown as the nearest known person, so a
    /// cough or two people talking over each other never flashes a stranger.
    pub confirm_ms: u64,
    /// The microphone usually holds only the user, so new voices there need
    /// stronger evidence.
    pub mic_new_speaker: f32,
    pub mic_new_min_ms: u64,
    /// Final pass: speakers this similar are one person.
    pub merge: f32,
    /// Final pass: speakers with less speech than this fold into their
    /// nearest neighbour when at least `small_merge` similar, and below
    /// `min_speaker_ms` they always do.
    pub small_ms: u64,
    pub small_merge: f32,
    pub min_speaker_ms: u64,
    /// Final pass: a minor voice (less than `fold_ms` and `fold_share` of
    /// its track's speech) this similar to a bigger one is a part of it.
    pub fold_ms: u64,
    pub fold_share: f32,
    pub fold_merge: f32,
    pub refine_rounds: usize,
    /// Final pass: a speaker whose speech falls into two groups this unlike,
    /// each with at least `split_min_ms`, was two people heard as one.
    pub split: f32,
    pub split_min_ms: u64,
    /// Similarity to the voice profile that identifies the user.
    pub profile_match: f32,
    /// A first microphone voice this unlike the profile is someone else.
    pub profile_reject: f32,
    pub enrol_min_ms: u64,
    /// Share of the user's speech allowed to sound unlike the voice being
    /// learnt; above it the meeting had other people on the microphone.
    pub enrol_max_unlike: f64,
    /// A voice is the user by loudness when the microphone hears it this
    /// much louder (dB) than the voice with the most speech, and it has at
    /// least `user_min_ms` and `user_min_share` of the microphone's speech.
    pub user_louder_db: f64,
    pub user_min_ms: u64,
    pub user_min_share: f64,
    /// How far apart in time two tracks' speech may be and still be the
    /// same sound arriving twice.
    pub echo_slack_ms: u64,
    /// Embeddings kept for the final pass; older pieces beyond this keep only
    /// their label, which bounds memory in very long meetings.
    pub max_embeddings: usize,
    /// A microphone stretch whose loudness rises and falls with the call's
    /// this closely (correlation of their levels) is the call coming out of
    /// the speakers, whatever it sounds like after the trip through the room.
    pub leak: f32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            window_ms: 1_500,
            hop_ms: 750,
            whole_max_ms: 3_000,
            min_embed_ms: 500,
            assign: 0.55,
            new_speaker: 0.3,
            new_min_ms: 1_500,
            confirm_ms: 4_000,
            mic_new_speaker: 0.3,
            mic_new_min_ms: 3_000,
            merge: 0.62,
            small_ms: 8_000,
            small_merge: 0.25,
            min_speaker_ms: 1_500,
            fold_ms: 30_000,
            fold_share: 0.1,
            fold_merge: 0.5,
            refine_rounds: 4,
            split: 0.55,
            split_min_ms: 10_000,
            profile_match: 0.5,
            profile_reject: 0.15,
            enrol_min_ms: 30_000,
            enrol_max_unlike: 0.08,
            user_louder_db: 2.0,
            user_min_ms: 8_000,
            user_min_share: 0.15,
            echo_slack_ms: 1_000,
            max_embeddings: 40_000,
            leak: 0.6,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Segment<'a> {
    pub track: Track,
    /// The caller's key for the segment, reported back with its labels.
    pub key: u64,
    pub start_ms: u64,
    pub samples: &'a [f32],
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Stats {
    pub segments: u64,
    pub windows: u64,
    pub embed_calls: u64,
    pub embed_time: Duration,
    pub total_time: Duration,
    pub embeddings_kept: usize,
    /// Windows embedded early by `peek` and reused when the segment closed.
    pub reused_windows: u64,
    /// Windows `peek` embedded (reused or not).
    pub early_windows: u64,
    pub mic_absorbed_ms: u64,
    /// Final pass: whether the Nemotron voices were applied, the speech they
    /// moved to another speaker, the people they added and the ids they merged.
    pub nemotron_applied: bool,
    pub nemotron_relabelled_ms: u64,
    pub nemotron_new_voices: u32,
    pub nemotron_merged_ids: u32,
}

/// Window embeddings of a segment that is still open, computed by `peek`
/// and reused when it closes. A window is only reused when its samples are
/// exactly the ones it was computed from.
struct Early {
    key: u64,
    samples: Vec<f32>,
    windows: Vec<((usize, usize), Vec<f32>)>,
}

impl Early {
    fn get(&self, key: u64, samples: &[f32], (a, b): (usize, usize)) -> Option<&Vec<f32>> {
        if key != self.key || b > samples.len() || b > self.samples.len() {
            return None;
        }
        self.windows
            .iter()
            .find(|(w, _)| *w == (a, b))
            .filter(|_| samples[a..b] == self.samples[a..b])
            .map(|(_, e)| e)
    }
}

struct Cluster {
    id: SpeakerId,
    track: Track,
    centroid: Centroid,
    first_ms: u64,
    speech_ms: u64,
    /// Speech-weighted signal power, for how loud the microphone hears them.
    power_ms: f64,
    confirmed: bool,
    created_key: u64,
    /// Whether this microphone voice is the call coming out of the
    /// speakers; `None` until the call's levels have said.
    leak: Option<bool>,
}

struct Piece {
    track: Track,
    key: u64,
    start_ms: u64,
    end_ms: u64,
    embedding: Option<Vec<f32>>,
    /// The voice this stretch matched, which may still be provisional.
    cluster: Option<SpeakerId>,
    /// The person shown for it.
    speaker: Option<SpeakerId>,
    echo: bool,
    /// Mean signal power of the stretch.
    power: f32,
    /// How closely the stretch follows the call's levels, once known.
    leak: Option<f32>,
    /// Words transcribed in the stretch, once its segment is transcribed.
    words: Option<u32>,
}

impl Piece {
    fn ms(&self) -> u64 {
        self.end_ms.saturating_sub(self.start_ms)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Decision {
    Join(SpeakerId, bool),
    Echo(SpeakerId),
    Unknown,
}

/// One segment's speech level, every `LEVEL_MS` from `first` (in frames
/// from the start of the meeting).
struct Levels {
    first: u64,
    q: Vec<u8>,
}

pub struct MeetingDiarizer {
    config: Config,
    embedder: Box<dyn Embed>,
    profile: Option<VoiceProfile>,
    clusters: Vec<Cluster>,
    pieces: Vec<Piece>,
    next_id: u32,
    user: Option<SpeakerId>,
    embeddings_kept: usize,
    oldest_embedding: usize,
    /// Microphone speech in an unknown voice too short to become anyone,
    /// folded into the nearest speaker.
    mic_absorbed_ms: u64,
    stats: Stats,
    early: [Option<Early>; 2],
    levels: [Vec<Levels>; 2],
    level_frames: [usize; 2],
    /// Each track's level summed over the frames where the other track
    /// speaks too, and their count: the usual level of what is heard while
    /// both are active (on the microphone, the call through the speakers).
    level_sum: [(f64, u64); 2],
    /// Nemotron 3 Diarization on its own thread, when its model is available.
    nemotron: Option<crate::nemotron::NemoRunner>,
    nemotron_error: Option<String>,
    nemotron_voices: Option<[crate::nemotron::TrackVoices; 2]>,
    /// The after-Stop Nemotron pass this meeting's final pass left running.
    late: Option<LateNemotron>,
    /// Where each stretch between device changes starts (ms) and whether the
    /// microphone was already known to repeat the call in it.
    echo_stretches: Vec<(u64, bool)>,
    /// Where a whole window of the microphone followed the call (ms), the
    /// first in each stretch: the speakers are playing the call there.
    heard_live: Vec<u64>,
}

/// Nemotron hearing a finished meeting after Stop (`Schedule::AfterStop`): the
/// final pass went out with the speaker model's labels, and this corrects it
/// once the model is done.
pub struct LateNemotron {
    voices: std::sync::mpsc::Receiver<Result<[crate::nemotron::TrackVoices; 2], String>>,
    pass: FinalPass,
}

impl LateNemotron {
    /// Blocks until Nemotron is done (it works on its own low-priority
    /// thread): the final pass with its corrections, or why there are none.
    pub fn wait(self) -> Result<(FinalPass, crate::hybrid::HybridStats), String> {
        let voices = self.voices.recv().unwrap_or_else(|_| Err("the model thread stopped".into()))?;
        let mut pass = self.pass;
        let stats = crate::hybrid::apply(&mut pass, &voices);
        Ok((pass, stats))
    }
}

impl MeetingDiarizer {
    pub fn new(config: Config, embedder: Box<dyn Embed>, profile: Option<VoiceProfile>) -> Self {
        let profile = profile.filter(|p| p.usable_with(embedder.model_id(), embedder.dim()));
        Self {
            config,
            embedder,
            profile,
            clusters: Vec::new(),
            pieces: Vec::new(),
            next_id: 1,
            user: None,
            embeddings_kept: 0,
            oldest_embedding: 0,
            mic_absorbed_ms: 0,
            stats: Stats::default(),
            early: [None, None],
            levels: [Vec::new(), Vec::new()],
            level_frames: [0, 0],
            level_sum: [(0.0, 0), (0.0, 0)],
            nemotron: None,
            nemotron_error: None,
            nemotron_voices: None,
            late: None,
            echo_stretches: Vec::new(),
            heard_live: Vec::new(),
        }
    }

    /// Lets Nemotron 3 Diarization decide who is who at the end (see
    /// `hybrid`). Every segment pushed from now on is fed to it.
    pub fn set_nemotron(&mut self, model: Box<dyn crate::nemotron::NemoModel>) {
        self.nemotron = Some(crate::nemotron::NemoRunner::start(model));
    }

    /// As `set_nemotron`, on `schedule`: with `AfterStop` the final pass does
    /// not wait for Nemotron, and `take_late` hands over the correction.
    pub fn set_nemotron_with(
        &mut self,
        model: Box<dyn crate::nemotron::NemoModel>,
        schedule: crate::nemotron::Schedule,
        lower_priority: fn(),
    ) {
        self.nemotron = Some(crate::nemotron::NemoRunner::start_with(model, schedule, lower_priority));
    }

    /// Stops an `AfterStop` Nemotron before the final pass, when another
    /// source of its voices (the farm) stands in.
    /// The stretches between the meeting's device changes, each with whether
    /// the call was already heard on the microphone there. At the end the
    /// microphone is judged to hear the call stretch by stretch: speakers then
    /// a headset is two different rooms.
    pub fn set_echo_stretches(&mut self, stretches: &[(u64, bool)]) {
        self.echo_stretches = stretches.to_vec();
    }

    /// The stretch between device changes that holds `ms`, as `[from, until)`
    /// and whether it was already known to hear the call.
    fn echo_stretch(&self, ms: u64) -> (u64, u64, bool) {
        let k = self
            .echo_stretches
            .partition_point(|&(start, _)| start <= ms)
            .saturating_sub(1);
        let (from, heard) = self.echo_stretches.get(k).copied().unwrap_or((0, false));
        let until = self.echo_stretches.get(k + 1).map_or(u64::MAX, |s| s.0);
        (from, until, heard)
    }

    /// Whether the microphone hears the call around `ms`: its stretch was
    /// known to, or a whole window of the microphone followed the call there.
    /// Elsewhere (a headset) nothing on the microphone is the call's echo.
    fn mic_hears_call_at(&self, ms: u64) -> bool {
        let (from, until, heard) = self.echo_stretch(ms);
        heard || {
            let at = self.heard_live.partition_point(|&t| t < from);
            self.heard_live.get(at).is_some_and(|&t| t < until)
        }
    }

    pub fn cancel_after_stop_nemotron(&mut self) {
        if self.nemotron.as_ref().is_some_and(|n| n.schedule() == crate::nemotron::Schedule::AfterStop) {
            self.nemotron = None;
        }
    }

    /// The after-Stop correction the last `finish` left running.
    pub fn take_late(&mut self) -> Option<LateNemotron> {
        self.late.take()
    }

    /// The Nemotron voices the final pass used (mic, system), for diagnostics.
    pub fn nemotron_voices(&self) -> Option<&[crate::nemotron::TrackVoices; 2]> {
        self.nemotron_voices.as_ref()
    }

    /// Why Nemotron was not applied at the end, when it was set and failed.
    pub fn nemotron_error(&self) -> Option<&str> {
        self.nemotron_error.as_deref()
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn stats(&self) -> Stats {
        Stats {
            embeddings_kept: self.embeddings_kept,
            mic_absorbed_ms: self.mic_absorbed_ms,
            ..self.stats
        }
    }

    pub fn user(&self) -> Option<SpeakerId> {
        self.user
    }

    pub fn speakers(&self) -> Vec<SpeakerInfo> {
        self.clusters
            .iter()
            .filter(|c| c.confirmed && c.leak != Some(true))
            .map(|c| SpeakerInfo {
                id: c.id,
                track: c.track,
                first_ms: c.first_ms,
                speech_ms: c.speech_ms,
                is_user: Some(c.id) == self.user,
            })
            .collect()
    }

    /// Labels one closed speech segment. Segments of one track come in time
    /// order while a meeting runs; one transcribed again later (a repair
    /// from the saved audio) is labelled the same way, against the levels
    /// and voices around its own time.
    pub fn push(&mut self, segment: Segment<'_>) -> Result<SegmentLabels, Error> {
        let started = Instant::now();
        self.stats.segments += 1;
        if let Some(n) = &self.nemotron {
            n.push(segment.track, segment.start_ms, segment.samples);
        }
        let early = self.early[track_index(segment.track)].take();
        let result = self.label(segment, early.as_ref());
        self.stats.total_time += started.elapsed();
        result
    }

    /// Who is speaking at the start of a segment that is still open, for its
    /// partial words. Changes nothing the meeting's labels depend on: the
    /// windows it embeds are the ones the segment will use when it closes,
    /// and `push` reuses them, so the segment's labels come out the same and
    /// sooner.
    pub fn peek(&mut self, segment: Segment<'_>) -> Result<Option<SpeakerId>, Error> {
        let track = segment.track;
        let window = (self.config.window_ms * SAMPLES_PER_MS) as usize;
        let hop = (self.config.hop_ms * SAMPLES_PER_MS).max(1) as usize;
        let len = segment.samples.len();
        if len < window {
            return Ok(None);
        }
        let slot = track_index(track);
        let mut early = match self.early[slot].take() {
            Some(e) if e.key == segment.key => e,
            _ => Early {
                key: segment.key,
                samples: Vec::new(),
                windows: Vec::new(),
            },
        };
        let wanted: Vec<(usize, usize)> = (0..)
            .map(|k| (k * hop, k * hop + window))
            .take_while(|&(_, b)| b <= len)
            .collect();
        let missing: Vec<(usize, usize)> = wanted
            .iter()
            .copied()
            .filter(|&w| early.get(segment.key, segment.samples, w).is_none())
            .collect();
        if !missing.is_empty() {
            let slices: Vec<&[f32]> = missing
                .iter()
                .map(|&(a, b)| &segment.samples[a..b])
                .collect();
            let started = Instant::now();
            let embeddings = self.embedder.embed(&slices)?;
            self.stats.embed_time += started.elapsed();
            self.stats.embed_calls += 1;
            self.stats.early_windows += missing.len() as u64;
            early
                .windows
                .retain(|&(w, _)| w.1 <= len && !missing.contains(&w));
            early.windows.extend(missing.into_iter().zip(embeddings));
            early.samples.clear();
            early.samples.extend_from_slice(segment.samples);
        }
        let at = |sample: usize| segment.start_ms + sample as u64 / SAMPLES_PER_MS;
        self.keep_levels(track, segment.start_ms, segment.samples, false);
        let mut labels: Vec<Option<(SpeakerId, bool)>> = wanted
            .iter()
            .map(|&(a, b)| {
                let e = early.get(segment.key, segment.samples, (a, b))?;
                match self.decide(track, e, at(a), at(b)) {
                    Decision::Join(id, _) => self.shown(id, e).map(|id| (id, false)),
                    Decision::Echo(id) => Some((id, true)),
                    Decision::Unknown => self.nearest_confirmed(track, e).map(|id| (id, false)),
                }
            })
            .collect();
        self.forget_levels(track, segment.start_ms);
        self.early[slot] = Some(early);
        smooth(&mut labels);
        Ok(labels
            .into_iter()
            .flatten()
            .find(|(_, echo)| !echo)
            .map(|(id, _)| id))
    }

    /// The words transcribed in a closed segment, by the middle of each
    /// word (ms from the start of the meeting), once its words are final.
    pub fn transcribed(&mut self, track: Track, key: u64, word_ms: &[u64]) {
        let mut found = false;
        for piece in self.pieces.iter_mut().rev().take(TRANSCRIBED_LOOKBACK) {
            if piece.track != track || piece.key != key {
                if found {
                    break;
                }
                continue;
            }
            found = true;
            let (a, b) = (piece.start_ms, piece.end_ms);
            piece.words = Some(word_ms.iter().filter(|&&m| m >= a && m < b).count() as u32);
        }
    }

    fn nearest_confirmed(&self, track: Track, embedding: &[f32]) -> Option<SpeakerId> {
        self.clusters
            .iter()
            .filter(|c| c.track == track && c.confirmed && c.leak != Some(true))
            .max_by(|a, b| {
                a.centroid
                    .similarity(embedding)
                    .total_cmp(&b.centroid.similarity(embedding))
            })
            .map(|c| c.id)
    }

    fn label(
        &mut self,
        segment: Segment<'_>,
        early: Option<&Early>,
    ) -> Result<SegmentLabels, Error> {
        let track = segment.track;
        let len = segment.samples.len() as u64;
        let end_ms = segment.start_ms + len / SAMPLES_PER_MS;
        self.keep_levels(track, segment.start_ms, segment.samples, true);
        if len / SAMPLES_PER_MS < self.config.min_embed_ms {
            let speaker = self.previous_speaker(track, segment.start_ms);
            self.pieces.push(Piece {
                track,
                key: segment.key,
                start_ms: segment.start_ms,
                end_ms,
                embedding: None,
                cluster: speaker,
                speaker,
                echo: false,
                power: power(segment.samples),
                leak: None,
                words: None,
            });
            return Ok(SegmentLabels {
                track,
                key: segment.key,
                spans: speaker
                    .map(|speaker| Span {
                        start_ms: segment.start_ms,
                        end_ms,
                        speaker,
                        echo: false,
                    })
                    .into_iter()
                    .collect(),
            });
        }

        let windows = self.windows(segment.samples.len());
        let early: Vec<Option<&Vec<f32>>> = windows
            .iter()
            .map(|&w| early.and_then(|e| e.get(segment.key, segment.samples, w)))
            .collect();
        let slices: Vec<&[f32]> = windows
            .iter()
            .zip(&early)
            .filter(|(_, e)| e.is_none())
            .map(|(&(a, b), _)| &segment.samples[a..b])
            .collect();
        let mut fresh = if slices.is_empty() {
            Vec::new()
        } else {
            let embed_started = Instant::now();
            let fresh = self.embedder.embed(&slices)?;
            self.stats.embed_time += embed_started.elapsed();
            self.stats.embed_calls += 1;
            fresh
        }
        .into_iter();
        let mut embeddings = Vec::with_capacity(windows.len());
        for e in &early {
            match e {
                Some(e) => {
                    self.stats.reused_windows += 1;
                    embeddings.push((*e).clone());
                }
                None => embeddings.push(
                    fresh
                        .next()
                        .ok_or_else(|| Error::Model("fewer embeddings than windows".into()))?,
                ),
            }
        }
        self.stats.windows += windows.len() as u64;

        let at = |sample: usize| segment.start_ms + sample as u64 / SAMPLES_PER_MS;
        let mut labels: Vec<Option<(SpeakerId, bool)>> = vec![None; windows.len()];
        let mut pending: Vec<usize> = Vec::new();
        let whole = (self.config.window_ms * SAMPLES_PER_MS) as usize;
        for (i, embedding) in embeddings.iter().enumerate() {
            let (a, b) = windows[i];
            if track == Track::Mic
                && b - a >= whole
                && !self.mic_hears_call_at(at(a))
                && self.leak(at(a), at(b)) >= Some(self.config.leak)
            {
                let k = self.heard_live.partition_point(|&t| t < at(a));
                self.heard_live.insert(k, at(a));
            }
            match self.decide(track, embedding, at(a), at(b)) {
                Decision::Join(id, confident) => {
                    self.settle(
                        track,
                        &windows,
                        &embeddings,
                        &mut pending,
                        &mut labels,
                        segment,
                    );
                    labels[i] = Some((id, false));
                    if confident {
                        self.refine_cluster(id, embedding, b - a, segment.key);
                    } else if self.continues(track, id, i, &labels, at(a))
                        && let Some(c) = self
                            .clusters
                            .iter_mut()
                            .find(|c| c.id == id && !c.confirmed && c.created_key != segment.key)
                    {
                        // A voice first heard in a short line is learnt from
                        // the speech that carries straight on from it,
                        // without being shown as someone new on that alone.
                        // Someone else who only sounds a little alike, later,
                        // never moves it.
                        c.centroid.add(
                            embedding,
                            (b - a) as f32 / (SAMPLES_PER_MS as f32 * 1000.0),
                        );
                    }
                }
                Decision::Echo(id) => {
                    self.settle(
                        track,
                        &windows,
                        &embeddings,
                        &mut pending,
                        &mut labels,
                        segment,
                    );
                    labels[i] = Some((id, true));
                }
                Decision::Unknown => pending.push(i),
            }
        }
        self.settle(
            track,
            &windows,
            &embeddings,
            &mut pending,
            &mut labels,
            segment,
        );
        smooth(&mut labels);

        let mut spans: Vec<Span> = Vec::new();
        let mut run_start = 0;
        for i in 0..windows.len() {
            let last = i + 1 == windows.len();
            if !last && labels[i + 1] == labels[i] {
                continue;
            }
            let from = if run_start == 0 {
                0
            } else {
                (windows[run_start - 1].1 + windows[run_start].0) / 2
            };
            let to = if last {
                segment.samples.len()
            } else {
                (windows[i].1 + windows[i + 1].0) / 2
            };
            let mut mean = vec![0.0; self.embedder.dim()];
            for e in &embeddings[run_start..=i] {
                for (m, x) in mean.iter_mut().zip(e) {
                    *m += x;
                }
            }
            normalize(&mut mean);
            let (cluster, echo) = match labels[i] {
                Some((id, echo)) => (Some(id), echo),
                None => (None, false),
            };
            let speaker = match cluster {
                Some(id) if !echo => self.shown(id, &mean),
                other => other,
            };
            let piece = Piece {
                track,
                key: segment.key,
                start_ms: at(from),
                end_ms: if last { end_ms } else { at(to) },
                embedding: Some(mean),
                cluster,
                speaker,
                echo,
                power: power(&segment.samples[from..to]),
                leak: None,
                words: None,
            };
            if let (Some(id), false) = (cluster, echo)
                && let Some(c) = self.clusters.iter_mut().find(|c| c.id == id)
            {
                c.speech_ms += piece.ms();
                c.power_ms += f64::from(piece.power) * piece.ms() as f64;
            }
            if let Some(speaker) = speaker {
                match spans.last_mut() {
                    Some(span) if span.speaker == speaker && span.echo == echo => {
                        span.end_ms = piece.end_ms;
                    }
                    _ => spans.push(Span {
                        start_ms: piece.start_ms,
                        end_ms: piece.end_ms,
                        speaker,
                        echo,
                    }),
                }
            }
            self.pieces.push(piece);
            self.embeddings_kept += 1;
            run_start = i + 1;
        }
        self.review_leaks();
        if track == Track::Mic {
            self.follow_loudest_user();
        }
        self.bound_memory();
        Ok(SegmentLabels {
            track,
            key: segment.key,
            spans,
        })
    }

    /// Whether window `i` of a segment carries straight on from voice `id`:
    /// the window before it was theirs, or (the segment's first window) the
    /// track's last stretch was theirs and ended moments before.
    fn continues(
        &self,
        track: Track,
        id: SpeakerId,
        i: usize,
        labels: &[Option<(SpeakerId, bool)>],
        start_ms: u64,
    ) -> bool {
        if i > 0 {
            return labels[i - 1] == Some((id, false));
        }
        self.pieces
            .iter()
            .rev()
            .find(|p| p.track == track)
            .is_some_and(|p| p.cluster == Some(id) && start_ms <= p.end_ms + SAME_TURN_MS)
    }

    /// The person to show for a stretch matched to `cluster`: itself once
    /// confirmed, otherwise the nearest confirmed person on its track.
    fn shown(&self, cluster: SpeakerId, embedding: &[f32]) -> Option<SpeakerId> {
        let c = self.clusters.iter().find(|c| c.id == cluster)?;
        if c.confirmed {
            return Some(cluster);
        }
        self.clusters
            .iter()
            .filter(|o| o.track == c.track && o.confirmed && o.leak != Some(true))
            .max_by(|a, b| {
                a.centroid
                    .similarity(embedding)
                    .total_cmp(&b.centroid.similarity(embedding))
            })
            .map(|o| o.id)
    }

    /// Windows come in a handful of lengths only: ONNX Runtime keeps about
    /// 8 MB for every distinct input length it has seen and never frees it,
    /// so whole short segments are centre-cropped to a 250 ms grid.
    fn windows(&self, samples: usize) -> Vec<(usize, usize)> {
        let whole = (self.config.whole_max_ms * SAMPLES_PER_MS) as usize;
        if samples <= whole {
            let grid = (WINDOW_GRID_MS * SAMPLES_PER_MS) as usize;
            let kept = (samples / grid * grid).max(samples.min(grid));
            let start = (samples - kept) / 2;
            return vec![(start, start + kept)];
        }
        let window = (self.config.window_ms * SAMPLES_PER_MS) as usize;
        let hop = (self.config.hop_ms * SAMPLES_PER_MS).max(1) as usize;
        let mut out = Vec::new();
        let mut start = 0;
        while start + window < samples {
            out.push((start, start + window));
            start += hop;
        }
        let tail = samples.saturating_sub(window);
        if out.last().is_none_or(|&(a, _)| a < tail) {
            out.push((tail, samples));
        }
        out
    }

    fn decide(&self, track: Track, embedding: &[f32], start_ms: u64, end_ms: u64) -> Decision {
        // The microphone can only echo the call where it hears it.
        let mic_hears_call = || track == Track::Mic && self.mic_hears_call_at(start_ms);
        if mic_hears_call()
            && self.leak(start_ms, end_ms) >= Some(self.config.leak)
            && let Some(id) = self.call_speaker(start_ms, end_ms)
        {
            return Decision::Echo(id);
        }
        let own = self.best(track, embedding);
        let other = self
            .best_overlapping(other_track(track), embedding, start_ms, end_ms)
            .filter(|(id, _)| track == Track::Mic || Some(*id) == self.user);
        // A stretch of the call whose copy the microphone is hearing through
        // the speakers is the call itself, never the user sent back: when
        // the call is louder than the user, its copy can sound like them.
        let call_heard_in_the_room = || {
            track == Track::System && self.heard_leak(start_ms, end_ms) >= Some(self.config.leak)
        };
        if let Some((id, sim)) = other
            && sim >= self.config.assign
            && own.is_none_or(|(_, own)| sim > own)
            && !call_heard_in_the_room()
            && (track == Track::System || mic_hears_call())
        {
            return Decision::Echo(id);
        }
        if let Some((id, sim)) = own
            && sim >= self.new_threshold(track)
            && self
                .clusters
                .iter()
                .any(|c| c.id == id && c.leak == Some(true))
        {
            return Decision::Echo(self.call_speaker(start_ms, end_ms).unwrap_or(id));
        }
        match own {
            Some((id, sim)) if sim >= self.config.assign => Decision::Join(id, true),
            Some((id, sim)) if sim >= self.new_threshold(track) => Decision::Join(id, false),
            _ => Decision::Unknown,
        }
    }

    fn new_threshold(&self, track: Track) -> f32 {
        match track {
            Track::Mic => self.config.mic_new_speaker,
            Track::System => self.config.new_speaker,
        }
    }

    fn new_min_ms(&self, track: Track) -> u64 {
        match track {
            Track::Mic => self.config.mic_new_min_ms,
            Track::System => self.config.new_min_ms,
        }
    }

    fn best(&self, track: Track, embedding: &[f32]) -> Option<(SpeakerId, f32)> {
        self.clusters
            .iter()
            .filter(|c| c.track == track)
            .map(|c| (c.id, c.centroid.similarity(embedding)))
            .max_by(|a, b| a.1.total_cmp(&b.1))
    }

    fn best_overlapping(
        &self,
        track: Track,
        embedding: &[f32],
        start_ms: u64,
        end_ms: u64,
    ) -> Option<(SpeakerId, f32)> {
        let slack = self.config.echo_slack_ms;
        let mut ids: Vec<SpeakerId> = Vec::new();
        for piece in self.pieces.iter().rev() {
            if piece.track != track || piece.echo {
                continue;
            }
            if piece.end_ms + slack < start_ms {
                if piece.end_ms + 60_000 < start_ms {
                    break;
                }
                continue;
            }
            if piece.start_ms > end_ms + slack {
                continue;
            }
            if let Some(id) = piece.speaker
                && !ids.contains(&id)
            {
                ids.push(id);
            }
        }
        self.clusters
            .iter()
            .filter(|c| ids.contains(&c.id))
            .map(|c| (c.id, c.centroid.similarity(embedding)))
            .max_by(|a, b| a.1.total_cmp(&b.1))
    }

    /// Resolves a run of windows unlike every known speaker. On the
    /// microphone the run is first cut where the voice changes, because one
    /// segment can hold several people nobody has heard yet (people in a room
    /// trading turns without a pause, from the first minute). Each long enough part is a
    /// new speaker, or the one an earlier part just became; short parts join
    /// the nearest speaker.
    fn settle(
        &mut self,
        track: Track,
        windows: &[(usize, usize)],
        embeddings: &[Vec<f32>],
        pending: &mut Vec<usize>,
        labels: &mut [Option<(SpeakerId, bool)>],
        segment: Segment<'_>,
    ) {
        if pending.is_empty() {
            return;
        }
        // How much speech a set of windows covers (they overlap).
        let run_ms = |run: &[usize]| {
            let mut covered = 0usize;
            let mut until = 0usize;
            for &i in run {
                let (a, b) = windows[i];
                let from = a.max(until);
                if b > from {
                    covered += b - from;
                    until = b;
                }
            }
            covered as u64 / SAMPLES_PER_MS
        };
        let threshold = self.new_threshold(track);
        // Each window joins the part of this run it sounds most like, so a
        // stray window starts a small part of its own instead of cutting the
        // voice around it into pieces too short to be anyone.
        let mut runs: Vec<(Vec<usize>, Vec<f32>)> = Vec::new();
        for &i in pending.iter() {
            let e = &embeddings[i];
            let nearest = runs
                .iter()
                .enumerate()
                .map(|(r, (_, sum))| (r, dot(sum, e) / dot(sum, sum).sqrt().max(1e-9)))
                .max_by(|a, b| a.1.total_cmp(&b.1));
            match nearest {
                Some((r, sim)) if sim >= threshold => {
                    let (members, sum) = &mut runs[r];
                    members.push(i);
                    for (s, x) in sum.iter_mut().zip(e) {
                        *s += x;
                    }
                }
                _ => runs.push((vec![i], e.clone())),
            }
        }
        let has_any = |this: &Self| {
            this.clusters
                .iter()
                .any(|c| c.track == track && c.confirmed)
        };
        if !has_any(self) && runs.iter().all(|(r, _)| run_ms(r) < self.new_min_ms(track)) {
            let all = pending.clone();
            let mut sum = vec![0.0; self.embedder.dim()];
            for (_, s) in &runs {
                for (a, x) in sum.iter_mut().zip(s) {
                    *a += x;
                }
            }
            runs = vec![(all, sum)];
        }
        let mut order: Vec<usize> = (0..runs.len()).collect();
        order.sort_by_key(|&r| run_ms(&runs[r].0) < self.new_min_ms(track));
        let mut created: Vec<SpeakerId> = Vec::new();
        // Speech each new voice got in this run, all its parts together.
        let mut heard: Vec<(SpeakerId, u64)> = Vec::new();
        for r in order {
            let (members, sum) = &runs[r];
            let mut mean = sum.clone();
            normalize(&mut mean);
            let long = run_ms(members);
            let known = has_any(self);
            let again = self
                .clusters
                .iter()
                .filter(|c| created.contains(&c.id))
                .map(|c| (c.id, c.centroid.similarity(&mean)))
                .max_by(|a, b| a.1.total_cmp(&b.1))
                .filter(|(_, sim)| *sim >= threshold);
            let id = match (again, self.best(track, &mean)) {
                (Some((id, _)), _) => {
                    if let Some(c) = self.clusters.iter_mut().find(|c| c.id == id) {
                        c.centroid.add(&mean, long as f32 / 1000.0);
                    }
                    if let Some(h) = heard.iter_mut().find(|h| h.0 == id) {
                        h.1 += long;
                    }
                    id
                }
                _ if long >= self.new_min_ms(track) || !known => {
                    let id = SpeakerId(self.next_id);
                    self.next_id += 1;
                    let first_ms = segment.start_ms + windows[members[0]].0 as u64 / SAMPLES_PER_MS;
                    let confirmed = !known || long >= self.config.confirm_ms;
                    self.clusters.push(Cluster {
                        id,
                        track,
                        centroid: Centroid::from(&mean, long as f32 / 1000.0),
                        first_ms,
                        speech_ms: 0,
                        power_ms: 0.0,
                        confirmed,
                        created_key: segment.key,
                        leak: None,
                    });
                    if confirmed {
                        self.on_confirmed(id);
                    }
                    created.push(id);
                    heard.push((id, long));
                    id
                }
                (None, Some((id, _))) => {
                    if track == Track::Mic {
                        self.mic_absorbed_ms += long;
                    }
                    id
                }
                (None, None) => continue,
            };
            for &i in members {
                labels[i] = Some((id, false));
            }
        }
        // A voice heard in several parts of one run is confirmed by all of
        // them together, as it would be had it spoken in one stretch.
        for (id, ms) in heard {
            if ms >= self.config.confirm_ms
                && let Some(c) = self
                    .clusters
                    .iter_mut()
                    .find(|c| c.id == id && !c.confirmed)
            {
                c.confirmed = true;
                self.on_confirmed(id);
            }
        }
        pending.clear();
    }

    fn on_confirmed(&mut self, id: SpeakerId) {
        let Some(c) = self.clusters.iter().find(|c| c.id == id) else {
            return;
        };
        if c.track == Track::Mic && self.user.is_none() && c.leak != Some(true) {
            let rejected = self
                .profile
                .as_ref()
                .is_some_and(|p| p.similarity(&c.centroid.unit) < self.config.profile_reject);
            if !rejected {
                self.user = Some(id);
            }
        }
    }

    fn refine_cluster(&mut self, id: SpeakerId, embedding: &[f32], samples: usize, key: u64) {
        let mut confirmed_now = false;
        if let Some(c) = self.clusters.iter_mut().find(|c| c.id == id) {
            c.centroid
                .add(embedding, samples as f32 / (SAMPLES_PER_MS as f32 * 1000.0));
            if !c.confirmed && c.created_key != key {
                c.confirmed = true;
                confirmed_now = true;
            }
        }
        if confirmed_now {
            self.on_confirmed(id);
        }
        if self.user.is_none()
            && let Some(profile) = &self.profile
            && let Some(c) = self.clusters.iter().find(|c| c.id == id)
            && c.track == Track::Mic
            && c.confirmed
            && c.leak != Some(true)
            && profile.similarity(&c.centroid.unit) >= self.config.profile_match
        {
            self.user = Some(id);
        }
    }

    /// Decides, as the call's levels arrive, which microphone voices are the
    /// call coming out of the speakers. Such a voice is nobody: its speech
    /// is an echo of the call from then on, and it stops being the user.
    fn review_leaks(&mut self) {
        let Some(now) = self.pieces.iter().map(|p| p.end_ms).max() else {
            return;
        };
        let since = now.saturating_sub(LEAK_REVIEW_MS);
        // The call's levels are known up to here: a stretch before it that
        // the call was not speaking through was heard with the call silent.
        let call_known_ms = self.levels[track_index(Track::System)]
            .last()
            .map_or(0, |r| (r.first + r.q.len() as u64) * LEVEL_MS);
        let call_runs = &self.levels[track_index(Track::System)];
        // (voice, tested ms, leaked ms, ms heard with the call silent, the
        // call's silences it was heard in, by the call speech ending each)
        let mut totals: Vec<(SpeakerId, u64, u64, u64, Vec<usize>)> = Vec::new();
        for i in (0..self.pieces.len()).rev() {
            let p = &self.pieces[i];
            if p.end_ms < since {
                break;
            }
            let Some(id) = p.cluster.filter(|_| p.track == Track::Mic && !p.echo) else {
                continue;
            };
            if !self.clusters.iter().any(|c| c.id == id && c.leak.is_none()) {
                continue;
            }
            let score = match p.leak {
                Some(score) => Some(score),
                None => self.leak(p.start_ms, p.end_ms),
            };
            self.pieces[i].leak = score;
            let p = &self.pieces[i];
            let ms = p.ms();
            let (tested, leaked, alone) = match score {
                Some(score) => (ms, if score >= self.config.leak { ms } else { 0 }, 0),
                None if p.end_ms + CALL_KNOWN_AFTER_MS <= call_known_ms
                    && self.call_silent(p.start_ms, p.end_ms) =>
                {
                    (0, 0, ms)
                }
                None => continue,
            };
            let silence =
                (alone > 0).then(|| call_runs.partition_point(|r| r.first * LEVEL_MS <= p.end_ms));
            let t = match totals.iter_mut().position(|t| t.0 == id) {
                Some(at) => &mut totals[at],
                None => {
                    totals.push((id, 0, 0, 0, Vec::new()));
                    totals.last_mut().unwrap()
                }
            };
            t.1 += tested;
            t.2 += leaked;
            t.3 += alone;
            if let Some(silence) = silence.filter(|s| !t.4.contains(s)) {
                t.4.push(silence);
            }
        }
        let mut lost_user = false;
        for (id, tested, leaked, alone, silences) in totals {
            let share = leaked as f64 / tested.max(1) as f64;
            // The speakers only play the call while the call is speaking, so
            // speech heard with the call silent counts against the call. A
            // voice heard that way in several of the call's silences is
            // someone in the room; a single silence could be the computer
            // audio dropping out while the speakers kept playing.
            let heard_alone = alone >= LEAK_DECIDE_MS
                && silences.len() >= ALONE_PERSON_SILENCES
                && alone as f64 >= ALONE_PERSON_SHARE * (alone + tested) as f64;
            let verdict = if tested >= LEAK_DECIDE_MS
                && leaked as f64 >= LEAK_VOICE_SHARE * (tested + alone) as f64
            {
                Some(true)
            } else if heard_alone || (tested >= PERSON_DECIDE_MS && share <= PERSON_VOICE_SHARE) {
                Some(false)
            } else {
                None
            };
            if let Some(c) = self.clusters.iter_mut().find(|c| c.id == id) {
                c.leak = verdict;
            }
            lost_user |= verdict == Some(true) && self.user == Some(id);
        }
        if lost_user {
            self.user = None;
            let next = self
                .clusters
                .iter()
                .filter(|c| c.track == Track::Mic && c.confirmed && c.leak != Some(true))
                .max_by_key(|c| c.speech_ms)
                .map(|c| c.id);
            if let Some(id) = next {
                self.on_confirmed(id);
            }
        }
    }

    fn keep_levels(&mut self, track: Track, start_ms: u64, samples: &[f32], count: bool) {
        let frame = (LEVEL_MS * SAMPLES_PER_MS) as usize;
        let first = start_ms.div_ceil(LEVEL_MS);
        let skip = ((first * LEVEL_MS - start_ms) * SAMPLES_PER_MS) as usize;
        let q: Vec<u8> = samples
            .get(skip..)
            .unwrap_or(&[])
            .chunks_exact(frame)
            .map(|c| {
                let db = 10.0 * power(c).max(1e-12).log10();
                ((db + 100.0) * 2.0).round().clamp(0.0, 255.0) as u8
            })
            .collect();
        let t = track_index(track);
        if count {
            // Frames the other track already holds; frames it adds later are
            // counted when they arrive.
            let other = self.levels(other_track(track), first, first + q.len() as u64);
            for (&mine, theirs) in q.iter().zip(other) {
                if let Some(theirs) = theirs {
                    self.level_sum[t].0 += f64::from(mine);
                    self.level_sum[t].1 += 1;
                    let o = 1 - t;
                    self.level_sum[o].0 += f64::from((theirs + 100.0) * 2.0);
                    self.level_sum[o].1 += 1;
                }
            }
        }
        self.level_frames[t] += q.len();
        // In time order, so lookups can search; a late segment goes where it
        // belongs (for one in order that is the end).
        let at = self.levels[t].partition_point(|r| r.first <= first);
        self.levels[t].insert(at, Levels { first, q });
        while self.level_frames[t] > LEVELS_MAX && self.levels[t].len() > 1 {
            let old = self.levels[t].remove(0);
            self.level_frames[t] -= old.q.len();
        }
    }

    /// Drops the run `keep_levels` just added for a segment starting at
    /// `start_ms` (a peek's, which must not count).
    fn forget_levels(&mut self, track: Track, start_ms: u64) {
        let t = track_index(track);
        let first = start_ms.div_ceil(LEVEL_MS);
        if let Some(at) = self.levels[t].iter().rposition(|r| r.first == first) {
            let old = self.levels[t].remove(at);
            self.level_frames[t] -= old.q.len();
        }
    }

    /// The track's level (dB) in frames `from..to`, `None` where it was
    /// not speaking.
    fn levels(&self, track: Track, from: u64, to: u64) -> Vec<Option<f32>> {
        let runs = &self.levels[track_index(track)];
        let mut out = vec![None; to.saturating_sub(from) as usize];
        let start = runs.partition_point(|r| r.first + r.q.len() as u64 <= from);
        for run in &runs[start..] {
            if run.first >= to {
                break;
            }
            for (k, &q) in run.q.iter().enumerate() {
                let f = run.first + k as u64;
                if f >= from && f < to {
                    out[(f - from) as usize] = Some(f32::from(q) / 2.0 - 100.0);
                }
            }
        }
        out
    }

    /// How closely a microphone stretch's loudness follows the call's (best
    /// correlation over the speakers' delay), when the call was speaking
    /// through most of it. The call heard through the speakers keeps the
    /// call's rhythm syllable by syllable; someone talking over the call
    /// does not.
    fn leak(&self, start_ms: u64, end_ms: u64) -> Option<f32> {
        self.follows_call(start_ms, end_ms, true)
    }

    /// `leak`, optionally without the loudness test: a call stretch is the
    /// original whenever the microphone follows it, however loud the copy
    /// (a limiter or the room can keep it level while the call dips).
    fn follows_call(&self, start_ms: u64, end_ms: u64, louder_is_a_person: bool) -> Option<f32> {
        let (from, to) = (start_ms.div_ceil(LEVEL_MS), end_ms / LEVEL_MS);
        if to < from + LEAK_MIN_FRAMES {
            return None;
        }
        let mic: Vec<f32> = self
            .levels(Track::Mic, from, to)
            .into_iter()
            .collect::<Option<Vec<f32>>>()?;
        let (early, late) = LEAK_LAG_FRAMES;
        let lo = from.saturating_sub(late as u64);
        let call = self.levels(Track::System, lo, to + (late - early) as u64);
        let at = (from - lo) as usize;
        let covered = call[at..at + mic.len()].iter().flatten().count();
        if (covered as f64) < mic.len() as f64 * LEAK_MIN_COVER {
            return None;
        }
        // The copy is the quieter one, each track against its usual level
        // while both are active: a stretch clearly louder than the
        // microphone's usual level over the call holds someone talking.
        let usual = |t: usize| {
            let (sum, n) = self.level_sum[t];
            (n > 0).then(|| (sum / n as f64) as f32 / 2.0 - 100.0)
        };
        let mean = |v: &[f32]| v.iter().sum::<f32>() / v.len().max(1) as f32;
        let heard: Vec<f32> = call[at..at + mic.len()].iter().flatten().copied().collect();
        if louder_is_a_person
            && let (Some(mic_usual), Some(call_usual)) = (usual(0), usual(1))
            && mean(&mic) - mic_usual > mean(&heard) - call_usual + LEAK_LOUDER_DB
        {
            return None;
        }
        let floor = call.iter().flatten().copied().fold(f32::MAX, f32::min);
        let call: Vec<f32> = call.into_iter().map(|v| v.unwrap_or(floor)).collect();
        let at_lag = |lag: i64| {
            let begin = at as i64 - lag;
            if begin < 0 || begin as usize + mic.len() > call.len() {
                return None;
            }
            correlation(&mic, &call[begin as usize..begin as usize + mic.len()])
        };
        let follows = (early..=late).filter_map(at_lag).max_by(f32::total_cmp)?;
        // The call following the microphone instead (the user's voice sent
        // back by the far end) beats the other way round: not a leak.
        let leads = (early - late..early)
            .filter_map(at_lag)
            .max_by(f32::total_cmp);
        (leads.is_none_or(|leads| follows >= leads)).then_some(follows)
    }

    /// How closely the microphone follows a call stretch over the longest
    /// run of it the microphone heard. The speakers' copy starts and stops a
    /// little after the call, so a window of the call seldom lines up with
    /// the microphone's speech.
    fn heard_leak(&self, start_ms: u64, end_ms: u64) -> Option<f32> {
        let from = start_ms.div_ceil(LEVEL_MS);
        let mic = self.levels(Track::Mic, from, end_ms / LEVEL_MS);
        let (mut best, mut run_start) = ((0, 0), None);
        for (i, level) in mic.iter().chain([&None]).enumerate() {
            match (level, run_start) {
                (Some(_), None) => run_start = Some(i),
                (None, Some(a)) => {
                    if i - a > best.1 - best.0 {
                        best = (a, i);
                    }
                    run_start = None;
                }
                _ => {}
            }
        }
        let (a, b) = (from + best.0 as u64, from + best.1 as u64);
        self.follows_call(a * LEVEL_MS, b * LEVEL_MS, false)
    }

    /// Whether the call says (almost) nothing through a stretch, counting the
    /// speakers' delay either side: its levels there are known.
    fn call_silent(&self, start_ms: u64, end_ms: u64) -> bool {
        let (early, late) = LEAK_LAG_FRAMES;
        let from = (start_ms / LEVEL_MS).saturating_sub(late as u64);
        let to = end_ms.div_ceil(LEVEL_MS) + (-early) as u64;
        let call = self.levels(Track::System, from, to);
        let spoken = call.iter().flatten().count();
        (spoken as f64) <= call.len() as f64 * CALL_SILENT_COVER
    }

    /// The call's voice speaking most during a stretch.
    fn call_speaker(&self, start_ms: u64, end_ms: u64) -> Option<SpeakerId> {
        let mut totals: Vec<(SpeakerId, u64)> = Vec::new();
        for piece in self.pieces.iter().rev() {
            if piece.track != Track::System || piece.echo {
                continue;
            }
            if piece.end_ms + 60_000 < start_ms {
                break;
            }
            let overlap = piece
                .end_ms
                .min(end_ms)
                .saturating_sub(piece.start_ms.max(start_ms));
            if let (Some(id), true) = (piece.speaker, overlap > 0) {
                match totals.iter_mut().find(|t| t.0 == id) {
                    Some(t) => t.1 += overlap,
                    None => totals.push((id, overlap)),
                }
            }
        }
        totals.into_iter().max_by_key(|t| t.1).map(|t| t.0)
    }

    fn previous_speaker(&self, track: Track, before_ms: u64) -> Option<SpeakerId> {
        self.pieces
            .iter()
            .rev()
            .filter(|p| p.track == track && !p.echo && p.start_ms <= before_ms)
            .find_map(|p| p.speaker)
    }

    fn bound_memory(&mut self) {
        while self.embeddings_kept > self.config.max_embeddings
            && self.oldest_embedding < self.pieces.len()
        {
            if self.pieces[self.oldest_embedding]
                .embedding
                .take()
                .is_some()
            {
                self.embeddings_kept -= 1;
            }
            self.oldest_embedding += 1;
        }
    }

    /// Revisits the whole meeting: re-assigns every stretch to the speaker it
    /// is closest to now that every voice is known, folds speakers that turn
    /// out to be one person, and re-checks echoes across the two tracks.
    pub fn finish(&mut self) -> FinalPass {
        let started = Instant::now();
        let mut finals: Vec<FinalCluster> = Vec::new();
        let mut assignment: Vec<Option<usize>> = vec![None; self.pieces.len()];
        let mut scores: Vec<Option<f32>> = self
            .pieces
            .iter()
            .map(|p| match p.track {
                Track::Mic => self.leak(p.start_ms, p.end_ms),
                Track::System => None,
            })
            .collect();
        // A word said a beat after the same word on the call rises and falls
        // with it too. Only a microphone that repeated a sentence of the call
        // (or was already known to) hears it at all, stretch by stretch
        // between device changes; on a headset every such stretch is the
        // user's.
        let stretch = |ms: u64| {
            self.echo_stretches
                .partition_point(|&(start, _)| start <= ms)
                .saturating_sub(1)
        };
        let mut stretch_hears: Vec<bool> = self.echo_stretches.iter().map(|s| s.1).collect();
        if stretch_hears.is_empty() {
            stretch_hears.push(false);
        }
        for (p, s) in self.pieces.iter().zip(&scores) {
            if *s >= Some(self.config.leak) && p.ms() >= ECHO_HEARD_MS {
                stretch_hears[stretch(p.start_ms)] = true;
            }
        }
        for &t in &self.heard_live {
            stretch_hears[stretch(t)] = true;
        }
        let hears: Vec<bool> = self
            .pieces
            .iter()
            .map(|p| stretch_hears[stretch(p.start_ms)])
            .collect();
        for (s, &hears) in scores.iter_mut().zip(&hears) {
            if !hears {
                *s = None;
            }
        }
        let mut leaked: Vec<bool> = scores
            .iter()
            .map(|s| *s >= Some(self.config.leak))
            .collect();
        for track in [Track::Mic, Track::System] {
            self.refine_track(track, &leaked, &mut finals, &mut assignment);
        }
        let call_voices = self.leaky_voices(&finals, &scores, &assignment, &mut leaked);
        self.mark_leaks(&leaked, &mut assignment);
        let folded = self.fold_echo_voices(&finals, &mut assignment);
        let user = self.final_user(&finals, &assignment);
        self.recheck_echo(
            &finals,
            user,
            &call_voices,
            &folded,
            &hears,
            &mut leaked,
            &mut assignment,
        );
        self.mark_leaks(&leaked, &mut assignment);
        self.fill_unembedded(&mut assignment);
        self.fold_tiny_mic_voices(&finals, &mut assignment);
        self.fold_wordless_voices(&finals, &mut assignment);

        let live: Vec<SpeakerId> = self
            .clusters
            .iter()
            .filter(|c| c.confirmed)
            .map(|c| c.id)
            .collect();
        let mut overlap = vec![vec![0u64; live.len()]; finals.len()];
        for (piece, f) in self.pieces.iter().zip(&assignment) {
            let heard_as = piece.cluster.filter(|c| live.contains(c)).or(piece.speaker);
            if let (Some(FinalLabel::Speaker(f)), Some(l)) = (f.map(FinalLabel::from), heard_as)
                && !piece.echo
                && let Some(l) = live.iter().position(|id| *id == l)
            {
                overlap[f][l] += piece.ms().max(1);
            }
        }
        let mut ids: Vec<Option<SpeakerId>> = vec![None; finals.len()];
        for (f, l) in greedy_match(&overlap) {
            ids[f] = Some(live[l]);
        }
        let mut next = self.next_id;
        let ids: Vec<SpeakerId> = ids
            .into_iter()
            .map(|id| {
                id.unwrap_or_else(|| {
                    let id = SpeakerId(next);
                    next += 1;
                    id
                })
            })
            .collect();
        let mut merged = Vec::new();
        for (l, id) in live.iter().enumerate() {
            if ids.contains(id) {
                continue;
            }
            if let Some(f) = (0..finals.len())
                .filter(|&f| overlap[f][l] > 0)
                .max_by_key(|&f| overlap[f][l])
            {
                merged.push((*id, ids[f]));
            }
        }

        let resolve = |a: Option<usize>| -> Option<(SpeakerId, bool)> {
            a.map(|a| match FinalLabel::from(a) {
                FinalLabel::Speaker(f) => (ids[f], false),
                FinalLabel::Echo(f) => (ids[f], true),
            })
        };
        let mut segments: Vec<SegmentLabels> = Vec::new();
        let mut speech = vec![0u64; finals.len()];
        let mut first = vec![u64::MAX; finals.len()];
        for (piece, a) in self.pieces.iter().zip(&assignment) {
            if let Some(FinalLabel::Speaker(f)) = a.map(FinalLabel::from) {
                speech[f] += piece.ms();
                first[f] = first[f].min(piece.start_ms);
            }
            let open = segments
                .last()
                .is_some_and(|s| s.key == piece.key && s.track == piece.track);
            if !open {
                segments.push(SegmentLabels {
                    track: piece.track,
                    key: piece.key,
                    spans: Vec::new(),
                });
            }
            let Some(current) = segments.last_mut() else {
                continue;
            };
            if let Some((speaker, echo)) = resolve(*a) {
                match current.spans.last_mut() {
                    Some(span) if span.speaker == speaker && span.echo == echo => {
                        span.end_ms = piece.end_ms;
                    }
                    _ => current.spans.push(Span {
                        start_ms: piece.start_ms,
                        end_ms: piece.end_ms,
                        speaker,
                        echo,
                    }),
                }
            }
        }

        let user = self.final_user(&finals, &assignment);
        let speakers: Vec<SpeakerInfo> = finals
            .iter()
            .enumerate()
            .filter(|(f, _)| speech[*f] > 0)
            .map(|(f, c)| SpeakerInfo {
                id: ids[f],
                track: c.track,
                first_ms: first[f],
                speech_ms: speech[f],
                is_user: user == Some(f),
            })
            .collect();
        let enrolment = self.enrolment(&finals, &speech, user, &assignment);
        let mut pass = FinalPass {
            segments,
            merged,
            speakers,
            user: user.map(|f| ids[f]),
            enrolment,
        };
        if let Some(runner) = self.nemotron.take_if(|n| n.schedule() == crate::nemotron::Schedule::AfterStop) {
            let mut later = pass.clone();
            // the voice profile is learnt once, from this pass
            later.enrolment = None;
            self.late = Some(LateNemotron { voices: runner.finish_later(), pass: later });
        }
        if let Some(result) = self.nemotron.take().map(|n| n.finish()) {
            let voices = match result {
                Ok(v) => v,
                Err(e) => {
                    self.nemotron_error = Some(e);
                    self.stats.total_time += started.elapsed();
                    return pass;
                }
            };
            let h = crate::hybrid::apply(&mut pass, &voices);
            self.nemotron_voices = Some(voices);
            self.stats.nemotron_applied = true;
            self.stats.nemotron_relabelled_ms = h.relabelled_ms;
            self.stats.nemotron_new_voices = h.new_voices;
            self.stats.nemotron_merged_ids = h.merged_ids;
        }
        self.stats.total_time += started.elapsed();
        pass
    }

    fn refine_track(
        &self,
        track: Track,
        leaked: &[bool],
        finals: &mut Vec<FinalCluster>,
        assignment: &mut [Option<usize>],
    ) {
        let members: Vec<usize> = (0..self.pieces.len())
            .filter(|&i| {
                let p = &self.pieces[i];
                p.track == track && !p.echo && !leaked[i] && p.embedding.is_some()
            })
            .collect();
        let mut centroids: Vec<Centroid> = self
            .clusters
            .iter()
            .filter(|c| c.track == track)
            .map(|c| c.centroid.clone())
            .collect();
        if members.is_empty() || centroids.is_empty() {
            return;
        }
        let embedding = |i: usize| self.pieces[i].embedding.as_deref().unwrap_or(&[]);
        let weight = |i: usize| self.pieces[i].ms() as f32 / 1000.0;
        let mut owner = vec![0usize; members.len()];
        let assign_all = |centroids: &[Centroid], owner: &mut [usize]| {
            for (slot, &i) in owner.iter_mut().zip(&members) {
                let e = embedding(i);
                *slot = (0..centroids.len())
                    .max_by(|&a, &b| {
                        centroids[a]
                            .similarity(e)
                            .total_cmp(&centroids[b].similarity(e))
                    })
                    .unwrap_or(0);
            }
        };
        let rebuild = |owner: &[usize], count: usize| -> Vec<Centroid> {
            let mut out: Vec<Centroid> = (0..count)
                .map(|_| Centroid::new(self.embedder.dim()))
                .collect();
            for (&o, &i) in owner.iter().zip(&members) {
                out[o].add(embedding(i), weight(i));
            }
            out
        };
        let compact = |owner: &mut [usize], centroids: Vec<Centroid>| -> Vec<Centroid> {
            let mut remap = vec![usize::MAX; centroids.len()];
            let mut kept = Vec::new();
            for (c, centroid) in centroids.into_iter().enumerate() {
                if centroid.weight > 0.0 {
                    remap[c] = kept.len();
                    kept.push(centroid);
                }
            }
            for o in owner.iter_mut() {
                *o = remap[*o];
            }
            kept
        };

        for _ in 0..self.config.refine_rounds {
            assign_all(&centroids, &mut owner);
            let rebuilt = rebuild(&owner, centroids.len());
            centroids = compact(&mut owner, rebuilt);
        }

        loop {
            let speech: Vec<f32> = centroids.iter().map(|c| c.weight).collect();
            let total_ms = speech.iter().sum::<f32>() * 1000.0;
            let mut best: Option<(usize, usize, bool, f32)> = None;
            for a in 0..centroids.len() {
                for b in a + 1..centroids.len() {
                    let sim = dot(&centroids[a].unit, &centroids[b].unit);
                    let smaller_ms = speech[a].min(speech[b]) * 1000.0;
                    let forced = smaller_ms < self.config.min_speaker_ms as f32;
                    let threshold = if smaller_ms < self.config.small_ms as f32 {
                        self.config.small_merge
                    } else if track == Track::System
                        && smaller_ms < self.config.fold_ms as f32
                        && smaller_ms < total_ms * self.config.fold_share
                    {
                        self.config.fold_merge
                    } else {
                        self.config.merge
                    };
                    let margin = sim - threshold;
                    if (forced || margin >= 0.0)
                        && best.is_none_or(|(_, _, f, m)| (forced, margin) > (f, m))
                    {
                        best = Some((a, b, forced, margin));
                    }
                }
            }
            let Some((a, b, _, _)) = best else {
                break;
            };
            let absorbed = centroids.remove(b);
            centroids[a].absorb(&absorbed);
            for o in owner.iter_mut() {
                if *o == b {
                    *o = a;
                } else if *o > b {
                    *o -= 1;
                }
            }
        }
        let min_side = self.config.split_min_ms as f32 / 1000.0;
        let mut checked = vec![false; centroids.len()];
        let mut splits = 0;
        while splits < MAX_SPLITS {
            let Some(c) = (0..centroids.len())
                .find(|&c| !checked[c] && centroids[c].weight >= 2.0 * min_side)
            else {
                break;
            };
            checked[c] = true;
            let held: Vec<usize> = (0..members.len()).filter(|&k| owner[k] == c).collect();
            let items: Vec<(&[f32], f32)> = held
                .iter()
                .map(|&k| (embedding(members[k]), weight(members[k])))
                .collect();
            if let Some(side) = two_way(&items, self.config.split, min_side) {
                let new = centroids.len();
                for (&k, &moved) in held.iter().zip(&side) {
                    if moved {
                        owner[k] = new;
                    }
                }
                centroids = rebuild(&owner, new + 1);
                checked[c] = false;
                checked.push(false);
                splits += 1;
            }
        }

        assign_all(&centroids, &mut owner);
        let rebuilt = rebuild(&owner, centroids.len());
        centroids = compact(&mut owner, rebuilt);

        let base = finals.len();
        finals.extend(
            centroids
                .into_iter()
                .map(|centroid| FinalCluster { track, centroid }),
        );
        for (&o, &i) in owner.iter().zip(&members) {
            assignment[i] = Some(FinalLabel::Speaker(base + o).into());
        }
    }

    fn leaky_voices(
        &self,
        finals: &[FinalCluster],
        scores: &[Option<f32>],
        assignment: &[Option<usize>],
        leaked: &mut [bool],
    ) -> Vec<bool> {
        // (speech, compared speech, sum of score x speech) per final voice.
        let mut voices = vec![(0u64, 0u64, 0f64); finals.len()];
        for (i, piece) in self.pieces.iter().enumerate() {
            if let Some(FinalLabel::Speaker(f)) = assignment[i].map(FinalLabel::from)
                && finals[f].track == Track::Mic
            {
                let ms = piece.ms();
                voices[f].0 += ms;
                if let Some(score) = scores[i] {
                    voices[f].1 += ms;
                    voices[f].2 += f64::from(score) * ms as f64;
                }
            }
        }
        let call: Vec<bool> = voices
            .iter()
            .map(|&(ms, tested, sum)| {
                tested > 0
                    && tested as f64 >= ms as f64 * LEAK_VOICE_TESTED
                    && sum / tested as f64 >= f64::from(LEAK_VOICE_MEAN)
            })
            .collect();
        for (i, a) in assignment.iter().enumerate() {
            if let Some(FinalLabel::Speaker(f)) = a.map(FinalLabel::from)
                && call[f]
            {
                leaked[i] = true;
            }
        }
        call
    }

    /// Microphone stretches that are the call coming out of the speakers are
    /// echoes of the call's voice speaking then.
    fn mark_leaks(&self, leaked: &[bool], assignment: &mut [Option<usize>]) {
        let mut call: Vec<(u64, u64, usize)> = self
            .pieces
            .iter()
            .zip(assignment.iter())
            .filter(|(p, _)| p.track == Track::System)
            .filter_map(|(p, a)| match a.map(FinalLabel::from) {
                Some(FinalLabel::Speaker(f)) => Some((p.start_ms, p.end_ms, f)),
                _ => None,
            })
            .collect();
        call.sort_unstable();
        let longest = call.iter().map(|(a, b, _)| b - a).max().unwrap_or(0);
        for (i, piece) in self.pieces.iter().enumerate() {
            if !leaked[i] {
                continue;
            }
            let first = call.partition_point(|c| c.0 + longest < piece.start_ms);
            let mut totals: Vec<(usize, u64)> = Vec::new();
            for &(a, b, f) in &call[first..] {
                if a >= piece.end_ms {
                    break;
                }
                let overlap = b.min(piece.end_ms).saturating_sub(a.max(piece.start_ms));
                if overlap == 0 {
                    continue;
                }
                match totals.iter_mut().find(|t| t.0 == f) {
                    Some(t) => t.1 += overlap,
                    None => totals.push((f, overlap)),
                }
            }
            if let Some((f, _)) = totals.into_iter().max_by_key(|t| t.1) {
                assignment[i] = Some(FinalLabel::Echo(f).into());
            }
        }
    }

    /// A whole voice that sounds like the other track's speaker and is heard
    /// almost only while they talk is that speaker arriving twice: the user
    /// returned by the call, or the call leaking from the speakers into the
    /// microphone. Checked per voice because a voice built only from echoes
    /// matches itself better than the original, piece by piece.
    /// Returns where each folded voice went, for stretches placed later.
    fn fold_echo_voices(
        &self,
        finals: &[FinalCluster],
        assignment: &mut [Option<usize>],
    ) -> Vec<Option<usize>> {
        let slack = self.config.echo_slack_ms;
        let mut speech = vec![0u64; finals.len()];
        let mut spans: Vec<Vec<(u64, u64)>> = vec![Vec::new(); finals.len()];
        for (piece, a) in self.pieces.iter().zip(assignment.iter()) {
            if let Some(FinalLabel::Speaker(f)) = a.map(FinalLabel::from) {
                speech[f] += piece.ms();
                spans[f].push((piece.start_ms, piece.end_ms));
            }
        }
        for s in &mut spans {
            s.sort_unstable();
        }
        // All of the call's speech: the microphone hears whoever is talking.
        let mut call: Vec<(u64, u64)> = (0..finals.len())
            .filter(|&g| finals[g].track == Track::System)
            .flat_map(|g| spans[g].iter().copied())
            .collect();
        call.sort_unstable();
        let covered_by = |f: usize, other: &[(u64, u64)]| -> f64 {
            let mut hit = 0u64;
            for &(a, b) in &spans[f] {
                let first = other.partition_point(|&(_, e)| e + slack < a);
                for &(c, d) in &other[first..] {
                    if c > b + slack {
                        break;
                    }
                    hit += b
                        .min(d + slack)
                        .saturating_sub(a.max(c.saturating_sub(slack)));
                }
            }
            hit.min(speech[f]) as f64 / speech[f].max(1) as f64
        };
        let covered = |f: usize, g: usize| match (finals[f].track, finals[g].track) {
            (Track::Mic, Track::System) => covered_by(f, &call),
            _ => covered_by(f, &spans[g]),
        };
        let user = self.final_user(finals, assignment);
        let mut echo_of: Vec<Option<usize>> = vec![None; finals.len()];
        for f in 0..finals.len() {
            if speech[f] == 0 || Some(f) == user {
                continue;
            }
            let originals: Vec<usize> = match finals[f].track {
                Track::System => user.into_iter().collect(),
                Track::Mic => (0..finals.len())
                    .filter(|&g| finals[g].track == Track::System && speech[g] > 0)
                    .collect(),
            };
            let sim = |g: usize| dot(&finals[f].centroid.unit, &finals[g].centroid.unit);
            let nearest = originals
                .iter()
                .map(|&g| (g, sim(g)))
                .max_by(|a, b| a.1.total_cmp(&b.1));
            echo_of[f] = originals
                .into_iter()
                .map(|g| (g, sim(g)))
                .filter(|&(g, sim)| sim >= self.config.merge && covered(f, g) >= ECHO_COVERAGE)
                .max_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(g, _)| FinalLabel::Echo(g).into());
            if echo_of[f].is_none()
                && finals[f].track == Track::Mic
                && speech[f] < OVER_CALL_MAX_MS
                && let (Some(u), Some((g, call_sim))) = (user, nearest)
                && covered(f, g) >= OVER_CALL_COVERAGE
            {
                echo_of[f] = Some(if call_sim >= sim(u) {
                    FinalLabel::Echo(g).into()
                } else {
                    FinalLabel::Speaker(u).into()
                });
            }
        }
        for a in assignment.iter_mut() {
            if let Some(FinalLabel::Speaker(f)) = a.map(FinalLabel::from)
                && let Some(to) = echo_of[f]
            {
                *a = Some(to);
            }
        }
        echo_of
    }

    fn final_speech(&self, assignment: &[Option<usize>], count: usize) -> Vec<u64> {
        let mut speech = vec![0u64; count];
        for (piece, a) in self.pieces.iter().zip(assignment) {
            if let Some(FinalLabel::Speaker(f)) = a.map(FinalLabel::from) {
                speech[f] += piece.ms();
            }
        }
        speech
    }

    /// Echo runs one way per track: the call can only return the user's
    /// voice, and the microphone can only pick up the call.
    fn recheck_echo(
        &self,
        finals: &[FinalCluster],
        user: Option<usize>,
        call_voices: &[bool],
        folded: &[Option<usize>],
        hears: &[bool],
        leaked: &mut [bool],
        assignment: &mut [Option<usize>],
    ) {
        let slack = self.config.echo_slack_ms;
        let mut spans: [Vec<(u64, u64, usize)>; 2] = [Vec::new(), Vec::new()];
        for (piece, a) in self.pieces.iter().zip(assignment.iter()) {
            if let Some(FinalLabel::Speaker(f)) = a.map(FinalLabel::from) {
                spans[track_index(piece.track)].push((piece.start_ms, piece.end_ms, f));
            }
        }
        for s in &mut spans {
            s.sort_unstable();
        }
        let max_len = |s: &[(u64, u64, usize)]| s.iter().map(|(a, b, _)| b - a).max().unwrap_or(0);
        let longest = [max_len(&spans[0]), max_len(&spans[1])];
        // Only a microphone that hears the call can hold it: on a headset a
        // short reply over the same word stays the user's, however much it
        // sounds like the call.
        for (i, piece) in self.pieces.iter().enumerate() {
            let Some(e) = piece.embedding.as_deref() else {
                continue;
            };
            if piece.track == Track::Mic && !hears[i] && !piece.echo {
                continue;
            }
            if leaked[i] && assignment[i].is_some() {
                continue;
            }
            let own = match assignment[i].map(FinalLabel::from) {
                Some(FinalLabel::Speaker(f)) => finals[f].centroid.similarity(e),
                _ => f32::MIN,
            };
            let other = track_index(other_track(piece.track));
            let from = piece.start_ms.saturating_sub(slack + longest[other]);
            let first = spans[other].partition_point(|s| s.0 < from);
            let mut best: Option<(usize, f32)> = None;
            for &(a, b, f) in &spans[other][first..] {
                if a > piece.end_ms + slack {
                    break;
                }
                if b + slack < piece.start_ms || (piece.track == Track::System && Some(f) != user) {
                    continue;
                }
                let sim = finals[f].centroid.similarity(e);
                if best.is_none_or(|(_, s)| sim > s) {
                    best = Some((f, sim));
                }
            }
            if let Some((f, sim)) = best
                && sim >= self.config.assign
                && sim > own
            {
                assignment[i] = Some(FinalLabel::Echo(f).into());
            } else if piece.echo {
                // Nearest to what is left of the speakers: the call too.
                let nearest = self.nearest_final(piece.track, e, finals);
                if nearest.is_some_and(|f| call_voices[f]) {
                    leaked[i] = true;
                    assignment[i] = None;
                } else {
                    assignment[i] =
                        nearest.map(|f| folded[f].unwrap_or(FinalLabel::Speaker(f).into()));
                }
            }
        }
    }

    fn nearest_final(&self, track: Track, e: &[f32], finals: &[FinalCluster]) -> Option<usize> {
        (0..finals.len())
            .filter(|&f| finals[f].track == track)
            .max_by(|&a, &b| {
                finals[a]
                    .centroid
                    .similarity(e)
                    .total_cmp(&finals[b].centroid.similarity(e))
            })
    }

    /// A microphone voice left with less than `min_speaker_ms` once echoes
    /// are taken out is a scrap of someone else, not a person.
    fn fold_tiny_mic_voices(&self, finals: &[FinalCluster], assignment: &mut [Option<usize>]) {
        let speech = self.final_speech(assignment, finals.len());
        let real =
            |f: usize| finals[f].track == Track::Mic && speech[f] >= self.config.min_speaker_ms;
        let into: Vec<Option<usize>> = (0..finals.len())
            .map(|f| {
                if finals[f].track != Track::Mic || speech[f] == 0 || real(f) {
                    return None;
                }
                (0..finals.len())
                    .filter(|&g| g != f && real(g))
                    .max_by(|&a, &b| {
                        dot(&finals[f].centroid.unit, &finals[a].centroid.unit)
                            .total_cmp(&dot(&finals[f].centroid.unit, &finals[b].centroid.unit))
                    })
            })
            .collect();
        for a in assignment.iter_mut() {
            if let Some(FinalLabel::Speaker(f)) = a.map(FinalLabel::from)
                && let Some(g) = into[f]
            {
                *a = Some(FinalLabel::Speaker(g).into());
            }
        }
    }

    fn fold_wordless_voices(&self, finals: &[FinalCluster], assignment: &mut [Option<usize>]) {
        if self.pieces.iter().all(|p| p.words.is_none()) {
            return;
        }
        // (speech, transcribed speech, words) per final voice.
        let mut v = vec![(0u64, 0u64, 0u64); finals.len()];
        for (piece, a) in self.pieces.iter().zip(assignment.iter()) {
            if let Some(FinalLabel::Speaker(f)) = a.map(FinalLabel::from) {
                v[f].0 += piece.ms();
                if let Some(words) = piece.words {
                    v[f].1 += piece.ms();
                    v[f].2 += u64::from(words);
                }
            }
        }
        let rate = |f: usize| v[f].2 as f64 * 1000.0 / v[f].1.max(1) as f64;
        let user = self.final_user(finals, assignment);
        let main = |f: usize| {
            (0..finals.len())
                .filter(|&g| finals[g].track == finals[f].track && v[g].1 >= WORDLESS_MIN_MS)
                .map(rate)
                .fold(0.0, f64::max)
        };
        let wordless: Vec<bool> = (0..finals.len())
            .map(|f| {
                let main = main(f);
                Some(f) != user
                    && v[f].1 >= WORDLESS_MIN_MS
                    && v[f].1 as f64 >= v[f].0 as f64 * WORDLESS_TRANSCRIBED
                    && rate(f) < WORDLESS_RATE
                    && rate(f) < main * WORDLESS_OF_MAIN
            })
            .collect();
        let into: Vec<Option<usize>> = (0..finals.len())
            .map(|f| {
                if !wordless[f] {
                    return None;
                }
                (0..finals.len())
                    .filter(|&g| {
                        g != f
                            && finals[g].track == finals[f].track
                            && v[g].1 >= WORDLESS_MIN_MS
                            && rate(g) >= main(f) * TALKER_OF_MAIN
                    })
                    .max_by(|&a, &b| {
                        dot(&finals[f].centroid.unit, &finals[a].centroid.unit)
                            .total_cmp(&dot(&finals[f].centroid.unit, &finals[b].centroid.unit))
                    })
            })
            .collect();
        for a in assignment.iter_mut() {
            if let Some(FinalLabel::Speaker(f)) = a.map(FinalLabel::from)
                && let Some(g) = into[f]
            {
                *a = Some(FinalLabel::Speaker(g).into());
            }
        }
    }

    fn fill_unembedded(&self, assignment: &mut [Option<usize>]) {
        for track in [Track::Mic, Track::System] {
            let labelled: Vec<(usize, u64)> = self
                .pieces
                .iter()
                .enumerate()
                .filter(|(i, p)| {
                    p.track == track
                        && matches!(
                            assignment[*i].map(FinalLabel::from),
                            Some(FinalLabel::Speaker(_))
                        )
                })
                .map(|(i, p)| (i, (p.start_ms + p.end_ms) / 2))
                .collect();
            if labelled.is_empty() {
                continue;
            }
            for i in 0..self.pieces.len() {
                let p = &self.pieces[i];
                if p.track != track || assignment[i].is_some() {
                    continue;
                }
                let mid = (p.start_ms + p.end_ms) / 2;
                let at = labelled.partition_point(|(_, m)| *m < mid);
                let candidates = [at.checked_sub(1), (at < labelled.len()).then_some(at)];
                let nearest = candidates
                    .into_iter()
                    .flatten()
                    .min_by_key(|&k| {
                        let (j, m) = labelled[k];
                        (self.pieces[j].key != p.key, m.abs_diff(mid))
                    })
                    .map(|k| labelled[k].0);
                if let Some(j) = nearest {
                    assignment[i] = assignment[j];
                }
            }
        }
    }

    fn final_user(&self, finals: &[FinalCluster], assignment: &[Option<usize>]) -> Option<usize> {
        let speech = self.final_speech(assignment, finals.len());
        let mut power = vec![0f64; finals.len()];
        for (piece, a) in self.pieces.iter().zip(assignment) {
            if let Some(FinalLabel::Speaker(f)) = a.map(FinalLabel::from) {
                power[f] += f64::from(piece.power) * piece.ms() as f64;
            }
        }
        let mic: Vec<usize> = (0..finals.len())
            .filter(|&f| finals[f].track == Track::Mic && speech[f] > 0)
            .collect();
        if let Some(profile) = &self.profile
            && let Some(&f) = mic.iter().max_by(|&&a, &&b| {
                profile
                    .similarity(&finals[a].centroid.unit)
                    .total_cmp(&profile.similarity(&finals[b].centroid.unit))
            })
            && profile.similarity(&finals[f].centroid.unit) >= self.config.profile_match
        {
            return Some(f);
        }
        let mut voices: Vec<(usize, u64, f64)> = mic
            .iter()
            .map(|&f| (f, speech[f], power[f] / speech[f].max(1) as f64))
            .collect();
        if loudest(&voices, &self.config).is_some() {
            voices.retain(|v| {
                !self.heard_with_the_call(|i, _| {
                    assignment[i]
                        .map(FinalLabel::from)
                        .is_some_and(|a| matches!(a, FinalLabel::Speaker(f) if f == v.0))
                })
            });
        }
        // Voices set aside as heard with the call never come back as the
        // fallback: the most speech among the rest.
        loudest(&voices, &self.config)
            .or_else(|| voices.iter().max_by_key(|v| v.1).map(|v| v.0))
            .or_else(|| mic.into_iter().max_by_key(|&f| speech[f]))
    }

    /// Whether a microphone voice is heard mostly while the call is talking:
    /// the call leaking from the speakers, never the person at the computer.
    fn heard_with_the_call(&self, owns: impl Fn(usize, &Piece) -> bool) -> bool {
        let slack = self.config.echo_slack_ms;
        let mut call: Vec<(u64, u64)> = self
            .pieces
            .iter()
            .filter(|p| p.track == Track::System && !p.echo && p.speaker.is_some())
            .map(|p| (p.start_ms.saturating_sub(slack), p.end_ms + slack))
            .collect();
        call.sort_unstable();
        let (mut hit, mut total) = (0u64, 0u64);
        for (i, p) in self.pieces.iter().enumerate() {
            if p.track != Track::Mic || p.echo || !owns(i, p) {
                continue;
            }
            total += p.ms();
            let first = call.partition_point(|&(_, e)| e <= p.start_ms);
            let mut covered = 0u64;
            let mut until = p.start_ms;
            for &(a, b) in &call[first..] {
                if a >= p.end_ms {
                    break;
                }
                let from = a.max(until);
                let to = b.min(p.end_ms);
                if to > from {
                    covered += to - from;
                    until = to;
                }
            }
            hit += covered;
        }
        total > 0 && hit as f64 >= total as f64 * ECHO_COVERAGE
    }

    /// Several people can share the microphone; the user is the one it hears
    /// clearly loudest, sitting at the computer. Without a voice profile the
    /// live choice follows that as soon as it is clear, so the end of the
    /// meeting agrees with what was shown.
    fn follow_loudest_user(&mut self) {
        if self.profile.is_some() {
            return;
        }
        let mut voices: Vec<(SpeakerId, u64, f64)> = self
            .clusters
            .iter()
            .filter(|c| {
                c.track == Track::Mic && c.confirmed && c.speech_ms > 0 && c.leak != Some(true)
            })
            .map(|c| (c.id, c.speech_ms, c.power_ms / c.speech_ms as f64))
            .collect();
        if loudest(&voices, &self.config).is_none() {
            return;
        }
        voices.retain(|v| !self.heard_with_the_call(|_, p| p.cluster == Some(v.0)));
        let Some(id) = loudest(&voices, &self.config) else {
            return;
        };
        let level = |id: SpeakerId| voices.iter().find(|v| v.0 == id).map(|v| v.2);
        let clearer = match self.user.and_then(level) {
            Some(current) => {
                10.0 * (level(id).unwrap_or(0.0) / current.max(1e-12))
                    .max(1e-12)
                    .log10()
                    >= self.config.user_louder_db
            }
            None => true,
        };
        if clearer {
            self.user = Some(id);
        }
    }

    fn enrolment(
        &self,
        finals: &[FinalCluster],
        speech: &[u64],
        user: Option<usize>,
        assignment: &[Option<usize>],
    ) -> Option<VoiceProfile> {
        let mic: Vec<usize> = (0..finals.len())
            .filter(|&f| finals[f].track == Track::Mic && speech[f] > 0)
            .collect();
        let [only] = mic[..] else {
            return None;
        };
        if user != Some(only) || speech[only] < self.config.enrol_min_ms {
            return None;
        }
        // One voice on the microphone is not proof of one person: voices the
        // live pass could not tell apart end up together. Learn only from
        // speech that holds together as one voice.
        let (mut unlike, mut total) = (0u64, 0u64);
        for (piece, a) in self.pieces.iter().zip(assignment) {
            if let (Some(FinalLabel::Speaker(f)), Some(e)) =
                (a.map(FinalLabel::from), piece.embedding.as_deref())
                && f == only
            {
                total += piece.ms();
                if finals[only].centroid.similarity(e) < self.config.mic_new_speaker {
                    unlike += piece.ms();
                }
            }
        }
        if (unlike + self.mic_absorbed_ms) as f64 > total as f64 * self.config.enrol_max_unlike {
            return None;
        }
        let learnt = VoiceProfile::new(
            self.embedder.model_id(),
            &finals[only].centroid.unit,
            speech[only],
        );
        match &self.profile {
            Some(profile) if profile.similarity(&learnt.embedding) >= self.config.profile_match => {
                Some(profile.merged(&learnt))
            }
            Some(_) => None,
            None => Some(learnt),
        }
    }
}

struct FinalCluster {
    track: Track,
    centroid: Centroid,
}

/// Final assignments pack "speaker f" and "echo of speaker f" into one
/// `usize` so the per-piece table stays a flat vector.
#[derive(Clone, Copy)]
enum FinalLabel {
    Speaker(usize),
    Echo(usize),
}

impl From<usize> for FinalLabel {
    fn from(v: usize) -> Self {
        if v & 1 == 0 {
            FinalLabel::Speaker(v >> 1)
        } else {
            FinalLabel::Echo(v >> 1)
        }
    }
}

impl From<FinalLabel> for usize {
    fn from(v: FinalLabel) -> Self {
        match v {
            FinalLabel::Speaker(f) => f << 1,
            FinalLabel::Echo(f) => (f << 1) | 1,
        }
    }
}

fn other_track(track: Track) -> Track {
    match track {
        Track::Mic => Track::System,
        Track::System => Track::Mic,
    }
}

fn track_index(track: Track) -> usize {
    match track {
        Track::Mic => 0,
        Track::System => 1,
    }
}

/// Two-means over one speaker's stretches. Seeds are the stretches of at
/// least a second least like the whole, each paired with the whole and with
/// its own opposite; three people heard as one rarely split well from a
/// single seed. Returns which stretches form the second group for the
/// clearest split whose groups are unlike enough and both hold `min_side`
/// seconds.
fn two_way(items: &[(&[f32], f32)], threshold: f32, min_side: f32) -> Option<Vec<bool>> {
    let dim = items.first()?.0.len();
    let mut all = Centroid::new(dim);
    for (e, w) in items {
        all.add(e, *w);
    }
    let mut seeds: Vec<&[f32]> = items
        .iter()
        .filter(|(_, w)| *w >= 1.0)
        .map(|(e, _)| *e)
        .collect();
    seeds.sort_by(|a, b| all.similarity(a).total_cmp(&all.similarity(b)));
    seeds.truncate(SPLIT_SEEDS);
    let mut best: Option<(f32, Vec<bool>)> = None;
    for seed in &seeds {
        let opposite = items
            .iter()
            .filter(|(_, w)| *w >= 1.0)
            .min_by(|a, b| dot(seed, a.0).total_cmp(&dot(seed, b.0)))
            .map(|(e, _)| *e)?;
        for other in [all.unit.as_slice(), opposite] {
            let Some((sim, side)) = two_means(items, seed, other, min_side) else {
                continue;
            };
            if sim < threshold && best.as_ref().is_none_or(|(s, _)| sim < *s) {
                best = Some((sim, side));
            }
        }
    }
    best.map(|(_, side)| side)
}

fn two_means(
    items: &[(&[f32], f32)],
    first: &[f32],
    second: &[f32],
    min_side: f32,
) -> Option<(f32, Vec<bool>)> {
    let dim = first.len();
    let mut one = Centroid::from(first, 1.0);
    let mut two = Centroid::from(second, 1.0);
    let mut side = vec![false; items.len()];
    for _ in 0..8 {
        for (s, (e, _)) in side.iter_mut().zip(items) {
            *s = two.similarity(e) > one.similarity(e);
        }
        let mut a = Centroid::new(dim);
        let mut b = Centroid::new(dim);
        for (s, (e, w)) in side.iter().zip(items) {
            if *s {
                b.add(e, *w);
            } else {
                a.add(e, *w);
            }
        }
        if a.weight == 0.0 || b.weight == 0.0 {
            return None;
        }
        one = a;
        two = b;
    }
    (one.weight >= min_side && two.weight >= min_side).then(|| (dot(&one.unit, &two.unit), side))
}

/// Pearson correlation; `None` when either side is flat.
fn correlation(a: &[f32], b: &[f32]) -> Option<f32> {
    let n = a.len().min(b.len()) as f32;
    if n < 2.0 {
        return None;
    }
    let (ma, mb) = (a.iter().sum::<f32>() / n, b.iter().sum::<f32>() / n);
    let (mut ab, mut aa, mut bb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        let (x, y) = (x - ma, y - mb);
        ab += x * y;
        aa += x * x;
        bb += y * y;
    }
    (aa > 1e-6 && bb > 1e-6).then(|| ab / (aa * bb).sqrt())
}

/// A single window whose neighbours agree with each other is a blip.
fn smooth(labels: &mut [Option<(SpeakerId, bool)>]) {
    if labels.len() < 3 {
        return;
    }
    for i in 1..labels.len() - 1 {
        if labels[i - 1] == labels[i + 1] && labels[i] != labels[i - 1] && labels[i - 1].is_some() {
            labels[i] = labels[i - 1];
        }
    }
}

fn power(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    samples.iter().map(|x| x * x).sum::<f32>() / samples.len() as f32
}

/// The voice clearly loudest on the microphone among those with enough
/// speech: `(id, speech ms, mean power)`. None when there is one such voice
/// or no clear winner.
fn loudest<T: Copy + PartialEq>(voices: &[(T, u64, f64)], config: &Config) -> Option<T> {
    let most = voices.iter().map(|v| v.1).max()?;
    let enough: Vec<&(T, u64, f64)> = voices
        .iter()
        .filter(|v| v.1 >= config.user_min_ms && v.1 as f64 >= most as f64 * config.user_min_share)
        .collect();
    if enough.len() < 2 {
        return None;
    }
    let db = |p: f64| 10.0 * p.max(1e-12).log10();
    let top = enough.iter().max_by_key(|v| v.1)?;
    let loud = enough.iter().max_by(|a, b| a.2.total_cmp(&b.2))?;
    (loud.0 != top.0 && db(loud.2) >= db(top.2) + config.user_louder_db).then_some(loud.0)
}
