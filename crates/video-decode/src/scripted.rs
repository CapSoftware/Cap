//! Scripted media for decoder model tests, compiled only with the `scripted`
//! feature (enabled by test builds, never by the app). A script is a list of
//! video samples with exact presentation times and sync flags. Registering it
//! yields a path; opening that path with the real decoders reads the script
//! instead of a file, so everything above the container and the native reader
//! runs unchanged.
//!
//! Modelled container and reader behaviour:
//! - FFmpeg: `seek(ts)` lands on the newest sync sample at or before `ts`
//!   (the first sample when there is none), as `avformat_seek_file` with
//!   `max_ts = ts` does for MP4. Decoding then vends every sample from there in
//!   presentation order.
//! - AVAssetReader: a reader started at time `T` vends the sample on screen at
//!   `T` (the newest at or before it) and every later one. When that sample
//!   starts before `T` its presentation time is trimmed to `T`. A reader started
//!   at or after the end of the track vends nothing. A read set up with
//!   [`Registration::fail_avf_read_at`] fails like a decode error: the reader
//!   vends nothing more and reports the failure.
//!
//! Every vended frame carries its sample index in its first luma row, see
//! [`frame_id`].

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

const MAGIC: [u8; 4] = *b"CAPS";
pub const FRAME_WIDTH: u32 = 16;
pub const FRAME_HEIGHT: u32 = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScriptFrame {
    pub pts: i64,
    pub keyframe: bool,
}

#[derive(Clone, Debug)]
pub struct Script {
    /// Stream time base as (numerator, denominator).
    pub time_base: (i32, i32),
    /// Samples in strictly increasing presentation order.
    pub frames: Vec<ScriptFrame>,
    /// Duration of the last sample, in time base ticks.
    pub last_duration: i64,
}

impl Script {
    pub fn end_pts(&self) -> i64 {
        self.frames.last().map_or(0, |frame| frame.pts) + self.last_duration
    }

    pub fn secs(&self, ticks: i64) -> f64 {
        ticks as f64 * self.time_base.0 as f64 / self.time_base.1 as f64
    }

    pub fn duration_secs(&self) -> f64 {
        self.secs(self.end_pts() - self.frames.first().map_or(0, |frame| frame.pts))
    }

    /// Average frame rate as the MP4 demuxer reports it: sample count over
    /// track duration.
    pub fn avg_fps(&self) -> f64 {
        let duration = self.duration_secs();
        if duration > 0.0 {
            self.frames.len() as f64 / duration
        } else {
            30.0
        }
    }

    fn validate(&self) {
        assert!(self.time_base.0 > 0 && self.time_base.1 > 0);
        assert!(!self.frames.is_empty(), "scripts need at least one frame");
        assert!(
            self.frames[0].keyframe,
            "the first sample must be a sync sample"
        );
        assert!(self.last_duration > 0);
        assert!(
            self.frames.windows(2).all(|pair| pair[0].pts < pair[1].pts),
            "sample presentation times must increase"
        );
    }
}

#[derive(Default)]
struct Counters {
    reader_starts: AtomicU64,
    seeks: AtomicU64,
}

pub(crate) struct ScriptState {
    pub(crate) script: Script,
    counters: Counters,
    vend_delay_micros: AtomicU64,
    vended: Mutex<Vec<u32>>,
    failing_samples: Mutex<Vec<usize>>,
    #[cfg(target_os = "macos")]
    samples: Mutex<HashMap<usize, avf::SharedSample>>,
}

impl ScriptState {
    fn record_vend(&self, index: usize) {
        let delay = self.vend_delay_micros.load(Ordering::Relaxed);
        if delay > 0 {
            std::thread::sleep(Duration::from_micros(delay));
        }
        self.vended.lock().unwrap().push(index as u32);
    }

    #[cfg(target_os = "macos")]
    fn take_failure(&self, index: usize) -> bool {
        let mut failing = self.failing_samples.lock().unwrap();
        let Some(position) = failing.iter().position(|&sample| sample == index) else {
            return false;
        };
        failing.swap_remove(position);
        true
    }

    /// Whether `pts` (in stream ticks) is at or before `value / scale` seconds.
    #[cfg(target_os = "macos")]
    fn at_or_before(&self, pts: i64, value: i64, scale: i32) -> bool {
        let (num, den) = self.script.time_base;
        (pts as i128) * (num as i128) * (scale as i128) <= (value as i128) * (den as i128)
    }

    #[cfg(target_os = "macos")]
    fn newest_at_or_before(&self, value: i64, scale: i32) -> Option<usize> {
        self.script
            .frames
            .partition_point(|frame| self.at_or_before(frame.pts, value, scale))
            .checked_sub(1)
    }
}

fn registry() -> &'static Mutex<HashMap<PathBuf, Arc<ScriptState>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Arc<ScriptState>>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

pub(crate) fn lookup(path: &Path) -> Option<Arc<ScriptState>> {
    registry().lock().unwrap().get(path).cloned()
}

/// Frame dimensions of a registered script, for probes that would otherwise
/// open the path as a file.
pub fn dimensions(path: &Path) -> Option<(u32, u32)> {
    lookup(path).map(|_| (FRAME_WIDTH, FRAME_HEIGHT))
}

/// A registered script. Dropping it unregisters the path.
pub struct Registration {
    path: PathBuf,
    state: Arc<ScriptState>,
}

impl Registration {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn script(&self) -> &Script {
        &self.state.script
    }

    /// Sample indices vended by every reader of this script since the last call.
    pub fn take_vended(&self) -> Vec<u32> {
        std::mem::take(&mut *self.state.vended.lock().unwrap())
    }

    /// Every reader of this script sleeps this long before each vend, so a
    /// test can act while a read is still in progress.
    pub fn set_vend_delay(&self, delay: Duration) {
        let micros = u64::try_from(delay.as_micros()).unwrap_or(u64::MAX);
        self.state
            .vend_delay_micros
            .store(micros, Ordering::Relaxed);
    }

    /// AVAssetReader starts: creations and resets.
    pub fn reader_starts(&self) -> u64 {
        self.state.counters.reader_starts.load(Ordering::Relaxed)
    }

    /// FFmpeg demuxer seeks.
    pub fn seeks(&self) -> u64 {
        self.state.counters.seeks.load(Ordering::Relaxed)
    }

    /// The next AVAssetReader that reaches `index` fails there instead of
    /// vending it, as a native reader does with a decode error: it vends
    /// nothing more and reports the failure. Once per call.
    pub fn fail_avf_read_at(&self, index: usize) {
        self.state.failing_samples.lock().unwrap().push(index);
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        registry().lock().unwrap().remove(&self.path);
    }
}

pub fn register(script: Script) -> Registration {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    script.validate();
    let path = PathBuf::from(format!(
        "/nonexistent/cap-scripted-media/{}-{}.mp4",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let state = Arc::new(ScriptState {
        script,
        counters: Counters::default(),
        vend_delay_micros: AtomicU64::new(0),
        vended: Mutex::new(Vec::new()),
        failing_samples: Mutex::new(Vec::new()),
        #[cfg(target_os = "macos")]
        samples: Mutex::new(HashMap::new()),
    });
    registry()
        .lock()
        .unwrap()
        .insert(path.clone(), state.clone());
    Registration { path, state }
}

fn identity_row(index: u32) -> [u8; FRAME_WIDTH as usize] {
    let mut row = [0u8; FRAME_WIDTH as usize];
    row[..4].copy_from_slice(&MAGIC);
    row[4..8].copy_from_slice(&index.to_le_bytes());
    row[8..12].copy_from_slice(&(!index).to_le_bytes());
    row
}

/// The sample index a decoded frame was made from: reads the first luma row of
/// the frame's raw planes.
pub fn frame_id(first_row: &[u8]) -> Option<u32> {
    if first_row.len() < 12 || first_row[..4] != MAGIC {
        return None;
    }
    let index = u32::from_le_bytes(first_row[4..8].try_into().ok()?);
    let check = u32::from_le_bytes(first_row[8..12].try_into().ok()?);
    (check == !index).then_some(index)
}

pub(crate) struct Demuxer {
    state: Arc<ScriptState>,
    next: usize,
}

impl Demuxer {
    pub(crate) fn new(state: Arc<ScriptState>) -> Self {
        Self { state, next: 0 }
    }

    pub(crate) fn start_time(&self) -> i64 {
        self.state.script.frames[0].pts
    }

    pub(crate) fn time_base(&self) -> ffmpeg::Rational {
        let (num, den) = self.state.script.time_base;
        ffmpeg::Rational::new(num, den)
    }

    /// `position` is in `AV_TIME_BASE` units, as `avformat_seek_file` receives
    /// it with no stream index.
    pub(crate) fn seek(&mut self, position: i64) -> Result<(), ffmpeg::Error> {
        self.state.counters.seeks.fetch_add(1, Ordering::Relaxed);
        let (num, den) = self.state.script.time_base;
        let ticks = rescale_rounded(position, den as i64, 1_000_000 * num as i64);
        let frames = &self.state.script.frames;
        let at_or_before = frames.partition_point(|frame| frame.pts <= ticks);
        self.next = frames[..at_or_before]
            .iter()
            .rposition(|frame| frame.keyframe)
            .unwrap_or(0);
        Ok(())
    }

    pub(crate) fn next_frame(&mut self) -> Option<ffmpeg::frame::Video> {
        let frame = self.state.script.frames.get(self.next)?;
        let index = self.next;
        self.next += 1;
        self.state.record_vend(index);
        let mut video =
            ffmpeg::frame::Video::new(ffmpeg::format::Pixel::YUV420P, FRAME_WIDTH, FRAME_HEIGHT);
        video.data_mut(0).fill(16);
        let row = identity_row(index as u32);
        video.data_mut(0)[..row.len()].copy_from_slice(&row);
        video.data_mut(1).fill(128);
        video.data_mut(2).fill(128);
        video.set_pts(Some(frame.pts));
        Some(video)
    }

    pub(crate) fn open_decoder(&self) -> Result<ffmpeg::decoder::Video, String> {
        let codec = ffmpeg::decoder::find(ffmpeg::codec::Id::RAWVIDEO)
            .or_else(|| ffmpeg::decoder::find(ffmpeg::codec::Id::H264))
            .ok_or("no decoder available for scripted media")?;
        let mut context = ffmpeg::codec::Context::new_with_codec(codec);
        unsafe {
            let raw = context.as_mut_ptr();
            (*raw).width = FRAME_WIDTH as i32;
            (*raw).height = FRAME_HEIGHT as i32;
            (*raw).pix_fmt = ffmpeg::ffi::AVPixelFormat::AV_PIX_FMT_YUV420P;
        }
        let mut decoder = context
            .decoder()
            .video()
            .map_err(|error| format!("scripted decoder / {error}"))?;
        decoder.set_time_base(self.time_base());
        Ok(decoder)
    }
}

/// `a * b / c` rounded half away from zero, as `av_rescale` does.
fn rescale_rounded(a: i64, b: i64, c: i64) -> i64 {
    let product = a as i128 * b as i128;
    let c = c as i128;
    let rounded = if product >= 0 {
        (product + c / 2) / c
    } else {
        (product - c / 2) / c
    };
    rounded as i64
}

#[cfg(target_os = "macos")]
pub(crate) use avf::AvfReader;

#[cfg(target_os = "macos")]
mod avf {
    use super::*;
    use cidre::{arc::R, cm, cv};

    /// Sample buffers are immutable once built and CoreFoundation reference
    /// counting is thread safe, so a script shares them across its readers.
    pub(crate) struct SharedSample(R<cm::SampleBuf>);

    unsafe impl Send for SharedSample {}

    pub(crate) struct AvfReader {
        state: Arc<ScriptState>,
        next: usize,
        trimmed_start: Option<cm::Time>,
        failed: bool,
    }

    impl AvfReader {
        pub(crate) fn start(state: Arc<ScriptState>, start: cm::Time) -> Self {
            state.counters.reader_starts.fetch_add(1, Ordering::Relaxed);
            let script = &state.script;
            let past_end = state.at_or_before(script.end_pts(), start.value, start.scale);
            let (next, trimmed_start) = if past_end {
                (script.frames.len(), None)
            } else {
                match state.newest_at_or_before(start.value, start.scale) {
                    None => (0, None),
                    Some(index) => {
                        let pts = script.frames[index].pts;
                        let (num, den) = script.time_base;
                        let exact = (pts as i128) * (num as i128) * (start.scale as i128)
                            == (start.value as i128) * (den as i128);
                        (index, (!exact).then_some(start))
                    }
                }
            };
            Self {
                state,
                next,
                trimmed_start,
                failed: false,
            }
        }

        pub(crate) fn failed(&self) -> bool {
            self.failed
        }

        pub(crate) fn next_sample_buf(&mut self) -> Option<R<cm::SampleBuf>> {
            if self.failed {
                return None;
            }
            let script = &self.state.script;
            let frame = script.frames.get(self.next)?;
            if self.state.take_failure(self.next) {
                self.failed = true;
                return None;
            }
            let index = self.next;
            self.next += 1;
            self.state.record_vend(index);

            let trimmed = self.trimmed_start.take();
            if trimmed.is_none()
                && let Some(SharedSample(sample)) = self.state.samples.lock().unwrap().get(&index)
            {
                return Some(sample.retained());
            }
            let (num, den) = script.time_base;
            let pts = trimmed.unwrap_or_else(|| cm::Time::new(frame.pts * num as i64, den));
            let end = script
                .frames
                .get(index + 1)
                .map_or(script.end_pts(), |next| next.pts);
            let duration = cm::Time::new((end - frame.pts) * num as i64, den);

            let mut pixel_buf = cv::PixelBuf::new(
                FRAME_WIDTH as usize,
                FRAME_HEIGHT as usize,
                cv::PixelFormat::_420V,
                None,
            )
            .ok()?;
            unsafe {
                pixel_buf
                    .lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
                    .result()
                    .ok()?;
                let row = identity_row(index as u32);
                for plane in 0..2 {
                    let bytes =
                        pixel_buf.plane_bytes_per_row(plane) * pixel_buf.plane_height(plane);
                    let base = pixel_buf.plane_base_address(plane) as *mut u8;
                    std::ptr::write_bytes(base, if plane == 0 { 16 } else { 128 }, bytes);
                    if plane == 0 {
                        std::ptr::copy_nonoverlapping(row.as_ptr(), base, row.len());
                    }
                }
                pixel_buf.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT);
            }
            let format = cm::VideoFormatDesc::with_image_buf(&pixel_buf).ok()?;
            let timing = cm::SampleTimingInfo {
                duration,
                pts,
                dts: cm::Time::invalid(),
            };
            let sample = cm::SampleBuf::with_image_buf(
                &pixel_buf,
                true,
                None,
                std::ptr::null(),
                &format,
                &timing,
            )
            .ok()?;
            if trimmed.is_none() {
                self.state
                    .samples
                    .lock()
                    .unwrap()
                    .insert(index, SharedSample(sample.retained()));
            }
            Some(sample)
        }
    }
}
