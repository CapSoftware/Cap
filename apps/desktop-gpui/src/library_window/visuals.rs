//! What an item shows when it has no picture of its own: the shape of its
//! sound, its length, its first words, or a frame from its video.
//!
//! Everything here is worked out once, off the main thread, and kept in a
//! small cache file next to the thumbnail cache, keyed by the item and the
//! size and modified time of the files it came from. A waveform is 64 bytes,
//! so the whole library's visuals stay a few hundred KB in memory and on disk.

use std::{
    collections::{BTreeMap, HashMap},
    io::Write as _,
    path::{Path, PathBuf},
    sync::Arc,
    time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize};

use super::items::{Item, ItemKey, ItemKind};

pub const BARS: usize = 64;
const CACHE_FILE: &str = "library-visuals.json";
const CACHE_VERSION: u32 = 1;
const STEP_MS: u64 = 100;
/// Transcripts are read only this far for an item's first words.
const TRANSCRIPT_READ_MAX: u64 = 4 * 1024 * 1024;
const EXCERPT_CHARS: usize = 220;

pub type Wave = Arc<[u8; BARS]>;

/// Each field is used only when the item has nothing better already.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Visual {
    pub wave: Option<Wave>,
    pub duration_ms: Option<u64>,
    pub excerpt: Option<String>,
    pub frame: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct Job {
    pub key: ItemKey,
    source: Source,
}

#[derive(Clone, Debug)]
enum Source {
    Meeting {
        dir: PathBuf,
        /// Each file with its start offset in the meeting.
        audio: Vec<(PathBuf, u64)>,
        duration_ms: u64,
        want_text: bool,
    },
    Recording {
        bundle: PathBuf,
        want_frame: bool,
    },
}

impl Job {
    /// The files whose change means the visual must be worked out again.
    fn inputs(&self) -> Vec<PathBuf> {
        match &self.source {
            Source::Meeting { dir, audio, .. } => {
                let mut v: Vec<PathBuf> = audio.iter().map(|(p, _)| p.clone()).collect();
                v.push(dir.join(cap_meetings::library::ENHANCED_FILE));
                v.push(dir.join(cap_meetings::library::TRANSCRIPT_FILE));
                v
            }
            Source::Recording { bundle, .. } => vec![bundle.join("recording-meta.json")],
        }
    }

    fn stamp(&self) -> String {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |v: u128| {
            for byte in v.to_le_bytes() {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x100_0000_01b3);
            }
        };
        for path in self.inputs() {
            match std::fs::metadata(&path) {
                Ok(meta) => {
                    mix(u128::from(meta.len()));
                    mix(meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map_or(0, |d| d.as_millis()));
                }
                Err(_) => mix(u128::MAX),
            }
        }
        let (Source::Meeting { want_text, .. }
        | Source::Recording {
            want_frame: want_text,
            ..
        }) = &self.source;
        mix(u128::from(*want_text));
        format!("{hash:016x}")
    }
}

pub fn meeting_job(
    key: ItemKey,
    dir: PathBuf,
    meeting: &cap_meetings::library::MeetingDetails,
    want_text: bool,
) -> Option<Job> {
    let mut audio: Vec<(PathBuf, u64)> = meeting
        .extra
        .get("audioParts")
        .and_then(|v| v.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| {
                    let file = part.get("file")?.as_str()?;
                    let offset = part.get("offsetMs").and_then(|o| o.as_u64()).unwrap_or(0);
                    Some((dir.join(file), offset))
                })
                .collect()
        })
        .unwrap_or_default();
    if audio.is_empty() {
        audio = meeting
            .audio
            .iter()
            .filter(|t| !t.file.is_empty())
            .map(|t| (dir.join(&t.file), 0))
            .collect();
    }
    if audio.is_empty() && !want_text {
        return None;
    }
    Some(Job {
        key,
        source: Source::Meeting {
            dir,
            audio,
            duration_ms: meeting.duration_ms,
            want_text,
        },
    })
}

pub fn recording_job(key: ItemKey, bundle: PathBuf, has_picture: bool) -> Job {
    Job {
        key,
        source: Source::Recording {
            bundle,
            want_frame: !has_picture,
        },
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Cache {
    version: u32,
    #[serde(default)]
    items: BTreeMap<String, Entry>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    stamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wave: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    frame: Option<PathBuf>,
}

impl Entry {
    fn visual(&self) -> Visual {
        Visual {
            wave: self.wave.as_deref().and_then(wave_from_hex),
            duration_ms: self.duration_ms,
            excerpt: self.excerpt.clone(),
            frame: self.frame.clone().filter(|p| p.is_file()),
        }
    }

    fn new(stamp: String, visual: &Visual) -> Self {
        Self {
            stamp,
            wave: visual.wave.as_deref().map(wave_to_hex),
            duration_ms: visual.duration_ms,
            excerpt: visual.excerpt.clone(),
            frame: visual.frame.clone(),
        }
    }
}

fn key_string(key: &ItemKey) -> String {
    match key {
        ItemKey::Doc(id) => format!("doc:{id}"),
        ItemKey::Path(path) => format!("path:{}", path.to_string_lossy()),
    }
}

fn wave_to_hex(wave: &[u8; BARS]) -> String {
    wave.iter().map(|b| format!("{b:02x}")).collect()
}

fn wave_from_hex(hex: &str) -> Option<Wave> {
    if hex.len() != BARS * 2 {
        return None;
    }
    let mut out = [0u8; BARS];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(Arc::new(out))
}

pub fn cache_dir() -> PathBuf {
    crate::library::thumbnail_cache_dir()
}

fn load_cache(path: &Path) -> Cache {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Cache>(&bytes).ok())
        .filter(|c| c.version == CACHE_VERSION)
        .unwrap_or_default()
}

fn save_cache(path: &Path, cache: &Cache) {
    let Some(dir) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let tmp = dir.join(format!(".{CACHE_FILE}.{}.tmp", std::process::id()));
    let written = serde_json::to_vec(cache)
        .ok()
        .and_then(|json| {
            let mut file = std::fs::File::create(&tmp).ok()?;
            file.write_all(&json).ok()?;
            file.sync_all().ok()
        })
        .is_some();
    if !written || std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Also drops the entries of items no longer in `jobs` (deleted, or emptied
/// from the trash), so their waveform and first words leave the disk now
/// rather than at the next pass that has something to decode.
pub fn cached(jobs: Vec<Job>, dir: &Path) -> (HashMap<ItemKey, Visual>, Vec<(Job, String)>) {
    let path = dir.join(CACHE_FILE);
    let mut cache = load_cache(&path);
    let listed: std::collections::HashSet<String> =
        jobs.iter().map(|job| key_string(&job.key)).collect();
    let before = cache.items.len();
    cache.items.retain(|key, _| listed.contains(key));
    if cache.items.len() != before {
        save_cache(&path, &cache);
    }
    let mut known = HashMap::with_capacity(jobs.len());
    let mut todo = Vec::new();
    for job in jobs {
        let stamp = job.stamp();
        match cache.items.get(&key_string(&job.key)) {
            Some(entry) if entry.stamp == stamp => {
                known.insert(job.key, entry.visual());
            }
            _ => todo.push((job, stamp)),
        }
    }
    (known, todo)
}

/// Blocking: decodes audio and video.
pub fn work(job: &Job, frames_dir: &Path) -> Visual {
    match &job.source {
        Source::Meeting {
            dir,
            audio,
            duration_ms,
            want_text,
        } => {
            let wave = meeting_wave(audio, *duration_ms);
            let excerpt = want_text.then(|| meeting_excerpt(dir)).flatten();
            Visual {
                wave,
                duration_ms: None,
                excerpt,
                frame: None,
            }
        }
        Source::Recording { bundle, want_frame } => {
            recording_visual(bundle, *want_frame, frames_dir)
        }
    }
}

pub fn remember(dir: &Path, done: &[(ItemKey, String, Visual)], keep: &[ItemKey]) {
    let path = dir.join(CACHE_FILE);
    let mut cache = load_cache(&path);
    cache.version = CACHE_VERSION;
    for (key, stamp, visual) in done {
        cache
            .items
            .insert(key_string(key), Entry::new(stamp.clone(), visual));
    }
    let keep: std::collections::HashSet<String> = keep.iter().map(key_string).collect();
    cache.items.retain(|k, _| keep.contains(k));
    save_cache(&path, &cache);
}

#[derive(Default)]
struct Acc {
    steps: Vec<f32>,
    sum: f64,
    count: usize,
    step_len: usize,
    samples: u64,
    rate: u32,
}

impl Acc {
    fn take(&mut self, frame: &ffmpeg::frame::Audio) {
        if self.rate == 0 {
            self.rate = frame.rate().max(1);
            self.step_len = (u64::from(self.rate) * STEP_MS / 1000).max(1) as usize;
        }
        let n = frame.samples();
        let stride = if frame.is_planar() {
            1
        } else {
            usize::from(frame.channels()).max(1)
        };
        // The first channel carries the shape well enough for a picture.
        let data = frame.data(0);
        let (width, read): (usize, fn(&[u8]) -> f32) = match frame.format() {
            ffmpeg::format::Sample::F32(_) => (4, |b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
            ffmpeg::format::Sample::I16(_) => {
                (2, |b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.)
            }
            ffmpeg::format::Sample::I32(_) => (4, |b| {
                i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.
            }),
            _ => return,
        };
        for i in 0..n {
            let at = i * stride * width;
            let Some(bytes) = data.get(at..at + width) else {
                break;
            };
            let s = read(bytes);
            self.sum += f64::from(s * s);
            self.count += 1;
            if self.count == self.step_len {
                self.steps
                    .push((self.sum / self.count as f64).sqrt() as f32);
                self.sum = 0.;
                self.count = 0;
            }
        }
        self.samples += n as u64;
    }
}

/// Streams the file: a long meeting decoded whole would hold hundreds of MB.
fn envelope(path: &Path) -> Option<(Vec<f32>, u64)> {
    let mut input = ffmpeg::format::input(path).ok()?;
    let stream = input.streams().best(ffmpeg::media::Type::Audio)?;
    let index = stream.index();
    let mut decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .ok()?
        .decoder()
        .audio()
        .ok()?;
    let mut acc = Acc::default();
    let mut frame = ffmpeg::frame::Audio::empty();
    for (stream, packet) in input.packets() {
        if stream.index() != index || decoder.send_packet(&packet).is_err() {
            continue;
        }
        while decoder.receive_frame(&mut frame).is_ok() {
            acc.take(&frame);
        }
    }
    let _ = decoder.send_eof();
    while decoder.receive_frame(&mut frame).is_ok() {
        acc.take(&frame);
    }
    if acc.count > 0 {
        acc.steps.push((acc.sum / acc.count as f64).sqrt() as f32);
    }
    if acc.rate == 0 {
        return None;
    }
    Some((acc.steps, acc.samples * 1000 / u64::from(acc.rate)))
}

/// Where files overlap (mic and system audio), the louder one wins.
fn combine(parts: &[(Vec<f32>, u64)], total_ms: u64) -> Option<Wave> {
    let total_steps = (total_ms / STEP_MS).max(1) as usize;
    let mut line = vec![0f32; total_steps];
    for (steps, offset_ms) in parts {
        let start = (*offset_ms / STEP_MS) as usize;
        for (i, v) in steps.iter().enumerate() {
            if let Some(slot) = line.get_mut(start + i) {
                *slot = slot.max(*v);
            }
        }
    }
    bars(&line)
}

/// Peak per bar in decibels, scaled to the loudest bar so a quiet recording
/// still shows its shape.
pub fn bars(line: &[f32]) -> Option<Wave> {
    if line.is_empty() {
        return None;
    }
    let mut out = [0f32; BARS];
    for (b, slot) in out.iter_mut().enumerate() {
        let from = b * line.len() / BARS;
        let to = ((b + 1) * line.len() / BARS).max(from + 1).min(line.len());
        let peak = line[from.min(line.len() - 1)..to]
            .iter()
            .fold(0f32, |m, v| m.max(*v));
        // -54 dB (room noise) to 0 dB.
        let db = if peak > 0. { 20. * peak.log10() } else { -90. };
        *slot = ((db + 54.) / 54.).clamp(0., 1.);
    }
    let top = out.iter().fold(0f32, |m, v| m.max(*v));
    if top <= 0.02 {
        return None;
    }
    let mut wave = [0u8; BARS];
    for (w, v) in wave.iter_mut().zip(out) {
        *w = ((v / top) * 255.).round() as u8;
    }
    Some(Arc::new(wave))
}

fn meeting_wave(audio: &[(PathBuf, u64)], duration_ms: u64) -> Option<Wave> {
    let parts: Vec<(Vec<f32>, u64)> = audio
        .iter()
        .filter_map(|(path, offset)| envelope(path).map(|(steps, _)| (steps, *offset)))
        .collect();
    let longest = parts
        .iter()
        .map(|(steps, offset)| offset + steps.len() as u64 * STEP_MS)
        .max()?;
    combine(&parts, duration_ms.max(longest))
}

fn meeting_excerpt(dir: &Path) -> Option<String> {
    let enhanced = dir.join(cap_meetings::library::ENHANCED_FILE);
    if std::fs::metadata(&enhanced).is_ok_and(|m| m.len() <= 1024 * 1024)
        && let Ok(json) = std::fs::read_to_string(&enhanced)
        && let Ok(doc) = cap_notes::Document::from_json(&json)
        && let Some(text) = crate::meetings_ui::documents::summary_preview(&doc)
    {
        return Some(text);
    }
    let transcript = dir.join(cap_meetings::library::TRANSCRIPT_FILE);
    if std::fs::metadata(&transcript).map_or(true, |m| m.len() > TRANSCRIPT_READ_MAX) {
        return None;
    }
    let (transcript, _) = cap_meetings::transcript::Transcript::load_jsonl(&transcript).ok()?;
    let mut said: Vec<_> = transcript.utterances().iter().collect();
    said.sort_by_key(|u| u.start_ms);
    let mut text = String::new();
    for u in said {
        let line = u.text.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(&line);
        if text.chars().count() > EXCERPT_CHARS {
            break;
        }
    }
    clip(text)
}

fn clip(text: String) -> Option<String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= EXCERPT_CHARS {
        return Some(text);
    }
    let cut: String = text.chars().take(EXCERPT_CHARS).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    Some(format!(
        "{}\u{2026}",
        cut.trim_end_matches([',', ';', ':', '.'])
    ))
}

fn recording_visual(bundle: &Path, want_frame: bool, frames_dir: &Path) -> Visual {
    use cap_project::{RecordingMeta, RecordingMetaInner, StudioRecordingMeta};
    let Ok(meta) = RecordingMeta::load_for_project(bundle) else {
        return Visual::default();
    };
    let mut videos: Vec<PathBuf> = Vec::new();
    let mut audio: Vec<Vec<PathBuf>> = Vec::new();
    let mut audio_only = false;
    match &meta.inner {
        RecordingMetaInner::Studio(studio) => match &**studio {
            StudioRecordingMeta::SingleSegment { segment } => {
                videos.push(meta.path(&segment.display.path));
                audio.push(segment.audio.iter().map(|a| meta.path(&a.path)).collect());
            }
            StudioRecordingMeta::MultipleSegments { inner } => {
                audio_only = inner.audio_only;
                for s in &inner.segments {
                    videos.push(meta.path(&s.display.path));
                    audio.push(
                        s.mic
                            .iter()
                            .chain(s.system_audio.iter())
                            .map(|a| meta.path(&a.path))
                            .collect(),
                    );
                }
            }
        },
        RecordingMetaInner::Instant(_) => videos.push(meta.output_path()),
    }
    if audio_only {
        // Segments play one after another.
        let mut parts = Vec::new();
        let mut at = 0u64;
        for files in &audio {
            let mut longest = 0u64;
            for file in files {
                if let Some((steps, ms)) = envelope(file) {
                    longest = longest.max(ms);
                    parts.push((steps, at));
                }
            }
            at += longest;
        }
        return Visual {
            wave: (at > 0).then(|| combine(&parts, at)).flatten(),
            duration_ms: (at > 0).then_some(at),
            excerpt: None,
            frame: None,
        };
    }
    let duration_ms: u64 = videos.iter().filter_map(|v| video_duration_ms(v)).sum();
    let frame = want_frame
        .then(|| {
            let source = videos.iter().find(|v| v.is_file())?;
            let out = frames_dir.join(format!(
                "{:016x}.jpg",
                fnv(bundle.to_string_lossy().as_bytes())
            ));
            crate::library::write_representative_frame(source, &out).ok()?;
            Some(out)
        })
        .flatten();
    Visual {
        wave: None,
        duration_ms: (duration_ms > 0).then_some(duration_ms),
        excerpt: None,
        frame,
    }
}

fn video_duration_ms(path: &Path) -> Option<u64> {
    let input = ffmpeg::format::input(path).ok()?;
    let d = input.duration();
    (d > 0).then(|| (d as u64) / 1000)
}

fn fnv(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

/// Puts worked-out facts onto the items. A field is filled when it is empty
/// or still holds what `previous` (the visual applied before) put there, so a
/// newer visual for a changed file replaces the older one; a value the item
/// has from its own data is never touched.
pub fn apply(
    items: &mut [Item],
    visuals: &HashMap<ItemKey, Visual>,
    previous: &HashMap<ItemKey, Visual>,
) -> bool {
    fn take<T: Clone + PartialEq>(
        field: &mut Option<T>,
        old: Option<&Option<T>>,
        new: &Option<T>,
    ) -> bool {
        let from_old = old.is_some_and(|old| old.is_some() && old == field);
        if (field.is_none() || from_old) && field != new && (new.is_some() || from_old) {
            *field = new.clone();
            return true;
        }
        false
    }
    let mut changed = false;
    for item in items {
        let Some(v) = visuals.get(&item.key) else {
            continue;
        };
        let old = previous.get(&item.key);
        changed |= take(
            &mut item.duration_ms,
            old.map(|o| &o.duration_ms),
            &v.duration_ms,
        );
        changed |= take(&mut item.excerpt, old.map(|o| &o.excerpt), &v.excerpt);
        if item.kind == ItemKind::Recording {
            changed |= take(&mut item.thumbnail, old.map(|o| &o.frame), &v.frame);
        }
    }
    changed
}

/// A made-up waveform for seeded items (screenshots and benchmarks): speech
/// like, different per item, the same every run.
pub fn seed_wave(seed: usize) -> Wave {
    let mut state = (seed as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % 1000) as f32 / 1000.
    };
    let mut line = Vec::with_capacity(BARS * 4);
    let mut phrase = 0.4f32;
    for k in 0..BARS * 4 {
        if k % 9 == 0 {
            phrase = 0.15 + next() * 0.85;
        }
        let r = next();
        line.push(if r < 0.1 {
            0.003
        } else {
            phrase * (0.25 + r * r * 0.75) * 0.5
        });
    }
    bars(&line).unwrap_or_else(|| Arc::new([128; BARS]))
}

/// List rows draw their waveform as an image made once per wave and theme:
/// painting a quad per bar on every frame cost a row more than an icon did.
/// At most `WAVE_IMAGES` are kept; the oldest are handed back so the window
/// can free them from the GPU atlas.
#[derive(Default)]
pub struct WaveImages {
    /// Each entry holds its wave, so its address can't be freed and handed
    /// to another item's wave while the entry lives.
    ready: HashMap<(usize, bool), (Wave, Arc<gpui::RenderImage>)>,
    order: std::collections::VecDeque<(usize, bool)>,
    evicted: Vec<Arc<gpui::RenderImage>>,
}

const WAVE_IMAGES: usize = 300;

impl WaveImages {
    /// `w` x `h` points, drawn at 2x. Keyed by the wave's allocation, which
    /// stays the same for as long as the item's visual does.
    pub fn get(
        &mut self,
        wave: &Wave,
        dark: bool,
        (w, h): (f32, f32),
        ink: gpui::Hsla,
    ) -> Arc<gpui::RenderImage> {
        let key = (Arc::as_ptr(wave) as usize, dark);
        if let Some((kept, image)) = self.ready.get(&key)
            && Arc::ptr_eq(kept, wave)
        {
            return image.clone();
        }
        let image = crate::library::rgba_to_render_image(rasterize(wave, w, h, ink));
        if let Some((_, old)) = self.ready.insert(key, (wave.clone(), image.clone())) {
            self.evicted.push(old);
        } else {
            self.order.push_back(key);
        }
        while self.ready.len() > WAVE_IMAGES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some((_, old)) = self.ready.remove(&oldest) {
                self.evicted.push(old);
            }
        }
        image
    }

    pub fn take_evicted(&mut self) -> Vec<Arc<gpui::RenderImage>> {
        std::mem::take(&mut self.evicted)
    }
}

/// 2 pt bars with 2 pt gaps, centred, at 2x.
fn rasterize(wave: &Wave, w: f32, h: f32, ink: gpui::Hsla) -> image::RgbaImage {
    let (pw, ph) = (
        (w * 2.).round().max(2.) as u32,
        (h * 2.).round().max(2.) as u32,
    );
    let rgba = gpui::Rgba::from(ink);
    let px = image::Rgba([
        (rgba.r * 255.).round() as u8,
        (rgba.g * 255.).round() as u8,
        (rgba.b * 255.).round() as u8,
        (rgba.a * 255.).round() as u8,
    ]);
    let mut img = image::RgbaImage::new(pw, ph);
    let (bar, gap) = (4u32, 4u32);
    let n = ((pw + gap) / (bar + gap)).clamp(1, BARS as u32) as usize;
    let total = n as u32 * (bar + gap) - gap;
    let x0 = pw.saturating_sub(total) / 2;
    for i in 0..n {
        let from = i * BARS / n;
        let to = ((i + 1) * BARS / n).max(from + 1);
        let v = wave[from..to].iter().copied().max().unwrap_or(0);
        let bh = ((ph as f32 * (0.08 + 0.92 * f32::from(v) / 255.)).round() as u32).clamp(bar, ph);
        let top = (ph - bh) / 2;
        for y in top..top + bh {
            for x in 0..bar {
                img.put_pixel(x0 + i as u32 * (bar + gap) + x, y, px);
            }
        }
    }
    img
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wave_survives_the_cache_text() {
        let wave = seed_wave(7);
        let hex = wave_to_hex(&wave);
        assert_eq!(wave_from_hex(&hex).as_deref(), Some(&*wave));
        assert!(wave_from_hex("zz").is_none());
    }

    #[test]
    fn bars_fill_to_the_loudest_and_silence_gives_nothing() {
        let mut line = vec![0.0001f32; 640];
        line[320] = 0.5;
        let wave = bars(&line).unwrap();
        assert_eq!(*wave.iter().max().unwrap(), 255);
        assert!(bars(&vec![0f32; 640]).is_none());
        assert!(bars(&[]).is_none());
    }

    #[test]
    fn parts_land_at_their_offsets() {
        // One loud second at 9 s of a 10 s meeting: only the last bars rise.
        let loud = vec![0.5f32; 10];
        let wave = combine(&[(loud, 9_000)], 10_000).unwrap();
        assert!(wave[..BARS * 8 / 10].iter().all(|b| *b < 40));
        assert!(wave[BARS - 2] > 200);
    }

    #[test]
    fn wave_images_are_made_once_and_bounded() {
        let mut images = WaveImages::default();
        let ink = gpui::hsla(0., 0., 0., 0.5);
        let wave = seed_wave(1);
        let a = images.get(&wave, false, (52., 28.), ink);
        let b = images.get(&wave, false, (52., 28.), ink);
        assert!(Arc::ptr_eq(&a, &b));
        assert!(!Arc::ptr_eq(&a, &images.get(&wave, true, (52., 28.), ink)));
        let waves: Vec<Wave> = (0..WAVE_IMAGES + 10).map(seed_wave).collect();
        for w in &waves {
            images.get(w, false, (52., 28.), ink);
        }
        assert!(images.ready.len() <= WAVE_IMAGES);
        assert_eq!(images.take_evicted().len(), 12);
    }

    #[test]
    fn a_cached_image_keeps_its_wave_so_its_address_is_never_reused() {
        let mut images = WaveImages::default();
        let ink = gpui::hsla(0., 0., 0., 0.5);
        let wave = seed_wave(5);
        let first = images.get(&wave, false, (52., 28.), ink);
        // The entry holds the wave: dropping the item's copy can't free the
        // allocation another wave would then be given.
        assert_eq!(Arc::strong_count(&wave), 2);
        let addr = Arc::as_ptr(&wave) as usize;
        drop(wave);
        let others: Vec<Wave> = (0..64).map(seed_wave).collect();
        for other in &others {
            assert_ne!(Arc::as_ptr(other) as usize, addr);
            assert!(!Arc::ptr_eq(
                &images.get(other, false, (52., 28.), ink),
                &first
            ));
        }
        // A key that matches but a wave that doesn't is never served the old
        // image (the check behind the key).
        let stranger = seed_wave(5);
        let key = (Arc::as_ptr(&stranger) as usize, false);
        let (_, kept_image) = images.ready.values().next().cloned().unwrap();
        images.ready.insert(key, (seed_wave(6), kept_image.clone()));
        assert!(!Arc::ptr_eq(
            &images.get(&stranger, false, (52., 28.), ink),
            &kept_image
        ));
    }

    #[test]
    fn a_deleted_meeting_leaves_the_cache_even_when_nothing_needs_working_out() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("doc-1");
        std::fs::create_dir_all(&doc).unwrap();
        std::fs::write(
            doc.join(cap_meetings::library::TRANSCRIPT_FILE),
            "{\"op\":\"upsert\",\"utterance\":{\"id\":\"u1\",\"source\":\"mic\",\"speaker\":null,\"speakerId\":1,\"startMs\":0,\"endMs\":1000,\"text\":\"Quarterly numbers for Acme\"}}\n",
        )
        .unwrap();
        let meeting: cap_meetings::library::MeetingDetails =
            serde_json::from_value(serde_json::json!({ "transcriptChars": 26 })).unwrap();
        let cache = dir.path().join("cache");
        let job = |id: &str| meeting_job(ItemKey::Doc(id.into()), doc.clone(), &meeting, true);
        let (_, todo) = cached(vec![job("a").unwrap(), job("b").unwrap()], &cache);
        let frames = dir.path().join("frames");
        let done: Vec<_> = todo
            .into_iter()
            .map(|(job, stamp)| {
                let visual = work(&job, &frames);
                (job.key, stamp, visual)
            })
            .collect();
        let keep: Vec<ItemKey> = done.iter().map(|(k, _, _)| k.clone()).collect();
        remember(&cache, &done, &keep);
        let file = cache.join(CACHE_FILE);
        assert!(std::fs::read_to_string(&file).unwrap().contains("Acme"));

        // "b" is deleted; "a" is already known, so nothing is decoded.
        let (known, todo) = cached(vec![job("a").unwrap()], &cache);
        assert_eq!((known.len(), todo.len()), (1, 0));
        let saved = std::fs::read_to_string(&file).unwrap();
        assert!(
            saved.contains("doc:a") && !saved.contains("doc:b"),
            "{saved}"
        );

        // The last item goes too.
        let (known, todo) = cached(Vec::new(), &cache);
        assert_eq!((known.len(), todo.len()), (0, 0));
        assert!(!std::fs::read_to_string(&file).unwrap().contains("Acme"));
    }

    #[test]
    fn an_edited_transcript_replaces_the_first_words_a_rescan_had_shown() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("doc-1");
        std::fs::create_dir_all(&doc).unwrap();
        let line = |text: &str| {
            format!(
                "{{\"op\":\"upsert\",\"utterance\":{{\"id\":\"u1\",\"source\":\"mic\",\"speaker\":null,\"speakerId\":1,\"startMs\":0,\"endMs\":1000,\"text\":\"{text}\"}}}}\n"
            )
        };
        let transcript = doc.join(cap_meetings::library::TRANSCRIPT_FILE);
        std::fs::write(&transcript, line("We planned the launch")).unwrap();
        let meeting: cap_meetings::library::MeetingDetails =
            serde_json::from_value(serde_json::json!({ "transcriptChars": 20 })).unwrap();
        let key = ItemKey::Doc("doc-1".into());
        let frames = dir.path().join("frames");
        let run = || {
            let job = meeting_job(key.clone(), doc.clone(), &meeting, true).unwrap();
            HashMap::from([(key.clone(), work(&job, &frames))])
        };
        let mut items = vec![Item::new(
            key.clone(),
            ItemKind::Meeting,
            "Sync",
            chrono::Utc::now(),
            super::super::items::ItemFacts::default(),
        )];
        let first = run();
        assert!(apply(&mut items, &first, &HashMap::new()));
        assert_eq!(items[0].excerpt.as_deref(), Some("We planned the launch"));

        // A rescan fills the new items from what is known, then the changed
        // file is worked out again: its newer words replace the older ones.
        std::fs::write(&transcript, line("We moved the launch to Friday")).unwrap();
        let second = run();
        assert!(apply(&mut items, &second, &first));
        assert_eq!(
            items[0].excerpt.as_deref(),
            Some("We moved the launch to Friday")
        );

        // Words the item has from its own data (the summary line) stay.
        let mut own = vec![Item::new(
            key.clone(),
            ItemKind::Meeting,
            "Sync",
            chrono::Utc::now(),
            super::super::items::ItemFacts {
                excerpt: Some("The summary line".into()),
                ..Default::default()
            },
        )];
        assert!(!apply(&mut own, &second, &first));
        assert_eq!(own[0].excerpt.as_deref(), Some("The summary line"));
    }

    #[test]
    fn long_text_is_cut_on_a_word() {
        let text = "word ".repeat(100);
        let clipped = clip(text).unwrap();
        assert!(clipped.ends_with('\u{2026}'));
        assert!(clipped.chars().count() <= EXCERPT_CHARS + 1);
        assert_eq!(clip("  ".into()), None);
    }
}
