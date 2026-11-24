use std::time::Duration;

pub const BACKOFF_SECS: [u64; 8] = [2, 3, 5, 8, 13, 21, 30, 38];
pub const WELCOME_FOR: Duration = Duration::from_millis(1900);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Closed,
    Pitch,
    SigningIn,
    Starting,
    Waiting,
    Welcome,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input {
    Open { signed_in: bool, pro: bool },
    Continue { signed_in: bool },
    SignedIn { pro: bool },
    SignInStopped,
    CheckoutOpened,
    AlreadyPro,
    Activated,
    PlanChecked { pro: bool },
    Tick,
    WelcomeDone,
    Close,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    StartSignIn,
    StartCheckout,
    CheckPlan,
    Wait(Duration),
    StopTimers,
    Upgraded,
    CloseAfter(Duration),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Flow {
    pub phase: Phase,
    tries: usize,
}

impl Default for Flow {
    fn default() -> Self {
        Self {
            phase: Phase::Closed,
            tries: 0,
        }
    }
}

impl Flow {
    pub fn step(&mut self, input: Input) -> Vec<Effect> {
        use Effect::*;
        match (self.phase, input) {
            (_, Input::Close) => {
                self.phase = Phase::Closed;
                vec![StopTimers]
            }
            (Phase::Closed | Phase::Pitch, Input::Open { pro: true, .. }) => {
                self.phase = Phase::Closed;
                vec![Upgraded]
            }
            (Phase::Closed, Input::Open { .. }) => {
                self.phase = Phase::Pitch;
                self.tries = 0;
                Vec::new()
            }
            (Phase::Pitch, Input::Continue { signed_in: true }) => {
                self.phase = Phase::Starting;
                vec![StartCheckout]
            }
            (Phase::Pitch, Input::Continue { signed_in: false }) => {
                self.phase = Phase::SigningIn;
                vec![StartSignIn]
            }
            (Phase::SigningIn, Input::SignedIn { pro: true }) => self.welcome(),
            (Phase::SigningIn, Input::SignedIn { pro: false }) => {
                self.phase = Phase::Starting;
                vec![StartCheckout]
            }
            (Phase::SigningIn, Input::SignInStopped) => {
                self.phase = Phase::Pitch;
                Vec::new()
            }
            (Phase::Starting, Input::CheckoutOpened) => {
                self.phase = Phase::Waiting;
                self.tries = 0;
                Vec::new()
            }
            (Phase::Starting, Input::AlreadyPro) => {
                self.phase = Phase::Waiting;
                self.tries = 0;
                vec![CheckPlan]
            }
            (Phase::Waiting, Input::Activated) => {
                self.tries = 0;
                vec![StopTimers, CheckPlan]
            }
            (Phase::Waiting, Input::Tick) => vec![CheckPlan],
            (Phase::Waiting, Input::PlanChecked { pro: true }) => self.welcome(),
            (Phase::Waiting, Input::PlanChecked { pro: false }) => {
                match BACKOFF_SECS.get(self.tries) {
                    Some(secs) => {
                        self.tries += 1;
                        vec![Wait(Duration::from_secs(*secs))]
                    }
                    None => Vec::new(),
                }
            }
            (Phase::Welcome, Input::WelcomeDone) => {
                self.phase = Phase::Closed;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn welcome(&mut self) -> Vec<Effect> {
        self.phase = Phase::Welcome;
        vec![
            Effect::StopTimers,
            Effect::Upgraded,
            Effect::CloseAfter(WELCOME_FOR),
        ]
    }

    pub fn is_open(&self) -> bool {
        self.phase != Phase::Closed
    }

    #[cfg(test)]
    pub fn may_hold_timer(&self) -> bool {
        matches!(self.phase, Phase::Waiting | Phase::Welcome)
    }
}

#[cfg(any(test, debug_assertions))]
pub fn debug_flow(phase: Phase) -> Flow {
    Flow { phase, tries: 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opened(signed_in: bool) -> Flow {
        let mut flow = Flow::default();
        assert!(
            flow.step(Input::Open {
                signed_in,
                pro: false
            })
            .is_empty()
        );
        assert_eq!(flow.phase, Phase::Pitch);
        flow
    }

    #[test]
    fn signed_in_goes_from_pitch_to_checkout_to_welcome() {
        let mut flow = opened(true);
        assert_eq!(
            flow.step(Input::Continue { signed_in: true }),
            vec![Effect::StartCheckout]
        );
        assert_eq!(flow.phase, Phase::Starting);
        assert!(flow.step(Input::CheckoutOpened).is_empty());
        assert_eq!(flow.phase, Phase::Waiting);
        assert_eq!(
            flow.step(Input::Activated),
            vec![Effect::StopTimers, Effect::CheckPlan]
        );
        assert_eq!(
            flow.step(Input::PlanChecked { pro: true }),
            vec![
                Effect::StopTimers,
                Effect::Upgraded,
                Effect::CloseAfter(WELCOME_FOR)
            ]
        );
        assert_eq!(flow.phase, Phase::Welcome);
        assert!(flow.step(Input::WelcomeDone).is_empty());
        assert_eq!(flow.phase, Phase::Closed);
    }

    #[test]
    fn signed_out_signs_in_first_then_checks_out_without_another_step() {
        let mut flow = opened(false);
        assert_eq!(
            flow.step(Input::Continue { signed_in: false }),
            vec![Effect::StartSignIn]
        );
        assert_eq!(flow.phase, Phase::SigningIn);
        assert_eq!(
            flow.step(Input::SignedIn { pro: false }),
            vec![Effect::StartCheckout]
        );
        assert_eq!(flow.phase, Phase::Starting);
    }

    #[test]
    fn signing_in_to_a_pro_account_skips_checkout() {
        let mut flow = opened(false);
        flow.step(Input::Continue { signed_in: false });
        let effects = flow.step(Input::SignedIn { pro: true });
        assert!(effects.contains(&Effect::Upgraded));
        assert!(!effects.contains(&Effect::StartCheckout));
        assert_eq!(flow.phase, Phase::Welcome);
    }

    #[test]
    fn a_stopped_sign_in_returns_to_the_pitch() {
        let mut flow = opened(false);
        flow.step(Input::Continue { signed_in: false });
        assert!(flow.step(Input::SignInStopped).is_empty());
        assert_eq!(flow.phase, Phase::Pitch);
    }

    #[test]
    fn plan_checks_back_off_for_about_two_minutes_then_stop() {
        let mut flow = opened(true);
        flow.step(Input::Continue { signed_in: true });
        flow.step(Input::CheckoutOpened);
        flow.step(Input::Activated);
        let mut waited = Duration::ZERO;
        let mut checks = 1;
        loop {
            let effects = flow.step(Input::PlanChecked { pro: false });
            let Some(Effect::Wait(delay)) = effects.first().copied() else {
                assert!(effects.is_empty());
                break;
            };
            assert!(delay > Duration::ZERO);
            waited += delay;
            assert_eq!(flow.step(Input::Tick), vec![Effect::CheckPlan]);
            checks += 1;
        }
        assert_eq!(waited, Duration::from_secs(120));
        assert_eq!(checks, BACKOFF_SECS.len() + 1);
        assert_eq!(flow.phase, Phase::Waiting);
        assert_eq!(
            flow.step(Input::Activated),
            vec![Effect::StopTimers, Effect::CheckPlan]
        );
        assert_eq!(
            flow.step(Input::PlanChecked { pro: false }),
            vec![Effect::Wait(Duration::from_secs(BACKOFF_SECS[0]))]
        );
    }

    #[test]
    fn nothing_waits_or_checks_while_no_checkout_is_pending() {
        let inputs = [
            Input::Activated,
            Input::Tick,
            Input::PlanChecked { pro: false },
            Input::CheckoutOpened,
            Input::SignInStopped,
            Input::WelcomeDone,
        ];
        for phase_inputs in [
            Vec::new(),
            vec![Input::Open {
                signed_in: true,
                pro: false,
            }],
        ] {
            let mut flow = Flow::default();
            for input in phase_inputs {
                flow.step(input);
            }
            for input in inputs {
                let effects = flow.step(input);
                assert!(
                    effects
                        .iter()
                        .all(|e| !matches!(e, Effect::Wait(_) | Effect::CheckPlan)),
                    "{input:?} in {:?} gave {effects:?}",
                    flow.phase
                );
                assert!(!flow.may_hold_timer());
            }
        }
    }

    #[test]
    fn closing_stops_everything_from_any_phase() {
        let mut flow = opened(true);
        flow.step(Input::Continue { signed_in: true });
        flow.step(Input::CheckoutOpened);
        assert_eq!(flow.step(Input::Close), vec![Effect::StopTimers]);
        assert_eq!(flow.phase, Phase::Closed);
        assert!(flow.step(Input::Tick).is_empty());
    }

    #[test]
    fn opening_for_someone_already_on_pro_just_writes() {
        let mut flow = Flow::default();
        assert_eq!(
            flow.step(Input::Open {
                signed_in: true,
                pro: true
            }),
            vec![Effect::Upgraded]
        );
        assert_eq!(flow.phase, Phase::Closed);
    }

    #[test]
    fn a_purchase_that_already_happened_is_checked_straight_away() {
        let mut flow = opened(true);
        flow.step(Input::Continue { signed_in: true });
        assert_eq!(flow.step(Input::AlreadyPro), vec![Effect::CheckPlan]);
        assert_eq!(flow.phase, Phase::Waiting);
    }
}
