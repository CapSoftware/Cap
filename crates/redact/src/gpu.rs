//! The text detector on the GPU (WGSL, [`crate::wdet`]): each region is
//! resampled to the detector's scale on the CPU, exactly as for the ONNX
//! detector, and a frame's regions are packed into one tile and detected in
//! one submit that is collected later, so frames overlap on the GPU.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::{Duration, Instant},
};

use anyhow::{Context, anyhow};

use crate::{
    db,
    image::{Rect, RgbImage},
    model::{DetMeta, DetectedLine},
    wdet,
};

const MAX_TILE: u32 = 2048;
/// Tile sizes are rounded to these steps so a few sizes cover most frames
/// and their buffers are reused rather than allocated per frame.
const ATLAS_STEP_X: usize = 256;
const ATLAS_STEP_Y: usize = 128;
/// Tile pixels kept allocated across frames; the least recently used sizes
/// go first beyond it.
const POOL_BUDGET: u64 = 6 << 20;
/// Black pixels between packed regions, so one region's text does not
/// reach into another's probabilities.
const GUTTER: usize = 64;

struct Slot {
    tile: wdet::Tile,
    texture: wgpu::Texture,
    view: wgpu::TextureView,
}

pub struct GpuDetector {
    device: wgpu::Device,
    queue: wgpu::Queue,
    detector: wdet::Detector,
    slots: HashMap<(u32, u32), Vec<Slot>>,
    /// Tiles whose detection has not been collected yet.
    busy: HashSet<((u32, u32), usize)>,
    last_used: HashMap<(u32, u32), u64>,
    frame: u64,
    /// Tile pixels the network ran on (regions, gutters and padding).
    pub processed: u64,
    pub created: u64,
    /// Tallest tile: f32 activations of a 2048 x 2048 tile pass the default
    /// storage binding limit.
    max_height: u32,
    pub adapter: String,
    /// Time spent resampling and uploading regions, waiting for the GPU,
    /// and turning probability maps into boxes.
    pub prepare: Duration,
    pub wait: Duration,
    pub post: Duration,
}

/// A region, the detector-scale size its pixels are resampled to, and where
/// they sit in which packed tile.
struct Job {
    roi: Rect,
    out_w: usize,
    out_h: usize,
    at: (usize, usize),
    atlas: usize,
}

impl GpuDetector {
    /// The GPU detector for a model drop with WGSL weights, or `None` when the
    /// drop has none or no GPU adapter is available.
    pub fn new(drop: &Path) -> anyhow::Result<Option<Self>> {
        let (layers, weights) = (drop.join("det.wgsl.json"), drop.join("det.wgsl.bin"));
        if !layers.exists() || !weights.exists() {
            return Ok(None);
        }
        let weights = wdet::Weights::load(&layers, &weights).map_err(|e| anyhow!("{e}"))?;
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let Ok(adapter) =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                ..Default::default()
            }))
        else {
            return Ok(None);
        };
        let info = adapter.get_info();
        if info.device_type == wgpu::DeviceType::Cpu {
            return Ok(None);
        }
        let (device, queue) = pollster::block_on(adapter.request_device(&Default::default()))
            .context("GPU device for the detector")?;
        let precision = if info.backend == wgpu::Backend::Metal {
            wdet::Precision::F16Packed
        } else {
            wdet::Precision::F32
        };
        let detector =
            wdet::Detector::new(&device, &weights, precision).map_err(|e| anyhow!("{e}"))?;
        Ok(Some(Self {
            device,
            queue,
            detector,
            slots: HashMap::new(),
            busy: HashSet::new(),
            last_used: HashMap::new(),
            frame: 0,
            processed: 0,
            created: 0,
            max_height: if precision == wdet::Precision::F32 {
                1088
            } else {
                MAX_TILE
            },
            prepare: Duration::ZERO,
            wait: Duration::ZERO,
            post: Duration::ZERO,
            adapter: format!("{} ({:?}, {:?})", info.name, info.backend, precision),
        }))
    }

    /// The tallest tile this detector runs, for [`pack_regions`].
    pub fn max_height(&self) -> u32 {
        self.max_height
    }

    /// A handle to wait on submissions without holding the detector.
    pub fn device(&self) -> wgpu::Device {
        self.device.clone()
    }

    /// Uploads and runs a [`pack_regions`] layout, returning its upload
    /// buffers for reuse.
    pub fn dispatch(&mut self, packed: Packed) -> anyhow::Result<(Ticket, Vec<Vec<u8>>)> {
        let started = Instant::now();
        let Packed {
            jobs,
            atlases,
            uploads,
            frame_size,
        } = packed;
        self.frame += 1;
        for size in &atlases {
            self.last_used.insert(*size, self.frame);
            self.processed += u64::from(size.0) * u64::from(size.1);
        }

        let mut slots = Vec::with_capacity(atlases.len());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        for (size, upload) in atlases.iter().zip(&uploads) {
            let index = self.reserve(*size)?;
            let slot = &self.slots[size][index];
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &slot.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                upload,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(size.0 * 4),
                    rows_per_image: Some(size.1),
                },
                wgpu::Extent3d {
                    width: size.0,
                    height: size.1,
                    depth_or_array_layers: 1,
                },
            );
            self.detector.encode(
                &self.queue,
                &self.device,
                &mut encoder,
                &slot.tile,
                &slot.view,
                [size.0, size.1],
                [0, 0],
                false,
            );
            self.detector.copy_prob(&mut encoder, &slot.tile);
            slots.push((*size, index));
        }
        let submission = self.queue.submit([encoder.finish()]);
        for (size, index) in &slots {
            self.detector.map_prob(&self.slots[size][*index].tile);
        }
        self.prepare += started.elapsed();
        Ok((
            Ticket {
                jobs,
                atlases,
                slots,
                submission,
                frame_size,
            },
            uploads,
        ))
    }

    /// The lines of a [`Self::dispatch`], per region, waiting for the GPU if it
    /// has not finished.
    pub fn collect(
        &mut self,
        ticket: Ticket,
        meta: &DetMeta,
    ) -> anyhow::Result<Vec<Vec<DetectedLine>>> {
        let wait_started = Instant::now();
        let _ = self
            .device
            .poll(wgpu::PollType::WaitForSubmissionIndex(ticket.submission));
        self.wait += wait_started.elapsed();

        let post_started = Instant::now();
        let maps = ticket
            .slots
            .iter()
            .map(|(size, index)| self.detector.take_prob(&self.slots[size][*index].tile))
            .collect::<Vec<_>>();
        for (size, index) in &ticket.slots {
            self.busy.remove(&(*size, *index));
        }
        let (fw, fh) = ticket.frame_size;
        let mut out = Vec::with_capacity(ticket.jobs.len());
        for job in &ticket.jobs {
            let Some(job) = job else {
                out.push(Vec::new());
                continue;
            };
            let size = ticket.atlases[job.atlas];
            let (map_w, map_h) = (size.0 as usize / 2, size.1 as usize / 2);
            let (x, y) = (job.at.0 / 2, job.at.1 / 2);
            let boxes = db::boxes_from_probability(
                &maps[job.atlas][y * map_w + x..],
                map_w,
                map_h - y,
                job.out_w.div_ceil(2),
                job.out_h.div_ceil(2),
                meta.prob_threshold,
                meta.box_threshold,
                meta.unclip,
            );
            let sx = job.roi.w / job.out_w as f32 * 2.0;
            let sy = job.roi.h / job.out_h as f32 * 2.0;
            out.push(
                boxes
                    .into_iter()
                    .map(|(rect, score)| DetectedLine {
                        rect: Rect::new(
                            job.roi.x + rect.x * sx,
                            job.roi.y + rect.y * sy,
                            rect.w * sx,
                            rect.h * sy,
                        )
                        .clamp_to(fw, fh),
                        score,
                    })
                    .filter(|line| line.rect.w >= 4.0 && line.rect.h >= 4.0)
                    .collect(),
            );
        }
        self.post += post_started.elapsed();
        Ok(out)
    }

    /// A free tile of `size` (one not in flight), made if needed.
    fn reserve(&mut self, size: (u32, u32)) -> anyhow::Result<usize> {
        let pool = self.slots.entry(size).or_default();
        let free = (0..pool.len()).find(|index| !self.busy.contains(&(size, *index)));
        let index = match free {
            Some(index) => index,
            None => {
                pool.push(new_slot(&self.device, &self.detector, size)?);
                self.created += 1;
                pool.len() - 1
            }
        };
        self.busy.insert((size, index));
        self.evict();
        Ok(index)
    }
}

/// Upload buffers kept for reuse.
pub const SPARE_UPLOADS: usize = 4;

/// A frame's regions laid out in tiles and resampled into their upload
/// buffers, ready for [`GpuDetector::dispatch`].
pub struct Packed {
    jobs: Vec<Option<Job>>,
    atlases: Vec<(u32, u32)>,
    uploads: Vec<Vec<u8>>,
    frame_size: (u32, u32),
}

/// Lays out `rois` of `frame` at `scale` in tiles no taller than
/// `max_height` and resamples them into RGBA upload buffers (taken from
/// `spare` when it has some). [`GpuDetector::dispatch`] runs the layout. Needs no GPU, so it can run beside the GPU
/// work of other frames.
pub fn pack_regions(
    frame: &RgbImage,
    rois: &[Rect],
    scale: f32,
    meta: &DetMeta,
    max_height: u32,
    spare: &mut Vec<Vec<u8>>,
) -> Packed {
    let max_side = meta.max_side.max(64) as f32;
    let mut jobs = Vec::with_capacity(rois.len());
    for roi in rois {
        let roi = roi.clamp_to(frame.width, frame.height);
        if roi.w < 8.0 || roi.h < 8.0 {
            jobs.push(None);
            continue;
        }
        let scale = scale
            .min(max_side / roi.w.max(roi.h))
            .min(MAX_TILE as f32 / roi.w)
            .min(max_height as f32 / roi.h)
            .max(0.05);
        let out_w = ((roi.w * scale).round() as usize).clamp(16, MAX_TILE as usize);
        let out_h = ((roi.h * scale).round() as usize).clamp(16, max_height as usize);
        jobs.push(Some(Job {
            roi,
            out_w,
            out_h,
            at: (0, 0),
            atlas: 0,
        }));
    }
    let atlases = pack(&mut jobs, max_height);
    let mut uploads = Vec::with_capacity(atlases.len());
    for (atlas, size) in atlases.iter().enumerate() {
        let (aw, ah) = (size.0 as usize, size.1 as usize);
        let mut upload = spare.pop().unwrap_or_default();
        upload.clear();
        upload.resize(aw * ah * 4, 0);
        for alpha in upload.iter_mut().skip(3).step_by(4) {
            *alpha = 255;
        }
        for job in jobs.iter().flatten().filter(|job| job.atlas == atlas) {
            let (x, y) = job.at;
            frame.resize_into_rgba(
                job.roi,
                job.out_w,
                job.out_h,
                aw,
                &mut upload[(y * aw + x) * 4..],
            );
        }
        uploads.push(upload);
    }
    Packed {
        jobs,
        atlases,
        uploads,
        frame_size: (frame.width, frame.height),
    }
}

/// Detection in flight on the GPU.
pub struct Ticket {
    jobs: Vec<Option<Job>>,
    atlases: Vec<(u32, u32)>,
    slots: Vec<((u32, u32), usize)>,
    submission: wgpu::SubmissionIndex,
    frame_size: (u32, u32),
}

impl Ticket {
    /// The submission to wait for before [`GpuDetector::collect`].
    pub fn submission(&self) -> wgpu::SubmissionIndex {
        self.submission.clone()
    }
}

impl GpuDetector {
    fn evict(&mut self) {
        let area = |slots: &HashMap<(u32, u32), Vec<Slot>>| {
            slots
                .iter()
                .map(|(size, pool)| u64::from(size.0) * u64::from(size.1) * pool.len() as u64)
                .sum::<u64>()
        };
        while area(&self.slots) > POOL_BUDGET {
            let busy = &self.busy;
            let Some(oldest) = self
                .slots
                .keys()
                .filter(|size| !busy.iter().any(|(b, _)| b == *size))
                .min_by_key(|size| self.last_used.get(size).copied().unwrap_or(0))
                .copied()
            else {
                return;
            };
            self.slots.remove(&oldest);
            self.last_used.remove(&oldest);
        }
    }
}

/// Places every job on shelves (tallest first, a gutter apart, at even
/// coordinates so the half-resolution map lines up) in as few tiles as fit,
/// and returns each tile's size.
fn pack(jobs: &mut [Option<Job>], max_height: u32) -> Vec<(u32, u32)> {
    let mut order = (0..jobs.len())
        .filter(|i| jobs[*i].is_some())
        .collect::<Vec<_>>();
    order.sort_by_key(|i| std::cmp::Reverse(jobs[*i].as_ref().map_or(0, |job| job.out_h)));
    let widest = order
        .iter()
        .filter_map(|i| jobs[*i].as_ref())
        .map(|job| job.out_w)
        .max()
        .unwrap_or(0);
    let even = |v: usize| v.div_ceil(2) * 2;
    let area = order
        .iter()
        .filter_map(|i| jobs[*i].as_ref())
        .map(|job| ((job.out_w + GUTTER) * (job.out_h + GUTTER)) as f32)
        .sum::<f32>();
    let width =
        round_up(widest.max((area.sqrt() * 1.15) as usize), ATLAS_STEP_X).min(MAX_TILE as usize);
    let mut atlases: Vec<(u32, u32)> = Vec::new();
    let (mut x, mut y, mut shelf, mut used_h) = (0usize, 0usize, 0usize, 0usize);
    let mut atlas = 0usize;
    let mut open = false;
    for index in order {
        let Some(job) = jobs[index].as_mut() else {
            continue;
        };
        if open && x + job.out_w > width {
            x = 0;
            y += shelf + GUTTER;
            shelf = 0;
        }
        if open && y + job.out_h > max_height as usize {
            atlases.push((
                width as u32,
                round_up(used_h, ATLAS_STEP_Y).min(max_height as usize) as u32,
            ));
            atlas += 1;
            (x, y, shelf, used_h) = (0, 0, 0, 0);
        }
        open = true;
        job.at = (x, y);
        job.atlas = atlas;
        shelf = shelf.max(even(job.out_h));
        used_h = used_h.max(y + job.out_h);
        x += even(job.out_w) + GUTTER;
    }
    if open {
        atlases.push((
            width as u32,
            round_up(used_h, ATLAS_STEP_Y).min(max_height as usize) as u32,
        ));
    }
    atlases
}

fn round_up(value: usize, multiple: usize) -> usize {
    value.max(1).div_ceil(multiple) * multiple
}

fn new_slot(
    device: &wgpu::Device,
    detector: &wdet::Detector,
    (width, height): (u32, u32),
) -> anyhow::Result<Slot> {
    let tile = detector
        .tile(device, width, height)
        .map_err(|e| anyhow!("{e}"))?;
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("redact detector input"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    Ok(Slot {
        tile,
        texture,
        view,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packed_regions_never_touch_and_fit_their_tiles() {
        let sizes = [
            (1900, 40),
            (300, 60),
            (300, 60),
            (900, 500),
            (64, 32),
            (1200, 1000),
        ];
        let mut jobs = sizes
            .iter()
            .map(|(w, h)| {
                Some(Job {
                    roi: Rect::new(0.0, 0.0, *w as f32, *h as f32),
                    out_w: *w,
                    out_h: *h,
                    at: (0, 0),
                    atlas: 0,
                })
            })
            .collect::<Vec<_>>();
        jobs.insert(2, None);
        let atlases = pack(&mut jobs, 1088);
        let placed = jobs.iter().flatten().collect::<Vec<_>>();
        for job in &placed {
            let (aw, ah) = atlases[job.atlas];
            assert!(job.at.0 + job.out_w <= aw as usize && job.at.1 + job.out_h <= ah as usize);
            assert!(job.at.0 % 2 == 0 && job.at.1 % 2 == 0);
        }
        for (i, a) in placed.iter().enumerate() {
            for b in &placed[i + 1..] {
                if a.atlas != b.atlas {
                    continue;
                }
                let apart_x =
                    a.at.0 + a.out_w + GUTTER <= b.at.0 || b.at.0 + b.out_w + GUTTER <= a.at.0;
                let apart_y =
                    a.at.1 + a.out_h + GUTTER <= b.at.1 || b.at.1 + b.out_h + GUTTER <= a.at.1;
                assert!(apart_x || apart_y, "{:?} {:?}", a.at, b.at);
            }
        }
    }

    /// The WGSL detector against the reference probabilities shipped in a
    /// model drop's `det.wgsl.test/`. Set `CAP_REDACT_TEST_DROP` to the drop;
    /// skipped without it or without a GPU adapter.
    #[test]
    fn matches_the_reference_network() {
        let Some(drop) = std::env::var_os("CAP_REDACT_TEST_DROP") else {
            return;
        };
        let drop = std::path::PathBuf::from(drop);
        let fixture = drop.join("det.wgsl.test");
        let info: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture.join("info.json")).unwrap()).unwrap();
        let (w, h) = (
            info["w"].as_u64().unwrap() as u32,
            info["h"].as_u64().unwrap() as u32,
        );
        let rgba = std::fs::read(fixture.join("input.rgba")).unwrap();
        let reference = std::fs::read(fixture.join("ref.bin"))
            .unwrap()
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect::<Vec<_>>();
        let weights =
            wdet::Weights::load(drop.join("det.wgsl.json"), drop.join("det.wgsl.bin")).unwrap();
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let Ok(adapter) = pollster::block_on(instance.request_adapter(&Default::default())) else {
            return;
        };
        let (device, queue) =
            pollster::block_on(adapter.request_device(&Default::default())).unwrap();
        let texture = wgpu::util::DeviceExt::create_texture_with_data(
            &device,
            &queue,
            &wgpu::TextureDescriptor {
                label: None,
                size: wgpu::Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &rgba,
        );
        let view = texture.create_view(&Default::default());
        for (precision, max_abs, max_flips) in [
            (wdet::Precision::F32, 1e-4f32, 0.0f64),
            (wdet::Precision::F16Packed, 2e-2, 1e-4),
        ] {
            let detector = wdet::Detector::new(&device, &weights, precision).unwrap();
            let tile = detector.tile(&device, w, h).unwrap();
            let mut encoder = device.create_command_encoder(&Default::default());
            detector.encode(
                &queue,
                &device,
                &mut encoder,
                &tile,
                &view,
                [w, h],
                [0, 0],
                false,
            );
            queue.submit([encoder.finish()]);
            let got = detector.read_prob(&device, &queue, &tile);
            assert_eq!(got.len(), reference.len());
            let worst = got
                .iter()
                .zip(&reference)
                .map(|(a, b)| (a - b).abs())
                .fold(0f32, f32::max);
            let flips = got
                .iter()
                .zip(&reference)
                .filter(|(a, b)| (**a > 0.3) != (**b > 0.3))
                .count();
            eprintln!("{precision:?}: max abs {worst:.2e}, {flips} flips");
            assert!(worst < max_abs, "{precision:?} max abs {worst}");
            assert!(
                flips as f64 <= max_flips * got.len() as f64,
                "{precision:?} {flips} flips"
            );
        }
    }
}
