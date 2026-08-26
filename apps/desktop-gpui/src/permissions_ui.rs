//! The permissions surface's state machine, shared by every entry point.
//!
//! Three ways in, one surface (rendered by `onboarding_window`):
//!
//! 1. First-run onboarding -- the step after Welcome.
//! 2. The revoked-permissions revisit -- `store::should_show_onboarding`
//!    returns true whenever a required permission has been revoked, and the
//!    onboarding window opens straight on the permissions step (the Tauri
//!    app's `permissionsOnly` flow).
//! 3. `CAP_GPUI_AUTO_PERMISSIONS=1` -- the screenshot harness, below.
//!
//! Everything stateful about a row lives here so it can be unit-tested
//! without a window: status classification (via [`permissions::classify`]),
//! the one action a row offers per state, all-granted detection, and the
//! relaunch hint. The polling *lifecycle* lives with the window that owns the
//! poll task (`onboarding_window`); the rules it enforces are documented on
//! [`PermissionsState::all_shown_granted`].

use std::sync::atomic::{AtomicBool, Ordering};

use crate::permissions::{
    self, AttemptedFlags, OSPermission, OSPermissionStatus, OSPermissionsCheck, RawPermissions,
};

/// The single action a not-yet-granted row offers. Granted rows offer none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowAction {
    /// `notDetermined`: show the system prompt.
    Request,
    /// `denied` / `restricted` (or a failed request cycle on the boolean
    /// APIs): deep-link the exact System Settings pane.
    OpenSettings,
}

#[derive(Debug, Clone, Copy)]
pub struct PermissionsState {
    raw: Option<RawPermissions>,
    attempted: AttemptedFlags,
    /// A required permission has been routed through System Settings; from
    /// then on the relaunch hint stays up until both required grants land.
    sent_to_settings: bool,
    check: OSPermissionsCheck,
}

impl PermissionsState {
    /// Live constructor -- one preflight sweep, no prompting.
    pub fn initial() -> Self {
        let mut this = Self::from_raw(sweep_raw());
        if let Some(spec) = fake_spec() {
            if spec.contains("hint") {
                this.sent_to_settings = true;
            }
            // The boolean APIs cannot report "denied" on their own; a faked
            // denial is an attempted-and-failed request.
            if spec.contains("screen=denied") {
                this.note_request_failed(OSPermission::ScreenRecording);
            }
            if spec.contains("ax=denied") {
                this.note_request_failed(OSPermission::Accessibility);
            }
        }
        this
    }

    pub fn from_raw(raw: Option<RawPermissions>) -> Self {
        let attempted = AttemptedFlags::default();
        Self {
            raw,
            attempted,
            sent_to_settings: false,
            check: permissions::classify(raw, attempted),
        }
    }

    /// Fold in a fresh preflight sweep. Returns true when anything the UI
    /// renders changed.
    pub fn apply_raw(&mut self, raw: Option<RawPermissions>) -> bool {
        if self.raw == raw {
            return false;
        }
        self.raw = raw;
        self.check = permissions::classify(raw, self.attempted);
        true
    }

    /// A request cycle for a boolean-API permission (screen recording /
    /// accessibility) ran its grace period without the grant landing: the row
    /// flips from "Grant" to "Open Settings".
    pub fn note_request_failed(&mut self, permission: OSPermission) {
        match permission {
            OSPermission::ScreenRecording => self.attempted.screen = true,
            OSPermission::Accessibility => self.attempted.accessibility = true,
            // AV reports notDetermined vs denied itself; nothing to record.
            OSPermission::Microphone | OSPermission::Camera => return,
        }
        self.check = permissions::classify(self.raw, self.attempted);
    }

    /// The user was deep-linked into System Settings for this permission.
    pub fn note_settings_opened(&mut self, permission: OSPermission) {
        if permission.required() {
            self.sent_to_settings = true;
        }
    }

    pub fn status(&self, permission: OSPermission) -> OSPermissionStatus {
        self.check.get(permission)
    }

    /// The rows the surface renders, `NotNeeded` filtered out.
    pub fn shown(&self) -> impl Iterator<Item = (OSPermission, OSPermissionStatus)> + '_ {
        OSPermission::ALL
            .iter()
            .map(|&permission| (permission, self.check.get(permission)))
            .filter(|(_, status)| *status != OSPermissionStatus::NotNeeded)
    }

    pub fn action(&self, permission: OSPermission) -> Option<RowAction> {
        match self.check.get(permission) {
            OSPermissionStatus::NotDetermined => Some(RowAction::Request),
            OSPermissionStatus::Denied => Some(RowAction::OpenSettings),
            OSPermissionStatus::Granted | OSPermissionStatus::NotNeeded => None,
        }
    }

    pub fn refreshed_action(
        &mut self,
        permission: OSPermission,
        raw: Option<RawPermissions>,
    ) -> Option<RowAction> {
        self.apply_raw(raw);
        self.action(permission)
    }

    pub fn granted_counts(&self) -> (usize, usize) {
        let mut granted = 0;
        let mut total = 0;
        for (_, status) in self.shown() {
            total += 1;
            if status.permitted() {
                granted += 1;
            }
        }
        (granted, total)
    }

    pub fn necessary_granted(&self) -> bool {
        self.check.necessary_granted()
    }

    /// The poll's stop condition: every permission this platform has is
    /// granted. The owning window arms its 1s poll only while the surface is
    /// visible and this is false, and the poll task returns the moment this
    /// turns true -- nothing is left ticking behind a fully-granted surface.
    pub fn all_shown_granted(&self) -> bool {
        self.check.all_permitted()
    }

    /// Whether to show the "grants from System Settings may need a relaunch"
    /// hint -- the Tauri onboarding's "Restart Required" dialog, inline.
    /// Visible from the moment a required permission is routed through
    /// System Settings until both required grants have actually landed.
    pub fn relaunch_hint(&self) -> bool {
        self.sent_to_settings && !self.necessary_granted()
    }
}

// ---------------------------------------------------------------------------
// The screenshot-harness hook
// ---------------------------------------------------------------------------

/// The sweep the surface actually consumes: the real preflight, unless the
/// screenshot harness is faking states. Real flows never set the variable.
pub fn sweep_raw() -> Option<RawPermissions> {
    match fake_spec() {
        Some(spec) => parse_fake(&spec),
        None => permissions::check_raw(),
    }
}

fn fake_spec() -> Option<String> {
    std::env::var("CAP_GPUI_FAKE_PERMISSIONS")
        .ok()
        .filter(|spec| !spec.is_empty())
}

/// `CAP_GPUI_FAKE_PERMISSIONS=screen=nd,ax=granted,mic=denied,cam=restricted[,hint]`:
/// the screenshot harness's way to photograph non-granted states on a machine
/// whose TCC grants are all in place, without ever resetting TCC or raising a
/// real prompt. `denied` on screen/ax renders as an attempted-and-failed
/// request (the boolean APIs cannot report "denied" on their own). `hint`
/// pre-arms the relaunch banner.
fn parse_fake(spec: &str) -> Option<RawPermissions> {
    use crate::permissions::MediaAuthorization;

    let mut raw = RawPermissions {
        screen_granted: true,
        accessibility_granted: true,
        microphone: MediaAuthorization::Authorized,
        camera: MediaAuthorization::Authorized,
    };
    for token in spec.split(',') {
        let Some((key, value)) = token.split_once('=') else {
            continue;
        };
        let media = match value {
            "granted" => MediaAuthorization::Authorized,
            "nd" => MediaAuthorization::NotDetermined,
            "restricted" => MediaAuthorization::Restricted,
            _ => MediaAuthorization::Denied,
        };
        match key {
            "screen" => raw.screen_granted = value == "granted",
            "ax" => raw.accessibility_granted = value == "granted",
            "mic" => raw.microphone = media,
            "cam" => raw.camera = media,
            _ => {}
        }
    }
    Some(raw)
}

static FORCE_SURFACE: AtomicBool = AtomicBool::new(false);

/// `CAP_GPUI_AUTO_PERMISSIONS=1`: open the permissions surface regardless of
/// store flags or current grants -- unprivileged synthetic clicks are
/// dropped, so the screenshot harness needs a way in, the same reason every
/// other `CAP_GPUI_AUTO_*` hook exists. Checking is preflight-only, so this
/// never triggers a TCC prompt by itself.
pub fn auto_open_from_env(cx: &mut gpui::App) {
    if std::env::var("CAP_GPUI_AUTO_PERMISSIONS").is_ok_and(|value| value == "1") {
        FORCE_SURFACE.store(true, Ordering::Release);
        crate::app_windows::open_onboarding(cx);
    }
}

/// Whether the harness forced the surface open. Read by the onboarding
/// window to pin the step to Permissions and to suppress the all-granted
/// auto-finish (which would close the window before a screenshot lands).
pub fn surface_forced() -> bool {
    FORCE_SURFACE.load(Ordering::Acquire)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::MediaAuthorization;

    #[test]
    fn fake_spec_parses_every_state() {
        let parsed = parse_fake("screen=nd,ax=granted,mic=denied,cam=restricted,hint").unwrap();
        assert!(!parsed.screen_granted);
        assert!(parsed.accessibility_granted);
        assert_eq!(parsed.microphone, MediaAuthorization::Denied);
        assert_eq!(parsed.camera, MediaAuthorization::Restricted);

        // Unknown keys and bare tokens are ignored; defaults are granted.
        let parsed = parse_fake("hint,nonsense=1").unwrap();
        assert!(parsed.screen_granted);
        assert!(parsed.accessibility_granted);
        assert_eq!(parsed.microphone, MediaAuthorization::Authorized);
        assert_eq!(parsed.camera, MediaAuthorization::Authorized);
    }

    fn raw(
        screen: bool,
        ax: bool,
        mic: MediaAuthorization,
        camera: MediaAuthorization,
    ) -> Option<RawPermissions> {
        Some(RawPermissions {
            screen_granted: screen,
            accessibility_granted: ax,
            microphone: mic,
            camera,
        })
    }

    fn fresh_ungranted() -> PermissionsState {
        PermissionsState::from_raw(raw(
            false,
            false,
            MediaAuthorization::NotDetermined,
            MediaAuthorization::NotDetermined,
        ))
    }

    #[test]
    fn fresh_rows_all_offer_request() {
        let state = fresh_ungranted();
        for &permission in OSPermission::ALL {
            assert_eq!(state.action(permission), Some(RowAction::Request));
        }
        assert_eq!(state.granted_counts(), (0, 4));
        assert!(!state.all_shown_granted());
        assert!(!state.necessary_granted());
        assert!(!state.relaunch_hint());
    }

    #[test]
    fn failed_request_flips_boolean_rows_to_settings() {
        let mut state = fresh_ungranted();
        state.note_request_failed(OSPermission::ScreenRecording);
        assert_eq!(
            state.action(OSPermission::ScreenRecording),
            Some(RowAction::OpenSettings)
        );
        // The others are untouched.
        assert_eq!(
            state.action(OSPermission::Accessibility),
            Some(RowAction::Request)
        );
        assert_eq!(
            state.action(OSPermission::Microphone),
            Some(RowAction::Request)
        );
    }

    #[test]
    fn media_denial_offers_settings_without_any_attempt() {
        let state = PermissionsState::from_raw(raw(
            false,
            false,
            MediaAuthorization::Denied,
            MediaAuthorization::Restricted,
        ));
        assert_eq!(
            state.action(OSPermission::Microphone),
            Some(RowAction::OpenSettings)
        );
        assert_eq!(
            state.action(OSPermission::Camera),
            Some(RowAction::OpenSettings)
        );
    }

    #[test]
    fn media_not_determined_still_requests_after_other_attempts() {
        // The old single-`interacted` flag turned a never-asked camera into
        // "Open Settings" the moment any other row was touched; the fixed
        // classification must not.
        let mut state = fresh_ungranted();
        state.note_request_failed(OSPermission::ScreenRecording);
        state.note_request_failed(OSPermission::Accessibility);
        assert_eq!(state.action(OSPermission::Camera), Some(RowAction::Request));
        assert_eq!(
            state.action(OSPermission::Microphone),
            Some(RowAction::Request)
        );
    }

    #[test]
    fn grant_landing_clears_the_action_and_stops_everything() {
        let mut state = fresh_ungranted();
        state.note_request_failed(OSPermission::ScreenRecording);

        let changed = state.apply_raw(raw(
            true,
            true,
            MediaAuthorization::Authorized,
            MediaAuthorization::Authorized,
        ));
        assert!(changed);
        for &permission in OSPermission::ALL {
            assert_eq!(state.action(permission), None);
        }
        assert!(state.all_shown_granted(), "poll stop condition");
        assert_eq!(state.granted_counts(), (4, 4));
    }

    #[test]
    fn stale_request_is_skipped_when_permission_was_already_granted() {
        for &permission in OSPermission::ALL {
            let mut state = fresh_ungranted();
            assert_eq!(state.action(permission), Some(RowAction::Request));

            let action = state.refreshed_action(
                permission,
                raw(
                    true,
                    true,
                    MediaAuthorization::Authorized,
                    MediaAuthorization::Authorized,
                ),
            );

            assert_eq!(action, None);
            assert_eq!(state.status(permission), OSPermissionStatus::Granted);
        }
    }

    #[test]
    fn stale_settings_action_is_skipped_after_permission_is_granted() {
        let mut state = fresh_ungranted();
        state.note_request_failed(OSPermission::ScreenRecording);
        assert_eq!(
            state.action(OSPermission::ScreenRecording),
            Some(RowAction::OpenSettings)
        );

        let action = state.refreshed_action(
            OSPermission::ScreenRecording,
            raw(
                true,
                false,
                MediaAuthorization::NotDetermined,
                MediaAuthorization::NotDetermined,
            ),
        );

        assert_eq!(action, None);
        assert_eq!(
            state.status(OSPermission::ScreenRecording),
            OSPermissionStatus::Granted
        );
    }

    #[test]
    fn refreshed_denial_opens_settings_instead_of_requesting_again() {
        let mut state = fresh_ungranted();

        let action = state.refreshed_action(
            OSPermission::Microphone,
            raw(
                false,
                false,
                MediaAuthorization::Denied,
                MediaAuthorization::NotDetermined,
            ),
        );

        assert_eq!(action, Some(RowAction::OpenSettings));
    }

    #[test]
    fn apply_raw_reports_no_change_for_identical_sweeps() {
        let mut state = fresh_ungranted();
        let same = raw(
            false,
            false,
            MediaAuthorization::NotDetermined,
            MediaAuthorization::NotDetermined,
        );
        assert!(!state.apply_raw(same));
    }

    #[test]
    fn relaunch_hint_tracks_required_settings_trips_only() {
        let mut state = fresh_ungranted();

        // Optional permissions never raise it.
        state.note_settings_opened(OSPermission::Camera);
        assert!(!state.relaunch_hint());

        state.note_settings_opened(OSPermission::ScreenRecording);
        assert!(state.relaunch_hint());

        // Both required grants landing clears it.
        state.apply_raw(raw(
            true,
            true,
            MediaAuthorization::NotDetermined,
            MediaAuthorization::NotDetermined,
        ));
        assert!(!state.relaunch_hint());
    }

    #[test]
    fn platform_without_permissions_shows_no_rows() {
        let state = PermissionsState::from_raw(None);
        assert_eq!(state.shown().count(), 0);
        assert_eq!(state.granted_counts(), (0, 0));
        assert!(state.all_shown_granted());
        assert!(state.necessary_granted());
    }

    #[test]
    fn necessary_ignores_optional_rows() {
        let state = PermissionsState::from_raw(raw(
            true,
            true,
            MediaAuthorization::Denied,
            MediaAuthorization::NotDetermined,
        ));
        assert!(state.necessary_granted());
        assert!(!state.all_shown_granted());
        assert_eq!(state.granted_counts(), (2, 4));
    }
}
