use cap_media::{
	sources::{ScreenCaptureSource, ScreenCaptureTarget, AVFrameCapture},
	pipeline::{
		task::{PipelineSourceTask, PipelineReadySignal},
		control::PipelineControlSignal,
	}
};
use std::time::SystemTime;
use cap_displays::Display;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let (video_tx, video_rx) = flume::unbounded();
    let (ready_tx, ready_rx) = flume::unbounded();
    let (ctrl_tx, ctrl_rx) = flume::unbounded();

    let mut source = ScreenCaptureSource::<AVFrameCapture>::init(
    	&ScreenCaptureTarget::Screen { id: Display::primary().id().clone() },
	     false,
	     false,
	     60,
	     video_tx,
	     None,
	     SystemTime::now(),
	     tokio::runtime::Handle::current(),
    ).await.unwrap();

    std::thread::spawn(move || {
	    source.run(
	    	ready_tx,
		     PipelineControlSignal {
			     last_value: None,
			     receiver: ctrl_rx,
		     }
	    );
    });

    while let Ok((video, e)) = video_rx.recv_async().await {
	    dbg!(video.format(), e);
    }

    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
}
