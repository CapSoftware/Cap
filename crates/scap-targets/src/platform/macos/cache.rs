use std::{
    collections::HashMap,
    sync::{OnceLock, RwLock},
    time::Instant,
};

use cidre::{arc, ns, sc};
use core_graphics::{display::CGDirectDisplayID, window::CGWindowID};
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};
use tracing::{debug, info, trace};

#[derive(Default)]
struct CacheState {
    cache: RwLock<Option<ShareableContentCache>>,
    warmup: Mutex<Option<WarmupTask>>,
}

#[derive(Clone)]
struct WarmupTask {
    notify: Arc<Notify>,
    result: Arc<Mutex<Option<Result<(), arc::R<ns::Error>>>>>,
}

static STATE: OnceLock<CacheState> = OnceLock::new();

fn state() -> &'static CacheState {
    STATE.get_or_init(CacheState::default)
}

pub(super) async fn prewarm_shareable_content() -> Result<(), arc::R<ns::Error>> {
    if state().cache.read().unwrap().is_some() {
        trace!("ScreenCaptureKit shareable content already warmed");
        return Ok(());
    }

    let warmup = {
        let mut guard = state().warmup.lock().await;
        if let Some(task) = guard.clone() {
            trace!("Awaiting in-flight ScreenCaptureKit warmup");
            task
        } else {
            let task = WarmupTask {
                notify: Arc::new(Notify::new()),
                result: Arc::new(Mutex::new(None)),
            };
            *guard = Some(task.clone());
            tokio::spawn(run_warmup(task.clone()));
            task
        }
    };

    warmup.notify.notified().await;
    let result = warmup
        .result
        .lock()
        .await
        .clone()
        .expect("ScreenCaptureKit warmup task missing result");

    result
}

async fn run_warmup(task: WarmupTask) {
    let result = async {
        let warm_start = Instant::now();
        debug!("Populating ScreenCaptureKit shareable content cache");

        let content = sc::ShareableContent::current().await?;
        let cache = ShareableContentCache::new(content);
        let elapsed_ms = warm_start.elapsed().as_micros() as f64 / 1000.0;

        let mut guard = state().cache.write().unwrap();
        let replaced = guard.is_some();
        *guard = Some(cache);

        info!(
            elapsed_ms,
            replaced, "ScreenCaptureKit shareable content cache populated"
        );
        Ok::<(), arc::R<ns::Error>>(())
    }
    .await;

    {
        let mut res_guard = task.result.lock().await;
        *res_guard = Some(result);
    }

    task.notify.notify_waiters();

    let mut guard = state().warmup.lock().await;
    if let Some(current) = guard.as_ref() {
        if Arc::ptr_eq(&current.notify, &task.notify) {
            *guard = None;
        }
    }
}

pub(super) async fn get_display(
    id: CGDirectDisplayID,
) -> Result<Option<arc::R<sc::Display>>, arc::R<ns::Error>> {
    let lookup_start = Instant::now();

    if let Some(display) = state()
        .cache
        .read()
        .unwrap()
        .as_ref()
        .and_then(|cache| cache.display(id))
    {
        trace!(
            display_id = id,
            elapsed_ms = lookup_start.elapsed().as_micros() as f64 / 1000.0,
            "Resolved ScreenCaptureKit display from warmed cache"
        );
        return Ok(Some(display));
    }

    prewarm_shareable_content().await?;

    let result = state()
        .cache
        .read()
        .unwrap()
        .as_ref()
        .and_then(|cache| cache.display(id));
    trace!(
        display_id = id,
        elapsed_ms = lookup_start.elapsed().as_micros() as f64 / 1000.0,
        cache_hit = result.is_some(),
        "Resolved ScreenCaptureKit display after cache populate"
    );
    Ok(result)
}

pub(super) async fn get_window(
    id: CGWindowID,
) -> Result<Option<arc::R<sc::Window>>, arc::R<ns::Error>> {
    let lookup_start = Instant::now();

    if let Some(window) = state()
        .cache
        .read()
        .unwrap()
        .as_ref()
        .and_then(|cache| cache.window(id))
    {
        trace!(
            window_id = id,
            elapsed_ms = lookup_start.elapsed().as_micros() as f64 / 1000.0,
            "Resolved ScreenCaptureKit window from warmed cache"
        );
        return Ok(Some(window));
    }

    prewarm_shareable_content().await?;

    let result = state()
        .cache
        .read()
        .unwrap()
        .as_ref()
        .and_then(|cache| cache.window(id));
    trace!(
        window_id = id,
        elapsed_ms = lookup_start.elapsed().as_micros() as f64 / 1000.0,
        cache_hit = result.is_some(),
        "Resolved ScreenCaptureKit window after cache populate"
    );
    Ok(result)
}

#[derive(Debug)]
struct ShareableContentCache {
    #[allow(dead_code)]
    content: arc::R<sc::ShareableContent>,
    displays: HashMap<CGDirectDisplayID, arc::R<sc::Display>>,
    windows: HashMap<CGWindowID, arc::R<sc::Window>>,
}

unsafe impl Send for ShareableContentCache {}
unsafe impl Sync for ShareableContentCache {}

impl ShareableContentCache {
    fn new(content: arc::R<sc::ShareableContent>) -> Self {
        let displays = content
            .displays()
            .iter()
            .map(|display| (display.display_id().0, display.retained()))
            .collect();

        let windows = content
            .windows()
            .iter()
            .map(|window| (window.id(), window.retained()))
            .collect();

        Self {
            content,
            displays,
            windows,
        }
    }

    fn display(&self, id: CGDirectDisplayID) -> Option<arc::R<sc::Display>> {
        self.displays.get(&id).cloned()
    }

    fn window(&self, id: CGWindowID) -> Option<arc::R<sc::Window>> {
        self.windows.get(&id).cloned()
    }
}
