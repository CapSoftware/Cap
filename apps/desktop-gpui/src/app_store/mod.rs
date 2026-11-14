pub mod catalog;
pub mod settings_page;

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{App, AsyncApp, BorrowAppContext, Global, RenderImage};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{auth, store};
pub use catalog::*;

const STORE_SECTION: &str = "appStore";
const LOCAL_INSTALLS_KEY: &str = "localInstalls";
const REFRESH_INTERVAL: Duration = Duration::from_secs(10 * 60);
const ICON_THUMBNAIL: u32 = 96;
const BACKGROUND_THUMBNAIL: u32 = 256;
const MAX_ASSET_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SyncState {
    #[default]
    Idle,
    Loading,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CapAction {
    pub installation_id: String,
    pub app_id: String,
    pub app_name: String,
    pub action_id: String,
    pub title: String,
    pub icon_sha256: String,
}

#[derive(Default)]
pub struct AppStore {
    pub catalog: Option<Arc<Catalog>>,
    pub installations: Vec<Installation>,
    pub local_installs: BTreeSet<String>,
    pub signed_in: bool,
    pub state: SyncState,
    pub pending: BTreeSet<String>,
    account: Option<String>,
    cap_actions: HashMap<String, Vec<CapAction>>,
    cap_actions_pending: BTreeSet<String>,
    assets: HashMap<String, PathBuf>,
    thumbnails: HashMap<String, Arc<RenderImage>>,
    last_refresh: Option<Instant>,
    generation: u64,
}

impl Global for AppStore {}

pub fn root_dir() -> PathBuf {
    store::app_data_dir().join("app-store")
}

fn catalog_cache_path() -> PathBuf {
    root_dir().join("catalog.json")
}

pub fn asset_path(asset: &CatalogAsset) -> Option<PathBuf> {
    asset.is_valid_hash().then(|| {
        root_dir()
            .join("assets")
            .join(format!("{}.{}", asset.sha256, asset.extension()))
    })
}

fn installations_cache_path() -> PathBuf {
    root_dir().join("installations.json")
}

fn current_account() -> Option<String> {
    let auth = store::auth_snapshot();
    let token = auth.token?;
    Some(sha256_hex(
        format!("{}\n{token}", auth::server_url()).as_bytes(),
    ))
}

fn read_cached_installations(account: &str) -> Option<Vec<Installation>> {
    let bytes = std::fs::read(installations_cache_path()).ok()?;
    let cached: CachedInstallations = serde_json::from_slice(&bytes).ok()?;
    (cached.account == account).then_some(cached.installations)
}

fn write_cached_installations(account: &str, installations: &[Installation]) {
    let path = installations_cache_path();
    let Ok(bytes) = serde_json::to_vec(&CachedInstallations {
        account: account.to_string(),
        installations: installations.to_vec(),
    }) else {
        return;
    };
    if let Some(parent) = path.parent()
        && std::fs::create_dir_all(parent).is_err()
    {
        return;
    }
    let temporary = path.with_extension("partial");
    if std::fs::write(&temporary, bytes).is_err() || std::fs::rename(&temporary, &path).is_err() {
        tracing::warn!("Could not cache App Store installations");
    }
}

fn read_local_installs() -> BTreeSet<String> {
    store::store_section(STORE_SECTION)
        .get(LOCAL_INSTALLS_KEY)
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn write_local_installs(ids: &BTreeSet<String>) {
    store::update_store_section(STORE_SECTION, |section| {
        section.insert(LOCAL_INSTALLS_KEY.to_string(), json!(ids));
        true
    });
}

fn read_cached_catalog() -> Option<Catalog> {
    let bytes = std::fs::read(catalog_cache_path()).ok()?;
    Catalog::parse(&serde_json::from_slice(&bytes).ok()?)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn store_verified_asset(target: &Path, bytes: &[u8], expected: &str) -> Result<(), String> {
    if sha256_hex(bytes) != expected {
        return Err("downloaded asset does not match its hash".to_string());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = target.with_extension("partial");
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, target).map_err(|error| error.to_string())
}

fn asset_url(server: &str, asset: &CatalogAsset) -> String {
    if asset.url.starts_with("https://") || asset.url.starts_with("http://") {
        asset.url.clone()
    } else {
        format!("{server}{}", asset.url)
    }
}

impl AppStore {
    pub fn init(cx: &mut App) {
        let catalog = read_cached_catalog().map(Arc::new);
        let account = current_account();
        let installations = account
            .as_deref()
            .and_then(read_cached_installations)
            .unwrap_or_default();
        let mut state = AppStore {
            catalog,
            installations,
            account,
            local_installs: read_local_installs(),
            signed_in: store::auth_snapshot().token.is_some(),
            ..Default::default()
        };
        state.index_cached_assets();
        cx.set_global(state);
        let sign_in = crate::sign_in::SignIn::global(cx);
        cx.subscribe(&sign_in, |_, event, cx| {
            if matches!(
                event,
                crate::sign_in::SignInEvent::Finished { .. }
                    | crate::sign_in::SignInEvent::AccountRefreshed
            ) {
                refresh(cx);
            }
        })
        .detach();
        refresh(cx);
    }

    fn index_cached_assets(&mut self) {
        let Some(catalog) = self.catalog.clone() else {
            return;
        };
        for app in &catalog.apps {
            for asset in std::iter::once(&app.icon).chain(app.image_assets()) {
                if let Some(path) = asset_path(asset)
                    && path.is_file()
                {
                    self.assets.insert(asset.sha256.clone(), path);
                }
            }
        }
    }

    // Installs belong to the account they were fetched for. Auth can be
    // cleared from several places (sign out, an upload rejecting the key), so
    // they are checked against the current account instead of trusting that
    // every one of those places resets the store.
    pub fn account_installations(&self) -> &[Installation] {
        self.installations_for(current_account().as_deref())
    }

    fn installations_for(&self, account: Option<&str>) -> &[Installation] {
        match (&self.account, account) {
            (Some(stored), Some(current)) if stored == current => &self.installations,
            _ => &[],
        }
    }

    pub fn installed_ids(&self) -> BTreeSet<String> {
        let mut ids: BTreeSet<String> = self
            .account_installations()
            .iter()
            .filter(|installation| installation.is_active())
            .map(|installation| installation.app_id.clone())
            .collect();
        ids.extend(self.local_installs.iter().cloned());
        ids
    }

    pub fn installed_apps(&self) -> Vec<&CatalogApp> {
        let Some(catalog) = self.catalog.as_deref() else {
            return Vec::new();
        };
        let ids = self.installed_ids();
        catalog
            .apps
            .iter()
            .filter(|app| ids.contains(&app.id))
            .collect()
    }

    pub fn asset_file(&self, asset: &CatalogAsset) -> Option<&PathBuf> {
        self.assets.get(&asset.sha256)
    }

    pub fn thumbnail(&self, sha256: &str) -> Option<Arc<RenderImage>> {
        self.thumbnails.get(sha256).cloned()
    }

    pub fn backgrounds(&self) -> Vec<(String, CatalogBackground)> {
        self.installed_apps()
            .into_iter()
            .flat_map(|app| {
                app.backgrounds
                    .iter()
                    .filter(|background| match background {
                        CatalogBackground::Image { image, .. } => {
                            self.assets.contains_key(&image.sha256)
                        }
                        _ => true,
                    })
                    .map(|background| (app.id.clone(), background.clone()))
            })
            .collect()
    }

    pub fn caption_styles(&self) -> Vec<(String, CaptionStyle)> {
        self.installed_apps()
            .into_iter()
            .flat_map(|app| {
                app.caption_styles
                    .iter()
                    .map(|style| (app.id.clone(), style.clone()))
            })
            .collect()
    }

    pub fn color_looks(&self) -> Vec<(String, ColorLook)> {
        self.installed_apps()
            .into_iter()
            .flat_map(|app| {
                app.color_looks
                    .iter()
                    .map(|look| (app.id.clone(), look.clone()))
            })
            .collect()
    }

    pub fn has_cap_actions(&self) -> bool {
        self.has_cap_actions_in(self.account_installations())
    }

    fn has_cap_actions_in(&self, installations: &[Installation]) -> bool {
        let Some(catalog) = self.catalog.as_deref() else {
            return false;
        };
        installations.iter().any(|installation| {
            installation.is_active()
                && catalog
                    .app(&installation.app_id)
                    .and_then(|app| app.connection.as_ref())
                    .is_some_and(|connection| !connection.actions.is_empty())
        })
    }

    pub fn actions_for_cap(&self, cap_id: &str) -> Option<&Vec<CapAction>> {
        self.cap_actions.get(cap_id)
    }
}

#[derive(Clone, Default)]
pub struct AppStoreSnapshot {
    pub catalog: Option<Arc<Catalog>>,
    pub installations: Vec<Installation>,
    pub local_installs: BTreeSet<String>,
    pub pending: BTreeSet<String>,
    pub signed_in: bool,
    pub state: SyncState,
    pub thumbnails: HashMap<String, Arc<RenderImage>>,
}

impl AppStoreSnapshot {
    pub fn installation(&self, app_id: &str) -> Option<&Installation> {
        self.installations
            .iter()
            .find(|installation| installation.app_id == app_id && installation.scope == "user")
            .or_else(|| {
                self.installations
                    .iter()
                    .find(|installation| installation.app_id == app_id)
            })
    }

    pub fn is_installed(&self, app_id: &str) -> bool {
        self.local_installs.contains(app_id) || self.installation(app_id).is_some()
    }
}

impl AppStore {
    pub fn snapshot(&self) -> AppStoreSnapshot {
        AppStoreSnapshot {
            catalog: self.catalog.clone(),
            installations: self.account_installations().to_vec(),
            local_installs: self.local_installs.clone(),
            pending: self.pending.clone(),
            signed_in: self.signed_in,
            state: self.state,
            thumbnails: self.thumbnails.clone(),
        }
    }
}

pub fn snapshot(cx: &App) -> AppStoreSnapshot {
    cx.try_global::<AppStore>()
        .map(AppStore::snapshot)
        .unwrap_or_default()
}

pub fn try_get(cx: &App) -> Option<&AppStore> {
    cx.try_global::<AppStore>()
}

pub fn refresh_if_stale(cx: &mut App) {
    let stale = cx.try_global::<AppStore>().is_none_or(|store| {
        store.state != SyncState::Loading
            && store
                .last_refresh
                .is_none_or(|last| last.elapsed() >= REFRESH_INTERVAL)
    });
    if stale {
        refresh(cx);
    }
}

struct SyncResult {
    catalog: Option<Catalog>,
    installations: Option<Vec<Installation>>,
    account: Option<String>,
    signed_in: bool,
    failed: bool,
}

pub fn refresh(cx: &mut App) {
    if !cx.has_global::<AppStore>() {
        return;
    }
    let generation = cx.update_global::<AppStore, _>(|store, _| {
        store.state = SyncState::Loading;
        store.generation += 1;
        store.generation
    });
    let local = read_local_installs();
    cx.spawn(async move |cx: &mut AsyncApp| {
        let task = cx.update(|cx| gpui_tokio::Tokio::spawn(cx, sync(local)));
        let result = task.await.unwrap_or(SyncResult {
            catalog: None,
            installations: None,
            account: None,
            signed_in: false,
            failed: true,
        });
        let applied = cx.update(|cx| {
            cx.update_global::<AppStore, _>(|store, _| {
                if store.generation != generation {
                    return false;
                }
                if let Some(catalog) = result.catalog {
                    store.catalog = Some(Arc::new(catalog));
                }
                if let Some(installations) = result.installations {
                    store.installations = installations;
                    store.account = result.account;
                }
                store.cap_actions.clear();
                store.signed_in = result.signed_in;
                store.local_installs = read_local_installs();
                store.state = if result.failed {
                    SyncState::Failed
                } else {
                    SyncState::Idle
                };
                store.last_refresh = Some(Instant::now());
                true
            })
        });
        if applied {
            load_assets(cx).await;
        }
    })
    .detach();
}

async fn sync(local: BTreeSet<String>) -> SyncResult {
    let server = auth::server_url();
    let mut failed = false;
    let catalog = match fetch_catalog(&server).await {
        Ok(catalog) => catalog,
        Err(error) => {
            tracing::warn!(%error, "App Store catalog refresh failed");
            failed = true;
            None
        }
    };
    let signed_in = store::auth_snapshot().token.is_some();
    let account = current_account();
    let mut installations = None;
    if signed_in {
        if !local.is_empty() {
            adopt_local_installs(&local).await;
        }
        match fetch_installations().await {
            Ok(list) => {
                if let Some(account) = &account {
                    write_cached_installations(account, &list);
                }
                installations = Some(list);
            }
            Err(error) => {
                tracing::warn!(%error, "App Store installations refresh failed");
                failed = true;
            }
        }
    } else {
        installations = Some(Vec::new());
    }
    SyncResult {
        catalog,
        installations,
        account,
        signed_in,
        failed,
    }
}

async fn fetch_catalog(server: &str) -> Result<Option<Catalog>, String> {
    let client = auth::api_client().map_err(|error| error.to_string())?;
    let url = format!("{server}/api/app-store/catalog?apiVersion={SUPPORTED_API_VERSION}");
    let response = auth::apply_desktop_headers(client.get(url))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("catalog returned {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let catalog = Catalog::parse(&value).ok_or("catalog has an unknown format")?;
    let path = catalog_cache_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("partial");
    if std::fs::write(&temporary, &bytes).is_ok() && std::fs::rename(&temporary, &path).is_err() {
        tracing::warn!("Could not cache the App Store catalog");
    }
    Ok(Some(catalog))
}

async fn fetch_installations() -> Result<Vec<Installation>, String> {
    let response = auth::authed_request(reqwest::Method::GET, "/api/app-store/installations", None)
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("installations returned {}", response.status()));
    }
    let body: InstallationsResponse = response.json().await.map_err(|error| error.to_string())?;
    Ok(body.installations)
}

async fn adopt_local_installs(local: &BTreeSet<String>) {
    let mut kept = BTreeSet::new();
    for app_id in local {
        let response = auth::authed_request(
            reqwest::Method::POST,
            "/api/app-store/installations",
            Some(json!({ "appId": app_id, "scope": "user" })),
        )
        .await;
        match response {
            Ok(response)
                if response.status().is_success()
                    || response.status() == reqwest::StatusCode::CONFLICT
                    || response.status() == reqwest::StatusCode::NOT_FOUND => {}
            _ => {
                kept.insert(app_id.clone());
            }
        }
    }
    write_local_installs(&kept);
}

async fn load_assets(cx: &mut AsyncApp) {
    let Some((catalog, installed, known)) = cx.update(|cx| {
        cx.try_global::<AppStore>().and_then(|store| {
            store.catalog.clone().map(|catalog| {
                (
                    catalog,
                    store.installed_ids(),
                    store.thumbnails.keys().cloned().collect::<BTreeSet<_>>(),
                )
            })
        })
    }) else {
        return;
    };
    let server = auth::server_url();
    let mut wanted: Vec<(CatalogAsset, u32)> = Vec::new();
    for app in &catalog.apps {
        wanted.push((app.icon.clone(), ICON_THUMBNAIL));
        if installed.contains(&app.id) {
            for image in app.image_assets() {
                wanted.push((image.clone(), BACKGROUND_THUMBNAIL));
            }
        }
    }
    wanted.retain(|(asset, _)| !known.contains(&asset.sha256));
    if wanted.is_empty() {
        return;
    }
    let task = cx.update(|cx| {
        gpui_tokio::Tokio::spawn(cx, async move {
            let client = auth::api_client().ok()?;
            let mut loaded = Vec::new();
            for (asset, size) in wanted {
                if asset.bytes > MAX_ASSET_BYTES {
                    continue;
                }
                let Some(path) = asset_path(&asset) else {
                    continue;
                };
                if !path.is_file() {
                    let response = auth::apply_desktop_headers(client.get(asset_url(&server, &asset)))
                        .send()
                        .await;
                    let Ok(response) = response else { continue };
                    if !response.status().is_success() {
                        continue;
                    }
                    let Ok(bytes) = response.bytes().await else {
                        continue;
                    };
                    if let Err(error) = store_verified_asset(&path, &bytes, &asset.sha256) {
                        tracing::warn!(%error, sha256 = %asset.sha256, "Rejected an App Store asset");
                        continue;
                    }
                }
                let thumbnail = crate::editor_sidebar::decode_scaled_rgba(&path, size)
                    .map(crate::library::rgba_to_render_image);
                loaded.push((asset.sha256.clone(), path, thumbnail));
            }
            Some(loaded)
        })
    });
    let Ok(Some(loaded)) = task.await else {
        return;
    };
    cx.update(|cx| {
        cx.update_global::<AppStore, _>(|store, _| {
            for (sha256, path, thumbnail) in loaded {
                store.assets.insert(sha256.clone(), path);
                if let Some(thumbnail) = thumbnail {
                    store.thumbnails.insert(sha256, thumbnail);
                }
            }
        });
    });
}

#[derive(Debug, Clone, PartialEq)]
pub enum InstallOutcome {
    Installed,
    OpenedWeb,
}

pub fn install(app_id: String, cx: &mut App) -> Option<InstallOutcome> {
    let store = cx.try_global::<AppStore>()?;
    let app = store.catalog.as_deref()?.app(&app_id)?.clone();
    let signed_in = store::auth_snapshot().token.is_some();
    if app.needs_web_setup() || (app.connection.is_some() && !signed_in) {
        cx.open_url(&format!("{}/dashboard/apps/{}", auth::server_url(), app.id));
        return Some(InstallOutcome::OpenedWeb);
    }
    if !signed_in {
        let mut local = read_local_installs();
        local.insert(app.id.clone());
        write_local_installs(&local);
        cx.update_global::<AppStore, _>(|store, _| store.local_installs = local);
        refresh(cx);
        return Some(InstallOutcome::Installed);
    }
    cx.update_global::<AppStore, _>(|store, _| {
        store.pending.insert(app.id.clone());
    });
    let id = app.id.clone();
    cx.spawn(async move |cx: &mut AsyncApp| {
        let body = json!({ "appId": id, "scope": "user" });
        let task = cx.update(|cx| {
            gpui_tokio::Tokio::spawn(cx, async move {
                auth::authed_request(
                    reqwest::Method::POST,
                    "/api/app-store/installations",
                    Some(body),
                )
                .await
                .map(|response| response.status())
            })
        });
        let status = task.await.ok().and_then(Result::ok);
        if !status.is_some_and(|status| status.is_success() || status.as_u16() == 409) {
            tracing::warn!(?status, app = %id, "App Store install failed");
        }
        cx.update(|cx| {
            cx.update_global::<AppStore, _>(|store, _| {
                store.pending.remove(&id);
            });
            refresh(cx);
        });
    })
    .detach();
    Some(InstallOutcome::Installed)
}

pub fn uninstall(app_id: String, cx: &mut App) {
    let Some(store) = cx.try_global::<AppStore>() else {
        return;
    };
    let was_local = store.local_installs.contains(&app_id);
    let installation = store
        .account_installations()
        .iter()
        .find(|installation| {
            installation.app_id == app_id && installation.scope == "user" && installation.can_manage
        })
        .cloned();
    if was_local {
        let mut local = read_local_installs();
        local.remove(&app_id);
        write_local_installs(&local);
        cx.update_global::<AppStore, _>(|store, _| store.local_installs = local);
    }
    let Some(installation) = installation else {
        return;
    };
    cx.update_global::<AppStore, _>(|store, _| {
        store.pending.insert(app_id.clone());
    });
    cx.spawn(async move |cx: &mut AsyncApp| {
        let path = format!("/api/app-store/installations/{}", installation.id);
        let task = cx.update(|cx| {
            gpui_tokio::Tokio::spawn(cx, async move {
                auth::authed_request(reqwest::Method::DELETE, &path, None)
                    .await
                    .map(|response| response.status())
            })
        });
        let status = task.await.ok().and_then(Result::ok);
        if !status.is_some_and(|status| status.is_success()) {
            tracing::warn!(?status, app = %app_id, "App Store uninstall failed");
        }
        cx.update(|cx| {
            cx.update_global::<AppStore, _>(|store, _| {
                store.pending.remove(&app_id);
            });
            refresh(cx);
        });
    })
    .detach();
}

pub fn account_changed(cx: &mut App) {
    if !cx.has_global::<AppStore>() {
        return;
    }
    cx.update_global::<AppStore, _>(|store, _| {
        store.installations.clear();
        store.account = None;
        store.cap_actions.clear();
        store.cap_actions_pending.clear();
    });
    refresh(cx);
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerCapAction {
    installation_id: String,
    app_id: String,
    app_name: String,
    action_id: String,
    title: String,
}

#[derive(serde::Deserialize)]
struct ServerCapActions {
    actions: Vec<ServerCapAction>,
}

pub fn request_cap_actions(cap_ids: Vec<String>, cx: &mut App) {
    let Some(store) = cx.try_global::<AppStore>() else {
        return;
    };
    if !store.has_cap_actions() {
        return;
    }
    let wanted: Vec<String> = cap_ids
        .into_iter()
        .filter(|id| !store.cap_actions.contains_key(id) && !store.cap_actions_pending.contains(id))
        .collect();
    if wanted.is_empty() {
        return;
    }
    let icons: HashMap<String, String> = store
        .catalog
        .as_deref()
        .map(|catalog| {
            catalog
                .apps
                .iter()
                .map(|app| (app.id.clone(), app.icon.sha256.clone()))
                .collect()
        })
        .unwrap_or_default();
    cx.update_global::<AppStore, _>(|store, _| {
        store.cap_actions_pending.extend(wanted.iter().cloned());
    });
    cx.spawn(async move |cx: &mut AsyncApp| {
        let task = cx.update(|cx| {
            gpui_tokio::Tokio::spawn(cx, async move {
                let mut loaded = Vec::new();
                for cap_id in wanted {
                    let path = format!("/api/app-store/caps/{cap_id}/actions");
                    let actions =
                        match auth::authed_request(reqwest::Method::GET, &path, None).await {
                            Ok(response) if response.status().is_success() => response
                                .json::<ServerCapActions>()
                                .await
                                .map(|body| body.actions)
                                .unwrap_or_default(),
                            _ => Vec::new(),
                        };
                    loaded.push((cap_id, actions));
                }
                loaded
            })
        });
        let loaded = task.await.unwrap_or_default();
        cx.update(|cx| {
            cx.update_global::<AppStore, _>(|store, _| {
                for (cap_id, actions) in loaded {
                    store.cap_actions_pending.remove(&cap_id);
                    store.cap_actions.insert(
                        cap_id,
                        actions
                            .into_iter()
                            .map(|action| CapAction {
                                icon_sha256: icons.get(&action.app_id).cloned().unwrap_or_default(),
                                installation_id: action.installation_id,
                                app_id: action.app_id,
                                app_name: action.app_name,
                                action_id: action.action_id,
                                title: action.title,
                            })
                            .collect(),
                    );
                }
            });
        });
    })
    .detach();
}

pub async fn run_cap_action(action: CapAction, cap_id: String) -> Result<ActionResult, String> {
    let path = format!("/api/app-store/caps/{cap_id}/actions");
    let response = auth::authed_request(
        reqwest::Method::POST,
        &path,
        Some(json!({
            "installationId": action.installation_id,
            "actionId": action.action_id,
        })),
    )
    .await
    .map_err(|error| error.to_string())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The app could not complete this action")
            .to_string());
    }
    serde_json::from_value(body.get("result").cloned().unwrap_or(Value::Null))
        .map_err(|_| "The app sent a response Cap could not read".to_string())
}

#[cfg(test)]
mod tests;
