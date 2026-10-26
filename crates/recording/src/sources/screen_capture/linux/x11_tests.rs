use super::*;
use x11rb::protocol::xproto::{ChangeGCAux, CreateGCAux, Rectangle};

async fn configured_source(
    crop: Option<CropBounds>,
    limit: Option<(u32, u32)>,
) -> VideoSourceConfig {
    let config = ScreenCaptureConfig::<X11Capture>::init(
        Display::primary(),
        crop,
        false,
        30,
        limit,
        SystemTime::now(),
        false,
        if crop.is_some() {
            LinuxCaptureSource::Area
        } else {
            LinuxCaptureSource::Display
        },
    )
    .await
    .unwrap();
    let (source, audio) = config.to_sources().await.unwrap();
    assert!(audio.is_none());
    source
}

async fn capture_frame(
    crop: Option<CropBounds>,
    limit: Option<(u32, u32)>,
) -> (VideoInfo, ffmpeg::frame::Video) {
    let source = configured_source(crop, limit).await;
    let LinuxInputConfig::X11(input) = source.input else {
        panic!("requires an X11 session");
    };
    let info = source.video_info;
    let (tx, mut rx) = mpsc::channel(1);
    let (health_tx, _health_rx) = tokio::sync::mpsc::channel(4);
    let stop = CancellationToken::new();
    let thread_stop = stop.clone();
    let thread = std::thread::spawn(move || capture_x11(info, input, tx, thread_stop, health_tx));
    let frame = tokio::time::timeout(Duration::from_secs(5), rx.next()).await;
    stop.cancel();
    drop(rx);
    thread.join().unwrap().unwrap();
    (info, frame.unwrap().unwrap().inner)
}

static DISPLAY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The tests share one root window, so each holds the display from painting
/// until its last capture.
async fn paint_display() -> (tokio::sync::MutexGuard<'static, ()>, RustConnection) {
    let guard = DISPLAY.lock().await;
    let (conn, screen) = x11rb::connect(None).unwrap();
    let root = conn.setup().roots[screen].root;
    let gc = conn.generate_id().unwrap();
    conn.create_gc(gc, root, &CreateGCAux::new().foreground(0xff0000))
        .unwrap()
        .check()
        .unwrap();
    conn.poly_fill_rectangle(
        root,
        gc,
        &[Rectangle {
            x: 0,
            y: 0,
            width: 800,
            height: 600,
        }],
    )
    .unwrap()
    .check()
    .unwrap();
    conn.change_gc(gc, &ChangeGCAux::new().foreground(0x0000ff))
        .unwrap()
        .check()
        .unwrap();
    conn.poly_fill_rectangle(
        root,
        gc,
        &[Rectangle {
            x: 400,
            y: 0,
            width: 400,
            height: 600,
        }],
    )
    .unwrap()
    .check()
    .unwrap();
    conn.free_gc(gc).unwrap().check().unwrap();
    (guard, conn)
}

fn assert_frame(info: VideoInfo, frame: &ffmpeg::frame::Video, expected: (u32, u32)) {
    assert_eq!((info.width, info.height), expected);
    assert_eq!((frame.width(), frame.height()), expected);
    assert_eq!(frame.format(), ffmpeg::format::Pixel::BGRZ);
    let y = frame.height() as usize / 2;
    let left = y * frame.stride(0) + 4 * 4;
    let right = y * frame.stride(0) + (frame.width() as usize - 5) * 4;
    assert_eq!(&frame.data(0)[left..left + 3], &[0, 0, 255]);
    assert_eq!(&frame.data(0)[right..right + 3], &[255, 0, 0]);
}

#[tokio::test]
#[ignore = "requires a dedicated 800x600 Xvfb display"]
async fn x11_resolution_limit_preserves_the_whole_display_and_area() {
    let _display = paint_display().await;
    let (info, frame) = capture_frame(None, Some((320, 240))).await;
    assert_frame(info, &frame, (320, 240));

    let crop = CropBounds::new(
        PhysicalPosition::new(200.0, 100.0),
        PhysicalSize::new(400.0, 300.0),
    );
    let (info, frame) = capture_frame(Some(crop), Some((160, 120))).await;
    assert_frame(info, &frame, (160, 120));

    let (info, frame) = capture_frame(None, Some((320, 200))).await;
    assert_frame(info, &frame, (266, 200));
}

#[tokio::test]
#[ignore = "requires a dedicated 800x600 Xvfb display"]
async fn x11_resolution_without_a_limit_keeps_native_dimensions() {
    let _display = paint_display().await;
    let (info, frame) = capture_frame(None, None).await;
    assert_frame(info, &frame, (800, 600));

    let crop = CropBounds::new(
        PhysicalPosition::new(200.0, 100.0),
        PhysicalSize::new(400.0, 300.0),
    );
    let (info, frame) = capture_frame(Some(crop), None).await;
    assert_frame(info, &frame, (400, 300));

    let (info, frame) = capture_frame(Some(crop), Some((800, 600))).await;
    assert_frame(info, &frame, (400, 300));

    let clipped = CropBounds::new(
        PhysicalPosition::new(600.0, 300.0),
        PhysicalSize::new(400.0, 400.0),
    );
    let (info, frame) = capture_frame(Some(clipped), None).await;
    assert_eq!((info.width, info.height), (200, 300));
    assert_eq!((frame.width(), frame.height()), (200, 300));
}

#[tokio::test]
#[ignore = "requires a dedicated 800x600 Xvfb display"]
async fn x11_resolution_limit_reaches_the_encoded_recording() {
    let _display = paint_display().await;
    let source = configured_source(None, Some((320, 240))).await;
    let output = tempfile::tempdir().unwrap();
    let pipeline = output_pipeline::OutputPipeline::builder(output.path().to_path_buf())
        .with_video::<VideoSource>(source)
        .with_timestamps(cap_timestamp::Timestamps::now())
        .build::<output_pipeline::ffmpeg::SegmentedVideoMuxer>(Default::default())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(350)).await;
    let finished = pipeline.stop().await.unwrap();
    assert!(finished.video_frame_count > 0);
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(output.path().join("manifest.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["is_complete"], true);
    assert_eq!(manifest["codec_info"]["width"], 320);
    assert_eq!(manifest["codec_info"]["height"], 240);
    let input = ffmpeg::format::input(
        &output
            .path()
            .join(manifest["init_segment"].as_str().unwrap()),
    )
    .unwrap();
    let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
    let decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .unwrap()
        .decoder()
        .video()
        .unwrap();
    assert_eq!((decoder.width(), decoder.height()), (320, 240));
}
