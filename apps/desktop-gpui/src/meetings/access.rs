use std::collections::HashSet;

use gpui::Context;

use super::{
    GenerateOptions, Meetings, NotesError,
    cloud::{Capabilities, CloudError},
    persist,
};

const UNWRITTEN_FILE: &str = "unwritten-notes.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AiAccess {
    Ready,
    Trial { remaining: u32 },
    NeedsUpgrade,
    NeedsSignIn,
    Unavailable,
}

impl AiAccess {
    pub fn writes_notes(self) -> bool {
        matches!(self, AiAccess::Ready | AiAccess::Trial { .. })
    }

    pub fn can_ask(self, has_notes: bool) -> bool {
        match self {
            AiAccess::Ready => true,
            AiAccess::Trial { .. } | AiAccess::NeedsUpgrade => has_notes,
            AiAccess::NeedsSignIn | AiAccess::Unavailable => false,
        }
    }

    pub fn locked(self) -> bool {
        matches!(self, AiAccess::NeedsUpgrade | AiAccess::NeedsSignIn)
    }

    pub fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        if let Some(count) = value.strip_prefix("trial:") {
            return count
                .parse()
                .ok()
                .map(|remaining| AiAccess::Trial { remaining });
        }
        match value {
            "ready" => Some(AiAccess::Ready),
            "upgrade" | "spent" => Some(AiAccess::NeedsUpgrade),
            "signin" => Some(AiAccess::NeedsSignIn),
            "unavailable" => Some(AiAccess::Unavailable),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct AccessInput<'a> {
    pub signed_in: bool,
    pub pro: bool,
    pub caps: Option<&'a Capabilities>,
    pub error: Option<&'a CloudError>,
}

pub fn resolve(input: AccessInput<'_>) -> AiAccess {
    if !input.signed_in {
        return AiAccess::NeedsSignIn;
    }
    if input.pro {
        return match (input.caps, input.error) {
            (Some(caps), _) if caps.notes => AiAccess::Ready,
            (Some(_), _) => AiAccess::Unavailable,
            (None, Some(CloudError::NotConfigured)) => AiAccess::Unavailable,
            (None, _) => AiAccess::Ready,
        };
    }
    match input.caps.and_then(|c| c.notes_trial_remaining) {
        Some(remaining) if remaining > 0 => AiAccess::Trial { remaining },
        _ => match input.error {
            Some(CloudError::NotConfigured) => AiAccess::Unavailable,
            _ => AiAccess::NeedsUpgrade,
        },
    }
}

/// What a free account may send for one meeting's notes. The server counts
/// free meetings per meeting: one it wrote up free can be rewritten after the
/// last free meeting is used, a new one cannot. `covered` marks a meeting that
/// may be one of those (written free here, or already holding AI notes); the
/// server has the last word, so notes first written under Pro are refused there.
pub fn trial_gate(remaining: Option<u32>, covered: bool) -> Result<(), NotesError> {
    if covered || remaining.is_some_and(|n| n > 0) {
        Ok(())
    } else {
        Err(NotesError::UpgradeRequired)
    }
}

fn holds_ai_notes(library: &cap_meetings::library::Library, doc_id: &str) -> bool {
    library.read_enhanced(doc_id).ok().flatten().is_some()
}

pub fn settled(input: AccessInput<'_>) -> bool {
    !input.signed_in
        || input.pro
        || input.caps.is_some()
        || input.error.is_some_and(CloudError::is_final)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoDecision {
    Start,
    Wait,
    Skip,
}

#[derive(Debug, Default)]
pub struct AiState {
    started: HashSet<String>,
    waiting: Vec<String>,
    trial: HashSet<String>,
}

impl AiState {
    pub fn decide(&mut self, doc_id: &str, access: AiAccess, settled: bool) -> AutoDecision {
        if self.started.contains(doc_id) {
            return AutoDecision::Skip;
        }
        if access.writes_notes() {
            self.waiting.retain(|id| id != doc_id);
            self.started.insert(doc_id.to_string());
            return AutoDecision::Start;
        }
        if !settled && access == AiAccess::NeedsUpgrade {
            if !self.waiting.iter().any(|id| id == doc_id) {
                self.waiting.push(doc_id.to_string());
            }
            return AutoDecision::Wait;
        }
        self.waiting.retain(|id| id != doc_id);
        AutoDecision::Skip
    }

    /// Automatic notes were started for this meeting in this run.
    pub fn started(&self, doc_id: &str) -> bool {
        self.started.contains(doc_id)
    }

    pub fn waiting_ids(&self) -> &[String] {
        &self.waiting
    }

    pub fn has_waiting(&self) -> bool {
        !self.waiting.is_empty()
    }

    pub fn take_waiting(&mut self) -> Vec<String> {
        std::mem::take(&mut self.waiting)
    }

    pub fn mark_trial(&mut self, doc_id: &str) {
        self.trial.insert(doc_id.to_string());
    }

    pub fn on_trial(&self, doc_id: &str) -> bool {
        self.trial.contains(doc_id)
    }
}

#[cfg(debug_assertions)]
static DEBUG_ACCESS: std::sync::LazyLock<std::sync::Mutex<Option<(AiAccess, bool)>>> =
    std::sync::LazyLock::new(|| {
        std::sync::Mutex::new(
            std::env::var("CAP_GPUI_AI_ACCESS")
                .ok()
                .and_then(|v| AiAccess::parse(&v).map(|access| (access, v.trim() == "spent"))),
        )
    });

#[cfg(debug_assertions)]
pub fn debug_access() -> Option<(AiAccess, bool)> {
    *DEBUG_ACCESS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(debug_assertions)]
pub fn set_debug_access(access: Option<(AiAccess, bool)>) {
    *DEBUG_ACCESS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = access;
}

impl Meetings {
    pub fn ai_access(&self) -> AiAccess {
        #[cfg(debug_assertions)]
        if let Some((access, _)) = debug_access() {
            return access;
        }
        let auth = crate::store::auth_snapshot();
        resolve(AccessInput {
            signed_in: auth.signed_in(),
            pro: auth.is_upgraded(),
            caps: self.capabilities(),
            error: self.capabilities_error(),
        })
    }

    fn access_settled(&self) -> bool {
        let auth = crate::store::auth_snapshot();
        settled(AccessInput {
            signed_in: auth.signed_in(),
            pro: auth.is_upgraded(),
            caps: self.capabilities(),
            error: self.capabilities_error(),
        })
    }

    pub fn trial_remaining(&self) -> Option<u32> {
        #[cfg(debug_assertions)]
        if let Some((access, spent)) = debug_access() {
            return match access {
                AiAccess::Trial { remaining } => Some(remaining),
                _ if spent => Some(0),
                _ => None,
            };
        }
        self.capabilities().and_then(|c| c.notes_trial_remaining)
    }

    pub fn written_on_trial(&self, doc_id: &str) -> bool {
        self.ai.on_trial(doc_id)
    }

    pub fn ensure_access(&mut self, cx: &mut Context<Self>) {
        if !crate::store::auth_snapshot().signed_in() {
            return;
        }
        if self.capabilities().is_none()
            && !self.capabilities_pending()
            && self.capabilities_retry.is_none()
            && self.capabilities_error().is_none_or(|e| !e.is_final())
        {
            self.fetch_capabilities(cx);
        }
    }

    pub fn write_notes_now(&mut self, doc_id: &str, cx: &mut Context<Self>) {
        let busy = self.notes_state(doc_id).is_some_and(|s| s.running);
        let written = self
            .library()
            .and_then(|l| l.load(doc_id).ok())
            .and_then(|m| m.meeting)
            .is_some_and(|m| m.has_enhanced);
        if busy || written {
            return;
        }
        let task = self.generate_notes(doc_id, GenerateOptions::default(), cx);
        self.auto_notes.insert(doc_id.to_string(), task);
    }

    #[cfg(debug_assertions)]
    pub fn debug_mark_trial(&mut self, doc_id: &str) {
        self.ai.mark_trial(doc_id);
    }

    pub(super) fn auto_notes_for(&mut self, doc_id: String, cx: &mut Context<Self>) {
        let access = self.ai_access();
        let settled = self.access_settled();
        match self.ai.decide(&doc_id, access, settled) {
            AutoDecision::Start => {
                let task = self.generate_notes(&doc_id, GenerateOptions::default(), cx);
                self.auto_notes.insert(doc_id, task);
            }
            AutoDecision::Wait => self.fetch_capabilities(cx),
            AutoDecision::Skip => {}
        }
    }

    pub(super) fn trial_gate_for(&mut self, doc_id: &str) -> Result<(), NotesError> {
        let covered = self.ai.on_trial(doc_id)
            || self
                .library()
                .is_some_and(|library| holds_ai_notes(library, doc_id));
        trial_gate(
            self.capabilities().and_then(|c| c.notes_trial_remaining),
            covered,
        )
    }

    pub(super) fn capabilities_settled(&mut self, cx: &mut Context<Self>) {
        for doc_id in self.ai.take_waiting() {
            self.auto_notes_for(doc_id, cx);
        }
    }

    pub(super) fn notes_finished(
        &mut self,
        doc_id: &str,
        outcome: &Result<(), NotesError>,
        cx: &mut Context<Self>,
    ) {
        if matches!(outcome, Err(NotesError::UpgradeRequired)) || self.ai.on_trial(doc_id) {
            self.refresh_capabilities(cx);
        }
    }

    pub(super) fn remember_unwritten(&self, doc_ids: Vec<String>) {
        let path = persist::meetings_dir().join(UNWRITTEN_FILE);
        if doc_ids.is_empty() {
            return;
        }
        let mut all = read_unwritten(&path);
        let account = current_account();
        for id in doc_ids {
            if !all.iter().any(|entry| entry.id() == id) {
                all.push(Unwritten::Owned {
                    id,
                    account: account.clone(),
                });
            }
        }
        if let Err(error) = write_unwritten(&path, &all) {
            tracing::warn!(%error, "could not remember meetings waiting for notes");
        }
    }

    /// The notes were written (or will never be): no resume next launch.
    pub(super) fn forget_unwritten(&self, doc_id: &str) {
        let path = persist::meetings_dir().join(UNWRITTEN_FILE);
        if !path.exists() {
            return;
        }
        let mut all = read_unwritten(&path);
        let before = all.len();
        all.retain(|entry| entry.id() != doc_id);
        if all.len() == before {
            return;
        }
        if let Err(error) = write_unwritten(&path, &all) {
            tracing::warn!(%error, "could not update the meetings waiting for notes");
        }
    }

    pub(super) fn resume_unwritten(&mut self, cx: &mut Context<Self>) {
        let path = persist::meetings_dir().join(UNWRITTEN_FILE);
        if !path.exists() {
            return;
        }
        let (ids, kept) =
            split_unwritten(read_unwritten(&path), current_account().as_deref(), |id| {
                self.ai.started(id)
            });
        if let Err(error) = write_unwritten(&path, &kept) {
            tracing::warn!(%error, "could not update the meetings waiting for notes");
        }
        if ids.is_empty() || !self.settings.notes.auto_generate {
            return;
        }
        cx.spawn(async move |this, cx| {
            this.update(cx, |this, cx| {
                for id in ids {
                    let written = this
                        .library()
                        .and_then(|l| l.load(&id).ok())
                        .and_then(|m| m.meeting)
                        .is_none_or(|m| m.has_enhanced);
                    if !written {
                        tracing::info!(
                            doc_id = id,
                            "writing notes for a meeting that ended at quit"
                        );
                        this.auto_notes_for(id, cx);
                    }
                }
            })
            .ok();
        })
        .detach();
    }
}

/// Meetings whose notes were left to write after Cap last quit.
pub(super) fn unwritten_ids() -> Vec<String> {
    read_unwritten(&persist::meetings_dir().join(UNWRITTEN_FILE))
        .into_iter()
        .map(|entry| entry.id().to_string())
        .collect()
}

/// A meeting whose notes are still to write, with the Cap account signed in
/// when they were left (none when signed out). Files from before accounts
/// were kept hold bare ids.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
enum Unwritten {
    Owned { id: String, account: Option<String> },
    Bare(String),
}

impl Unwritten {
    fn id(&self) -> &str {
        match self {
            Unwritten::Owned { id, .. } | Unwritten::Bare(id) => id,
        }
    }
}

fn current_account() -> Option<String> {
    if !crate::store::auth_snapshot().signed_in() {
        return None;
    }
    crate::store::store_section("auth")
        .get("user_id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

/// The ids to write now (left by `account`, or by nobody in particular),
/// and the entries to keep: another account's, for its next sign-in, and
/// those whose notes this run already `started`, for the next launch.
fn split_unwritten(
    all: Vec<Unwritten>,
    account: Option<&str>,
    started: impl Fn(&str) -> bool,
) -> (Vec<String>, Vec<Unwritten>) {
    let (mine, kept): (Vec<_>, Vec<_>) = all.into_iter().partition(|entry| {
        let owned = match entry {
            Unwritten::Owned {
                account: Some(owner),
                ..
            } => Some(owner.as_str()) == account,
            _ => true,
        };
        owned && !started(entry.id())
    });
    (
        mine.iter().map(|entry| entry.id().to_string()).collect(),
        kept,
    )
}

fn read_unwritten(path: &std::path::Path) -> Vec<Unwritten> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_unwritten(path: &std::path::Path, all: &[Unwritten]) -> std::io::Result<()> {
    if all.is_empty() {
        return match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        };
    }
    persist::atomic_write(
        path,
        &serde_json::to_vec(all).map_err(std::io::Error::other)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_left_by_one_account_wait_for_that_account() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(UNWRITTEN_FILE);
        // A file from before accounts were kept, then newer entries.
        std::fs::write(&path, br#"["old"]"#).unwrap();
        let mut all = read_unwritten(&path);
        for (id, account) in [
            ("a1", Some("user-a")),
            ("b1", Some("user-b")),
            ("anon", None),
        ] {
            all.push(Unwritten::Owned {
                id: id.into(),
                account: account.map(str::to_string),
            });
        }
        write_unwritten(&path, &all).unwrap();
        let all = read_unwritten(&path);
        assert_eq!(all.len(), 4);

        let (now, kept) = split_unwritten(all.clone(), Some("user-b"), |_| false);
        assert_eq!(now, ["old", "b1", "anon"]);
        assert_eq!(kept.iter().map(Unwritten::id).collect::<Vec<_>>(), ["a1"]);

        let (now, kept) = split_unwritten(all.clone(), None, |_| false);
        assert_eq!(now, ["old", "anon"]);
        assert_eq!(kept.len(), 2);

        // A sign-in later in the same run: notes this run already started
        // (written, or failed after their retries) stay for the next launch.
        let (now, kept) = split_unwritten(all, Some("user-b"), |id| id == "b1");
        assert_eq!(now, ["old", "anon"]);
        assert_eq!(
            kept.iter().map(Unwritten::id).collect::<Vec<_>>(),
            ["a1", "b1"]
        );

        write_unwritten(&path, &[]).unwrap();
        assert!(!path.exists());
        write_unwritten(&path, &[]).unwrap();
    }

    #[test]
    fn a_free_meeting_can_be_rewritten_after_the_last_one_is_used() {
        let dir = tempfile::tempdir().unwrap();
        let library = cap_meetings::library::Library::open(dir.path().join("documents")).unwrap();
        let written = library
            .create(
                cap_meetings::library::DocKind::Meeting,
                chrono::Utc::now(),
                1,
            )
            .unwrap();
        library.write_enhanced(&written.id, "{}").unwrap();
        let fresh = library
            .create(
                cap_meetings::library::DocKind::Meeting,
                chrono::Utc::now(),
                2,
            )
            .unwrap();
        assert!(holds_ai_notes(&library, &written.id));
        assert!(!holds_ai_notes(&library, &fresh.id));

        // All free meetings used: a meeting with notes still goes to the
        // server, which allows it within its runs; a new one is stopped here
        // with the upgrade message.
        assert_eq!(
            trial_gate(Some(0), holds_ai_notes(&library, &written.id)),
            Ok(())
        );
        assert_eq!(
            trial_gate(Some(0), holds_ai_notes(&library, &fresh.id)),
            Err(NotesError::UpgradeRequired)
        );
        assert_eq!(trial_gate(None, false), Err(NotesError::UpgradeRequired));
        assert_eq!(trial_gate(Some(1), false), Ok(()));
    }

    fn caps(notes: bool, trial: Option<u32>) -> Capabilities {
        Capabilities {
            notes,
            notes_trial_remaining: trial,
            ..Capabilities::default()
        }
    }

    fn input<'a>(
        signed_in: bool,
        pro: bool,
        caps: Option<&'a Capabilities>,
        error: Option<&'a CloudError>,
    ) -> AccessInput<'a> {
        AccessInput {
            signed_in,
            pro,
            caps,
            error,
        }
    }

    #[test]
    fn access_maps_every_account_state() {
        let on = caps(true, None);
        let off = caps(false, None);
        let two = caps(false, Some(2));
        let none_left = caps(true, Some(0));
        let offline = CloudError::Offline("x".into());
        let unconfigured = CloudError::NotConfigured;
        let upgrade = CloudError::UpgradeRequired;
        assert_eq!(
            resolve(input(false, false, None, None)),
            AiAccess::NeedsSignIn
        );
        assert_eq!(
            resolve(input(false, true, Some(&on), None)),
            AiAccess::NeedsSignIn
        );
        assert_eq!(resolve(input(true, true, Some(&on), None)), AiAccess::Ready);
        assert_eq!(
            resolve(input(true, true, Some(&off), None)),
            AiAccess::Unavailable
        );
        assert_eq!(resolve(input(true, true, None, None)), AiAccess::Ready);
        assert_eq!(
            resolve(input(true, true, None, Some(&offline))),
            AiAccess::Ready
        );
        assert_eq!(
            resolve(input(true, true, None, Some(&unconfigured))),
            AiAccess::Unavailable
        );
        assert_eq!(
            resolve(input(true, false, Some(&two), None)),
            AiAccess::Trial { remaining: 2 }
        );
        assert_eq!(
            resolve(input(true, false, Some(&none_left), None)),
            AiAccess::NeedsUpgrade
        );
        assert_eq!(
            resolve(input(true, false, Some(&on), None)),
            AiAccess::NeedsUpgrade
        );
        assert_eq!(
            resolve(input(true, false, None, None)),
            AiAccess::NeedsUpgrade
        );
        assert_eq!(
            resolve(input(true, false, None, Some(&upgrade))),
            AiAccess::NeedsUpgrade
        );
        assert_eq!(
            resolve(input(true, false, None, Some(&unconfigured))),
            AiAccess::Unavailable
        );
    }

    #[test]
    fn a_free_account_is_settled_once_the_server_answers() {
        let two = caps(false, Some(2));
        let upgrade = CloudError::UpgradeRequired;
        assert!(settled(input(false, false, None, None)));
        assert!(settled(input(true, true, None, None)));
        assert!(!settled(input(true, false, None, None)));
        assert!(settled(input(true, false, Some(&two), None)));
        assert!(settled(input(true, false, None, Some(&upgrade))));
        for passing in [
            CloudError::Offline("no route".into()),
            CloudError::Failed("503".into()),
            CloudError::RateLimited {
                retry_after_secs: 30,
            },
        ] {
            assert!(
                !settled(input(true, false, None, Some(&passing))),
                "{passing:?} may clear, so a free account's trial is still unknown"
            );
        }
    }

    #[test]
    fn a_free_meeting_waits_out_a_passing_error_instead_of_skipping_notes() {
        let offline = CloudError::Offline("no route".into());
        let free = input(true, false, None, Some(&offline));
        let mut state = AiState::default();
        assert_eq!(
            state.decide("a", resolve(free), settled(free)),
            AutoDecision::Wait
        );
        assert!(state.has_waiting());
        let two = caps(false, Some(2));
        let answered = input(true, false, Some(&two), None);
        assert_eq!(state.take_waiting(), vec!["a".to_string()]);
        assert_eq!(
            state.decide("a", resolve(answered), settled(answered)),
            AutoDecision::Start
        );
    }

    #[test]
    fn a_server_without_the_meeting_endpoints_never_auto_writes_notes() {
        // A Pro account on a server that answers 404 used to start notes and show them as failed.
        let missing = super::super::cloud::classify_status(404, "", None);
        assert_eq!(NotesError::from(missing.clone()), NotesError::NotConfigured);
        let pro = resolve(input(true, true, None, Some(&missing)));
        let free = resolve(input(true, false, None, Some(&missing)));
        assert_eq!(pro, AiAccess::Unavailable);
        assert_eq!(free, AiAccess::Unavailable);
        let mut state = AiState::default();
        assert_eq!(state.decide("a", pro, true), AutoDecision::Skip);
    }

    #[test]
    fn payment_required_maps_to_needs_upgrade() {
        let error = super::super::cloud::classify_status(402, "{}", None);
        assert_eq!(error, CloudError::UpgradeRequired);
        assert_eq!(NotesError::from(error.clone()), NotesError::UpgradeRequired);
        assert_eq!(
            resolve(input(true, false, None, Some(&error))),
            AiAccess::NeedsUpgrade
        );
    }

    #[test]
    fn auto_notes_start_once_per_meeting_for_ready_and_trial() {
        let mut state = AiState::default();
        assert_eq!(
            state.decide("a", AiAccess::Ready, true),
            AutoDecision::Start
        );
        assert_eq!(state.decide("a", AiAccess::Ready, true), AutoDecision::Skip);
        let trial = AiAccess::Trial { remaining: 1 };
        assert_eq!(state.decide("b", trial, true), AutoDecision::Start);
        assert_eq!(state.decide("b", trial, true), AutoDecision::Skip);
    }

    #[test]
    fn auto_notes_never_start_for_locked_accounts() {
        let mut state = AiState::default();
        for _ in 0..3 {
            assert_eq!(
                state.decide("a", AiAccess::NeedsUpgrade, true),
                AutoDecision::Skip
            );
            assert_eq!(
                state.decide("b", AiAccess::NeedsSignIn, true),
                AutoDecision::Skip
            );
            assert_eq!(
                state.decide("c", AiAccess::Unavailable, true),
                AutoDecision::Skip
            );
        }
        assert!(state.take_waiting().is_empty());
    }

    #[test]
    fn auto_notes_wait_for_an_unknown_trial_then_start_once() {
        let mut state = AiState::default();
        assert_eq!(
            state.decide("a", AiAccess::NeedsUpgrade, false),
            AutoDecision::Wait
        );
        assert_eq!(
            state.decide("a", AiAccess::NeedsUpgrade, false),
            AutoDecision::Wait
        );
        assert_eq!(state.take_waiting(), vec!["a".to_string()]);
        let trial = AiAccess::Trial { remaining: 3 };
        assert_eq!(state.decide("a", trial, true), AutoDecision::Start);
        assert_eq!(state.decide("a", trial, true), AutoDecision::Skip);
        assert!(state.take_waiting().is_empty());
    }

    #[test]
    fn capabilities_parse_the_optional_trial_count() {
        let with: Capabilities =
            serde_json::from_str(r#"{"notes":false,"notesTrialRemaining":2}"#).unwrap();
        assert_eq!(with.notes_trial_remaining, Some(2));
        let without: Capabilities = serde_json::from_str(r#"{"notes":true}"#).unwrap();
        assert_eq!(without.notes_trial_remaining, None);
    }

    #[test]
    fn free_accounts_ask_only_about_written_meetings() {
        assert!(AiAccess::Ready.can_ask(false));
        assert!(AiAccess::Trial { remaining: 1 }.can_ask(true));
        assert!(!AiAccess::Trial { remaining: 1 }.can_ask(false));
        assert!(AiAccess::NeedsUpgrade.can_ask(true));
        assert!(!AiAccess::NeedsUpgrade.can_ask(false));
        assert!(!AiAccess::NeedsSignIn.can_ask(true));
    }

    #[test]
    fn debug_access_values_parse() {
        assert_eq!(AiAccess::parse("ready"), Some(AiAccess::Ready));
        assert_eq!(
            AiAccess::parse("trial:2"),
            Some(AiAccess::Trial { remaining: 2 })
        );
        assert_eq!(AiAccess::parse("spent"), Some(AiAccess::NeedsUpgrade));
        assert_eq!(AiAccess::parse("signin"), Some(AiAccess::NeedsSignIn));
        assert_eq!(AiAccess::parse("nope"), None);
    }
}
