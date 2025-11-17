use cidre::{arc, ns, sc};
use std::sync::{Arc, OnceLock, RwLock};
use tokio::sync::{Mutex, Notify};
use tracing::trace;

#[derive(Default)]
struct CacheState {
    cache: RwLock<Option<ShareableContentCache>>,
    warmup: Mutex<Option<WarmupTask>>,
}

type WarmupResult = Result<(), arc::R<ns::Error>>;

#[derive(Clone)]
struct WarmupTask {
    notify: Arc<Notify>,
    result: Arc<Mutex<Option<WarmupResult>>>,
}

static STATE: OnceLock<CacheState> = OnceLock::new();

fn state() -> &'static CacheState {
    STATE.get_or_init(CacheState::default)
}

pub async fn prewarm_shareable_content() -> Result<(), arc::R<ns::Error>> {
    prewarm_shareable_content_inner(false).await
}

pub async fn refresh_shareable_content() -> Result<(), arc::R<ns::Error>> {
    prewarm_shareable_content_inner(true).await
}

async fn prewarm_shareable_content_inner(force_refresh: bool) -> Result<(), arc::R<ns::Error>> {
    if force_refresh {
        state().cache.write().unwrap().take();
    } else if state().cache.read().unwrap().is_some() {
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
    warmup
        .result
        .lock()
        .await
        .clone()
        .expect("ScreenCaptureKit warmup task missing result")
}

pub async fn get_shareable_content()
-> Result<Option<arc::R<sc::ShareableContent>>, arc::R<ns::Error>> {
    if let Some(content) = state()
        .cache
        .read()
        .unwrap()
        .as_ref()
        .map(|v| v.content.retained())
    {
        return Ok(Some(content));
    }

    prewarm_shareable_content().await?;

    let content = state().cache.read().unwrap();
    Ok(content.as_ref().map(|v| v.content.retained()))
}

async fn run_warmup(task: WarmupTask) {
    let result = async {
        let content = sc::ShareableContent::current().await?;
        let cache = ShareableContentCache::new(content);

        let mut guard = state().cache.write().unwrap();
        *guard = Some(cache);

        Ok::<(), arc::R<ns::Error>>(())
    }
    .await;

    {
        let mut res_guard = task.result.lock().await;
        *res_guard = Some(result);
    }

    task.notify.notify_waiters();

    let mut guard = state().warmup.lock().await;
    if let Some(current) = guard.as_ref()
        && Arc::ptr_eq(&current.notify, &task.notify)
    {
        *guard = None;
    }
}

#[derive(Debug)]
struct ShareableContentCache {
    #[allow(dead_code)]
    content: arc::R<sc::ShareableContent>,
}

unsafe impl Send for ShareableContentCache {}
unsafe impl Sync for ShareableContentCache {}

impl ShareableContentCache {
    fn new(content: arc::R<sc::ShareableContent>) -> Self {
        Self { content }
    }
}

pub(crate) struct ScreenCapturePrewarmer {
    state: Mutex<PrewarmState>,
}

impl Default for ScreenCapturePrewarmer {
    fn default() -> Self {
        Self {
            state: Mutex::new(PrewarmState::Idle),
        }
    }
}

impl ScreenCapturePrewarmer {
    pub async fn request(&self, force: bool) {
        let should_start = {
            let mut state = self.state.lock().await;

            if force {
                *state = PrewarmState::Idle;
            }

            match *state {
                PrewarmState::Idle => {
                    *state = PrewarmState::Warming;
                    true
                }
                PrewarmState::Warming => {
                    trace!("ScreenCaptureKit prewarm already in progress");
                    false
                }
                PrewarmState::Warmed => {
                    if force {
                        *state = PrewarmState::Warming;
                        true
                    } else {
                        trace!("ScreenCaptureKit cache already warmed");
                        false
                    }
                }
            }
        };

        if !should_start {
            return;
        }

        let warm_start = std::time::Instant::now();
        let result = if force {
            crate::platform::refresh_shareable_content().await
        } else {
            crate::platform::prewarm_shareable_content().await
        };

        let mut state = self.state.lock().await;
        match result {
            Ok(()) => {
                let elapsed_ms = warm_start.elapsed().as_micros() as f64 / 1000.0;
                *state = PrewarmState::Warmed;
                trace!(elapsed_ms, "ScreenCaptureKit cache warmed");
            }
            Err(error) => {
                *state = PrewarmState::Idle;
                tracing::warn!(error = %error, "ScreenCaptureKit prewarm failed");
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PrewarmState {
    Idle,
    Warming,
    Warmed,
}
