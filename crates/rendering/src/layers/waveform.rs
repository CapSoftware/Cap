use bytemuck::{Pod, Zeroable};
use cap_project::{
    ClipOffsets, ProjectConfiguration, StudioRecordingMeta, TimelineFrameMapping, WaveformSegment,
    WaveformSource, WaveformStyle,
};
use wgpu::util::DeviceExt;

use crate::{
    AUDIO_LEVEL_BANDS, AudioLevelSource, AudioLevelStore, ProjectUniforms, RenderVideoConstants,
    segment_timing::segment_video_timing, text::parse_rgb_color,
};

const MAX_BARS: usize = WaveformSegment::MAX_BAR_COUNT as usize;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct WaveformUniforms {
    rect: [f32; 4],
    canvas: [f32; 4],
    color: [f32; 4],
    secondary: [f32; 4],
    shape: [f32; 4],
    values: [[f32; 4]; MAX_BARS / 4],
}

fn style_index(style: WaveformStyle) -> f32 {
    match style {
        WaveformStyle::Bars => 0.0,
        WaveformStyle::Mirrored => 1.0,
        WaveformStyle::Line => 2.0,
        WaveformStyle::Dots => 3.0,
    }
}

/// Resamples the analysed bands to one value per bar: averaged when bars are
/// fewer than bands, interpolated when there are more.
fn bar_values(bands: &[f32; AUDIO_LEVEL_BANDS], count: usize, sensitivity: f32) -> Vec<f32> {
    let gain = if sensitivity.is_finite() {
        sensitivity.max(0.0)
    } else {
        1.0
    };
    (0..count)
        .map(|bar| {
            let value = if count < AUDIO_LEVEL_BANDS {
                let start = bar * AUDIO_LEVEL_BANDS / count;
                let end = ((bar + 1) * AUDIO_LEVEL_BANDS / count).max(start + 1);
                bands[start..end].iter().sum::<f32>() / (end - start) as f32
            } else {
                let position = ((bar as f32 + 0.5) * AUDIO_LEVEL_BANDS as f32 / count as f32 - 0.5)
                    .clamp(0.0, (AUDIO_LEVEL_BANDS - 1) as f32);
                let low = position.floor() as usize;
                let high = (low + 1).min(AUDIO_LEVEL_BANDS - 1);
                let fraction = position - low as f32;
                bands[low] * (1.0 - fraction) + bands[high] * fraction
            };
            (value * gain).clamp(0.0, 1.0)
        })
        .collect()
}

fn waveform_uniforms(
    segment: &WaveformSegment,
    output_size: (u32, u32),
    values: &[f32],
) -> Option<WaveformUniforms> {
    if output_size.0 == 0 || output_size.1 == 0 || !segment.opacity.is_finite() {
        return None;
    }
    let opacity = segment.opacity.clamp(0.0, 1.0);
    if opacity <= 0.0 {
        return None;
    }
    let (width, height) = (f64::from(output_size.0), f64::from(output_size.1));
    let rect = [
        (segment.center.x * width) as f32,
        (segment.center.y * height) as f32,
        (segment.size.x * width * 0.5) as f32,
        (segment.size.y * height * 0.5) as f32,
    ];
    if rect
        .iter()
        .any(|value| !value.is_finite() || value.abs() > 1.0e7)
        || rect[2] < 1.0
        || rect[3] < 1.0
        || rect[0] + rect[2] < 0.0
        || rect[1] + rect[3] < 0.0
        || rect[0] - rect[2] > width as f32
        || rect[1] - rect[3] > height as f32
    {
        return None;
    }
    let count = segment.clamped_bar_count() as usize;
    let unit = |value: f32, fallback: f32| {
        if value.is_finite() {
            value.clamp(0.0, 1.0)
        } else {
            fallback
        }
    };
    let color = parse_rgb_color(&segment.color).unwrap_or([1.0; 4]);
    let secondary = segment
        .secondary_color
        .as_deref()
        .and_then(parse_rgb_color)
        .map(|[r, g, b, _]| [r, g, b, 1.0])
        .unwrap_or([color[0], color[1], color[2], 0.0]);
    let mut uniforms = WaveformUniforms {
        rect,
        canvas: [
            output_size.0 as f32,
            output_size.1 as f32,
            count as f32,
            style_index(segment.style),
        ],
        color: [color[0], color[1], color[2], opacity],
        secondary,
        shape: [
            unit(segment.bar_width, 0.6).max(0.05),
            unit(segment.rounding, 1.0),
            0.0,
            0.0,
        ],
        values: [[0.0; 4]; MAX_BARS / 4],
    };
    for (index, value) in values.iter().take(count).enumerate() {
        uniforms.values[index / 4][index % 4] = *value;
    }
    Some(uniforms)
}

fn clip_offsets(
    meta: &StudioRecordingMeta,
    project: &ProjectConfiguration,
    clip: u32,
) -> ClipOffsets {
    if let Some(config) = project.clips.iter().find(|config| config.index == clip) {
        return config.offsets;
    }
    match meta {
        StudioRecordingMeta::SingleSegment { .. } => ClipOffsets::default(),
        StudioRecordingMeta::MultipleSegments { inner } => inner
            .segments
            .get(clip as usize)
            .map(|segment| segment.calculate_audio_offsets())
            .unwrap_or_default(),
    }
}

fn clip_count(meta: &StudioRecordingMeta) -> usize {
    match meta {
        StudioRecordingMeta::SingleSegment { .. } => 1,
        StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
    }
}

/// Band levels for a segment at output `time`, read at the source time each
/// audio file plays then so trims, cuts and speed changes stay in sync. A
/// held frame plays silence.
fn segment_levels(
    store: &AudioLevelStore,
    meta: &StudioRecordingMeta,
    project: &ProjectConfiguration,
    time: f64,
    segment: &WaveformSegment,
) -> [f32; AUDIO_LEVEL_BANDS] {
    let mut bands = [0.0; AUDIO_LEVEL_BANDS];
    let source = match project
        .timeline
        .as_ref()
        .and_then(|timeline| timeline.get_frame_mapping(time))
    {
        Some(TimelineFrameMapping::Single { source, .. }) => source,
        Some(TimelineFrameMapping::Transition { incoming, .. }) => incoming,
        Some(TimelineFrameMapping::Hold { .. }) | None => return bands,
    };
    let clip = source.segment.recording_clip;
    if clip as usize >= clip_count(meta) {
        return bands;
    }
    let offsets = clip_offsets(meta, project, clip);
    let system = if store.get(clip, AudioLevelSource::System).is_some() {
        AudioLevelSource::System
    } else {
        AudioLevelSource::Display
    };
    let sources: &[AudioLevelSource] = match segment.source {
        WaveformSource::Mix => &[
            AudioLevelSource::Display,
            AudioLevelSource::Mic,
            AudioLevelSource::System,
        ],
        WaveformSource::Mic => &[AudioLevelSource::Mic],
        WaveformSource::System => std::slice::from_ref(&system),
    };
    for kind in sources {
        let Some(levels) = store.get(clip, *kind) else {
            continue;
        };
        let file_time = source.source_time
            + match kind {
                AudioLevelSource::Display => {
                    segment_video_timing(meta, clip as usize).screen_offset
                }
                AudioLevelSource::Mic => f64::from(offsets.mic),
                AudioLevelSource::System => f64::from(offsets.system_audio),
            };
        levels.accumulate(file_time, segment.smoothing, &mut bands);
    }
    bands
}

pub struct WaveformLayer {
    pipeline: wgpu::RenderPipeline,
    draws: Vec<wgpu::BindGroup>,
    draw_tracks: Vec<u32>,
}

impl WaveformLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        let shader = device.create_shader_module(wgpu::include_wgsl!("../shaders/waveform.wgsl"));
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Waveform overlay pipeline"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        Self {
            pipeline,
            draws: Vec::new(),
            draw_tracks: Vec::new(),
        }
    }

    fn push_draw(&mut self, device: &wgpu::Device, uniforms: &WaveformUniforms, track: u32) {
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Waveform overlay uniforms"),
            contents: bytemuck::bytes_of(uniforms),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        self.draws
            .push(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Waveform overlay bind group"),
                layout: &self.pipeline.get_bind_group_layout(0),
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: buffer.as_entire_binding(),
                }],
            }));
        self.draw_tracks.push(track);
    }

    pub fn prepare(&mut self, constants: &RenderVideoConstants, uniforms: &ProjectUniforms) {
        self.draws.clear();
        self.draw_tracks.clear();
        let Some(timeline) = &uniforms.project.timeline else {
            return;
        };
        if uniforms.frame_rate == 0 || timeline.waveform_segments.is_empty() {
            return;
        }
        let time = f64::from(uniforms.frame_number) / f64::from(uniforms.frame_rate);
        let mut active: Vec<_> = timeline
            .waveform_segments
            .iter()
            .enumerate()
            .filter(|(_, segment)| segment.is_active_at(time))
            .collect();
        active.sort_unstable_by_key(|(index, segment)| (segment.track, *index));
        for (_, segment) in active {
            let bands = segment_levels(
                &constants.audio_levels,
                &constants.meta,
                &uniforms.project,
                time,
                segment,
            );
            let values = bar_values(
                &bands,
                segment.clamped_bar_count() as usize,
                segment.sensitivity,
            );
            if let Some(draw) = waveform_uniforms(segment, uniforms.output_size, &values) {
                self.push_draw(&constants.device, &draw, segment.track);
            }
        }
    }

    pub fn has_content(&self) -> bool {
        !self.draws.is_empty()
    }

    pub fn has_track(&self, track: u32) -> bool {
        self.draw_tracks.contains(&track)
    }

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if !self.has_content() {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        for group in &self.draws {
            pass.set_bind_group(0, group, &[]);
            pass.draw(0..6, 0..1);
        }
    }

    pub fn render_track(&self, pass: &mut wgpu::RenderPass<'_>, track: u32) {
        if !self.has_content() {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        for (group, draw_track) in self.draws.iter().zip(&self.draw_tracks) {
            if *draw_track == track {
                pass.set_bind_group(0, group, &[]);
                pass.draw(0..6, 0..1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::XY;

    fn segment(style: WaveformStyle) -> WaveformSegment {
        WaveformSegment {
            start: 0.0,
            end: 10.0,
            center: XY::new(0.5, 0.5),
            size: XY::new(1.0, 1.0),
            style,
            bar_count: 8,
            bar_width: 1.0,
            smoothing: 0.0,
            ..Default::default()
        }
    }

    #[test]
    fn bar_values_average_interpolate_and_apply_gain() {
        let mut bands = [0.0; AUDIO_LEVEL_BANDS];
        for (index, band) in bands.iter_mut().enumerate() {
            *band = index as f32 / (AUDIO_LEVEL_BANDS - 1) as f32;
        }
        let few = bar_values(&bands, 8, 1.0);
        assert_eq!(few.len(), 8);
        assert!(few.windows(2).all(|pair| pair[0] < pair[1]));
        assert!((few[0] - bands[..4].iter().sum::<f32>() / 4.0).abs() < 1.0e-6);

        let many = bar_values(&bands, 256, 1.0);
        assert_eq!(many.len(), 256);
        assert_eq!(many[0], 0.0);
        assert_eq!(many[255], 1.0);
        assert!(many.windows(2).all(|pair| pair[0] <= pair[1]));

        let loud = bar_values(&bands, 8, 4.0);
        assert!(loud.iter().all(|value| (0.0..=1.0).contains(value)));
        assert_eq!(loud[7], 1.0);
        assert!(
            bar_values(&bands, 8, f32::NAN)
                .iter()
                .zip(&few)
                .all(|(a, b)| a == b)
        );
    }

    #[test]
    fn uniforms_clamp_and_reject_invalid_geometry() {
        let mut waveform = segment(WaveformStyle::Bars);
        waveform.bar_count = 1_000;
        waveform.opacity = 3.0;
        waveform.secondary_color = Some("#000000".into());
        let values = vec![0.5; 300];
        let uniforms = waveform_uniforms(&waveform, (200, 100), &values).unwrap();
        assert_eq!(uniforms.rect, [100.0, 50.0, 100.0, 50.0]);
        assert_eq!(uniforms.canvas[2], 256.0);
        assert_eq!(uniforms.color[3], 1.0);
        assert_eq!(uniforms.secondary, [0.0, 0.0, 0.0, 1.0]);
        assert_eq!(uniforms.values[63][3], 0.5);

        waveform.bar_count = 1;
        waveform.secondary_color = Some("nope".into());
        let uniforms = waveform_uniforms(&waveform, (200, 100), &values).unwrap();
        assert_eq!(uniforms.canvas[2], 8.0);
        assert_eq!(uniforms.secondary[3], 0.0);
        assert_eq!(uniforms.values[2], [0.0; 4]);

        for mutate in [
            |w: &mut WaveformSegment| w.opacity = 0.0,
            |w: &mut WaveformSegment| w.opacity = f32::NAN,
            |w: &mut WaveformSegment| w.size.x = 0.0,
            |w: &mut WaveformSegment| w.center.x = f64::INFINITY,
            |w: &mut WaveformSegment| w.center.y = 3.0,
        ] {
            let mut invalid = segment(WaveformStyle::Bars);
            mutate(&mut invalid);
            assert!(waveform_uniforms(&invalid, (200, 100), &values).is_none());
        }
        assert!(waveform_uniforms(&segment(WaveformStyle::Bars), (0, 100), &values).is_none());
    }

    #[test]
    fn levels_follow_trims_offsets_and_sources() {
        let meta: StudioRecordingMeta = serde_json::from_value(serde_json::json!({
            "display": { "path": "display.mp4", "fps": 30 }
        }))
        .unwrap();
        let project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 2.0, "end": 4.0 }],
                "zoomSegments": []
            },
            "clips": [{ "index": 0, "offsets": { "mic": 0.5 } }]
        }))
        .unwrap();
        let loud_at = |frame: usize| {
            let mut bytes = vec![0; AUDIO_LEVEL_BANDS * 300];
            bytes[frame * AUDIO_LEVEL_BANDS] = 255;
            crate::AudioLevels::from_bytes(bytes).unwrap()
        };
        let store = AudioLevelStore::default();
        store.set(0, AudioLevelSource::Mic, loud_at(180));
        store.set(0, AudioLevelSource::Display, loud_at(120));
        let level = |time: f64, source: WaveformSource| {
            let waveform = WaveformSegment {
                source,
                smoothing: 0.0,
                ..Default::default()
            };
            segment_levels(&store, &meta, &project, time, &waveform)[0]
        };
        assert_eq!(level(0.5, WaveformSource::Mic), 1.0);
        assert_eq!(level(0.0, WaveformSource::Mic), 0.0);
        assert_eq!(level(0.0, WaveformSource::System), 1.0);
        assert_eq!(level(0.5, WaveformSource::System), 0.0);
        assert_eq!(level(0.0, WaveformSource::Mix), 1.0);
        assert_eq!(level(0.5, WaveformSource::Mix), 1.0);
        assert_eq!(level(3.0, WaveformSource::Mix), 0.0);

        store.set(0, AudioLevelSource::System, crate::AudioLevels::default());
        assert_eq!(level(0.0, WaveformSource::System), 0.0);
    }

    fn render(style: WaveformStyle, values: &[f32]) -> Option<Vec<u8>> {
        let instance = crate::create_wgpu_instance_sync();
        let Ok(adapter) = pollster::block_on(instance.request_adapter(&Default::default())) else {
            eprintln!("No GPU adapter available; skipping waveform pixel tests");
            return None;
        };
        let (device, queue) =
            pollster::block_on(adapter.request_device(&Default::default())).unwrap();
        let mut layer = WaveformLayer::new(&device);
        let uniforms = waveform_uniforms(&segment(style), (64, 64), values).unwrap();
        layer.push_draw(&device, &uniforms, 0);

        let output = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Waveform test output"),
            size: wgpu::Extent3d {
                width: 64,
                height: 64,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Waveform test readback"),
            size: 64 * 64 * 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let view = output.create_view(&Default::default());
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Waveform pixel test"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            layer.render_track(&mut pass, 0);
        }
        encoder.copy_texture_to_buffer(
            output.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: Some(64),
                },
            },
            output.size(),
        );
        queue.submit([encoder.finish()]);
        let (sender, receiver) = std::sync::mpsc::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                sender.send(result).expect("Waveform readback receiver");
            });
        device
            .poll(wgpu::PollType::Wait)
            .expect("Poll waveform GPU test");
        receiver.recv().unwrap().unwrap();
        let pixels = buffer.slice(..).get_mapped_range().to_vec();
        buffer.unmap();
        Some(pixels)
    }

    fn alpha(pixels: &[u8], x: usize, y: usize) -> u8 {
        pixels[(y * 64 + x) * 4 + 3]
    }

    #[test]
    fn waveform_styles_draw_expected_pixels() {
        let values = [1.0, 0.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0];
        let Some(bars) = render(WaveformStyle::Bars, &values) else {
            return;
        };
        assert_eq!(alpha(&bars, 4, 2), 255);
        assert_eq!(alpha(&bars, 20, 2), 0);
        assert_eq!(alpha(&bars, 20, 40), 255);
        assert_eq!(alpha(&bars, 12, 2), 0);
        assert_eq!(alpha(&bars, 12, 62), 255);

        let mirrored = render(WaveformStyle::Mirrored, &values).unwrap();
        assert_eq!(alpha(&mirrored, 4, 2), 255);
        assert_eq!(alpha(&mirrored, 4, 61), 255);
        assert_eq!(alpha(&mirrored, 20, 20), 255);
        assert_eq!(alpha(&mirrored, 20, 44), 255);
        assert_eq!(alpha(&mirrored, 20, 4), 0);
        assert_eq!(alpha(&mirrored, 12, 32), 255);
        assert_eq!(alpha(&mirrored, 12, 20), 0);

        let dots = render(WaveformStyle::Dots, &values).unwrap();
        assert_eq!(alpha(&dots, 4, 32), 255);
        assert_eq!(alpha(&dots, 4, 8), 255);
        assert_eq!(alpha(&dots, 12, 32), 255);
        assert_eq!(alpha(&dots, 12, 24), 0);

        let flat = render(WaveformStyle::Line, &[0.0; 8]).unwrap();
        assert_eq!(alpha(&flat, 30, 32), 255);
        assert_eq!(alpha(&flat, 30, 20), 0);
        let wave = render(WaveformStyle::Line, &[1.0; 8]).unwrap();
        assert_eq!(alpha(&wave, 4, 32), 0);
        assert!(alpha(&wave, 4, 4) > 0);
        assert!(alpha(&wave, 12, 59) > 0);
    }
}
