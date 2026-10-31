use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
    time::Duration,
};

use ffmpeg::{format, frame, software};
use tokio::sync::oneshot;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use ffmpeg::sys::AVHWDeviceType;

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "webm", "mkv", "gif"];

/// Frames from the start of the clip stay decoded so a loop restarts
/// without a seek. Short clips and most GIFs fit entirely.
const HEAD_BUDGET_BYTES: usize = 32 * 1024 * 1024;
const MIN_HEAD_FRAMES: usize = 2;
const PREFETCH_FRAMES: usize = 3;
/// A request this far past the decoded frames seeks instead of decoding
/// through everything in between.
const SEEK_THRESHOLD_SECS: f64 = 1.5;
const TIME_EPSILON: f64 = 1e-4;
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
const FRAME_TIMEOUT: Duration = Duration::from_secs(5);
/// Downscaling a 4K frame is the most expensive step; past four threads it
/// stops paying off and starts competing with the recording's own decoders.
const SCALER_THREADS: usize = 4;
const MAX_DECODE_ERRORS: usize = 16;

pub fn is_video_background(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            VIDEO_EXTENSIONS
                .iter()
                .any(|video| extension.eq_ignore_ascii_case(video))
        })
}

/// Picks the decode size from a few fixed steps, so resizing the preview
/// only reopens the video when the output crosses a step.
pub fn video_background_max_dimension(output_size: (u32, u32), device_limit: u32) -> u32 {
    let longest = output_size.0.max(output_size.1);
    [640, 960, 1280, 1920]
        .into_iter()
        .find(|step| *step >= longest)
        .unwrap_or(1920)
        .min(device_limit)
}

pub fn video_background_poster(path: &Path, max_dimension: u32) -> Option<(Vec<u8>, u32, u32)> {
    let reader = Reader::open(path.to_path_buf(), max_dimension, 0)
        .inspect_err(|error| tracing::warn!("Failed to read background video poster: {error}"))
        .ok()?;
    let frame = reader.head.first()?;
    Some((frame.data.clone(), frame.width, frame.height))
}

pub struct VideoBackgroundFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    time: f64,
    /// When the next decoded frame starts. Frames skipped by read-ahead leave
    /// gaps between cached frames, so coverage can't be taken from the next
    /// cached frame.
    end: f64,
}

struct FrameRequest {
    seconds: f64,
    reply: oneshot::Sender<Option<Arc<VideoBackgroundFrame>>>,
}

pub struct VideoBackgroundSource {
    requests: mpsc::Sender<FrameRequest>,
}

impl VideoBackgroundSource {
    pub async fn open(path: PathBuf, max_dimension: u32) -> Result<Self, String> {
        Self::open_with_head_budget(path, max_dimension, HEAD_BUDGET_BYTES).await
    }

    async fn open_with_head_budget(
        path: PathBuf,
        max_dimension: u32,
        head_budget_bytes: usize,
    ) -> Result<Self, String> {
        let (ready_tx, ready_rx) = oneshot::channel();
        let (requests, receiver) = mpsc::channel();

        std::thread::Builder::new()
            .name("video-background".to_string())
            .spawn(
                move || match Reader::open(path, max_dimension, head_budget_bytes) {
                    Ok(reader) => {
                        let _ = ready_tx.send(Ok(()));
                        reader.run(receiver);
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                    }
                },
            )
            .map_err(|error| format!("spawn video background thread / {error}"))?;

        tokio::time::timeout(OPEN_TIMEOUT, ready_rx)
            .await
            .map_err(|_| "timed out opening video background".to_string())?
            .map_err(|_| "video background thread exited".to_string())??;

        Ok(Self { requests })
    }

    pub async fn frame_at(&self, seconds: f64) -> Option<Arc<VideoBackgroundFrame>> {
        let (reply, response) = oneshot::channel();
        self.requests.send(FrameRequest { seconds, reply }).ok()?;
        tokio::time::timeout(FRAME_TIMEOUT, response)
            .await
            .ok()?
            .ok()?
    }
}

/// Built through the raw swscale API: only a context configured before
/// initialisation can spread the conversion over several threads.
struct Scaler {
    context: *mut ffmpeg::ffi::SwsContext,
    input: (format::Pixel, u32, u32),
    output: frame::Video,
}

// SAFETY: the context is created, used and freed by the reader thread that
// owns the scaler; nothing else holds the pointer.
unsafe impl Send for Scaler {}

impl Scaler {
    fn new(
        input: (format::Pixel, u32, u32),
        (width, height): (u32, u32),
        bt709: bool,
    ) -> Option<Self> {
        let flags = if width < input.1 {
            software::scaling::Flags::AREA
        } else {
            software::scaling::Flags::BILINEAR
        };
        let source: ffmpeg::ffi::AVPixelFormat = input.0.into();
        let threads = std::thread::available_parallelism()
            .map_or(1, |count| count.get())
            .min(SCALER_THREADS) as i64;
        unsafe {
            let context = ffmpeg::ffi::sws_alloc_context();
            if context.is_null() {
                return None;
            }
            let scaler = Self {
                context,
                input,
                output: frame::Video::new(format::Pixel::RGBA, width, height),
            };
            let options = [
                (c"srcw", i64::from(input.1)),
                (c"srch", i64::from(input.2)),
                (c"src_format", source as i64),
                (c"dstw", i64::from(width)),
                (c"dsth", i64::from(height)),
                (
                    c"dst_format",
                    ffmpeg::ffi::AVPixelFormat::AV_PIX_FMT_RGBA as i64,
                ),
                (c"sws_flags", i64::from(flags.bits())),
            ];
            for (name, value) in options {
                if ffmpeg::ffi::av_opt_set_int(context.cast(), name.as_ptr(), value, 0) < 0 {
                    return None;
                }
            }
            // Without threading support this stays a single-threaded scaler.
            ffmpeg::ffi::av_opt_set_int(context.cast(), c"threads".as_ptr(), threads, 0);
            if ffmpeg::ffi::sws_init_context(context, std::ptr::null_mut(), std::ptr::null_mut())
                < 0
            {
                return None;
            }
            if bt709 {
                crate::decoder::use_bt709_source_raw(context);
            }
            Some(scaler)
        }
    }

    fn run(&mut self, decoded: &frame::Video) -> bool {
        unsafe {
            ffmpeg::ffi::sws_scale_frame(self.context, self.output.as_mut_ptr(), decoded.as_ptr())
                >= 0
        }
    }
}

impl Drop for Scaler {
    fn drop(&mut self) {
        unsafe { ffmpeg::ffi::sws_freeContext(self.context) };
    }
}

struct Reader {
    path: PathBuf,
    max_dimension: u32,
    decoder: cap_video_decode::FFmpegDecoder,
    seconds_per_tick: f64,
    start_ticks: i64,
    frame_interval: f64,
    duration: f64,
    scaler: Option<Scaler>,
    head: Vec<Arc<VideoBackgroundFrame>>,
    head_is_whole_clip: bool,
    ring: VecDeque<Arc<VideoBackgroundFrame>>,
    at_end: bool,
    last_time: Option<f64>,
    last_served: f64,
    /// Only set while requests come further apart than the clip's frames.
    request_interval: Option<f64>,
    pending: Option<(f64, frame::Video)>,
    last_frame_duration: Option<f64>,
    quarter_turns: u32,
    sample_aspect: (i32, i32),
    unreachable_anchor: Option<f64>,
    #[cfg(test)]
    seeks: usize,
    #[cfg(test)]
    scaled: usize,
}

fn hardware_device() -> Option<ffmpeg::sys::AVHWDeviceType> {
    #[cfg(target_os = "windows")]
    {
        Some(AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA)
    }
    #[cfg(target_os = "macos")]
    {
        Some(AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}

fn open_decoder(path: &Path) -> Result<cap_video_decode::FFmpegDecoder, String> {
    let is_gif = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("gif"));
    let hardware = if is_gif { None } else { hardware_device() };
    cap_video_decode::FFmpegDecoder::new(path, hardware)
}

fn covering_frame<'a>(
    frames: impl IntoIterator<Item = &'a Arc<VideoBackgroundFrame>>,
    time: f64,
) -> Option<&'a Arc<VideoBackgroundFrame>> {
    frames
        .into_iter()
        .take_while(|frame| frame.time <= time + TIME_EPSILON)
        .last()
        .filter(|frame| frame.end > time + TIME_EPSILON)
}

/// Phones store portrait video as landscape pixels plus a display matrix.
fn display_quarter_turns(stream: &ffmpeg::format::stream::Stream) -> u32 {
    unsafe {
        let parameters = stream.parameters().as_ptr();
        let side_data = ffmpeg::ffi::av_packet_side_data_get(
            (*parameters).coded_side_data,
            (*parameters).nb_coded_side_data,
            ffmpeg::ffi::AVPacketSideDataType::AV_PKT_DATA_DISPLAYMATRIX,
        );
        if side_data.is_null() || (*side_data).size < 9 * 4 {
            return 0;
        }
        quarter_turns_from_matrix(&*((*side_data).data as *const [i32; 9]))
    }
}

fn quarter_turns_from_matrix(matrix: &[i32; 9]) -> u32 {
    let counter_clockwise = unsafe { ffmpeg::ffi::av_display_rotation_get(matrix.as_ptr()) };
    if !counter_clockwise.is_finite() {
        return 0;
    }
    ((-counter_clockwise / 90.0).round() as i64).rem_euclid(4) as u32
}

fn rotate_rgba(data: &[u8], width: u32, height: u32, quarter_turns: u32) -> (Vec<u8>, u32, u32) {
    let (width, height) = (width as usize, height as usize);
    let (out_width, out_height) = if quarter_turns % 2 == 1 {
        (height, width)
    } else {
        (width, height)
    };
    let mut out = vec![0u8; data.len()];
    const TILE: usize = 64;
    for tile_y in (0..height).step_by(TILE) {
        for tile_x in (0..width).step_by(TILE) {
            for y in tile_y..(tile_y + TILE).min(height) {
                for x in tile_x..(tile_x + TILE).min(width) {
                    let (to_x, to_y) = match quarter_turns {
                        1 => (height - 1 - y, x),
                        2 => (width - 1 - x, height - 1 - y),
                        3 => (y, width - 1 - x),
                        _ => (x, y),
                    };
                    let from = (y * width + x) * 4;
                    let to = (to_y * out_width + to_x) * 4;
                    out[to..to + 4].copy_from_slice(&data[from..from + 4]);
                }
            }
        }
    }
    (out, out_width as u32, out_height as u32)
}

fn output_size(
    width: u32,
    height: u32,
    sample_aspect: (i32, i32),
    max_dimension: u32,
) -> (u32, u32) {
    let display_width = match sample_aspect {
        (numerator, denominator) if numerator > 0 && denominator > 0 => {
            f64::from(width) * f64::from(numerator) / f64::from(denominator)
        }
        _ => f64::from(width),
    };
    let height = f64::from(height);
    let longest = display_width.max(height).max(1.0);
    let scale = (f64::from(max_dimension) / longest).min(1.0);
    let even = |value: f64| ((value * scale).round() as u32).max(2) & !1;
    (even(display_width), even(height))
}

impl Reader {
    fn open(path: PathBuf, max_dimension: u32, head_budget_bytes: usize) -> Result<Self, String> {
        let probe = format::input(&path).map_err(|error| format!("open video / {error}"))?;
        let stream = probe
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or_else(|| "no video stream".to_string())?;
        let time_base = stream.time_base();
        let seconds_per_tick =
            f64::from(time_base.numerator()) / f64::from(time_base.denominator().max(1));
        let rate = stream.avg_frame_rate();
        let frame_interval = if rate.numerator() > 0 && rate.denominator() > 0 {
            f64::from(rate.denominator()) / f64::from(rate.numerator())
        } else {
            1.0 / 30.0
        };
        let duration = if stream.duration() > 0 {
            stream.duration() as f64 * seconds_per_tick
        } else if probe.duration() > 0 {
            probe.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE)
        } else {
            0.0
        };
        let quarter_turns = display_quarter_turns(&stream);
        let sample_aspect = unsafe {
            let ratio = (*stream.parameters().as_ptr()).sample_aspect_ratio;
            (ratio.num, ratio.den)
        };
        let start_ticks = match stream.start_time() {
            ffmpeg::ffi::AV_NOPTS_VALUE => 0,
            start => start,
        };
        drop(probe);

        let mut reader = Self {
            decoder: open_decoder(&path)?,
            path,
            max_dimension: max_dimension.max(2),
            seconds_per_tick,
            start_ticks,
            frame_interval,
            duration,
            scaler: None,
            head: Vec::new(),
            head_is_whole_clip: false,
            ring: VecDeque::new(),
            at_end: false,
            last_time: None,
            last_served: 0.0,
            request_interval: None,
            pending: None,
            last_frame_duration: None,
            quarter_turns,
            sample_aspect,
            unreachable_anchor: None,
            #[cfg(test)]
            seeks: 0,
            #[cfg(test)]
            scaled: 0,
        };
        reader.fill_head(head_budget_bytes)?;
        Ok(reader)
    }

    fn fill_head(&mut self, budget_bytes: usize) -> Result<(), String> {
        let mut bytes = 0;
        while self.head.len() < MIN_HEAD_FRAMES || bytes < budget_bytes {
            let Some(frame) = self.decode_next() else {
                self.head_is_whole_clip = true;
                break;
            };
            bytes += frame.data.len();
            self.head.push(frame);
        }
        let Some(last) = self.head.last() else {
            return Err("video has no frames".to_string());
        };
        self.ring.push_back(last.clone());
        Ok(())
    }

    fn run(mut self, requests: mpsc::Receiver<FrameRequest>) {
        loop {
            let request = if self.wants_prefetch() {
                match requests.try_recv() {
                    Ok(request) => Some(request),
                    Err(mpsc::TryRecvError::Empty) => None,
                    Err(mpsc::TryRecvError::Disconnected) => return,
                }
            } else {
                match requests.recv() {
                    Ok(request) => Some(request),
                    Err(_) => return,
                }
            };

            match request {
                Some(request) => {
                    let frame = self.frame_at(request.seconds);
                    let _ = request.reply.send(frame);
                }
                None => self.prefetch(),
            }
        }
    }

    fn clip_time(&self, seconds: f64) -> f64 {
        if !seconds.is_finite() || seconds <= 0.0 {
            0.0
        } else if self.duration > 0.0 {
            seconds.rem_euclid(self.duration)
        } else {
            seconds
        }
    }

    fn frame_at(&mut self, seconds: f64) -> Option<Arc<VideoBackgroundFrame>> {
        let time = self.clip_time(seconds);
        let step = time - self.last_served;
        self.request_interval =
            (step > self.frame_interval * 1.5 && step < SEEK_THRESHOLD_SECS).then_some(step);
        self.last_served = time;

        if self.head_is_whole_clip {
            return covering_frame(&self.head, time)
                .or_else(|| self.head.first())
                .cloned();
        }
        if let Some(frame) = covering_frame(&self.head, time) {
            return Some(frame.clone());
        }
        if time < self.head[0].time {
            return Some(self.head[0].clone());
        }
        if let Some(frame) = covering_frame(&self.ring, time) {
            return Some(frame.clone());
        }

        // Anything before the newest frame's end that isn't covered landed in
        // a gap read-ahead skipped, and only a seek can go back for it.
        let close_ahead = self.ring.back().is_some_and(|last| {
            !self.at_end
                && time + TIME_EPSILON >= last.end
                && time - last.time < SEEK_THRESHOLD_SECS
        });
        if !close_ahead {
            self.seek(time);
        }
        self.decode_until(time)
    }

    fn decode_until(&mut self, time: f64) -> Option<Arc<VideoBackgroundFrame>> {
        loop {
            self.trim_before(time);
            if let Some(frame) = covering_frame(&self.ring, time) {
                return Some(frame.clone());
            }
            // A seek can land after the target; decoding on would never come back.
            if let Some(first) = self.ring.front()
                && first.time > time + TIME_EPSILON
            {
                return Some(first.clone());
            }
            if self.at_end {
                return self.ring.back().cloned();
            }
            match self.next_shown(|frame_time| frame_time.max(time)) {
                Some(frame) => self.ring.push_back(frame),
                None => self.at_end = true,
            }
        }
    }

    fn trim_before(&mut self, time: f64) {
        while self.ring.len() >= 2 && self.ring[1].time <= time + TIME_EPSILON {
            self.ring.pop_front();
        }
    }

    /// Where reading ahead continues from: just after the cached head while
    /// the head is playing, otherwise the last frame handed out.
    fn prefetch_anchor(&self) -> f64 {
        let head_end = self.head.last().map_or(0.0, |frame| frame.time);
        self.last_served.max(head_end)
    }

    fn ring_is_positioned(&self, anchor: f64) -> bool {
        match (self.ring.front(), self.ring.back()) {
            (Some(first), Some(last)) => {
                first.time <= anchor + TIME_EPSILON
                    && (self.at_end || anchor - last.time < SEEK_THRESHOLD_SECS)
            }
            _ => false,
        }
    }

    fn wants_prefetch(&self) -> bool {
        if self.head_is_whole_clip {
            return false;
        }
        let anchor = self.prefetch_anchor();
        if !self.ring_is_positioned(anchor) {
            return self.unreachable_anchor != Some(anchor);
        }
        !self.at_end
            && self
                .ring
                .iter()
                .filter(|frame| frame.time > anchor + TIME_EPSILON)
                .count()
                < PREFETCH_FRAMES
    }

    fn prefetch(&mut self) {
        let anchor = self.prefetch_anchor();
        if !self.ring_is_positioned(anchor) {
            self.seek(anchor);
            self.decode_until(anchor);
            if !self.ring_is_positioned(anchor) {
                self.unreachable_anchor = Some(anchor);
            }
            return;
        }
        self.trim_before(anchor);
        let interval = self.request_interval;
        let next = self.next_shown(|frame_time| match interval {
            Some(interval) if frame_time > anchor => {
                anchor + ((frame_time - anchor) / interval - TIME_EPSILON).ceil() * interval
            }
            _ => frame_time.max(anchor),
        });
        match next {
            Some(frame) => self.ring.push_back(frame),
            None => self.at_end = true,
        }
    }

    fn seek(&mut self, time: f64) {
        #[cfg(test)]
        {
            self.seeks += 1;
        }
        self.ring.clear();
        self.pending = None;
        self.at_end = false;
        self.last_time = None;
        let target = time + self.start_ticks as f64 * self.seconds_per_tick;
        if time <= TIME_EPSILON || self.decoder.reset(target as f32).is_err() {
            match open_decoder(&self.path) {
                Ok(decoder) => self.decoder = decoder,
                Err(error) => {
                    tracing::warn!("Failed to reopen video background: {error}");
                    self.at_end = true;
                }
            }
        }
    }

    fn decode_next(&mut self) -> Option<Arc<VideoBackgroundFrame>> {
        self.next_shown(|frame_time| frame_time)
    }

    /// A frame whose successor starts by `first_request_at(frame time)` is
    /// never shown, so it's dropped unscaled: decoding forward from a keyframe
    /// after a seek, or a clip with more frames than the output, would
    /// otherwise pay for conversions nobody sees.
    fn next_shown(
        &mut self,
        first_request_at: impl Fn(f64) -> f64,
    ) -> Option<Arc<VideoBackgroundFrame>> {
        let mut errors = 0;
        loop {
            let (time, decoded) = match self.pending.take() {
                Some(pending) => pending,
                None => self.decode_raw()?,
            };
            self.pending = self.decode_raw();
            if let Some((next_time, _)) = &self.pending
                && *next_time <= first_request_at(time) + TIME_EPSILON
            {
                continue;
            }
            #[cfg(test)]
            {
                self.scaled += 1;
            }
            match self.scale(&decoded) {
                Some((data, width, height)) => {
                    let end = self
                        .pending
                        .as_ref()
                        .map_or(f64::INFINITY, |(next_time, _)| *next_time);
                    return Some(Arc::new(VideoBackgroundFrame {
                        data,
                        width,
                        height,
                        time,
                        end,
                    }));
                }
                None => {
                    errors += 1;
                    if errors >= MAX_DECODE_ERRORS {
                        self.pending = None;
                        return self.reached_end();
                    }
                }
            }
        }
    }

    fn decode_raw(&mut self) -> Option<(f64, frame::Video)> {
        let mut errors = 0;
        loop {
            let decoded = match self.decoder.frames().next() {
                Some(Ok(decoded)) => decoded,
                Some(Err(error)) => {
                    errors += 1;
                    if errors >= MAX_DECODE_ERRORS {
                        tracing::warn!("Video background decode failed: {error}");
                        return self.reached_end();
                    }
                    continue;
                }
                None => return self.reached_end(),
            };

            let time = match decoded.timestamp().or(decoded.pts()) {
                Some(ticks) => (ticks - self.start_ticks) as f64 * self.seconds_per_tick,
                None => self
                    .last_time
                    .map_or(0.0, |last| last + self.frame_interval),
            };
            if let Some(last) = self.last_time
                && time > last
            {
                self.frame_interval = time - last;
            }
            self.last_time = Some(time);
            let ticks = unsafe { (*decoded.as_ptr()).duration };
            self.last_frame_duration = (ticks > 0).then_some(ticks as f64 * self.seconds_per_tick);
            return Some((time.max(0.0), decoded));
        }
    }

    /// Container durations can be missing or wrong, and a GIF can hold its
    /// last frame far longer than the others, so the last frame's own
    /// duration wins over both.
    fn reached_end<T>(&mut self) -> Option<T> {
        if let Some(last) = self.last_time {
            let end = match self.last_frame_duration {
                Some(duration) => last + duration,
                None if self.duration > last + TIME_EPSILON => self.duration,
                None => last + self.frame_interval,
            };
            if end > 0.0 {
                self.duration = end;
            }
        }
        None
    }

    fn scale(&mut self, decoded: &frame::Video) -> Option<(Vec<u8>, u32, u32)> {
        let input = (decoded.format(), decoded.width(), decoded.height());
        if input.1 == 0 || input.2 == 0 {
            return None;
        }

        if self
            .scaler
            .as_ref()
            .is_none_or(|scaler| scaler.input != input)
        {
            // Frames copied out of a hardware surface lose their aspect ratio.
            let sample_aspect = match decoded.aspect_ratio() {
                ratio if ratio.numerator() > 0 && ratio.denominator() > 0 => {
                    (ratio.numerator(), ratio.denominator())
                }
                _ => self.sample_aspect,
            };
            let size = output_size(input.1, input.2, sample_aspect, self.max_dimension);
            let bt709 = decoded.color_space() == ffmpeg::util::color::Space::BT709;
            self.scaler = Some(Scaler::new(input, size, bt709)?);
        }

        let scaler = self.scaler.as_mut()?;
        if !scaler.run(decoded) {
            return None;
        }

        let width = scaler.output.width();
        let height = scaler.output.height();
        let row_bytes = width as usize * 4;
        let stride = scaler.output.stride(0);
        let source = scaler.output.data(0);
        let mut data = Vec::with_capacity(row_bytes * height as usize);
        for row in 0..height as usize {
            let start = row * stride;
            data.extend_from_slice(&source[start..start + row_bytes]);
        }
        if self.quarter_turns != 0 {
            return Some(rotate_rgba(&data, width, height, self.quarter_turns));
        }
        Some((data, width, height))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Delay, Frame, Rgba, RgbaImage, codecs::gif::GifEncoder};

    const COLOURS: [[u8; 3]; 4] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];

    fn write_gif(path: &Path, width: u32, height: u32, frames_per_colour: usize) {
        let file = std::fs::File::create(path).unwrap();
        let mut encoder = GifEncoder::new(file);
        encoder
            .set_repeat(image::codecs::gif::Repeat::Infinite)
            .unwrap();
        for colour in COLOURS {
            for _ in 0..frames_per_colour {
                let image = RgbaImage::from_pixel(
                    width,
                    height,
                    Rgba([colour[0], colour[1], colour[2], 255]),
                );
                encoder
                    .encode_frame(Frame::from_parts(
                        image,
                        0,
                        0,
                        Delay::from_numer_denom_ms(100, 1),
                    ))
                    .unwrap();
            }
        }
    }

    fn colour_index(frame: &VideoBackgroundFrame) -> usize {
        let pixel = &frame.data[..3];
        COLOURS
            .iter()
            .position(|colour| {
                colour
                    .iter()
                    .zip(pixel)
                    .all(|(expected, actual)| expected.abs_diff(*actual) < 40)
            })
            .unwrap_or_else(|| panic!("unexpected colour {pixel:?}"))
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
    }

    #[test]
    fn recognises_video_and_gif_paths() {
        assert!(is_video_background("/a/b/clip.MP4"));
        assert!(is_video_background("loop.gif"));
        assert!(is_video_background("c.webm"));
        assert!(!is_video_background("wallpaper.jpg"));
        assert!(!is_video_background("no-extension"));
    }

    #[test]
    fn decode_size_steps_with_the_output() {
        assert_eq!(video_background_max_dimension((600, 400), 8192), 640);
        assert_eq!(video_background_max_dimension((1280, 720), 8192), 1280);
        assert_eq!(video_background_max_dimension((3840, 2160), 8192), 1920);
        assert_eq!(video_background_max_dimension((3840, 2160), 1024), 1024);
    }

    #[test]
    fn small_gif_plays_and_loops_from_memory() {
        ffmpeg::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("loop.gif");
        write_gif(&path, 64, 32, 1);

        runtime().block_on(async {
            let source = VideoBackgroundSource::open(path, 1920).await.unwrap();
            for (seconds, expected) in [
                (0.0, 0),
                (0.05, 0),
                (0.15, 1),
                (0.25, 2),
                (0.35, 3),
                (0.45, 0),
                (1.05, 2),
                (0.15, 1),
            ] {
                let frame = source.frame_at(seconds).await.unwrap();
                assert_eq!((frame.width, frame.height), (64, 32));
                assert_eq!(colour_index(&frame), expected, "at {seconds}s");
            }
        });
    }

    #[test]
    fn long_clip_streams_seeks_and_loops() {
        ffmpeg::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("long.gif");
        write_gif(&path, 96, 48, 10);

        runtime().block_on(async {
            let frame_bytes = 64 * 32 * 4;
            let source = VideoBackgroundSource::open_with_head_budget(path, 64, frame_bytes * 5)
                .await
                .unwrap();
            let mut seconds = 0.0;
            while seconds < 9.0 {
                let frame = source.frame_at(seconds).await.unwrap();
                assert_eq!((frame.width, frame.height), (64, 32));
                let expected = ((seconds % 4.0) / 1.0) as usize;
                assert_eq!(colour_index(&frame), expected, "at {seconds}s");
                seconds += 0.25;
            }
            for (seconds, expected) in [(3.5, 3), (0.5, 0), (2.5, 2), (1.5, 1), (5.5, 1)] {
                let frame = source.frame_at(seconds).await.unwrap();
                assert_eq!(colour_index(&frame), expected, "at {seconds}s");
            }
        });
    }

    #[test]
    fn playing_forward_without_read_ahead_never_seeks() {
        ffmpeg::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("forward.gif");
        write_gif(&path, 96, 48, 10);

        let mut reader = Reader::open(path, 64, 64 * 32 * 4 * 5).unwrap();
        for frame in 0..40 {
            let seconds = frame as f64 / 10.0;
            let served = reader.frame_at(seconds).unwrap();
            assert_eq!(colour_index(&served), frame / 10, "at {seconds}s");
        }
        assert_eq!(reader.seeks, 0);
    }

    #[test]
    fn seeking_scales_only_the_frame_it_lands_on() {
        ffmpeg::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("seek.gif");
        write_gif(&path, 96, 48, 10);

        let mut reader = Reader::open(path, 64, 64 * 32 * 4 * 2).unwrap();
        let after_head = reader.scaled;
        let served = reader.frame_at(3.05).unwrap();
        assert_eq!(colour_index(&served), 3);
        assert_eq!(reader.seeks, 1);
        assert!(
            reader.scaled - after_head <= 2,
            "scaled {} frames to show one",
            reader.scaled - after_head
        );
    }

    #[test]
    fn sparse_requests_skip_frames_between_them() {
        ffmpeg::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sparse.gif");
        write_gif(&path, 96, 48, 10);

        let mut reader = Reader::open(path, 64, 64 * 32 * 4 * 2).unwrap();
        let after_head = reader.scaled;
        for request in 0..20 {
            let seconds = request as f64 * 0.2;
            let served = reader.frame_at(seconds).unwrap();
            assert_eq!(colour_index(&served), request / 5, "at {seconds}s");
            while reader.wants_prefetch() {
                reader.prefetch();
            }
        }
        assert_eq!(reader.seeks, 0);
        let scaled = reader.scaled - after_head;
        assert!(
            scaled <= 24,
            "scaled {scaled} frames for 20 requests over 40 frames"
        );
    }

    #[test]
    fn threaded_scaler_matches_a_single_threaded_one() {
        ffmpeg::init().unwrap();
        let (width, height) = (1280, 720);
        let mut source = frame::Video::new(format::Pixel::NV12, width, height);
        for plane in 0..2 {
            let stride = source.stride(plane);
            let rows = if plane == 0 { height } else { height / 2 } as usize;
            let data = source.data_mut(plane);
            for row in 0..rows {
                for column in 0..width as usize {
                    data[row * stride + column] = ((row * 7 + column * 3 + plane * 50) % 256) as u8;
                }
            }
        }
        let mut threaded =
            Scaler::new((format::Pixel::NV12, width, height), (640, 360), true).unwrap();
        assert!(threaded.run(&source));

        let mut reference = software::scaling::Context::get(
            format::Pixel::NV12,
            width,
            height,
            format::Pixel::RGBA,
            640,
            360,
            software::scaling::Flags::AREA,
        )
        .unwrap();
        unsafe { crate::decoder::use_bt709_source_raw(reference.as_mut_ptr()) };
        let mut expected = frame::Video::new(format::Pixel::RGBA, 640, 360);
        reference.run(&source, &mut expected).unwrap();

        for row in 0..360 {
            let actual = &threaded.output.data(0)[row * threaded.output.stride(0)..][..640 * 4];
            let wanted = &expected.data(0)[row * expected.stride(0)..][..640 * 4];
            assert_eq!(actual, wanted, "row {row}");
        }
    }

    fn write_gif_frames(path: &Path, frames: &[(usize, u32)]) {
        let file = std::fs::File::create(path).unwrap();
        let mut encoder = GifEncoder::new(file);
        encoder
            .set_repeat(image::codecs::gif::Repeat::Infinite)
            .unwrap();
        for &(colour, delay_ms) in frames {
            let [r, g, b] = COLOURS[colour];
            let image = RgbaImage::from_pixel(96, 48, Rgba([r, g, b, 255]));
            encoder
                .encode_frame(Frame::from_parts(
                    image,
                    0,
                    0,
                    Delay::from_numer_denom_ms(delay_ms, 1),
                ))
                .unwrap();
        }
    }

    #[test]
    fn request_in_a_gap_read_ahead_skipped_gets_its_own_frame() {
        ffmpeg::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("gaps.gif");
        let frames: Vec<_> = (0..40).map(|index| (index % 4, 100)).collect();
        write_gif_frames(&path, &frames);

        let mut reader = Reader::open(path, 64, 64 * 32 * 4 * 2).unwrap();
        for seconds in [0.5, 1.0] {
            reader.frame_at(seconds).unwrap();
            while reader.wants_prefetch() {
                reader.prefetch();
            }
        }
        for (seconds, frame) in [(1.7, 17), (2.05, 20), (2.3, 23)] {
            let served = reader.frame_at(seconds).unwrap();
            assert_eq!(colour_index(&served), frame % 4, "at {seconds}s");
        }
    }

    #[test]
    fn gif_loops_after_its_last_frame_is_held() {
        ffmpeg::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("held.gif");
        write_gif_frames(&path, &[(0, 100), (1, 100), (2, 2000)]);

        let mut reader = Reader::open(path, 64, HEAD_BUDGET_BYTES).unwrap();
        for (seconds, expected) in [(0.05, 0), (0.15, 1), (1.0, 2), (2.1, 2), (2.25, 0)] {
            let served = reader.frame_at(seconds).unwrap();
            assert_eq!(colour_index(&served), expected, "at {seconds}s");
        }
    }

    #[test]
    fn display_matrix_turns_into_clockwise_quarter_turns() {
        // av_display_rotation_set takes a clockwise angle; phones tag portrait
        // video with a clockwise 90°.
        for (clockwise, expected) in [(0.0, 0), (90.0, 1), (180.0, 2), (-90.0, 3)] {
            let mut matrix = [0i32; 9];
            unsafe { ffmpeg::ffi::av_display_rotation_set(matrix.as_mut_ptr(), clockwise) };
            assert_eq!(quarter_turns_from_matrix(&matrix), expected, "{clockwise}°");
        }
    }

    #[test]
    fn rotation_moves_pixels_clockwise() {
        let pixels: Vec<u8> = (0..6u8).flat_map(|value| [value; 4]).collect();
        let at = |data: &[u8], width: u32, x: u32, y: u32| data[((y * width + x) * 4) as usize];

        let (turned, width, height) = rotate_rgba(&pixels, 3, 2, 1);
        assert_eq!((width, height), (2, 3));
        assert_eq!([at(&turned, 2, 0, 0), at(&turned, 2, 1, 0)], [3, 0]);
        assert_eq!([at(&turned, 2, 0, 2), at(&turned, 2, 1, 2)], [5, 2]);

        let (flipped, width, _) = rotate_rgba(&pixels, 3, 2, 2);
        assert_eq!(at(&flipped, width, 0, 0), 5);

        let (back, width, height) = rotate_rgba(&pixels, 3, 2, 3);
        assert_eq!((width, height), (2, 3));
        assert_eq!([at(&back, 2, 0, 0), at(&back, 2, 1, 0)], [2, 5]);
    }

    #[test]
    fn non_square_pixels_keep_their_display_shape() {
        assert_eq!(output_size(720, 576, (64, 45), 1920), (1024, 576));
        assert_eq!(output_size(1920, 1080, (1, 1), 960), (960, 540));
        assert_eq!(output_size(1920, 1080, (0, 1), 960), (960, 540));
        assert_eq!(output_size(1440, 1080, (4, 3), 1920), (1920, 1080));
    }

    #[test]
    fn poster_is_the_first_frame_scaled_down() {
        ffmpeg::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("poster.gif");
        write_gif(&path, 96, 48, 1);

        let (data, width, height) = video_background_poster(&path, 48).unwrap();
        assert_eq!((width, height), (48, 24));
        let frame = VideoBackgroundFrame {
            data,
            width,
            height,
            time: 0.0,
            end: f64::INFINITY,
        };
        assert_eq!(colour_index(&frame), 0);
    }

    #[test]
    fn missing_file_fails_to_open() {
        ffmpeg::init().unwrap();
        let result = runtime().block_on(VideoBackgroundSource::open(
            PathBuf::from("/definitely/not/here.mp4"),
            640,
        ));
        assert!(result.is_err());
    }
}
