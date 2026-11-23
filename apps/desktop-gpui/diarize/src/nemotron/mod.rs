//! NVIDIA Nemotron 3 Diarization (OpenMDW-1.1) as a second opinion on who
//! spoke when, run once after Stop (see `Schedule`).
//!
//! Each track's speech segments are laid out on the meeting's timeline (the
//! pauses between them as silence) and fed to the model
//! in 30.4 s steps (340 encoder frames plus 40 frames of look-ahead), the
//! offline preset Cap measured. The model numbers voices by first arrival, up
//! to 8 per track; its Arrival-Order Speaker Cache keeps a voice on the same
//! number for the whole meeting. The final pass uses these voices to decide
//! who is who (see `hybrid`).

pub mod cache;
pub mod mel;

use std::io::{BufWriter, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;

use crate::{Error, Track};
use cache::{HIDDEN, SPEAKERS, SUB, SpeakerCache};
use mel::{N_MELS, StreamingMel};

pub const CHUNK: usize = 340;
pub const RIGHT: usize = 40;
/// Silence between joined segments: the real pause (at least 200 ms, at most an
/// hour). The model separates voices far better on the meeting's own timeline:
/// with pauses shortened to 3 s it heard two remote people as one.
pub const MIN_GAP: usize = 3_200;
/// A pause is fed as silence one model step's worth at a time, so an hour of
/// it never sits in memory as samples and features at once.
const GAP_PIECE: usize = CHUNK * SUB * mel::HOP;
pub const MAX_GAP_MS: u64 = 3_600_000;

fn max_gap_ms() -> u64 {
    if !cfg!(debug_assertions) {
        return MAX_GAP_MS;
    }
    std::env::var("CAP_DIARIZE_NEMO_MAX_GAP_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(MAX_GAP_MS)
}
/// A voice counts as speaking in a 10 ms frame above this probability.
pub const ACTIVE: f32 = 0.5;

/// One encoder step of the model.
pub trait NemoModel: Send {
    /// `feats`: log-mel frames of the chunk and its look-ahead (`N_MELS`
    /// each); `cached`: the speaker cache's frames (`HIDDEN` each); `mask`:
    /// valid encoder frames, cached ones first. Returns the speaker logits of
    /// every input frame at the spectrogram rate (cached then chunk, `SUB`
    /// per encoder frame, `SPEAKERS` each), the chunk's encoder input frames,
    /// and the learned silence frame.
    fn step(&mut self, feats: &[f32], cached: &[f32], mask: &[i64]) -> Result<StepOut, Error>;
}

pub struct StepOut {
    pub logits: Vec<f32>,
    pub chunk_embeds: Vec<f32>,
    pub silence: Vec<f32>,
}

#[cfg(feature = "onnx")]
pub struct OnnxNemotron {
    session: ort::session::Session,
}

#[cfg(feature = "onnx")]
impl OnnxNemotron {
    /// Loads the ONNX export (onnx-community/Nemotron-3-Diarization-ONNX,
    /// `model_quantized.onnx` with its `.onnx_data`). The runtime must be
    /// initialised by the caller.
    pub fn load(path: &std::path::Path, threads: usize) -> Result<Self, Error> {
        use ort::session::{Session, builder::GraphOptimizationLevel};
        let session = Session::builder()
            .map_err(Error::runtime)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(Error::runtime)?
            .with_intra_threads(threads.max(1))
            .map_err(Error::runtime)?
            .with_inter_threads(1)
            .map_err(Error::runtime)?
            .with_intra_op_spinning(false)
            .map_err(Error::runtime)?
            .with_inter_op_spinning(false)
            .map_err(Error::runtime)?
            .commit_from_file(path)
            .map_err(Error::runtime)?;
        Ok(Self { session })
    }
}

#[cfg(feature = "onnx")]
impl NemoModel for OnnxNemotron {
    fn step(&mut self, feats: &[f32], cached: &[f32], mask: &[i64]) -> Result<StepOut, Error> {
        use ort::value::TensorRef;
        let n_mel = feats.len() / N_MELS;
        // the runtime refuses a zero-length dimension: an empty cache is passed as one masked frame,
        // whose logits are dropped below (attention never sees it; positions are relative)
        let dummy = cached.is_empty();
        let zero = [0f32; HIDDEN];
        let cached: &[f32] = if dummy { &zero } else { cached };
        let mut dmask;
        let mask: &[i64] = if dummy {
            dmask = Vec::with_capacity(mask.len() + 1);
            dmask.push(0);
            dmask.extend_from_slice(mask);
            &dmask
        } else {
            mask
        };
        let n_cached = cached.len() / HIDDEN;
        let f = TensorRef::from_array_view(([1, n_mel, N_MELS], feats)).map_err(Error::runtime)?;
        let c = TensorRef::from_array_view(([1, n_cached, HIDDEN], cached)).map_err(Error::runtime)?;
        let m = TensorRef::from_array_view(([1, mask.len()], mask)).map_err(Error::runtime)?;
        let outputs = self
            .session
            .run(ort::inputs!["input_features" => f, "cached_embeds" => c, "attention_mask" => m])
            .map_err(Error::runtime)?;
        let get = |name: &str| -> Result<Vec<f32>, Error> {
            let (_, data) = outputs[name].try_extract_tensor::<f32>().map_err(Error::runtime)?;
            Ok(data.to_vec())
        };
        let mut logits = get("logits")?;
        if dummy {
            logits.drain(..SUB * SPEAKERS);
        }
        Ok(StepOut {
            logits,
            chunk_embeds: get("chunk_embeds")?,
            silence: get("silence_embeds")?,
        })
    }
}

/// Where a joined stretch of a track came from.
#[derive(Clone, Copy, Debug)]
struct Part {
    joined: usize,
    source_ms: u64,
    samples: usize,
}

/// Voice probabilities of one track, 10 ms frames on the joined timeline,
/// stored as bytes (p * 255).
#[derive(Clone, Debug, Default)]
pub struct TrackVoices {
    probs: Vec<u8>,
    parts: Vec<Part>,
}

impl TrackVoices {
    /// Test voices: one part from source time 0, each listed voice certain over its turn.
    #[cfg(test)]
    pub(crate) fn scripted(track_ms: u64, turns: &[(u64, u64, usize)]) -> Self {
        Self::from_turns(track_ms, turns)
    }

    /// Voices known only as turns on the source timeline (the farm's speaker
    /// letters on words): each voice certain over its turns, silent elsewhere.
    pub fn from_turns(track_ms: u64, turns: &[(u64, u64, usize)]) -> Self {
        let frames = (track_ms / 10) as usize;
        let mut probs = vec![0u8; frames * SPEAKERS];
        for &(a, b, v) in turns {
            for f in (a / 10) as usize..((b / 10) as usize).min(frames) {
                if v < SPEAKERS {
                    probs[f * SPEAKERS + v] = 250;
                }
            }
        }
        Self { probs, parts: vec![Part { joined: 0, source_ms: 0, samples: frames * 160 }] }
    }

    pub fn frames(&self) -> usize {
        self.probs.len() / SPEAKERS
    }

    /// Rebuilds voices from `raw` and `parts` (a dump), to replay the final pass.
    pub fn from_raw(probs: Vec<u8>, parts: &[(usize, u64, usize)]) -> Self {
        Self {
            probs,
            parts: parts.iter().map(|&(joined, source_ms, samples)| Part { joined, source_ms, samples }).collect(),
        }
    }

    /// Where each joined stretch came from: (joined sample, source ms, samples).
    pub fn parts(&self) -> Vec<(usize, u64, usize)> {
        self.parts.iter().map(|p| (p.joined, p.source_ms, p.samples)).collect()
    }

    /// The stored probabilities (p * 255, `SPEAKERS` per 10 ms frame of the joined timeline).
    pub fn raw(&self) -> &[u8] {
        &self.probs
    }

    fn prob(&self, frame: usize, voice: usize) -> f32 {
        self.probs.get(frame * SPEAKERS + voice).map_or(0.0, |p| *p as f32 / 255.0)
    }

    /// Joined-timeline frames covering source time `[start_ms, end_ms)`.
    fn frames_of(&self, start_ms: u64, end_ms: u64) -> Vec<(usize, u64)> {
        let mut out = Vec::new();
        for p in &self.parts {
            let p_end = p.source_ms + (p.samples as u64 * 1000 / 16_000);
            let a = start_ms.max(p.source_ms);
            let b = end_ms.min(p_end);
            if b <= a {
                continue;
            }
            let base = p.joined / 160;
            let fa = base + ((a - p.source_ms) / 10) as usize;
            let fb = base + ((b - p.source_ms) / 10) as usize;
            for f in fa..fb.min(self.frames()) {
                out.push((f, p.source_ms + ((f - base) as u64) * 10));
            }
        }
        out
    }

    /// Active speech of each voice over source time `[start_ms, end_ms)`, in ms.
    pub fn cover(&self, start_ms: u64, end_ms: u64) -> [u64; SPEAKERS] {
        let mut out = [0u64; SPEAKERS];
        for (f, _) in self.frames_of(start_ms, end_ms) {
            for (v, o) in out.iter_mut().enumerate() {
                if self.prob(f, v) > ACTIVE {
                    *o += 10;
                }
            }
        }
        out
    }

    /// The most active voice of each 10 ms frame in `[start_ms, end_ms)` (None where nobody is).
    pub fn turns(&self, start_ms: u64, end_ms: u64) -> Vec<(u64, Option<usize>)> {
        self.frames_of(start_ms, end_ms)
            .into_iter()
            .map(|(f, ms)| {
                let (v, p) = (0..SPEAKERS)
                    .map(|v| (v, self.prob(f, v)))
                    .fold((0, 0.0), |a, b| if b.1 > a.1 { b } else { a });
                (ms, (p > ACTIVE).then_some(v))
            })
            .collect()
    }

    /// Active speech of each voice over the whole track, in ms.
    pub fn sizes(&self) -> [u64; SPEAKERS] {
        let mut out = [0u64; SPEAKERS];
        for f in 0..self.frames() {
            for (v, o) in out.iter_mut().enumerate() {
                if self.prob(f, v) > ACTIVE {
                    *o += 10;
                }
            }
        }
        out
    }

    /// Active seconds of each voice (diagnostics).
    pub fn active_secs(&self) -> [f32; SPEAKERS] {
        let mut out = [0f32; SPEAKERS];
        for f in 0..self.frames() {
            for (v, o) in out.iter_mut().enumerate() {
                if self.prob(f, v) > ACTIVE {
                    *o += 0.01;
                }
            }
        }
        out
    }

    /// Voices with any speech on this track.
    pub fn voices(&self) -> usize {
        (0..SPEAKERS)
            .filter(|&v| (0..self.frames()).any(|f| self.prob(f, v) > ACTIVE))
            .count()
    }
}

/// One track's stream: joined audio -> features -> model steps.
struct TrackStream {
    mel: StreamingMel,
    /// Features from mel frame `feats_start` on.
    feats: Vec<f32>,
    feats_start: usize,
    /// Encoder frames already scored.
    done: usize,
    cache: SpeakerCache,
    voices: TrackVoices,
    joined: usize,
    /// Source end of the last segment.
    last_end_ms: Option<u64>,
    max_gap_ms: u64,
    gap_piece: usize,
}

impl TrackStream {
    fn new() -> Self {
        Self {
            mel: StreamingMel::new(),
            feats: Vec::new(),
            feats_start: 0,
            done: 0,
            cache: SpeakerCache::offline(),
            voices: TrackVoices::default(),
            joined: 0,
            last_end_ms: None,
            max_gap_ms: max_gap_ms(),
            gap_piece: GAP_PIECE,
        }
    }

    fn push(&mut self, model: &mut dyn NemoModel, start_ms: u64, samples: &[f32]) -> Result<(), Error> {
        if let Some(last) = self.last_end_ms {
            let pause_ms = start_ms.saturating_sub(last).min(self.max_gap_ms);
            let gap = ((pause_ms * 16) as usize).max(MIN_GAP);
            let zeros = vec![0.0; gap.min(self.gap_piece)];
            let mut left = gap;
            while left > 0 {
                let n = left.min(zeros.len());
                self.mel.push(&zeros[..n], &mut self.feats);
                self.joined += n;
                left -= n;
                self.step_ready(model)?;
            }
        }
        self.last_end_ms = Some(start_ms + samples.len() as u64 / 16);
        self.voices.parts.push(Part { joined: self.joined, source_ms: start_ms, samples: samples.len() });
        self.mel.push(samples, &mut self.feats);
        self.joined += samples.len();
        self.step_ready(model)
    }

    /// Every full step the features so far allow; a step only reads up to
    /// its look-ahead, so when it runs never changes what it hears.
    fn step_ready(&mut self, model: &mut dyn NemoModel) -> Result<(), Error> {
        while self.mel.frames() >= (self.done + CHUNK + RIGHT) * SUB {
            self.step(model, self.done + CHUNK, self.done + CHUNK + RIGHT, None)?;
        }
        Ok(())
    }

    fn finish(&mut self, model: &mut dyn NemoModel) -> Result<(), Error> {
        let valid = self.mel.finish(&mut self.feats);
        let total = self.mel.frames();
        let n_emb = total.div_ceil(SUB);
        while self.done < n_emb {
            let end = (self.done + CHUNK).min(n_emb);
            let hi = (end + RIGHT).min(n_emb);
            self.step(model, end, hi, Some(valid))?;
        }
        Ok(())
    }

    /// Scores encoder frames `[done, end)` with look-ahead up to `hi`.
    fn step(&mut self, model: &mut dyn NemoModel, end: usize, hi: usize, valid: Option<usize>) -> Result<(), Error> {
        let start = self.done;
        let first = start * SUB - self.feats_start;
        let total = self.feats_start + self.feats.len() / N_MELS;
        let last = (hi * SUB).min(total) - self.feats_start;
        let piece = &self.feats[first * N_MELS..last * N_MELS];
        let cached = self.cache.embeds();
        let n_cached = cached.len() / HIDDEN;
        let n_emb = (last - first).div_ceil(SUB);
        let mut mask = vec![1i64; n_cached + n_emb];
        if let Some(valid) = valid {
            for e in 0..n_emb {
                // a stacked frame is padding when its first spectrogram frame is
                if (start + e) * SUB >= valid {
                    mask[n_cached + e] = 0;
                }
            }
        }
        let out = model.step(piece, &cached, &mask)?;
        let mut input = cached;
        input.extend_from_slice(&out.chunk_embeds);
        let maskf: Vec<f32> = mask.iter().map(|m| *m as f32).collect();
        let n_chunk = end - start;
        self.cache.update(&input, &out.logits, &out.silence, n_chunk, &maskf);
        let from = n_cached * SUB * SPEAKERS;
        let frames_here = (n_chunk * SUB).min(total.saturating_sub(start * SUB));
        for &l in &out.logits[from..from + frames_here * SPEAKERS] {
            let p = 1.0 / (1.0 + (-l).exp());
            self.voices.probs.push((p * 255.0).round() as u8);
        }
        self.done = end;
        // features before the next chunk are no longer needed
        let keep = self.done * SUB;
        if keep > self.feats_start {
            let cut = (keep - self.feats_start).min(self.feats.len() / N_MELS);
            self.feats.drain(..cut * N_MELS);
            self.feats_start += cut;
        }
        Ok(())
    }
}

enum Msg {
    Push(Track, u64, Vec<f32>),
    Finish(mpsc::Sender<Result<[TrackVoices; 2], String>>),
}

/// When Nemotron hears the meeting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Schedule {
    /// As the meeting records, one 30 s step at a time, so its voices are
    /// ready the moment the meeting stops (the harness and tests).
    Live,
    /// Once, after Stop, at low priority. Recording costs what it did without
    /// Nemotron: speech is only written to a temporary file until then.
    AfterStop,
}

impl Schedule {
    /// After Stop on every machine. Live, the app spent 5-6 more points of a
    /// core recording on Apple Silicon and 20-24% of a core on a 2-core x86
    /// machine; after Stop the pass takes 1-2 minutes per meeting hour on
    /// Apple Silicon and 3-10 minutes on a 2-core x86 machine.
    pub fn for_this_machine() -> Self {
        Self::AfterStop
    }
}

/// The speech of an `AfterStop` meeting, kept on disk until Stop: raw f32
/// samples (exactly what a live run would have heard) and where each segment
/// starts. The file goes when the spool does.
struct Spool {
    path: PathBuf,
    file: Option<BufWriter<std::fs::File>>,
    index: Vec<(Track, u64, usize)>,
}

/// A spool this old goes even if its process seems to run (a reused pid):
/// no meeting is silent this long.
const ABANDONED_SPOOL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Removes other processes' spools from `dir` (the file is only removed when
/// the spool drops, so a crash or quit leaves it): those whose process is
/// gone, and any older than `ABANDONED_SPOOL`. `alive` says whether a pid
/// runs, true when it can't tell. Returns how many went.
fn remove_stale_spools(dir: &std::path::Path, own_pid: u32, alive: impl Fn(u32) -> bool) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(pid) = name
            .strip_prefix("cap-nemotron-")
            .filter(|_| name.ends_with(".f32"))
            .and_then(|rest| rest.split('-').next())
            .and_then(|pid| pid.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == own_pid {
            continue;
        }
        let abandoned = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age >= ABANDONED_SPOOL);
        if (abandoned || !alive(pid)) && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Removes the speech files a crash or quit left in the temp folder before
/// their pass ran. The app calls it once at launch with a check of whether
/// a pid runs; returns how many went.
pub fn clear_stale_spools(alive: impl Fn(u32) -> bool) -> usize {
    remove_stale_spools(&std::env::temp_dir(), std::process::id(), alive)
}

/// The meeting's speech sits in the shared temp folder until Stop, so the
/// name can't be guessed from the process id alone.
fn spool_name(pid: u32, n: u64) -> String {
    use std::hash::BuildHasher;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let token = std::collections::hash_map::RandomState::new().hash_one((pid, n, nanos));
    format!("cap-nemotron-{pid}-{n}-{token:016x}.f32")
}

/// Opens a new spool only its owner can read, and only when nothing is at
/// the path yet: a file or link someone else left there is never written.
fn open_private(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

impl Spool {
    fn create() -> Result<Self, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir();
        if n == 0 {
            remove_stale_spools(&dir, std::process::id(), |_| true);
        }
        let mut attempt = 0;
        let (path, file) = loop {
            let path = dir.join(spool_name(std::process::id(), n));
            match open_private(&path) {
                Ok(file) => break (path, file),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempt < 8 => attempt += 1,
                Err(e) => return Err(format!("could not keep the meeting's speech for Nemotron: {e}")),
            }
        };
        Ok(Self { path, file: Some(BufWriter::with_capacity(1 << 20, file)), index: Vec::new() })
    }

    fn write(&mut self, track: Track, start_ms: u64, samples: &[f32]) -> Result<(), String> {
        let file = self.file.as_mut().ok_or("the speech file is closed")?;
        let bytes: Vec<u8> = samples.iter().flat_map(|x| x.to_le_bytes()).collect();
        file.write_all(&bytes).map_err(|e| format!("could not keep the meeting's speech for Nemotron: {e}"))?;
        self.index.push((track, start_ms, samples.len()));
        Ok(())
    }

    /// Every segment, in the order it was pushed.
    fn replay(&mut self, mut each: impl FnMut(Track, u64, &[f32]) -> Result<(), String>) -> Result<(), String> {
        if let Some(mut file) = self.file.take() {
            file.flush().map_err(|e| format!("could not keep the meeting's speech for Nemotron: {e}"))?;
        }
        let mut file = std::io::BufReader::with_capacity(1 << 20, std::fs::File::open(&self.path).map_err(|e| format!("could not read the meeting's speech back: {e}"))?);
        let mut bytes = Vec::new();
        let mut samples = Vec::new();
        for &(track, start_ms, n) in &self.index {
            bytes.resize(n * 4, 0);
            file.read_exact(&mut bytes).map_err(|e| format!("could not read the meeting's speech back: {e}"))?;
            samples.clear();
            samples.extend(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
            each(track, start_ms, &samples)?;
        }
        Ok(())
    }
}

impl Drop for Spool {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Runs the model on its own thread so recording never waits for a step.
pub struct NemoRunner {
    tx: Option<mpsc::Sender<Msg>>,
    worker: Option<JoinHandle<()>>,
    schedule: Schedule,
    spool_path: Option<PathBuf>,
}

impl NemoRunner {
    pub fn start(model: Box<dyn NemoModel>) -> Self {
        Self::start_with(model, Schedule::Live, || {})
    }

    /// `lower_priority` runs on the model's thread before an `AfterStop`
    /// pass, which then never competes with the app.
    pub fn start_with(mut model: Box<dyn NemoModel>, schedule: Schedule, lower_priority: fn()) -> Self {
        let (tx, rx) = mpsc::channel::<Msg>();
        let (mut spool, mut failed) = match schedule {
            Schedule::Live => (None, None),
            Schedule::AfterStop => match Spool::create() {
                Ok(s) => (Some(s), None),
                Err(e) => (None, Some(e)),
            },
        };
        let spool_path = spool.as_ref().map(|s: &Spool| s.path.clone());
        let worker = std::thread::Builder::new()
            .name("cap-diarize-nemotron".into())
            .spawn(move || {
                let mut streams = [TrackStream::new(), TrackStream::new()];
                for msg in rx {
                    match msg {
                        Msg::Push(track, start_ms, samples) => {
                            if failed.is_some() {
                                continue;
                            }
                            let result = match spool.as_mut() {
                                Some(spool) => spool.write(track, start_ms, &samples),
                                None => streams[track_slot(track)].push(model.as_mut(), start_ms, &samples).map_err(|e| e.to_string()),
                            };
                            if let Err(e) = result {
                                failed = Some(e);
                            }
                        }
                        Msg::Finish(reply) => {
                            if let Some(mut spool) = spool.take().filter(|_| failed.is_none()) {
                                lower_priority();
                                let model = model.as_mut();
                                if let Err(e) = spool.replay(|track, start_ms, samples| {
                                    streams[track_slot(track)].push(&mut *model, start_ms, samples).map_err(|e| e.to_string())
                                }) {
                                    failed = Some(e);
                                }
                            }
                            if failed.is_none() {
                                for s in streams.iter_mut().filter(|s| s.joined > 0) {
                                    if let Err(e) = s.finish(model.as_mut()) {
                                        failed = Some(e.to_string());
                                        break;
                                    }
                                }
                            }
                            let out = match failed.take() {
                                Some(e) => Err(e),
                                None => {
                                    let [a, b] = std::mem::replace(&mut streams, [TrackStream::new(), TrackStream::new()]);
                                    Ok([a.voices, b.voices])
                                }
                            };
                            // the model goes before the answer, so what it held
                            // is free once the caller hears back
                            drop(model);
                            let _ = reply.send(out);
                            return;
                        }
                    }
                }
            })
            .ok();
        Self { tx: worker.as_ref().map(|_| tx), worker, schedule, spool_path }
    }

    pub fn schedule(&self) -> Schedule {
        self.schedule
    }

    /// Where an `AfterStop` runner keeps the speech until Stop.
    pub fn spool_path(&self) -> Option<&std::path::Path> {
        self.spool_path.as_deref()
    }

    pub fn push(&self, track: Track, start_ms: u64, samples: &[f32]) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(Msg::Push(track, start_ms, samples.to_vec()));
        }
    }

    /// Finishes both tracks without waiting: the voices arrive on the
    /// returned channel (an `AfterStop` runner hears the whole meeting first).
    pub fn finish_later(mut self) -> mpsc::Receiver<Result<[TrackVoices; 2], String>> {
        let (reply, rx) = mpsc::channel();
        match self.tx.take() {
            Some(tx) => {
                if let Err(mpsc::SendError(Msg::Finish(reply))) = tx.send(Msg::Finish(reply)) {
                    let _ = reply.send(Err("the model thread stopped".into()));
                }
            }
            None => {
                let _ = reply.send(Err("the model thread did not start".into()));
            }
        }
        // the thread ends by itself once it has answered
        drop(self.worker.take());
        rx
    }

    /// Finishes both tracks; an error when the model failed at any point.
    pub fn finish(mut self) -> Result<[TrackVoices; 2], String> {
        let tx = self.tx.take().ok_or("the model thread did not start")?;
        let (reply, rx) = mpsc::channel();
        tx.send(Msg::Finish(reply)).map_err(|_| "the model thread stopped")?;
        let out = rx.recv().unwrap_or_else(|_| Err("the model thread stopped".into()));
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
        out
    }
}

pub fn track_slot(track: Track) -> usize {
    match track {
        Track::Mic => 0,
        Track::System => 1,
    }
}

#[cfg(test)]
mod tests;
