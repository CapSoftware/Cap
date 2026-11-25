use std::{
    path::Path,
    sync::{Arc, Mutex, mpsc},
};

use anyhow::{Context, bail};
use ort::{
    session::Session,
    value::{DynValue, TensorRef},
};
use serde::Deserialize;

use crate::image::{Rect, RgbImage};

#[derive(Debug, Clone, Deserialize)]
pub struct ModelMeta {
    pub version: String,
    pub det: DetMeta,
    pub rec: RecMeta,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DetMeta {
    pub mean: [f32; 3],
    pub std: [f32; 3],
    #[serde(default = "default_multiple")]
    pub multiple: u32,
    #[serde(default = "default_max_side")]
    pub max_side: u32,
    #[serde(default = "default_prob")]
    pub prob_threshold: f32,
    #[serde(default = "default_box")]
    pub box_threshold: f32,
    #[serde(default = "default_unclip")]
    pub unclip: f32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RecMeta {
    #[serde(default = "default_rec_height")]
    pub height: u32,
    #[serde(default = "default_half")]
    pub mean: f32,
    #[serde(default = "default_half")]
    pub std: f32,
    #[serde(default = "default_stride")]
    pub stride: u32,
    #[serde(default = "default_rec_width")]
    pub max_width: u32,
}

fn default_multiple() -> u32 {
    32
}
fn default_max_side() -> u32 {
    2048
}
fn default_prob() -> f32 {
    0.3
}
fn default_box() -> f32 {
    0.5
}
fn default_unclip() -> f32 {
    1.6
}
fn default_rec_height() -> u32 {
    48
}
fn default_half() -> f32 {
    0.5
}
fn default_stride() -> u32 {
    8
}
fn default_rec_width() -> u32 {
    1280
}

/// One text line from the detector, in frame pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DetectedLine {
    pub rect: Rect,
    pub score: f32,
}

/// What the recogniser read in a line, with each character's x-span in
/// frame pixels.
#[derive(Clone, Default)]
pub struct Recognized {
    pub text: String,
    pub spans: Vec<(f32, f32)>,
    pub confidence: f32,
    /// Per character, what else the recogniser saw there.
    pub alternatives: Vec<Alternatives>,
}

/// The likeliest other characters at a character's strongest timestep, and
/// how likely that timestep was to be blank (the character not there at all).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Alternatives {
    pub options: Vec<(char, f32)>,
    pub blank: f32,
}

/// Detector pixels per frame below which the CPU detector is faster than a
/// round trip to the GPU (whose submit and wait alone take a few ms).
const GPU_MIN_PIXELS: f32 = 150_000.0;

/// Detection started by [`OcrModel::detect_begin`].
pub enum PendingDetect {
    /// One answer per region from the CPU detector threads.
    Cpu(Vec<mpsc::Receiver<anyhow::Result<Vec<DetectedLine>>>>),
    Gpu(crate::gpu::Ticket),
}

/// A region resampled into the detector's input, waiting to be run.
struct DetJob {
    input: Vec<f32>,
    in_w: usize,
    in_h: usize,
    out_w: usize,
    out_h: usize,
    roi: Rect,
    frame: (u32, u32),
    reply: mpsc::Sender<anyhow::Result<Vec<DetectedLine>>>,
}

/// Detector sessions on their own threads, so a frame's regions run side by
/// side and the CPU detection of one frame overlaps the rest of the work on
/// the frames before it.
struct DetWorkers {
    jobs: Option<mpsc::Sender<DetJob>>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl DetWorkers {
    fn new(dir: &Path, meta: &DetMeta, count: usize) -> anyhow::Result<Self> {
        let (sender, receiver) = mpsc::channel::<DetJob>();
        let receiver = Arc::new(Mutex::new(receiver));
        let mut threads = Vec::with_capacity(count);
        for _ in 0..count {
            let mut session = session(&dir.join("det.onnx"), detection_threads(), false)?;
            let receiver = receiver.clone();
            let meta = meta.clone();
            threads.push(std::thread::spawn(move || {
                loop {
                    let job = match receiver.lock() {
                        Ok(receiver) => receiver.recv(),
                        Err(_) => return,
                    };
                    let Ok(job) = job else { return };
                    let result = run_detection(&mut session, &meta, &job);
                    let _ = job.reply.send(result);
                }
            }));
        }
        Ok(Self {
            jobs: Some(sender),
            threads,
        })
    }
}

impl Drop for DetWorkers {
    fn drop(&mut self) {
        self.jobs = None;
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

pub struct OcrModel {
    pub meta: ModelMeta,
    charset: Vec<String>,
    det: DetWorkers,
    /// Lines are read one at a time (batching costs several times more per
    /// line on CPU), spread over a few sessions in parallel.
    rec: Vec<Session>,
    gpu: Option<Arc<Mutex<crate::gpu::GpuDetector>>>,
    /// Waits on GPU submissions without holding the detector.
    gpu_device: Option<wgpu::Device>,
    /// Upload buffers reused by [`Self::detect_begin`].
    spare: Vec<Vec<u8>>,
}

/// Starts detection from another thread than the one that collects it:
/// regions are resampled there and handed to the GPU or the CPU detector
/// threads, which run while the collecting thread works.
pub struct DetectStarter {
    gpu: Option<Arc<Mutex<crate::gpu::GpuDetector>>>,
    max_height: u32,
    det: DetMeta,
    jobs: mpsc::Sender<DetJob>,
    spare: Vec<Vec<u8>>,
}

impl DetectStarter {
    pub fn begin(
        &mut self,
        frame: &RgbImage,
        rois: &[Rect],
        scale: f32,
    ) -> anyhow::Result<PendingDetect> {
        match &self.gpu {
            Some(gpu) => begin_gpu(
                gpu,
                self.max_height,
                &self.det,
                &mut self.spare,
                frame,
                rois,
                scale,
            ),
            None => begin_cpu(&self.jobs, &self.det, frame, rois, scale),
        }
    }
}

fn lock_gpu(
    gpu: &Mutex<crate::gpu::GpuDetector>,
) -> std::sync::MutexGuard<'_, crate::gpu::GpuDetector> {
    gpu.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Resamples the regions here, then uploads and submits them while holding
/// the detector only for that.
fn begin_gpu(
    gpu: &Mutex<crate::gpu::GpuDetector>,
    max_height: u32,
    det: &DetMeta,
    spare: &mut Vec<Vec<u8>>,
    frame: &RgbImage,
    rois: &[Rect],
    scale: f32,
) -> anyhow::Result<PendingDetect> {
    let started = std::time::Instant::now();
    let packed = crate::gpu::pack_regions(frame, rois, scale, det, max_height, spare);
    let mut detector = lock_gpu(gpu);
    detector.prepare += started.elapsed();
    let (ticket, uploads) = detector.dispatch(packed)?;
    drop(detector);
    spare.extend(uploads);
    spare.truncate(crate::gpu::SPARE_UPLOADS);
    Ok(PendingDetect::Gpu(ticket))
}

/// Hands every region to the CPU detector threads.
fn begin_cpu(
    jobs: &mpsc::Sender<DetJob>,
    det: &DetMeta,
    frame: &RgbImage,
    rois: &[Rect],
    scale: f32,
) -> anyhow::Result<PendingDetect> {
    let mut replies = Vec::with_capacity(rois.len());
    for roi in rois {
        let (reply, answer) = mpsc::channel();
        match detection_input(det, frame, *roi, scale, reply.clone()) {
            Some(job) => jobs
                .send(job)
                .map_err(|_| anyhow::anyhow!("detector threads stopped"))?,
            None => {
                let _ = reply.send(Ok(Vec::new()));
            }
        }
        replies.push(answer);
    }
    Ok(PendingDetect::Cpu(replies))
}

/// `roi` of `frame` resampled into the detector's input at `scale` (frame
/// pixels to detector pixels), or `None` when it is too small.
fn detection_input(
    det: &DetMeta,
    frame: &RgbImage,
    roi: Rect,
    scale: f32,
    reply: mpsc::Sender<anyhow::Result<Vec<DetectedLine>>>,
) -> Option<DetJob> {
    let roi = roi.clamp_to(frame.width, frame.height);
    if roi.w < 8.0 || roi.h < 8.0 {
        return None;
    }
    let multiple = det.multiple.max(1) as usize;
    let max_side = det.max_side.max(64) as f32;
    let scale = scale.min(max_side / roi.w.max(roi.h)).max(0.05);
    let out_w = ((roi.w * scale).round() as usize).max(multiple);
    let out_h = ((roi.h * scale).round() as usize).max(multiple);
    let in_w = out_w.div_ceil(multiple) * multiple;
    let in_h = out_h.div_ceil(multiple) * multiple;
    let plane = in_w * in_h;
    let mean = det.mean;
    let std = det.std;
    let pad = [-mean[0] / std[0], -mean[1] / std[1], -mean[2] / std[2]];
    let mut input = vec![0.0f32; 3 * plane];
    for (channel, value) in pad.iter().enumerate() {
        input[channel * plane..(channel + 1) * plane].fill(*value);
    }
    frame.resize_into_planes(
        roi,
        out_w,
        out_h,
        in_w,
        plane,
        &mut input,
        |channel, value| (value / 255.0 - mean[channel]) / std[channel],
    );
    Some(DetJob {
        input,
        in_w,
        in_h,
        out_w,
        out_h,
        roi,
        frame: (frame.width, frame.height),
        reply,
    })
}

impl OcrModel {
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        let meta: ModelMeta = serde_json::from_slice(
            &std::fs::read(dir.join("meta.json")).context("read meta.json")?,
        )
        .context("parse meta.json")?;
        let charset = std::fs::read_to_string(dir.join("charset.txt"))
            .context("read charset.txt")?
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
            .collect::<Vec<_>>();
        let charset = trim_trailing_empty(charset);
        if charset.is_empty() {
            bail!("charset.txt is empty");
        }
        cap_camera_effects::initialize_onnx_runtime()?;
        let rec = (0..recognition_sessions())
            .map(|_| session(&dir.join("rec.onnx"), 2, true))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let gpu = if std::env::var_os("CAP_REDACT_ORT_DET").is_some() {
            None
        } else {
            crate::gpu::GpuDetector::new(dir).unwrap_or_else(|error| {
                tracing::warn!(%error, "GPU text detector unavailable");
                None
            })
        };
        // With a GPU detector only the small regions run here, so one session
        // is enough; the CPU-only path runs every region on these sessions.
        let sessions = if gpu.is_some() {
            1
        } else {
            cpu_detection_sessions()
        };
        let det = DetWorkers::new(dir, &meta.det, sessions)?;
        let gpu_device = gpu.as_ref().map(crate::gpu::GpuDetector::device);
        Ok(Self {
            meta,
            charset,
            det,
            rec,
            gpu: gpu.map(|gpu| Arc::new(Mutex::new(gpu))),
            gpu_device,
            spare: Vec::new(),
        })
    }

    pub fn version(&self) -> &str {
        &self.meta.version
    }

    /// Where detection runs: the GPU adapter, or the ONNX runtime.
    pub fn detector(&self) -> String {
        match self.gpu.as_deref().map(lock_gpu) {
            Some(gpu) => format!(
                "gpu {} ({:.1} Mpx run, {} tiles made; prepare {:.2}s, wait {:.2}s, post {:.2}s)",
                gpu.adapter,
                gpu.processed as f64 / 1e6,
                gpu.created,
                gpu.prepare.as_secs_f64(),
                gpu.wait.as_secs_f64(),
                gpu.post.as_secs_f64()
            ),
            None => "onnx".to_string(),
        }
    }

    /// [`Self::detect`] for several regions of one frame: on the GPU when it
    /// is available and the regions are large enough to be worth a round
    /// trip, otherwise here.
    pub fn detect_all(
        &mut self,
        frame: &RgbImage,
        rois: &[Rect],
        scale: f32,
    ) -> anyhow::Result<Vec<Vec<DetectedLine>>> {
        let pixels: f32 = rois
            .iter()
            .map(|roi| roi.clamp_to(frame.width, frame.height).area() * scale * scale)
            .sum();
        let pending = if pixels >= GPU_MIN_PIXELS {
            self.detect_begin(frame, rois, scale)?
        } else {
            self.detect_begin_cpu(frame, rois, scale)?
        };
        self.detect_end(pending)
    }

    /// A handle that starts detection from another thread; the lines are
    /// collected here with [`Self::detect_end`].
    pub fn starter(&self) -> anyhow::Result<DetectStarter> {
        Ok(DetectStarter {
            gpu: self.gpu.clone(),
            max_height: self
                .gpu
                .as_deref()
                .map_or(0, |gpu| lock_gpu(gpu).max_height()),
            det: self.meta.det.clone(),
            jobs: self.det.jobs.clone().context("detector threads stopped")?,
            spare: Vec::new(),
        })
    }

    /// Starts detecting several regions of one frame; on the GPU this
    /// returns before the work is done, so frames can overlap.
    pub fn detect_begin(
        &mut self,
        frame: &RgbImage,
        rois: &[Rect],
        scale: f32,
    ) -> anyhow::Result<PendingDetect> {
        match &self.gpu {
            Some(gpu) => {
                let max_height = lock_gpu(gpu).max_height();
                begin_gpu(
                    gpu,
                    max_height,
                    &self.meta.det,
                    &mut self.spare,
                    frame,
                    rois,
                    scale,
                )
            }
            None => self.detect_begin_cpu(frame, rois, scale),
        }
    }

    fn detect_begin_cpu(
        &mut self,
        frame: &RgbImage,
        rois: &[Rect],
        scale: f32,
    ) -> anyhow::Result<PendingDetect> {
        let jobs = self.det.jobs.as_ref().context("detector threads stopped")?;
        begin_cpu(jobs, &self.meta.det, frame, rois, scale)
    }

    /// The lines of a [`Self::detect_begin`], per region.
    pub fn detect_end(&mut self, pending: PendingDetect) -> anyhow::Result<Vec<Vec<DetectedLine>>> {
        match pending {
            PendingDetect::Cpu(replies) => replies
                .into_iter()
                .map(|answer| {
                    answer
                        .recv()
                        .unwrap_or_else(|_| Err(anyhow::anyhow!("detector thread stopped")))
                })
                .collect(),
            PendingDetect::Gpu(ticket) => match (&self.gpu, &self.gpu_device) {
                (Some(gpu), Some(device)) => {
                    let started = std::time::Instant::now();
                    let _ =
                        device.poll(wgpu::PollType::WaitForSubmissionIndex(ticket.submission()));
                    let mut detector = lock_gpu(gpu);
                    detector.wait += started.elapsed();
                    detector.collect(ticket, &self.meta.det)
                }
                _ => anyhow::bail!("GPU detection without a GPU detector"),
            },
        }
    }

    /// Reads every line crop. Long lines are cut at a gap between words so
    /// each piece fits the recogniser's widest input.
    pub fn recognize(
        &mut self,
        frame: &RgbImage,
        lines: &[Rect],
    ) -> anyhow::Result<Vec<Recognized>> {
        let height = self.meta.rec.height as usize;
        let max_width = self.meta.rec.max_width.max(64) as usize;
        let stride = self.meta.rec.stride.max(1) as usize;
        let mut pieces = Vec::new();
        for (line, rect) in lines.iter().enumerate() {
            let rect = rect.clamp_to(frame.width, frame.height);
            if rect.w < 2.0 || rect.h < 2.0 {
                continue;
            }
            let scale = height as f32 / rect.h;
            let limit = (max_width as f32 / scale).max(8.0);
            // A line a little too wide is squeezed rather than cut: a cut
            // through a long key splits it into pieces that read as two words.
            let parts = if rect.w <= limit * 1.4 {
                vec![rect]
            } else {
                frame.split_for_width(rect, limit)
            };
            for piece in parts {
                let width = ((piece.w * scale).round() as usize)
                    .clamp(stride, max_width)
                    .div_ceil(stride)
                    * stride;
                pieces.push(Piece {
                    line,
                    rect: piece,
                    width,
                });
            }
        }
        let workers = self.rec.len().max(1);
        let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); workers];
        let mut load = vec![0usize; workers];
        let mut order = (0..pieces.len()).collect::<Vec<_>>();
        order.sort_by_key(|i| std::cmp::Reverse(pieces[*i].width));
        for index in order {
            let (lightest, _) = load
                .iter()
                .enumerate()
                .min_by_key(|(_, l)| **l)
                .unwrap_or((0, &0));
            buckets[lightest].push(index);
            load[lightest] += pieces[index].width;
        }
        let meta = &self.meta.rec;
        let charset = &self.charset;
        let pieces_ref = &pieces;
        let results = std::thread::scope(|scope| {
            let handles = self
                .rec
                .iter_mut()
                .zip(buckets)
                .map(|(session, bucket)| {
                    scope.spawn(move || {
                        let mut input = Vec::new();
                        let mut out = Vec::with_capacity(bucket.len());
                        for index in bucket {
                            let piece = &pieces_ref[index];
                            let result =
                                read_piece(session, meta, charset, frame, piece, &mut input)?;
                            out.push((index, result));
                        }
                        anyhow::Ok(out)
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| {
                    handle
                        .join()
                        .unwrap_or_else(|_| Err(anyhow::anyhow!("recogniser thread panicked")))
                })
                .collect::<anyhow::Result<Vec<_>>>()
        })?;
        let mut piece_results: Vec<Option<Recognized>> = vec![None; pieces.len()];
        for (index, result) in results.into_iter().flatten() {
            piece_results[index] = Some(result);
        }
        let mut results = vec![Recognized::default(); lines.len()];
        let mut confidence_weight = vec![0usize; lines.len()];
        for (piece, result) in pieces.iter().zip(piece_results) {
            let Some(result) = result else { continue };
            let target = &mut results[piece.line];

            let chars = result.text.chars().count();
            target.confidence += result.confidence * chars as f32;
            confidence_weight[piece.line] += chars;
            target.text.push_str(&result.text);
            target.spans.extend(result.spans);
            target.alternatives.extend(result.alternatives);
        }
        for (result, weight) in results.iter_mut().zip(confidence_weight) {
            if weight > 0 {
                result.confidence /= weight as f32;
            }
        }
        Ok(results)
    }
}

/// Runs the detector on a prepared region and turns its probability map
/// into line boxes in frame pixels.
fn run_detection(
    session: &mut Session,
    meta: &DetMeta,
    job: &DetJob,
) -> anyhow::Result<Vec<DetectedLine>> {
    let (in_w, in_h, out_w, out_h, roi) = (job.in_w, job.in_h, job.out_w, job.out_h, job.roi);
    let input =
        TensorRef::from_array_view(([1usize, 3, in_h, in_w], &*job.input)).context("det input")?;
    let input_name = session.inputs()[0].name().to_string();
    let output_name = session.outputs()[0].name().to_string();
    let mut outputs = session
        .run(ort::inputs![input_name.as_str() => input])
        .context("det inference")?;
    let output: DynValue = outputs.remove(&output_name).context("det output")?;
    let (shape, probs) = output.try_extract_tensor::<f32>().context("det tensor")?;
    let (map_h, map_w) = match shape.len() {
        4 => (shape[2] as usize, shape[3] as usize),
        3 => (shape[1] as usize, shape[2] as usize),
        _ => bail!("unexpected det output shape {shape:?}"),
    };
    // The map may be at the input's resolution or a fraction of it (a
    // head that stops at half resolution): boxes are scaled by the ratio.
    let (fx, fy) = (in_w as f32 / map_w as f32, in_h as f32 / map_h as f32);
    let boxes = crate::db::boxes_from_probability(
        probs,
        map_w,
        map_h,
        ((out_w as f32 / fx).ceil() as usize).min(map_w),
        ((out_h as f32 / fy).ceil() as usize).min(map_h),
        meta.prob_threshold,
        meta.box_threshold,
        meta.unclip,
    );
    let sx = roi.w / out_w as f32 * fx;
    let sy = roi.h / out_h as f32 * fy;
    let (fw, fh) = job.frame;
    Ok(boxes
        .into_iter()
        .map(|(rect, score)| DetectedLine {
            rect: Rect {
                x: roi.x + rect.x * sx,
                y: roi.y + rect.y * sy,
                w: rect.w * sx,
                h: rect.h * sy,
            }
            .clamp_to(fw, fh),
            score,
        })
        .filter(|line| line.rect.w >= 4.0 && line.rect.h >= 4.0)
        .collect())
}

struct Piece {
    line: usize,
    rect: Rect,
    width: usize,
}

fn read_piece(
    session: &mut Session,
    meta: &RecMeta,
    charset: &[String],
    frame: &RgbImage,
    piece: &Piece,
    input: &mut Vec<f32>,
) -> anyhow::Result<Recognized> {
    let height = meta.height as usize;
    let width = piece.width;
    let plane = height * width;
    input.clear();
    input.resize(3 * plane, 0.0);
    let (mean, std) = (meta.mean, meta.std);
    frame.resize_into_planes(
        piece.rect,
        width,
        height,
        width,
        plane,
        input,
        |_, value| (value / 255.0 - mean) / std,
    );
    let tensor =
        TensorRef::from_array_view(([1usize, 3, height, width], &**input)).context("rec input")?;
    let input_name = session.inputs()[0].name().to_string();
    let output_name = session.outputs()[0].name().to_string();
    let mut outputs = session
        .run(ort::inputs![input_name.as_str() => tensor])
        .context("rec inference")?;
    let output: DynValue = outputs.remove(&output_name).context("rec output")?;
    let (shape, probs) = output.try_extract_tensor::<f32>().context("rec tensor")?;
    if shape.len() != 3 {
        bail!("unexpected rec output shape {shape:?}");
    }
    let steps = shape[1] as usize;
    let classes = shape[2] as usize;
    let column_width = width as f32 / steps.max(1) as f32;
    let mut result = crate::ctc::greedy_decode(&probs[..steps * classes], classes, charset);
    let to_frame = piece.rect.w / width as f32 * column_width;
    for span in &mut result.spans {
        span.0 = piece.rect.x + span.0 * to_frame;
        span.1 = piece.rect.x + span.1 * to_frame;
    }
    Ok(result)
}

fn trim_trailing_empty(mut charset: Vec<String>) -> Vec<String> {
    while charset.last().is_some_and(String::is_empty) {
        charset.pop();
    }
    charset
}

/// CPU detector sessions, each on its own thread, on machines with room for
/// a second one (each keeps its own working buffers).
const DETECTION_SESSIONS: usize = 2;
const SECOND_SESSION_CORES: usize = 8;
const SECOND_SESSION_MEMORY: u64 = 15 << 30;

fn cpu_detection_sessions() -> usize {
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    let memory = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::new().with_memory(sysinfo::MemoryRefreshKind::new().with_ram()),
    )
    .total_memory();
    if cores >= SECOND_SESSION_CORES && memory >= SECOND_SESSION_MEMORY {
        DETECTION_SESSIONS
    } else {
        1
    }
}

fn detection_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 4)
}

fn recognition_sessions() -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    (cores / 3).clamp(1, 3)
}

/// An ONNX session. `keep_buffers: false` frees a run's buffers when it ends
/// instead of keeping an arena as large as the largest input seen, for the
/// detector whose regions range from a strip to the whole frame.
fn session(path: &Path, threads: usize, keep_buffers: bool) -> anyhow::Result<Session> {
    let mut builder = Session::builder()
        .context("ONNX session builder")?
        .with_intra_threads(threads)
        .map_err(|error| anyhow::anyhow!("intra threads: {error}"))?
        .with_intra_op_spinning(false)
        .map_err(|error| anyhow::anyhow!("intra spinning: {error}"))?
        .with_inter_op_spinning(false)
        .map_err(|error| anyhow::anyhow!("inter spinning: {error}"))?;
    if !keep_buffers {
        builder = builder
            .with_memory_pattern(false)
            .map_err(|error| anyhow::anyhow!("memory pattern: {error}"))?
            .with_execution_providers([ort::ep::CPU::default().with_arena_allocator(false).build()])
            .map_err(|error| anyhow::anyhow!("CPU arena: {error}"))?;
    }
    #[cfg(target_os = "windows")]
    let builder = register_directml(builder);
    let mut builder = builder;
    builder
        .commit_from_file(path)
        .with_context(|| format!("load {}", path.display()))
}

#[cfg(target_os = "windows")]
fn register_directml(
    builder: ort::session::builder::SessionBuilder,
) -> ort::session::builder::SessionBuilder {
    if std::env::var_os("CAP_REDACT_CPU").is_some() || !cap_camera_effects::directml_available() {
        return builder;
    }
    match builder.with_execution_providers([
        ort::execution_providers::DirectMLExecutionProvider::default()
            .build()
            .error_on_failure(),
    ]) {
        Ok(builder) => builder,
        Err(error) => {
            tracing::warn!("Auto redact: DirectML unavailable, using CPU: {error}");
            error.recover()
        }
    }
}
