#[derive(Default)]
struct CallbackState;

fn run_callback(
    bytes: &[u8],
    width: u32,
    height: u32,
    preview_on: bool,
    _state: &mut CallbackState,
    preview_decoder: &mut MjpegDecoder,
) -> (
    Option<NativeCameraFrame>,
    Option<ffmpeg::frame::Video>,
    Option<Instant>,
) {
    let native = NativeCameraFrame {
        buffer: mf_buffer(bytes),
        pixel_format: cap_camera_windows::PixelFormat::MJPEG,
        width,
        height,
        is_bottom_up: false,
        timestamp: Timestamp::Instant(Instant::now()),
    };
    if !preview_on {
        return (Some(native), None, None);
    }
    let mut preview = preview_decoder.decode(bytes).unwrap();
    preview.set_pts(Some(1));
    (Some(native), Some(preview), Some(Instant::now()))
}
