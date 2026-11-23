//! Whether a meeting's microphone hears the call, stretch by stretch.
//!
//! A 1-3 word microphone line over the same words of the call is an echo
//! only where the speakers play into the microphone, which a full sentence
//! coming back proves. That holds for the devices of the moment: moving from
//! the speakers to a headset ends it, and a quick "Yes" there is the
//! person's own. So every change of microphone or output starts a new
//! stretch that has to prove it again, and lines keep the judgement of the
//! stretch they started in.

#[derive(Clone, Debug, PartialEq)]
pub struct EchoPeriods {
    /// Where each stretch starts on the meeting's timeline (ms), and whether
    /// the call was heard on the microphone in it. The first starts at 0.
    stretches: Vec<(u64, bool)>,
}

impl Default for EchoPeriods {
    fn default() -> Self {
        Self {
            stretches: vec![(0, false)],
        }
    }
}

impl EchoPeriods {
    /// A meeting recorded into from `at_ms` on (a resumed one carries on
    /// its timeline): what came before was on devices nobody looked at.
    pub fn from(at_ms: u64) -> Self {
        let mut periods = Self::default();
        periods.devices_changed(at_ms);
        periods
    }

    /// The microphone or the output changed at `at_ms`.
    pub fn devices_changed(&mut self, at_ms: u64) {
        match self.stretches.last_mut() {
            Some(last) if last.0 >= at_ms => last.1 = false,
            _ => self.stretches.push((at_ms, false)),
        }
    }

    /// A sentence of the call came back on the microphone in a line that
    /// began at `at_ms`. True when its stretch was not known to hear it yet.
    pub fn heard_at(&mut self, at_ms: u64) -> bool {
        let index = self
            .stretches
            .partition_point(|&(start, _)| start <= at_ms)
            .saturating_sub(1);
        let Some(stretch) = self.stretches.get_mut(index) else {
            return false;
        };
        !std::mem::replace(&mut stretch.1, true)
    }

    /// Each stretch's start (ms) and whether the call was heard in it.
    pub fn stretches(&self) -> &[(u64, bool)] {
        &self.stretches
    }

    /// The stretches whose short lines are judged, as `[from, until)` ms.
    pub fn heard_spans(&self) -> Vec<(u64, u64)> {
        self.stretches
            .iter()
            .enumerate()
            .filter(|(_, stretch)| stretch.1)
            .map(|(i, stretch)| {
                let until = self.stretches.get(i + 1).map_or(u64::MAX, |next| next.0);
                (stretch.0, until)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stretch_is_judged_only_once_it_heard_the_call() {
        let mut periods = EchoPeriods::default();
        assert!(periods.heard_spans().is_empty());
        assert!(periods.heard_at(5_000));
        assert!(!periods.heard_at(6_000), "already known");
        assert_eq!(periods.heard_spans(), vec![(0, u64::MAX)]);
    }

    #[test]
    fn a_device_change_starts_a_stretch_that_has_to_hear_it_again() {
        let mut periods = EchoPeriods::default();
        periods.heard_at(5_000);
        periods.devices_changed(20_000);
        assert_eq!(periods.heard_spans(), vec![(0, 20_000)]);
        // A sentence that began before the switch, finished after it.
        assert!(!periods.heard_at(19_000));
        assert_eq!(periods.heard_spans(), vec![(0, 20_000)]);
        periods.devices_changed(40_000);
        assert!(periods.heard_at(41_000));
        assert_eq!(periods.heard_spans(), vec![(0, 20_000), (40_000, u64::MAX)]);
    }

    #[test]
    fn changes_at_the_same_moment_make_one_stretch() {
        let mut periods = EchoPeriods::from(0);
        periods.heard_at(0);
        periods.devices_changed(0);
        assert!(periods.heard_spans().is_empty());
        periods.devices_changed(10_000);
        periods.devices_changed(10_000);
        assert!(periods.heard_at(10_000));
        assert_eq!(periods.heard_spans(), vec![(10_000, u64::MAX)]);
    }
}
