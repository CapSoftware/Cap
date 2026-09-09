use std::time::{Duration, Instant};

use cap_recording::feeds::{camera, microphone::MicrophoneFeed};
use kameo::Actor;

use crate::devices::{DeviceSnapshot, InputSnapshot, TargetSnapshot};

fn measure<T>(stage: &str, sample: usize, run: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let result = run();
    println!(
        "{}",
        serde_json::json!({
            "stage": stage,
            "sample": sample,
            "elapsedMs": started.elapsed().as_secs_f64() * 1000.0,
        })
    );
    result
}

#[tokio::test]
#[ignore = "opens local capture devices to measure native picker dependencies"]
async fn native_picker_latency() -> anyhow::Result<()> {
    for sample in 0..10 {
        let snapshot = measure("gpui_startup_discovery", sample, DeviceSnapshot::enumerate);
        println!(
            "{}",
            serde_json::json!({
                "sample": sample,
                "cameras": snapshot.cameras.len(),
                "microphones": snapshot.microphones.len(),
                "displays": snapshot.displays.len(),
                "windows": snapshot.windows.len(),
            })
        );
        measure("camera_picker_discovery", sample, || {
            InputSnapshot::cameras(&[])
        });
        measure(
            "microphone_picker_discovery",
            sample,
            InputSnapshot::microphones,
        );
        measure("tauri_device_inventory", sample, || {
            (
                cap_camera::list_cameras().collect::<Vec<_>>(),
                MicrophoneFeed::list_names(),
            )
        });
        measure("target_discovery", sample, TargetSnapshot::enumerate);
        let names = MicrophoneFeed::list_names();
        measure("microphone_metadata_all_devices", sample, || {
            names
                .iter()
                .map(|name| MicrophoneFeed::list().swap_remove(name))
                .collect::<Vec<_>>()
        });
        measure("microphone_metadata_named_devices", sample, || {
            names
                .iter()
                .map(|name| MicrophoneFeed::device_with_settings(name, None))
                .collect::<Vec<_>>()
        });
    }

    let device_id = std::env::var("CAP_PICKER_BENCH_CAMERA_ID")?;
    let camera_info = cap_camera::list_cameras()
        .find(|camera| camera.device_id() == device_id)
        .ok_or_else(|| anyhow::anyhow!("Benchmark camera is unavailable"))?;
    let id = camera::DeviceOrModelID::from_info(&camera_info);
    for (stage, reuse) in [
        ("camera_repeated_selection", false),
        ("camera_reused_selection", true),
    ] {
        measure_camera_selection(stage, reuse, &id).await?;
    }
    Ok(())
}

async fn measure_camera_selection(
    stage: &str,
    reuse: bool,
    id: &camera::DeviceOrModelID,
) -> anyhow::Result<()> {
    let feed = camera::CameraFeed::spawn(camera::CameraFeed::default());
    let (sender, receiver) = flume::bounded(4);
    feed.ask(camera::AddSender(sender)).await?;
    for sample in 0..10 {
        while receiver.try_recv().is_ok() {}
        if sample > 0 {
            tokio::time::timeout(Duration::from_secs(5), receiver.recv_async()).await??;
        }
        let started = Instant::now();
        let reused = reuse
            && feed
                .ask(camera::CheckInput {
                    id: id.clone(),
                    settings: None,
                })
                .await?;
        if !reused {
            feed.ask(camera::SetInput {
                id: id.clone(),
                settings: None,
            })
            .await?
            .await?;
        }
        let ready_ms = started.elapsed().as_secs_f64() * 1000.0;
        tokio::time::timeout(Duration::from_secs(5), receiver.recv_async()).await??;
        println!(
            "{}",
            serde_json::json!({
                "stage": stage,
                "sample": sample,
                "elapsedMs": ready_ms,
                "frameMs": started.elapsed().as_secs_f64() * 1000.0,
                "reused": reused,
            })
        );
    }
    feed.ask(camera::RemoveInput).await?;
    feed.stop_gracefully().await?;
    Ok(())
}
