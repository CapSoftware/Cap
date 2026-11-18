use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use cap_media_info::{Pixel, VideoInfo};
use cap_timestamp::Timestamp;
use ffmpeg::util::rational::Rational as FFRational;
use futures::{FutureExt, SinkExt, channel::mpsc, future::BoxFuture};

use crate::output_pipeline::{FFmpegVideoFrame, SetupCtx, VideoSource};

/// Size of the black frame an audio-only recording keeps as its display track.
/// It is the canvas a visualiser export is drawn on, so it matches the 1080p
/// default export.
pub const AUDIO_ONLY_CANVAS_WIDTH: u32 = 1920;
pub const AUDIO_ONLY_CANVAS_HEIGHT: u32 = 1080;
pub const AUDIO_ONLY_CANVAS_FPS: u32 = 30;

/// Software H.264 only: a static black frame costs libx264 almost nothing, and
/// keeping it off the hardware encoders means an audio recording never
/// competes with, or depends on, a GPU encoder session.
pub const AUDIO_ONLY_CANVAS_ENCODERS: &[&str] = &["libx264"];

pub struct AudioOnlyCanvasConfig;

/// Emits one shared black frame per tick so an audio-only segment has the same
/// display track, timing and fragment layout as every other Studio segment.
pub struct AudioOnlyCanvas {
    info: VideoInfo,
    stop: Arc<AtomicBool>,
}

pub fn audio_only_canvas_info() -> VideoInfo {
    VideoInfo {
        pixel_format: Pixel::YUV420P,
        width: AUDIO_ONLY_CANVAS_WIDTH,
        height: AUDIO_ONLY_CANVAS_HEIGHT,
        time_base: FFRational(1, 1_000_000),
        frame_rate: FFRational(AUDIO_ONLY_CANVAS_FPS as i32, 1),
    }
}

pub fn black_frame(info: &VideoInfo) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(info.pixel_format, info.width, info.height);
    for (plane, value) in [(0, 16u8), (1, 128u8), (2, 128u8)] {
        frame.data_mut(plane).fill(value);
    }
    frame
}

impl VideoSource for AudioOnlyCanvas {
    type Config = AudioOnlyCanvasConfig;
    type Frame = FFmpegVideoFrame;

    async fn setup(
        _: Self::Config,
        mut video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut SetupCtx,
    ) -> anyhow::Result<Self> {
        let info = audio_only_canvas_info();
        let stop = Arc::new(AtomicBool::new(false));
        let cancel = ctx.stop_token();
        let template = FFmpegVideoFrame {
            inner: black_frame(&info),
            timestamp: Timestamp::Instant(Instant::now()),
        };

        ctx.tasks().spawn("audio-only-canvas", {
            let stop = stop.clone();
            async move {
                let period = Duration::from_secs(1) / AUDIO_ONLY_CANVAS_FPS;
                let mut ticks = tokio::time::interval(period);
                ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => break,
                        tick = ticks.tick() => {
                            if stop.load(Ordering::Relaxed) {
                                break;
                            }
                            let Some(mut frame) =
                                crate::output_pipeline::VideoFrame::duplicate(&template)
                            else {
                                continue;
                            };
                            frame.timestamp = Timestamp::Instant(tick.into_std());
                            if video_tx.send(frame).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                Ok(())
            }
        });

        Ok(Self { info, stop })
    }

    fn video_info(&self) -> VideoInfo {
        self.info
    }

    fn stop(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        self.stop.store(true, Ordering::Relaxed);
        async { Ok(()) }.boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn black_frame_is_limited_range_black() {
        let info = audio_only_canvas_info();
        let frame = black_frame(&info);
        assert_eq!((frame.width(), frame.height()), (1920, 1080));
        assert!(frame.data(0).iter().all(|value| *value == 16));
        assert!(frame.data(1).iter().all(|value| *value == 128));
        assert!(frame.data(2).iter().all(|value| *value == 128));
    }
}
