use std::time::Duration;
use tracing::error;

#[derive(Debug)]
pub enum PostHogEvent {
    MultipartUploadComplete {
        // Upload duration
        duration: Duration,
        // Length of the video
        length: Duration,
        // Size of the file in megabytes
        size: u64,
    },
    MultipartUploadFailed {
        // Upload duration
        duration: Duration,
        // Error message
        error: String,
    },
}

impl From<PostHogEvent> for posthog_rs::Event {
    fn from(event: PostHogEvent) -> Self {
        let mut e = match event {
            PostHogEvent::MultipartUploadComplete {
                duration,
                length,
                size,
            } => {
                let mut e = posthog_rs::Event::new_anon("multipart_upload_complete");
                e.insert_prop("duration", duration.as_secs())
                    .map_err(|err| error!("Error adding PostHog property: {err:?}"))
                    .ok();
                e.insert_prop("length", length.as_secs())
                    .map_err(|err| error!("Error adding PostHog property: {err:?}"))
                    .ok();
                e.insert_prop("size", size)
                    .map_err(|err| error!("Error adding PostHog property: {err:?}"))
                    .ok();
                e
            }
            PostHogEvent::MultipartUploadFailed { duration, error } => {
                let mut e = posthog_rs::Event::new_anon("multipart_upload_failed");
                e.insert_prop("duration", duration.as_secs())
                    .map_err(|err| error!("Error adding PostHog property: {err:?}"))
                    .ok();
                e.insert_prop("error", error)
                    .map_err(|err| error!("Error adding PostHog property: {err:?}"))
                    .ok();
                e
            }
        };

        e.insert_prop("cap_version", env!("CARGO_PKG_VERSION"))
            .map_err(|err| error!("Error adding PostHog property: {err:?}"))
            .ok();

        e
    }
}

pub fn init() {
    if let Some(env) = option_env!("VITE_POSTHOG_KEY") {
        tokio::spawn(async move {
            posthog_rs::init_global(env)
                .await
                .map_err(|err| error!("Error initializing PostHog: {err}"))
                .ok();
        });
    }
}

pub fn async_capture_event(event: PostHogEvent) {
    if option_env!("VITE_POSTHOG_KEY").is_some() {
        tokio::spawn(async move {
            posthog_rs::capture(event.into())
                .await
                .map_err(|err| error!("Error sending event to PostHog: {err:?}"))
                .ok();
        });
    }
}
