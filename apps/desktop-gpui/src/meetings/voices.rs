use std::collections::{BTreeMap, HashMap, HashSet};

use cap_diarize::{
    Config, Embed, FinalPass, LateNemotron, MeetingDiarizer, Segment, SegmentLabels, SpeakerId,
    SpeakerInfo, Track, VoiceProfile,
};
use cap_meetings::transcript::{Source, Utterance, Word};

use super::{capture::utterance_id, timeline};

/// Labels waiting for their words. Segments are transcribed in order within a
/// few seconds (minutes when batched for the cloud), so this only bounds what
/// a stalled engine could pile up.
const PENDING_LABELS_MAX: usize = 2_048;

pub type LoadEmbedder = Box<dyn FnOnce() -> Result<Box<dyn Embed>, String> + Send>;

pub struct VoicesConfig {
    pub load: LoadEmbedder,
    pub profile: Option<VoiceProfile>,
    /// A resumed meeting numbers its new voices after the ones already in
    /// the document, and its user keeps the document's user id.
    pub id_offset: u32,
    pub prior_user: Option<u32>,
}

/// What the end-of-meeting pass changed, in the document's ids.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FinalVoices {
    pub assign: Vec<(String, u32)>,
    pub pass: FinalPass,
}

struct Emitted {
    track: Track,
    key: u64,
    id: String,
    start_ms: u64,
    end_ms: u64,
    speaker: Option<u32>,
}

/// Nemotron still hearing a finished meeting (machines where it waits for
/// Stop): the lines as the final pass left them, to move once it is done.
pub struct LateVoices {
    late: LateNemotron,
    prior_user: Option<u32>,
    id_offset: u32,
    lines: Vec<Emitted>,
}

/// What Nemotron's after-Stop pass moves: `voices` as from a final pass, and
/// `expect`, the voice each moved line had when the meeting finished (a line
/// the user moved or deleted since stays as it is).
#[derive(Clone, Debug, PartialEq)]
pub struct LateResult {
    pub voices: FinalVoices,
    pub expect: Vec<(String, Option<u32>)>,
}

impl LateVoices {
    /// Blocks until Nemotron is done (on its own low-priority thread); None
    /// when it failed or moves nothing.
    pub fn resolve(self) -> Option<LateResult> {
        let started = std::time::Instant::now();
        let (pass, stats) = match self.late.wait() {
            Ok(done) => done,
            Err(error) => {
                tracing::warn!(%error, "Nemotron after Stop failed, kept the speaker model's labels");
                return None;
            }
        };
        let (segments, pass) = in_document_ids(pass, self.prior_user, self.id_offset);
        let mut assign = Vec::new();
        let mut expect = Vec::new();
        for line in &self.lines {
            let Some(labels) = segments.get(&(line.track, line.key)) else {
                continue;
            };
            if let Some(speaker) = best_overlap(labels, line.start_ms, line.end_ms)
                && Some(speaker) != line.speaker
            {
                assign.push((line.id.clone(), speaker));
                expect.push((line.id.clone(), line.speaker));
            }
        }
        tracing::info!(
            waited_ms = started.elapsed().as_millis() as u64,
            relabelled_ms = stats.relabelled_ms,
            new_voices = stats.new_voices,
            merged = stats.merged_ids,
            lines = assign.len(),
            "Nemotron after Stop"
        );
        (!assign.is_empty()).then(|| LateResult {
            voices: FinalVoices { assign, pass },
            expect,
        })
    }
}

/// The pass's ids as the document numbers them, and its segments by key.
fn in_document_ids(
    mut pass: FinalPass,
    prior_user: Option<u32>,
    id_offset: u32,
) -> (BTreeMap<(Track, u64), SegmentLabels>, FinalPass) {
    let user = pass.user;
    let map = |id: SpeakerId| -> u32 {
        match prior_user {
            Some(prior) if Some(id) == user => prior,
            _ => id.0 + id_offset,
        }
    };
    let segments: BTreeMap<(Track, u64), SegmentLabels> = std::mem::take(&mut pass.segments)
        .into_iter()
        .map(|mut s| {
            for span in &mut s.spans {
                span.speaker = SpeakerId(map(span.speaker));
            }
            ((s.track, s.key), s)
        })
        .collect();
    for (from, to) in &mut pass.merged {
        *from = SpeakerId(map(*from));
        *to = SpeakerId(map(*to));
    }
    for s in &mut pass.speakers {
        s.id = SpeakerId(map(s.id));
    }
    pass.user = user.map(|u| SpeakerId(map(u)));
    (segments, pass)
}

enum State {
    Unloaded(LoadEmbedder),
    Ready(Box<MeetingDiarizer>),
    Off,
}

pub struct Voices {
    state: State,
    profile: Option<VoiceProfile>,
    id_offset: u32,
    prior_user: Option<u32>,
    labels: BTreeMap<(Track, u64), SegmentLabels>,
    emitted: Vec<Emitted>,
    /// The latest segment start each track has pushed, so a peek at an open
    /// segment never repeats a closed one.
    pushed: [Option<u64>; 2],
    /// Every segment already labelled: pushed once, whatever its order.
    seen: HashSet<(Track, u64)>,
    last: [Option<u32>; 2],
    /// Who the open segment on each track starts with, from `peek`.
    open: [Option<(u64, u32)>; 2],
    published: Vec<SpeakerInfo>,
    /// Microphone lines the end-of-meeting pass found to be only the call
    /// heard through the speakers: duplicates of the call's own lines.
    echoes: Vec<String>,
    /// The farm's voice turns per track (mic, system), source ms, by the
    /// meeting's own farm voice (see `farm_clip`).
    farm: [Vec<(u64, u64, usize)>; 2],
    /// Per track: each farm voice's overlap with this meeting's voices (ms),
    /// and which farm voice each letter meant last.
    farm_voices: [Vec<HashMap<u32, u64>>; 2],
    farm_letters: [HashMap<usize, usize>; 2],
    late: Option<LateVoices>,
    /// The meeting's stretches between device changes and whether the call
    /// was heard on the microphone in each (see `echo_periods`).
    echo_stretches: Vec<(u64, bool)>,
    #[cfg(test)]
    test_nemotron: Option<(Box<dyn cap_diarize::nemotron::NemoModel>, cap_diarize::nemotron::Schedule)>,
}

fn track(source: Source) -> Track {
    match source {
        Source::Mic => Track::Mic,
        Source::System => Track::System,
    }
}

fn index(track: Track) -> usize {
    match track {
        Track::Mic => 0,
        Track::System => 1,
    }
}

impl Voices {
    pub fn new(config: VoicesConfig) -> Self {
        Self {
            state: State::Unloaded(config.load),
            profile: config.profile,
            id_offset: config.id_offset,
            prior_user: config.prior_user,
            labels: BTreeMap::new(),
            emitted: Vec::new(),
            pushed: [None, None],
            seen: HashSet::new(),
            last: [None, None],
            open: [None, None],
            published: Vec::new(),
            echoes: Vec::new(),
            farm: [Vec::new(), Vec::new()],
            farm_voices: [Vec::new(), Vec::new()],
            farm_letters: [HashMap::new(), HashMap::new()],
            late: None,
            echo_stretches: Vec::new(),
            #[cfg(test)]
            test_nemotron: None,
        }
    }

    /// A scripted Nemotron in place of the downloaded one (tests).
    #[cfg(test)]
    pub fn with_nemotron(
        mut self,
        model: Box<dyn cap_diarize::nemotron::NemoModel>,
        schedule: cap_diarize::nemotron::Schedule,
    ) -> Self {
        self.test_nemotron = Some((model, schedule));
        self
    }

    pub fn is_off(&self) -> bool {
        matches!(self.state, State::Off)
    }

    /// A word the farm labelled with one of its voices (cloud transcription
    /// with a speaker session): used at the end when Nemotron did not run here.
    pub fn farm_word(&mut self, source: Source, start_ms: u64, end_ms: u64, voice: usize) {
        let turns = &mut self.farm[index(track(source))];
        match turns.last_mut() {
            Some(last) if last.2 == voice && start_ms <= last.1 + 300 => last.1 = last.1.max(end_ms),
            _ => turns.push((start_ms, end_ms, voice)),
        }
    }

    /// One clip's farm words (source ms and the farm's letter). A letter is
    /// one person only within a clip: the farm starts its letters over when
    /// it restarts, and its backup letters every clip. Each letter becomes
    /// one of this meeting's farm voices: the one it meant before while this
    /// meeting's own voices agree, else the farm voice that heard the same
    /// person, else a new one. Two letters the embeddings hear as one person
    /// stay two (the farm may tell apart what the embeddings could not).
    pub fn farm_clip(&mut self, source: Source, words: &[(u64, u64, usize)]) {
        let track = track(source);
        let t = index(track);
        let mut votes: BTreeMap<usize, HashMap<u32, u64>> = BTreeMap::new();
        for &(a, b, letter) in words {
            let entry = votes.entry(letter).or_default();
            if let Some(voice) = self.voice_at(track, a, b) {
                *entry.entry(voice).or_default() += b.saturating_sub(a).max(1);
            }
        }
        let dominant = |v: &HashMap<u32, u64>| v.iter().max_by_key(|(id, ms)| (**ms, std::cmp::Reverse(**id))).map(|(id, _)| *id);
        let mut order: Vec<(usize, u64)> = votes.iter().map(|(l, v)| (*l, v.values().sum())).collect();
        order.sort_by_key(|(l, ms)| (std::cmp::Reverse(*ms), *l));
        let mut claimed: HashSet<usize> = HashSet::new();
        let mut mapping: HashMap<usize, usize> = HashMap::new();
        for (letter, _) in order {
            let mine = dominant(&votes[&letter]);
            let before = self.farm_letters[t].get(&letter).copied();
            let heard = |c: usize, voices: &[HashMap<u32, u64>]| dominant(&voices[c]);
            let free = |c: &usize| !claimed.contains(c);
            let letters = &self.farm_letters[t];
            // No letter means it any more (its letter was taken over).
            let orphan = |c: usize| !letters.values().any(|&x| x == c);
            let kept = before.filter(free);
            let pick = match (kept, mine) {
                (Some(p), Some(m)) if heard(p, &self.farm_voices[t]).is_none_or(|h| h == m) => Some(p),
                (Some(p), None) => Some(p),
                // The letter now names someone else (a restart, or backup
                // letters): the farm voice that heard this person, if any.
                (_, Some(m)) => (0..self.farm_voices[t].len())
                    .filter(free)
                    .find(|&c| heard(c, &self.farm_voices[t]) == Some(m) && (before.is_some() || orphan(c)))
                    .or(kept),
                (None, None) => None,
            };
            let pick = match pick {
                Some(c) => c,
                None if self.farm_voices[t].len() < cap_diarize::nemotron::cache::SPEAKERS => {
                    self.farm_voices[t].push(HashMap::new());
                    self.farm_voices[t].len() - 1
                }
                // More people than the pass can hold: the least heard one.
                None => (0..self.farm_voices[t].len())
                    .filter(free)
                    .min_by_key(|&c| self.farm_voices[t][c].values().sum::<u64>())
                    .unwrap_or(0),
            };
            claimed.insert(pick);
            mapping.insert(letter, pick);
            self.farm_letters[t].insert(letter, pick);
            for (voice, ms) in &votes[&letter] {
                *self.farm_voices[t][pick].entry(*voice).or_default() += ms;
            }
        }
        for &(a, b, letter) in words {
            if let Some(&voice) = mapping.get(&letter) {
                self.farm_word(source, a, b, voice);
            }
        }
    }

    /// The meeting's own voice over source ms [a, b), from labels still
    /// waiting for their words.
    fn voice_at(&self, track: Track, a: u64, b: u64) -> Option<u32> {
        let mut best: Option<(u64, u32)> = None;
        for ((t, _), labels) in self.labels.iter() {
            if *t != track {
                continue;
            }
            for span in labels.spans.iter().filter(|s| !s.echo) {
                let overlap = b.max(a + 1).min(span.end_ms).saturating_sub(a.max(span.start_ms));
                if overlap > 0 && best.is_none_or(|(ms, _)| overlap > ms) {
                    best = Some((overlap, span.speaker.0));
                }
            }
        }
        best.map(|(_, id)| id)
    }

    fn diarizer(&mut self) -> Option<&mut MeetingDiarizer> {
        if matches!(self.state, State::Unloaded(_)) {
            let State::Unloaded(load) = std::mem::replace(&mut self.state, State::Off) else {
                unreachable!()
            };
            match load() {
                Ok(embedder) => {
                    let mut diarizer = MeetingDiarizer::new(Config::default(), embedder, self.profile.take());
                    // the end-of-meeting pass also asks Nemotron when it is downloaded:
                    // once, after Stop (see Schedule::for_this_machine)
                    if let Some(model) = super::speakers::load_nemotron() {
                        diarizer.set_nemotron_with(
                            model,
                            cap_diarize::nemotron::Schedule::for_this_machine(),
                            crate::transcription::lower_thread_priority,
                        );
                    }
                    #[cfg(test)]
                    if let Some((model, schedule)) = self.test_nemotron.take() {
                        diarizer.set_nemotron_with(model, schedule, || {});
                    }
                    diarizer.set_echo_stretches(&self.echo_stretches);
                    self.state = State::Ready(Box::new(diarizer));
                }
                Err(error) => {
                    tracing::warn!(%error, "the speaker model could not load, voices stay together");
                }
            }
        }
        match &mut self.state {
            State::Ready(diarizer) => Some(diarizer),
            _ => None,
        }
    }

    fn map(&self, id: SpeakerId, user: Option<SpeakerId>) -> u32 {
        match self.prior_user {
            Some(prior) if Some(id) == user => prior,
            _ => id.0 + self.id_offset,
        }
    }

    /// Runs the speaker model on one closed segment. Returns the live voices
    /// when they changed, for the transcript's names. A segment transcribed
    /// again from the saved audio (out of time order) is labelled like the
    /// rest, so its lines get voices and go through the final passes.
    pub fn push(
        &mut self,
        source: Source,
        start_sample: u64,
        samples: &[f32],
    ) -> Option<Vec<SpeakerInfo>> {
        let track = track(source);
        if !self.seen.insert((track, start_sample)) {
            return None;
        }
        let slot = index(track);
        let late = self.pushed[slot].is_some_and(|at| at > start_sample);
        if !late {
            self.pushed[slot] = Some(start_sample);
        }
        let diarizer = self.diarizer()?;
        let result = diarizer.push(Segment {
            track,
            key: start_sample,
            start_ms: timeline::samples_to_ms(start_sample),
            samples,
        });
        let labels = match result {
            Ok(labels) => labels,
            Err(cap_diarize::Error::TooShort) => return None,
            Err(error) => {
                tracing::warn!(%error, "speaker model failed, voices stay together from here");
                self.state = State::Off;
                return None;
            }
        };
        let user = diarizer.user();
        let speakers = diarizer.speakers();
        // A late segment is not who spoke last: live captions keep theirs.
        if !late && let Some(span) = labels.spans.iter().rev().find(|s| !s.echo) {
            self.last[slot] = Some(self.map(span.speaker, user));
        }
        let mut mapped = labels;
        for span in &mut mapped.spans {
            span.speaker = SpeakerId(self.map(span.speaker, user));
        }
        self.labels.insert((track, start_sample), mapped);
        while self.labels.len() > PENDING_LABELS_MAX {
            self.labels.pop_first();
        }
        let speakers: Vec<SpeakerInfo> = speakers
            .into_iter()
            .map(|s| SpeakerInfo {
                id: SpeakerId(self.map(s.id, user)),
                is_user: s.is_user,
                ..s
            })
            .collect();
        (speakers != self.published).then(|| {
            self.published = speakers.clone();
            speakers
        })
    }

    /// Listens to a segment that is still open, so its partial words show
    /// who is speaking now rather than who spoke last. The segment's labels
    /// when it closes are unchanged (and come sooner: the work is reused).
    pub fn peek(&mut self, source: Source, start_sample: u64, samples: &[f32]) {
        let track = track(source);
        let slot = index(track);
        if self.pushed[slot].is_some_and(|at| at >= start_sample) {
            return;
        }
        let Some(diarizer) = self.diarizer() else {
            return;
        };
        let result = diarizer.peek(Segment {
            track,
            key: start_sample,
            start_ms: timeline::samples_to_ms(start_sample),
            samples,
        });
        let speaker = match result {
            Ok(speaker) => speaker,
            Err(cap_diarize::Error::TooShort) => None,
            Err(error) => {
                tracing::warn!(%error, "speaker model failed, voices stay together from here");
                self.state = State::Off;
                return;
            }
        };
        let user = diarizer.user();
        self.open[slot] = speaker.map(|s| (start_sample, self.map(s, user)));
    }

    /// The voice to show on a partial line before its segment closes.
    pub fn current(&self, source: Source) -> Option<u32> {
        self.last[index(track(source))]
    }

    fn partial_speaker(&self, source: Source, start_sample: u64) -> Option<u32> {
        match self.open[index(track(source))] {
            Some((key, speaker)) if key == start_sample => Some(speaker),
            _ => self.current(source),
        }
    }

    /// Turns one segment's words into utterances, one per stretch of a
    /// single voice. Words the model heard as the other track's speaker
    /// echoing back are dropped: the other track holds the original.
    pub fn split(
        &mut self,
        source: Source,
        start_sample: u64,
        words: Vec<Word>,
        is_final: bool,
    ) -> Vec<Utterance> {
        self.split_lines(source, start_sample, words, is_final, is_final)
    }

    /// Lines for a closed segment whose final words come later (Cloud): the
    /// speaker split the final `split` will use, without using it up or
    /// counting the lines for the end-of-meeting pass.
    pub fn split_provisional(
        &mut self,
        source: Source,
        start_sample: u64,
        words: Vec<Word>,
    ) -> Vec<Utterance> {
        self.split_lines(source, start_sample, words, true, false)
    }

    fn split_lines(
        &mut self,
        source: Source,
        start_sample: u64,
        words: Vec<Word>,
        is_final: bool,
        commit: bool,
    ) -> Vec<Utterance> {
        let track = track(source);
        let taken = if commit {
            self.labels.remove(&(track, start_sample))
        } else {
            None
        };
        if commit && let State::Ready(diarizer) = &mut self.state {
            let middles: Vec<u64> = words
                .iter()
                .map(|w| (w.start_ms + w.end_ms.max(w.start_ms)) / 2)
                .collect();
            diarizer.transcribed(track, start_sample, &middles);
        }
        let labels = if commit {
            taken.as_ref()
        } else if is_final {
            self.labels.get(&(track, start_sample))
        } else {
            None
        };
        let base = utterance_id(source, start_sample);
        let segment_start = timeline::samples_to_ms(start_sample);
        let groups: Vec<(Option<u32>, Vec<Word>)> = match labels {
            Some(labels) if !labels.spans.is_empty() => group_words(labels, words),
            _ => {
                let speaker = if self.is_off() {
                    None
                } else if is_final {
                    self.current(source)
                } else {
                    self.partial_speaker(source, start_sample)
                };
                vec![(speaker, words)]
            }
        };
        let mut out = Vec::new();
        for (part, (speaker, words)) in groups.into_iter().enumerate() {
            let id = if part == 0 {
                base.clone()
            } else {
                format!("{base}#{part}")
            };
            if let Some(utterance) = build(id, source, segment_start, speaker, words, is_final) {
                if commit {
                    self.emitted.push(Emitted {
                        track,
                        key: start_sample,
                        id: utterance.id.clone(),
                        start_ms: utterance.start_ms,
                        end_ms: utterance.end_ms,
                        speaker: utterance.speaker_id,
                    });
                }
                out.push(utterance);
            }
        }
        out
    }

    /// The end-of-meeting pass: which stored utterances move to another
    /// voice, and the final voices.
    pub fn finish(&mut self) -> Option<FinalVoices> {
        let State::Ready(diarizer) = &mut self.state else {
            return None;
        };
        diarizer.set_echo_stretches(&self.echo_stretches);
        let farm = self.farm.iter().any(|t| !t.is_empty());
        if farm {
            // the farm already heard this meeting with the same model
            diarizer.cancel_after_stop_nemotron();
        }
        let mut pass = diarizer.finish();
        let late = diarizer.take_late();
        let stats = diarizer.stats();
        if !stats.nemotron_applied && farm {
            // no Nemotron here: the farm's voices (the same model, run on the cloud clips) stand in
            let end = |t: &[(u64, u64, usize)]| t.iter().map(|x| x.1).max().unwrap_or(0) + 10;
            let voices = [
                cap_diarize::nemotron::TrackVoices::from_turns(end(&self.farm[0]), &self.farm[0]),
                cap_diarize::nemotron::TrackVoices::from_turns(end(&self.farm[1]), &self.farm[1]),
            ];
            let h = cap_diarize::hybrid::apply(&mut pass, &voices);
            tracing::info!(relabelled_ms = h.relabelled_ms, new_voices = h.new_voices, "farm speaker labels final pass");
        }
        if let Some(error) = diarizer.nemotron_error() {
            tracing::warn!(%error, "Nemotron failed, kept the speaker model's labels");
        } else if stats.nemotron_applied {
            tracing::info!(
                relabelled_ms = stats.nemotron_relabelled_ms,
                new_voices = stats.nemotron_new_voices,
                merged = stats.nemotron_merged_ids,
                "Nemotron final pass"
            );
        }
        let (segments, pass) = in_document_ids(pass, self.prior_user, self.id_offset);
        let mut assign = Vec::new();
        let mut lines = Vec::new();
        self.echoes.clear();
        for mut e in std::mem::take(&mut self.emitted) {
            let Some(labels) = segments.get(&(e.track, e.key)) else {
                continue;
            };
            if e.track == Track::Mic && only_echo(labels, e.start_ms, e.end_ms) {
                self.echoes.push(e.id.clone());
                continue;
            }
            if let Some(speaker) = best_overlap(labels, e.start_ms, e.end_ms)
                && Some(speaker) != e.speaker
            {
                assign.push((e.id.clone(), speaker));
                e.speaker = Some(speaker);
            }
            lines.push(e);
        }
        self.late = late.map(|late| LateVoices {
            late,
            prior_user: self.prior_user,
            id_offset: self.id_offset,
            lines,
        });
        self.labels.clear();
        Some(FinalVoices { assign, pass })
    }

    /// Nemotron's after-Stop pass over the meeting the last `finish` closed.
    pub fn take_late(&mut self) -> Option<LateVoices> {
        self.late.take()
    }

    /// The microphone lines the last `finish` found to be the call heard
    /// through the speakers, to remove from the transcript.
    /// Where the meeting's devices changed and whether each stretch was
    /// heard repeating the call: the microphone only echoes the call where
    /// it hears it.
    pub fn set_echo_stretches(&mut self, stretches: Vec<(u64, bool)>) {
        if let State::Ready(diarizer) = &mut self.state {
            diarizer.set_echo_stretches(&stretches);
        }
        self.echo_stretches = stretches;
    }

    pub fn take_echoes(&mut self) -> Vec<String> {
        std::mem::take(&mut self.echoes)
    }

    #[cfg(test)]
    pub fn stats(&self) -> Option<cap_diarize::Stats> {
        match &self.state {
            State::Ready(d) => Some(d.stats()),
            _ => None,
        }
    }
}

/// Whether everything heard during a line is an echo of the other track.
fn only_echo(labels: &SegmentLabels, start_ms: u64, end_ms: u64) -> bool {
    let (mut echo, mut direct) = (0u64, 0u64);
    for span in &labels.spans {
        let overlap = end_ms
            .max(start_ms + 1)
            .min(span.end_ms)
            .saturating_sub(start_ms.max(span.start_ms));
        if span.echo {
            echo += overlap;
        } else {
            direct += overlap;
        }
    }
    echo > 0 && direct == 0
}

fn best_overlap(labels: &SegmentLabels, start_ms: u64, end_ms: u64) -> Option<u32> {
    let mut totals: Vec<(u32, u64)> = Vec::new();
    for span in labels.spans.iter().filter(|s| !s.echo) {
        let overlap = end_ms
            .max(start_ms + 1)
            .min(span.end_ms)
            .saturating_sub(start_ms.max(span.start_ms));
        if overlap == 0 {
            continue;
        }
        match totals.iter_mut().find(|(id, _)| *id == span.speaker.0) {
            Some(entry) => entry.1 += overlap,
            None => totals.push((span.speaker.0, overlap)),
        }
    }
    totals
        .into_iter()
        .max_by_key(|(_, ms)| *ms)
        .map(|(id, _)| id)
        .or_else(|| labels.main_speaker().map(|s| s.0))
}

fn group_words(labels: &SegmentLabels, words: Vec<Word>) -> Vec<(Option<u32>, Vec<Word>)> {
    let mut groups: Vec<((u32, bool), Vec<Word>)> = Vec::new();
    for word in words {
        let mid = (word.start_ms + word.end_ms.max(word.start_ms)) / 2;
        let span = labels
            .spans
            .iter()
            .find(|s| s.start_ms <= mid && mid < s.end_ms)
            .or_else(|| {
                labels.spans.iter().min_by_key(|s| {
                    if mid < s.start_ms {
                        s.start_ms - mid
                    } else {
                        mid.saturating_sub(s.end_ms)
                    }
                })
            });
        let Some(span) = span else {
            continue;
        };
        let key = (span.speaker.0, span.echo);
        match groups.last_mut() {
            Some((last, words)) if *last == key => words.push(word),
            _ => groups.push((key, vec![word])),
        }
    }
    groups
        .into_iter()
        .filter(|((_, echo), _)| !echo)
        .map(|((id, _), words)| (Some(id), words))
        .collect()
}

fn build(
    id: String,
    source: Source,
    segment_start: u64,
    speaker_id: Option<u32>,
    words: Vec<Word>,
    is_final: bool,
) -> Option<Utterance> {
    let text = words
        .iter()
        .map(|w| w.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let start_ms = words.first().map_or(segment_start, |w| w.start_ms);
    let end_ms = words
        .iter()
        .map(|w| w.end_ms)
        .max()
        .unwrap_or(start_ms)
        .max(start_ms);
    Some(Utterance {
        id,
        source,
        speaker: None,
        speaker_id,
        start_ms,
        end_ms,
        text: text.to_string(),
        is_final,
        words,
    })
}

#[cfg(test)]
mod tests;
