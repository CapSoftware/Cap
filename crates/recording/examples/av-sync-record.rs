//! Continuous instant-mode screen recording for the A/V sync hardware test
//! (`scripts/av-sync/`). Records the primary display for a fixed duration with
//! no pause, so `av-sync-check` can measure drift against a flash+beep
//! stimulus playing on screen. Audio is system audio by default, or a named
//! microphone, which `--switch-to` moves to another microphone mid-recording.
//!
//! Usage: av-sync-record [--duration <secs>] [--out <dir>] [--mic <name>]
//!                       [--switch-to <name> --switch-at <secs>]

use cap_recording::{
    feeds::microphone::{self, MicrophoneFeed, MicrophoneFeedLock},
    screen_capture::ScreenCaptureTarget,
    *,
};
use kameo::Actor as _;
use scap_targets::Display;
use std::{sync::Arc, time::Duration};
use tracing::*;

struct OpenMicrophone {
    lock: Arc<MicrophoneFeedLock>,
    _errors: flume::Receiver<cpal::StreamError>,
}

async fn open_microphone(name: &str) -> OpenMicrophone {
    let (error_tx, errors) = flume::unbounded();
    let feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx));
    feed.ask(microphone::SetInput {
        label: name.to_string(),
        settings: None,
    })
    .await
    .expect("set microphone input")
    .await
    .expect("open microphone");
    let lock = feed.ask(microphone::Lock).await.expect("lock microphone");
    OpenMicrophone {
        lock: Arc::new(lock),
        _errors: errors,
    }
}

#[tokio::main]
pub async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("warn,cap_recording=info,av_sync_record=info")
        .init();

    let mut duration_secs = 45u64;
    let mut out = std::path::PathBuf::from("/tmp/avsync_rec");
    let mut mic = None::<String>;
    let mut switch_to = None::<String>;
    let mut switch_at = None::<u64>;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--duration" => {
                duration_secs = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .expect("--duration <secs>")
            }
            "--out" => out = args.next().expect("--out <dir>").into(),
            "--mic" => mic = Some(args.next().expect("--mic <name>")),
            "--switch-to" => switch_to = Some(args.next().expect("--switch-to <name>")),
            "--switch-at" => {
                switch_at = Some(
                    args.next()
                        .and_then(|v| v.parse().ok())
                        .expect("--switch-at <secs>"),
                )
            }
            other => panic!("unexpected argument: {other}"),
        }
    }

    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).expect("create output dir");

    info!(
        "Recording {duration_secs}s of screen + {} to '{}'",
        mic.as_deref().unwrap_or("system audio"),
        out.display()
    );

    let first = match &mic {
        Some(name) => Some(open_microphone(name).await),
        None => None,
    };
    let mut builder = instant_recording::Actor::builder(
        out.clone(),
        ScreenCaptureTarget::Display {
            id: Display::primary().id(),
        },
    )
    .with_system_audio(mic.is_none());
    if let Some(first) = &first {
        builder = builder.with_mic_feed(first.lock.clone());
    }
    let handle = builder
        .build(
            #[cfg(target_os = "macos")]
            Some(cap_recording::SendableShareableContent::from(
                cidre::sc::ShareableContent::current().await.unwrap(),
            )),
        )
        .await
        .unwrap();

    let total = Duration::from_secs(duration_secs);
    let mut _switched = None;
    if let (Some(name), Some(at)) = (&switch_to, switch_at) {
        tokio::time::sleep(Duration::from_secs(at)).await;
        let next = open_microphone(name).await;
        let started = std::time::Instant::now();
        handle
            .microphone_switch()
            .expect("the recording has a switchable microphone")
            .switch(next.lock.clone())
            .await
            .expect("switch microphone");
        info!(
            to = %name,
            at_secs = at,
            switch_ms = started.elapsed().as_secs_f64() * 1000.0,
            "switched microphone"
        );
        _switched = Some(next);
        tokio::time::sleep(total.saturating_sub(Duration::from_secs(at))).await;
    } else {
        tokio::time::sleep(total).await;
    }

    handle.stop().await.unwrap();
    info!("Recording finished: {}", out.display());
}
