use cap_recording::feeds::camera::{self, CameraFeed, DeviceOrModelID};
use kameo::Actor as _;
use std::time::Duration;
use tokio::{task::JoinHandle, time::Instant};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let camera_info = cap_camera::list_cameras()
        .next()
        .expect("no cameras detected");

    println!("Using camera: {}", camera_info.display_name());

    let camera_feed = CameraFeed::spawn(CameraFeed::default());

    camera_feed
        .ask(camera::SetInput {
            id: DeviceOrModelID::from_info(&camera_info),
        })
        .await
        .expect("failed to request camera")
        .await
        .expect("failed to initialize camera");

    let lock = camera_feed.ask(camera::Lock).await.expect("lock failed");

    let (tx, rx) = flume::bounded(8);
    lock.ask(camera::AddSender(tx))
        .await
        .expect("add sender failed");

    let reader: JoinHandle<()> = tokio::spawn(async move {
        let start = Instant::now();
        let mut frames = 0usize;

        while start.elapsed() < Duration::from_secs(5) {
            match rx.recv_async().await {
                Ok(_frame) => {
                    frames += 1;
                }
                Err(err) => {
                    eprintln!("Channel closed: {err}");
                    break;
                }
            }
        }

        println!("Captured {frames} frames in 5 seconds");
    });

    reader.await.expect("reader crashed");

    drop(lock);
}
