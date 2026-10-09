use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Reveal {
    pub session: u32,
    pub instance: u32,
}

#[derive(Default)]
struct Window {
    instance: u32,
    requested: bool,
    frontend_ready: bool,
    native_ready: bool,
    focus: bool,
}

#[derive(Default)]
pub(super) struct Lifecycle {
    session: u32,
    next_instance: u32,
    active: bool,
    accepting_requests: bool,
    windows: HashMap<String, Window>,
}

impl Lifecycle {
    pub fn begin(&mut self) -> u32 {
        self.session = self.session.wrapping_add(1);
        self.active = true;
        self.accepting_requests = true;
        for window in self.windows.values_mut() {
            window.requested = false;
        }
        self.session
    }

    pub fn current(&self) -> Option<u32> {
        self.active.then_some(self.session)
    }

    pub fn is_current(&self, session: u32) -> bool {
        self.current() == Some(session)
    }

    pub fn is_cancelled(&self, session: u32) -> bool {
        !self.active && self.session == session
    }

    pub fn cancel(&mut self) -> bool {
        let active = self.active;
        self.active = false;
        for window in self.windows.values_mut() {
            window.requested = false;
        }
        active
    }

    pub fn register(&mut self, label: &str, session: u32) -> Option<u32> {
        if !self.is_current(session) {
            return None;
        }
        self.next_instance = self.next_instance.checked_add(1)?;
        self.windows.insert(
            label.to_string(),
            Window {
                instance: self.next_instance,
                requested: self.accepting_requests,
                ..Default::default()
            },
        );
        Some(self.next_instance)
    }

    pub fn request(&mut self, label: &str, session: u32, focus: bool) -> Option<Reveal> {
        if !self.accepting_requests {
            return None;
        }
        self.restore(label, session, focus)
    }

    pub fn suspend_all(&mut self) {
        self.accepting_requests = false;
        for window in self.windows.values_mut() {
            window.requested = false;
        }
    }

    pub fn restore(&mut self, label: &str, session: u32, focus: bool) -> Option<Reveal> {
        if !self.is_current(session) {
            return None;
        }
        let window = self.windows.get_mut(label)?;
        window.requested = true;
        window.focus = focus;
        Some(Reveal {
            session,
            instance: window.instance,
        })
    }

    pub fn focus(&mut self, label: &str, session: u32, focus: bool) -> Option<Reveal> {
        if !self.is_current(session) {
            return None;
        }
        let window = self.windows.get_mut(label)?;
        if !window.requested {
            return None;
        }
        window.focus = focus;
        Some(Reveal {
            session,
            instance: window.instance,
        })
    }

    pub fn suspend(&mut self, label: &str) {
        if let Some(window) = self.windows.get_mut(label) {
            window.requested = false;
        }
    }

    pub fn ready(&mut self, label: &str, instance: u32, frontend: bool) -> Option<Reveal> {
        let window = self.windows.get_mut(label)?;
        if window.instance != instance {
            return None;
        }
        if frontend {
            window.frontend_ready = true;
        } else {
            window.native_ready = true;
        }
        Some(Reveal {
            session: self.session,
            instance,
        })
    }

    pub fn may_reveal(&self, label: &str, reveal: Reveal) -> Option<bool> {
        if !self.is_current(reveal.session) {
            return None;
        }
        self.windows.get(label).and_then(|window| {
            (window.instance == reveal.instance
                && window.requested
                && window.frontend_ready
                && window.native_ready)
                .then_some(window.focus)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared(lifecycle: &mut Lifecycle, label: &str, session: u32) -> Reveal {
        let instance = lifecycle.register(label, session).unwrap();
        lifecycle.ready(label, instance, true).unwrap();
        lifecycle.ready(label, instance, false).unwrap()
    }

    #[test]
    fn both_native_and_frontend_readiness_are_required_in_either_order() {
        for first in [true, false] {
            let mut lifecycle = Lifecycle::default();
            let session = lifecycle.begin();
            let instance = lifecycle.register("overlay", session).unwrap();
            let reveal = lifecycle.request("overlay", session, true).unwrap();
            assert_eq!(lifecycle.may_reveal("overlay", reveal), None);
            lifecycle.ready("overlay", instance, first).unwrap();
            assert_eq!(lifecycle.may_reveal("overlay", reveal), None);
            lifecycle.ready("overlay", instance, !first).unwrap();
            assert_eq!(lifecycle.may_reveal("overlay", reveal), Some(true));
        }
    }

    #[test]
    fn cancel_rejects_late_creation_readiness_and_queued_reveals() {
        let mut lifecycle = Lifecycle::default();
        let session = lifecycle.begin();
        let reveal = prepared(&mut lifecycle, "first", session);
        assert!(lifecycle.cancel());
        assert!(!lifecycle.cancel());
        assert!(lifecycle.register("late", session).is_none());
        lifecycle.ready("first", reveal.instance, true).unwrap();
        assert_eq!(lifecycle.may_reveal("first", reveal), None);
        assert!(lifecycle.request("first", session, true).is_none());
    }

    #[test]
    fn new_session_reuses_ready_windows_without_accepting_old_callbacks() {
        let mut lifecycle = Lifecycle::default();
        let first = lifecycle.begin();
        let stale = prepared(&mut lifecycle, "overlay", first);
        lifecycle.cancel();
        let second = lifecycle.begin();
        let current = lifecycle.request("overlay", second, false).unwrap();
        assert_eq!(lifecycle.may_reveal("overlay", stale), None);
        assert_eq!(lifecycle.may_reveal("overlay", current), Some(false));
        assert!(lifecycle.request("overlay", first, true).is_none());
    }

    #[test]
    fn replaced_window_cannot_be_revealed_by_destroyed_frontend() {
        let mut lifecycle = Lifecycle::default();
        let session = lifecycle.begin();
        let old = prepared(&mut lifecycle, "overlay", session);
        let replacement = lifecycle.register("overlay", session).unwrap();
        let reveal = lifecycle.ready("overlay", replacement, false).unwrap();
        assert!(lifecycle.ready("overlay", old.instance, true).is_none());
        assert_eq!(lifecycle.may_reveal("overlay", old), None);
        assert_eq!(lifecycle.may_reveal("overlay", reveal), None);
        lifecycle.ready("overlay", replacement, true).unwrap();
        assert_eq!(lifecycle.may_reveal("overlay", reveal), Some(false));
    }

    #[test]
    fn modal_hiding_cannot_be_undone_by_readiness_or_a_queued_reveal() {
        let mut lifecycle = Lifecycle::default();
        let session = lifecycle.begin();
        let reveal = prepared(&mut lifecycle, "overlay", session);
        lifecycle.suspend("overlay");
        lifecycle.ready("overlay", reveal.instance, true).unwrap();
        assert_eq!(lifecycle.may_reveal("overlay", reveal), None);
        assert!(lifecycle.focus("overlay", session, true).is_none());
        let restored = lifecycle.request("overlay", session, true).unwrap();
        assert_eq!(lifecycle.may_reveal("overlay", restored), Some(true));
    }

    #[test]
    fn modal_suspends_pending_displays_until_explicit_restore_or_a_new_session() {
        let mut lifecycle = Lifecycle::default();
        let session = lifecycle.begin();
        let first = prepared(&mut lifecycle, "one", session);
        lifecycle.suspend_all();
        let late = prepared(&mut lifecycle, "late", session);
        assert_eq!(lifecycle.may_reveal("one", first), None);
        assert_eq!(lifecycle.may_reveal("late", late), None);
        assert!(lifecycle.request("one", session, true).is_none());
        let restored = lifecycle.restore("one", session, true).unwrap();
        assert_eq!(lifecycle.may_reveal("one", restored), Some(true));
        assert_eq!(lifecycle.may_reveal("late", late), None);
        let next = lifecycle.begin();
        let reopened = lifecycle.request("late", next, true).unwrap();
        assert_eq!(lifecycle.may_reveal("late", reopened), Some(true));
    }

    #[test]
    fn displays_are_independent_and_cancelled_sessions_do_not_restore() {
        let mut lifecycle = Lifecycle::default();
        let session = lifecycle.begin();
        let first = prepared(&mut lifecycle, "one", session);
        let second = prepared(&mut lifecycle, "two", session);
        lifecycle.suspend("one");
        assert_eq!(lifecycle.may_reveal("one", first), None);
        assert_eq!(lifecycle.may_reveal("two", second), Some(false));
        lifecycle.cancel();
        assert!(lifecycle.request("one", session, false).is_none());
        assert_eq!(lifecycle.may_reveal("two", second), None);
    }
}
