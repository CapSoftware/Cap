//! The desktop side of the App Store. The catalog is built from
//! `app-store/apps` in the repo and served by the web app; installs belong to
//! the account, with a local list for people who are signed out. Apps never
//! ship UI: this module turns what they declare into data the editor, the
//! settings window and the recording cards draw with Cap's own components.

pub mod catalog;
pub mod settings_page;

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{App, AsyncApp, Global, RenderImage};
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

/// One action an installed connection offers on a Cap.
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

/// Writes `bytes` to `target` only when they hash to `expected`, through a
/// temporary file so a crash never leaves a half-written asset in place.
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
        let mut state = AppStore {
            catalog,
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

    pub fn installed_ids(&self) -> BTreeSet<String> {
        let mut ids: BTreeSet<String> = self
            .installations
            .iter()
            .filter(|installation| installation.is_active())
            .map(|installation| installation.app_id.clone())
            .collect();
        ids.extend(self.local_installs.iter().cloned());
        ids
    }

    pub fn is_installed(&self, app_id: &str) -> bool {
        self.local_installs.contains(app_id)
            || self
                .installations
                .iter()
                .any(|installation| installation.app_id == app_id)
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

    /// Backgrounds from installed apps that can be used right now: images
    /// only once their file is on disk and verified.
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

    pub fn cap_actions(&self) -> Vec<CapAction> {
        let Some(catalog) = self.catalog.as_deref() else {
            return Vec::new();
        };
        let mut actions = Vec::new();
        for installation in self.installations.iter().filter(|i| i.is_active()) {
            let Some(app) = catalog.app(&installation.app_id) else {
                continue;
            };
            let Some(connection) = &app.connection else {
                continue;
            };
            for action in &connection.actions {
                actions.push(CapAction {
                    installation_id: installation.id.clone(),
                    app_id: app.id.clone(),
                    app_name: app.name.clone(),
                    action_id: action.id.clone(),
                    title: action.title.clone(),
                    icon_sha256: app.icon.sha256.clone(),
                });
            }
        }
        actions.sort_by(|a, b| a.title.cmp(&b.title));
        actions.dedup_by(|a, b| a.app_id == b.app_id && a.action_id == b.action_id);
        actions
    }
}

/// An owned copy of what a view needs, so it can render with a mutable
/// context while the global stays untouched.
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
            installations: self.installations.clone(),
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

/// Refreshes when the last sync is older than [`REFRESH_INTERVAL`], so every
/// window can ask on open without the store hammering the server.
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
        let Ok(task) = cx.update(|cx| gpui_tokio::Tokio::spawn(cx, sync(local))) else {
            return;
        };
        let result = task.await.unwrap_or(SyncResult {
            catalog: None,
            installations: None,
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
                }
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
        if applied.unwrap_or(false) {
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
    let mut installations = None;
    if signed_in {
        if !local.is_empty() {
            adopt_local_installs(&local).await;
        }
        match fetch_installations().await {
            Ok(list) => installations = Some(list),
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

/// Content apps installed while signed out move onto the account the first
/// time Cap syncs signed in, so they follow the person to every device.
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

/// Downloads every asset installed apps need, plus every catalog icon, and
/// decodes thumbnails off the main thread.
async fn load_assets(cx: &mut AsyncApp) {
    let Ok(Some((catalog, installed, known))) = cx.update(|cx| {
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
    let Ok(task) = cx.update(|cx| {
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
    }) else {
        return;
    };
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
    })
    .ok();
}

#[derive(Debug, Clone, PartialEq)]
pub enum InstallOutcome {
    Installed,
    OpenedWeb,
    Failed(String),
}

/// Installs for the signed-in account, or into the local list when signed
/// out. Apps that need settings or an outside account are set up on the web,
/// where Cap draws their settings form.
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
        let Ok(task) = cx.update(|cx| {
            gpui_tokio::Tokio::spawn(cx, async move {
                auth::authed_request(
                    reqwest::Method::POST,
                    "/api/app-store/installations",
                    Some(body),
                )
                .await
                .map(|response| response.status())
            })
        }) else {
            return;
        };
        let status = task.await.ok().and_then(Result::ok);
        if !status.is_some_and(|status| status.is_success() || status.as_u16() == 409) {
            tracing::warn!(?status, app = %id, "App Store install failed");
        }
        cx.update(|cx| {
            cx.update_global::<AppStore, _>(|store, _| {
                store.pending.remove(&id);
            });
            refresh(cx);
        })
        .ok();
    })
    .detach();
    Some(InstallOutcome::Installed)
}

/// Removes the person's own install. Installs made for an organization are
/// managed by its owners and admins on the web.
pub fn uninstall(app_id: String, cx: &mut App) {
    let Some(store) = cx.try_global::<AppStore>() else {
        return;
    };
    let was_local = store.local_installs.contains(&app_id);
    let installation = store
        .installations
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
        let Ok(task) = cx.update(|cx| {
            gpui_tokio::Tokio::spawn(cx, async move {
                auth::authed_request(reqwest::Method::DELETE, &path, None)
                    .await
                    .map(|response| response.status())
            })
        }) else {
            return;
        };
        let status = task.await.ok().and_then(Result::ok);
        if !status.is_some_and(|status| status.is_success()) {
            tracing::warn!(?status, app = %app_id, "App Store uninstall failed");
        }
        cx.update(|cx| {
            cx.update_global::<AppStore, _>(|store, _| {
                store.pending.remove(&app_id);
            });
            refresh(cx);
        })
        .ok();
    })
    .detach();
}

/// Runs a connection's action on an uploaded Cap and returns what the app
/// asked Cap to show.
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
