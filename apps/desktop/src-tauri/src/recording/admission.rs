use crate::{
    auth::AuthStore,
    general_settings::GeneralSettingsStore,
    web_api::{AuthedApiError, UploadRequestContext},
};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::{Store, StoreExt};

pub(super) const CHANGED: &str =
    "Account, server, or Instant recording quality changed during startup. Try recording again.";

#[derive(Clone)]
pub(super) struct Binding {
    server_url: String,
    auth: Arc<AuthStore>,
    secret: Value,
    pub(super) configured_resolution: u32,
}

impl Binding {
    pub(super) fn read<R: Runtime>(app: &AppHandle<R>, server_url: &str) -> Result<Self, String> {
        let store = app
            .store("store")
            .map_err(|_| "Could not read recording account settings")?;
        Self::from_store(&store, server_url)
    }

    fn from_store<R: Runtime>(store: &Store<R>, server_url: &str) -> Result<Self, String> {
        // entries takes the same plugin-store mutex used by native and frontend writes.
        let entries = store.entries();
        let raw_auth = entries
            .iter()
            .find(|(key, _)| key == "auth")
            .map(|(_, value)| value.clone())
            .ok_or("Please sign in to use instant recording")?;
        let auth: AuthStore = serde_json::from_value(raw_auth.clone())
            .map_err(|_| "Please sign in to use instant recording")?;
        let settings = GeneralSettingsStore::from_stored_value(
            entries
                .iter()
                .find(|(key, _)| key == "general_settings")
                .map(|(_, value)| value.clone()),
        )?;
        let configured_resolution = if auth.is_upgraded() {
            settings.map_or(cap_recording::PRO_INSTANT_MODE_MAX_RESOLUTION, |settings| {
                settings.instant_mode_max_resolution
            })
        } else {
            cap_recording::FREE_INSTANT_MODE_MAX_RESOLUTION
        };
        if server_url.is_empty() {
            return Err("Recording server is unavailable".into());
        }
        Ok(Self {
            server_url: server_url.to_string(),
            secret: raw_auth["secret"].clone(),
            auth: Arc::new(auth),
            configured_resolution,
        })
    }

    fn matches(&self, current: &Self) -> bool {
        self.server_url == current.server_url
            && self.auth.user_id == current.auth.user_id
            && self.secret == current.secret
            && self.auth.is_upgraded() == current.auth.is_upgraded()
            && self.configured_resolution == current.configured_resolution
    }

    pub(super) fn validate<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        server_url: &str,
    ) -> Result<(), String> {
        let store = app.store("store").map_err(|_| CHANGED.to_string())?;
        self.validate_store(&store, server_url)
    }

    fn validate_store<R: Runtime>(&self, store: &Store<R>, server_url: &str) -> Result<(), String> {
        let current = Self::from_store(store, server_url).map_err(|_| CHANGED.to_string())?;
        if !self.matches(&current) {
            return Err(CHANGED.into());
        }
        Ok(())
    }

    pub(super) fn admit<R: Runtime, T>(
        &self,
        app: &AppHandle<R>,
        server_url: &str,
        publish: impl FnOnce() -> T,
    ) -> Result<T, String> {
        let store = app.store("store").map_err(|_| CHANGED.to_string())?;
        self.admit_from_store(&store, server_url, publish)
    }

    fn admit_from_store<R: Runtime, T>(
        &self,
        store: &Store<R>,
        server_url: &str,
        publish: impl FnOnce() -> T,
    ) -> Result<T, String> {
        self.validate_store(store, server_url)?;
        Ok(publish())
    }

    pub(super) fn context(&self) -> Result<UploadRequestContext, AuthedApiError> {
        UploadRequestContext::for_admission(self.server_url.clone(), self.auth.clone())
    }

    pub(super) fn share_url(&self, video_id: &str) -> String {
        format!("{}/s/{video_id}", self.server_url.trim_end_matches('/'))
    }

    pub(super) fn server_url(&self) -> &str {
        &self.server_url
    }

    pub(super) fn owner_id(&self) -> Option<String> {
        self.auth.user_id.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tauri::test::MockRuntime;

    fn fixture() -> (
        tauri::App<MockRuntime>,
        Arc<Store<MockRuntime>>,
        tempfile::TempDir,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_store::Builder::new().build())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let store = app
            .store_builder(directory.path().join("admission.json"))
            .disable_auto_save()
            .build()
            .unwrap();
        write_auth(&store, Some("alice"), "a", true);
        store.set("general_settings", json!({"instantModeMaxResolution":1920}));
        (app, store, directory)
    }

    fn write_auth(store: &Store<MockRuntime>, owner: Option<&str>, secret: &str, upgraded: bool) {
        store.set(
            "auth",
            json!({
                "user_id":owner, "secret":{"api_key":secret},
                "plan":{"upgraded":upgraded,"manual":false,"last_checked":1}
            }),
        );
    }

    #[test]
    fn actual_store_writes_reject_account_credentials_plan_quality_and_origin_changes() {
        let (_app, store, _directory) = fixture();
        let initial = Binding::from_store(&store, "https://a.invalid").unwrap();
        write_auth(&store, Some("bob"), "b", true);
        assert!(!initial.matches(&Binding::from_store(&store, "https://a.invalid").unwrap()));
        write_auth(&store, Some("alice"), "new-a", true);
        assert!(!initial.matches(&Binding::from_store(&store, "https://a.invalid").unwrap()));
        write_auth(&store, Some("alice"), "a", false);
        assert!(!initial.matches(&Binding::from_store(&store, "https://a.invalid").unwrap()));
        write_auth(&store, Some("alice"), "a", true);
        store.set("general_settings", json!({"instantModeMaxResolution":1280}));
        assert!(!initial.matches(&Binding::from_store(&store, "https://a.invalid").unwrap()));
        store.set("general_settings", json!({"instantModeMaxResolution":1920}));
        assert!(!initial.matches(&Binding::from_store(&store, "https://b.invalid").unwrap()));
        assert!(initial.matches(&Binding::from_store(&store, "https://a.invalid").unwrap()));
        store.delete("auth");
        assert!(Binding::from_store(&store, "https://a.invalid").is_err());
    }

    #[test]
    fn effective_aba_state_is_allowed_but_does_not_rebind_the_original_context() {
        let (_app, store, _directory) = fixture();
        let initial = Binding::from_store(&store, "https://a.invalid").unwrap();
        write_auth(&store, Some("bob"), "b", false);
        write_auth(&store, Some("alice"), "a", true);
        assert!(initial.matches(&Binding::from_store(&store, "https://a.invalid").unwrap()));
        let context = initial.context().unwrap();
        assert_eq!(context.owner_id(), Some("alice"));
        assert_eq!(context.server_url(), "https://a.invalid");
        assert_eq!(initial.share_url("video"), "https://a.invalid/s/video");
    }

    #[test]
    fn missing_optional_owner_is_readable_but_not_a_full_recording_owner() {
        let (_app, store, _directory) = fixture();
        write_auth(&store, None, "a", true);
        let binding = Binding::from_store(&store, "https://a.invalid").unwrap();
        assert_eq!(binding.configured_resolution, 1920);
        assert_eq!(binding.context().unwrap().owner_id(), None);
    }

    #[test]
    fn captured_quality_uses_existing_settings_recovery_and_absent_settings_policy() {
        let (_app, store, _directory) = fixture();
        store.delete("general_settings");
        assert_eq!(
            Binding::from_store(&store, "https://a.invalid")
                .unwrap()
                .configured_resolution,
            cap_recording::PRO_INSTANT_MODE_MAX_RESOLUTION
        );
        store.set(
            "general_settings",
            json!({"instantModeMaxResolution":"broken","recordingCountdown":"broken"}),
        );
        assert_eq!(
            Binding::from_store(&store, "https://a.invalid")
                .unwrap()
                .configured_resolution,
            cap_recording::DEFAULT_INSTANT_MODE_MAX_RESOLUTION
        );
        write_auth(&store, Some("alice"), "a", false);
        assert_eq!(
            Binding::from_store(&store, "https://a.invalid")
                .unwrap()
                .configured_resolution,
            cap_recording::FREE_INSTANT_MODE_MAX_RESOLUTION
        );
    }

    #[tokio::test]
    async fn held_create_and_cue_revalidate_actual_store_before_output_admission() {
        let (_app, store, _directory) = fixture();
        let binding = Binding::from_store(&store, "https://a.invalid").unwrap();
        let context = binding.context().unwrap();
        let gate = cap_recording::RecordingStartGate::explicit_admission();
        let (created, create_response) = tokio::sync::oneshot::channel();
        let (cued, cue_response) = tokio::sync::oneshot::channel();
        let request_store = store.clone();
        let request_gate = gate.clone();
        let request = async move {
            context
                .run(async move {
                    let actual_context = UploadRequestContext::current().unwrap();
                    assert_eq!(actual_context.owner_id(), Some("alice"));
                    assert_eq!(actual_context.server_url(), "https://a.invalid");
                    create_response.await.unwrap();
                    cue_response.await.unwrap();
                    binding.admit_from_store(&request_store, "https://a.invalid", || {
                        request_gate.arm();
                        binding.share_url("created-for-alice")
                    })
                })
                .await
        };
        tokio::pin!(request);
        assert!(futures::poll!(&mut request).is_pending());
        write_auth(&store, Some("bob"), "b", true);
        created.send(()).unwrap();
        assert!(futures::poll!(&mut request).is_pending());
        cued.send(()).unwrap();
        assert_eq!(request.await.unwrap_err(), CHANGED);
        assert!(!gate.is_armed());
    }

    #[tokio::test]
    async fn aba_during_awaits_can_admit_only_the_restored_effective_binding() {
        let (_app, store, _directory) = fixture();
        let binding = Binding::from_store(&store, "https://a.invalid").unwrap();
        let gate = cap_recording::RecordingStartGate::explicit_admission();
        let (ready, wait) = tokio::sync::oneshot::channel();
        let request_store = store.clone();
        let request_gate = gate.clone();
        let request = async move {
            wait.await.unwrap();
            binding.admit_from_store(&request_store, "https://a.invalid", || {
                request_gate.arm();
                binding.configured_resolution
            })
        };
        tokio::pin!(request);
        assert!(futures::poll!(&mut request).is_pending());
        write_auth(&store, Some("bob"), "b", false);
        write_auth(&store, Some("alice"), "a", true);
        ready.send(()).unwrap();
        assert_eq!(request.await.unwrap(), 1920);
        assert!(gate.is_armed());
    }
}
