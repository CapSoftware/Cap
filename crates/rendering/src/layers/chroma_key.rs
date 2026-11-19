use bytemuck::{Pod, Zeroable};
use cap_project::ChromaKey;
use wgpu::util::DeviceExt;

const OUTPUT_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// Keys a camera frame into a texture the size of the frame. The camera layer
/// composites that texture, and the background blur reads it, in place of
/// the frame itself.
pub struct ChromaKeyPass {
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    uniforms_buffer: wgpu::Buffer,
    /// The camera layer double-buffers its frames, so two sources at most.
    source_bind_groups: Vec<(wgpu::TextureView, wgpu::BindGroup)>,
    output: wgpu::Texture,
    output_view: wgpu::TextureView,
}

impl ChromaKeyPass {
    pub fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Chroma Key Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Chroma Key Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/chroma-key.wgsl").into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Chroma Key Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Chroma Key Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: OUTPUT_FORMAT,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        let uniforms_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Chroma Key Uniforms"),
            contents: bytemuck::cast_slice(&[ChromaKeyUniforms::new(&ChromaKey::default())]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let output = create_output(device, 1, 1);
        let output_view = output.create_view(&Default::default());

        Self {
            pipeline,
            bind_group_layout,
            uniforms_buffer,
            source_bind_groups: Vec::with_capacity(2),
            output,
            output_view,
        }
    }

    pub fn output_texture(&self) -> &wgpu::Texture {
        &self.output
    }

    pub fn output_view(&self) -> &wgpu::TextureView {
        &self.output_view
    }

    /// Records the key into `encoder`. Returns whether the output texture was
    /// replaced, which invalidates anything bound to the previous one.
    pub fn render(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::Texture,
        source_view: &wgpu::TextureView,
        key: &ChromaKey,
    ) -> bool {
        let resized = self.output.size() != source.size();
        if resized {
            self.output = create_output(device, source.width(), source.height());
            self.output_view = self.output.create_view(&Default::default());
        }

        queue.write_buffer(
            &self.uniforms_buffer,
            0,
            bytemuck::cast_slice(&[ChromaKeyUniforms::new(key)]),
        );

        let bind_group = self.source_bind_group(device, source_view);
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Chroma Key Pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.output_view,
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
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.draw(0..3, 0..1);

        resized
    }

    fn source_bind_group(
        &mut self,
        device: &wgpu::Device,
        view: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        if let Some((_, bind_group)) = self
            .source_bind_groups
            .iter()
            .find(|(cached, _)| cached == view)
        {
            return bind_group.clone();
        }
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Chroma Key Bind Group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.uniforms_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(view),
                },
            ],
        });
        if self.source_bind_groups.len() == 2 {
            self.source_bind_groups.remove(0);
        }
        self.source_bind_groups
            .push((view.clone(), bind_group.clone()));
        bind_group
    }
}

fn create_output(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Chroma Key Output"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: OUTPUT_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    })
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
struct ChromaKeyUniforms {
    key_color: [f32; 4],
    levels: [f32; 4],
}

impl ChromaKeyUniforms {
    fn new(key: &ChromaKey) -> Self {
        let [r, g, b] = key.color.map(|channel| f32::from(channel) / 255.0);
        Self {
            key_color: [r, g, b, 1.0],
            levels: [key.tolerance, key.softness, key.spill, 0.0],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CAMERA_PADDING, CursorEvents, DecodedFrame, DecodedSegmentFrames, FrameRenderer,
        ProjectConfiguration, ProjectUniforms, RecordingMeta, RenderOptions, RenderVideoConstants,
        RendererLayers, ZoomTransformTimeline,
    };
    use cap_project::{BackgroundBlurMode, CameraShape, XY};
    use std::sync::Arc;

    const WIDTH: u32 = 320;
    const HEIGHT: u32 = 180;
    const BEHIND: [u8; 3] = [255, 0, 255];
    const SKIN: [u8; 3] = [224, 172, 138];
    const HAIR: [u8; 3] = [40, 30, 25];
    const SHIRT: [u8; 3] = [235, 235, 235];

    async fn constants(size: XY<u32>) -> RenderVideoConstants {
        let metadata: RecordingMeta = serde_json::from_value(serde_json::json!({
            "pretty_name": "chroma key",
            "display": { "path": "unused.mp4", "fps": 60 },
            "camera": { "path": "unused-camera.mp4", "fps": 60 },
            "audio": null, "cursor": null
        }))
        .unwrap();
        let studio = metadata.studio_meta().unwrap().clone();
        RenderVideoConstants::new_with_options(
            RenderOptions {
                screen_size: size,
                camera_size: Some(size),
                preserve_screen_alpha: false,
            },
            metadata,
            studio,
        )
        .await
        .expect("graphics device")
    }

    fn image(size: XY<u32>, color_at: impl Fn(u32, u32) -> [u8; 3]) -> DecodedFrame {
        let mut data = Vec::with_capacity((size.x * size.y * 4) as usize);
        for y in 0..size.y {
            for x in 0..size.x {
                data.extend(color_at(x, y));
                data.push(255);
            }
        }
        DecodedFrame::new(data, size.x, size.y)
    }

    fn lit(color: [u16; 3], light: f32) -> [u8; 3] {
        color.map(|channel| (f32::from(channel) * light).round().min(255.0) as u8)
    }

    fn mix(a: [u8; 3], b: [u8; 3], t: f32) -> [u8; 3] {
        std::array::from_fn(|i| (f32::from(a[i]) * (1.0 - t) + f32::from(b[i]) * t).round() as u8)
    }

    /// A presenter in front of `screen`, lit unevenly from 70% on the left to
    /// 115% on the right: hair, a face and a shirt, with a band of spill where
    /// the screen bounces onto the edge of the subject.
    fn presenter(screen: [u16; 3]) -> DecodedFrame {
        image(XY::new(WIDTH, HEIGHT), |x, y| {
            let backdrop = lit(screen, 0.7 + 0.45 * x as f32 / WIDTH as f32);
            if !(110..210).contains(&x) || y < 30 {
                return backdrop;
            }
            let subject = match y {
                ..60 => HAIR,
                60..120 => SKIN,
                _ => SHIRT,
            };
            if !(118..202).contains(&x) || y < 38 {
                mix(subject, backdrop, 0.3)
            } else {
                subject
            }
        })
    }

    /// Stretches the camera overlay over the whole output, so camera texels
    /// land on output pixels nearly one to one.
    fn full_frame(key: Option<ChromaKey>) -> ProjectConfiguration {
        let mut project = ProjectConfiguration::default();
        project.camera.chroma_key = key;
        project.camera.shape = CameraShape::Source;
        project.camera.manual_position = Some(XY::new(0.5, 0.5));
        let padding = CAMERA_PADDING * HEIGHT as f32 / 1080.0;
        project.camera.size = (HEIGHT as f32 - padding) / HEIGHT as f32 * 100.0;
        project
    }

    fn key(color: [u16; 3], spill: f32) -> ChromaKey {
        ChromaKey {
            color,
            spill,
            ..ChromaKey::default()
        }
    }

    async fn render(
        constants: &RenderVideoConstants,
        layers: &mut RendererLayers,
        project: &ProjectConfiguration,
        camera: DecodedFrame,
        behind: [u8; 3],
        ordinary_prepare: bool,
    ) -> Vec<u8> {
        let size = constants.options.screen_size;
        let frames = DecodedSegmentFrames {
            screen_size: size,
            screen_frame: Some(DecodedFrame::new(
                [behind[0], behind[1], behind[2], 255].repeat((size.x * size.y) as usize),
                size.x,
                size.y,
            )),
            camera_frame: Some(camera),
            segment_time: 3.0,
            recording_time: 3.0,
            segment_has_camera: true,
        };
        let cursor = CursorEvents::default();
        let zoom = ZoomTransformTimeline::from_project(project, &cursor, 6.0, size);
        let uniforms = ProjectUniforms::new(
            constants,
            &Arc::new(project.clone()),
            180,
            60,
            size,
            &cursor,
            &frames,
            6.0,
            &zoom,
        );
        if ordinary_prepare {
            layers
                .prepare(constants, &uniforms, &frames, &cursor, true)
                .await
                .unwrap();
        }
        let output = FrameRenderer::new(constants)
            .render_immediate(frames, uniforms, &cursor, true, layers)
            .await
            .unwrap();
        output
            .data
            .chunks_exact(output.padded_bytes_per_row as usize)
            .flat_map(|row| row[..output.width as usize * 4].iter().copied())
            .collect()
    }

    fn pixel(frame: &[u8], x: u32, y: u32) -> [u8; 3] {
        let index = ((y * WIDTH + x) * 4) as usize;
        [frame[index], frame[index + 1], frame[index + 2]]
    }

    fn assert_near(actual: [u8; 3], expected: [u8; 3], tolerance: u8, what: &str) {
        assert!(
            actual
                .iter()
                .zip(expected)
                .all(|(&a, e)| a.abs_diff(e) <= tolerance),
            "{what}: {actual:?} is not within {tolerance} of {expected:?}"
        );
    }

    fn greenness(color: [u8; 3]) -> i32 {
        i32::from(color[1]) - (i32::from(color[0]) + i32::from(color[2])) / 2
    }

    fn luma(color: [u8; 3]) -> f32 {
        0.2126 * f32::from(color[0]) + 0.7152 * f32::from(color[1]) + 0.0722 * f32::from(color[2])
    }

    const SCREEN_POINTS: [(u32, u32); 5] = [(20, 90), (300, 90), (160, 12), (60, 170), (260, 170)];

    #[tokio::test]
    async fn green_and_blue_screens_key_out_and_leave_the_presenter() {
        let constants = constants(XY::new(WIDTH, HEIGHT)).await;
        for screen in [ChromaKey::GREEN, ChromaKey::BLUE] {
            for ordinary_prepare in [false, true] {
                let mut layers = RendererLayers::new(&constants.device, &constants.queue);
                let project = full_frame(Some(key(screen, 0.5)));
                let frame = render(
                    &constants,
                    &mut layers,
                    &project,
                    presenter(screen),
                    BEHIND,
                    ordinary_prepare,
                )
                .await;
                for (x, y) in SCREEN_POINTS {
                    assert_near(pixel(&frame, x, y), BEHIND, 1, "screen");
                }
                assert_near(pixel(&frame, 160, 48), HAIR, 2, "hair");
                assert_near(pixel(&frame, 160, 90), SKIN, 2, "skin");
                assert_near(pixel(&frame, 160, 150), SHIRT, 2, "shirt");
            }
        }
    }

    #[tokio::test]
    async fn the_key_colour_decides_what_is_removed() {
        let constants = constants(XY::new(WIDTH, HEIGHT)).await;
        let mut layers = RendererLayers::new(&constants.device, &constants.queue);
        let frame = render(
            &constants,
            &mut layers,
            &full_frame(Some(key(ChromaKey::GREEN, 0.0))),
            presenter(ChromaKey::BLUE),
            BEHIND,
            false,
        )
        .await;
        assert_near(
            pixel(&frame, 300, 90),
            lit(ChromaKey::BLUE, 0.7 + 0.45 * 300.0 / WIDTH as f32),
            2,
            "a blue screen under a green key",
        );
        assert_near(pixel(&frame, 160, 90), SKIN, 2, "skin");
    }

    #[tokio::test]
    async fn softness_ramp_rises_monotonically_from_tolerance() {
        let constants = constants(XY::new(WIDTH, HEIGHT)).await;
        let screen_to_grey = |x: u32| x as f32 / (WIDTH - 1) as f32;
        let camera = || {
            image(XY::new(WIDTH, HEIGHT), |x, _| {
                mix(lit(ChromaKey::GREEN, 1.0), [128; 3], screen_to_grey(x))
            })
        };
        let mut over = Vec::new();
        for behind in [[0; 3], [255; 3]] {
            let mut layers = RendererLayers::new(&constants.device, &constants.queue);
            let project = full_frame(Some(key(ChromaKey::GREEN, 0.5)));
            over.push(render(&constants, &mut layers, &project, camera(), behind, false).await);
        }
        // Over black a pixel is alpha * colour, over white it gains
        // (1 - alpha) * 255, so their difference recovers alpha.
        // The outermost columns sit on the display card's anti-aliased edge.
        let columns = 2..WIDTH - 2;
        let alpha: Vec<f32> = columns
            .clone()
            .map(|x| {
                let (black, white) = (pixel(&over[0], x, 90), pixel(&over[1], x, 90));
                let gap: f32 = (0..3)
                    .map(|i| f32::from(white[i]) - f32::from(black[i]))
                    .sum::<f32>()
                    / 3.0;
                1.0 - gap / 255.0
            })
            .collect();
        let tolerance = ChromaKey::DEFAULT_TOLERANCE;
        let softness = ChromaKey::DEFAULT_SOFTNESS;
        for (x, alpha) in columns.clone().zip(&alpha) {
            let distance = screen_to_grey(x);
            if distance < tolerance - 0.02 {
                assert!(*alpha < 0.01, "x {x}: alpha {alpha} below the tolerance");
            } else if distance > tolerance + softness + 0.02 {
                assert!(*alpha > 0.99, "x {x}: alpha {alpha} above the ramp");
            }
        }
        for (x, pair) in columns.zip(alpha.windows(2)) {
            assert!(
                pair[1] >= pair[0] - 1.5 / 255.0,
                "alpha falls from {} to {} at x {x}",
                pair[0],
                pair[1]
            );
        }
        assert!(
            alpha.iter().filter(|a| (0.1..0.9).contains(*a)).count() >= 8,
            "the ramp should be soft, not a step: {alpha:?}"
        );
    }

    #[tokio::test]
    async fn spill_removal_takes_the_screen_hue_out_of_the_subject() {
        let constants = constants(XY::new(WIDTH, HEIGHT)).await;
        let mut frames = Vec::new();
        for spill in [0.0, 1.0] {
            let mut layers = RendererLayers::new(&constants.device, &constants.queue);
            let project = full_frame(Some(key(ChromaKey::GREEN, spill)));
            frames.push(
                render(
                    &constants,
                    &mut layers,
                    &project,
                    presenter(ChromaKey::GREEN),
                    BEHIND,
                    false,
                )
                .await,
            );
        }
        let source = presenter(ChromaKey::GREEN);
        let source_pixel = |x: u32, y: u32| pixel(source.data(), x, y);
        for (x, y, what) in [
            (114, 90, "skin edge"),
            (114, 150, "shirt edge"),
            (160, 34, "hair edge"),
        ] {
            let kept = pixel(&frames[0], x, y);
            let cleaned = pixel(&frames[1], x, y);
            assert_near(kept, source_pixel(x, y), 3, what);
            assert!(
                greenness(cleaned) < greenness(kept) - 10,
                "{what}: {cleaned:?} should be less green than {kept:?}"
            );
            assert!(
                (luma(cleaned) - luma(kept)).abs() <= 3.0,
                "{what}: spill removal changed brightness from {kept:?} to {cleaned:?}"
            );
        }
        for (x, y, expected) in [(160, 48, HAIR), (160, 90, SKIN), (160, 150, SHIRT)] {
            assert_near(pixel(&frames[1], x, y), expected, 2, "subject");
        }
    }

    #[tokio::test]
    async fn a_keyed_bubble_is_a_cutout_without_shadow_or_frame() {
        let constants = constants(XY::new(WIDTH, HEIGHT)).await;
        let mut renders = Vec::new();
        for (hide, chroma_key) in [
            (true, None),
            (false, None),
            (false, Some(ChromaKey::default())),
        ] {
            let mut layers = RendererLayers::new(&constants.device, &constants.queue);
            let mut project = ProjectConfiguration::default();
            project.camera.hide = hide;
            project.camera.size = 60.0;
            project.camera.chroma_key = chroma_key;
            renders.push(
                render(
                    &constants,
                    &mut layers,
                    &project,
                    presenter(ChromaKey::GREEN),
                    BEHIND,
                    false,
                )
                .await,
            );
        }
        let [hidden, framed, keyed] = renders.as_slice() else {
            unreachable!()
        };
        let changed = |frame: &[u8]| {
            (0..HEIGHT)
                .flat_map(|y| (0..WIDTH).map(move |x| (x, y)))
                .filter(|&(x, y)| {
                    pixel(frame, x, y)
                        .iter()
                        .zip(pixel(hidden, x, y))
                        .any(|(&a, b)| a.abs_diff(b) > 2)
                })
                .collect::<Vec<_>>()
        };
        let framed = changed(framed);
        let keyed_pixels = changed(keyed);
        assert!(
            keyed_pixels.len() * 2 < framed.len(),
            "only the presenter should be left: {} of {} pixels",
            keyed_pixels.len(),
            framed.len()
        );
        let green = keyed_pixels
            .iter()
            .filter(|&&(x, y)| greenness(pixel(keyed, x, y)) > 30)
            .count();
        assert_eq!(green, 0, "no screen colour may reach the output");
        let skin = keyed_pixels
            .iter()
            .filter(|&&(x, y)| {
                pixel(keyed, x, y)
                    .iter()
                    .zip(SKIN)
                    .all(|(&a, b)| a.abs_diff(b) <= 3)
            })
            .count();
        assert!(
            skin > 100,
            "the presenter's face must still be drawn: {skin}"
        );
    }

    #[tokio::test]
    async fn camera_only_scenes_show_the_whole_camera() {
        let constants = constants(XY::new(WIDTH, HEIGHT)).await;
        let mut layers = RendererLayers::new(&constants.device, &constants.queue);
        let mut project = ProjectConfiguration::default();
        project.camera.chroma_key = Some(ChromaKey::default());
        project.timeline = Some(
            serde_json::from_value(serde_json::json!({
                "segments": [], "zoomSegments": [],
                "sceneSegments": [{
                    "start": 2.0, "end": 5.0, "mode": "cameraOnly",
                    "transitionIn": 0.0, "transitionOut": 0.0
                }]
            }))
            .unwrap(),
        );
        let frame = render(
            &constants,
            &mut layers,
            &project,
            presenter(ChromaKey::GREEN),
            BEHIND,
            false,
        )
        .await;
        assert_near(
            pixel(&frame, 300, 90),
            lit(ChromaKey::GREEN, 0.7 + 0.45 * 300.0 / WIDTH as f32),
            3,
            "the screen in a camera-only scene",
        );
    }

    /// Blur reads the keyed frame and keeps its alpha. Where the blur cannot
    /// start (no segmentation runtime), the key alone must still apply.
    #[tokio::test]
    async fn the_key_holds_with_background_blur_on() {
        let constants = constants(XY::new(WIDTH, HEIGHT)).await;
        let mut layers = RendererLayers::new(&constants.device, &constants.queue);
        let mut project = full_frame(Some(ChromaKey::default()));
        project.camera.background_blur.mode = BackgroundBlurMode::Heavy;
        let frame = render(
            &constants,
            &mut layers,
            &project,
            presenter(ChromaKey::GREEN),
            BEHIND,
            false,
        )
        .await;
        for (x, y) in SCREEN_POINTS {
            assert_near(pixel(&frame, x, y), BEHIND, 1, "screen");
        }
        let presenter: u32 = pixel(&frame, 160, 90)
            .iter()
            .zip(BEHIND)
            .map(|(&a, b)| u32::from(a.abs_diff(b)))
            .sum();
        assert!(presenter > 200, "the presenter must stay opaque");
    }

    #[tokio::test]
    async fn turning_the_key_off_renders_exactly_as_without_one() {
        let constants = constants(XY::new(WIDTH, HEIGHT)).await;
        let off = ChromaKey {
            enabled: false,
            ..ChromaKey::default()
        };
        for size in [30.0, 60.0] {
            for ordinary_prepare in [false, true] {
                let mut reference = RendererLayers::new(&constants.device, &constants.queue);
                let mut toggled = RendererLayers::new(&constants.device, &constants.queue);
                let project = |key| {
                    let mut project = ProjectConfiguration::default();
                    project.camera.size = size;
                    project.camera.chroma_key = key;
                    project
                };
                let (none, disabled, enabled) = (
                    project(None),
                    project(Some(off)),
                    project(Some(ChromaKey::default())),
                );
                let frame = || presenter(ChromaKey::GREEN);
                let expected = render(
                    &constants,
                    &mut reference,
                    &none,
                    frame(),
                    BEHIND,
                    ordinary_prepare,
                )
                .await;

                let first = render(
                    &constants,
                    &mut toggled,
                    &disabled,
                    frame(),
                    BEHIND,
                    ordinary_prepare,
                )
                .await;
                assert!(!toggled.camera.has_chroma_key_pass());
                assert_eq!(first, expected);

                let keyed = render(
                    &constants,
                    &mut toggled,
                    &enabled,
                    frame(),
                    BEHIND,
                    ordinary_prepare,
                )
                .await;
                assert_ne!(keyed, expected);
                for project in [&disabled, &none] {
                    let after = render(
                        &constants,
                        &mut toggled,
                        project,
                        frame(),
                        BEHIND,
                        ordinary_prepare,
                    )
                    .await;
                    assert_eq!(after, expected, "size {size}, ordinary={ordinary_prepare}");
                }
            }
        }
    }
    #[tokio::test]
    #[ignore = "benchmark: cargo test -p cap-rendering --lib chroma_key_cost -- --ignored --nocapture"]
    async fn chroma_key_cost() {
        let size = XY::new(1920, 1080);
        let constants = constants(size).await;
        let frames = DecodedSegmentFrames {
            screen_size: size,
            screen_frame: Some(image(size, |_, _| BEHIND)),
            camera_frame: Some(image(size, |x, _| {
                if x < size.x / 2 {
                    lit(ChromaKey::GREEN, 1.0)
                } else {
                    SKIN
                }
            })),
            segment_time: 3.0,
            recording_time: 3.0,
            segment_has_camera: true,
        };
        let cursor = CursorEvents::default();
        let median = |mut times: Vec<f64>| {
            times.sort_by(f64::total_cmp);
            times[times.len() / 2]
        };

        let mut renderer = FrameRenderer::new(&constants);
        let mut runs = Vec::new();
        for key in [None, Some(ChromaKey::default())] {
            let mut project = ProjectConfiguration::default();
            project.camera.chroma_key = key;
            let zoom = ZoomTransformTimeline::from_project(&project, &cursor, 6.0, size);
            let uniforms = ProjectUniforms::new(
                &constants,
                &Arc::new(project),
                180,
                60,
                size,
                &cursor,
                &frames,
                6.0,
                &zoom,
            );
            runs.push((
                RendererLayers::new(&constants.device, &constants.queue),
                uniforms,
                Vec::new(),
            ));
        }
        for iteration in 0..35 {
            for (layers, uniforms, times) in &mut runs {
                let start = std::time::Instant::now();
                renderer
                    .render_immediate(frames.clone(), uniforms.clone(), &cursor, true, layers)
                    .await
                    .unwrap();
                if iteration >= 5 {
                    times.push(start.elapsed().as_secs_f64() * 1000.0);
                }
            }
        }
        let off = median(std::mem::take(&mut runs[0].2));
        let on = median(std::mem::take(&mut runs[1].2));

        let source = constants.device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d {
                width: size.x,
                height: size.y,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: OUTPUT_FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let source_view = source.create_view(&Default::default());
        let mut pass = ChromaKeyPass::new(&constants.device);
        let mut times = Vec::new();
        for iteration in 0..35 {
            let start = std::time::Instant::now();
            let mut encoder = constants.device.create_command_encoder(&Default::default());
            pass.render(
                &constants.device,
                &constants.queue,
                &mut encoder,
                &source,
                &source_view,
                &ChromaKey::default(),
            );
            constants.queue.submit([encoder.finish()]);
            constants.device.poll(wgpu::PollType::Wait).unwrap();
            if iteration >= 5 {
                times.push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
        println!(
            "1080p camera, 1080p output, median of 30 on {}: frame {off:.2} ms without the key, {on:.2} ms with it; the key pass alone {:.2} ms",
            constants.adapter_name,
            median(times)
        );
    }
}
