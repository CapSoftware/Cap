//! Wallpapers and music are downloaded the first time someone uses them
//! instead of shipping inside the app.
//!
//! Every file is pinned by size and sha256 (`assets/asset-manifest.json`,
//! written by `scripts/desktop-assets.mjs`) and lands in
//! [`cap_rendering::asset_paths::downloaded_assets_dir`]. People who had an
//! older app, which bundled them, get them back in the background on first
//! launch ([`start_restore`]), so nothing changes for them. A remote manifest
//! can add new wallpapers and tracks without an app update.

pub mod catalog;
mod fetch;
#[cfg(test)]
mod tests;
pub mod ui;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cap_project::{BackgroundSource, ProjectConfiguration};
use cap_rendering::asset_paths;
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, watch};

pub use catalog::{Catalog, Item};
pub use fetch::FetchError;

use crate::i18n::tr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Wallpaper,
    Music,
}

pub type Key = (Kind, &'static str);

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ItemStatus {
    Ready,
    /// Fraction received, 0..=1.
    Downloading(f32),
    Failed,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Summary {
    pub missing: usize,
    pub missing_bytes: u64,
    /// Missing entries that came from the remote manifest.
    pub new: usize,
    pub bulk: Option<BulkProgress>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BulkProgress {
    pub received: u64,
    pub total: u64,
    pub failed: usize,
    pub running: bool,
}

pub enum Begin {
    Ready(PathBuf),
    Waiting(oneshot::Receiver<Result<PathBuf, FetchError>>),
    Unknown,
}

const REMOTE_MANIFEST_URL: &str = "https://github.com/CapSoftware/transcription-models/releases/download/desktop-assets/manifest.json";
const REMOTE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const BULK_CONCURRENCY: usize = 3;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(50);

fn extension(kind: Kind) -> &'static str {
    match kind {
        Kind::Wallpaper => "jpg",
        Kind::Music => "mp3",
    }
}

fn kind_dir(kind: Kind) -> &'static str {
    match kind {
        Kind::Wallpaper => "backgrounds",
        Kind::Music => "music",
    }
}

fn is_file_of_size(path: &Path, size: u64) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() == size)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct Waiter {
    tx: oneshot::Sender<Result<PathBuf, FetchError>>,
    /// Someone is looking at it: a bulk cancel does not stop this download.
    interactive: bool,
}

struct Bulk {
    keys: Vec<Key>,
    cancel: Arc<AtomicBool>,
    failed: usize,
    running: bool,
}

#[derive(Default)]
struct Hub {
    ready: HashMap<Key, PathBuf>,
    missing: HashSet<Key>,
    progress: HashMap<Key, u64>,
    failed: HashMap<Key, FetchError>,
    waiters: HashMap<Key, Vec<Waiter>>,
    bulk: HashMap<Kind, Bulk>,
    restoring: bool,
}

/// Everything one download folder needs. The app has one ([`library`]);
/// tests make their own against a temporary folder and a local server.
pub struct Library {
    root: PathBuf,
    /// Folders that may already hold built-in files (an app bundle from
    /// before they were downloaded, a dev checkout). Thumbnails always come
    /// from here; full files only when `local_files` is set.
    local_dirs: HashMap<Kind, Vec<PathBuf>>,
    local_files: bool,
    remote_url: String,
    /// One extra origin remote entries may point at, for testing.
    dev_origin: Option<String>,
    catalog: RwLock<Arc<Catalog>>,
    hub: Mutex<Hub>,
    changed: watch::Sender<u64>,
    last_progress: Mutex<Option<Instant>>,
    runtime: OnceLock<tokio::runtime::Handle>,
}

fn default_local_dirs(kind: Kind) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if kind == Kind::Wallpaper
        && let Some(dir) = std::env::var_os("CAP_GPUI_WALLPAPERS_DIR").map(PathBuf::from)
    {
        dirs.push(dir);
    }
    let sub = Path::new("assets").join(kind_dir(kind));
    dirs.extend(
        crate::store::bundled_resource_dirs()
            .into_iter()
            .map(|dir| dir.join(&sub)),
    );
    #[cfg(target_os = "macos")]
    dirs.push(Path::new("/Applications/Cap.app/Contents/Resources").join(&sub));
    dirs.push(Path::new(env!("CARGO_MANIFEST_DIR")).join(&sub));
    dirs
}

static LIBRARY: LazyLock<Arc<Library>> = LazyLock::new(|| {
    Arc::new(Library::new(
        asset_paths::downloaded_assets_dir(),
        [Kind::Wallpaper, Kind::Music]
            .into_iter()
            .map(|kind| (kind, default_local_dirs(kind)))
            .collect(),
        // `CAP_ASSETS_NO_LOCAL=1` ignores built-in files found outside the
        // download folder, so a dev build behaves like a fresh install.
        std::env::var("CAP_ASSETS_NO_LOCAL").as_deref() != Ok("1"),
        std::env::var("CAP_ASSETS_MANIFEST_URL")
            .ok()
            .filter(|url| !url.is_empty())
            .unwrap_or_else(|| REMOTE_MANIFEST_URL.to_string()),
        std::env::var("CAP_ASSETS_DEV_ORIGIN")
            .ok()
            .filter(|origin| !origin.is_empty()),
        Catalog::builtin(),
    ))
});

pub fn library() -> &'static Arc<Library> {
    &LIBRARY
}

impl Library {
    pub fn new(
        root: PathBuf,
        local_dirs: HashMap<Kind, Vec<PathBuf>>,
        local_files: bool,
        remote_url: String,
        dev_origin: Option<String>,
        catalog: Catalog,
    ) -> Self {
        Self {
            root,
            local_dirs,
            local_files,
            remote_url,
            dev_origin,
            catalog: RwLock::new(Arc::new(catalog)),
            hub: Mutex::default(),
            changed: watch::channel(0).0,
            last_progress: Mutex::new(None),
            runtime: OnceLock::new(),
        }
    }

    pub fn catalog(&self) -> Arc<Catalog> {
        self.catalog
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn set_catalog(&self, catalog: Catalog) {
        *self
            .catalog
            .write()
            .unwrap_or_else(|error| error.into_inner()) = Arc::new(catalog);
        self.hub().missing.clear();
        self.notify();
    }

    fn hub(&self) -> MutexGuard<'_, Hub> {
        self.hub.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn notify(&self) {
        self.changed
            .send_modify(|version| *version = version.wrapping_add(1));
    }

    fn notify_progress(&self) {
        let mut last = self
            .last_progress
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let now = Instant::now();
        if last.is_none_or(|last| now.duration_since(last) >= PROGRESS_INTERVAL) {
            *last = Some(now);
            drop(last);
            self.notify();
        }
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    fn spawn<F>(&self, future: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        if let Some(handle) = self.runtime.get() {
            handle.spawn(future);
        } else if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(future);
        } else {
            tracing::error!("asset download requested before the runtime was set");
        }
    }

    // -- Paths --------------------------------------------------------------

    pub fn downloaded_path(&self, kind: Kind, id: &str) -> PathBuf {
        self.root
            .join(kind_dir(kind))
            .join(format!("{id}.{}", extension(kind)))
    }

    fn downloaded_thumbnail_path(&self, id: &str) -> PathBuf {
        self.root
            .join(kind_dir(Kind::Wallpaper))
            .join(format!("{id}-thumbnail.jpg"))
    }

    fn local_dirs(&self, kind: Kind) -> &[PathBuf] {
        self.local_dirs.get(&kind).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Where the item's file is right now, if anywhere.
    pub fn installed_path(&self, item: &Item) -> Option<PathBuf> {
        let downloaded = self.downloaded_path(item.kind, item.id);
        if is_file_of_size(&downloaded, item.file.size) {
            return Some(downloaded);
        }
        if !item.builtin || !self.local_files {
            return None;
        }
        let file = format!("{}.{}", item.id, extension(item.kind));
        self.local_dirs(item.kind)
            .iter()
            .map(|dir| dir.join(&file))
            .find(|path| is_file_of_size(path, item.file.size))
    }

    /// The small picture a wallpaper tile shows.
    pub fn thumbnail_path(&self, id: &str) -> Option<PathBuf> {
        let item = self.catalog().item(Kind::Wallpaper, id)?;
        if let Some(thumbnail) = &item.thumbnail {
            let path = self.downloaded_thumbnail_path(item.id);
            return is_file_of_size(&path, thumbnail.size).then_some(path);
        }
        let file = format!("{id}-thumbnail.jpg");
        self.local_dirs(Kind::Wallpaper)
            .iter()
            .map(|dir| dir.join(&file))
            .find(|path| path.is_file())
            .or_else(|| self.installed_path(&item))
    }

    // -- Status -------------------------------------------------------------

    fn status_of(&self, hub: &mut Hub, item: &Item) -> ItemStatus {
        let key = (item.kind, item.id);
        if let Some(received) = hub.progress.get(&key) {
            return ItemStatus::Downloading(
                (*received as f64 / item.file.size.max(1) as f64).clamp(0., 1.) as f32,
            );
        }
        if hub.ready.contains_key(&key) {
            return ItemStatus::Ready;
        }
        if hub.failed.contains_key(&key) {
            return ItemStatus::Failed;
        }
        if hub.missing.contains(&key) {
            return ItemStatus::Missing;
        }
        match self.installed_path(item) {
            Some(path) => {
                hub.ready.insert(key, path);
                ItemStatus::Ready
            }
            None => {
                hub.missing.insert(key);
                ItemStatus::Missing
            }
        }
    }

    pub fn status(&self, kind: Kind, id: &str) -> ItemStatus {
        let Some(item) = self.catalog().item(kind, id) else {
            return ItemStatus::Missing;
        };
        self.status_of(&mut self.hub(), &item)
    }

    pub fn offers_downloads(&self) -> bool {
        !self.hub().restoring
    }

    pub fn summary(&self, kind: Kind) -> Summary {
        let catalog = self.catalog();
        let mut hub = self.hub();
        let mut summary = Summary::default();
        let mut sizes = HashMap::new();
        for item in catalog.items(kind) {
            sizes.insert(item.id, item.file.size);
            if !matches!(self.status_of(&mut hub, &item), ItemStatus::Ready) {
                summary.missing += 1;
                summary.missing_bytes += item.file.size;
                if !item.builtin {
                    summary.new += 1;
                }
            }
        }
        if let Some(bulk) = hub.bulk.get(&kind) {
            let mut progress = BulkProgress {
                received: 0,
                total: 0,
                failed: bulk.failed,
                running: bulk.running,
            };
            for key in &bulk.keys {
                let size = sizes.get(key.1).copied().unwrap_or_default();
                progress.total += size;
                progress.received += if hub.ready.contains_key(key) {
                    size
                } else {
                    hub.progress.get(key).copied().unwrap_or_default().min(size)
                };
            }
            summary.bulk = Some(progress);
        }
        summary
    }

    // -- Downloads ----------------------------------------------------------

    /// Starts `id` downloading unless it is already here or on its way.
    pub fn begin(self: &Arc<Self>, kind: Kind, id: &str) -> Begin {
        self.begin_with(kind, id, None, true)
    }

    fn begin_with(
        self: &Arc<Self>,
        kind: Kind,
        id: &str,
        cancel: Option<Arc<AtomicBool>>,
        interactive: bool,
    ) -> Begin {
        let Some(item) = self.catalog().item(kind, id) else {
            return Begin::Unknown;
        };
        let key = (item.kind, item.id);
        let mut hub = self.hub();
        if let Some(path) = hub.ready.get(&key).cloned() {
            if is_file_of_size(&path, item.file.size) {
                return Begin::Ready(path);
            }
            hub.ready.remove(&key);
        }
        let in_flight = hub.progress.contains_key(&key);
        if !in_flight && let Some(path) = self.installed_path(&item) {
            hub.ready.insert(key, path.clone());
            hub.missing.remove(&key);
            return Begin::Ready(path);
        }
        let (tx, rx) = oneshot::channel();
        hub.waiters
            .entry(key)
            .or_default()
            .push(Waiter { tx, interactive });
        if !in_flight {
            hub.progress.insert(key, 0);
            hub.failed.remove(&key);
            hub.missing.remove(&key);
            drop(hub);
            self.notify();
            self.spawn(self.clone().run_download(item, cancel));
        }
        Begin::Waiting(rx)
    }

    /// [`Self::begin`], awaited.
    pub async fn ensure(self: &Arc<Self>, kind: Kind, id: &str) -> Result<PathBuf, FetchError> {
        match self.begin(kind, id) {
            Begin::Ready(path) => Ok(path),
            Begin::Waiting(rx) => rx.await.unwrap_or(Err(FetchError::Cancelled)),
            Begin::Unknown => Err(FetchError::Http(404)),
        }
    }

    async fn run_download(self: Arc<Self>, item: Arc<Item>, cancel: Option<Arc<AtomicBool>>) {
        let key = (item.kind, item.id);
        let destination = self.downloaded_path(item.kind, item.id);
        let cancelled = {
            let this = self.clone();
            move || {
                cancel
                    .as_ref()
                    .is_some_and(|cancel| cancel.load(Ordering::Acquire))
                    && !this
                        .hub()
                        .waiters
                        .get(&key)
                        .is_some_and(|waiters| waiters.iter().any(|waiter| waiter.interactive))
            }
        };
        let mut on_progress = {
            let this = self.clone();
            move |received: u64| {
                if let Some(entry) = this.hub().progress.get_mut(&key) {
                    *entry = received;
                }
                this.notify_progress();
            }
        };
        let result =
            fetch::fetch_with_retries(&item.file, &destination, &cancelled, &mut on_progress).await;
        match &result {
            Ok(()) => tracing::info!(id = item.id, "asset downloaded"),
            Err(error) => tracing::warn!(id = item.id, ?error, "asset download failed"),
        }
        let waiters = {
            let mut hub = self.hub();
            hub.progress.remove(&key);
            match &result {
                Ok(()) => {
                    hub.ready.insert(key, destination.clone());
                    hub.missing.remove(&key);
                    hub.failed.remove(&key);
                }
                Err(FetchError::Cancelled) => {}
                Err(error) => {
                    hub.failed.insert(key, error.clone());
                }
            }
            hub.waiters.remove(&key).unwrap_or_default()
        };
        if result.is_ok() {
            asset_paths::bump_asset_generation();
        }
        for waiter in waiters {
            let _ = waiter.tx.send(result.clone().map(|()| destination.clone()));
        }
        self.notify();
    }

    /// Downloads every missing item of `kind`, a few at a time.
    pub fn download_all(self: &Arc<Self>, kind: Kind) {
        let catalog = self.catalog();
        let keys: Vec<Key> = {
            let mut hub = self.hub();
            if hub.bulk.get(&kind).is_some_and(|bulk| bulk.running) {
                return;
            }
            catalog
                .items(kind)
                .filter(|item| !matches!(self.status_of(&mut hub, item), ItemStatus::Ready))
                .map(|item| (item.kind, item.id))
                .collect()
        };
        if keys.is_empty() {
            self.hub().bulk.remove(&kind);
            self.notify();
            return;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        self.hub().bulk.insert(
            kind,
            Bulk {
                keys: keys.clone(),
                cancel: cancel.clone(),
                failed: 0,
                running: true,
            },
        );
        self.notify();
        let this = self.clone();
        self.spawn(async move {
            let failed = Arc::new(AtomicUsize::new(0));
            futures_util::stream::iter(keys)
                .for_each_concurrent(BULK_CONCURRENCY, |(kind, id)| {
                    let (this, cancel, failed) = (this.clone(), cancel.clone(), failed.clone());
                    async move {
                        if this.fetch_unless(kind, id, &cancel).await.is_err() {
                            failed.fetch_add(1, Ordering::AcqRel);
                        }
                    }
                })
                .await;
            let failed = failed.load(Ordering::Acquire);
            let mut hub = this.hub();
            if let Some(bulk) = hub.bulk.get_mut(&kind)
                && Arc::ptr_eq(&bulk.cancel, &cancel)
            {
                if failed == 0 || cancel.load(Ordering::Acquire) {
                    hub.bulk.remove(&kind);
                } else {
                    bulk.running = false;
                    bulk.failed = failed;
                }
            }
            drop(hub);
            this.notify();
        });
    }

    /// One item for a batch: `Ok` when it is here or the batch was
    /// cancelled. A transfer that an earlier, cancelled batch started is
    /// joined, comes back `Cancelled` and is started again.
    async fn fetch_unless(
        self: &Arc<Self>,
        kind: Kind,
        id: &'static str,
        cancel: &Arc<AtomicBool>,
    ) -> Result<(), FetchError> {
        loop {
            if cancel.load(Ordering::Acquire) {
                return Ok(());
            }
            let result = match self.begin_with(kind, id, Some(cancel.clone()), false) {
                Begin::Ready(_) | Begin::Unknown => return Ok(()),
                Begin::Waiting(rx) => rx.await.unwrap_or(Err(FetchError::Cancelled)),
            };
            match result {
                Ok(_) => return Ok(()),
                Err(FetchError::Cancelled) => continue,
                Err(error) => return Err(error),
            }
        }
    }

    pub fn cancel_all(&self, kind: Kind) {
        if let Some(bulk) = self.hub().bulk.remove(&kind) {
            bulk.cancel.store(true, Ordering::Release);
        }
        self.notify();
    }

    /// Clears a failed bulk so the section offers a fresh download.
    pub fn dismiss_failures(&self, kind: Kind) {
        let catalog = self.catalog();
        let mut hub = self.hub();
        if hub.bulk.get(&kind).is_some_and(|bulk| !bulk.running) {
            hub.bulk.remove(&kind);
        }
        for item in catalog.items(kind) {
            hub.failed.remove(&(item.kind, item.id));
        }
        drop(hub);
        self.notify();
    }

    // -- Projects -----------------------------------------------------------

    /// A wallpaper `source` names that is not on disk: `Ok(id)` for one in
    /// the catalogue, `Err(tail)` for a catalogue-shaped path this catalogue
    /// does not list (yet). `None` when it is here or is not a catalogue
    /// wallpaper at all.
    fn missing_wallpaper(&self, source: &BackgroundSource) -> Option<Result<&'static str, String>> {
        let BackgroundSource::Wallpaper { path: Some(path) } = source else {
            return None;
        };
        cap_rendering::clean_background_path(path)
            .is_none()
            .then_some(())?;
        let tail = asset_paths::catalogue_wallpaper_tail(path)?;
        let id = tail.strip_suffix(".jpg")?;
        Some(match self.catalog().item(Kind::Wallpaper, id) {
            Some(item) => Ok(item.id),
            None => Err(tail),
        })
    }

    /// Every wallpaper a render of `project` can draw that is not on disk:
    /// its background's and its style sections'.
    pub fn missing_project_wallpapers(
        &self,
        project: &ProjectConfiguration,
    ) -> Vec<Result<&'static str, String>> {
        let mut missing = Vec::new();
        for source in background_sources(project) {
            if let Some(wallpaper) = self.missing_wallpaper(source)
                && !missing.contains(&wallpaper)
            {
                missing.push(wallpaper);
            }
        }
        missing
    }

    // -- State file ---------------------------------------------------------

    fn state_path(&self) -> PathBuf {
        self.root.join("state.json")
    }

    fn load_state(&self) -> Option<State> {
        serde_json::from_slice(&std::fs::read(self.state_path()).ok()?).ok()
    }

    fn update_state(&self, mutate: impl FnOnce(&mut State)) {
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let mut state = self.load_state().unwrap_or(State {
            restore: Restore::Done,
            remote_checked_at: 0,
        });
        mutate(&mut state);
        let path = self.state_path();
        let staging = fetch::staging_path(&path);
        let result = std::fs::create_dir_all(&self.root)
            .and_then(|()| {
                serde_json::to_vec(&state)
                    .map_err(std::io::Error::other)
                    .and_then(|bytes| std::fs::write(&staging, bytes))
            })
            .and_then(|()| std::fs::rename(&staging, &path));
        if let Err(error) = result {
            let _ = std::fs::remove_file(&staging);
            tracing::warn!(?error, "could not save the asset state");
        }
    }

    /// The first launch of this version decides: someone who already
    /// finished onboarding had the bundled files, so theirs are restored.
    fn decide_restore(&self, existing_user: bool) {
        if self.load_state().is_none() {
            self.update_state(|state| {
                state.restore = if existing_user {
                    Restore::Pending
                } else {
                    Restore::Done
                };
            });
        }
    }

    fn restore_pending(&self) -> bool {
        self.load_state()
            .is_some_and(|state| state.restore == Restore::Pending)
    }

    fn remove_stale_staging_files(&self, older_than: Duration) {
        let cutoff = SystemTime::now()
            .checked_sub(older_than)
            .unwrap_or(UNIX_EPOCH);
        let mut dirs = vec![self.root.clone(), self.root.join(kind_dir(Kind::Music))];
        let backgrounds = self.root.join(kind_dir(Kind::Wallpaper));
        if let Ok(entries) = std::fs::read_dir(&backgrounds) {
            dirs.push(backgrounds.clone());
            dirs.extend(
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.is_dir()),
            );
        }
        for dir in dirs {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let stale = entry
                    .file_name()
                    .to_str()
                    .is_some_and(fetch::is_staging_name)
                    && entry
                        .metadata()
                        .and_then(|metadata| metadata.modified())
                        .is_ok_and(|modified| modified <= cutoff);
                if stale {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }

    // -- Remote catalogue ---------------------------------------------------

    fn load_cached_remote(&self) {
        let Ok(bytes) = std::fs::read(self.root.join("remote-manifest.json")) else {
            return;
        };
        match Catalog::with_remote_from(&bytes, self.dev_origin.as_deref()) {
            Ok(catalog) => self.set_catalog(catalog),
            Err(error) => tracing::warn!(error, "ignoring the cached remote asset manifest"),
        }
    }

    /// Fetches the remote manifest at most every six hours. New thumbnails
    /// come down with it, so new wallpapers show up in the grid straight away.
    pub async fn refresh_remote(self: &Arc<Self>, force: bool) {
        let checked_at = self
            .load_state()
            .map(|state| state.remote_checked_at)
            .unwrap_or(0);
        if !force && now_secs().saturating_sub(checked_at) < REMOTE_CHECK_INTERVAL.as_secs() {
            self.fetch_missing_thumbnails().await;
            return;
        }
        let Some(bytes) = fetch_manifest(&self.remote_url).await else {
            self.fetch_missing_thumbnails().await;
            return;
        };
        self.update_state(|state| state.remote_checked_at = now_secs());
        let Some(bytes) = bytes else {
            return;
        };
        let catalog = match Catalog::with_remote_from(&bytes, self.dev_origin.as_deref()) {
            Ok(catalog) => catalog,
            Err(error) => {
                tracing::warn!(error, "ignoring the remote asset manifest");
                return;
            }
        };
        let path = self.root.join("remote-manifest.json");
        let staging = fetch::staging_path(&path);
        if std::fs::create_dir_all(&self.root)
            .and_then(|()| std::fs::write(&staging, &bytes))
            .and_then(|()| std::fs::rename(&staging, &path))
            .is_err()
        {
            let _ = std::fs::remove_file(&staging);
        }
        self.set_catalog(catalog);
        self.fetch_missing_thumbnails().await;
    }

    /// The thumbnails remote wallpapers need that are not on disk yet.
    async fn fetch_missing_thumbnails(&self) {
        let thumbnails: Vec<(&'static str, catalog::FileRef)> = self
            .catalog()
            .items(Kind::Wallpaper)
            .filter_map(|item| Some((item.id, item.thumbnail.clone()?)))
            .collect();
        for (id, thumbnail) in thumbnails {
            let path = self.downloaded_thumbnail_path(id);
            if is_file_of_size(&path, thumbnail.size) {
                continue;
            }
            if fetch::fetch_with_retries(&thumbnail, &path, &|| false, &mut |_| {})
                .await
                .is_ok()
            {
                self.notify();
            }
        }
    }
}

/// `Some(None)` is a 404: there is no remote manifest, which is fine.
async fn fetch_manifest(url: &str) -> Option<Option<Vec<u8>>> {
    let response = fetch::HTTP
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .ok()?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Some(None);
    }
    if !response.status().is_success() {
        return None;
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        body.extend_from_slice(&chunk.ok()?);
        if body.len() > catalog::MAX_MANIFEST_BYTES {
            return None;
        }
    }
    Some(Some(body))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Restore {
    Pending,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    restore: Restore,
    #[serde(default)]
    remote_checked_at: u64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// The app's library
// ---------------------------------------------------------------------------

pub fn downloaded_path(kind: Kind, id: &str) -> PathBuf {
    library().downloaded_path(kind, id)
}

pub fn thumbnail_path(id: &str) -> Option<PathBuf> {
    library().thumbnail_path(id)
}

pub fn status(kind: Kind, id: &str) -> ItemStatus {
    library().status(kind, id)
}

/// Whether the sections offer downloads. While an existing user's files are
/// being restored they do not: those people had them all along.
pub fn offers_downloads() -> bool {
    library().offers_downloads()
}

pub fn summary(kind: Kind) -> Summary {
    library().summary(kind)
}

pub fn begin(kind: Kind, id: &str) -> Begin {
    library().begin(kind, id)
}

pub async fn ensure(kind: Kind, id: &str) -> Result<PathBuf, FetchError> {
    library().ensure(kind, id).await
}

pub fn download_all(kind: Kind) {
    library().download_all(kind);
}

pub fn cancel_all(kind: Kind) {
    library().cancel_all(kind);
}

pub fn dismiss_failures(kind: Kind) {
    library().dismiss_failures(kind);
}

/// Fires after anything changes: a download starts, moves, lands or fails,
/// or the catalogue grows. Progress is throttled to 20 per second.
pub fn subscribe() -> watch::Receiver<u64> {
    library().subscribe()
}

pub fn error_message(error: &FetchError) -> String {
    match error {
        FetchError::Offline | FetchError::Timeout => tr::assets::error::offline().to_string(),
        FetchError::NoSpace => tr::assets::error::no_space().to_string(),
        FetchError::Disk(_) => tr::assets::error::disk().to_string(),
        FetchError::Http(_) | FetchError::Corrupt | FetchError::Cancelled => {
            tr::assets::error::failed().to_string()
        }
    }
}

/// The background and every enabled style section's, the sources a render
/// of `project` can draw.
fn background_sources(project: &ProjectConfiguration) -> impl Iterator<Item = &BackgroundSource> {
    std::iter::once(&project.background.source).chain(
        project
            .timeline
            .iter()
            .flat_map(|timeline| &timeline.style_segments)
            .filter(|segment| segment.enabled)
            .filter_map(|segment| segment.overrides.background.as_ref())
            .map(|background| &background.source),
    )
}

fn background_sources_mut(
    project: &mut ProjectConfiguration,
) -> impl Iterator<Item = &mut BackgroundSource> {
    std::iter::once(&mut project.background.source).chain(
        project
            .timeline
            .iter_mut()
            .flat_map(|timeline| &mut timeline.style_segments)
            .filter(|segment| segment.enabled)
            .filter_map(|segment| segment.overrides.background.as_mut())
            .map(|background| &mut background.source),
    )
}

/// How many wallpapers a render of `project` would miss right now.
pub fn missing_wallpaper_count(project: &ProjectConfiguration) -> usize {
    library().missing_project_wallpapers(project).len()
}

/// What the editor preview renders instead of `config` while its wallpaper
/// is still on the way: the bundled thumbnail, which sharpens into the real
/// picture when the download lands. Starts the download if nothing has.
/// Only ever applied to the copy sent to a preview renderer, never to a
/// saved or exported project. Returns how many wallpapers were missing,
/// so a caller can republish as each one lands.
pub fn apply_preview_placeholder(config: &mut ProjectConfiguration) -> usize {
    let library = library();
    let mut stood_in = 0;
    for source in background_sources_mut(config) {
        let Some(missing) = library.missing_wallpaper(source) else {
            continue;
        };
        stood_in += 1;
        let Ok(id) = missing else {
            continue;
        };
        if library.status(Kind::Wallpaper, id) == ItemStatus::Missing {
            let _ = library.begin(Kind::Wallpaper, id);
        }
        if let Some(thumbnail) = library.thumbnail_path(id)
            && thumbnail.to_string_lossy().ends_with("-thumbnail.jpg")
        {
            *source = BackgroundSource::Wallpaper {
                path: Some(thumbnail.to_string_lossy().into_owned()),
            };
        }
    }
    stood_in
}

/// Makes sure the wallpapers a render of `project` needs are on disk. An
/// export fails here rather than quietly rendering a white background. A
/// wallpaper this catalogue does not list (added remotely, on another
/// machine) refreshes the catalogue first; one that is still unknown renders
/// as it always has. `cancel` stops the wait, not a shared download.
pub async fn ensure_for_project(
    project: &ProjectConfiguration,
    cancel: Option<&AtomicBool>,
) -> Result<(), String> {
    let library = library().clone();
    let mut missing = library.missing_project_wallpapers(project);
    if missing.iter().any(Result::is_err) {
        let (tx, rx) = oneshot::channel();
        let remote = library.clone();
        library.spawn(async move {
            remote.refresh_remote(true).await;
            let _ = tx.send(());
        });
        let _ = rx.await;
        missing = library.missing_project_wallpapers(project);
    }
    for wallpaper in missing {
        let id = match wallpaper {
            Ok(id) => id,
            Err(tail) => {
                tracing::warn!(tail, "a wallpaper this catalogue does not list is missing");
                continue;
            }
        };
        tracing::info!(id, "downloading a project wallpaper before rendering");
        let result = match library.begin(Kind::Wallpaper, id) {
            Begin::Ready(_) | Begin::Unknown => Ok(()),
            Begin::Waiting(rx) => wait_unless_cancelled(rx, cancel).await,
        };
        result.map_err(|error| {
            format!(
                "{} {}",
                tr::assets::error::background(),
                error_message(&error)
            )
        })?;
    }
    Ok(())
}

/// `rx`, or `Cancelled` as soon as `cancel` is set. Polling the flag needs
/// a tokio timer, so a caller without one passes `None`.
async fn wait_unless_cancelled(
    mut rx: oneshot::Receiver<Result<PathBuf, FetchError>>,
    cancel: Option<&AtomicBool>,
) -> Result<(), FetchError> {
    let Some(cancel) = cancel else {
        return rx.await.unwrap_or(Err(FetchError::Cancelled)).map(|_| ());
    };
    loop {
        let tick = std::pin::pin!(tokio::time::sleep(Duration::from_millis(100)));
        match futures_util::future::select(&mut rx, tick).await {
            futures_util::future::Either::Left((result, _)) => {
                return result.unwrap_or(Err(FetchError::Cancelled)).map(|_| ());
            }
            futures_util::future::Either::Right(_) if cancel.load(Ordering::Acquire) => {
                return Err(FetchError::Cancelled);
            }
            futures_util::future::Either::Right(_) => {}
        }
    }
}

/// Calls `on_change` on the view after each [`subscribe`] notification, for
/// as long as the returned task is kept.
pub fn watch<T: 'static>(
    window: &mut gpui::Window,
    cx: &mut gpui::Context<T>,
    on_change: fn(&mut T, &mut gpui::Window, &mut gpui::Context<T>),
) -> gpui::Task<()> {
    let mut changes = subscribe();
    cx.spawn_in(window, async move |this, cx| {
        while changes.changed().await.is_ok() {
            if this.update_in(cx, on_change).is_err() {
                break;
            }
        }
    })
}

/// Called once at startup, before onboarding can mark a new user as done.
pub fn init(runtime: tokio::runtime::Handle) {
    let library = library();
    let _ = library.runtime.set(runtime);
    asset_paths::register_wallpaper_dir(library.root.join(kind_dir(Kind::Wallpaper)));
    if library.local_files {
        for dir in library.local_dirs(Kind::Wallpaper) {
            asset_paths::register_wallpaper_dir(dir.clone());
        }
    }
    library.decide_restore(crate::store::has_completed_startup());
    library.load_cached_remote();
    std::thread::Builder::new()
        .name("asset-cleanup".into())
        .spawn(|| LIBRARY.remove_stale_staging_files(Duration::from_secs(10 * 60)))
        .ok();
}

/// For someone updating from an app that bundled every wallpaper and track:
/// fetch them all, one at a time, never while a recording runs. Until it
/// finishes the sections do not offer downloads; a click on something not
/// back yet fetches it first.
pub fn start_restore(cx: &mut gpui::App) {
    let library = library().clone();
    let pending = library.restore_pending();
    if pending {
        library.hub().restoring = true;
    }
    cx.spawn(async move |cx| {
        let executor = cx.background_executor().clone();
        executor.timer(Duration::from_secs(3)).await;
        if pending {
            let app = cx.clone();
            let recording = move || {
                app.update(|cx| {
                    crate::session::RecordingSession::active_project_dir_in(cx).is_some()
                })
            };
            restore(&library, recording, |delay| executor.timer(delay)).await;
        }
        let remote = library.clone();
        library.spawn(async move { remote.refresh_remote(false).await });
    })
    .detach();
}

async fn restore<Pause: std::future::Future>(
    library: &Arc<Library>,
    recording: impl Fn() -> bool,
    pause: impl Fn(Duration) -> Pause,
) {
    let catalog = library.catalog();
    let keys: Vec<Key> = catalog
        .items(Kind::Wallpaper)
        .chain(catalog.items(Kind::Music))
        .filter(|item| item.builtin)
        .map(|item| (item.kind, item.id))
        .collect();
    let mut all_ready = true;
    let mut offline_in_a_row = 0;
    for (kind, id) in keys {
        while recording() {
            pause(Duration::from_secs(5)).await;
        }
        let never = Arc::new(AtomicBool::new(false));
        let result = library.fetch_unless(kind, id, &never).await;
        match result {
            Ok(()) => offline_in_a_row = 0,
            Err(error) => {
                all_ready = false;
                if matches!(error, FetchError::Offline | FetchError::Timeout) {
                    offline_in_a_row += 1;
                }
                // No connection: stop for now rather than wait out every
                // file's retries. The next launch picks it up again.
                if offline_in_a_row >= 3 {
                    break;
                }
            }
        }
    }
    if all_ready {
        library.update_state(|state| state.restore = Restore::Done);
        tracing::info!("restored bundled wallpapers and music");
    } else {
        tracing::warn!("asset restore incomplete; retrying next launch");
    }
    library.hub().restoring = false;
    library.notify();
}
