use cap_media::{feeds::RawCameraFrame, frame_ws::WSFrame};
use flume::Sender;

pub async fn create_camera_preview_ws() -> (
    Sender<RawCameraFrame>,
    u16,
    tauri::async_runtime::Sender<()>,
) {
    let (camera_tx, mut _camera_rx) = flume::bounded::<RawCameraFrame>(4);
    let (_camera_tx, camera_rx) = flume::bounded::<WSFrame>(4);
    std::thread::spawn(move || {
        use ffmpeg::format::Pixel;

        let mut converter: Option<(Pixel, ffmpeg::software::scaling::Context)> = None;

        while let Ok(raw_frame) = _camera_rx.recv() {
            let mut frame = raw_frame.frame;

            if frame.format() != Pixel::RGBA || frame.width() > 1280 || frame.height() > 720 {
                let converter = match &mut converter {
                    Some((format, converter))
                        if *format == frame.format()
                            && converter.input().width == frame.width()
                            && converter.input().height == frame.height() =>
                    {
                        converter
                    }
                    _ => {
                        &mut converter
                            .insert((
                                frame.format(),
                                ffmpeg::software::scaling::Context::get(
                                    frame.format(),
                                    frame.width(),
                                    frame.height(),
                                    Pixel::RGBA,
                                    1280,
                                    (1280.0 / (frame.width() as f64 / frame.height() as f64))
                                        as u32,
                                    ffmpeg::software::scaling::flag::Flags::FAST_BILINEAR,
                                )
                                .unwrap(),
                            ))
                            .1
                    }
                };

                let mut new_frame = ffmpeg::util::frame::Video::new(
                    Pixel::RGBA,
                    converter.output().width,
                    converter.output().height,
                );

                converter.run(&frame, &mut new_frame).unwrap();

                frame = new_frame;
            }

            _camera_tx
                .send(WSFrame {
                    data: frame.data(0).to_vec(),
                    width: frame.width(),
                    height: frame.height(),
                    stride: frame.stride(0) as u32,
                })
                .ok();
        }
    });
    // _shutdown needs to be kept alive to keep the camera ws running
    let (camera_ws_port, _shutdown) = cap_media::frame_ws::create_frame_ws(camera_rx.clone()).await;

    (camera_tx, camera_ws_port, _shutdown)
}
