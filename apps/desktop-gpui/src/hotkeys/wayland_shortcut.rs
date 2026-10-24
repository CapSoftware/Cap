use ashpd::desktop::global_shortcuts::{Shortcut, ShortcutsChanged};

pub(super) fn stop_binding_changed(
    event: &ShortcutsChanged,
    owned_session: &str,
    approved: &Shortcut,
) -> bool {
    if event.session_handle().as_str() != owned_session {
        return false;
    }

    // GNOME emits ShortcutsChanged before completing the initial BindShortcuts request.
    event
        .shortcuts()
        .iter()
        .find(|shortcut| shortcut.id() == approved.id())
        .is_none_or(|shortcut| shortcut.trigger_description() != approved.trigger_description())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ashpd::desktop::global_shortcuts::BindShortcuts;
    use serde_json::{Value, json};

    const SESSION: &str = "/org/freedesktop/portal/desktop/session/test/cap";
    const TRIGGER: &str = "Press <ctrl><shift>F9";

    fn shortcut(id: &str, trigger: &str) -> Value {
        json!([id, {
            "description": ["s", "Start or stop this Cap recording"],
            "trigger_description": ["s", trigger],
        }])
    }

    fn approved() -> Shortcut {
        binding_response(TRIGGER).shortcuts()[0].clone()
    }

    fn binding_response(trigger: &str) -> BindShortcuts {
        serde_json::from_str(
            &json!({"shortcuts": ["a(sa{sv})", [shortcut("stop", trigger)]]}).to_string(),
        )
        .unwrap()
    }

    fn event(session: &str, shortcuts: Vec<Value>) -> ShortcutsChanged {
        serde_json::from_str(&json!([session, shortcuts]).to_string()).unwrap()
    }

    #[test]
    fn initial_binding_notification_does_not_invalidate_approved_stop() {
        let changed = event(SESSION, vec![shortcut("stop", TRIGGER)]);
        assert!(!stop_binding_changed(&changed, SESSION, &approved()));
    }

    #[test]
    fn initial_notification_uses_the_granted_trigger_not_the_preferred_one() {
        let granted_trigger = "Press <super>F10";
        let response = binding_response(granted_trigger);
        let changed = event(SESSION, vec![shortcut("stop", granted_trigger)]);
        assert!(!stop_binding_changed(
            &changed,
            SESSION,
            &response.shortcuts()[0],
        ));
    }

    #[test]
    fn repeated_notifications_and_other_shortcut_changes_are_harmless() {
        for shortcuts in [
            vec![shortcut("other", "Press A"), shortcut("stop", TRIGGER)],
            vec![shortcut("stop", TRIGGER), shortcut("other", "Press B")],
        ] {
            let changed = event(SESSION, shortcuts);
            assert!(!stop_binding_changed(&changed, SESSION, &approved()));
        }
    }

    #[test]
    fn a_changed_stop_trigger_invalidates_the_approved_binding() {
        let changed = event(SESSION, vec![shortcut("stop", "Press <ctrl><shift>F10")]);
        assert!(stop_binding_changed(&changed, SESSION, &approved()));
    }

    #[test]
    fn an_empty_stop_trigger_invalidates_the_approved_binding() {
        let changed = event(SESSION, vec![shortcut("stop", "")]);
        assert!(stop_binding_changed(&changed, SESSION, &approved()));
    }

    #[test]
    fn a_removed_stop_binding_is_not_replaced_by_another_matching_trigger() {
        let changed = event(SESSION, vec![shortcut("other", TRIGGER)]);
        assert!(stop_binding_changed(&changed, SESSION, &approved()));
    }

    #[test]
    fn an_empty_shortcut_list_invalidates_the_approved_binding() {
        let changed = event(SESSION, vec![]);
        assert!(stop_binding_changed(&changed, SESSION, &approved()));
    }

    #[test]
    fn another_sessions_changes_do_not_invalidate_approved_stop() {
        let changed = event("/org/freedesktop/portal/desktop/session/test/other", vec![]);
        assert!(!stop_binding_changed(&changed, SESSION, &approved()));
    }
}
