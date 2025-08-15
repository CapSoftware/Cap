use cap_displays::{Display, Window};
use cap_media::{
    pipeline::{control::PipelineControlSignal, task::PipelineSourceTask},
    sources::{CMSampleBufferCapture, ScreenCaptureSource, ScreenCaptureTarget},
};
use std::time::SystemTime;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let (video_tx, video_rx) = flume::unbounded();
    let (ready_tx, ready_rx) = flume::unbounded();
    let (ctrl_tx, ctrl_rx) = flume::unbounded();

    let mut source = ScreenCaptureSource::<CMSampleBufferCapture>::init(
        &ScreenCaptureTarget::Window {
            id: Window::list()
                .into_iter()
                .find(|w| w.owner_name().unwrap().contains("Zed"))
                .unwrap()
                .id(),
        },
        false,
        false,
        60,
        video_tx,
        None,
        SystemTime::now(),
        tokio::runtime::Handle::current(),
    )
    .await
    .unwrap();

    std::thread::spawn(move || {
        source.run(
            ready_tx,
            PipelineControlSignal {
                last_value: None,
                receiver: ctrl_rx,
            },
        );
    });

    while let Ok((video, e)) = video_rx.recv_async().await {
        video.image_buf().unwrap();
        dbg!(video.total_sample_size());
    }

    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
}
