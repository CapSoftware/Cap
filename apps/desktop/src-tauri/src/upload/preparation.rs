use super::{SegmentUploadState, lifecycle};
use crate::{api, web_api::inherit_upload_context};
use cap_recording::upload_preparation::Preparation;
pub(crate) use cap_recording::upload_preparation::Segment;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::AppHandle;

pub(super) struct Task(tokio::task::JoinHandle<()>);

impl Task {
    pub(super) async fn stop(mut self) {
        self.0.abort();
        if let Err(error) = (&mut self.0).await
            && !error.is_cancelled()
        {
            tracing::warn!(%error, "Optional recording preparation stopped");
        }
    }
}

impl Drop for Task {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) fn start(
    app: AppHandle,
    video_id: String,
    state: Arc<Mutex<SegmentUploadState>>,
    session: Arc<lifecycle::Session>,
) -> Task {
    let context = session.context();
    Task(tokio::spawn(inherit_upload_context(context, async move {
        let mut preparation = Preparation::default();
        let mut next_request = tokio::time::Instant::now();
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = session.cancelled() => return,
                _ = interval.tick() => {}
            }
            if tokio::time::Instant::now() < next_request {
                continue;
            }
            let batch = {
                let state = state.lock().unwrap_or_else(|error| error.into_inner());
                preparation.next_batch(
                    state.uploaded_video_segments.keys().copied(),
                    state.uploaded_audio_segments.keys().copied(),
                )
            };
            if batch.is_empty() {
                continue;
            }
            let result = tokio::select! {
                _ = session.cancelled() => return,
                result = api::prepare_recording_segments(&app, &video_id, &batch) => result,
            };
            match result {
                Ok(Some(prepared)) => {
                    preparation.acknowledge(&batch, &prepared);
                }
                Ok(None) => return,
                Err(error) => {
                    preparation.request_failed();
                    tracing::debug!(%error, "Optional recording preparation unavailable");
                }
            }
            next_request = tokio::time::Instant::now() + preparation.retry_delay();
        }
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stopping_preparation_cancels_an_in_flight_request() {
        let (started, ready) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        let abort = handle.abort_handle();
        let task = Task(handle);
        ready.await.unwrap();
        task.stop().await;
        assert!(abort.is_finished());
    }
}
