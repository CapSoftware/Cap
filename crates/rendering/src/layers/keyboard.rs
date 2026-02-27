use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use cap_project::CursorEvents;
use glyphon::{
    Attrs, Buffer, Cache, Color, Family, Metrics, Resolution, Shaping, SwashCache, TextArea,
    TextAtlas, TextBounds, TextRenderer, Viewport,
};
use wgpu::{
    BindGroup, BindGroupLayout, Device, Queue, RenderPipeline, include_wgsl, util::DeviceExt,
};

use crate::DecodedSegmentFrames;

const RECENT_SHORTCUT_WINDOW_MS: f64 = 850.0;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct KeyboardOverlayUniforms {
    output_size: [f32; 2],
    _padding0: [f32; 2],
    rect: [f32; 4],
    fill_color: [f32; 4],
    border_color: [f32; 4],
    shadow_color: [f32; 4],
    radius_feather: [f32; 2],
    _padding1: [f32; 2],
}

impl Default for KeyboardOverlayUniforms {
    fn default() -> Self {
        Self {
            output_size: [1.0, 1.0],
            _padding0: [0.0, 0.0],
            rect: [0.0, 0.0, 1.0, 1.0],
            fill_color: [0.0, 0.0, 0.0, 0.0],
            border_color: [0.0, 0.0, 0.0, 0.0],
            shadow_color: [0.0, 0.0, 0.0, 0.0],
            radius_feather: [0.0, 1.0],
            _padding1: [0.0, 0.0],
        }
    }
}

struct OverlayStatics {
    bind_group_layout: BindGroupLayout,
    render_pipeline: RenderPipeline,
}

struct OverlayInstance {
    uniform_buffer: wgpu::Buffer,
    bind_group: BindGroup,
}

impl OverlayStatics {
    fn new(device: &Device) -> Self {
        let bind_group_layout: BindGroupLayout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Keyboard Overlay Bind Group Layout"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });

        let shader = device.create_shader_module(include_wgsl!("../shaders/keyboard-overlay.wgsl"));

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Keyboard Overlay Pipeline"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("Keyboard Overlay Pipeline Layout"),
                    bind_group_layouts: &[&bind_group_layout],
                    push_constant_ranges: &[],
                }),
            ),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &[],
                    zero_initialize_workgroup_memory: false,
                },
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &[],
                    zero_initialize_workgroup_memory: false,
                },
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Self {
            bind_group_layout,
            render_pipeline,
        }
    }

    fn create_instance(&self, device: &Device) -> OverlayInstance {
        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Keyboard Overlay Uniform Buffer"),
            contents: bytemuck::cast_slice(&[KeyboardOverlayUniforms::default()]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Keyboard Overlay Bind Group"),
            layout: &self.bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
        });

        OverlayInstance {
            uniform_buffer,
            bind_group,
        }
    }
}

#[derive(Clone)]
struct ShortcutState {
    label: String,
    down_time: f64,
}

struct ShortcutPresentation {
    label: String,
    opacity: f32,
}

pub struct KeyboardLayer {
    overlay: OverlayStatics,
    overlays: Vec<OverlayInstance>,
    font_system: glyphon::FontSystem,
    swash_cache: SwashCache,
    text_atlas: TextAtlas,
    text_renderer: TextRenderer,
    viewport: Viewport,
    visible: bool,
    current_label: Option<String>,
    current_font_size: f32,
}

impl KeyboardLayer {
    pub fn new(device: &Device, queue: &Queue) -> Self {
        let overlay = OverlayStatics::new(device);
        let font_system = glyphon::FontSystem::new();
        let swash_cache = SwashCache::new();
        let cache = Cache::new(device);
        let viewport = Viewport::new(device, &cache);
        let mut text_atlas =
            TextAtlas::new(device, queue, &cache, wgpu::TextureFormat::Rgba8UnormSrgb);
        let text_renderer = TextRenderer::new(
            &mut text_atlas,
            device,
            wgpu::MultisampleState::default(),
            None,
        );

        Self {
            overlay,
            overlays: Vec::new(),
            font_system,
            swash_cache,
            text_atlas,
            text_renderer,
            viewport,
            visible: false,
            current_label: None,
            current_font_size: 0.0,
        }
    }

    pub fn prepare(
        &mut self,
        device: &Device,
        queue: &Queue,
        cursor: &CursorEvents,
        segment_frames: &DecodedSegmentFrames,
        output_size: (u32, u32),
    ) {
        let time_ms = segment_frames.recording_time as f64 * 1000.0;
        let presentation = active_shortcut_label(cursor, time_ms);

        self.visible = presentation.is_some();
        if !self.visible {
            self.current_label = None;
            self.overlays.clear();
            return;
        }

        let Some(presentation) = presentation else {
            return;
        };

        let text = presentation.label;
        let key_parts = text.split(" + ").collect::<Vec<_>>();
        if key_parts.is_empty() {
            self.visible = false;
            self.overlays.clear();
            return;
        }

        let opacity = presentation.opacity.clamp(0.0, 1.0);

        let (width, height) = output_size;
        let font_size = (height as f32 * 0.0225).clamp(15.0, 28.0);
        self.current_label = Some(text.clone());
        self.current_font_size = font_size;

        self.viewport.update(queue, Resolution { width, height });

        let horizontal_padding = font_size * 0.68;
        let vertical_padding = font_size * 0.42;
        let pill_height = font_size + vertical_padding * 2.0;
        let plus_width = estimate_text_width("+", font_size);
        let plus_gap = font_size * 0.42;

        let key_widths = key_parts
            .iter()
            .map(|part| {
                (estimate_text_width(part, font_size) + horizontal_padding * 2.0)
                    .clamp(font_size * 1.8, width as f32 * 0.34)
            })
            .collect::<Vec<_>>();

        let separators_width = if key_parts.len() > 1 {
            (key_parts.len() as f32 - 1.0) * (plus_gap * 2.0 + plus_width)
        } else {
            0.0
        };

        let total_width = key_widths.iter().sum::<f32>() + separators_width;

        let x = ((width as f32 - total_width) * 0.5).max(12.0);
        let y = (height as f32 * 0.87)
            .min(height as f32 - pill_height - 12.0)
            .max(12.0);

        while self.overlays.len() < key_parts.len() {
            self.overlays.push(self.overlay.create_instance(device));
        }
        self.overlays.truncate(key_parts.len());

        let alpha = (opacity * 255.0).clamp(0.0, 255.0) as u8;
        let outline_alpha = (opacity * 140.0).clamp(0.0, 255.0) as u8;
        let outline_color = Color::rgba(20, 20, 20, outline_alpha);
        let main_color = Color::rgba(255, 255, 255, alpha);
        let plus_color = Color::rgba(220, 220, 220, (opacity * 220.0).clamp(0.0, 255.0) as u8);

        let mut key_buffers = Vec::<Buffer>::with_capacity(key_parts.len());
        let mut key_positions = Vec::<(f32, f32, f32, f32)>::with_capacity(key_parts.len());

        let mut plus_buffers = Vec::<Buffer>::new();
        let mut plus_positions = Vec::<(f32, f32)>::new();

        let metrics = Metrics::new(font_size, font_size * 1.25);
        let mut cursor_x = x;

        for (index, part) in key_parts.iter().enumerate() {
            if index > 0 {
                let mut plus_buffer = Buffer::new(&mut self.font_system, metrics);
                plus_buffer.set_size(
                    &mut self.font_system,
                    Some((plus_width * 1.5).max(font_size)),
                    None,
                );
                plus_buffer.set_text(
                    &mut self.font_system,
                    "+",
                    &Attrs::new().family(Family::SansSerif).color(plus_color),
                    Shaping::Advanced,
                );
                plus_buffer.shape_until_scroll(&mut self.font_system, false);

                let plus_x = cursor_x + plus_gap;
                let plus_y = y + vertical_padding - 0.5;
                plus_positions.push((plus_x, plus_y));
                plus_buffers.push(plus_buffer);

                cursor_x += plus_gap * 2.0 + plus_width;
            }

            let key_width = key_widths[index];
            let text_left = cursor_x + horizontal_padding;
            let text_top = y + vertical_padding - 0.8;
            let inner_width = (key_width - horizontal_padding * 2.0).max(font_size);
            let text_right = text_left + inner_width;

            let overlay_uniforms = KeyboardOverlayUniforms {
                output_size: [width as f32, height as f32],
                _padding0: [0.0, 0.0],
                rect: [cursor_x, y, cursor_x + key_width, y + pill_height],
                fill_color: [0.09, 0.09, 0.1, 0.78 * opacity],
                border_color: [1.0, 1.0, 1.0, 0.14 * opacity],
                shadow_color: [0.0, 0.0, 0.0, 0.33 * opacity],
                radius_feather: [font_size * 0.52, 1.2],
                _padding1: [0.0, 0.0],
            };
            queue.write_buffer(
                &self.overlays[index].uniform_buffer,
                0,
                bytemuck::cast_slice(&[overlay_uniforms]),
            );

            let mut key_buffer = Buffer::new(&mut self.font_system, metrics);
            key_buffer.set_size(&mut self.font_system, Some(inner_width), None);
            key_buffer.set_text(
                &mut self.font_system,
                part,
                &Attrs::new()
                    .family(Family::Monospace)
                    .color(Color::rgb(255, 255, 255)),
                Shaping::Advanced,
            );
            key_buffer.shape_until_scroll(&mut self.font_system, false);

            key_positions.push((text_left, text_top, text_right, text_top + font_size * 1.45));
            key_buffers.push(key_buffer);

            cursor_x += key_width;
        }

        let mut text_areas = Vec::new();

        for (index, buffer) in key_buffers.iter().enumerate() {
            let (text_left, text_top, text_right, text_bottom) = key_positions[index];
            let bounds = TextBounds {
                left: text_left as i32,
                top: text_top as i32,
                right: text_right as i32,
                bottom: text_bottom as i32,
            };

            for (dx, dy) in [(-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)] {
                text_areas.push(TextArea {
                    buffer,
                    left: text_left + dx,
                    top: text_top + dy,
                    scale: 1.0,
                    bounds,
                    default_color: outline_color,
                    custom_glyphs: &[],
                });
            }

            text_areas.push(TextArea {
                buffer,
                left: text_left,
                top: text_top,
                scale: 1.0,
                bounds,
                default_color: main_color,
                custom_glyphs: &[],
            });
        }

        for (index, buffer) in plus_buffers.iter().enumerate() {
            let (plus_x, plus_y) = plus_positions[index];
            let bounds = TextBounds {
                left: plus_x as i32,
                top: plus_y as i32,
                right: (plus_x + plus_width * 1.4) as i32,
                bottom: (plus_y + font_size * 1.4) as i32,
            };

            text_areas.push(TextArea {
                buffer,
                left: plus_x,
                top: plus_y,
                scale: 1.0,
                bounds,
                default_color: plus_color,
                custom_glyphs: &[],
            });
        }

        if self
            .text_renderer
            .prepare(
                device,
                queue,
                &mut self.font_system,
                &mut self.text_atlas,
                &self.viewport,
                text_areas,
                &mut self.swash_cache,
            )
            .is_err()
        {
            self.visible = false;
            self.current_label = None;
            self.overlays.clear();
            return;
        }
    }

    pub fn render<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        if !self.visible {
            return;
        }

        pass.set_pipeline(&self.overlay.render_pipeline);
        for overlay in &self.overlays {
            pass.set_bind_group(0, &overlay.bind_group, &[]);
            pass.draw(0..4, 0..1);
        }

        let _ = self
            .text_renderer
            .render(&self.text_atlas, &self.viewport, pass);
    }
}

fn estimate_text_width(text: &str, font_size: f32) -> f32 {
    let mut width = 0.0;

    for ch in text.chars() {
        width += match ch {
            'I' | 'J' | 'L' | '1' | '|' => font_size * 0.44,
            'M' | 'W' => font_size * 0.76,
            ' ' => font_size * 0.32,
            _ => font_size * 0.62,
        };
    }

    width.max(font_size * 0.62)
}

fn normalize_modifier(modifier: &str) -> Option<&'static str> {
    match modifier {
        "Meta" | "Command" | "Cmd" | "Super" | "Win" => Some("⌘"),
        "Ctrl" | "Control" => Some("⌃"),
        "Alt" | "Option" | "Opt" | "AltGraph" => Some("⌥"),
        "Shift" => Some("⇧"),
        _ => None,
    }
}

fn modifier_sort_key(symbol: &str) -> u8 {
    match symbol {
        "⌃" => 0,
        "⌥" => 1,
        "⇧" => 2,
        "⌘" => 3,
        _ => 255,
    }
}

fn is_modifier_key(key: &str) -> bool {
    matches!(
        key,
        "Meta"
            | "MetaLeft"
            | "MetaRight"
            | "Command"
            | "Cmd"
            | "Ctrl"
            | "Control"
            | "ControlLeft"
            | "ControlRight"
            | "Alt"
            | "Option"
            | "Opt"
            | "AltLeft"
            | "AltRight"
            | "Shift"
            | "ShiftLeft"
            | "ShiftRight"
    )
}

fn normalize_key_label(key: &str) -> String {
    match key {
        "Left" => "←".to_string(),
        "Right" => "→".to_string(),
        "Up" => "↑".to_string(),
        "Down" => "↓".to_string(),
        "Space" => "Space".to_string(),
        "Enter" | "Return" => "Return".to_string(),
        "Escape" => "Esc".to_string(),
        "Backspace" => "Delete".to_string(),
        "Tab" => "Tab".to_string(),
        "CapsLock" => "Caps".to_string(),
        "PageUp" => "Page Up".to_string(),
        "PageDown" => "Page Down".to_string(),
        "Delete" => "Del".to_string(),
        other => other.to_uppercase(),
    }
}

fn active_shortcut_label(cursor: &CursorEvents, now_ms: f64) -> Option<ShortcutPresentation> {
    if cursor.keyboard.is_empty() {
        return None;
    }

    let mut active = HashMap::<String, ShortcutState>::new();
    let mut last_recent: Option<ShortcutState> = None;

    let mut events = cursor.keyboard.iter().collect::<Vec<_>>();
    events.sort_by(|a, b| {
        a.time_ms
            .partial_cmp(&b.time_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    for event in events {
        if event.time_ms > now_ms {
            break;
        }

        let mut mods = event
            .active_modifiers
            .iter()
            .filter(|modifier| modifier.as_str() != event.key)
            .filter_map(|modifier| normalize_modifier(modifier))
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        mods.sort_by_key(|symbol| modifier_sort_key(symbol));
        mods.dedup();

        if is_modifier_key(&event.key) {
            continue;
        }

        let has_shortcut_modifier = mods
            .iter()
            .any(|symbol| symbol == "⌘" || symbol == "⌃" || symbol == "⌥");
        if event.down && !has_shortcut_modifier {
            continue;
        }

        let mut parts = mods;
        parts.push(normalize_key_label(&event.key));
        let label = parts.join(" + ");

        if event.down {
            let state = ShortcutState {
                label,
                down_time: event.time_ms,
            };

            active.insert(event.key.clone(), state.clone());

            if let Some(last) = &last_recent {
                if state.down_time > last.down_time {
                    last_recent = Some(state);
                }
            } else {
                last_recent = Some(state);
            }
        } else {
            active.remove(&event.key);
        }
    }

    if let Some(current) = active.values().max_by(|a, b| {
        a.down_time
            .partial_cmp(&b.down_time)
            .unwrap_or(std::cmp::Ordering::Equal)
    }) {
        return Some(ShortcutPresentation {
            label: current.label.clone(),
            opacity: 1.0,
        });
    }

    if let Some(last) = last_recent
        && now_ms - last.down_time <= RECENT_SHORTCUT_WINDOW_MS
    {
        let remaining = 1.0 - ((now_ms - last.down_time) / RECENT_SHORTCUT_WINDOW_MS);
        return Some(ShortcutPresentation {
            label: last.label,
            opacity: remaining.clamp(0.0, 1.0) as f32,
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::KeyboardEvent;

    fn key_event(active_modifiers: &[&str], key: &str, time_ms: f64, down: bool) -> KeyboardEvent {
        KeyboardEvent {
            active_modifiers: active_modifiers.iter().map(|v| (*v).to_string()).collect(),
            key: key.to_string(),
            time_ms,
            down,
        }
    }

    #[test]
    fn normalizes_modifier_symbols() {
        assert_eq!(normalize_modifier("Meta"), Some("⌘"));
        assert_eq!(normalize_modifier("Control"), Some("⌃"));
        assert_eq!(normalize_modifier("Option"), Some("⌥"));
        assert_eq!(normalize_modifier("Shift"), Some("⇧"));
        assert_eq!(normalize_modifier("Unknown"), None);
    }

    #[test]
    fn normalizes_common_key_labels() {
        assert_eq!(normalize_key_label("Left"), "←");
        assert_eq!(normalize_key_label("Return"), "Return");
        assert_eq!(normalize_key_label("Escape"), "Esc");
        assert_eq!(normalize_key_label("a"), "A");
    }

    #[test]
    fn active_shortcut_has_full_opacity_when_key_is_down() {
        let cursor = CursorEvents {
            clicks: vec![],
            moves: vec![],
            keyboard: vec![key_event(&["Meta"], "k", 100.0, true)],
        };

        let presentation = active_shortcut_label(&cursor, 100.0).expect("shortcut should exist");
        assert_eq!(presentation.label, "⌘ + K");
        assert!((presentation.opacity - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn modifiers_are_displayed_in_canonical_order() {
        let cursor = CursorEvents {
            clicks: vec![],
            moves: vec![],
            keyboard: vec![key_event(
                &["Shift", "Meta", "Alt", "Ctrl"],
                "k",
                100.0,
                true,
            )],
        };

        let presentation = active_shortcut_label(&cursor, 100.0).expect("shortcut should exist");
        assert_eq!(presentation.label, "⌃ + ⌥ + ⇧ + ⌘ + K");
    }

    #[test]
    fn recently_released_shortcut_fades_then_disappears() {
        let cursor = CursorEvents {
            clicks: vec![],
            moves: vec![],
            keyboard: vec![
                key_event(&["Meta"], "k", 100.0, true),
                key_event(&["Meta"], "k", 300.0, false),
            ],
        };

        let fading = active_shortcut_label(&cursor, 700.0).expect("recent shortcut should fade");
        assert_eq!(fading.label, "⌘ + K");
        assert!(fading.opacity > 0.0 && fading.opacity < 1.0);

        let gone = active_shortcut_label(&cursor, 1300.0);
        assert!(gone.is_none());
    }
}
