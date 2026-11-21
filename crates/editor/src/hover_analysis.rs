use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use cap_project::CursorEvents;
use serde::{Deserialize, Serialize};

/// Bump when detection changes so cached results from older detectors are
/// analysed again.
pub const DETECTOR_VERSION: u32 = 3;

const CACHE_FILE: &str = "cursor-hover.json";

/// Decoding stays on the analysis thread itself: decoder worker threads would
/// not inherit its background priority on every platform.
const ANALYSIS_DECODE_THREADS: usize = 1;
const PAUSE_POLL: std::time::Duration = std::time::Duration::from_millis(200);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HoverCache {
    version: u32,
    display_bytes: u64,
    changes_ms: Vec<f64>,
}

fn cache_path(display: &Path) -> Option<PathBuf> {
    Some(display.parent()?.join(CACHE_FILE))
}

fn display_bytes(display: &Path) -> Option<u64> {
    let metadata = std::fs::metadata(display).ok()?;
    metadata.is_file().then_some(metadata.len())
}

pub fn cached_changes(display: &Path) -> Option<Vec<f64>> {
    let file = std::fs::read(cache_path(display)?).ok()?;
    let cache: HoverCache = serde_json::from_slice(&file).ok()?;
    (cache.version == DETECTOR_VERSION && Some(cache.display_bytes) == display_bytes(display))
        .then_some(cache.changes_ms)
}

pub fn needs_analysis(display: &Path) -> bool {
    display_bytes(display).is_some() && cached_changes(display).is_none()
}

fn write_cache(display: &Path, changes_ms: &[f64]) -> Result<(), String> {
    let path = cache_path(display).ok_or("display video has no folder")?;
    let cache = HoverCache {
        version: DETECTOR_VERSION,
        display_bytes: display_bytes(display).ok_or("display video is missing")?,
        changes_ms: changes_ms.to_vec(),
    };
    let partial = path.with_extension("json.partial");
    std::fs::write(
        &partial,
        serde_json::to_vec(&cache).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&partial, &path).map_err(|e| e.to_string())
}

/// Every display video the analysis has opened, so tests can prove it never
/// decodes anything for projects that have not asked for it.
#[cfg(test)]
pub(crate) static OPENED_FOR_TEST: std::sync::Mutex<Vec<PathBuf>> =
    std::sync::Mutex::new(Vec::new());

/// `cursor_offset_ms` is added to video timestamps to reach cursor time.
/// Waits while `should_pause` holds (playback, an export). Returns
/// `Ok(None)` when cancelled, without saving anything.
pub fn analyze(
    display: &Path,
    cursor: &CursorEvents,
    cursor_offset_ms: f64,
    cancel: &AtomicBool,
    should_pause: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(f32),
) -> Result<Option<Vec<f64>>, String> {
    #[cfg(test)]
    OPENED_FOR_TEST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(display.to_path_buf());
    let mut input = ffmpeg::format::input(&display).map_err(|e| format!("open video: {e}"))?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or("no video stream")?;
    let stream_index = stream.index();
    let time_base = stream.time_base();
    let seconds_per_tick =
        f64::from(time_base.numerator()) / f64::from(time_base.denominator()).max(1.0);
    let duration_secs = (stream.duration() as f64 * seconds_per_tick).max(0.001);

    let mut context = ffmpeg::codec::Context::from_parameters(stream.parameters())
        .map_err(|e| format!("video params: {e}"))?;
    context.set_threading(ffmpeg::threading::Config::count(ANALYSIS_DECODE_THREADS));
    let mut decoder = context.decoder();
    decoder.skip_loop_filter(ffmpeg::Discard::All);
    let mut decoder = decoder.video().map_err(|e| format!("video decoder: {e}"))?;
    decoder.set_packet_time_base(time_base);

    let mut downscale = Downscale::new(decoder.format(), decoder.width(), decoder.height())?;
    let (width, height) = (downscale.width(), downscale.height());

    let pointer = PointerTrack::new(cursor);
    let mut detector = HoverDetector::new(width as usize, height as usize);
    let mut decoded = ffmpeg::frame::Video::empty();
    let mut drain = |decoder: &mut ffmpeg::decoder::Video,
                     detector: &mut HoverDetector|
     -> Result<(), String> {
        while decoder.receive_frame(&mut decoded).is_ok() {
            let luma = downscale.run(&decoded)?;
            let ticks = decoded.timestamp().or_else(|| decoded.pts()).unwrap_or(0);
            let video_secs = ticks as f64 * seconds_per_tick;
            let time_ms = video_secs * 1000.0 + cursor_offset_ms;
            let position = pointer.position(time_ms).and_then(|(x, y)| {
                let (px, py) = (x * f64::from(width), y * f64::from(height));
                (px >= 0.0 && py >= 0.0 && px < f64::from(width) && py < f64::from(height))
                    .then_some((px as usize, py as usize))
            });
            detector.push(time_ms, luma, position, pointer.busy(time_ms));
            progress((video_secs / duration_secs).clamp(0.0, 1.0) as f32);
        }
        Ok(())
    };

    for (packet_stream, packet) in input.packets() {
        while should_pause() && !cancel.load(Ordering::Relaxed) {
            std::thread::sleep(PAUSE_POLL);
        }
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        if packet_stream.index() != stream_index {
            continue;
        }
        decoder
            .send_packet(&packet)
            .map_err(|e| format!("send packet: {e}"))?;
        drain(&mut decoder, &mut detector)?;
    }
    decoder.send_eof().map_err(|e| format!("send eof: {e}"))?;
    drain(&mut decoder, &mut detector)?;

    let changes = detector.finish();
    write_cache(display, &changes)?;
    Ok(Some(changes))
}

enum Downscale {
    Luma(LumaBox),
    Scaler {
        scaler: ffmpeg::software::scaling::context::Context,
        gray: ffmpeg::frame::Video,
        width: u32,
        height: u32,
    },
}

const MAX_ANALYSIS_WIDTH: u32 = 720;

impl Downscale {
    fn new(format: ffmpeg::format::Pixel, width: u32, height: u32) -> Result<Self, String> {
        use ffmpeg::format::Pixel;

        let factor = [1, 2, 4, 8]
            .into_iter()
            .find(|factor| width / factor <= MAX_ANALYSIS_WIDTH)
            .unwrap_or(8);
        let out_width = (width / factor / 2 * 2).max(2);
        let out_height = (height / factor / 2 * 2).max(2);
        let full_range = match format {
            Pixel::YUVJ420P | Pixel::YUVJ422P | Pixel::YUVJ444P | Pixel::GRAY8 => true,
            Pixel::YUV420P | Pixel::YUV422P | Pixel::YUV444P | Pixel::NV12 | Pixel::NV21 => false,
            _ => {
                let scaler = ffmpeg::software::scaling::context::Context::get(
                    format,
                    width,
                    height,
                    Pixel::GRAY8,
                    out_width,
                    out_height,
                    ffmpeg::software::scaling::flag::Flags::AREA,
                )
                .map_err(|e| format!("create scaler: {e}"))?;
                return Ok(Self::Scaler {
                    scaler,
                    gray: ffmpeg::frame::Video::empty(),
                    width: out_width,
                    height: out_height,
                });
            }
        };
        Ok(Self::Luma(LumaBox::new(
            (width, height),
            factor as usize,
            (out_width as usize, out_height as usize),
            full_range,
        )))
    }

    fn width(&self) -> u32 {
        match self {
            Self::Luma(luma) => luma.width as u32,
            Self::Scaler { width, .. } => *width,
        }
    }

    fn height(&self) -> u32 {
        match self {
            Self::Luma(luma) => luma.height as u32,
            Self::Scaler { height, .. } => *height,
        }
    }

    fn run(&mut self, frame: &ffmpeg::frame::Video) -> Result<Vec<u8>, String> {
        match self {
            Self::Luma(luma) => {
                if (frame.width(), frame.height()) != luma.source {
                    return Err(format!(
                        "frame size changed to {}x{}",
                        frame.width(),
                        frame.height()
                    ));
                }
                Ok(luma.reduce(frame.data(0), frame.stride(0)))
            }
            Self::Scaler {
                scaler,
                gray,
                width,
                height,
            } => {
                scaler
                    .run(frame, gray)
                    .map_err(|e| format!("scale frame: {e}"))?;
                let (width, height) = (*width as usize, *height as usize);
                let mut luma = Vec::with_capacity(width * height);
                for row in gray.data(0).chunks(gray.stride(0)).take(height) {
                    luma.extend_from_slice(&row[..width]);
                }
                Ok(luma)
            }
        }
    }
}

/// Averages `factor` x `factor` blocks of an 8-bit luma plane, eight source
/// pixels per u64: release builds optimise for size, which leaves a per-byte
/// loop unvectorised and slower than swscale.
struct LumaBox {
    source: (u32, u32),
    factor: usize,
    width: usize,
    height: usize,
    lanes: Vec<(u64, u64)>,
    levels: Vec<u8>,
}

const EVEN_BYTES: u64 = 0x00FF_00FF_00FF_00FF;
const EVEN_PAIRS: u64 = 0x0000_FFFF_0000_FFFF;
const LOW_HALF: u64 = 0x0000_0000_FFFF_FFFF;

impl LumaBox {
    fn new(source: (u32, u32), factor: usize, size: (usize, usize), full_range: bool) -> Self {
        let area = (factor * factor) as f64;
        let levels = (0..=factor * factor * 255)
            .map(|sum| {
                let mean = sum as f64 / area;
                let level = if full_range {
                    mean
                } else {
                    (mean - 16.0) * 255.0 / 219.0
                };
                level.round().clamp(0.0, 255.0) as u8
            })
            .collect();
        Self {
            source,
            factor,
            width: size.0,
            height: size.1,
            lanes: vec![(0, 0); (size.0 * factor).div_ceil(8)],
            levels,
        }
    }

    fn reduce(&mut self, plane: &[u8], stride: usize) -> Vec<u8> {
        let factor = self.factor;
        let span = self.width * factor;
        let levels = self.levels.as_slice();
        let mut luma = Vec::with_capacity(self.width * self.height);
        for out_row in 0..self.height {
            self.lanes.fill((0, 0));
            for row in out_row * factor..(out_row + 1) * factor {
                let start = row * stride;
                accumulate_row(&mut self.lanes, &plane[start..start + span]);
            }
            let row_start = luma.len();
            for &(even, odd) in &self.lanes {
                match factor {
                    1 => {
                        for lane in 0..4 {
                            luma.push(levels[(even >> (lane * 16)) as u16 as usize]);
                            luma.push(levels[(odd >> (lane * 16)) as u16 as usize]);
                        }
                    }
                    2 => {
                        let pairs = even + odd;
                        for lane in 0..4 {
                            luma.push(levels[(pairs >> (lane * 16)) as u16 as usize]);
                        }
                    }
                    4 => {
                        let quads = fold_pairs(even + odd);
                        luma.push(levels[(quads & LOW_HALF) as usize]);
                        luma.push(levels[(quads >> 32) as usize]);
                    }
                    _ => {
                        let quads = fold_pairs(even + odd);
                        luma.push(levels[((quads & LOW_HALF) + (quads >> 32)) as usize]);
                    }
                }
            }
            luma.truncate(row_start + self.width);
        }
        luma
    }
}

fn fold_pairs(pairs: u64) -> u64 {
    (pairs & EVEN_PAIRS) + ((pairs >> 16) & EVEN_PAIRS)
}

fn accumulate_row(lanes: &mut [(u64, u64)], row: &[u8]) {
    let (words, rest) = row.as_chunks::<8>();
    for (lane, word) in lanes.iter_mut().zip(words) {
        add_word(lane, u64::from_le_bytes(*word));
    }
    if !rest.is_empty() {
        let mut word = [0; 8];
        word[..rest.len()].copy_from_slice(rest);
        add_word(&mut lanes[words.len()], u64::from_le_bytes(word));
    }
}

fn add_word(lane: &mut (u64, u64), word: u64) {
    lane.0 += word & EVEN_BYTES;
    lane.1 += (word >> 8) & EVEN_BYTES;
}

/// Background priority for the calling thread, so the analysis only uses
/// time the editor, playback and other apps leave idle.
pub fn lower_thread_priority() {
    #[cfg(target_os = "macos")]
    {
        const QOS_CLASS_BACKGROUND: u32 = 0x09;
        unsafe extern "C" {
            fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
        }
        // SAFETY: only changes the scheduling class of the calling thread.
        unsafe { pthread_set_qos_class_self_np(QOS_CLASS_BACKGROUND, 0) };
    }
    #[cfg(target_os = "linux")]
    {
        const PRIO_PROCESS: i32 = 0;
        unsafe extern "C" {
            fn setpriority(which: i32, who: u32, priority: i32) -> i32;
        }
        // SAFETY: on Linux `who == 0` with PRIO_PROCESS sets only the
        // calling thread's nice value.
        unsafe { setpriority(PRIO_PROCESS, 0, 19) };
    }
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN,
        };
        // SAFETY: only changes the priority of the calling thread.
        let _ = unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) };
    }
}

struct PointerTrack {
    moves: Vec<(f64, f64, f64)>,
    clicks: Vec<f64>,
    held: Vec<(f64, f64)>,
}

/// Clicks and drags already anchor the cursor, and their own feedback
/// (pressed buttons, selections, drawing) would read as hover changes.
const CLICK_GUARD_MS: f64 = 150.0;
const IDLE_GAP_MS: f64 = 66.0;

impl PointerTrack {
    fn new(cursor: &CursorEvents) -> Self {
        let mut moves: Vec<(f64, f64, f64)> =
            cursor.moves.iter().map(|m| (m.time_ms, m.x, m.y)).collect();
        moves.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut clicks: Vec<_> = cursor.clicks.iter().collect();
        clicks.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
        // A held stretch lasts from the first press until every button pressed
        // during it is released, so letting go of one button while another is
        // still down keeps the guard on.
        let mut held = Vec::new();
        let mut pressed = [false; 2];
        let mut down_at = None;
        for click in &clicks {
            let button = usize::from(click.cursor_num);
            if button >= pressed.len() {
                continue;
            }
            if click.down {
                pressed[button] = true;
                down_at.get_or_insert(click.time_ms);
            } else if std::mem::take(&mut pressed[button])
                && !pressed.contains(&true)
                && let Some(start) = down_at.take()
            {
                held.push((start, click.time_ms));
            }
        }
        if let Some(start) = down_at {
            held.push((start, f64::INFINITY));
        }
        Self {
            moves,
            clicks: clicks.iter().map(|click| click.time_ms).collect(),
            held,
        }
    }

    fn position(&self, time_ms: f64) -> Option<(f64, f64)> {
        let moves = &self.moves;
        let next = moves.partition_point(|m| m.0 <= time_ms);
        let (a, b) = match (next.checked_sub(1).map(|i| moves[i]), moves.get(next)) {
            (None, None) => return None,
            (None, Some(b)) => return Some((b.1, b.2)),
            (Some(a), None) => return Some((a.1, a.2)),
            (Some(a), Some(b)) => (a, *b),
        };
        if b.0 - a.0 > IDLE_GAP_MS {
            return Some((a.1, a.2));
        }
        let u = (time_ms - a.0) / (b.0 - a.0).max(1e-9);
        Some((a.1 + (b.1 - a.1) * u, a.2 + (b.2 - a.2) * u))
    }

    fn busy(&self, time_ms: f64) -> bool {
        let next = self
            .clicks
            .partition_point(|&t| t < time_ms - CLICK_GUARD_MS);
        if self
            .clicks
            .get(next)
            .is_some_and(|&t| t <= time_ms + CLICK_GUARD_MS)
        {
            return true;
        }
        self.held
            .iter()
            .any(|&(start, end)| start <= time_ms && time_ms <= end)
    }
}

struct Frame {
    time_ms: f64,
    luma: Vec<u8>,
    pointer: Option<(usize, usize)>,
    busy: bool,
    active: bool,
    global: f32,
}

/// Thresholds are tuned at a 395 px wide analysis frame and scaled with the
/// analysis width, so a probe covers the same share of the screen at any size.
const TUNED_WIDTH: f32 = 395.0;
const PROBE_RADIUS: f32 = 26.0;
const MAX_SHIFT: f32 = 60.0;
const STILL_POINTER: f32 = 3.0;
const PIXEL_THRESHOLD: u8 = 12;
const ACTIVE_FRACTION: f32 = 0.004;
const NET_CHANGE_FRACTION: f32 = 0.02;
const MAX_BURST_MS: f64 = 250.0;
/// Quiet is measured in time, not frames: an animation recorded at a higher
/// frame rate than it runs repeats frames, so a single unchanged frame does
/// not mean the picture has settled.
const QUIET_MS: f64 = 100.0;
const GLOBAL_LIMIT: f32 = 0.2;
const SCROLL_RATIO: f32 = 0.5;
/// A plain patch matches any shifted plain patch, so a highlight switching
/// off would read as a scroll; only textured content can be seen to move.
const MIN_SCROLL_TEXTURE: f32 = 6.0;
const MERGE_MS: f64 = 120.0;
const RING_FRAMES: usize = 48;

/// Streams frames and reports short, isolated bursts of change around the
/// pointer: quiet before and after, a visibly different picture at some point,
/// not most of the screen, not while a button is held, and not content sliding
/// past a still pointer (scrolling). Continuous change (video, animation)
/// never goes quiet and is ignored.
struct HoverDetector {
    width: usize,
    height: usize,
    probe_radius: usize,
    max_shift: i32,
    still_pointer: f32,
    frames: VecDeque<Frame>,
    first_index: usize,
    burst: Option<Burst>,
    last_active_ms: Option<f64>,
    changes: Vec<f64>,
}

#[derive(Clone, Copy)]
struct Burst {
    start: usize,
    end: usize,
    end_ms: f64,
    quiet_before: bool,
}

impl HoverDetector {
    fn new(width: usize, height: usize) -> Self {
        let scale = width as f32 / TUNED_WIDTH;
        Self {
            width,
            height,
            probe_radius: (PROBE_RADIUS * scale).round() as usize,
            max_shift: (MAX_SHIFT * scale).round() as i32,
            still_pointer: STILL_POINTER * scale,
            frames: VecDeque::with_capacity(RING_FRAMES),
            first_index: 0,
            burst: None,
            last_active_ms: None,
            changes: Vec::new(),
        }
    }

    fn frame(&self, index: usize) -> Option<&Frame> {
        self.frames.get(index.checked_sub(self.first_index)?)
    }

    fn push(&mut self, time_ms: f64, luma: Vec<u8>, pointer: Option<(usize, usize)>, busy: bool) {
        let mut frame = Frame {
            time_ms,
            luma,
            pointer,
            busy,
            active: false,
            global: 0.0,
        };
        if let Some(previous) = self.frames.back() {
            let activity = [frame.pointer, previous.pointer]
                .into_iter()
                .flatten()
                .map(|(x, y)| self.changed_fraction(&previous.luma, &frame.luma, x, y))
                .fold(0.0, f32::max);
            frame.active = activity >= ACTIVE_FRACTION;
            frame.global = global_fraction(&previous.luma, &frame.luma);
        }

        let index = self.first_index + self.frames.len();
        if self.frames.len() == RING_FRAMES {
            self.frames.pop_front();
            self.first_index += 1;
        }
        let active = frame.active;
        self.frames.push_back(frame);

        if active {
            match self.burst {
                Some(burst) if time_ms - burst.end_ms < QUIET_MS => {
                    self.burst = Some(Burst {
                        end: index,
                        end_ms: time_ms,
                        ..burst
                    });
                }
                previous => {
                    if let Some(burst) = previous {
                        self.evaluate(burst, index - 1);
                    }
                    let quiet_before = index > self.first_index
                        && self
                            .last_active_ms
                            .is_none_or(|last| time_ms - last >= QUIET_MS);
                    self.burst = Some(Burst {
                        start: index,
                        end: index,
                        end_ms: time_ms,
                        quiet_before,
                    });
                }
            }
            self.last_active_ms = Some(time_ms);
        } else if let Some(burst) = self.burst
            && time_ms - burst.end_ms >= QUIET_MS
        {
            self.burst = None;
            self.evaluate(burst, index);
        }
    }

    fn evaluate(&mut self, burst: Burst, after: usize) {
        let Burst {
            start,
            end,
            quiet_before,
            ..
        } = burst;
        if !quiet_before {
            return;
        }
        let (Some(first), Some(last), Some(before)) =
            (self.frame(start), self.frame(end), self.frame(start - 1))
        else {
            return;
        };
        if last.time_ms - first.time_ms > MAX_BURST_MS {
            return;
        }
        let probes: Vec<(usize, usize)> = [first.pointer, before.pointer]
            .into_iter()
            .flatten()
            .collect();
        let Some(&(cx, cy)) = probes.first() else {
            return;
        };
        let net = (start..=after)
            .filter_map(|i| self.frame(i))
            .flat_map(|frame| {
                probes
                    .iter()
                    .map(|&(x, y)| self.changed_fraction(&before.luma, &frame.luma, x, y))
            })
            .fold(0.0, f32::max);
        if net < NET_CHANGE_FRACTION {
            return;
        }
        let in_burst = start..=end;
        if in_burst.clone().any(|i| {
            self.frame(i)
                .is_none_or(|f| f.busy || f.global > GLOBAL_LIMIT)
        }) {
            return;
        }
        let scrolled = self.content_moved_past_pointer(start - 1, after, cx, cy)
            || in_burst
                .clone()
                .any(|i| self.content_moved_past_pointer(i - 1, i, cx, cy));
        if scrolled {
            return;
        }
        let time_ms = first.time_ms;
        if self
            .changes
            .last()
            .is_none_or(|&last| time_ms - last > MERGE_MS)
        {
            self.changes.push(time_ms);
        }
    }

    fn finish(mut self) -> Vec<f64> {
        if let Some(burst) = self.burst.take() {
            let last = self.first_index + self.frames.len() - 1;
            self.evaluate(burst, last);
        }
        self.changes
    }

    fn probe_bounds(&self, cx: usize, cy: usize) -> (usize, usize, usize, usize) {
        let r = self.probe_radius;
        (
            cx.saturating_sub(r),
            (cx + r).min(self.width - 1),
            cy.saturating_sub(r),
            (cy + r).min(self.height - 1),
        )
    }

    fn changed_fraction(&self, a: &[u8], b: &[u8], cx: usize, cy: usize) -> f32 {
        let (x0, x1, y0, y1) = self.probe_bounds(cx, cy);
        let mut changed = 0u32;
        let mut total = 0u32;
        for y in y0..=y1 {
            let row = y * self.width;
            for x in x0..=x1 {
                total += 1;
                changed += u32::from(a[row + x].abs_diff(b[row + x]) > PIXEL_THRESHOLD);
            }
        }
        changed as f32 / total.max(1) as f32
    }

    fn mean_difference(&self, a: &[u8], b: &[u8], cx: usize, cy: usize, dx: i32, dy: i32) -> f32 {
        let (x0, x1, y0, y1) = self.probe_bounds(cx, cy);
        let (w, h) = (self.width as i32, self.height as i32);
        let mut sum = 0u64;
        let mut count = 0u64;
        for y in y0 as i32..=y1 as i32 {
            let sy = y + dy;
            if !(0..h).contains(&sy) {
                continue;
            }
            for x in x0 as i32..=x1 as i32 {
                let sx = x + dx;
                if !(0..w).contains(&sx) {
                    continue;
                }
                sum += u64::from(a[(sy * w + sx) as usize].abs_diff(b[(y * w + x) as usize]));
                count += 1;
            }
        }
        if count == 0 {
            f32::INFINITY
        } else {
            sum as f32 / count as f32
        }
    }

    fn spread(&self, luma: &[u8], cx: usize, cy: usize) -> f32 {
        let (x0, x1, y0, y1) = self.probe_bounds(cx, cy);
        let mut sum = 0f32;
        let mut sum_sq = 0f32;
        let mut count = 0f32;
        for y in y0..=y1 {
            for &value in &luma[y * self.width + x0..=y * self.width + x1] {
                let value = f32::from(value);
                sum += value;
                sum_sq += value * value;
                count += 1.0;
            }
        }
        let mean = sum / count.max(1.0);
        (sum_sq / count.max(1.0) - mean * mean).max(0.0).sqrt()
    }

    /// Scrolling slides content past a pointer that stays put; a hover
    /// change can look like a shift too (the highlight hopping to the next
    /// button) but the pointer moves with it.
    fn content_moved_past_pointer(&self, from: usize, to: usize, cx: usize, cy: usize) -> bool {
        let (Some(a), Some(b)) = (self.frame(from), self.frame(to)) else {
            return false;
        };
        let travel = match (a.pointer, b.pointer) {
            (Some(pa), Some(pb)) => {
                ((pa.0 as f32 - pb.0 as f32).powi(2) + (pa.1 as f32 - pb.1 as f32).powi(2)).sqrt()
            }
            _ => 0.0,
        };
        if travel >= self.still_pointer || self.spread(&b.luma, cx, cy) < MIN_SCROLL_TEXTURE {
            return false;
        }
        let base = self.mean_difference(&a.luma, &b.luma, cx, cy, 0, 0);
        if base < 0.5 {
            return false;
        }
        let mut best = base;
        for shift in (1..=self.max_shift).filter(|s| *s <= 8 || s % 2 == 0) {
            for (dx, dy) in [(0, shift), (0, -shift), (shift, 0), (-shift, 0)] {
                best = best.min(self.mean_difference(&a.luma, &b.luma, cx, cy, dx, dy));
            }
        }
        best < base * SCROLL_RATIO
    }
}

fn global_fraction(a: &[u8], b: &[u8]) -> f32 {
    let mut changed = 0u32;
    let mut total = 0u32;
    for i in (0..a.len()).step_by(7) {
        total += 1;
        changed += u32::from(a[i].abs_diff(b[i]) > PIXEL_THRESHOLD);
    }
    changed as f32 / total.max(1) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 120;
    const H: usize = 80;

    fn blank() -> Vec<u8> {
        vec![240; W * H]
    }

    fn with_rect(
        mut luma: Vec<u8>,
        x0: usize,
        y0: usize,
        w: usize,
        h: usize,
        value: u8,
    ) -> Vec<u8> {
        for y in y0..y0 + h {
            for x in x0..x0 + w {
                luma[y * W + x] = value;
            }
        }
        luma
    }

    fn run(frames: impl IntoIterator<Item = (Vec<u8>, Option<(usize, usize)>, bool)>) -> Vec<f64> {
        let mut detector = HoverDetector::new(W, H);
        for (i, (luma, pointer, busy)) in frames.into_iter().enumerate() {
            detector.push(i as f64 * 33.0, luma, pointer, busy);
        }
        detector.finish()
    }

    #[test]
    fn a_control_lighting_up_under_the_pointer_is_found() {
        let lit = with_rect(blank(), 40, 30, 40, 16, 60);
        let frames = (0..10).map(|i| {
            (
                if i < 5 { blank() } else { lit.clone() },
                Some((60, 38)),
                false,
            )
        });
        assert_eq!(run(frames), vec![5.0 * 33.0]);
    }

    #[test]
    fn nothing_changing_finds_nothing() {
        let frames = (0..20).map(|i| (blank(), Some((10 + i, 38)), false));
        assert!(run(frames).is_empty());
    }

    #[test]
    fn changes_while_the_button_is_held_are_ignored() {
        let lit = with_rect(blank(), 40, 30, 40, 16, 60);
        let frames = (0..10).map(|i| {
            (
                if i < 5 { blank() } else { lit.clone() },
                Some((60, 38)),
                true,
            )
        });
        assert!(run(frames).is_empty());
    }

    #[test]
    fn continuous_change_under_the_pointer_is_ignored() {
        let frames = (0..30).map(|i| {
            let value = if i % 2 == 0 { 40 } else { 200 };
            (
                with_rect(blank(), 40, 30, 40, 16, value),
                Some((60, 38)),
                false,
            )
        });
        assert!(run(frames).is_empty());
    }

    #[test]
    fn an_animation_with_repeated_frames_is_ignored() {
        let frames = (0..40).map(|i| {
            let value = if (i / 2) % 2 == 0 { 40 } else { 200 };
            (
                with_rect(blank(), 40, 30, 40, 16, value),
                Some((60, 38)),
                false,
            )
        });
        assert!(run(frames).is_empty());
    }

    #[test]
    fn a_control_that_flashes_for_one_frame_is_found() {
        let lit = with_rect(blank(), 40, 30, 40, 16, 60);
        let frames = (0..12).map(|i| {
            (
                if i == 5 { lit.clone() } else { blank() },
                Some((60, 38)),
                false,
            )
        });
        assert_eq!(run(frames), vec![5.0 * 33.0]);
    }

    #[test]
    fn content_scrolling_under_a_still_pointer_is_ignored() {
        let page = |offset: usize| {
            let mut luma = blank();
            for line in 0..12 {
                let y = (line * 9 + 80 - offset % 80) % 76;
                luma = with_rect(luma, 20, y, 80, 3, 30);
            }
            luma
        };
        let frames = (0..12).map(|i| (page(if i < 6 { 0 } else { 6 }), Some((60, 40)), false));
        assert!(run(frames).is_empty());
    }

    fn clicks(events: &[(u8, bool, f64)]) -> CursorEvents {
        CursorEvents {
            clicks: events
                .iter()
                .map(|&(button, down, time_ms)| cap_project::CursorClickEvent {
                    active_modifiers: Vec::new(),
                    cursor_num: button,
                    cursor_id: "arrow".into(),
                    time_ms,
                    down,
                })
                .collect(),
            moves: Vec::new(),
        }
    }

    #[test]
    fn releasing_one_button_keeps_the_guard_while_another_is_held() {
        // Hold the first button, tap the second, then drag on until 3000 ms.
        let track = PointerTrack::new(&clicks(&[
            (0, true, 1000.0),
            (1, true, 1500.0),
            (1, false, 1600.0),
            (0, false, 3000.0),
        ]));
        assert!(track.busy(2000.0));
        assert!(track.busy(2900.0));
        assert!(!track.busy(3400.0));

        // The other order: the second button is the one held longest.
        let track = PointerTrack::new(&clicks(&[
            (0, true, 1000.0),
            (1, true, 1500.0),
            (0, false, 1600.0),
            (1, false, 3000.0),
        ]));
        assert!(track.busy(2000.0));
        assert!(!track.busy(3400.0));
    }

    #[test]
    fn a_release_without_its_press_does_not_end_a_held_button() {
        let track = PointerTrack::new(&clicks(&[
            (0, true, 1000.0),
            (1, false, 1500.0),
            (0, false, 3000.0),
        ]));
        assert!(track.busy(2000.0));
        assert!(!track.busy(3400.0));
    }
    fn noise(len: usize, seed: u32) -> Vec<u8> {
        let mut state = seed;
        (0..len)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (state >> 24) as u8
            })
            .collect()
    }

    #[test]
    fn luma_box_averages_every_block_including_a_partial_last_word() {
        for (factor, width, height) in [(1, 718, 6), (2, 362, 5), (4, 98, 4), (8, 50, 3)] {
            let stride = width * factor + 40;
            let plane = noise(stride * height * factor, factor as u32);
            let mut luma = LumaBox::new(
                ((width * factor) as u32, (height * factor) as u32),
                factor,
                (width, height),
                true,
            );
            let expected: Vec<u8> = (0..height)
                .flat_map(|y| (0..width).map(move |x| (x, y)))
                .map(|(x, y)| {
                    let sum: u32 = (0..factor)
                        .flat_map(|dy| (0..factor).map(move |dx| (dx, dy)))
                        .map(|(dx, dy)| {
                            u32::from(plane[(y * factor + dy) * stride + x * factor + dx])
                        })
                        .sum();
                    (f64::from(sum) / (factor * factor) as f64).round() as u8
                })
                .collect();
            assert_eq!(luma.reduce(&plane, stride), expected, "factor {factor}");
        }
    }

    #[test]
    fn luma_box_expands_limited_range_like_swscale() {
        ffmpeg::init().unwrap();
        let (width, height) = (1280, 720);
        let mut downscale = Downscale::new(ffmpeg::format::Pixel::YUV420P, width, height).unwrap();
        assert!(matches!(downscale, Downscale::Luma(_)));
        let mut scaler = ffmpeg::software::scaling::context::Context::get(
            ffmpeg::format::Pixel::YUV420P,
            width,
            height,
            ffmpeg::format::Pixel::GRAY8,
            downscale.width(),
            downscale.height(),
            ffmpeg::software::scaling::flag::Flags::AREA,
        )
        .unwrap();
        let mut gray = ffmpeg::frame::Video::empty();
        for level in [0, 16, 17, 64, 126, 200, 235, 236, 255] {
            let mut frame =
                ffmpeg::frame::Video::new(ffmpeg::format::Pixel::YUV420P, width, height);
            frame.data_mut(0).fill(level);
            frame.data_mut(1).fill(128);
            frame.data_mut(2).fill(128);
            scaler.run(&frame, &mut gray).unwrap();
            let luma = downscale.run(&frame).unwrap();
            assert_eq!(
                luma.len(),
                (downscale.width() * downscale.height()) as usize
            );
            assert!(
                luma.iter()
                    .all(|&value| value.abs_diff(gray.data(0)[0]) <= 1),
                "level {level}: box {} swscale {}",
                luma[0],
                gray.data(0)[0]
            );
        }
    }

    #[test]
    fn analysis_frames_stay_within_720_columns() {
        use ffmpeg::format::Pixel;

        for ((width, height), expected) in [
            ((640, 480), (640, 480)),
            ((1280, 720), (640, 360)),
            ((1920, 1080), (480, 270)),
            ((2560, 1440), (640, 360)),
            ((3024, 1964), (378, 244)),
            ((3840, 2160), (480, 270)),
            ((5120, 2880), (640, 360)),
        ] {
            let downscale = Downscale::new(Pixel::NV12, width, height).unwrap();
            assert!(matches!(downscale, Downscale::Luma(_)));
            assert_eq!((downscale.width(), downscale.height()), expected);
        }
        ffmpeg::init().unwrap();
        let fallback = Downscale::new(Pixel::YUV420P10LE, 2560, 1440).unwrap();
        assert!(matches!(fallback, Downscale::Scaler { .. }));
        assert_eq!((fallback.width(), fallback.height()), (640, 360));
    }

    #[test]
    fn caches_from_older_detectors_are_analysed_again() {
        let dir = tempfile::tempdir().unwrap();
        let display = dir.path().join("display.mp4");
        std::fs::write(&display, b"video").unwrap();

        write_cache(&display, &[600.0]).unwrap();
        assert_eq!(cached_changes(&display), Some(vec![600.0]));
        assert!(!needs_analysis(&display));

        let stale = HoverCache {
            version: DETECTOR_VERSION - 1,
            display_bytes: display_bytes(&display).unwrap(),
            changes_ms: vec![600.0],
        };
        std::fs::write(
            cache_path(&display).unwrap(),
            serde_json::to_vec(&stale).unwrap(),
        )
        .unwrap();
        assert_eq!(cached_changes(&display), None);
        assert!(needs_analysis(&display));
    }
}
