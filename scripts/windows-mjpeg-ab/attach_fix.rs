#[derive(Default)]
struct CallbackState(SharedDecodeBudget);

fn run_callback(
    bytes: &[u8],
    width: u32,
    height: u32,
    preview_on: bool,
    state: &mut CallbackState,
    preview_decoder: &mut MjpegDecoder,
) -> (
    Option<NativeCameraFrame>,
    Option<ffmpeg::frame::Video>,
    Option<Instant>,
) {
    let shared_decode = preview_on.then(|| preview_decoder.decode(bytes));
    let native = NativeCameraFrame {
        buffer: mf_buffer(bytes),
        pixel_format: cap_camera_windows::PixelFormat::MJPEG,
        width,
        height,
        is_bottom_up: false,
        timestamp: Timestamp::Instant(Instant::now()),
        decoded: shared_decode
            .as_ref()
            .and_then(|decoded| decoded.as_ref().ok())
            .and_then(|decoded| state.0.share(decoded)),
    };
    let Some(decoded) = shared_decode else {
        return (Some(native), None, None);
    };
    let mut preview = decoded.unwrap();
    preview.set_pts(Some(1));
    (Some(native), Some(preview), Some(Instant::now()))
}
