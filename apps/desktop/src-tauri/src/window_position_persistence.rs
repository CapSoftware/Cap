use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

use crate::general_settings::{GeneralSettingsStore, WindowPosition};

#[derive(Default)]
struct PendingState {
    main: Option<WindowPosition>,
    camera_position: Option<(f64, f64)>,
}

pub struct WindowPositionPersistence {
    pending: Mutex<PendingState>,
    notify: Arc<Notify>,
}

impl WindowPositionPersistence {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            pending: Mutex::new(PendingState::default()),
            notify: Arc::new(Notify::new()),
        })
    }

    pub fn queue_main(&self, position: WindowPosition) {
        {
            let mut guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            guard.main = Some(position);
        }
        self.notify.notify_one();
    }

    pub fn queue_camera(&self, x: f64, y: f64) {
        {
            let mut guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            guard.camera_position = Some((x, y));
        }
        self.notify.notify_one();
    }

    fn take_pending(&self) -> PendingState {
        let mut guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *guard)
    }
}

pub fn install(app: &AppHandle) {
    let persistence = WindowPositionPersistence::new();
    app.manage(persistence.clone());

    let app_handle = app.clone();
    let notify = persistence.notify.clone();
    tokio::spawn(async move {
        const DEBOUNCE: Duration = Duration::from_millis(350);
        const MIN_INTERVAL: Duration = Duration::from_millis(150);

        let mut last_flush = std::time::Instant::now()
            .checked_sub(MIN_INTERVAL)
            .unwrap_or_else(std::time::Instant::now);

        loop {
            notify.notified().await;

            if crate::app_is_exiting(&app_handle) {
                break;
            }

            tokio::time::sleep(DEBOUNCE).await;

            if crate::app_is_exiting(&app_handle) {
                break;
            }

            let elapsed = last_flush.elapsed();
            let remaining = MIN_INTERVAL.saturating_sub(elapsed);
            if !remaining.is_zero() {
                tokio::time::sleep(remaining).await;
            }

            let Some(persistence) = app_handle.try_state::<Arc<WindowPositionPersistence>>() else {
                break;
            };
            let pending = persistence.take_pending();

            if pending.main.is_none() && pending.camera_position.is_none() {
                continue;
            }

            let write_app = app_handle.clone();
            let write_result = tokio::task::spawn_blocking(move || {
                GeneralSettingsStore::update(&write_app, |settings| {
                    if let Some(main) = pending.main {
                        settings.main_window_position = Some(main);
                    }
                    if let Some((x, y)) = pending.camera_position {
                        crate::update_camera_window_position_settings(settings, x, y);
                    }
                })
            })
            .await;

            match write_result {
                Ok(Ok(())) => {}
                Ok(Err(err)) => tracing::warn!("Failed to persist window position: {err}"),
                Err(err) => tracing::warn!("Window position persistence task panicked: {err}"),
            }

            last_flush = std::time::Instant::now();
        }
    });
}

pub fn queue_main_position(app: &AppHandle, position: WindowPosition) {
    if let Some(persistence) = app.try_state::<Arc<WindowPositionPersistence>>() {
        persistence.queue_main(position);
    }
}

pub fn queue_camera_position(app: &AppHandle, x: f64, y: f64) {
    if let Some(persistence) = app.try_state::<Arc<WindowPositionPersistence>>() {
        persistence.queue_camera(x, y);
    }
}
