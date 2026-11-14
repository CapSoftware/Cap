//! Probe only (not shipped): records the primary display plus a microphone in
//! Instant or Studio for the flash+click sync check, optionally switching the
//! microphone mid-recording the way the GPUI app does.
//!
//! devswitch-probe --mode instant|studio --out <dir> --duration <s> --mic <name>
//!                 [--switch-to <name> --switch-at <s>]

use cap_recording::{
    feeds::microphone::{self, MicrophoneFeed, MicrophoneFeedLock},
    screen_capture::ScreenCaptureTarget,
    *,
};
use kameo::Actor as _;
use scap_targets::Display;
use std::{sync::Arc, time::Duration};

struct Mic {
    lock: Arc<MicrophoneFeedLock>,
    _errors: flume::Receiver<cpal::StreamError>,
}

async fn open(name: &str) -> Mic {
    let (tx, errors) = flume::unbounded();
    let feed = MicrophoneFeed::spawn(MicrophoneFeed::new(tx));
    feed.ask(microphone::SetInput {
        label: name.into(),
        settings: None,
    })
    .await
    .expect("set input")
    .await
    .expect("open mic");
    Mic {
        lock: Arc::new(feed.ask(microphone::Lock).await.expect("lock")),
        _errors: errors,
    }
}

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

async fn content() -> Option<cap_recording::SendableShareableContent> {
    Some(cap_recording::SendableShareableContent::from(
        cidre::sc::ShareableContent::current().await.unwrap(),
    ))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("warn,cap_recording=info,devswitch_baseline=info")
        .init();
    let mode = arg("--mode").unwrap_or_else(|| "instant".into());
    let out = std::path::PathBuf::from(arg("--out").expect("--out"));
    let duration: u64 = arg("--duration").map_or(60, |v| v.parse().unwrap());
    let mic = arg("--mic").expect("--mic");
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).unwrap();
    let target = ScreenCaptureTarget::Display {
        id: Display::primary().id(),
    };
    let first = open(&mic).await;
    let total = Duration::from_secs(duration);
    let mut _keep = Vec::new();

    if mode == "studio" {
        let handle = studio_recording::Actor::builder(out.clone(), target)
            .with_mic_feed(first.lock.clone())
            .build(content().await)
            .await
            .unwrap();
        _keep.push(first);
        tokio::time::sleep(total).await;
        handle.stop().await.unwrap();
    } else {
        let handle = instant_recording::Actor::builder(out.clone(), target)
            .with_mic_feed(first.lock.clone())
            .build(content().await)
            .await
            .unwrap();
        _keep.push(first);
        tokio::time::sleep(total).await;
        handle.stop().await.unwrap();
    }
    println!("PROBE done {}", out.display());
}
