use std::{
    path::Path,
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

pub(crate) struct Startup {
    started: Instant,
    started_at: SystemTime,
    ready: watch::Sender<bool>,
}

impl Default for Startup {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            started_at: SystemTime::now(),
            ready: watch::channel(false).0,
        }
    }
}

impl Startup {
    pub(crate) fn predates_launch(&self, path: &Path) -> bool {
        let created = path.metadata().and_then(|metadata| metadata.created()).ok();
        let modified = path
            .join("recording-meta.json")
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok();
        created.is_none_or(|created| created <= self.started_at)
            && modified.is_none_or(|modified| modified <= self.started_at)
    }

    pub(crate) fn mark_ready(&self) {
        if !self.ready.send_replace(true) {
            tracing::info!(
                elapsed_ms = self.started.elapsed().as_millis(),
                "Startup frontend ready"
            );
        }
    }

    async fn wait(&self) {
        let mut ready = self.ready.subscribe();
        let remaining = Duration::from_secs(5).saturating_sub(self.started.elapsed());
        let _ = tokio::time::timeout(remaining, ready.wait_for(|ready| *ready)).await;
    }
}

pub(crate) async fn wait_for_window(app: &AppHandle) -> bool {
    app.state::<Startup>().wait().await;
    !crate::app_is_exiting(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delayed_reconciliation_does_not_mark_this_sessions_recordings_crashed() {
        let project = tempfile::tempdir().unwrap();
        let path = project.path().join("recording-meta.json");
        std::fs::write(&path, b"{}").unwrap();
        let metadata_time = path.metadata().unwrap().modified().unwrap();
        let before_recording = Startup {
            started_at: metadata_time.checked_sub(Duration::from_secs(1)).unwrap(),
            ..Startup::default()
        };
        assert!(!before_recording.predates_launch(project.path()));
        let after_recording = Startup {
            started_at: SystemTime::now() + Duration::from_secs(1),
            ..Startup::default()
        };
        assert!(after_recording.predates_launch(project.path()));
    }

    #[tokio::test]
    async fn readiness_releases_both_existing_and_late_waiters() {
        let startup = Startup::default();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), startup.wait())
                .await
                .is_err()
        );
        startup.mark_ready();
        startup.mark_ready();
        tokio::time::timeout(Duration::from_millis(100), startup.wait())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_failed_frontend_does_not_disable_recovery() {
        let startup = Startup {
            started: Instant::now().checked_sub(Duration::from_secs(6)).unwrap(),
            ..Startup::default()
        };
        tokio::time::timeout(Duration::from_millis(100), startup.wait())
            .await
            .unwrap();
    }
}
