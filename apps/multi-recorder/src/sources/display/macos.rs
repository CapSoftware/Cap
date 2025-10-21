use crate::config::DisplayInputConfig;
use cap_media_info::VideoInfo;
use cap_recording::screen_capture;
use cap_timestamp::Timestamp;
use cidre::{cm, ns, sc};
use futures::channel::mpsc;
use futures::SinkExt;
use scap_screencapturekit::Capturer as SckCapturer;
use std::sync::Arc;
use tokio::sync::broadcast;

pub use screen_capture::VideoFrame;

pub struct PlatformVideoSource {
    info: VideoInfo,
}

impl PlatformVideoSource {
    pub fn new(info: VideoInfo) -> Self {
        Self { info }
    }

    pub fn video_info(&self) -> VideoInfo {
        self.info
    }
}

pub type PlatformCapturer = SckCapturer;

pub async fn setup_platform_capture(
    config: &DisplayInputConfig,
    mut video_tx: mpsc::Sender<VideoFrame>,
) -> anyhow::Result<(
    PlatformVideoSource,
    super::Capturer,
    broadcast::Receiver<String>,
)> {
    let (error_tx, error_rx) = broadcast::channel(1);
    let (frame_tx, frame_rx) = flume::bounded(4);

    let content = sc::ShareableContent::current()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to get shareable content: {e}"))?;

    let displays = content.displays();
    if config.id >= displays.len() as u32 {
        anyhow::bail!(
            "Display {} not found (only {} displays available)",
            config.id,
            displays.len()
        );
    }

    let display = &displays[config.id as usize];

    let filter = sc::ContentFilter::with_display_excluding_windows(display, &ns::Array::new());

    let width = display.width() as usize;
    let height = display.height() as usize;
    let fps = config.fps.unwrap_or(30);

    let mut settings = scap_screencapturekit::StreamCfgBuilder::default()
        .with_width(width)
        .with_height(height)
        .with_fps(fps as f32)
        .with_shows_cursor(config.show_cursor)
        .build();

    settings.set_pixel_format(cidre::cv::PixelFormat::_32_BGRA);
    settings.set_color_space_name(cidre::cg::color_space::names::srgb());

    let builder = SckCapturer::builder(filter, settings)
        .with_output_sample_buf_cb(move |frame| {
            let sample_buffer = frame.sample_buf();

            let mach_timestamp = cm::Clock::convert_host_time_to_sys_units(sample_buffer.pts());
            let timestamp =
                Timestamp::MachAbsoluteTime(cap_timestamp::MachAbsoluteTimestamp::new(
                    mach_timestamp,
                ));

            if let scap_screencapturekit::Frame::Screen(frame) = &frame {
                if frame.image_buf().height() == 0 || frame.image_buf().width() == 0 {
                    return;
                }

                let _ = frame_tx.try_send(VideoFrame {
                    sample_buf: sample_buffer.retained(),
                    timestamp,
                });
            }
        })
        .with_stop_with_err_cb(move |_, err| {
            let _ = error_tx.send(format!("{err}"));
        });

    let capturer = Arc::new(builder.build()?);

    tokio::spawn({
        async move {
            while let Ok(frame) = frame_rx.recv_async().await {
                let _ = video_tx.send(frame).await;
            }
        }
    });

    let video_info = VideoInfo::from_raw_ffmpeg(
        ffmpeg::format::Pixel::BGRA,
        width as u32,
        height as u32,
        fps,
    );

    let video_source = PlatformVideoSource::new(video_info);

    Ok((
        video_source,
        super::Capturer::new(capturer),
        error_rx,
    ))
}
