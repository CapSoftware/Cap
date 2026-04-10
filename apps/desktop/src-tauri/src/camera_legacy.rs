use std::time::Instant;

use cap_recording::FFmpegVideoFrame;
use flume::Sender;
use tokio_util::sync::CancellationToken;

use crate::frame_ws::{WSFrame, create_frame_ws};

const WS_PREVIEW_MAX_WIDTH: u32 = 640;
const WS_PREVIEW_MAX_HEIGHT: u32 = 360;

pub async fn create_camera_preview_ws() -> (Sender<FFmpegVideoFrame>, u16, CancellationToken) {
    let (camera_tx, camera_rx) = flume::bounded::<FFmpegVideoFrame>(4);
    let (frame_tx, _) = tokio::sync::broadcast::channel::<WSFrame>(4);
    let frame_tx_clone = frame_tx.clone();
    std::thread::spawn(move || {
        use ffmpeg::format::Pixel;

        let mut converter: Option<(Pixel, ffmpeg::software::scaling::Context)> = None;
        let mut reusable_frame: Option<ffmpeg::util::frame::Video> = None;

        while let Ok(raw_frame) = camera_rx.recv() {
            let mut frame = raw_frame.inner;

            while let Ok(newer) = camera_rx.try_recv() {
                frame = newer.inner;
            }

            let needs_convert = frame.format() != Pixel::RGBA
                || frame.width() > WS_PREVIEW_MAX_WIDTH
                || frame.height() > WS_PREVIEW_MAX_HEIGHT;

            if needs_convert {
                let target_width = WS_PREVIEW_MAX_WIDTH.min(frame.width());
                let target_height =
                    (target_width as f64 / (frame.width() as f64 / frame.height() as f64)) as u32;

                let ctx = match &mut converter {
                    Some((format, ctx))
                        if *format == frame.format()
                            && ctx.input().width == frame.width()
                            && ctx.input().height == frame.height() =>
                    {
                        ctx
                    }
                    _ => {
                        let Ok(new_converter) = ffmpeg::software::scaling::Context::get(
                            frame.format(),
                            frame.width(),
                            frame.height(),
                            Pixel::RGBA,
                            target_width,
                            target_height,
                            ffmpeg::software::scaling::flag::Flags::FAST_BILINEAR,
                        ) else {
                            continue;
                        };

                        reusable_frame = None;
                        &mut converter.insert((frame.format(), new_converter)).1
                    }
                };

                let out_frame = reusable_frame.get_or_insert_with(|| {
                    ffmpeg::util::frame::Video::new(
                        Pixel::RGBA,
                        ctx.output().width,
                        ctx.output().height,
                    )
                });

                if ctx.run(&frame, out_frame).is_err() {
                    continue;
                }

                frame_tx_clone
                    .send(WSFrame {
                        data: std::sync::Arc::new(out_frame.data(0).to_vec()),
                        width: out_frame.width(),
                        height: out_frame.height(),
                        stride: out_frame.stride(0) as u32,
                        frame_number: 0,
                        target_time_ns: 0,
                        format: crate::frame_ws::WSFrameFormat::Rgba,
                        created_at: Instant::now(),
                    })
                    .ok();
            } else {
                frame_tx_clone
                    .send(WSFrame {
                        data: std::sync::Arc::new(frame.data(0).to_vec()),
                        width: frame.width(),
                        height: frame.height(),
                        stride: frame.stride(0) as u32,
                        frame_number: 0,
                        target_time_ns: 0,
                        format: crate::frame_ws::WSFrameFormat::Rgba,
                        created_at: Instant::now(),
                    })
                    .ok();
            }
        }
    });
    let (camera_ws_port, _shutdown) = create_frame_ws(frame_tx).await;

    (camera_tx, camera_ws_port, _shutdown)
}
