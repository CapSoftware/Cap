use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{FinalPass, SpeakerId, SpeakerInfo, Track};

#[cfg(test)]
mod tests;

/// When the calendar lists one other attendee but the computer's audio holds
/// a second voice briefly (someone saying hello from their side of the call),
/// the attendee's name stays on the voice holding at least this share.
const ATTENDEE_DOMINANCE: f64 = 0.85;

/// How a speaker is shown. The app turns `User` into the user's name (or its
/// word for "you") and `Person(n)` into its localised "Person n".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Label {
    User,
    Named(String),
    Person(u32),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NameChange {
    pub id: SpeakerId,
    pub before: Option<Label>,
    pub after: Option<Label>,
}

/// The meeting's names for its speakers: renames are keyed by speaker id so
/// they hold for the rest of the meeting and through the final pass.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SpeakerNames {
    attendee: Option<String>,
    attendee_voice: Option<SpeakerId>,
    user: Option<SpeakerId>,
    #[serde(with = "pairs")]
    renames: BTreeMap<SpeakerId, String>,
    #[serde(with = "pairs")]
    numbers: BTreeMap<SpeakerId, u32>,
    known: Vec<SpeakerId>,
    system_seen: bool,
    /// Voices the person said were not them ("That's not me"): numbered
    /// like anyone else and never taken for the user again in this meeting.
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    not_user: BTreeSet<SpeakerId>,
    /// Voices the person left out of the notes: still in the transcript,
    /// never in what the summary or Ask is given.
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    left_out: BTreeSet<SpeakerId>,
    /// Voices the person put back in the notes: kept even when their track
    /// was left out. A voice in neither set has no choice of its own.
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    kept_in: BTreeSet<SpeakerId>,
}

impl SpeakerNames {
    /// `other_attendee` is set when the calendar event lists exactly one
    /// attendee besides the user.
    pub fn new(other_attendee: Option<String>) -> Self {
        Self {
            attendee: other_attendee
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty()),
            ..Self::default()
        }
    }

    pub fn user(&self) -> Option<SpeakerId> {
        self.user
    }

    pub fn renames(&self) -> &BTreeMap<SpeakerId, String> {
        &self.renames
    }

    /// "That's not me": the voice is someone else from now on, with the
    /// next free number, and is never taken for the user again in this
    /// meeting (the live pass or the end-of-meeting one).
    pub fn not_user(&mut self, id: SpeakerId) {
        self.not_user.insert(id);
        if self.user == Some(id) {
            self.user = None;
        }
        if self.attendee_voice != Some(id) && !self.numbers.contains_key(&id) {
            let next = self.numbers.values().max().copied().unwrap_or(0) + 1;
            self.numbers.insert(id, next);
        }
        if !self.known.contains(&id) {
            self.known.push(id);
        }
    }

    /// "That's me": takes back "That's not me" on this voice, which is the
    /// user again. A voice shown as the user until now takes a number.
    pub fn claim_user(&mut self, id: SpeakerId) {
        self.not_user.remove(&id);
        if let Some(before) = self.user.replace(id)
            && before != id
            && self.attendee_voice != Some(before)
            && !self.numbers.contains_key(&before)
        {
            let next = self.numbers.values().max().copied().unwrap_or(0) + 1;
            self.numbers.insert(before, next);
        }
        if !self.known.contains(&id) {
            self.known.push(id);
        }
    }

    pub fn is_not_user(&self, id: SpeakerId) -> bool {
        self.not_user.contains(&id)
    }

    /// Whether the person said `id` (an end-of-meeting voice) was not them,
    /// following the live voices merged into it.
    pub fn disowns(&self, id: SpeakerId, merged: &[(SpeakerId, SpeakerId)]) -> bool {
        self.not_user.iter().any(|&live| follow(live, merged) == id)
    }

    /// Leaves the voice out of the notes, or puts it back in: either way a
    /// choice of its own, which its track's choice never overrides.
    pub fn set_left_out(&mut self, id: SpeakerId, out: bool) {
        self.choose_left_out(id, Some(out));
    }

    /// Leaves the voice out of the notes (`Some(true)`), puts it back in
    /// (`Some(false)`), or forgets the choice (`None`).
    pub fn choose_left_out(&mut self, id: SpeakerId, out: Option<bool>) {
        self.left_out.remove(&id);
        self.kept_in.remove(&id);
        match out {
            Some(true) => self.left_out.insert(id),
            Some(false) => self.kept_in.insert(id),
            None => false,
        };
    }

    /// The person's choice on this voice: left out, put back in, or none.
    pub fn left_out(&self, id: SpeakerId) -> Option<bool> {
        if self.left_out.contains(&id) {
            Some(true)
        } else if self.kept_in.contains(&id) {
            Some(false)
        } else {
            None
        }
    }

    pub fn is_left_out(&self, id: SpeakerId) -> bool {
        self.left_out(id) == Some(true)
    }

    /// The person's choices about voices follow the voices merged into
    /// others, as renames do. A merged voice that was both left out and
    /// kept in stays left out.
    fn follow_choices(&mut self, merged: &[(SpeakerId, SpeakerId)]) {
        for set in [&mut self.not_user, &mut self.left_out, &mut self.kept_in] {
            *set = set.iter().map(|&id| follow(id, merged)).collect();
        }
        let left_out = &self.left_out;
        self.kept_in.retain(|id| !left_out.contains(id));
    }

    /// Takes back the change from `before` to `after`, keeping whatever
    /// else changed since: names still equal to `after` become `before`
    /// exactly, and a choice made in between on another voice stays.
    pub fn revert(&mut self, before: &SpeakerNames, after: &SpeakerNames) {
        fn value<T: Clone + PartialEq>(now: &mut T, before: &T, after: &T) {
            if before != after {
                *now = before.clone();
            }
        }
        fn map<V: Clone + PartialEq>(
            now: &mut BTreeMap<SpeakerId, V>,
            before: &BTreeMap<SpeakerId, V>,
            after: &BTreeMap<SpeakerId, V>,
        ) {
            for id in before.keys().chain(after.keys()) {
                if before.get(id) != after.get(id) {
                    match before.get(id) {
                        Some(v) => now.insert(*id, v.clone()),
                        None => now.remove(id),
                    };
                }
            }
        }
        fn set(
            now: &mut BTreeSet<SpeakerId>,
            before: &BTreeSet<SpeakerId>,
            after: &BTreeSet<SpeakerId>,
        ) {
            for id in before.symmetric_difference(after) {
                if before.contains(id) {
                    now.insert(*id);
                } else {
                    now.remove(id);
                }
            }
        }
        value(&mut self.attendee, &before.attendee, &after.attendee);
        value(
            &mut self.attendee_voice,
            &before.attendee_voice,
            &after.attendee_voice,
        );
        value(&mut self.user, &before.user, &after.user);
        map(&mut self.renames, &before.renames, &after.renames);
        map(&mut self.numbers, &before.numbers, &after.numbers);
        self.known
            .retain(|id| before.known.contains(id) || !after.known.contains(id));
        for id in &before.known {
            if !self.known.contains(id) {
                self.known.push(*id);
            }
        }
        value(
            &mut self.system_seen,
            &before.system_seen,
            &after.system_seen,
        );
        set(&mut self.not_user, &before.not_user, &after.not_user);
        set(&mut self.left_out, &before.left_out, &after.left_out);
        set(&mut self.kept_in, &before.kept_in, &after.kept_in);
    }

    /// Takes in every voice that has a line in the transcript right now. A
    /// numbered voice with no line left (a partial line first heard as one
    /// voice, whose final words went to another) gives its number back, so
    /// the next new voice takes it and the numbers shown stay 1, 2, 3 from
    /// the live view to the notes. A voice the person named or made a choice
    /// about keeps its number.
    pub fn observe_speaking(&mut self, speakers: &[SpeakerInfo]) {
        let silent: Vec<SpeakerId> = self
            .numbers
            .keys()
            .copied()
            .filter(|id| {
                !speakers.iter().any(|s| s.id == *id)
                    && !self.renames.contains_key(id)
                    && !self.not_user.contains(id)
                    && !self.left_out.contains(id)
                    && !self.kept_in.contains(id)
            })
            .collect();
        for id in silent {
            self.numbers.remove(&id);
            self.known.retain(|k| *k != id);
        }
        self.observe(speakers);
    }

    /// The smallest number no voice holds.
    fn free_number(&self) -> u32 {
        (1..)
            .find(|n| !self.numbers.values().any(|v| v == n))
            .unwrap_or(1)
    }

    /// Takes in the live speaker list. Speakers already seen keep their
    /// labels; new ones are numbered in order of first speech.
    pub fn observe(&mut self, speakers: &[SpeakerInfo]) {
        let mut fresh: Vec<&SpeakerInfo> = speakers
            .iter()
            .filter(|s| !self.known.contains(&s.id))
            .collect();
        fresh.sort_by_key(|s| (s.first_ms, s.id));
        if let Some(user) = speakers
            .iter()
            .find(|s| s.is_user && !self.not_user.contains(&s.id))
            && self.user != Some(user.id)
        {
            // The microphone's user moved to a clearly louder voice: the
            // voice shown as the user until now takes the number the new
            // user had, so no one else is renumbered.
            match self.user.replace(user.id) {
                Some(before)
                    if self.known.contains(&before) && !self.numbers.contains_key(&before) =>
                {
                    let next = match self.numbers.remove(&user.id) {
                        Some(freed) => freed,
                        None => self.numbers.values().max().copied().unwrap_or(0) + 1,
                    };
                    self.numbers.insert(before, next);
                }
                // The first voice taken for the user: a number it was given
                // before it was known as the user is never shown, so it is
                // free for the next person.
                None => {
                    self.numbers.remove(&user.id);
                }
                _ => {}
            }
        }
        for speaker in fresh {
            self.known.push(speaker.id);
            if Some(speaker.id) == self.user {
                continue;
            }
            let first_system = speaker.track == Track::System && !self.system_seen;
            if speaker.track == Track::System {
                self.system_seen = true;
            }
            if first_system && self.attendee.is_some() {
                self.attendee_voice = Some(speaker.id);
                continue;
            }
            let next = self.free_number();
            self.numbers.insert(speaker.id, next);
        }
    }

    /// The number each told-apart voice was given (its "Person n"). A voice
    /// keeps it through renames.
    pub fn numbers(&self) -> &BTreeMap<SpeakerId, u32> {
        &self.numbers
    }

    pub fn label(&self, id: SpeakerId) -> Option<Label> {
        if let Some(name) = self.renames.get(&id) {
            return Some(Label::Named(name.clone()));
        }
        if Some(id) == self.user {
            return Some(Label::User);
        }
        if Some(id) == self.attendee_voice
            && let Some(name) = &self.attendee
        {
            return Some(Label::Named(name.clone()));
        }
        self.numbers.get(&id).map(|n| Label::Person(*n))
    }

    /// Names a speaker for the rest of the meeting; an empty name clears the
    /// rename.
    pub fn rename(&mut self, id: SpeakerId, name: &str) {
        let name = name.trim();
        if name.is_empty() {
            self.renames.remove(&id);
        } else {
            self.renames.insert(id, name.to_string());
        }
    }

    /// Applies a correction that arrives after the meeting was finished (and
    /// may already be summarised): renames and the attendee's name follow
    /// merged speakers, and nobody is renumbered. A merged voice leaves its
    /// number unused; a voice only the correction found takes the next one.
    pub fn apply_late(&mut self, pass: &FinalPass) -> Vec<NameChange> {
        let mut ids: Vec<SpeakerId> = self.known.clone();
        ids.extend(pass.speakers.iter().map(|s| s.id));
        ids.sort();
        ids.dedup();
        let before: Vec<(SpeakerId, Option<Label>)> =
            ids.iter().map(|id| (*id, self.label(*id))).collect();

        let follow = |mut id: SpeakerId| {
            for _ in 0..pass.merged.len() {
                match pass.merged.iter().find(|(from, _)| *from == id) {
                    Some((_, to)) => id = *to,
                    None => break,
                }
            }
            id
        };
        for (from, to) in &pass.merged {
            if let Some(name) = self.renames.remove(from) {
                self.renames.entry(*to).or_insert(name);
            }
        }
        self.follow_choices(&pass.merged);
        let alive: Vec<SpeakerId> = pass.speakers.iter().map(|s| s.id).collect();
        self.renames.retain(|id, _| alive.contains(id));
        if pass.user.is_some() {
            self.user = pass
                .user
                .map(follow)
                .filter(|id| !self.not_user.contains(id));
        }
        self.attendee_voice = self.attendee_voice.map(follow).filter(|id| alive.contains(id));
        self.numbers
            .retain(|id, _| alive.contains(id) && Some(*id) != self.user && Some(*id) != self.attendee_voice);
        let mut fresh: Vec<&SpeakerInfo> = pass
            .speakers
            .iter()
            .filter(|s| {
                !self.numbers.contains_key(&s.id) && Some(s.id) != self.user && Some(s.id) != self.attendee_voice
            })
            .collect();
        fresh.sort_by_key(|s| (s.first_ms, s.id));
        for s in fresh {
            let next = self.numbers.values().max().copied().unwrap_or(0) + 1;
            self.numbers.insert(s.id, next);
        }
        self.system_seen |= pass.speakers.iter().any(|s| s.track == Track::System);
        self.known = alive;

        before
            .into_iter()
            .filter_map(|(id, before)| {
                let after = self.label(id);
                (before != after).then_some(NameChange { id, before, after })
            })
            .collect()
    }

    /// Applies the end-of-meeting pass: renames follow merged speakers, the
    /// user is the voice the pass picked, and everyone else keeps the order
    /// they were numbered in live, closing the gaps voices merged away left
    /// (voices only the pass found come last, in order of first speech), so
    /// as few labels as possible change under the reader. Returns every
    /// speaker whose label changed.
    pub fn apply_final(&mut self, pass: &FinalPass) -> Vec<NameChange> {
        let mut ids: Vec<SpeakerId> = self.known.clone();
        ids.extend(pass.speakers.iter().map(|s| s.id));
        ids.sort();
        ids.dedup();
        let before: Vec<(SpeakerId, Option<Label>)> =
            ids.iter().map(|id| (*id, self.label(*id))).collect();

        for (from, to) in &pass.merged {
            if let Some(name) = self.renames.remove(from) {
                self.renames.entry(*to).or_insert(name);
            }
        }
        self.follow_choices(&pass.merged);
        let alive: Vec<SpeakerId> = pass.speakers.iter().map(|s| s.id).collect();
        self.renames.retain(|id, _| alive.contains(id));
        self.user = pass.user.filter(|id| !self.not_user.contains(id));

        let system: Vec<&SpeakerInfo> = pass
            .speakers
            .iter()
            .filter(|s| s.track == Track::System)
            .collect();
        let total: u64 = system.iter().map(|s| s.speech_ms).sum();
        self.attendee_voice = match system.iter().max_by_key(|s| s.speech_ms) {
            Some(top)
                if self.attendee.is_some()
                    && (system.len() == 1
                        || top.speech_ms as f64 >= total as f64 * ATTENDEE_DOMINANCE) =>
            {
                Some(top.id)
            }
            _ => None,
        };

        let mut order: Vec<&SpeakerInfo> = pass
            .speakers
            .iter()
            .filter(|s| Some(s.id) != self.user && Some(s.id) != self.attendee_voice)
            .collect();
        let live = std::mem::take(&mut self.numbers);
        order.sort_by_key(|s| {
            (
                live.get(&s.id).copied().unwrap_or(u32::MAX),
                s.first_ms,
                s.id,
            )
        });
        self.numbers = order
            .iter()
            .enumerate()
            .map(|(i, s)| (s.id, i as u32 + 1))
            .collect();
        self.system_seen = !system.is_empty();
        self.known = alive;

        before
            .into_iter()
            .filter_map(|(id, before)| {
                let after = self.label(id);
                (before != after).then_some(NameChange { id, before, after })
            })
            .collect()
    }
}

/// Where a live voice ended up after the end-of-meeting pass merged voices.
fn follow(mut id: SpeakerId, merged: &[(SpeakerId, SpeakerId)]) -> SpeakerId {
    for _ in 0..merged.len() {
        match merged.iter().find(|(from, _)| *from == id) {
            Some((_, to)) => id = *to,
            None => break,
        }
    }
    id
}

/// Maps keyed by voice are stored as `[id, value]` pairs: the transcript log
/// is an internally tagged enum, and serde's buffering there cannot read
/// numeric JSON object keys back, so every names line was dropped on load.
mod pairs {
    use std::collections::BTreeMap;

    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer, K: Serialize, V: Serialize>(
        map: &BTreeMap<K, V>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(map.iter())
    }

    pub fn deserialize<
        'de,
        D: Deserializer<'de>,
        K: Deserialize<'de> + Ord,
        V: Deserialize<'de>,
    >(
        deserializer: D,
    ) -> Result<BTreeMap<K, V>, D::Error> {
        Vec::<(K, V)>::deserialize(deserializer).map(|pairs| pairs.into_iter().collect())
    }
}
