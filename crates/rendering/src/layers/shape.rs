use std::ops::Range;

use bytemuck::{Pod, Zeroable};
use cap_project::{ShapeArrowHead, ShapeKind, arrow_head_size};
use wgpu::util::DeviceExt;

use super::TextLayer;
use crate::shape::PreparedShape;
use crate::text::PreparedText;

const INSTANCE_ATTRIBUTES: [wgpu::VertexAttribute; 9] = wgpu::vertex_attr_array![
    0 => Float32x4,
    1 => Float32x4,
    2 => Float32x4,
    3 => Float32x4,
    4 => Float32x4,
    5 => Float32x4,
    6 => Float32x4,
    7 => Float32x4,
    8 => Float32x4,
];

const KIND_LINE: f32 = 0.0;
const KIND_RECT: f32 = 1.0;
const KIND_ELLIPSE: f32 = 2.0;

const HEAD_NONE: f32 = 0.0;
const HEAD_FILLED: f32 = 1.0;
const HEAD_OPEN: f32 = 2.0;

/// The share of the draw animation the shaft takes; the head grows over the
/// last part so it lands as the shaft arrives.
const SHAFT_SHARE: f32 = 0.85;
const HEAD_START: f32 = 0.7;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
pub(crate) struct ShapeInstance {
    quad: [f32; 4],
    geometry: [f32; 4],
    head: [f32; 4],
    tail: [f32; 4],
    dir: [f32; 4],
    stroke: [f32; 4],
    fill: [f32; 4],
    params: [f32; 4],
    opacity_shadow: [f32; 4],
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn lerp(a: [f32; 2], b: [f32; 2], t: f32) -> [f32; 2] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

pub(crate) fn shape_instance(shape: &PreparedShape) -> Option<ShapeInstance> {
    let width = shape.stroke_width.max(0.0);
    let unit = shape.unit.max(1.0e-3);
    let alpha = shape.alpha.clamp(0.0, 1.0);
    let draw = shape.draw.clamp(0.0, 1.0);
    if alpha <= 0.0 {
        return None;
    }
    let stroke = [
        shape.stroke_color[0],
        shape.stroke_color[1],
        shape.stroke_color[2],
        if width > 0.0 { 1.0 } else { 0.0 },
    ];
    let shadow_alpha = shape.shadow.clamp(0.0, 1.0) * 0.5;
    let shadow_offset = 2.0 * unit + 0.15 * width;
    let shadow_blur = 5.0 * unit + 0.25 * width;
    let opacity_shadow = [alpha, shadow_blur, shadow_alpha, shadow_offset];
    let shadow_pad = if shadow_alpha > 0.0 {
        shadow_offset + shadow_blur * 1.5
    } else {
        0.0
    };

    let instance = match shape.kind {
        ShapeKind::Arrow | ShapeKind::Line => {
            if width <= 0.0 || draw <= 0.001 {
                return None;
            }
            let delta = [shape.to[0] - shape.from[0], shape.to[1] - shape.from[1]];
            let length = delta[0].hypot(delta[1]);
            let dir = if length > 1.0e-4 {
                [delta[0] / length, delta[1] / length]
            } else {
                [1.0, 0.0]
            };
            let style = match (shape.kind, shape.arrow_head) {
                (ShapeKind::Line, _) => HEAD_NONE,
                (_, ShapeArrowHead::Open) => HEAD_OPEN,
                _ => HEAD_FILLED,
            };
            let double =
                shape.kind == ShapeKind::Arrow && shape.arrow_head == ShapeArrowHead::Double;
            let span = if double { length * 0.5 } else { length };
            let (head_length, head_width) = if style == HEAD_NONE {
                (0.0, 0.0)
            } else {
                let (head_length, head_width) =
                    arrow_head_size(f64::from(width / unit), f64::from(span / unit));
                (head_length as f32 * unit, head_width as f32 * unit)
            };
            let along = |distance: f32, from: [f32; 2]| {
                [from[0] + dir[0] * distance, from[1] + dir[1] * distance]
            };
            let tuck = if style == HEAD_FILLED {
                head_length * 0.7
            } else {
                0.0
            };
            let shaft_start = if double {
                along(tuck, shape.from)
            } else {
                shape.from
            };
            let shaft_end = along(-tuck, shape.to);
            let shaft_t = if style == HEAD_NONE {
                draw
            } else {
                (draw / SHAFT_SHARE).min(1.0)
            };
            let drawn_end = lerp(shaft_start, shaft_end, shaft_t);
            let head_t = if style == HEAD_NONE {
                0.0
            } else {
                smoothstep(HEAD_START, 1.0, draw)
            };
            let head = if head_t > 0.0 {
                let grown = head_length * head_t;
                let tip = if style == HEAD_FILLED {
                    along(grown - head_length, shape.to)
                } else {
                    shape.to
                };
                [tip[0], tip[1], grown, head_width * head_t]
            } else {
                [0.0; 4]
            };
            let tail = if double {
                let grown = head_length * smoothstep(0.0, 0.3, draw);
                let tip = along(head_length - grown, shape.from);
                [
                    tip[0],
                    tip[1],
                    grown,
                    head_width * smoothstep(0.0, 0.3, draw),
                ]
            } else {
                [0.0; 4]
            };
            let pad = width * 0.5 + head_length.max(head_width) + 2.0 + shadow_pad;
            ShapeInstance {
                quad: [
                    shape.from[0].min(shape.to[0]) - pad,
                    shape.from[1].min(shape.to[1]) - pad,
                    shape.from[0].max(shape.to[0]) + pad,
                    shape.from[1].max(shape.to[1]) + pad,
                ],
                geometry: [shaft_start[0], shaft_start[1], drawn_end[0], drawn_end[1]],
                head,
                tail,
                dir: [dir[0], dir[1], style, width * 0.3],
                stroke,
                fill: [0.0; 4],
                params: [KIND_LINE, width, 0.0, draw],
                opacity_shadow,
            }
        }
        ShapeKind::Rectangle | ShapeKind::Ellipse | ShapeKind::Highlight | ShapeKind::Badge => {
            let [left, top, right, bottom] = shape.rect();
            let half = [(right - left) * 0.5, (bottom - top) * 0.5];
            let center = [(left + right) * 0.5, (top + bottom) * 0.5];
            let fill = shape.fill.map_or([0.0; 4], |[r, g, b, a]| {
                let a = a * smoothstep(0.0, 1.0, draw);
                [r * a, g * a, b * a, a]
            });
            if fill[3] <= 0.0 && (stroke[3] <= 0.0 || draw <= 0.001) {
                return None;
            }
            if half[0] <= 0.0 && half[1] <= 0.0 && width <= 0.0 {
                return None;
            }
            let kind = match shape.kind {
                ShapeKind::Rectangle | ShapeKind::Highlight => KIND_RECT,
                _ => KIND_ELLIPSE,
            };
            let radius = shape
                .corner_radius
                .clamp(0.0, half[0].min(half[1]).max(0.0));
            let pad = width * 0.5 + 2.0 + shadow_pad;
            ShapeInstance {
                quad: [left - pad, top - pad, right + pad, bottom + pad],
                geometry: [center[0], center[1], half[0], half[1]],
                head: [0.0; 4],
                tail: [0.0; 4],
                dir: [0.0; 4],
                stroke,
                fill,
                params: [kind, width, radius, draw],
                opacity_shadow,
            }
        }
    };
    Some(instance)
}

pub(crate) fn badge_label(shape: &PreparedShape) -> Option<PreparedText> {
    if shape.kind != ShapeKind::Badge {
        return None;
    }
    let (center, radius) = shape.badge_circle();
    let alpha = shape.alpha.clamp(0.0, 1.0) * smoothstep(0.6, 1.0, shape.draw);
    if radius < 1.0 || alpha <= 0.0 {
        return None;
    }
    let content = shape.number.to_string();
    let digits = content.chars().count().max(1) as f32;
    let font_size = (radius * 2.0 * 0.55 * (2.0 / digits).min(1.0)).max(1.0);
    let top = center[1] - font_size * 0.5 + font_size * 0.09;
    Some(PreparedText {
        track: shape.track,
        content,
        bounds: [center[0] - radius, top, center[0] + radius, top + font_size],
        color: shape.badge_text_color(),
        background_color: None,
        font_family: "sans-serif".to_string(),
        font_size,
        font_weight: 700.0,
        italic: false,
        opacity: alpha,
        align: cap_project::TextAlign::Center,
        letter_spacing: 0.0,
        line_height: 1.0,
        shadow: 0.0,
        offset: [0.0, 0.0],
        scale: 1.0,
        stroke: None,
        glow: 0.0,
        gradient_color: None,
        background_style: Default::default(),
        wipe: 1.0,
        stagger_in: None,
        stagger_out: None,
    })
}

pub struct ShapeLayer {
    pipeline: wgpu::RenderPipeline,
    globals: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    instance_buffer: wgpu::Buffer,
    capacity: usize,
    instances: Vec<ShapeInstance>,
    tracks: Vec<(u32, Range<u32>)>,
    labels: Option<TextLayer>,
    label_texts: Vec<PreparedText>,
    output_size: [f32; 2],
}

impl ShapeLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        let shader = device.create_shader_module(wgpu::include_wgsl!("../shaders/shape.wgsl"));
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Shape overlay bind group layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Shape overlay pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Shape overlay pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<ShapeInstance>() as u64,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &INSTANCE_ATTRIBUTES,
                }],
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
        let globals = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Shape overlay globals"),
            contents: bytemuck::cast_slice(&[0.0f32; 4]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Shape overlay bind group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: globals.as_entire_binding(),
            }],
        });
        let capacity = 16;
        Self {
            pipeline,
            globals,
            bind_group,
            instance_buffer: Self::create_instance_buffer(device, capacity),
            capacity,
            instances: Vec::new(),
            tracks: Vec::new(),
            labels: None,
            label_texts: Vec::new(),
            output_size: [0.0; 2],
        }
    }

    fn create_instance_buffer(device: &wgpu::Device, capacity: usize) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Shape overlay instances"),
            size: (capacity * std::mem::size_of::<ShapeInstance>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        output_size: (u32, u32),
        shapes: &[PreparedShape],
    ) {
        self.instances.clear();
        self.tracks.clear();
        self.label_texts.clear();
        for shape in shapes {
            let Some(instance) = shape_instance(shape) else {
                continue;
            };
            let index = self.instances.len() as u32;
            match self.tracks.last_mut() {
                Some((track, range)) if *track == shape.track => range.end = index + 1,
                _ => self.tracks.push((shape.track, index..index + 1)),
            }
            self.instances.push(instance);
            self.label_texts.extend(badge_label(shape));
        }

        if !self.instances.is_empty() {
            if self.instances.len() > self.capacity {
                self.capacity = self.instances.len().next_power_of_two();
                self.instance_buffer = Self::create_instance_buffer(device, self.capacity);
            }
            queue.write_buffer(
                &self.instance_buffer,
                0,
                bytemuck::cast_slice(&self.instances),
            );
            let size = [output_size.0 as f32, output_size.1 as f32];
            if size != self.output_size {
                self.output_size = size;
                queue.write_buffer(
                    &self.globals,
                    0,
                    bytemuck::cast_slice(&[size[0], size[1], 0.0, 0.0]),
                );
            }
        }

        if !self.label_texts.is_empty() || self.labels.is_some() {
            let labels = self
                .labels
                .get_or_insert_with(|| TextLayer::new(device, queue));
            labels.prepare_mixed(device, queue, output_size, &self.label_texts);
        }
    }

    pub fn has_content(&self) -> bool {
        !self.instances.is_empty()
    }

    pub fn has_track(&self, track: u32) -> bool {
        self.tracks.iter().any(|(candidate, _)| *candidate == track)
    }

    fn draw(&self, pass: &mut wgpu::RenderPass<'_>, range: Range<u32>) {
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.set_vertex_buffer(0, self.instance_buffer.slice(..));
        pass.draw(0..6, range);
    }

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        for (track, range) in &self.tracks {
            self.draw(pass, range.clone());
            self.render_labels(pass, *track);
        }
    }

    pub fn render_track(&self, pass: &mut wgpu::RenderPass<'_>, track: u32) {
        for (candidate, range) in &self.tracks {
            if *candidate == track {
                self.draw(pass, range.clone());
                self.render_labels(pass, track);
            }
        }
    }

    fn render_labels(&self, pass: &mut wgpu::RenderPass<'_>, track: u32) {
        if let Some(labels) = &self.labels
            && self.label_texts.iter().any(|label| label.track == track)
        {
            labels.render_track(pass, track);
        }
    }

    #[cfg(test)]
    pub(crate) fn instance_capacity(&self) -> usize {
        self.capacity
    }

    #[cfg(test)]
    pub(crate) fn labels_created(&self) -> bool {
        self.labels.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared(kind: ShapeKind) -> PreparedShape {
        PreparedShape {
            track: 0,
            kind,
            from: [100.0, 100.0],
            to: [300.0, 200.0],
            stroke_width: 6.0,
            stroke_color: [1.0, 0.0, 0.0],
            fill: None,
            corner_radius: 500.0,
            arrow_head: ShapeArrowHead::Filled,
            shadow: 0.0,
            alpha: 1.0,
            draw: 1.0,
            unit: 1.0,
            number: 3,
        }
    }

    #[test]
    fn quads_cover_the_stroke_and_the_head() {
        let instance = shape_instance(&prepared(ShapeKind::Arrow)).unwrap();
        let (head_length, head_width) = arrow_head_size(6.0, 223.6);
        let reach = head_length.max(head_width) as f32;
        assert!(instance.quad[0] <= 100.0 - reach);
        assert!(instance.quad[2] >= 300.0 + reach);
        assert_eq!(instance.head[2], head_length as f32);
        assert_eq!(&instance.head[..2], &[300.0, 200.0]);
        assert_eq!(instance.tail, [0.0; 4]);

        let rect = shape_instance(&prepared(ShapeKind::Rectangle)).unwrap();
        assert!(rect.quad[0] <= 97.0 && rect.quad[3] >= 203.0);
        assert_eq!(
            rect.params[2], 50.0,
            "corner radius clamps to half the short side"
        );
    }

    #[test]
    fn shadows_widen_the_quad() {
        let plain = shape_instance(&prepared(ShapeKind::Ellipse)).unwrap();
        let mut shadowed = prepared(ShapeKind::Ellipse);
        shadowed.shadow = 1.0;
        let shadowed = shape_instance(&shadowed).unwrap();
        assert!(shadowed.quad[3] > plain.quad[3]);
        assert_eq!(shadowed.opacity_shadow[2], 0.5);
        assert_eq!(plain.opacity_shadow[2], 0.0);
    }

    #[test]
    fn arrow_heads_follow_the_style() {
        let mut shape = prepared(ShapeKind::Arrow);
        shape.arrow_head = ShapeArrowHead::Open;
        let open = shape_instance(&shape).unwrap();
        assert_eq!(open.dir[2], HEAD_OPEN);
        assert_eq!(
            &open.geometry[2..],
            &[300.0, 200.0],
            "open shafts reach the tip"
        );
        shape.arrow_head = ShapeArrowHead::Double;
        let double = shape_instance(&shape).unwrap();
        assert_eq!(double.dir[2], HEAD_FILLED);
        assert_eq!(&double.tail[..2], &[100.0, 100.0]);
        assert!(double.tail[2] > 0.0);
        let line = shape_instance(&prepared(ShapeKind::Line)).unwrap();
        assert_eq!(line.dir[2], HEAD_NONE);
        assert_eq!(line.head, [0.0; 4]);
        assert_eq!(&line.geometry, &[100.0, 100.0, 300.0, 200.0]);
    }

    #[test]
    fn draw_progress_grows_the_shaft_before_the_head() {
        let mut shape = prepared(ShapeKind::Arrow);
        shape.draw = 0.4;
        let early = shape_instance(&shape).unwrap();
        assert_eq!(early.head, [0.0; 4]);
        assert!(early.geometry[2] < 300.0);
        shape.draw = 0.95;
        let late = shape_instance(&shape).unwrap();
        assert!(late.head[2] > 0.0);
        shape.draw = 0.0;
        assert!(shape_instance(&shape).is_none());

        let mut rect = prepared(ShapeKind::Rectangle);
        rect.draw = 0.5;
        rect.fill = Some([0.0, 0.0, 1.0, 1.0]);
        let half = shape_instance(&rect).unwrap();
        assert_eq!(half.params[3], 0.5);
        assert!(half.fill[3] > 0.0 && half.fill[3] < 1.0);
    }

    #[test]
    fn zero_length_lines_draw_a_round_dot() {
        let mut shape = prepared(ShapeKind::Line);
        shape.to = shape.from;
        let dot = shape_instance(&shape).unwrap();
        assert_eq!(&dot.dir[..2], &[1.0, 0.0]);
        assert!(dot.quad[2] - dot.quad[0] >= 6.0);
    }

    #[test]
    fn invisible_shapes_produce_no_instance() {
        let mut shape = prepared(ShapeKind::Rectangle);
        shape.stroke_width = 0.0;
        assert!(shape_instance(&shape).is_none());
        shape.fill = Some([1.0, 1.0, 0.0, 0.4]);
        let fill = shape_instance(&shape).unwrap();
        assert_eq!(fill.stroke[3], 0.0);
        assert!((fill.fill[3] - 0.4).abs() < 1e-6);
        assert!((fill.fill[0] - 0.4).abs() < 1e-6, "fill is premultiplied");
        shape.alpha = 0.0;
        assert!(shape_instance(&shape).is_none());
        let mut line = prepared(ShapeKind::Line);
        line.stroke_width = 0.0;
        assert!(shape_instance(&line).is_none());
    }

    #[test]
    fn badges_label_their_number_centred() {
        let mut badge = prepared(ShapeKind::Badge);
        badge.from = [100.0, 100.0];
        badge.to = [180.0, 180.0];
        badge.fill = Some([0.94, 0.34, 0.34, 1.0]);
        let label = badge_label(&badge).unwrap();
        assert_eq!(label.content, "3");
        assert_eq!(label.track, 0);
        assert_eq!(label.bounds[0], 100.0);
        assert_eq!(label.bounds[2], 180.0);
        let middle = (label.bounds[1] + label.bounds[3]) * 0.5;
        assert!((middle - 140.0).abs() < label.font_size * 0.1);
        badge.number = 128;
        let wide = badge_label(&badge).unwrap();
        assert!(wide.font_size < label.font_size);
        badge.draw = 0.2;
        assert!(badge_label(&badge).is_none());
        assert!(badge_label(&prepared(ShapeKind::Rectangle)).is_none());
    }
}
