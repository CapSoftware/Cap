//! Auto redact: hides detected regions on the display frame in source space,
//! right after the frame is copied in and before enhancement, zoom, crop and
//! composite, so every later step sees the redacted frame.

use std::{
    path::Path,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

use bytemuck::{Pod, Zeroable};
use cap_project::{
    AutoRedactConfiguration, RedactStyle,
    redaction::{RedactionIndex, Redactions},
};

/// The regions hidden on one display frame, normalized to the frame.
#[derive(Clone, Debug, PartialEq)]
pub struct RedactionFrame {
    pub rects: Vec<RedactionRect>,
    pub style: RedactStyle,
    pub amount: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RedactionRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub highlighted: bool,
}

impl RedactionFrame {
    /// A non-zero identity of what this frame draws; the display layer
    /// re-uploads a reused source frame when it changes.
    pub fn key(&self) -> u64 {
        let mut hash = 0xcbf29ce484222325u64;
        let mut feed = |value: u32| {
            for byte in value.to_le_bytes() {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x100000001b3);
            }
        };
        feed(match self.style {
            RedactStyle::Pixelate => 1,
            RedactStyle::Blur => 2,
        });
        feed(self.amount.to_bits());
        for rect in &self.rects {
            feed(rect.x.to_bits());
            feed(rect.y.to_bits());
            feed(rect.w.to_bits());
            feed(rect.h.to_bits());
            feed(u32::from(rect.highlighted));
        }
        hash.max(1)
    }
}

/// Block edge in source pixels for a region of `height_px`: at least a third
/// of the line, so no glyph keeps its shape at any zoom.
pub fn block_size(height_px: f32, amount: f32, style: RedactStyle) -> u32 {
    let factor = 0.34 + 0.32 * amount.clamp(0.0, 1.0);
    let factor = match style {
        RedactStyle::Pixelate => factor,
        RedactStyle::Blur => factor * 1.25,
    };
    ((height_px * factor).round() as u32).max(4)
}

/// Detections loaded for a project and the index built from them for the
/// current settings.
#[derive(Default)]
pub struct RedactionStore {
    loaded: AtomicBool,
    redactions: RwLock<Option<(u64, Arc<Redactions>)>>,
    highlighted: RwLock<Vec<String>>,
    index: Mutex<Option<IndexEntry>>,
}

struct IndexEntry {
    generation: u64,
    categories: Vec<cap_project::RedactCategory>,
    excluded: Vec<String>,
    index: Arc<RedactionIndex>,
}

impl RedactionStore {
    pub fn set(&self, redactions: Option<Arc<Redactions>>) {
        self.loaded.store(true, Ordering::Release);
        let mut guard = self.redactions.write().unwrap_or_else(|e| e.into_inner());
        let generation = guard.as_ref().map_or(0, |(g, _)| *g) + 1;
        *guard = redactions.map(|r| (generation, r));
    }

    pub fn get(&self) -> Option<Arc<Redactions>> {
        self.redactions
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|(_, r)| r.clone())
    }

    /// Regions drawn with an outline (editor preview only).
    pub fn set_highlighted(&self, ids: Vec<String>) {
        *self.highlighted.write().unwrap_or_else(|e| e.into_inner()) = ids;
    }

    fn index(&self, config: &AutoRedactConfiguration) -> Option<Arc<RedactionIndex>> {
        let (generation, redactions) = self
            .redactions
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()?;
        let mut cache = self.index.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = cache.as_ref()
            && entry.generation == generation
            && entry.categories == config.categories
            && entry.excluded == config.excluded
        {
            return Some(entry.index.clone());
        }
        let index = Arc::new(RedactionIndex::new(&redactions, config));
        *cache = Some(IndexEntry {
            generation,
            categories: config.categories.clone(),
            excluded: config.excluded.clone(),
            index: index.clone(),
        });
        Some(index)
    }

    /// What to hide on the display frame of recording `segment` at
    /// `source_time`; `None` when auto redact is off or nothing is active.
    pub fn frame(
        &self,
        config: &AutoRedactConfiguration,
        project_path: &Path,
        segment: u32,
        source_time: f64,
        preview: bool,
    ) -> Option<RedactionFrame> {
        if !config.enabled {
            return None;
        }
        if !self.loaded.swap(true, Ordering::AcqRel)
            && let Some(redactions) = Redactions::load(project_path)
        {
            self.set(Some(Arc::new(redactions)));
        }
        let index = self.index(config)?;
        let highlighted = if preview {
            self.highlighted
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        } else {
            Vec::new()
        };
        let mut rects = Vec::new();
        let mut now = Vec::new();
        index.for_each_around(segment, source_time, |id, rect, on_screen| {
            rects.push(RedactionRect {
                x: rect.x,
                y: rect.y,
                w: rect.w,
                h: rect.h,
                highlighted: highlighted.iter().any(|h| h == id),
            });
            now.push(on_screen);
        });
        if rects.is_empty() {
            return None;
        }
        if rects.len() > MAX_REGIONS {
            // Drawn in more than one batch: what is on screen at this time goes first.
            let (mut first, later): (Vec<_>, Vec<_>) = rects
                .into_iter()
                .zip(now)
                .partition(|(_, on_screen)| *on_screen);
            first.extend(later);
            rects = first.into_iter().map(|(rect, _)| rect).collect();
        }
        Some(RedactionFrame {
            rects,
            style: config.style,
            amount: config.effective_amount(),
        })
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Debug, PartialEq)]
struct GpuRegion {
    origin: [u32; 2],
    size: [u32; 2],
    block: u32,
    blocks_x: u32,
    blocks_y: u32,
    offset: u32,
    flags: u32,
    _pad: [u32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct GpuParams {
    frame_size: [u32; 2],
    region_count: u32,
    total_blocks: u32,
}

/// Regions drawn in one batch; a frame with more is drawn in several.
const MAX_REGIONS: usize = 512;

/// How far a mask reaches past its detected box, as a share of the box's
/// height above and below, so glyph edges at the box border are covered.
const GROW_Y: f32 = 0.1;

fn gpu_regions(
    frame: &RedactionFrame,
    rects: &[RedactionRect],
    width: u32,
    height: u32,
) -> (Vec<GpuRegion>, u32) {
    let mut regions = Vec::with_capacity(rects.len());
    let mut offset = 0u32;
    for rect in rects {
        let grow_y = (rect.h * height as f32 * GROW_Y).max(1.0);
        let x0 = (rect.x * width as f32 - 1.0).floor().max(0.0) as u32;
        let y0 = (rect.y * height as f32 - grow_y).floor().max(0.0) as u32;
        let x1 = ((rect.x + rect.w) * width as f32 + 1.0)
            .ceil()
            .min(width as f32) as u32;
        let y1 = ((rect.y + rect.h) * height as f32 + grow_y)
            .ceil()
            .min(height as f32) as u32;
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        let (w, h) = (x1 - x0, y1 - y0);
        let block = block_size(h as f32, frame.amount, frame.style).min(w.max(h));
        let blocks_x = w.div_ceil(block);
        let blocks_y = h.div_ceil(block);
        let mut flags = 0;
        if rect.highlighted {
            flags |= 1;
        }
        if frame.style == RedactStyle::Blur {
            flags |= 2;
        }
        regions.push(GpuRegion {
            origin: [x0, y0],
            size: [w, h],
            block,
            blocks_x,
            blocks_y,
            offset,
            flags,
            _pad: [0; 3],
        });
        offset += blocks_x * blocks_y;
    }
    (regions, offset)
}

/// GPU passes that pixelate or blur regions of a display frame in place.
pub struct Redactor {
    average_pipeline: wgpu::ComputePipeline,
    apply_pipeline: wgpu::RenderPipeline,
    average_layout: wgpu::BindGroupLayout,
    apply_layout: wgpu::BindGroupLayout,
    /// One set per batch of a frame's regions: every batch's data has to be
    /// there when the encoded passes run.
    batches: Vec<BatchBuffers>,
}

struct BatchBuffers {
    params: wgpu::Buffer,
    regions: Option<(wgpu::Buffer, u64)>,
    blocks: Option<(wgpu::Buffer, u64)>,
}

impl BatchBuffers {
    fn new(device: &wgpu::Device) -> Self {
        Self {
            params: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Redaction params"),
                size: std::mem::size_of::<GpuParams>() as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
            regions: None,
            blocks: None,
        }
    }
}

fn storage_entry(
    binding: u32,
    visibility: wgpu::ShaderStages,
    read_only: bool,
) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn uniform_entry(binding: u32, visibility: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

impl Redactor {
    pub fn new(device: &wgpu::Device) -> Self {
        let average_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Redaction average layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                storage_entry(1, wgpu::ShaderStages::COMPUTE, true),
                storage_entry(2, wgpu::ShaderStages::COMPUTE, false),
                uniform_entry(3, wgpu::ShaderStages::COMPUTE),
            ],
        });
        let apply_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Redaction apply layout"),
            entries: &[
                storage_entry(0, wgpu::ShaderStages::FRAGMENT, true),
                storage_entry(
                    1,
                    wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    true,
                ),
                uniform_entry(2, wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT),
            ],
        });
        let average_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Redaction average"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/redaction_average.wgsl").into()),
        });
        let apply_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Redaction apply"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/redaction_apply.wgsl").into()),
        });
        let average_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Redaction average"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("Redaction average layout"),
                    bind_group_layouts: &[&average_layout],
                    push_constant_ranges: &[],
                }),
            ),
            module: &average_shader,
            entry_point: Some("average"),
            compilation_options: Default::default(),
            cache: None,
        });
        let apply_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Redaction apply"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("Redaction apply layout"),
                    bind_group_layouts: &[&apply_layout],
                    push_constant_ranges: &[],
                }),
            ),
            vertex: wgpu::VertexState {
                module: &apply_shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &apply_shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        Self {
            average_pipeline,
            apply_pipeline,
            average_layout,
            apply_layout,
            batches: vec![BatchBuffers::new(device)],
        }
    }

    fn buffer<'a>(
        slot: &'a mut Option<(wgpu::Buffer, u64)>,
        device: &wgpu::Device,
        label: &str,
        size: u64,
        usage: wgpu::BufferUsages,
    ) -> &'a wgpu::Buffer {
        let size = size.max(64).next_power_of_two();
        if slot.as_ref().is_none_or(|(_, cap)| *cap < size) {
            *slot = Some((
                device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(label),
                    size,
                    usage,
                    mapped_at_creation: false,
                }),
                size,
            ));
        }
        &slot.as_ref().unwrap().0
    }

    /// Records the passes that hide `frame`'s regions on `texture`, a batch
    /// of regions at a time.
    pub fn encode(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        texture: &wgpu::Texture,
        frame: &RedactionFrame,
    ) {
        let (width, height) = (texture.width(), texture.height());
        for (batch, rects) in frame.rects.chunks(MAX_REGIONS).enumerate() {
            let (regions, total_blocks) = gpu_regions(frame, rects, width, height);
            if regions.is_empty() || total_blocks == 0 {
                continue;
            }
            if self.batches.len() <= batch {
                self.batches.push(BatchBuffers::new(device));
            }
            self.encode_batch(
                device,
                queue,
                encoder,
                texture,
                batch,
                &regions,
                total_blocks,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn encode_batch(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        texture: &wgpu::Texture,
        batch: usize,
        regions: &[GpuRegion],
        total_blocks: u32,
    ) {
        let (width, height) = (texture.width(), texture.height());
        let buffers = &mut self.batches[batch];
        let region_bytes = bytemuck::cast_slice::<GpuRegion, u8>(regions);
        let region_buffer = Self::buffer(
            &mut buffers.regions,
            device,
            "Redaction regions",
            region_bytes.len() as u64,
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        )
        .clone();
        queue.write_buffer(&region_buffer, 0, region_bytes);
        let block_buffer = Self::buffer(
            &mut buffers.blocks,
            device,
            "Redaction blocks",
            u64::from(total_blocks) * 16,
            wgpu::BufferUsages::STORAGE,
        )
        .clone();
        let params = buffers.params.clone();
        queue.write_buffer(
            &params,
            0,
            bytemuck::bytes_of(&GpuParams {
                frame_size: [width, height],
                region_count: regions.len() as u32,
                total_blocks,
            }),
        );
        let view = texture.create_view(&Default::default());
        let average_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Redaction average"),
            layout: &self.average_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: region_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: block_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: params.as_entire_binding(),
                },
            ],
        });
        let apply_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Redaction apply"),
            layout: &self.apply_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: block_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: region_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: params.as_entire_binding(),
                },
            ],
        });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Redaction average"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.average_pipeline);
            pass.set_bind_group(0, &average_group, &[]);
            pass.dispatch_workgroups(total_blocks.div_ceil(64), 1, 1);
        }
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Redaction apply"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.apply_pipeline);
            pass.set_bind_group(0, &apply_group, &[]);
            pass.draw(0..6, 0..regions.len() as u32);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(rects: &[(f32, f32, f32, f32)], style: RedactStyle) -> RedactionFrame {
        RedactionFrame {
            rects: rects
                .iter()
                .map(|&(x, y, w, h)| RedactionRect {
                    x,
                    y,
                    w,
                    h,
                    highlighted: false,
                })
                .collect(),
            style,
            amount: 0.5,
        }
    }

    #[test]
    fn blocks_are_at_least_a_third_of_the_line() {
        for height in [8.0, 20.0, 40.0, 120.0] {
            let block = block_size(height, 0.0, RedactStyle::Pixelate) as f32;
            assert!(
                block >= (height / 3.0).floor().max(4.0),
                "{height} -> {block}"
            );
        }
    }

    #[test]
    fn masks_reach_past_the_detected_box() {
        let frame = frame(&[(0.1, 0.1, 0.2, 0.02)], RedactStyle::Pixelate);
        let (regions, _) = gpu_regions(&frame, &frame.rects, 1920, 1080);
        let region = &regions[0];
        let (bx0, by0, bx1, by1) = (192.0, 108.0, 576.0, 129.6);
        assert!(region.origin[0] as f32 <= bx0 - 1.0);
        assert!(region.origin[1] as f32 <= by0 - 2.0);
        assert!((region.origin[0] + region.size[0]) as f32 >= bx1 + 1.0);
        assert!((region.origin[1] + region.size[1]) as f32 >= by1 + 2.0);
    }

    #[test]
    fn regions_are_laid_out_back_to_back() {
        let frame = frame(
            &[(0.1, 0.1, 0.2, 0.02), (0.5, 0.5, 0.1, 0.05)],
            RedactStyle::Pixelate,
        );
        let (regions, total) = gpu_regions(&frame, &frame.rects, 1920, 1080);
        assert_eq!(regions.len(), 2);
        assert_eq!(regions[1].offset, regions[0].blocks_x * regions[0].blocks_y);
        assert_eq!(
            total,
            regions[1].offset + regions[1].blocks_x * regions[1].blocks_y
        );
        for region in &regions {
            assert!(region.blocks_x * region.block >= region.size[0]);
            assert!(region.blocks_y * region.block >= region.size[1]);
        }
    }

    #[test]
    fn keys_change_with_content() {
        let a = frame(&[(0.1, 0.1, 0.2, 0.02)], RedactStyle::Pixelate);
        let mut b = a.clone();
        b.rects[0].x = 0.11;
        let mut c = a.clone();
        c.style = RedactStyle::Blur;
        assert_ne!(a.key(), b.key());
        assert_ne!(a.key(), c.key());
        assert_eq!(a.key(), a.clone().key());
        assert_ne!(a.key(), 0);
    }

    #[test]
    fn store_returns_nothing_when_off() {
        let store = RedactionStore::default();
        let mut redactions = Redactions {
            version: cap_project::redaction::REDACTIONS_VERSION,
            ..Default::default()
        };
        redactions
            .regions
            .push(cap_project::redaction::RedactionRegion {
                id: "a".into(),
                segment: 0,
                category: cap_project::RedactCategory::Email,
                start: 0.0,
                end: 1.0,
                keys: vec![cap_project::redaction::RedactionKey {
                    t: 0.0,
                    x: 0.1,
                    y: 0.1,
                    w: 0.2,
                    h: 0.05,
                }],
            });
        store.set(Some(Arc::new(redactions)));
        let mut config = AutoRedactConfiguration::default();
        let path = Path::new("/nonexistent");
        assert!(store.frame(&config, path, 0, 0.5, false).is_none());
        config.enabled = true;
        assert_eq!(
            store
                .frame(&config, path, 0, 0.5, false)
                .unwrap()
                .rects
                .len(),
            1
        );
        assert!(store.frame(&config, path, 1, 0.5, false).is_none());
        config.excluded.push("a".into());
        assert!(store.frame(&config, path, 0, 0.5, false).is_none());
    }
}
