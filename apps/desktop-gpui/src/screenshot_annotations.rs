//! Screenshot annotations -- the tool set, the frame-space geometry, and the
//! seam the annotation engine grows on.
//!
//! The Tauri editor keeps annotations in **frame space**: the SVG layer's
//! viewBox is `0 0 frameW frameH` (`AnnotationLayer.tsx`), so an annotation's
//! `x`/`y`/`width`/`height` are pixels of the *rendered preview frame*, not of
//! the source PNG and not of the screen. Everything in this module works in
//! that space, which is why the maths here is a literal transcription of
//! `screenshot-editor/layout.ts` and `screenshot-editor/arrow.ts` rather than
//! a re-derivation: the renderer, the SVG layer and the export path all agree
//! on those numbers today, and any drift shows up as annotations sliding off
//! the thing they point at.
//!
//! `calculate_image_transform` is the one function both halves need: it says
//! where the screenshot's content sits inside the padded frame, and the
//! context's resize effect (`context.tsx:474-547`) rescales every annotation
//! through it whenever the frame changes size.

// The geometry is transcribed whole rather than trimmed to today's callers --
// `ArrowHead::length`, `Tool::annotation_type` and friends are part of the
// transcription even where the engine reads them indirectly. Same rationale as
// `ui/mod.rs`'s allow: half a transcription is worse than none, because the
// next person would go back to `layout.ts` and re-derive it.
#![allow(dead_code)]

use std::cell::Cell;
use std::collections::HashMap;
use std::hash::{Hash as _, Hasher as _};
use std::rc::Rc;
use std::sync::Arc;

use cap_project::{Annotation, AnnotationType, AspectRatio, Crop, MaskType};
use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, Corners, CursorStyle, Entity, FontWeight,
    Hsla, InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, ParentElement as _, PathBuilder, Pixels, Point, RenderImage,
    StatefulInteractiveElement as _, Styled as _, TextRun, Window, canvas, div,
    prelude::FluentBuilder as _, px, svg,
};

use crate::editor_sidebar::{BACKGROUND_COLORS, hex_digit_count, hex_to_rgb};
use crate::screenshot_editor::ScreenshotEditorWindow;
use crate::theme::Theme;
use crate::ui;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/// `ScreenshotEditorTool` (`context.tsx:99`) -- the six annotation types plus
/// the selection arrow, in the order `AnnotationTools.tsx:37-73` lays them out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tool {
    Select,
    Draw,
    Arrow,
    Rectangle,
    Mask,
    Circle,
    Text,
}

impl Tool {
    /// Toolbar order (`AnnotationTools.tsx:37-73`).
    pub const ALL: [Tool; 7] = [
        Tool::Select,
        Tool::Draw,
        Tool::Arrow,
        Tool::Rectangle,
        Tool::Mask,
        Tool::Circle,
        Tool::Text,
    ];

    /// The Lucide glyph each button draws at `size-4`.
    pub fn icon(self) -> &'static str {
        match self {
            Tool::Select => "icons/mouse-pointer-2.svg",
            Tool::Draw => "icons/pencil.svg",
            Tool::Arrow => "icons/arrow-up-right.svg",
            Tool::Rectangle => "icons/square.svg",
            Tool::Mask => "icons/eye-off.svg",
            Tool::Circle => "icons/circle.svg",
            Tool::Text => "icons/type.svg",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Tool::Select => "Select",
            Tool::Draw => "Draw",
            Tool::Arrow => "Arrow",
            Tool::Rectangle => "Rectangle",
            Tool::Mask => "Mask",
            Tool::Circle => "Circle",
            Tool::Text => "Text",
        }
    }

    /// The `kbd` chip on the button's tooltip, and the bare key `Editor.tsx`
    /// binds it to (`:120-152`).
    pub fn shortcut(self) -> &'static str {
        match self {
            Tool::Select => "V",
            Tool::Draw => "D",
            Tool::Arrow => "A",
            Tool::Rectangle => "R",
            Tool::Mask => "M",
            Tool::Circle => "C",
            Tool::Text => "T",
        }
    }

    /// The annotation this tool draws, if it draws one.
    pub fn annotation_type(self) -> Option<AnnotationType> {
        match self {
            Tool::Select => None,
            Tool::Draw => Some(AnnotationType::Draw),
            Tool::Arrow => Some(AnnotationType::Arrow),
            Tool::Rectangle => Some(AnnotationType::Rectangle),
            Tool::Mask => Some(AnnotationType::Mask),
            Tool::Circle => Some(AnnotationType::Circle),
            Tool::Text => Some(AnnotationType::Text),
        }
    }
}

/// `ANNOTATION_TYPE_ICONS` (`LayersPanel.tsx:14-21`).
pub fn annotation_icon(annotation_type: AnnotationType) -> &'static str {
    match annotation_type {
        AnnotationType::Arrow => "icons/arrow-up-right.svg",
        AnnotationType::Rectangle => "icons/square.svg",
        AnnotationType::Circle => "icons/circle.svg",
        AnnotationType::Mask => "icons/eye-off.svg",
        AnnotationType::Text => "icons/type.svg",
        AnnotationType::Draw => "icons/pencil.svg",
    }
}

/// `ANNOTATION_TYPE_LABELS` (`LayersPanel.tsx:23-30`).
pub fn annotation_label(annotation_type: AnnotationType) -> &'static str {
    match annotation_type {
        AnnotationType::Arrow => "Arrow",
        AnnotationType::Rectangle => "Rectangle",
        AnnotationType::Circle => "Circle",
        AnnotationType::Mask => "Mask",
        AnnotationType::Text => "Text",
        AnnotationType::Draw => "Draw",
    }
}

/// `getTypeLabel` (`LayersPanel.tsx:53-60`): a text annotation shows its own
/// content, truncated at twelve characters.
pub fn layer_label(annotation: &Annotation) -> String {
    if annotation.annotation_type == AnnotationType::Text
        && let Some(text) = annotation.text.as_ref().filter(|text| !text.is_empty())
    {
        let mut chars = text.chars();
        let head: String = chars.by_ref().take(12).collect();
        return if chars.next().is_some() {
            format!("{head}...")
        } else {
            head
        };
    }
    annotation_label(annotation.annotation_type).to_string()
}

// ---------------------------------------------------------------------------
// Frame-space geometry (`layout.ts`)
// ---------------------------------------------------------------------------

/// `SCREEN_MAX_PADDING` (`layout.ts:3`), and the same constant the renderer
/// scales padding by.
pub const SCREEN_MAX_PADDING: f64 = 0.4;

/// A rectangle in frame space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `calculateImageTransform`'s return: where the screenshot's content lands
/// inside the padded frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageTransform {
    pub offset: (f64, f64),
    pub size: (f64, f64),
}

/// `roundBaseDimension` (`layout.ts:5-6`). The `& ~1` is a 32-bit bitwise op
/// in the source, so the intermediate is an integer here too.
fn round_base_dimension(value: f64) -> f64 {
    (((value.ceil() as i64) + 1) & !1).max(2) as f64
}

/// `roundAutoBaseDimension` (`layout.ts:8`).
fn round_auto_base_dimension(value: f64) -> f64 {
    (((value.floor() as i64) + 1) & !1) as f64
}

/// `getAspectRatioValue` (`layout.ts:10-23`).
fn aspect_ratio_value(aspect: &AspectRatio) -> f64 {
    match aspect {
        AspectRatio::Wide => 16. / 9.,
        AspectRatio::Vertical => 9. / 16.,
        AspectRatio::Square => 1.,
        AspectRatio::Classic => 4. / 3.,
        AspectRatio::Tall => 3. / 4.,
    }
}

/// `getBaseSize` (`layout.ts:25-58`).
fn base_size(
    crop_width: f64,
    crop_height: f64,
    padding_factor: f64,
    aspect: Option<&AspectRatio>,
) -> (f64, f64) {
    let Some(aspect) = aspect else {
        let scale = 1. + padding_factor * 2.;
        return (
            round_auto_base_dimension(crop_width * scale),
            round_auto_base_dimension(crop_height * scale),
        );
    };

    let crop_aspect = crop_width / crop_height;
    let target_aspect = aspect_ratio_value(aspect);
    let padding = crop_width.max(crop_height) * padding_factor * 2.;

    if crop_aspect > target_aspect {
        let width = crop_width + padding;
        let height = width / target_aspect;
        return (round_base_dimension(width), round_base_dimension(height));
    }

    let height = crop_height + padding;
    let width = height * target_aspect;
    (round_base_dimension(width), round_base_dimension(height))
}

/// `calculateImageTransform` (`layout.ts:60-148`), verbatim.
///
/// `frame` is the rendered frame's size, `image` the original PNG's. `padding`
/// is the config's 0..100 slider, not a pixel count.
pub fn calculate_image_transform(
    frame: (f64, f64),
    image: (f64, f64),
    padding: f64,
    crop: Option<&Crop>,
    aspect: Option<&AspectRatio>,
) -> ImageTransform {
    let crop_width = crop.map_or(image.0, |crop| crop.size.x as f64);
    let crop_height = crop.map_or(image.1, |crop| crop.size.y as f64);

    if frame.0 <= 0. || frame.1 <= 0. || crop_width <= 0. || crop_height <= 0. {
        return ImageTransform {
            offset: (0., 0.),
            size: (frame.0.max(0.), frame.1.max(0.)),
        };
    }

    let cropped_aspect = crop_width / crop_height;
    let output_aspect = frame.0 / frame.1;

    let padding_factor = (padding / 100.) * SCREEN_MAX_PADDING;
    let base = base_size(crop_width, crop_height, padding_factor, aspect);
    let output_scale = (frame.0 / base.0.max(1.)).min(frame.1 / base.1.max(1.));

    if aspect.is_none() {
        let offset_x = crop_width * padding_factor * output_scale;
        let offset_y = crop_height * padding_factor * output_scale;
        return ImageTransform {
            offset: (offset_x, offset_y),
            size: (
                (frame.0 - offset_x * 2.).max(1.),
                (frame.1 - offset_y * 2.).max(1.),
            ),
        };
    }

    let crop_basis = crop_width.max(crop_height);
    let max_padding = ((frame.0 - 1.) / 2.).min((frame.1 - 1.) / 2.).max(0.);
    let padding_pixels = (crop_basis * padding_factor * output_scale).min(max_padding);

    let available_width = (frame.0 - 2. * padding_pixels).max(1.);
    let available_height = (frame.1 - 2. * padding_pixels).max(1.);

    let height_constrained = cropped_aspect <= output_aspect;
    let (target_width, target_height) = if height_constrained {
        (available_height * cropped_aspect, available_height)
    } else {
        (available_width, available_width / cropped_aspect)
    };

    let target_offset_x = (frame.0 - target_width) / 2.;
    let target_offset_y = (frame.1 - target_height) / 2.;

    ImageTransform {
        offset: (
            if height_constrained {
                target_offset_x
            } else {
                padding_pixels
            },
            if height_constrained {
                padding_pixels
            } else {
                target_offset_y
            },
        ),
        size: (target_width, target_height),
    }
}

/// `getImageRect` (`layout.ts:150-180`): the transform as a rectangle, with the
/// whole frame as the fallback when the image's size is not known yet.
pub fn image_rect(
    frame: (f64, f64),
    image: Option<(f64, f64)>,
    padding: f64,
    crop: Option<&Crop>,
    aspect: Option<&AspectRatio>,
) -> Rect {
    let Some(image) = image else {
        return Rect {
            x: 0.,
            y: 0.,
            width: frame.0,
            height: frame.1,
        };
    };
    let transform = calculate_image_transform(frame, image, padding, crop, aspect);
    Rect {
        x: transform.offset.0,
        y: transform.offset.1,
        width: transform.size.0,
        height: transform.size.1,
    }
}

/// The context's resize effect (`context.tsx:474-547`): when the frame changes
/// size by more than a pixel, every annotation is carried across from the old
/// content rect to the new one so it keeps pointing at the same pixel of the
/// screenshot.
pub fn rescale_annotations(
    annotations: &mut [Annotation],
    previous: &ImageTransform,
    current: &ImageTransform,
) {
    if annotations.is_empty() || previous.size.0 <= 0. || previous.size.1 <= 0. {
        return;
    }
    let scale_x = current.size.0 / previous.size.0;
    let scale_y = current.size.1 / previous.size.1;

    for annotation in annotations {
        let relative_x = annotation.x - previous.offset.0;
        let relative_y = annotation.y - previous.offset.1;
        annotation.x = current.offset.0 + relative_x * scale_x;
        annotation.y = current.offset.1 + relative_y * scale_y;
        annotation.width *= scale_x;
        annotation.height *= scale_y;
    }
}

// ---------------------------------------------------------------------------
// Arrow heads (`arrow.ts`)
// ---------------------------------------------------------------------------

/// `getArrowHeadSize` (`arrow.ts:1-6`) -- `(length, width)`.
pub fn arrow_head_size(stroke_width: f64) -> (f64, f64) {
    let width = stroke_width.max(1.);
    ((width * 6.).max(20.), (width * 5.).max(14.))
}

/// `getArrowHeadPoints` (`arrow.ts:8-30`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ArrowHead {
    pub base: (f64, f64),
    pub length: f64,
    pub width: f64,
    /// Tip, then the two flanks.
    pub points: [(f64, f64); 3],
}

pub fn arrow_head_points(end_x: f64, end_y: f64, angle: f64, stroke_width: f64) -> ArrowHead {
    let (length, width) = arrow_head_size(stroke_width);
    let base_x = end_x - length * angle.cos();
    let base_y = end_y - length * angle.sin();
    let offset_x = (width / 2.) * angle.sin();
    let offset_y = (width / 2.) * -angle.cos();

    ArrowHead {
        base: (base_x, base_y),
        length,
        width,
        points: [
            (end_x, end_y),
            (base_x + offset_x, base_y + offset_y),
            (base_x - offset_x, base_y - offset_y),
        ],
    }
}

// ---------------------------------------------------------------------------
// Freehand paths (`AnnotationLayer.tsx:795-811`)
// ---------------------------------------------------------------------------

/// One `d` command of a smoothed freehand stroke.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PathSegment {
    Move {
        x: f64,
        y: f64,
    },
    /// `Q control end` -- the control point is the sample, the end point the
    /// midpoint to the next sample.
    Quad {
        cx: f64,
        cy: f64,
        x: f64,
        y: f64,
    },
    Line {
        x: f64,
        y: f64,
    },
}

/// `smoothPathFromPoints`: a move to the first sample, a quadratic through
/// every midpoint, and a straight run out to the last sample.
pub fn smooth_path(points: &[[f64; 2]]) -> Vec<PathSegment> {
    if points.len() < 2 {
        return Vec::new();
    }
    if points.len() == 2 {
        return vec![
            PathSegment::Move {
                x: points[0][0],
                y: points[0][1],
            },
            PathSegment::Line {
                x: points[1][0],
                y: points[1][1],
            },
        ];
    }

    let mut segments = Vec::with_capacity(points.len() + 1);
    segments.push(PathSegment::Move {
        x: points[0][0],
        y: points[0][1],
    });
    for pair in points.windows(2) {
        let (previous, next) = (pair[0], pair[1]);
        segments.push(PathSegment::Quad {
            cx: previous[0],
            cy: previous[1],
            x: (previous[0] + next[0]) / 2.,
            y: (previous[1] + next[1]) / 2.,
        });
    }
    let last = points[points.len() - 1];
    segments.push(PathSegment::Line {
        x: last[0],
        y: last[1],
    });
    segments
}

// ---------------------------------------------------------------------------
// The engine's own geometry
// ---------------------------------------------------------------------------

/// `#F05656` -- what every new annotation strokes with
/// (`AnnotationLayer.tsx:215-218`).
const DEFAULT_STROKE: &str = "#F05656";
/// `strokeWidth: 4` (`:219`).
const DEFAULT_STROKE_WIDTH: f64 = 4.;
/// `fillColor: "transparent"` -- the sentinel a mask strokes with too, and the
/// one `ColorPickerButton` draws a checkerboard for.
const TRANSPARENT: &str = "transparent";
/// `handleSize` (`:611-614`): ten **screen** pixels, expressed in frame units
/// at the zoom in force.
const HANDLE_SCREEN_SIZE: f64 = 10.;
/// The selection blue -- `#3b82f6`, hardcoded in the source rather than themed.
const SELECTION_BLUE: u32 = 0x3b82f6;
/// A creation smaller than this in both axes is discarded on mouse-up
/// (`:498`), and a mask thinner than this on either axis is deleted by the
/// clamp effect (`:118`).
const MIN_SIZE: f64 = 5.;
/// A text annotation's defaults (`:229-232`).
const TEXT_DEFAULT_SIZE: f64 = 40.;
const TEXT_DEFAULT_WIDTH: f64 = 150.;
/// `maskLevel: 7` (`:225`), and the `?? 16` every reader falls back to
/// (`Preview.tsx:634`).
const MASK_DEFAULT_LEVEL: f64 = 7.;
const MASK_FALLBACK_LEVEL: f64 = 16.;
/// The layers list's row pitch: a `size-6` chip inside `py-1.5`
/// (`LayersPanel.tsx:262`).
const LAYER_ROW_HEIGHT: f32 = 36.;
/// The font the renderer resolves `sans-serif` to (`layers/mod.rs:42`), so the
/// preview and the export agree on what a text annotation looks like.
pub(crate) const TEXT_FONT: &str = "Helvetica";

/// A `getBoundingClientRect` stand-in: an element's window-space rect, written
/// at prepaint. The same shape `screenshot_editor`'s anchors use.
type BoundsCell = Rc<Cell<Option<Bounds<Pixels>>>>;

/// `clampValue` (`AnnotationLayer.tsx:68-69`) -- `Math.min(Math.max(v, min),
/// max)`, so a window narrower than the value collapses to `max`.
pub fn clamp_value(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

/// The rectangle an annotation covers once its negative extents are folded in
/// -- `RenderAnnotation`'s `Math.min` / `Math.abs` pairs (`:818-827`).
pub fn normalized_rect(annotation: &Annotation) -> Rect {
    Rect {
        x: annotation.x.min(annotation.x + annotation.width),
        y: annotation.y.min(annotation.y + annotation.height),
        width: annotation.width.abs(),
        height: annotation.height.abs(),
    }
}

/// The eight (or four, or two) grips `SelectionHandles` draws (`:935-1039`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handle {
    Nw,
    N,
    Ne,
    W,
    E,
    Sw,
    S,
    Se,
    /// An arrow's tail.
    Start,
    /// An arrow's tip.
    End,
}

impl Handle {
    /// `state.handle.includes("w")` and friends (`:375-384`).
    fn west(self) -> bool {
        matches!(self, Handle::Nw | Handle::W | Handle::Sw)
    }

    fn east(self) -> bool {
        matches!(self, Handle::Ne | Handle::E | Handle::Se)
    }

    fn north(self) -> bool {
        matches!(self, Handle::Nw | Handle::N | Handle::Ne)
    }

    fn south(self) -> bool {
        matches!(self, Handle::Sw | Handle::S | Handle::Se)
    }

    /// `cursor={`${handle.id}-resize`}` (`:1028`), and `crosshair` for the two
    /// an arrow carries (`:988`).
    fn cursor(self) -> CursorStyle {
        match self {
            Handle::Nw | Handle::Se => CursorStyle::ResizeUpLeftDownRight,
            Handle::Ne | Handle::Sw => CursorStyle::ResizeUpRightDownLeft,
            Handle::N | Handle::S => CursorStyle::ResizeUpDown,
            Handle::W | Handle::E => CursorStyle::ResizeLeftRight,
            Handle::Start | Handle::End => CursorStyle::Crosshair,
        }
    }
}

/// `selectionRect` (`:947-956`): the shape's own box, padded by 30 % of a
/// handle for text so the wash clears the glyphs.
pub fn selection_rect(annotation: &Annotation, handle_size: f64) -> Rect {
    let padding = if annotation.annotation_type == AnnotationType::Text {
        handle_size * 0.3
    } else {
        0.
    };
    let rect = normalized_rect(annotation);
    Rect {
        x: rect.x - padding,
        y: rect.y - padding,
        width: rect.width + padding * 2.,
        height: rect.height + padding * 2.,
    }
}

/// `cornerHandles` (`:958-977`) placed on the selection rect: eight for a
/// shape, the four corners for text, and the two endpoints for an arrow.
pub fn handles(annotation: &Annotation, handle_size: f64) -> Vec<(Handle, (f64, f64))> {
    if annotation.annotation_type == AnnotationType::Arrow {
        return vec![
            (Handle::Start, (annotation.x, annotation.y)),
            (
                Handle::End,
                (
                    annotation.x + annotation.width,
                    annotation.y + annotation.height,
                ),
            ),
        ];
    }

    let rect = selection_rect(annotation, handle_size);
    let corners: &[(Handle, f64, f64)] = if annotation.annotation_type == AnnotationType::Text {
        &[
            (Handle::Nw, 0., 0.),
            (Handle::Ne, 1., 0.),
            (Handle::Sw, 0., 1.),
            (Handle::Se, 1., 1.),
        ]
    } else {
        &[
            (Handle::Nw, 0., 0.),
            (Handle::N, 0.5, 0.),
            (Handle::Ne, 1., 0.),
            (Handle::W, 0., 0.5),
            (Handle::E, 1., 0.5),
            (Handle::Sw, 0., 1.),
            (Handle::S, 0.5, 1.),
            (Handle::Se, 1., 1.),
        ]
    };
    corners
        .iter()
        .map(|(handle, fraction_x, fraction_y)| {
            (
                *handle,
                (
                    rect.x + fraction_x * rect.width,
                    rect.y + fraction_y * rect.height,
                ),
            )
        })
        .collect()
}

/// The grip under a pointer, if any. The handles are `<circle r={half()}>`, so
/// the hit area is the circle itself.
pub fn hit_handle(annotation: &Annotation, point: (f64, f64), handle_size: f64) -> Option<Handle> {
    let radius = handle_size / 2.;
    handles(annotation, handle_size)
        .into_iter()
        .find(|(_, (x, y))| {
            let (dx, dy) = (point.0 - x, point.1 - y);
            dx * dx + dy * dy <= radius * radius
        })
        .map(|(handle, _)| handle)
}

/// The annotation under a pointer, topmost first -- later siblings paint over
/// earlier ones (`:649-768`), so the hit test walks the list backwards.
pub fn hit_test(annotations: &[Annotation], point: (f64, f64), handle_size: f64) -> Option<usize> {
    annotations
        .iter()
        .enumerate()
        .rev()
        .find(|(_, annotation)| hit_annotation(annotation, point, handle_size))
        .map(|(index, _)| index)
}

/// The hit test the SVG performs. Every shape sits inside a `<g>` that sets
/// `pointer-events: all` (`:655-658`), and that value is inherited: a shape is
/// a target over its **interior or its perimeter, whatever `fill` and `stroke`
/// say**. So a `fill="transparent"` rectangle is hit across its face, a
/// `fill="none"` stroke is hit inside the region it encloses as well as along
/// its line, and the mask's invisible rect takes a press anywhere inside it.
pub fn hit_annotation(annotation: &Annotation, point: (f64, f64), handle_size: f64) -> bool {
    let stroke = (annotation.stroke_width / 2.).max(0.);
    match annotation.annotation_type {
        AnnotationType::Rectangle | AnnotationType::Mask => {
            let rect = normalized_rect(annotation);
            point.0 >= rect.x - stroke
                && point.0 <= rect.x + rect.width + stroke
                && point.1 >= rect.y - stroke
                && point.1 <= rect.y + rect.height + stroke
        }
        AnnotationType::Circle => {
            // SVG disables rendering for `rx="0"`/`ry="0"`, and an unrendered
            // element is not a pointer target however permissive
            // `pointer-events` is.
            if annotation.width == 0. || annotation.height == 0. {
                return false;
            }
            let center = (
                annotation.x + annotation.width / 2.,
                annotation.y + annotation.height / 2.,
            );
            let radius_x = (annotation.width / 2.).abs() + stroke;
            let radius_y = (annotation.height / 2.).abs() + stroke;
            if radius_x <= 0. || radius_y <= 0. {
                return false;
            }
            let dx = (point.0 - center.0) / radius_x;
            let dy = (point.1 - center.1) / radius_y;
            dx * dx + dy * dy <= 1.
        }
        AnnotationType::Text => {
            // The hover rect's box (`:738-750`), grown to Figma's feel by
            // `text_hit_rect` -- the measured overload in
            // `ScreenshotEditorWindow::hit_annotation_measured` also folds in
            // the glyph run.
            let rect = text_hit_rect(annotation, handle_size, None);
            point.0 >= rect.x
                && point.0 <= rect.x + rect.width
                && point.1 >= rect.y
                && point.1 <= rect.y + rect.height
        }
        AnnotationType::Arrow => {
            let end = (
                annotation.x + annotation.width,
                annotation.y + annotation.height,
            );
            let angle = (end.1 - annotation.y).atan2(end.0 - annotation.x);
            let head = arrow_head_points(end.0, end.1, angle, annotation.stroke_width);
            let tolerance = stroke.max(2.);
            distance_to_segment(point, (annotation.x, annotation.y), head.base) <= tolerance
                || point_in_triangle(point, head.points)
        }
        AnnotationType::Draw => {
            let points = draw_points(annotation);
            if points.len() < 2 {
                return false;
            }
            let tolerance = stroke.max(2.);
            // The line itself, and -- because `pointer-events: all` ignores
            // `fill="none"` -- whatever the path would have enclosed. Without
            // the second half a scribble is only selectable within half a
            // stroke of its own line, which at 50 % zoom is about a pixel.
            points.windows(2).any(|pair| {
                distance_to_segment(point, (pair[0][0], pair[0][1]), (pair[1][0], pair[1][1]))
                    <= tolerance
            }) || point_in_polygon(point, &points)
        }
    }
}

/// The extent of the glyph run [`paint_text`] draws, in frame units: the
/// run's advance width, and the ascent/descent around the baseline it hangs
/// from (`y + height`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextExtent {
    pub width: f64,
    pub ascent: f64,
    pub descent: f64,
}

/// The rect a pointer selects a text annotation from. This is Figma's feel
/// rather than the SVG's: the source's hover rect is the stored box alone,
/// but its `<text>` element also took clicks across every glyph cell through
/// `pointer-events: all` -- and the glyph run overflows the stored box freely
/// (typing never widens `width`), so the box alone goes dead past
/// `x + width`. The hit rect is therefore the stored box unioned with the
/// measured glyph run, padded by the hover overlay's `handleSize * 0.3` slop,
/// and never thinner than two handles on a side so a tiny label is not
/// miss-prone. Selection and hover *visuals* still draw [`selection_rect`],
/// exactly like the source.
pub fn text_hit_rect(
    annotation: &Annotation,
    handle_size: f64,
    glyphs: Option<TextExtent>,
) -> Rect {
    let rect = selection_rect(annotation, handle_size);
    let (mut left, mut top) = (rect.x, rect.y);
    let (mut right, mut bottom) = (rect.x + rect.width, rect.y + rect.height);

    if let Some(glyphs) = glyphs {
        let padding = handle_size * 0.3;
        // `paint_text` anchors the baseline at the raw `y + height`, so the
        // glyph box does too.
        let baseline = annotation.y + annotation.height;
        right = right.max(annotation.x + glyphs.width + padding);
        top = top.min(baseline - glyphs.ascent - padding);
        bottom = bottom.max(baseline + glyphs.descent + padding);
    }

    // The generous floor: 2x `handleSize` (20 screen px) per side, centred,
    // so text scaled down to a sliver still takes the press.
    let min_side = handle_size * 2.;
    if right - left < min_side {
        let center = (left + right) / 2.;
        left = center - min_side / 2.;
        right = center + min_side / 2.;
    }
    if bottom - top < min_side {
        let center = (top + bottom) / 2.;
        top = center - min_side / 2.;
        bottom = center + min_side / 2.;
    }

    Rect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    }
}

/// A stroke's samples in frame space -- `RenderAnnotation`'s draw branch
/// (`:915-921`), including its `|| 1` guard against a zero-width box.
pub fn draw_points(annotation: &Annotation) -> Vec<[f64; 2]> {
    let width = if annotation.width == 0. {
        1.
    } else {
        annotation.width
    };
    let height = if annotation.height == 0. {
        1.
    } else {
        annotation.height
    };
    annotation
        .points
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|point| {
            [
                annotation.x + point[0] * width,
                annotation.y + point[1] * height,
            ]
        })
        .collect()
}

/// `handleMouseUp`'s draw branch (`:449-453`): the samples become fractions of
/// the stroke's own bounding box, so a later resize carries them along.
pub fn normalize_draw_points(
    points: &[[f64; 2]],
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Vec<[f64; 2]> {
    let width = if width == 0. { 1. } else { width };
    let height = if height == 0. { 1. } else { height };
    points
        .iter()
        .map(|point| [(point[0] - x) / width, (point[1] - y) / height])
        .collect()
}

/// A resize that dragged a stroke inside out (`:544-556`): the box is
/// un-negated and the normalized samples mirror with it.
pub fn flip_draw_points(points: &[[f64; 2]], flip_x: bool, flip_y: bool) -> Vec<[f64; 2]> {
    points
        .iter()
        .map(|point| {
            [
                if flip_x { 1. - point[0] } else { point[0] },
                if flip_y { 1. - point[1] } else { point[1] },
            ]
        })
        .collect()
}

/// What the auto-clamp effect (`:88-141`) decided about one mask.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MaskClamp {
    /// Already inside the image rect.
    Unchanged,
    /// Smaller than 5px on an axis once clipped: delete it.
    Remove,
    /// Move it here.
    Clamped(Rect),
}

/// Clip one mask into the screenshot's content rect.
pub fn clamp_mask(annotation: &Annotation, rect: Rect) -> MaskClamp {
    let (right_edge, bottom_edge) = (rect.x + rect.width, rect.y + rect.height);
    let raw_left = annotation.x.min(annotation.x + annotation.width);
    let raw_top = annotation.y.min(annotation.y + annotation.height);
    let left = clamp_value(raw_left, rect.x, right_edge);
    let right = clamp_value(
        annotation.x.max(annotation.x + annotation.width),
        rect.x,
        right_edge,
    );
    let top = clamp_value(raw_top, rect.y, bottom_edge);
    let bottom = clamp_value(
        annotation.y.max(annotation.y + annotation.height),
        rect.y,
        bottom_edge,
    );
    let width = (right - left).max(0.);
    let height = (bottom - top).max(0.);

    if width < MIN_SIZE || height < MIN_SIZE {
        return MaskClamp::Remove;
    }
    if left != raw_left
        || top != raw_top
        || width != annotation.width.abs()
        || height != annotation.height.abs()
    {
        return MaskClamp::Clamped(Rect {
            x: left,
            y: top,
            width,
            height,
        });
    }
    MaskClamp::Unchanged
}

/// `finalizeDrag` (`LayersPanel.tsx:93-124`): the panel lists the annotations
/// reversed, so a drop index in that list has to be walked back through
/// `getActualIndex`, and a drop *below* the dragged row loses one slot to the
/// row's own removal.
pub fn reorder_move(len: usize, dragged_reversed: usize, target: usize) -> Option<(usize, usize)> {
    if len == 0 || dragged_reversed >= len || dragged_reversed == target {
        return None;
    }
    let actual = |reversed: usize| len - 1 - reversed.min(len - 1);
    let from = actual(dragged_reversed);
    let to = if target > dragged_reversed {
        actual(target.saturating_sub(1))
    } else {
        actual(target)
    };
    (from != to).then_some((from, to))
}

/// Whether a drag actually moved anything -- the "only record if something
/// changed" half of the snapshot semantics.
fn geometry_changed(before: &Annotation, after: &Annotation) -> bool {
    before.x != after.x
        || before.y != after.y
        || before.width != after.width
        || before.height != after.height
        || before.points != after.points
}

fn distance_to_segment(point: (f64, f64), start: (f64, f64), end: (f64, f64)) -> f64 {
    let (dx, dy) = (end.0 - start.0, end.1 - start.1);
    let length_squared = dx * dx + dy * dy;
    let t = if length_squared <= f64::EPSILON {
        0.
    } else {
        (((point.0 - start.0) * dx + (point.1 - start.1) * dy) / length_squared).clamp(0., 1.)
    };
    let closest = (start.0 + t * dx, start.1 + t * dy);
    ((point.0 - closest.0).powi(2) + (point.1 - closest.1).powi(2)).sqrt()
}

/// SVG's default `fill-rule: nonzero`, over a stroke's samples closed back on
/// themselves -- the region a `fill="none"` path still counts as its interior
/// for hit testing. The winding number, rather than an even-odd crossing
/// count, so a scribble that loops over itself stays solid.
fn point_in_polygon(point: (f64, f64), points: &[[f64; 2]]) -> bool {
    if points.len() < 3 {
        return false;
    }
    // Which side of `a -> b` the point falls on.
    let side = |a: [f64; 2], b: [f64; 2]| {
        (b[0] - a[0]) * (point.1 - a[1]) - (point.0 - a[0]) * (b[1] - a[1])
    };
    let mut winding = 0i32;
    for index in 0..points.len() {
        let a = points[index];
        let b = points[(index + 1) % points.len()];
        if a[1] <= point.1 {
            if b[1] > point.1 && side(a, b) > 0. {
                winding += 1;
            }
        } else if b[1] <= point.1 && side(a, b) < 0. {
            winding -= 1;
        }
    }
    winding != 0
}

fn point_in_triangle(point: (f64, f64), triangle: [(f64, f64); 3]) -> bool {
    let sign = |a: (f64, f64), b: (f64, f64), c: (f64, f64)| {
        (a.0 - c.0) * (b.1 - c.1) - (b.0 - c.0) * (a.1 - c.1)
    };
    let d1 = sign(point, triangle[0], triangle[1]);
    let d2 = sign(point, triangle[1], triangle[2]);
    let d3 = sign(point, triangle[2], triangle[0]);
    let negative = d1 < 0. || d2 < 0. || d3 < 0.;
    let positive = d1 > 0. || d2 > 0. || d3 > 0.;
    !(negative && positive)
}

/// A CSS colour string as RGB bytes plus a resolved 0..1 alpha, with the
/// annotation's `globalAlpha` folded in. `transparent` -- the sentinel a mask
/// strokes with and an unfilled shape fills with -- paints nothing at all, so
/// it comes back as `None`. Shared between the preview's gpui paint and the
/// export's tiny-skia paint so both resolve a colour identically.
pub(crate) fn parse_css_rgba(value: &str, opacity: f64) -> Option<([u8; 3], f32)> {
    let value = value.trim();
    if value.is_empty()
        || value.eq_ignore_ascii_case(TRANSPARENT)
        || value.eq_ignore_ascii_case("none")
    {
        return None;
    }
    let rgba = hex_to_rgb(value)?;
    let alpha = (f32::from(rgba[3]) / 255.) * opacity.clamp(0., 1.) as f32;
    Some(([rgba[0], rgba[1], rgba[2]], alpha))
}

/// A CSS colour string as gpui takes it.
fn annotation_color(value: &str, opacity: f64) -> Option<Hsla> {
    let (rgb, alpha) = parse_css_rgba(value, opacity)?;
    Some(Hsla::from(gpui::Rgba {
        r: f32::from(rgb[0]) / 255.,
        g: f32::from(rgb[1]) / 255.,
        b: f32::from(rgb[2]) / 255.,
        a: alpha,
    }))
}

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

/// One live gesture over the preview.
enum Gesture {
    /// A tool drawing a new annotation (`isDrawing` + `tempAnnotation`).
    Create(Creating),
    /// `dragState.action === "move"`.
    Move(Dragging),
    /// `dragState.action === "resize"`.
    Resize(Dragging),
}

struct Creating {
    temp: Annotation,
    /// A mask joins the live list the moment its drag starts (`:236-238`), so
    /// its blur preview follows the pointer.
    in_list: bool,
}

struct Dragging {
    id: String,
    handle: Option<Handle>,
    start: (f64, f64),
    /// `dragState.original` -- every frame of the drag is computed from the
    /// state the press found, never from the previous frame.
    original: Annotation,
    /// Whether a move gesture has crossed the promote threshold -- the editor
    /// canvas's `state.moved` (`editor_canvas.rs`), which the source layer
    /// does not have. Sticky: once a drag, always a drag.
    moved: bool,
}

/// The inline text editor's bracket: which annotation, and what it said when
/// the editor opened (`textSnapshot`, `:703-708`).
struct TextEdit {
    id: String,
    original: String,
}

/// A live layer-reorder drag (`LayersPanel.tsx:43-51`).
struct Reorder {
    id: String,
    /// `dropTargetIndex`, in the reversed list's coordinates.
    target: Option<usize>,
    /// The list length the drag started against. The source cancels outright
    /// when the count changes underneath it (`LayersPanel.tsx:192-200`), which
    /// an undo mid-drag can do.
    count: usize,
}

/// `ColorPickerButton`'s two call sites (`AnnotationConfig.tsx:47-79`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum ColorTarget {
    Stroke,
    Fill,
}

impl ColorTarget {
    const ALL: [ColorTarget; 2] = [ColorTarget::Stroke, ColorTarget::Fill];

    fn id(self) -> &'static str {
        match self {
            Self::Stroke => "screenshot-annotation-stroke",
            Self::Fill => "screenshot-annotation-fill",
        }
    }

    /// Only Fill offers the checkerboard swatch (`allowTransparent`, `:76`).
    fn allows_transparent(self) -> bool {
        self == Self::Fill
    }
}

/// The config bar's sliders. A parallel of `screenshot_editor`'s `StyleSlider`
/// -- same `ui::Slider` plumbing, same pause/resume bracket -- kept separate
/// because these read and write the *selected annotation*, not the project's
/// background.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum AnnotationSlider {
    Width,
    Opacity,
    MaskLevel,
    TextSize,
}

impl AnnotationSlider {
    const ALL: [AnnotationSlider; 4] = [
        AnnotationSlider::Width,
        AnnotationSlider::Opacity,
        AnnotationSlider::MaskLevel,
        AnnotationSlider::TextSize,
    ];

    /// `(min, max, step)` -- `AnnotationConfig.tsx:60-157`.
    fn range(self) -> (f32, f32, f32) {
        match self {
            Self::Width => (1., 20., 1.),
            Self::Opacity => (0.1, 1., 0.1),
            Self::MaskLevel => (4., 50., 1.),
            Self::TextSize => (12., 100., 1.),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Width => "width",
            Self::Opacity => "opacity",
            Self::MaskLevel => "mask-level",
            Self::TextSize => "text-size",
        }
    }

    fn value(self, annotation: &Annotation) -> f32 {
        match self {
            Self::Width => annotation.stroke_width as f32,
            Self::Opacity => annotation.opacity as f32,
            Self::MaskLevel => annotation.mask_level.unwrap_or(MASK_FALLBACK_LEVEL) as f32,
            Self::TextSize => annotation.height as f32,
        }
    }

    fn apply(self, annotation: &mut Annotation, value: f32) -> bool {
        let value = value as f64;
        let field = match self {
            Self::Width => &mut annotation.stroke_width,
            Self::Opacity => &mut annotation.opacity,
            Self::TextSize => &mut annotation.height,
            Self::MaskLevel => {
                let level = annotation.mask_level.get_or_insert(MASK_FALLBACK_LEVEL);
                if *level == value {
                    return false;
                }
                *level = value;
                return true;
            }
        };
        if *field == value {
            return false;
        }
        *field = value;
        true
    }
}

/// One blurred or pixelated region, ready to paint between the frame and the
/// annotations -- `renderMaskOverlays`' second canvas (`Preview.tsx:742-758`).
#[derive(Clone)]
struct MaskOverlay {
    /// The region in frame space, snapped to whole frame pixels because that
    /// is what was resampled.
    rect: Rect,
    image: Arc<RenderImage>,
}

/// Everything the annotation engine keeps that is not the annotations
/// themselves. One field on the window rather than fifteen.
#[derive(Default)]
pub struct AnnotationState {
    /// The layer's own window-space rect -- the preview's content wrapper,
    /// which is what maps a pointer into frame space.
    layer: BoundsCell,
    gesture: Option<Gesture>,
    /// The annotation the pointer is over, for the text hover wash.
    hover: Option<String>,
    hover_cursor: Option<CursorStyle>,
    /// `copiedAnnotation` (`Editor.tsx:53-54`).
    clipboard: Option<Annotation>,
    editing: Option<TextEdit>,
    text_input: Option<Entity<ui::TextInputState>>,
    /// The open swatch, and the annotation it was opened for: a selection
    /// change closes it rather than repointing it.
    color_popover: Option<(ColorTarget, String)>,
    color_anchors: HashMap<ColorTarget, BoundsCell>,
    color_inputs: HashMap<ColorTarget, Entity<ui::TextInputState>>,
    slider_tracks: HashMap<AnnotationSlider, ui::SliderTrack>,
    active_slider: Option<AnnotationSlider>,
    /// The layers list's rows container, for the reorder drag's hit testing.
    list: BoundsCell,
    reorder: Option<Reorder>,
    masks: Vec<MaskOverlay>,
    /// The inputs the painted overlays were computed from, and the ones a
    /// computation in flight is for.
    mask_key: u64,
    mask_pending: Option<u64>,
    mask_task: Option<gpui::Task<()>>,
}

/// One paint of the layer, copied out of the window so the closure owns it.
/// Cloning the list is the cost of a `'static` paint closure; a screenshot
/// carries a handful of annotations, not a timeline's worth.
struct LayerPaint {
    annotations: Vec<Annotation>,
    temp: Option<Annotation>,
    masks: Vec<MaskOverlay>,
    selected: Option<String>,
    editing: Option<String>,
    hover: Option<String>,
    select_tool: bool,
    scale: f32,
    handle_size: f64,
}

// ---------------------------------------------------------------------------
// The window's seam
// ---------------------------------------------------------------------------

impl ScreenshotEditorWindow {
    /// The text field the inline editor drives, and the two hex fields the
    /// colour popover carries. Entities need a `Window`, so they are minted in
    /// `ScreenshotEditorWindow::new` the way the styling popovers' are.
    pub(crate) fn init_annotation_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = cx.new(|cx| ui::TextInputState::single_line(window, cx));
        let subscription = cx.subscribe_in(
            &text,
            window,
            move |this: &mut Self, _input, event: &ui::TextInputEvent, window, cx| {
                this.on_annotation_text_event(event, window, cx);
            },
        );
        self.text_subscriptions.push(subscription);
        self.annotation_state.text_input = Some(text);

        for target in ColorTarget::ALL {
            let input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
            let subscription = cx.subscribe_in(
                &input,
                window,
                move |this: &mut Self, _input, event: &ui::TextInputEvent, window, cx| {
                    this.on_annotation_color_event(target, event, window, cx);
                },
            );
            self.text_subscriptions.push(subscription);
            self.annotation_state.color_inputs.insert(target, input);
            self.annotation_state
                .color_anchors
                .insert(target, BoundsCell::default());
        }

        for slider in AnnotationSlider::ALL {
            self.annotation_state
                .slider_tracks
                .insert(slider, ui::SliderTrack::default());
        }
    }

    // -- Frame-space plumbing -------------------------------------------------

    /// Screen pixels per frame pixel -- `cssWidth / bounds.width`
    /// (`AnnotationLayer.tsx:613`), read off the layer's painted rect so it
    /// needs no zoom bookkeeping of its own.
    fn annotation_scale(&self) -> Option<f32> {
        let bounds = self.annotation_state.layer.get()?;
        let width = f32::from(bounds.size.width);
        (width > 0. && self.frame_size.0 > 0.).then(|| width / self.frame_size.0)
    }

    /// `handleSize` in frame units.
    fn handle_size(&self) -> f64 {
        HANDLE_SCREEN_SIZE / self.annotation_scale().unwrap_or(1.).max(0.001) as f64
    }

    /// The glyph run [`paint_text`] will draw for `annotation`, shaped through
    /// the window's text system exactly as the paint does and mapped back into
    /// frame units. `None` for anything that is not a text annotation with
    /// content, or before the layer has painted once.
    fn text_extent(&self, annotation: &Annotation, window: &Window) -> Option<TextExtent> {
        if annotation.annotation_type != AnnotationType::Text {
            return None;
        }
        let text = annotation.text.as_deref().filter(|text| !text.is_empty())?;
        let scale = self.annotation_scale()?;
        let font_size = px((annotation.height as f32 * scale).max(1.));
        // Mirror `paint_text`'s newline guard so the measure matches the paint.
        let text = if text.contains('\n') {
            text.replace('\n', " ")
        } else {
            text.to_string()
        };
        let run = TextRun {
            len: text.len(),
            font: gpui::font(TEXT_FONT),
            color: gpui::black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let line = window
            .text_system()
            .shape_line(text.into(), font_size, &[run], None);
        let scale = f64::from(scale);
        Some(TextExtent {
            width: f64::from(f32::from(line.width)) / scale,
            ascent: f64::from(f32::from(line.ascent)) / scale,
            descent: f64::from(f32::from(line.descent)) / scale,
        })
    }

    /// [`hit_annotation`], with text upgraded to the measured glyph box
    /// ([`text_hit_rect`]) -- the Figma-feel half of the hit test lives here
    /// because measuring the run needs a window.
    fn hit_annotation_measured(
        &self,
        annotation: &Annotation,
        point: (f64, f64),
        handle_size: f64,
        window: &Window,
    ) -> bool {
        if annotation.annotation_type == AnnotationType::Text {
            let rect = text_hit_rect(
                annotation,
                handle_size,
                self.text_extent(annotation, window),
            );
            return point.0 >= rect.x
                && point.0 <= rect.x + rect.width
                && point.1 >= rect.y
                && point.1 <= rect.y + rect.height;
        }
        hit_annotation(annotation, point, handle_size)
    }

    /// [`hit_test`] through [`Self::hit_annotation_measured`].
    fn hit_test_measured(
        &self,
        point: (f64, f64),
        handle_size: f64,
        window: &Window,
    ) -> Option<usize> {
        (0..self.project.annotations.len()).rev().find(|index| {
            self.hit_annotation_measured(
                &self.project.annotations[*index],
                point,
                handle_size,
                window,
            )
        })
    }

    /// `getSvgPoint` (`:144-156`). The viewBox's origin is always `0 0` here,
    /// so the mapping is the layer's rect and the scale.
    fn frame_point(&self, position: Point<Pixels>) -> Option<(f64, f64)> {
        let bounds = self.annotation_state.layer.get()?;
        let scale = self.annotation_scale()?;
        Some((
            f64::from(f32::from(position.x - bounds.origin.x) / scale),
            f64::from(f32::from(position.y - bounds.origin.y) / scale),
        ))
    }

    /// `getImageRect(...)` for the config in force -- what clips every mask.
    pub(crate) fn annotation_image_rect(&self) -> Rect {
        image_rect(
            (self.frame_size.0 as f64, self.frame_size.1 as f64),
            self.image_size
                .map(|(width, height)| (width as f64, height as f64)),
            self.project.background.padding,
            self.project.background.crop.as_ref(),
            self.project.aspect_ratio.as_ref(),
        )
    }

    fn annotation(&self, id: &str) -> Option<&Annotation> {
        self.project
            .annotations
            .iter()
            .find(|annotation| annotation.id == id)
    }

    fn annotation_mut(&mut self, id: &str) -> Option<&mut Annotation> {
        self.project
            .annotations
            .iter_mut()
            .find(|annotation| annotation.id == id)
    }

    fn selected(&self) -> Option<&Annotation> {
        self.annotation(self.selected_annotation.as_deref()?)
    }

    /// One committed annotation change: the sequence `edit_project` runs --
    /// record, publish, schedule the debounced write -- for a mutation already
    /// applied to `self.project`.
    fn commit_annotations(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.clamp_masks();
        self.history.record(&self.project);
        self.publish();
        self.schedule_save(window, cx);
        self.refresh_mask_overlays(window, cx);
        cx.notify();
    }

    /// The auto-clamp effect (`AnnotationLayer.tsx:88-141`): every mask is
    /// clipped into the screenshot's content rect, and one that clips away to
    /// nothing is deleted. Runs where the geometry moves -- a new frame, or an
    /// edit to padding / crop / aspect -- not in the paint path.
    ///
    /// Returns whether anything moved, so the caller can decide whether the
    /// change is worth publishing.
    pub(crate) fn clamp_masks(&mut self) -> bool {
        let rect = self.annotation_image_rect();
        if rect.width <= 0. || rect.height <= 0. {
            return false;
        }
        // The mask being dragged out right now is exempt: it is mid-gesture and
        // clamps itself against the same rect on every move (`:91`, `:95`).
        let drawing = match &self.annotation_state.gesture {
            Some(Gesture::Create(creating)) => Some(creating.temp.id.clone()),
            _ => None,
        };

        let mut changed = false;
        let mut removed = Vec::new();
        for annotation in &mut self.project.annotations {
            if annotation.annotation_type != AnnotationType::Mask {
                continue;
            }
            if drawing.as_deref() == Some(annotation.id.as_str()) {
                continue;
            }
            match clamp_mask(annotation, rect) {
                MaskClamp::Unchanged => {}
                MaskClamp::Remove => removed.push(annotation.id.clone()),
                MaskClamp::Clamped(clamped) => {
                    annotation.x = clamped.x;
                    annotation.y = clamped.y;
                    annotation.width = clamped.width;
                    annotation.height = clamped.height;
                    changed = true;
                }
            }
        }
        if !removed.is_empty() {
            self.project
                .annotations
                .retain(|annotation| !removed.contains(&annotation.id));
            if let Some(selected) = &self.selected_annotation
                && removed.contains(selected)
            {
                self.selected_annotation = None;
            }
            changed = true;
        }
        changed
    }
}

impl ScreenshotEditorWindow {
    // -- Pointer --------------------------------------------------------------

    /// A left press inside the preview. `true` means the annotation layer took
    /// it -- a hit on a shape, a handle, or the start of a new drawing.
    pub(crate) fn annotation_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        // `handleMouseDown`'s first act (`AnnotationLayer.tsx:159-164`): a press
        // outside the open editor commits it; one inside belongs to the field.
        if self.annotation_state.editing.is_some() {
            if self
                .text_editor_bounds()
                .is_some_and(|bounds| bounds.contains(&event.position))
            {
                return true;
            }
            self.commit_text_edit(window, cx);
        }

        let Some(bounds) = self.annotation_state.layer.get() else {
            return false;
        };
        if !bounds.contains(&event.position) {
            return false;
        }
        let Some(point) = self.frame_point(event.position) else {
            return false;
        };

        if self.tool == Tool::Select {
            return self.begin_select_gesture(point, event.click_count, window, cx);
        }
        self.begin_create(self.tool, point, cx);
        true
    }

    /// `startDrag` (`:568-596`) and `handleDoubleClick` (`:598-609`).
    fn begin_select_gesture(
        &mut self,
        point: (f64, f64),
        click_count: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let handle_size = self.handle_size();
        let selected = self.selected_annotation.clone();

        // Document order settles every tie. The grips live *inside* the
        // selected annotation's own `<g>` (`:760-765`), so they paint -- and
        // therefore hit -- over its shape but under any annotation later in the
        // list. One top-down walk expresses both.
        for index in (0..self.project.annotations.len()).rev() {
            let annotation = &self.project.annotations[index];
            if selected.as_deref() == Some(annotation.id.as_str())
                && let Some(handle) = hit_handle(annotation, point, handle_size)
            {
                let id = annotation.id.clone();
                let original = annotation.clone();
                self.annotation_state.gesture = Some(Gesture::Resize(Dragging {
                    id,
                    handle: Some(handle),
                    start: point,
                    original,
                    moved: false,
                }));
                cx.notify();
                return true;
            }
            if !self.hit_annotation_measured(annotation, point, handle_size, window) {
                continue;
            }

            let annotation = annotation.clone();
            self.selected_annotation = Some(annotation.id.clone());
            if click_count >= 2 && annotation.annotation_type == AnnotationType::Text {
                self.begin_text_edit(annotation.id, window, cx);
                return true;
            }
            // Selection and the move arm in one press -- `startDrag` (`:568`):
            // a not-yet-selected shape drags in the same motion, no
            // select-then-drag two-step.
            self.annotation_state.gesture = Some(Gesture::Move(Dragging {
                id: annotation.id.clone(),
                handle: None,
                start: point,
                original: annotation,
                moved: false,
            }));
            cx.notify();
            return true;
        }

        // `e.target === e.currentTarget` (`:168-173`): a press on bare canvas
        // drops the selection. The `false` then lets the caller start the pan,
        // which is `onBackgroundMouseDown` over there.
        if self.selected_annotation.take().is_some() {
            cx.notify();
        }
        false
    }

    /// `handleMouseDown`'s tool branch (`:176-238`).
    fn begin_create(&mut self, tool: Tool, point: (f64, f64), cx: &mut Context<Self>) {
        let Some(annotation_type) = tool.annotation_type() else {
            return;
        };
        let is_mask = annotation_type == AnnotationType::Mask;
        let rect = self.annotation_image_rect();
        let (x, y) = if is_mask {
            (
                clamp_value(point.0, rect.x, rect.x + rect.width),
                clamp_value(point.1, rect.y, rect.y + rect.height),
            )
        } else {
            point
        };

        // `styleSource` (`:203-207`): a new stroke inherits from the selection,
        // or else from the last stroke drawn.
        let style =
            (annotation_type == AnnotationType::Draw)
                .then(|| {
                    self.selected()
                        .or_else(|| {
                            self.project.annotations.iter().rev().find(|annotation| {
                                annotation.annotation_type == AnnotationType::Draw
                            })
                        })
                        .map(|annotation| {
                            (
                                annotation.stroke_color.clone(),
                                annotation.stroke_width,
                                annotation.opacity,
                            )
                        })
                })
                .flatten();

        let is_text = annotation_type == AnnotationType::Text;
        let annotation = Annotation {
            id: crate::store::new_uuid_v4(),
            annotation_type,
            x,
            y,
            width: if is_text { TEXT_DEFAULT_WIDTH } else { 0. },
            height: if is_text { TEXT_DEFAULT_SIZE } else { 0. },
            stroke_color: if is_mask {
                TRANSPARENT.to_string()
            } else {
                style
                    .as_ref()
                    .map(|(color, _, _)| color.clone())
                    .unwrap_or_else(|| DEFAULT_STROKE.to_string())
            },
            stroke_width: if is_mask {
                0.
            } else {
                style
                    .as_ref()
                    .map_or(DEFAULT_STROKE_WIDTH, |(_, width, _)| *width)
            },
            fill_color: TRANSPARENT.to_string(),
            opacity: style.as_ref().map_or(1., |(_, _, opacity)| *opacity),
            rotation: 0.,
            text: is_text.then(|| "Text".to_string()),
            mask_type: is_mask.then_some(MaskType::Pixelate),
            mask_level: is_mask.then_some(MASK_DEFAULT_LEVEL),
            points: (annotation_type == AnnotationType::Draw).then(|| vec![[x, y]]),
        };

        if is_mask {
            self.project.annotations.push(annotation.clone());
        }
        self.annotation_state.gesture = Some(Gesture::Create(Creating {
            temp: annotation,
            in_list: is_mask,
        }));
        cx.notify();
    }

    /// A drag move while the annotation layer owns the pointer.
    pub(crate) fn annotation_mouse_move(
        &mut self,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.annotation_state.gesture.is_none() {
            return false;
        }
        let Some(point) = self.frame_point(position) else {
            return false;
        };
        // `handleMouseMove` reads `e.shiftKey` off the event; gpui's drag layer
        // hands the position only, so the modifier comes off the window.
        let shift = window.modifiers().shift;
        let Some(gesture) = self.annotation_state.gesture.take() else {
            return false;
        };
        let gesture = match gesture {
            Gesture::Create(creating) => Gesture::Create(self.drag_create(creating, point, shift)),
            Gesture::Move(mut dragging) => {
                self.drag_move(&mut dragging, point);
                Gesture::Move(dragging)
            }
            Gesture::Resize(dragging) => {
                self.drag_resize(&dragging, point, shift);
                Gesture::Resize(dragging)
            }
        };
        self.annotation_state.gesture = Some(gesture);
        self.refresh_mask_overlays(window, cx);
        cx.notify();
        true
    }

    /// `handleMouseMove`'s drawing branch (`:245-320`).
    fn drag_create(&mut self, mut creating: Creating, point: (f64, f64), shift: bool) -> Creating {
        let temp = &mut creating.temp;
        if temp.annotation_type == AnnotationType::Text {
            return creating;
        }

        if temp.annotation_type == AnnotationType::Draw {
            let points = temp.points.get_or_insert_with(Vec::new);
            let last = points.last().copied().unwrap_or([temp.x, temp.y]);
            let (dx, dy) = (point.0 - last[0], point.1 - last[1]);
            // A 2px floor on the sample spacing (`:254`).
            if dx * dx + dy * dy < 4. {
                return creating;
            }
            points.push([point.0, point.1]);
            let (mut min_x, mut min_y) = (f64::INFINITY, f64::INFINITY);
            let (mut max_x, mut max_y) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
            for sample in points.iter() {
                min_x = min_x.min(sample[0]);
                min_y = min_y.min(sample[1]);
                max_x = max_x.max(sample[0]);
                max_y = max_y.max(sample[1]);
            }
            temp.x = min_x;
            temp.y = min_y;
            temp.width = max_x - min_x;
            temp.height = max_y - min_y;
            return creating;
        }

        let is_mask = temp.annotation_type == AnnotationType::Mask;
        let rect = self.annotation_image_rect();
        let (current_x, current_y) = if is_mask {
            (
                clamp_value(point.0, rect.x, rect.x + rect.width),
                clamp_value(point.1, rect.y, rect.y + rect.height),
            )
        } else {
            point
        };

        let mut width = current_x - temp.x;
        let mut height = current_y - temp.y;

        if temp.annotation_type == AnnotationType::Circle && !shift {
            let size = width.abs().max(height.abs());
            width = if width < 0. { -size } else { size };
            height = if height < 0. { -size } else { size };
        } else if shift {
            match temp.annotation_type {
                AnnotationType::Rectangle | AnnotationType::Mask => {
                    let size = width.abs().max(height.abs());
                    width = if width < 0. { -size } else { size };
                    height = if height < 0. { -size } else { size };
                }
                AnnotationType::Arrow => {
                    let quarter = std::f64::consts::FRAC_PI_4;
                    let snapped = (height.atan2(width) / quarter).round() * quarter;
                    let distance = (width * width + height * height).sqrt();
                    width = snapped.cos() * distance;
                    height = snapped.sin() * distance;
                }
                _ => {}
            }
        }

        temp.width = width;
        temp.height = height;

        if creating.in_list {
            let temp = creating.temp.clone();
            if let Some(live) = self.annotation_mut(&temp.id) {
                *live = temp;
            }
        }
        creating
    }

    /// `dragState.action === "move"` (`:328-354`).
    fn drag_move(&mut self, dragging: &mut Dragging, point: (f64, f64)) {
        let (dx, dy) = (point.0 - dragging.start.0, point.1 - dragging.start.1);
        // The editor canvas's promote threshold (`editor_canvas.rs`, the
        // source's `if (!state.moved && Math.hypot(...) < 2)`): a click with a
        // wobble in it selects, it does not nudge. 2 screen px, in frame units
        // at the scale in force; sticky once crossed so the shape does not
        // snap home when a real drag passes back over its origin.
        if !dragging.moved {
            let threshold = 2. / self.annotation_scale().unwrap_or(1.).max(0.001) as f64;
            if dx.hypot(dy) < threshold {
                return;
            }
            dragging.moved = true;
        }
        let rect = self.annotation_image_rect();
        let Some(annotation) = self.annotation_mut(&dragging.id) else {
            return;
        };
        if annotation.annotation_type == AnnotationType::Mask {
            annotation.x = clamp_value(
                dragging.original.x + dx,
                rect.x,
                rect.x + rect.width - annotation.width,
            );
            annotation.y = clamp_value(
                dragging.original.y + dy,
                rect.y,
                rect.y + rect.height - annotation.height,
            );
            return;
        }
        annotation.x = dragging.original.x + dx;
        annotation.y = dragging.original.y + dy;
    }

    /// `dragState.action === "resize"` (`:355-432`), handle by handle.
    fn drag_resize(&mut self, dragging: &Dragging, point: (f64, f64), shift: bool) {
        let Some(handle) = dragging.handle else {
            return;
        };
        let (dx, dy) = (point.0 - dragging.start.0, point.1 - dragging.start.1);
        let original = &dragging.original;
        let mut x = original.x;
        let mut y = original.y;
        let mut width = original.width;
        let mut height = original.height;

        if original.annotation_type == AnnotationType::Arrow {
            match handle {
                Handle::Start => {
                    x = original.x + dx;
                    y = original.y + dy;
                    width = original.width - dx;
                    height = original.height - dy;
                }
                Handle::End => {
                    width = original.width + dx;
                    height = original.height + dy;
                }
                _ => {}
            }
        } else {
            if handle.east() {
                width = original.width + dx;
            }
            if handle.south() {
                height = original.height + dy;
            }
            if handle.west() {
                x = original.x + dx;
                width = original.width - dx;
            }
            if handle.north() {
                y = original.y + dy;
                height = original.height - dy;
            }

            // A circle is square unless shift says otherwise; a rectangle is
            // square only while shift is held (`:386-405`).
            let constrain = (original.annotation_type == AnnotationType::Circle && !shift)
                || (original.annotation_type == AnnotationType::Rectangle && shift);
            if constrain {
                let size = width.abs().max(height.abs());
                let sign_width = if width < 0. { -1. } else { 1. };
                let sign_height = if height < 0. { -1. } else { 1. };
                if handle.west() {
                    x = original.x + original.width - sign_width * size;
                }
                if handle.north() {
                    y = original.y + original.height - sign_height * size;
                }
                width = sign_width * size;
                height = sign_height * size;
            }
        }

        if original.annotation_type == AnnotationType::Mask {
            let rect = self.annotation_image_rect();
            let (right_edge, bottom_edge) = (rect.x + rect.width, rect.y + rect.height);
            let left = clamp_value(x.min(x + width), rect.x, right_edge);
            let right = clamp_value(x.max(x + width), rect.x, right_edge);
            let top = clamp_value(y.min(y + height), rect.y, bottom_edge);
            let bottom = clamp_value(y.max(y + height), rect.y, bottom_edge);
            x = left;
            y = top;
            width = (right - left).max(0.);
            height = (bottom - top).max(0.);
        }

        if let Some(annotation) = self.annotation_mut(&dragging.id) {
            annotation.x = x;
            annotation.y = y;
            annotation.width = width;
            annotation.height = height;
        }
    }

    /// The release that ends an annotation drag -- `handleMouseUp`
    /// (`:437-566`).
    pub(crate) fn annotation_mouse_up(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(gesture) = self.annotation_state.gesture.take() else {
            return false;
        };
        match gesture {
            Gesture::Create(creating) => self.finish_create(creating, window, cx),
            Gesture::Move(dragging) | Gesture::Resize(dragging) => {
                self.finish_drag(dragging, window, cx)
            }
        }
        true
    }

    fn finish_create(&mut self, creating: Creating, window: &mut Window, cx: &mut Context<Self>) {
        let mut annotation = creating.temp;

        if annotation.annotation_type == AnnotationType::Draw {
            let raw = annotation.points.clone().unwrap_or_default();
            // A tap is not a stroke (`:443-448`).
            if raw.len() < 2 {
                cx.notify();
                return;
            }
            annotation.points = Some(normalize_draw_points(
                &raw,
                annotation.x,
                annotation.y,
                annotation.width,
                annotation.height,
            ));
            self.selected_annotation = Some(annotation.id.clone());
            self.project.annotations.push(annotation);
            // The draw branch returns before `setActiveTool("select")`, so the
            // pencil stays armed for the next stroke (`:460`).
            self.commit_annotations(window, cx);
            return;
        }

        if matches!(
            annotation.annotation_type,
            AnnotationType::Rectangle | AnnotationType::Circle | AnnotationType::Mask
        ) {
            if annotation.width < 0. {
                annotation.x += annotation.width;
                annotation.width = annotation.width.abs();
            }
            if annotation.height < 0. {
                annotation.y += annotation.height;
                annotation.height = annotation.height.abs();
            }
            if annotation.annotation_type == AnnotationType::Mask {
                let rect = self.annotation_image_rect();
                let (right_edge, bottom_edge) = (rect.x + rect.width, rect.y + rect.height);
                let left = clamp_value(annotation.x, rect.x, right_edge);
                let top = clamp_value(annotation.y, rect.y, bottom_edge);
                let right = clamp_value(annotation.x + annotation.width, rect.x, right_edge);
                let bottom = clamp_value(annotation.y + annotation.height, rect.y, bottom_edge);
                annotation.x = left;
                annotation.y = top;
                annotation.width = (right - left).max(0.);
                annotation.height = (bottom - top).max(0.);
            }
            // A click that never became a drag draws nothing, and records
            // nothing (`:498-506`).
            if annotation.width < MIN_SIZE && annotation.height < MIN_SIZE {
                if creating.in_list {
                    self.project
                        .annotations
                        .retain(|live| live.id != annotation.id);
                    self.refresh_mask_overlays(window, cx);
                }
                cx.notify();
                return;
            }
        }

        let id = annotation.id.clone();
        let is_text = annotation.annotation_type == AnnotationType::Text;
        if creating.in_list {
            if let Some(live) = self.annotation_mut(&id) {
                *live = annotation;
            }
        } else {
            self.project.annotations.push(annotation);
        }
        self.tool = Tool::Select;
        self.selected_annotation = Some(id.clone());
        self.commit_annotations(window, cx);

        if is_text {
            self.begin_text_edit(id, window, cx);
        }
    }

    fn finish_drag(&mut self, dragging: Dragging, window: &mut Window, cx: &mut Context<Self>) {
        // A stroke dragged inside out keeps its samples by mirroring them
        // (`:531-558`).
        if dragging.handle.is_some()
            && let Some(annotation) = self.annotation_mut(&dragging.id)
            && annotation.annotation_type == AnnotationType::Draw
            && (annotation.width < 0. || annotation.height < 0.)
        {
            let flip_x = annotation.width < 0.;
            let flip_y = annotation.height < 0.;
            if flip_x {
                annotation.x += annotation.width;
            }
            if flip_y {
                annotation.y += annotation.height;
            }
            annotation.width = annotation.width.abs();
            annotation.height = annotation.height.abs();
            if let Some(points) = annotation.points.as_deref() {
                annotation.points = Some(flip_draw_points(points, flip_x, flip_y));
            }
        }

        let moved = self
            .annotation(&dragging.id)
            .is_some_and(|annotation| geometry_changed(&dragging.original, annotation));
        if moved {
            self.commit_annotations(window, cx);
        } else {
            cx.notify();
        }
    }

    /// The text hover wash and the resize cursors, which the SVG gets from
    /// `:641-647` and `cursor={...}` and gpui has to track itself.
    fn annotation_hover(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.annotation_state.gesture.is_some() {
            return;
        }
        if self.tool != Tool::Select {
            self.clear_annotation_hover(cx);
            return;
        }
        let Some(point) = self.frame_point(event.position) else {
            return;
        };
        let handle_size = self.handle_size();
        let cursor = self
            .selected()
            .and_then(|annotation| hit_handle(annotation, point, handle_size))
            .map(Handle::cursor);
        let hover = self
            .hit_test_measured(point, handle_size, window)
            .map(|index| self.project.annotations[index].id.clone());
        if hover != self.annotation_state.hover || cursor != self.annotation_state.hover_cursor {
            self.annotation_state.hover = hover;
            self.annotation_state.hover_cursor = cursor;
            cx.notify();
        }
    }

    fn clear_annotation_hover(&mut self, cx: &mut Context<Self>) {
        if self.annotation_state.hover.take().is_some()
            || self.annotation_state.hover_cursor.take().is_some()
        {
            cx.notify();
        }
    }

    // -- Clipboard ------------------------------------------------------------

    /// `Editor.tsx:72-81` -- Cmd-C over a selected annotation copies it instead
    /// of exporting the screenshot.
    pub(crate) fn copy_selected_annotation(&mut self, _cx: &mut Context<Self>) -> bool {
        let Some(annotation) = self.selected().cloned() else {
            return false;
        };
        self.annotation_state.clipboard = Some(annotation);
        true
    }

    /// `Editor.tsx:83-101` -- Cmd-V drops the copy 16px down and right, selects
    /// it, and copies *it* in turn so a held Cmd-V cascades.
    pub(crate) fn paste_annotation(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(source) = self.annotation_state.clipboard.clone() else {
            return false;
        };
        let mut duplicate = source;
        duplicate.id = crate::store::new_uuid_v4();
        duplicate.x += 16.;
        duplicate.y += 16.;
        self.annotation_state.clipboard = Some(duplicate.clone());
        self.selected_annotation = Some(duplicate.id.clone());
        self.project.annotations.push(duplicate);
        self.tool = Tool::Select;
        self.commit_annotations(window, cx);
        true
    }

    /// Backspace / Delete over a selection (`AnnotationLayer.tsx:72-86`), which
    /// the open text editor swallows.
    pub(crate) fn delete_selected_annotation(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.annotation_state.editing.is_some() {
            return;
        }
        let Some(id) = self.selected_annotation.take() else {
            return;
        };
        let before = self.project.annotations.len();
        self.project
            .annotations
            .retain(|annotation| annotation.id != id);
        if self.project.annotations.len() == before {
            cx.notify();
            return;
        }
        self.annotation_state.reorder = None;
        self.commit_annotations(window, cx);
    }

    // -- Inline text ----------------------------------------------------------

    /// The `foreignObject` editor (`:661-722`): transparent, at the
    /// annotation's own font size, focused and fully selected on open.
    fn begin_text_edit(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(original) = self
            .annotation(&id)
            .map(|annotation| annotation.text.clone().unwrap_or_default())
        else {
            return;
        };
        let Some(input) = self.annotation_state.text_input.clone() else {
            return;
        };
        input.update(cx, |input, cx| {
            input.set_text(original.clone(), cx);
            input.select_all_text(cx);
        });
        // The double-click that opens the editor is still mid-dispatch, and
        // the root's `track_focus` click-to-focus runs *after* this listener:
        // focusing here would be stolen right back, leaving a field that
        // paints a selection but hears no keys (Escape and typing fall
        // through to the window's shortcut handler). Focus once the event
        // settles instead.
        let focus = input.read(cx).focus_handle();
        window.defer(cx, move |window, cx| {
            window.focus(&focus, cx);
        });
        self.annotation_state.editing = Some(TextEdit { id, original });
        cx.notify();
    }

    fn on_annotation_text_event(
        &mut self,
        event: &ui::TextInputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            // `onInput` (`:690-693`): the annotation follows the field live, so
            // the box the handles wrap keeps up. No history, no save -- the
            // commit does both.
            ui::TextInputEvent::Changed => {
                let Some(id) = self
                    .annotation_state
                    .editing
                    .as_ref()
                    .map(|edit| edit.id.clone())
                else {
                    return;
                };
                let Some(text) = self
                    .annotation_state
                    .text_input
                    .as_ref()
                    .map(|input| input.read(cx).text().to_string())
                else {
                    return;
                };
                if let Some(annotation) = self.annotation_mut(&id) {
                    annotation.text = Some(text);
                }
                cx.notify();
            }
            // Enter and blur both commit (`:694-720`). Escape has no meaning in
            // a `contentEditable`; the nearest thing here is the same commit.
            ui::TextInputEvent::Confirmed
            | ui::TextInputEvent::Cancelled
            | ui::TextInputEvent::Blurred => self.commit_text_edit(window, cx),
        }
    }

    /// `onBlur` (`:694-713`): empty text deletes the annotation, and history
    /// only records when the text actually moved.
    fn commit_text_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(edit) = self.annotation_state.editing.take() else {
            return;
        };
        let text = self
            .annotation_state
            .text_input
            .as_ref()
            .map(|input| input.read(cx).text().to_string())
            .unwrap_or_default();

        if text.trim().is_empty() {
            self.project
                .annotations
                .retain(|annotation| annotation.id != edit.id);
            if self.selected_annotation.as_deref() == Some(edit.id.as_str()) {
                self.selected_annotation = None;
            }
            self.commit_annotations(window, cx);
        } else if text != edit.original {
            if let Some(annotation) = self.annotation_mut(&edit.id) {
                annotation.text = Some(text);
            }
            self.commit_annotations(window, cx);
        } else {
            cx.notify();
        }

        let focus = self.focus.clone();
        window.focus(&focus, cx);
    }

    /// Where the editor sits on screen, so a press can tell "inside the field"
    /// from "outside it".
    fn text_editor_bounds(&self) -> Option<Bounds<Pixels>> {
        let edit = self.annotation_state.editing.as_ref()?;
        let annotation = self.annotation(&edit.id)?;
        let bounds = self.annotation_state.layer.get()?;
        let scale = self.annotation_scale()?;
        Some(Bounds {
            origin: gpui::point(
                bounds.origin.x + px(annotation.x as f32 * scale),
                bounds.origin.y + px(annotation.y as f32 * scale),
            ),
            size: gpui::size(
                px((annotation.width.abs() as f32 * scale).max(100.)),
                px((annotation.height as f32 * scale).max(16.)),
            ),
        })
    }

    // -- Mask overlays ---------------------------------------------------------

    /// What the painted overlays were computed from: the frame, the image rect,
    /// and every mask's geometry and style.
    fn mask_key(&self) -> u64 {
        let mut hasher = std::hash::DefaultHasher::new();
        match &self.frame_rgba {
            Some(rgba) => {
                (Arc::as_ptr(rgba) as usize).hash(&mut hasher);
                rgba.len().hash(&mut hasher);
            }
            None => 0usize.hash(&mut hasher),
        }
        self.frame_size.0.to_bits().hash(&mut hasher);
        self.frame_size.1.to_bits().hash(&mut hasher);
        let rect = self.annotation_image_rect();
        for value in [rect.x, rect.y, rect.width, rect.height] {
            value.to_bits().hash(&mut hasher);
        }
        for annotation in &self.project.annotations {
            if annotation.annotation_type != AnnotationType::Mask {
                continue;
            }
            annotation.id.hash(&mut hasher);
            for value in [
                annotation.x,
                annotation.y,
                annotation.width,
                annotation.height,
                annotation.mask_level.unwrap_or(MASK_FALLBACK_LEVEL),
            ] {
                value.to_bits().hash(&mut hasher);
            }
            matches!(annotation.mask_type, Some(MaskType::Pixelate)).hash(&mut hasher);
        }
        hasher.finish()
    }

    /// `renderMaskOverlays` (`Preview.tsx:579-687`), off the main thread. The
    /// stale overlay keeps painting until the new one lands, so a drag never
    /// blocks on a resample.
    pub(crate) fn refresh_mask_overlays(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let key = self.mask_key();
        if self.annotation_state.mask_key == key || self.annotation_state.mask_pending == Some(key)
        {
            return;
        }

        let masks: Vec<Annotation> = self
            .project
            .annotations
            .iter()
            .filter(|annotation| annotation.annotation_type == AnnotationType::Mask)
            .cloned()
            .collect();
        let frame = self.frame_rgba.clone();

        let (Some(rgba), false) = (frame, masks.is_empty()) else {
            self.drop_mask_overlays(window);
            // Dropping the task matters as much as dropping the tiles: a
            // resample still in flight would re-install the regions of a mask
            // that has just been deleted, and stamp its key over this one.
            self.annotation_state.mask_task = None;
            self.annotation_state.mask_key = key;
            self.annotation_state.mask_pending = None;
            cx.notify();
            return;
        };

        let size = (
            self.frame_size.0.max(0.) as u32,
            self.frame_size.1.max(0.) as u32,
        );
        let rect = self.annotation_image_rect();
        self.annotation_state.mask_pending = Some(key);
        self.annotation_state.mask_task = Some(cx.spawn_in(window, async move |this, cx| {
            let overlays = cx
                .background_executor()
                .spawn(async move { build_mask_overlays(&rgba, size, &masks, rect) })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.drop_mask_overlays(window);
                this.annotation_state.masks = overlays;
                this.annotation_state.mask_key = key;
                this.annotation_state.mask_pending = None;
                cx.notify();
                // The masks may have moved on while this was in flight.
                this.refresh_mask_overlays(window, cx);
            })
            .ok();
        }));
    }

    /// Hand the atlas back the tiles the old overlays held.
    fn drop_mask_overlays(&mut self, window: &mut Window) {
        for overlay in self.annotation_state.masks.drain(..) {
            let _ = window.drop_image(overlay.image);
        }
    }
}

impl ScreenshotEditorWindow {
    // -- The layer -------------------------------------------------------------

    /// `AnnotationLayer.tsx` -- the SVG overlay over the preview's content
    /// wrapper, as one canvas plus the inline text editor. `content` is the
    /// wrapper's on-screen size; the image rect the window passes is what the
    /// mask overlays were already clipped to, so the paint itself needs it no
    /// further.
    pub(crate) fn render_annotation_layer(
        &self,
        content: (f32, f32),
        _rect: Rect,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if self.frame_size.0 <= 0. || content.0 <= 0. {
            return None;
        }
        let scale = content.0 / self.frame_size.0;
        let temp = match &self.annotation_state.gesture {
            Some(Gesture::Create(creating)) if !creating.in_list => Some(creating.temp.clone()),
            _ => None,
        };
        let paint = LayerPaint {
            annotations: self.project.annotations.clone(),
            temp,
            masks: self.annotation_state.masks.clone(),
            selected: self.selected_annotation.clone(),
            editing: self
                .annotation_state
                .editing
                .as_ref()
                .map(|edit| edit.id.clone()),
            hover: self.annotation_state.hover.clone(),
            select_tool: self.tool == Tool::Select,
            scale,
            handle_size: HANDLE_SCREEN_SIZE / scale.max(0.001) as f64,
        };
        let cell = self.annotation_state.layer.clone();
        let drawing = self.tool != Tool::Select;
        let cursor = self.annotation_state.hover_cursor;

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .when(drawing, |this| this.cursor(CursorStyle::Crosshair))
                .when_some(cursor, |this, cursor| this.cursor(cursor))
                .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                    this.annotation_hover(event, window, cx);
                }))
                .child(
                    canvas(
                        move |bounds, _window, _cx| cell.set(Some(bounds)),
                        move |bounds, _, window, cx| paint_layer(&paint, bounds, window, cx),
                    )
                    .absolute()
                    .size_full(),
                )
                .children(self.render_text_editor(scale, cx))
                .into_any_element(),
        )
    }

    /// The `foreignObject` editor (`:662-722`): no chrome, the annotation's own
    /// font size and colour, sitting at the annotation's top-left the way the
    /// source's does -- which is a fifth of a line above the glyphs it replaces,
    /// because SVG anchors text on its baseline and HTML on its box.
    fn render_text_editor(&self, scale: f32, _cx: &mut Context<Self>) -> Option<AnyElement> {
        let edit = self.annotation_state.editing.as_ref()?;
        let annotation = self.annotation(&edit.id)?;
        let input = self.annotation_state.text_input.clone()?;
        let font_size = (annotation.height as f32 * scale).max(1.);
        let color = annotation_color(&annotation.stroke_color, 1.).unwrap_or(gpui::black());

        Some(
            div()
                .absolute()
                .left(px(annotation.x as f32 * scale))
                .top(px(annotation.y as f32 * scale))
                .w(px((annotation.width.abs() as f32 * scale).max(100.)))
                .child(
                    ui::TextInput::bare(&self.theme, "screenshot-annotation-text", &input)
                        .text_size(px(font_size))
                        .line_height(px(font_size))
                        .text_color(color)
                        .caret_color(color),
                )
                .into_any_element(),
        )
    }

    /// The drag layers and the colour popover, which have to hang off the
    /// window root rather than off the preview: a gesture outlives the element
    /// it started on, and a popover has to escape the config bar's 44px.
    pub(crate) fn render_annotation_overlays(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let mut layers = Vec::new();
        if self.annotation_state.gesture.is_some() {
            layers.push(
                ui::Slider::drag_layer(
                    "screenshot-annotation-drag",
                    cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                        this.annotation_mouse_move(event.position, window, cx);
                    }),
                    cx.listener(|this, _: &MouseUpEvent, window, cx| {
                        this.annotation_mouse_up(window, cx);
                    }),
                )
                .into_any_element(),
            );
        }
        if let Some(slider) = self.annotation_state.active_slider {
            layers.push(
                ui::Slider::drag_layer(
                    "screenshot-annotation-slider-drag",
                    cx.listener(move |this, event: &MouseMoveEvent, window, cx| {
                        this.apply_annotation_slider(slider, event.position, window, cx);
                    }),
                    cx.listener(|this, _: &MouseUpEvent, _window, cx| {
                        this.end_annotation_slider(cx);
                    }),
                )
                .into_any_element(),
            );
        }
        if self.annotation_state.reorder.is_some() {
            layers.push(
                ui::Slider::drag_layer(
                    "screenshot-layer-reorder-drag",
                    cx.listener(|this, event: &MouseMoveEvent, _window, cx| {
                        this.drag_reorder(event.position.y, cx);
                    }),
                    cx.listener(|this, _: &MouseUpEvent, window, cx| {
                        this.finish_reorder(window, cx);
                    }),
                )
                .into_any_element(),
            );
        }
        layers.extend(self.render_annotation_color_popover(window, cx));
        layers
    }

    // -- The config bar --------------------------------------------------------

    /// `AnnotationConfig.tsx:44-158` -- the per-type controls that sit left of
    /// the bar's Done button.
    pub(crate) fn render_annotation_config_controls(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let annotation = self.selected()?;
        let theme = self.theme;
        let kind = annotation.annotation_type;
        let is_mask = kind == AnnotationType::Mask;
        let is_text = kind == AnnotationType::Text;

        let mut row = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(24.));

        if !is_mask {
            row = row.child(config_item(
                &theme,
                if is_text { "Color" } else { "Stroke" },
                None,
                self.render_color_button(ColorTarget::Stroke, cx),
            ));
        }
        if !is_mask && !is_text {
            row = row.child(config_item(
                &theme,
                "Width",
                Some(format!("{}px", annotation.stroke_width.round() as i64)),
                self.annotation_slider(AnnotationSlider::Width, px(80.), cx)
                    .into_any_element(),
            ));
        }
        if matches!(kind, AnnotationType::Rectangle | AnnotationType::Circle) {
            row = row.child(config_item(
                &theme,
                "Fill",
                None,
                self.render_color_button(ColorTarget::Fill, cx),
            ));
        }
        if !is_mask {
            row = row.child(config_item(
                &theme,
                "Opacity",
                Some(format!("{}%", (annotation.opacity * 100.).round() as i64)),
                self.annotation_slider(AnnotationSlider::Opacity, px(80.), cx)
                    .into_any_element(),
            ));
        }
        if is_mask {
            let mask_type = annotation.mask_type.unwrap_or(MaskType::Blur);
            row = row
                .child(config_item(
                    &theme,
                    "Style",
                    None,
                    div()
                        .flex()
                        .flex_row()
                        .gap(px(4.))
                        .child(self.render_mask_pill("Blur", MaskType::Blur, mask_type, cx))
                        .child(self.render_mask_pill("Pixelate", MaskType::Pixelate, mask_type, cx))
                        .into_any_element(),
                ))
                .child(config_item(
                    &theme,
                    "Intensity",
                    Some(format!(
                        "{}",
                        annotation.mask_level.unwrap_or(MASK_FALLBACK_LEVEL).round() as i64
                    )),
                    self.annotation_slider(AnnotationSlider::MaskLevel, px(96.), cx)
                        .into_any_element(),
                ));
        }
        if is_text {
            row = row.child(config_item(
                &theme,
                "Size",
                Some(format!("{}px", annotation.height.round() as i64)),
                self.annotation_slider(AnnotationSlider::TextSize, px(80.), cx)
                    .into_any_element(),
            ));
        }

        Some(row.into_any_element())
    }

    /// The two `Style` pills (`AnnotationConfig.tsx:100-123`).
    fn render_mask_pill(
        &self,
        label: &'static str,
        value: MaskType,
        current: MaskType,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let active = value == current;
        div()
            .id(gpui::SharedString::from(format!(
                "screenshot-mask-style-{label}"
            )))
            .flex()
            .items_center()
            .justify_center()
            .h(px(24.))
            .px(px(10.))
            .rounded(px(6.))
            .cursor_pointer()
            .text_size(px(12.))
            .font_weight(FontWeight::MEDIUM)
            .when(active, |this| {
                this.bg(theme.blue_9).text_color(gpui::white())
            })
            .when(!active, |this| {
                this.bg(theme.gray_3)
                    .text_color(theme.gray_11)
                    .hover(|style| style.bg(theme.gray_4))
            })
            .child(label)
            .on_click(cx.listener(move |this, _, window, cx| {
                cx.stop_propagation();
                let Some(id) = this.selected_annotation.clone() else {
                    return;
                };
                this.edit_project(
                    move |project| {
                        let Some(annotation) = project
                            .annotations
                            .iter_mut()
                            .find(|annotation| annotation.id == id)
                        else {
                            return false;
                        };
                        if annotation.mask_type == Some(value) {
                            return false;
                        }
                        annotation.mask_type = Some(value);
                        true
                    },
                    window,
                    cx,
                );
                this.refresh_mask_overlays(window, cx);
            }))
            .into_any_element()
    }

    fn annotation_slider(
        &self,
        slider: AnnotationSlider,
        width: Pixels,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let (min, max, _) = slider.range();
        let value = self
            .selected()
            .map_or(min, |annotation| slider.value(annotation));
        let fraction = ((value - min) / (max - min).max(f32::EPSILON)).clamp(0., 1.);
        let track = self
            .annotation_state
            .slider_tracks
            .get(&slider)
            .cloned()
            .unwrap_or_default();

        ui::Slider::new(
            gpui::SharedString::from(format!("screenshot-annotation-slider-{}", slider.id())),
            fraction,
            track,
        )
        .row_width(width)
        .track(px(4.), theme.gray_4.into())
        .fill(theme.blue_9.into())
        .thumb(px(14.), gpui::white(), Some(theme.gray_6.into()))
        .on_drag_start(
            cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                cx.stop_propagation();
                this.begin_annotation_slider(slider, event.position, window, cx);
            }),
        )
    }

    /// The same bracket the styling sliders take (`ui/slider.rs`'s
    /// `SliderDrag`): one history entry for a whole drag.
    fn begin_annotation_slider(
        &mut self,
        slider: AnnotationSlider,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.annotation_state.active_slider.is_none() {
            self.history.pause();
        }
        self.annotation_state.active_slider = Some(slider);
        self.apply_annotation_slider(slider, position, window, cx);
        cx.notify();
    }

    fn apply_annotation_slider(
        &mut self,
        slider: AnnotationSlider,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let track = self
            .annotation_state
            .slider_tracks
            .get(&slider)
            .cloned()
            .unwrap_or_default();
        let (min, max, step) = slider.range();
        let Some(value) = ui::slider_value_at(&track, position, min, max, step) else {
            return;
        };
        let Some(id) = self.selected_annotation.clone() else {
            return;
        };
        self.edit_project(
            move |project| {
                project
                    .annotations
                    .iter_mut()
                    .find(|annotation| annotation.id == id)
                    .is_some_and(|annotation| slider.apply(annotation, value))
            },
            window,
            cx,
        );
        if slider == AnnotationSlider::MaskLevel {
            self.refresh_mask_overlays(window, cx);
        }
    }

    fn end_annotation_slider(&mut self, cx: &mut Context<Self>) {
        if self.annotation_state.active_slider.take().is_some() {
            self.history.resume(&self.project);
        }
        cx.notify();
    }

    // -- The colour popover ----------------------------------------------------

    fn annotation_color_value(&self, target: ColorTarget) -> Option<String> {
        let annotation = self.selected()?;
        Some(match target {
            ColorTarget::Stroke => annotation.stroke_color.clone(),
            ColorTarget::Fill => annotation.fill_color.clone(),
        })
    }

    fn set_annotation_color(
        &mut self,
        target: ColorTarget,
        value: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.selected_annotation.clone() else {
            return;
        };
        self.edit_project(
            move |project| {
                let Some(annotation) = project
                    .annotations
                    .iter_mut()
                    .find(|annotation| annotation.id == id)
                else {
                    return false;
                };
                let field = match target {
                    ColorTarget::Stroke => &mut annotation.stroke_color,
                    ColorTarget::Fill => &mut annotation.fill_color,
                };
                if *field == value {
                    return false;
                }
                *field = value;
                true
            },
            window,
            cx,
        );
    }

    /// `Popover.Trigger`'s `size-5 rounded-full` swatch
    /// (`AnnotationConfig.tsx:212-225`).
    fn render_color_button(&self, target: ColorTarget, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let value = self.annotation_color_value(target).unwrap_or_default();
        let transparent = annotation_color(&value, 1.).is_none();
        let cell = self
            .annotation_state
            .color_anchors
            .get(&target)
            .cloned()
            .unwrap_or_default();

        div()
            .relative()
            .flex_shrink_0()
            .size(px(20.))
            .child(
                canvas(
                    move |bounds, _window, _cx| cell.set(Some(bounds)),
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .child(
                div()
                    .id(target.id())
                    .size(px(20.))
                    .rounded_full()
                    .overflow_hidden()
                    .cursor_pointer()
                    .border_1()
                    .border_color(theme.gray_5)
                    .hover(|style| style.border_color(theme.gray_7))
                    .when(transparent, |this| this.children(checker_quarters(20.)))
                    .when(!transparent, |this| {
                        this.bg(annotation_color(&value, 1.).unwrap_or(gpui::transparent_black()))
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.toggle_color_popover(target, window, cx);
                    })),
            )
            .into_any_element()
    }

    fn toggle_color_popover(
        &mut self,
        target: ColorTarget,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.selected_annotation.clone() else {
            return;
        };
        let open = self
            .annotation_state
            .color_popover
            .as_ref()
            .is_some_and(|(open, open_id)| *open == target && open_id == &id);
        self.annotation_state.color_popover = if open {
            None
        } else {
            let focus = self.focus.clone();
            window.focus(&focus, cx);
            Some((target, id))
        };
        cx.notify();
    }

    /// `Popover.Content` (`AnnotationConfig.tsx:227-274`): the hex field over a
    /// six-column palette, anchored under its swatch.
    fn render_annotation_color_popover(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let (target, id) = self.annotation_state.color_popover.clone()?;
        if self.selected_annotation.as_deref() != Some(id.as_str()) {
            return None;
        }
        let value = self.annotation_color_value(target)?;
        let theme = self.theme;
        let width = 220.;
        let viewport = window.viewport_size();
        let anchor = self
            .annotation_state
            .color_anchors
            .get(&target)
            .and_then(|cell| cell.get());
        let left = anchor
            .map(|bounds| f32::from(bounds.origin.x + bounds.size.width / 2.) - width / 2.)
            .unwrap_or(16.)
            .clamp(8., (f32::from(viewport.width) - width - 8.).max(8.));
        let top = anchor
            .map(|bounds| f32::from(bounds.origin.y + bounds.size.height) + 8.)
            .unwrap_or(120.);
        // `grid-cols-6 gap-1.5` inside `w-[220px] p-2.5`: six equal columns of
        // the 200px content box, each centring a `size-5` swatch.
        // Rounded down so six columns plus their gaps can never round past the
        // content box and wrap the sixth swatch onto its own row.
        let cell_width = ((width - 20. - 5. * 6.) / 6.).floor();

        let mut palette: Vec<AnyElement> = Vec::new();
        if target.allows_transparent() {
            let selected = annotation_color(&value, 1.).is_none();
            palette.push(
                div()
                    .w(px(cell_width))
                    .flex()
                    .justify_center()
                    .child(
                        div()
                            .id("screenshot-annotation-swatch-transparent")
                            .size(px(20.))
                            .rounded_full()
                            .overflow_hidden()
                            .cursor_pointer()
                            .border_1()
                            .border_color(if selected { theme.blue_9 } else { theme.gray_4 })
                            .when(selected, |this| this.border_2())
                            .children(checker_quarters(20.))
                            .tooltip(move |_window, cx| {
                                ui::Tooltip::new(&theme, "Transparent").view(cx)
                            })
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.set_annotation_color(
                                    target,
                                    TRANSPARENT.to_string(),
                                    window,
                                    cx,
                                );
                            })),
                    )
                    .into_any_element(),
            );
        }
        for (index, hex) in BACKGROUND_COLORS
            .iter()
            .filter(|hex| **hex != "#00000000")
            .enumerate()
        {
            let hex = *hex;
            let selected = value.eq_ignore_ascii_case(hex);
            palette.push(
                div()
                    .w(px(cell_width))
                    .flex()
                    .justify_center()
                    .child(
                        div()
                            .id(("screenshot-annotation-swatch", index))
                            .size(px(20.))
                            .rounded_full()
                            .cursor_pointer()
                            .border_1()
                            .border_color(Theme::with_alpha(gpui::rgb(0x000000), 0.1))
                            .when(selected, |this| {
                                this.border_2()
                                    .border_color(Theme::with_alpha(gpui::rgb(0xffffff), 0.5))
                            })
                            .bg(annotation_color(hex, 1.).unwrap_or(gpui::transparent_black()))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.set_annotation_color(target, hex.to_string(), window, cx);
                            })),
                    )
                    .into_any_element(),
            );
        }

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("screenshot-annotation-color-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.annotation_state.color_popover = None;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .absolute()
                        .left(px(left))
                        .top(px(top))
                        .w(px(width))
                        .p(px(10.))
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .rounded(px(8.))
                        .border_1()
                        .border_color(theme.gray_4)
                        .bg(if theme.is_dark() {
                            theme.gray_2
                        } else {
                            theme.gray_1
                        })
                        .shadow(vec![gpui::BoxShadow {
                            color: Theme::with_alpha(gpui::rgb(0x000000), 0.18),
                            offset: gpui::point(px(0.), px(8.)),
                            blur_radius: px(24.),
                            spread_radius: px(0.),
                            inset: false,
                        }])
                        .child(
                            // `RgbInput` (`ColorPicker.tsx:47-102`).
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(12.))
                                .child(
                                    div()
                                        .size(px(32.))
                                        .rounded(px(8.))
                                        .overflow_hidden()
                                        .border_1()
                                        .border_color(theme.gray_4)
                                        .when(annotation_color(&value, 1.).is_none(), |this| {
                                            this.children(checker_quarters(32.))
                                        })
                                        .when_some(annotation_color(&value, 1.), |this, color| {
                                            this.bg(color)
                                        }),
                                )
                                .children(self.annotation_state.color_inputs.get(&target).map(
                                    |input| {
                                        ui::TextInput::plain(
                                            &theme,
                                            match target {
                                                ColorTarget::Stroke => {
                                                    "screenshot-annotation-hex-stroke"
                                                }
                                                ColorTarget::Fill => {
                                                    "screenshot-annotation-hex-fill"
                                                }
                                            },
                                            input,
                                        )
                                        .width(px(73.6))
                                        .padding_x(px(6.))
                                        .height(px(30.))
                                        .radius(px(8.))
                                        .text_size(px(13.))
                                    },
                                )),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .flex_wrap()
                                .gap(px(6.))
                                .children(palette),
                        ),
                )
                .into_any_element(),
        )
    }

    /// The hex field re-derives from the colour whenever it moves underneath,
    /// but never while it has focus -- the same rule `sync_hex_inputs` follows
    /// for the styling popovers.
    pub(crate) fn sync_annotation_inputs(&mut self, window: &Window, cx: &mut Context<Self>) {
        // A popover left open by a selection that has moved on is closed, not
        // repointed: its swatch belongs to an annotation that is no longer
        // under the bar.
        if let Some((_, id)) = &self.annotation_state.color_popover
            && self.selected_annotation.as_deref() != Some(id.as_str())
        {
            self.annotation_state.color_popover = None;
        }
        for target in ColorTarget::ALL {
            let Some(input) = self.annotation_state.color_inputs.get(&target).cloned() else {
                continue;
            };
            if input.read(cx).focus_handle().is_focused(window) {
                continue;
            }
            let Some(value) = self.annotation_color_value(target) else {
                continue;
            };
            // `rgbValue()` reads `transparent` as black rather than as an
            // empty field (`AnnotationConfig.tsx:200-206`).
            let hex = match hex_to_rgb(&value) {
                Some(rgba) => format!("#{:02X}{:02X}{:02X}", rgba[0], rgba[1], rgba[2]),
                None => "#000000".to_string(),
            };
            if input.read(cx).text() != hex {
                input.update(cx, |input, cx| input.set_text(hex, cx));
            }
        }
    }

    /// `RgbInput`'s handlers: a complete 6- or 8-digit value commits live, and
    /// Enter or blur commits whatever is in the box.
    fn on_annotation_color_event(
        &mut self,
        target: ColorTarget,
        event: &ui::TextInputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(input) = self.annotation_state.color_inputs.get(&target).cloned() else {
            return;
        };
        let text = input.read(cx).text().trim().to_string();
        match event {
            ui::TextInputEvent::Changed => {
                let digits = hex_digit_count(&text);
                if digits != 6 && digits != 8 {
                    return;
                }
            }
            ui::TextInputEvent::Confirmed | ui::TextInputEvent::Cancelled => {
                let focus = self.focus.clone();
                window.focus(&focus, cx);
            }
            ui::TextInputEvent::Blurred => {}
        }
        let Some(rgba) = hex_to_rgb(&text) else {
            return;
        };
        let hex = format!("#{:02X}{:02X}{:02X}", rgba[0], rgba[1], rgba[2]);
        if self.annotation_color_value(target).as_deref() != Some(hex.as_str()) {
            self.set_annotation_color(target, hex, window, cx);
        }
    }

    // -- The layers panel ------------------------------------------------------

    /// `LayersPanel.tsx:218-318`: the reversed list, one grip-dragged row each.
    pub(crate) fn render_layer_rows(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;

        if self.project.annotations.is_empty() {
            return div()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .h_full()
                .px(px(16.))
                .child(
                    svg()
                        .path("icons/layers.svg")
                        .size(px(32.))
                        .mb(px(8.))
                        .text_color(theme.gray_7),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(theme.gray_10)
                        .child("No layers yet"),
                )
                .child(
                    div()
                        .mt(px(4.))
                        .text_size(px(10.))
                        .text_color(theme.gray_8)
                        .child("Use the tools above to add annotations"),
                )
                .into_any_element();
        }

        let dragged = self
            .annotation_state
            .reorder
            .as_ref()
            .map(|reorder| reorder.id.clone());
        // The rule is drawn only where the drop would actually move the row:
        // the source hides it in the dragged row's own two gaps
        // (`LayersPanel.tsx:236-250`), which are exactly the drops
        // `reorder_move` rejects.
        let target = self.annotation_state.reorder.as_ref().and_then(|reorder| {
            let target = reorder.target?;
            let dragged_reversed = self
                .project
                .annotations
                .iter()
                .rev()
                .position(|annotation| annotation.id == reorder.id)?;
            reorder_move(self.project.annotations.len(), dragged_reversed, target).map(|_| target)
        });
        let cell = self.annotation_state.list.clone();

        // `reversedAnnotations()` -- the top of the list is the front of the
        // stack (`LayersPanel.tsx:62`).
        div()
            .relative()
            .flex()
            .flex_col()
            .child(
                canvas(
                    move |bounds, _window, _cx| cell.set(Some(bounds)),
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .children(
                self.project
                    .annotations
                    .iter()
                    .rev()
                    .enumerate()
                    .map(|(reversed, annotation)| {
                        self.render_layer_row(reversed, annotation, dragged.as_deref(), cx)
                    })
                    .collect::<Vec<_>>(),
            )
            .children(target.map(|target| {
                // A 2px rule in the gap the row would land in. Absolute, so the
                // rows do not shuffle underneath the pointer mid-drag.
                div()
                    .absolute()
                    .left(px(8.))
                    .right(px(8.))
                    .top(px(target as f32 * LAYER_ROW_HEIGHT - 1.))
                    .h(px(2.))
                    .rounded_full()
                    .bg(theme.blue_9)
            }))
            .into_any_element()
    }

    fn render_layer_row(
        &self,
        reversed: usize,
        annotation: &Annotation,
        dragged: Option<&str>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let id = annotation.id.clone();
        let selected = self.selected_annotation.as_deref() == Some(annotation.id.as_str());
        let dragging = dragged == Some(annotation.id.as_str());
        let delete_id = id.clone();
        let grip_id = id.clone();

        div()
            .id(("screenshot-layer-row", reversed))
            .group("screenshot-layer-row")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .h(px(LAYER_ROW_HEIGHT))
            .px(px(8.))
            .mx(px(4.))
            .rounded(px(6.))
            .cursor_pointer()
            .when(dragging, |this| this.opacity(0.5).bg(theme.gray_3))
            .when(selected && !dragging, |this| this.bg(theme.blue_3))
            .when(!selected && !dragging, |this| {
                this.hover(|style| style.bg(theme.gray_3))
            })
            .child(
                div()
                    .id(("screenshot-layer-grip", reversed))
                    .flex()
                    .items_center()
                    .justify_center()
                    .flex_shrink_0()
                    .cursor(CursorStyle::OpenHand)
                    .text_color(theme.gray_8)
                    .hover(|style| style.text_color(theme.gray_11))
                    .child(svg().path("icons/grip-vertical.svg").size(px(14.)))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _: &MouseDownEvent, _window, cx| {
                            cx.stop_propagation();
                            this.begin_reorder(grip_id.clone(), cx);
                        }),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(24.))
                    .flex_shrink_0()
                    .rounded(px(4.))
                    .bg(if selected { theme.blue_5 } else { theme.gray_3 })
                    .child(
                        svg()
                            .path(annotation_icon(annotation.annotation_type))
                            .size(px(14.))
                            .text_color(if selected {
                                theme.blue_11
                            } else {
                                theme.gray_11
                            }),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.))
                    .text_color(if selected {
                        theme.blue_12
                    } else {
                        theme.gray_12
                    })
                    .child(layer_label(annotation)),
            )
            .child(
                div()
                    .id(("screenshot-layer-delete", reversed))
                    .flex()
                    .items_center()
                    .justify_center()
                    .flex_shrink_0()
                    .p(px(2.))
                    .rounded(px(4.))
                    .cursor_pointer()
                    .opacity(0.)
                    .text_color(theme.gray_9)
                    .group_hover("screenshot-layer-row", |style| style.opacity(1.))
                    .hover(|style| style.bg(theme.red_3).text_color(theme.red_11))
                    .child(svg().path("icons/x.svg").size(px(12.)))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.delete_annotation(&delete_id, window, cx);
                    })),
            )
            .on_click(cx.listener(move |this, _, _window, cx| {
                cx.stop_propagation();
                this.selected_annotation = Some(id.clone());
                this.tool = Tool::Select;
                cx.notify();
            }))
            .into_any_element()
    }

    /// `handleDelete` (`LayersPanel.tsx:183-190`).
    fn delete_annotation(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let before = self.project.annotations.len();
        self.project
            .annotations
            .retain(|annotation| annotation.id != id);
        if self.project.annotations.len() == before {
            return;
        }
        if self.selected_annotation.as_deref() == Some(id) {
            self.selected_annotation = None;
        }
        // Deleting the row that is being edited has to close the editor too, or
        // `editing` outlives its annotation and swallows the delete key.
        if self
            .annotation_state
            .editing
            .as_ref()
            .is_some_and(|edit| edit.id == id)
        {
            self.annotation_state.editing = None;
        }
        self.annotation_state.reorder = None;
        self.commit_annotations(window, cx);
    }

    fn begin_reorder(&mut self, id: String, cx: &mut Context<Self>) {
        self.annotation_state.reorder = Some(Reorder {
            id,
            target: None,
            count: self.project.annotations.len(),
        });
        cx.notify();
    }

    /// `handleDragMove` (`LayersPanel.tsx:67-91`): the gap the pointer is
    /// nearest, found against each row's midpoint.
    fn drag_reorder(&mut self, y: Pixels, cx: &mut Context<Self>) {
        let Some(bounds) = self.annotation_state.list.get() else {
            return;
        };
        let count = self.project.annotations.len();
        if count == 0 {
            return;
        }
        let top = f32::from(bounds.origin.y);
        let mut target = 0;
        for index in 0..count {
            let middle = top + index as f32 * LAYER_ROW_HEIGHT + LAYER_ROW_HEIGHT / 2.;
            if f32::from(y) < middle {
                target = index;
                break;
            }
            target = index + 1;
        }
        if let Some(reorder) = self.annotation_state.reorder.as_mut()
            && reorder.target != Some(target)
        {
            reorder.target = Some(target);
            cx.notify();
        }
    }

    /// `finalizeDrag` (`LayersPanel.tsx:93-124`).
    fn finish_reorder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(reorder) = self.annotation_state.reorder.take() else {
            return;
        };
        let Some(target) = reorder.target else {
            cx.notify();
            return;
        };
        let count = self.project.annotations.len();
        if count != reorder.count {
            cx.notify();
            return;
        }
        let Some(dragged_reversed) = self
            .project
            .annotations
            .iter()
            .rev()
            .position(|annotation| annotation.id == reorder.id)
        else {
            cx.notify();
            return;
        };
        let Some((from, to)) = reorder_move(count, dragged_reversed, target) else {
            cx.notify();
            return;
        };
        let annotation = self.project.annotations.remove(from);
        self.project.annotations.insert(to, annotation);
        self.commit_annotations(window, cx);
    }
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------
//
// The source is an SVG with `viewBox="0 0 frameW frameH"`, so every number in
// an annotation is a frame pixel and the browser scales the lot. Here the same
// numbers are multiplied by the layer's own scale on the way into a
// `PathBuilder`. Two things stay in *screen* units on purpose: the selection
// chrome (handles, their rings, the text box) which the source sizes off
// `handleSize` and would otherwise thin out at low zoom, and the round caps,
// which lyon's `StrokeOptions` cannot be given without naming `lyon::LineCap`
// -- a filled disc at each end is the same shape.

/// Frame space to window space.
fn map_point(origin: Point<Pixels>, scale: f32, x: f64, y: f64) -> Point<Pixels> {
    gpui::point(
        origin.x + px(x as f32 * scale),
        origin.y + px(y as f32 * scale),
    )
}

fn push_rect(builder: &mut PathBuilder, origin: Point<Pixels>, scale: f32, rect: Rect) {
    let (right, bottom) = (rect.x + rect.width, rect.y + rect.height);
    builder.move_to(map_point(origin, scale, rect.x, rect.y));
    builder.line_to(map_point(origin, scale, right, rect.y));
    builder.line_to(map_point(origin, scale, right, bottom));
    builder.line_to(map_point(origin, scale, rect.x, bottom));
    builder.close();
}

/// A screen-space rounded rectangle -- the selection box's `rx={4}`.
fn push_rounded_rect(builder: &mut PathBuilder, bounds: Bounds<Pixels>, radius: f32) {
    let (left, top) = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
    let (width, height) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
    let radius = radius.min(width / 2.).min(height / 2.).max(0.);
    let (right, bottom) = (left + width, top + height);
    let point = |x: f32, y: f32| gpui::point(px(x), px(y));
    builder.move_to(point(left + radius, top));
    builder.line_to(point(right - radius, top));
    builder.curve_to(point(right, top + radius), point(right, top));
    builder.line_to(point(right, bottom - radius));
    builder.curve_to(point(right - radius, bottom), point(right, bottom));
    builder.line_to(point(left + radius, bottom));
    builder.curve_to(point(left, bottom - radius), point(left, bottom));
    builder.line_to(point(left, top + radius));
    builder.curve_to(point(left + radius, top), point(left, top));
    builder.close();
}

/// A circle in screen units, as four cubics.
fn push_circle(builder: &mut PathBuilder, center: Point<Pixels>, radius_x: f32, radius_y: f32) {
    // The usual cubic approximation of a quarter turn.
    const KAPPA: f32 = 0.552_284_75;
    let (cx, cy) = (f32::from(center.x), f32::from(center.y));
    let (ox, oy) = (radius_x * KAPPA, radius_y * KAPPA);
    let point = |x: f32, y: f32| gpui::point(px(x), px(y));
    builder.move_to(point(cx + radius_x, cy));
    builder.cubic_bezier_to(
        point(cx, cy + radius_y),
        point(cx + radius_x, cy + oy),
        point(cx + ox, cy + radius_y),
    );
    builder.cubic_bezier_to(
        point(cx - radius_x, cy),
        point(cx - ox, cy + radius_y),
        point(cx - radius_x, cy + oy),
    );
    builder.cubic_bezier_to(
        point(cx, cy - radius_y),
        point(cx - radius_x, cy - oy),
        point(cx - ox, cy - radius_y),
    );
    builder.cubic_bezier_to(
        point(cx + radius_x, cy),
        point(cx + ox, cy - radius_y),
        point(cx + radius_x, cy - oy),
    );
    builder.close();
}

fn paint_fill(builder: PathBuilder, color: Hsla, window: &mut Window) {
    if let Ok(path) = builder.build() {
        window.paint_path(path, color);
    }
}

/// A `stroke-linecap="round"` end, as the disc the cap is.
fn paint_disc(window: &mut Window, center: Point<Pixels>, radius: f32, color: Hsla) {
    if radius <= 0.25 {
        return;
    }
    let mut builder = PathBuilder::fill();
    push_circle(&mut builder, center, radius, radius);
    paint_fill(builder, color, window);
}

fn paint_layer(paint: &LayerPaint, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
    let origin = bounds.origin;
    let scale = paint.scale;

    // The blur/pixelate regions sit between the frame and the annotations, the
    // way the second canvas does over there.
    for overlay in &paint.masks {
        let region = Bounds {
            origin: map_point(origin, scale, overlay.rect.x, overlay.rect.y),
            size: gpui::size(
                px(overlay.rect.width as f32 * scale),
                px(overlay.rect.height as f32 * scale),
            ),
        };
        let _ = window.paint_image(region, Corners::default(), overlay.image.clone(), 0, false);
    }

    for annotation in &paint.annotations {
        if paint.editing.as_deref() == Some(annotation.id.as_str()) {
            continue;
        }
        paint_annotation(annotation, origin, scale, window, cx);
    }

    if paint.select_tool && paint.editing.is_none() {
        // The hover wash, on an unselected text annotation only (`:730-751`).
        if let Some(hovered) = paint
            .hover
            .as_deref()
            .filter(|id| paint.selected.as_deref() != Some(id))
            .and_then(|id| {
                paint
                    .annotations
                    .iter()
                    .find(|annotation| annotation.id == id)
            })
            && hovered.annotation_type == AnnotationType::Text
        {
            let rect = screen_rect(origin, scale, selection_rect(hovered, paint.handle_size));
            let mut fill = PathBuilder::fill();
            push_rounded_rect(&mut fill, rect, 4.);
            paint_fill(
                fill,
                Theme::with_alpha(gpui::rgb(SELECTION_BLUE), 0.05),
                window,
            );
            let mut stroke = PathBuilder::stroke(px(2.));
            push_rounded_rect(&mut stroke, rect, 4.);
            paint_fill(
                stroke,
                Theme::with_alpha(gpui::rgb(SELECTION_BLUE), 0.4),
                window,
            );
        }

        if let Some(selected) = paint.selected.as_deref().and_then(|id| {
            paint
                .annotations
                .iter()
                .find(|annotation| annotation.id == id)
        }) {
            paint_selection(selected, origin, scale, paint.handle_size, window);
        }
    }

    if let Some(temp) = &paint.temp {
        // A stroke's samples are absolute until mouse-up normalizes them, so
        // the live preview paints them straight rather than through
        // `RenderAnnotation`'s denormalizing branch (`:769-790`). Under two
        // samples that branch draws nothing either, so the fallback is a
        // no-op for a stroke and the real shape for everything else.
        if temp.annotation_type == AnnotationType::Draw {
            let points = temp.points.clone().unwrap_or_default();
            if points.len() >= 2
                && let Some(color) = annotation_color(&temp.stroke_color, temp.opacity)
            {
                paint_stroke_path(
                    &points,
                    origin,
                    scale,
                    (temp.stroke_width as f32 * scale).max(0.),
                    color,
                    window,
                );
            }
        } else {
            paint_annotation(temp, origin, scale, window, cx);
        }
    }
}

fn screen_rect(origin: Point<Pixels>, scale: f32, rect: Rect) -> Bounds<Pixels> {
    Bounds {
        origin: map_point(origin, scale, rect.x, rect.y),
        size: gpui::size(
            px(rect.width as f32 * scale),
            px(rect.height as f32 * scale),
        ),
    }
}

/// `RenderAnnotation` (`AnnotationLayer.tsx:813-933`).
fn paint_annotation(
    annotation: &Annotation,
    origin: Point<Pixels>,
    scale: f32,
    window: &mut Window,
    cx: &mut App,
) {
    let opacity = annotation.opacity;
    let stroke_color = annotation_color(&annotation.stroke_color, opacity);
    let fill_color = annotation_color(&annotation.fill_color, opacity);
    let stroke_width = (annotation.stroke_width as f32 * scale).max(0.);

    match annotation.annotation_type {
        // The mask's own rect is `fill="none" stroke="none"`; the overlay is
        // what makes it visible (`:892-909`).
        AnnotationType::Mask => {}
        AnnotationType::Rectangle => {
            let rect = normalized_rect(annotation);
            if let Some(fill) = fill_color {
                let mut builder = PathBuilder::fill();
                push_rect(&mut builder, origin, scale, rect);
                paint_fill(builder, fill, window);
            }
            if let Some(stroke) = stroke_color
                && stroke_width > 0.
            {
                let mut builder = PathBuilder::stroke(px(stroke_width));
                push_rect(&mut builder, origin, scale, rect);
                paint_fill(builder, stroke, window);
            }
        }
        AnnotationType::Circle => {
            let center = map_point(
                origin,
                scale,
                annotation.x + annotation.width / 2.,
                annotation.y + annotation.height / 2.,
            );
            let radius_x = (annotation.width / 2.).abs() as f32 * scale;
            let radius_y = (annotation.height / 2.).abs() as f32 * scale;
            if radius_x <= 0. || radius_y <= 0. {
                return;
            }
            if let Some(fill) = fill_color {
                let mut builder = PathBuilder::fill();
                push_circle(&mut builder, center, radius_x, radius_y);
                paint_fill(builder, fill, window);
            }
            if let Some(stroke) = stroke_color
                && stroke_width > 0.
            {
                let mut builder = PathBuilder::stroke(px(stroke_width));
                push_circle(&mut builder, center, radius_x, radius_y);
                paint_fill(builder, stroke, window);
            }
        }
        AnnotationType::Arrow => {
            let Some(stroke) = stroke_color else {
                return;
            };
            let end = (
                annotation.x + annotation.width,
                annotation.y + annotation.height,
            );
            let angle = (end.1 - annotation.y).atan2(end.0 - annotation.x);
            let head = arrow_head_points(end.0, end.1, angle, annotation.stroke_width);
            if stroke_width > 0. {
                let tail = map_point(origin, scale, annotation.x, annotation.y);
                let base = map_point(origin, scale, head.base.0, head.base.1);
                let mut builder = PathBuilder::stroke(px(stroke_width));
                builder.move_to(tail);
                builder.line_to(base);
                paint_fill(builder, stroke, window);
                paint_disc(window, tail, stroke_width / 2., stroke);
                paint_disc(window, base, stroke_width / 2., stroke);
            }
            let mut builder = PathBuilder::fill();
            let points: Vec<Point<Pixels>> = head
                .points
                .iter()
                .map(|(x, y)| map_point(origin, scale, *x, *y))
                .collect();
            builder.add_polygon(&points, true);
            paint_fill(builder, stroke, window);
        }
        AnnotationType::Draw => {
            let Some(stroke) = stroke_color else {
                return;
            };
            if stroke_width <= 0. {
                return;
            }
            let points = draw_points(annotation);
            paint_stroke_path(&points, origin, scale, stroke_width, stroke, window);
        }
        AnnotationType::Text => paint_text(annotation, origin, scale, window, cx),
    }
}

/// A smoothed freehand stroke, with the round caps its `stroke-linecap` asks
/// for. The quadratics `smooth_path` emits are already tangent-continuous, so
/// the joins need nothing extra.
fn paint_stroke_path(
    points: &[[f64; 2]],
    origin: Point<Pixels>,
    scale: f32,
    stroke_width: f32,
    color: Hsla,
    window: &mut Window,
) {
    let segments = smooth_path(points);
    if segments.is_empty() {
        return;
    }
    let mut builder = PathBuilder::stroke(px(stroke_width));
    for segment in &segments {
        match *segment {
            PathSegment::Move { x, y } => builder.move_to(map_point(origin, scale, x, y)),
            PathSegment::Line { x, y } => builder.line_to(map_point(origin, scale, x, y)),
            PathSegment::Quad { cx, cy, x, y } => builder.curve_to(
                map_point(origin, scale, x, y),
                map_point(origin, scale, cx, cy),
            ),
        }
    }
    paint_fill(builder, color, window);
    if let (Some(first), Some(last)) = (points.first(), points.last()) {
        paint_disc(
            window,
            map_point(origin, scale, first[0], first[1]),
            stroke_width / 2.,
            color,
        );
        paint_disc(
            window,
            map_point(origin, scale, last[0], last[1]),
            stroke_width / 2.,
            color,
        );
    }
}

/// `<text x y+height font-size=height>` (`:879-891`). SVG anchors a line on its
/// baseline; gpui centres the glyphs in the line box it is given, so a box of
/// exactly ascent+descent puts the baseline one ascent below the origin.
fn paint_text(
    annotation: &Annotation,
    origin: Point<Pixels>,
    scale: f32,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(text) = annotation.text.as_deref().filter(|text| !text.is_empty()) else {
        return;
    };
    let Some(color) = annotation_color(&annotation.stroke_color, annotation.opacity) else {
        return;
    };
    let font_size = px((annotation.height as f32 * scale).max(1.));
    // `shape_line` takes one line; `white-space: pre` in an SVG `<text>` never
    // wraps either, so a stray newline becomes a space rather than a panic.
    let text = if text.contains('\n') {
        text.replace('\n', " ")
    } else {
        text.to_string()
    };
    let run = TextRun {
        len: text.len(),
        font: gpui::font(TEXT_FONT),
        color,
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let line = window
        .text_system()
        .shape_line(text.into(), font_size, &[run], None);
    let line_height = line.ascent + line.descent;
    let baseline = origin.y + px((annotation.y + annotation.height) as f32 * scale);
    let _ = line.paint(
        gpui::point(
            origin.x + px(annotation.x as f32 * scale),
            baseline - line.ascent,
        ),
        line_height,
        gpui::TextAlign::Left,
        None,
        window,
        cx,
    );
}

/// `SelectionHandles` (`:935-1064`), in screen units.
fn paint_selection(
    annotation: &Annotation,
    origin: Point<Pixels>,
    scale: f32,
    handle_size: f64,
    window: &mut Window,
) {
    let is_text = annotation.annotation_type == AnnotationType::Text;
    if is_text {
        let rect = screen_rect(origin, scale, selection_rect(annotation, handle_size));
        let mut fill = PathBuilder::fill();
        push_rounded_rect(&mut fill, rect, 4.);
        paint_fill(
            fill,
            Theme::with_alpha(gpui::rgb(SELECTION_BLUE), 0.1),
            window,
        );
        let mut stroke = PathBuilder::stroke(px(2.));
        push_rounded_rect(&mut stroke, rect, 4.);
        paint_fill(stroke, gpui::rgb(SELECTION_BLUE).into(), window);
    }

    let radius = HANDLE_SCREEN_SIZE as f32 / 2.;
    for (_, (x, y)) in handles(annotation, handle_size) {
        let center = map_point(origin, scale, x, y);
        let mut fill = PathBuilder::fill();
        push_circle(&mut fill, center, radius, radius);
        paint_fill(
            fill,
            if is_text {
                gpui::rgb(SELECTION_BLUE).into()
            } else {
                gpui::white()
            },
            window,
        );
        let mut ring = PathBuilder::stroke(px(if is_text { 1.5 } else { 1. }));
        push_circle(&mut ring, center, radius, radius);
        paint_fill(
            ring,
            if is_text {
                gpui::white()
            } else {
                gpui::rgb(SELECTION_BLUE).into()
            },
            window,
        );
    }
}

// ---------------------------------------------------------------------------
// Chrome helpers
// ---------------------------------------------------------------------------

/// `ConfigItem` (`AnnotationConfig.tsx:177-193`).
fn config_item(
    theme: &Theme,
    label: &'static str,
    value: Option<String>,
    control: AnyElement,
) -> AnyElement {
    let theme = *theme;
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.))
        .flex_shrink_0()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.))
                .flex_shrink_0()
                .text_size(px(11.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.gray_10)
                .child(label)
                .children(value.map(|value| div().text_color(theme.gray_11).child(value))),
        )
        .child(control)
        .into_any_element()
}

/// The transparent swatch's checkerboard -- four quarters, which is what the
/// CSS pattern reduces to at this size.
fn checker_quarters(size: f32) -> Vec<AnyElement> {
    let half = size / 2.;
    let light: Hsla = gpui::white();
    let dark: Hsla = gpui::rgb(0xcccccc).into();
    [
        (0., 0., light),
        (half, 0., dark),
        (0., half, dark),
        (half, half, light),
    ]
    .into_iter()
    .map(|(x, y, fill)| {
        div()
            .absolute()
            .left(px(x))
            .top(px(y))
            .size(px(half))
            .bg(fill)
            .into_any_element()
    })
    .collect()
}

// ---------------------------------------------------------------------------
// Mask overlays
// ---------------------------------------------------------------------------

/// `renderMaskOverlays` + `blurRegion` (`Preview.tsx:537-687`): resample the
/// frame's own pixels inside each mask and hand back one image per region.
/// Runs on the background executor -- the regions are small, but a 50-block
/// pixelate over a 4K screenshot is still not main-thread work.
fn build_mask_overlays(
    rgba: &[u8],
    size: (u32, u32),
    masks: &[Annotation],
    rect: Rect,
) -> Vec<MaskOverlay> {
    let mut overlays = Vec::new();
    for mask in masks {
        let Some((x0, y0, processed)) = masked_region_image(rgba, size, mask, rect) else {
            continue;
        };
        overlays.push(MaskOverlay {
            rect: Rect {
                x: x0 as f64,
                y: y0 as f64,
                width: processed.width() as f64,
                height: processed.height() as f64,
            },
            image: crate::library::rgba_to_render_image(processed),
        });
    }
    overlays
}

/// One mask's blurred or pixelated pixels, sampled from `rgba` (an unmodified
/// copy of the frame) and returned with the region's top-left in frame
/// coordinates. This is the single implementation of the two filters -- the
/// preview's overlay tiles come through it, and so does the export's
/// `applyMaskAnnotations` pass, which calls it with `rect` set to the whole
/// canvas (`screenshotExport.ts:290-295` passes `{x:0,y:0,w,h}`).
pub(crate) fn masked_region_image(
    rgba: &[u8],
    size: (u32, u32),
    mask: &Annotation,
    rect: Rect,
) -> Option<(u32, u32, image::RgbaImage)> {
    let (frame_width, frame_height) = size;
    if frame_width == 0 || frame_height == 0 {
        return None;
    }
    let stride = frame_width as usize * 4;
    if rgba.len() < stride * frame_height as usize {
        return None;
    }

    let (x0, y0, width, height) = mask_region(mask, rect, (frame_width, frame_height))?;

    let mut region = Vec::with_capacity(width as usize * height as usize * 4);
    for row in 0..height {
        let start = (y0 + row) as usize * stride + x0 as usize * 4;
        region.extend_from_slice(&rgba[start..start + width as usize * 4]);
    }
    let source = image::RgbaImage::from_raw(width, height, region)?;

    let level = mask.mask_level.unwrap_or(MASK_FALLBACK_LEVEL).max(1.);
    let processed = if mask.mask_type == Some(MaskType::Pixelate) {
        // `blockSize = Math.max(2, Math.round(level))`, nearest both ways.
        let block = (level.round() as u32).max(2);
        let small = image::imageops::resize(
            &source,
            (width / block).max(1),
            (height / block).max(1),
            image::imageops::FilterType::Nearest,
        );
        image::imageops::resize(&small, width, height, image::imageops::FilterType::Nearest)
    } else {
        // `blurRegion`: `scale = Math.max(2, Math.round(level / 4))`, with
        // smoothing on both passes.
        let factor = ((level / 4.).round() as u32).max(2);
        let small = image::imageops::resize(
            &source,
            (width / factor).max(1),
            (height / factor).max(1),
            image::imageops::FilterType::Triangle,
        );
        image::imageops::resize(&small, width, height, image::imageops::FilterType::Triangle)
    };

    Some((x0, y0, processed))
}

/// One mask's region in whole frame pixels: its own rect, clipped to the
/// screenshot's content rect and then to the frame.
fn mask_region(mask: &Annotation, rect: Rect, frame: (u32, u32)) -> Option<(u32, u32, u32, u32)> {
    let left = rect.x.max(mask.x.min(mask.x + mask.width));
    let top = rect.y.max(mask.y.min(mask.y + mask.height));
    let right = (rect.x + rect.width).min(mask.x.max(mask.x + mask.width));
    let bottom = (rect.y + rect.height).min(mask.y.max(mask.y + mask.height));
    if right <= left || bottom <= top {
        return None;
    }
    let x0 = (left.round().max(0.) as u32).min(frame.0);
    let y0 = (top.round().max(0.) as u32).min(frame.1);
    let x1 = (right.round().max(0.) as u32).min(frame.0);
    let y1 = (bottom.round().max(0.) as u32).min(frame.1);
    (x1 > x0 && y1 > y0).then(|| (x0, y0, x1 - x0, y1 - y0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transform(
        frame: (f64, f64),
        image: (f64, f64),
        padding: f64,
        aspect: Option<AspectRatio>,
    ) -> ImageTransform {
        calculate_image_transform(frame, image, padding, None, aspect.as_ref())
    }

    /// Auto aspect, no padding: the content fills the frame exactly.
    ///
    /// `paddingFactor` is 0, so `getBaseSize`'s auto branch rounds 800x600 to
    /// 800x600 (`(floor(800) + 1) & ~1`), `outputScale` is 1 and both offsets
    /// are zero.
    #[test]
    fn the_auto_branch_with_no_padding_is_the_identity() {
        let result = transform((800., 600.), (800., 600.), 0., None);
        assert_eq!(result.offset, (0., 0.));
        assert_eq!(result.size, (800., 600.));
    }

    /// Auto aspect at padding 50: `paddingFactor` is `0.5 * 0.4 = 0.2`, so the
    /// base size is `800 * 1.4 = 1120` by `600 * 1.4 = 840` (both already even)
    /// and a frame of exactly that size scales 1:1. The offsets are then
    /// `800 * 0.2` and `600 * 0.2`, and the content is back to 800x600.
    #[test]
    fn the_auto_branch_insets_by_the_padding_factor() {
        let result = transform((1120., 840.), (800., 600.), 50., None);
        assert_eq!(result.offset, (160., 120.));
        assert_eq!(result.size, (800., 600.));
    }

    /// A square frame around a 4:3 image, no padding: the image is wider than
    /// the frame, so `isHeightConstrained` is false, the content takes the full
    /// width and is centred vertically at `(800 - 600) / 2`.
    #[test]
    fn a_fixed_aspect_letterboxes_the_content_and_centres_it() {
        let result = transform((800., 800.), (800., 600.), 0., Some(AspectRatio::Square));
        assert_eq!(result.offset, (0., 100.));
        assert_eq!(result.size, (800., 600.));
    }

    /// A frame that has not been measured yet must not divide by zero.
    #[test]
    fn a_degenerate_frame_falls_back_to_the_frame_itself() {
        let result = transform((0., 0.), (800., 600.), 20., None);
        assert_eq!(result.offset, (0., 0.));
        assert_eq!(result.size, (0., 0.));
    }

    #[test]
    fn image_rect_without_an_image_size_is_the_whole_frame() {
        let rect = image_rect((1280., 720.), None, 40., None, None);
        assert_eq!(
            rect,
            Rect {
                x: 0.,
                y: 0.,
                width: 1280.,
                height: 720.
            }
        );
    }

    /// The resize effect carries an annotation across proportionally: a shape
    /// that sat at the content's top-left corner stays there, and one that was
    /// half as wide as the content stays half as wide.
    #[test]
    fn annotations_ride_the_content_rect_across_a_resize() {
        let previous = ImageTransform {
            offset: (10., 20.),
            size: (100., 50.),
        };
        let current = ImageTransform {
            offset: (30., 40.),
            size: (200., 100.),
        };
        let mut annotations = vec![Annotation {
            id: "a".into(),
            annotation_type: AnnotationType::Rectangle,
            x: 10.,
            y: 20.,
            width: 50.,
            height: 25.,
            stroke_color: "#000000".into(),
            stroke_width: 2.,
            fill_color: "transparent".into(),
            opacity: 1.,
            rotation: 0.,
            text: None,
            mask_type: None,
            mask_level: None,
            points: None,
        }];
        rescale_annotations(&mut annotations, &previous, &current);
        assert_eq!((annotations[0].x, annotations[0].y), (30., 40.));
        assert_eq!((annotations[0].width, annotations[0].height), (100., 50.));
    }

    #[test]
    fn an_arrow_head_grows_with_its_stroke_but_never_below_the_floor() {
        assert_eq!(arrow_head_size(1.), (20., 14.));
        assert_eq!(arrow_head_size(10.), (60., 50.));
    }

    /// Pointing straight right: the base sits `length` behind the tip and the
    /// flanks are half the head's width above and below it.
    #[test]
    fn an_arrow_head_squares_up_along_its_angle() {
        let head = arrow_head_points(100., 100., 0., 4.);
        assert_eq!(head.base, (76., 100.));
        assert_eq!(head.points[0], (100., 100.));
        assert_eq!(head.points[1], (76., 90.));
        assert_eq!(head.points[2], (76., 110.));
    }

    #[test]
    fn a_two_point_stroke_is_a_straight_line() {
        let path = smooth_path(&[[0., 0.], [10., 10.]]);
        assert_eq!(
            path,
            vec![
                PathSegment::Move { x: 0., y: 0. },
                PathSegment::Line { x: 10., y: 10. }
            ]
        );
    }

    #[test]
    fn a_longer_stroke_runs_quadratics_through_the_midpoints() {
        let path = smooth_path(&[[0., 0.], [10., 0.], [20., 0.]]);
        assert_eq!(
            path,
            vec![
                PathSegment::Move { x: 0., y: 0. },
                PathSegment::Quad {
                    cx: 0.,
                    cy: 0.,
                    x: 5.,
                    y: 0.
                },
                PathSegment::Quad {
                    cx: 10.,
                    cy: 0.,
                    x: 15.,
                    y: 0.
                },
                PathSegment::Line { x: 20., y: 0. },
            ]
        );
    }

    #[test]
    fn a_stroke_with_fewer_than_two_samples_draws_nothing() {
        assert!(smooth_path(&[]).is_empty());
        assert!(smooth_path(&[[1., 1.]]).is_empty());
    }

    #[test]
    fn a_text_layer_is_labelled_with_its_own_content() {
        let mut annotation = Annotation {
            id: "a".into(),
            annotation_type: AnnotationType::Text,
            x: 0.,
            y: 0.,
            width: 0.,
            height: 0.,
            stroke_color: "#000000".into(),
            stroke_width: 1.,
            fill_color: "transparent".into(),
            opacity: 1.,
            rotation: 0.,
            text: Some("Hello".into()),
            mask_type: None,
            mask_level: None,
            points: None,
        };
        assert_eq!(layer_label(&annotation), "Hello");
        annotation.text = Some("A very long caption".into());
        assert_eq!(layer_label(&annotation), "A very long ...");
        annotation.text = None;
        assert_eq!(layer_label(&annotation), "Text");
    }

    // -----------------------------------------------------------------------
    // The engine
    // -----------------------------------------------------------------------

    fn shape(
        annotation_type: AnnotationType,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Annotation {
        Annotation {
            id: "a".into(),
            annotation_type,
            x,
            y,
            width,
            height,
            stroke_color: "#F05656".into(),
            stroke_width: 4.,
            fill_color: "transparent".into(),
            opacity: 1.,
            rotation: 0.,
            text: None,
            mask_type: None,
            mask_level: None,
            points: None,
        }
    }

    /// `Math.min(Math.max(v, min), max)`: a window narrower than the value
    /// collapses to its *upper* bound, which is what keeps a mask wider than
    /// the screenshot pinned to the right edge rather than the left.
    #[test]
    fn clamping_follows_the_sources_argument_order() {
        assert_eq!(clamp_value(5., 0., 10.), 5.);
        assert_eq!(clamp_value(-5., 0., 10.), 0.);
        assert_eq!(clamp_value(50., 0., 10.), 10.);
        assert_eq!(clamp_value(5., 10., 0.), 0.);
    }

    #[test]
    fn a_negative_box_normalizes_to_its_top_left() {
        let rect = normalized_rect(&shape(AnnotationType::Rectangle, 100., 100., -40., -20.));
        assert_eq!(
            rect,
            Rect {
                x: 60.,
                y: 80.,
                width: 40.,
                height: 20.
            }
        );
    }

    /// A rectangle is hit anywhere inside it -- `fill="transparent"` is still a
    /// paint, so SVG's `visiblePainted` counts it -- plus half a stroke out.
    #[test]
    fn a_rectangle_is_hit_across_its_whole_face() {
        let rectangle = shape(AnnotationType::Rectangle, 10., 10., 100., 50.);
        assert!(hit_annotation(&rectangle, (60., 30.), 10.));
        assert!(hit_annotation(&rectangle, (10., 10.), 10.));
        // Half of the 4px stroke hangs outside the box.
        assert!(hit_annotation(&rectangle, (8.5, 30.), 10.));
        assert!(!hit_annotation(&rectangle, (5., 30.), 10.));
    }

    /// An ellipse's corners are not inside it.
    #[test]
    fn a_circle_is_hit_inside_its_ellipse_only() {
        let circle = shape(AnnotationType::Circle, 0., 0., 100., 50.);
        assert!(hit_annotation(&circle, (50., 25.), 10.));
        assert!(hit_annotation(&circle, (98., 25.), 10.));
        assert!(!hit_annotation(&circle, (2., 2.), 10.));
    }

    /// A mask paints nothing, but its rect still takes the pointer
    /// (`pointer-events: all`, `AnnotationLayer.tsx:907`).
    #[test]
    fn a_mask_is_hit_inside_its_invisible_rect() {
        let mut mask = shape(AnnotationType::Mask, 0., 0., 40., 40.);
        mask.stroke_width = 0.;
        assert!(hit_annotation(&mask, (20., 20.), 10.));
        assert!(!hit_annotation(&mask, (60., 20.), 10.));
    }

    /// Text is hit on the padded box the hover overlay draws, not on the
    /// glyphs (`:738-750`).
    #[test]
    fn text_is_hit_on_its_padded_box() {
        let mut text = shape(AnnotationType::Text, 100., 100., 150., 40.);
        text.text = Some("Hello".into());
        // handleSize 10 -> 3 units of padding on every side.
        assert!(hit_annotation(&text, (98., 98.), 10.));
        assert!(!hit_annotation(&text, (96., 98.), 10.));
        assert!(hit_annotation(&text, (252., 142.), 10.));
    }

    /// Typing never widens `width`, so the glyph run overflows the stored box
    /// freely; the measured hit rect follows the run so the visible glyphs are
    /// always clickable, descenders included.
    #[test]
    fn a_measured_text_hit_follows_the_glyph_run() {
        let mut text = shape(AnnotationType::Text, 100., 100., 150., 40.);
        text.text = Some("A caption that runs long".into());
        let glyphs = TextExtent {
            width: 400.,
            ascent: 30.,
            descent: 8.,
        };
        let rect = text_hit_rect(&text, 10., Some(glyphs));
        // The run's far end, padded: 100 + 400 + 3.
        assert_eq!(rect.x + rect.width, 503.);
        // Descenders hang below the baseline at y + height: 140 + 8 + 3.
        assert_eq!(rect.y + rect.height, 151.);
        // The left/top edges keep the hover overlay's padding.
        assert_eq!(rect.x, 97.);
        assert_eq!(rect.y, 97.);
        // A run that stays inside the stored box changes nothing.
        let short = text_hit_rect(
            &text,
            10.,
            Some(TextExtent {
                width: 40.,
                ascent: 30.,
                descent: 0.,
            }),
        );
        assert_eq!(short, selection_rect(&text, 10.));
        // And so does no measurement at all.
        assert_eq!(text_hit_rect(&text, 10., None), selection_rect(&text, 10.));
    }

    /// The hit rect never collapses below two handles on a side, so a text
    /// scaled down to a sliver still takes the press.
    #[test]
    fn a_tiny_text_still_takes_a_generous_press() {
        let mut text = shape(AnnotationType::Text, 100., 100., 6., 5.);
        text.text = Some(".".into());
        let rect = text_hit_rect(&text, 10., None);
        assert!(rect.width >= 20.);
        assert!(rect.height >= 20.);
        // Centred on the box it grew from.
        assert_eq!(rect.x + rect.width / 2., 103.);
        assert_eq!(rect.y + rect.height / 2., 102.5);
        // And the pure hit test agrees.
        assert!(hit_annotation(&text, (95., 95.), 10.));
    }

    /// A stroke is `fill="none"`, but the `<g>` around it sets
    /// `pointer-events: all`, which ignores that: the line *and* the region it
    /// encloses are both targets.
    #[test]
    fn a_stroke_is_hit_on_its_line_and_inside_what_it_encloses() {
        let mut open = shape(AnnotationType::Draw, 0., 0., 100., 100.);
        open.points = Some(vec![[0., 0.], [1., 1.]]);
        assert!(hit_annotation(&open, (50., 50.), 10.));
        // Two samples enclose nothing, so the far corner stays clear.
        assert!(!hit_annotation(&open, (90., 10.), 10.));

        let mut loop_back = shape(AnnotationType::Draw, 0., 0., 100., 100.);
        loop_back.points = Some(vec![[0., 0.], [1., 0.], [1., 1.], [0., 1.]]);
        // Dead centre of the loop: nowhere near the line, still selectable.
        assert!(hit_annotation(&loop_back, (50., 50.), 10.));
        assert!(!hit_annotation(&loop_back, (150., 50.), 10.));
    }

    /// SVG disables rendering for a zero radius, and an unrendered element is
    /// not a pointer target.
    #[test]
    fn a_flat_circle_is_not_a_target() {
        let flat = shape(AnnotationType::Circle, 0., 0., 100., 0.);
        assert!(!hit_annotation(&flat, (50., 0.), 10.));
    }

    /// An arrow is its shaft plus its head, not its bounding box.
    #[test]
    fn an_arrow_is_hit_on_its_shaft_or_its_head() {
        let arrow = shape(AnnotationType::Arrow, 0., 0., 200., 0.);
        assert!(hit_annotation(&arrow, (100., 1.), 10.));
        assert!(hit_annotation(&arrow, (195., 0.), 10.));
        assert!(!hit_annotation(&arrow, (100., 40.), 10.));
    }

    /// Later siblings paint over earlier ones, so the hit test walks backwards.
    #[test]
    fn the_hit_test_takes_the_topmost_annotation() {
        let mut under = shape(AnnotationType::Rectangle, 0., 0., 100., 100.);
        under.id = "under".into();
        let mut over = shape(AnnotationType::Rectangle, 0., 0., 100., 100.);
        over.id = "over".into();
        let annotations = vec![under, over];
        assert_eq!(hit_test(&annotations, (50., 50.), 10.), Some(1));
        assert_eq!(hit_test(&annotations, (500., 50.), 10.), None);
    }

    /// Eight grips for a shape, the four corners for text, and the two
    /// endpoints for an arrow.
    #[test]
    fn the_handle_set_depends_on_the_annotation() {
        let rectangle = shape(AnnotationType::Rectangle, 0., 0., 100., 50.);
        let grips = handles(&rectangle, 10.);
        assert_eq!(grips.len(), 8);
        assert_eq!(grips[0], (Handle::Nw, (0., 0.)));
        assert_eq!(grips[7], (Handle::Se, (100., 50.)));

        let text = shape(AnnotationType::Text, 0., 0., 100., 40.);
        let grips = handles(&text, 10.);
        assert_eq!(grips.len(), 4);
        // The text box is padded by 30 % of a handle before the corners land.
        assert_eq!(grips[0], (Handle::Nw, (-3., -3.)));

        let arrow = shape(AnnotationType::Arrow, 10., 10., 40., 20.);
        assert_eq!(
            handles(&arrow, 10.),
            vec![(Handle::Start, (10., 10.)), (Handle::End, (50., 30.))]
        );
    }

    #[test]
    fn a_grip_is_hit_within_its_own_radius() {
        let rectangle = shape(AnnotationType::Rectangle, 0., 0., 100., 50.);
        assert_eq!(hit_handle(&rectangle, (100., 50.), 10.), Some(Handle::Se));
        assert_eq!(hit_handle(&rectangle, (52., 0.), 10.), Some(Handle::N));
        assert_eq!(hit_handle(&rectangle, (50., 25.), 10.), None);
    }

    /// `finalizeDrag` (`LayersPanel.tsx:93-124`). The panel is reversed, so
    /// reversed index 0 is the *last* annotation; dropping below the dragged
    /// row also loses a slot to the row's own removal.
    #[test]
    fn a_reorder_maps_the_reversed_list_back_onto_the_store() {
        // Three annotations, listed [2, 1, 0]. Dragging the front one (reversed
        // 0, actual 2) to the bottom of the panel lands it at actual 0.
        assert_eq!(reorder_move(3, 0, 3), Some((2, 0)));
        // Dragging the back one (reversed 2, actual 0) to the top puts it last.
        assert_eq!(reorder_move(3, 2, 0), Some((0, 2)));
        // One step down the panel is one step back in the store.
        assert_eq!(reorder_move(3, 0, 2), Some((2, 1)));
        // A drop in the row's own gaps is a no-op, on either side.
        assert_eq!(reorder_move(3, 1, 1), None);
        assert_eq!(reorder_move(3, 1, 2), None);
        assert_eq!(reorder_move(0, 0, 0), None);
    }

    /// The auto-clamp effect (`AnnotationLayer.tsx:88-141`).
    #[test]
    fn a_mask_is_clipped_into_the_screenshot_and_dropped_when_it_vanishes() {
        let rect = Rect {
            x: 100.,
            y: 100.,
            width: 400.,
            height: 300.,
        };
        let inside = shape(AnnotationType::Mask, 150., 150., 100., 100.);
        assert_eq!(clamp_mask(&inside, rect), MaskClamp::Unchanged);

        let overhanging = shape(AnnotationType::Mask, 50., 50., 200., 200.);
        assert_eq!(
            clamp_mask(&overhanging, rect),
            MaskClamp::Clamped(Rect {
                x: 100.,
                y: 100.,
                width: 150.,
                height: 150.
            })
        );

        // Slid off the left edge: what is left is thinner than 5px.
        let outside = shape(AnnotationType::Mask, 20., 150., 82., 100.);
        assert_eq!(clamp_mask(&outside, rect), MaskClamp::Remove);
    }

    /// The region `renderMaskOverlays` resamples: the mask, clipped to the
    /// content rect and then to the frame, in whole pixels.
    #[test]
    fn a_mask_region_is_clipped_to_the_content_rect_and_the_frame() {
        let rect = Rect {
            x: 10.,
            y: 10.,
            width: 100.,
            height: 100.,
        };
        let mask = shape(AnnotationType::Mask, 0., 0., 60., 60.);
        assert_eq!(mask_region(&mask, rect, (200, 200)), Some((10, 10, 50, 50)));

        // A negative box is the same region.
        let flipped = shape(AnnotationType::Mask, 60., 60., -50., -50.);
        assert_eq!(
            mask_region(&flipped, rect, (200, 200)),
            Some((10, 10, 50, 50))
        );

        // Entirely outside the content rect.
        let away = shape(AnnotationType::Mask, 500., 500., 50., 50.);
        assert_eq!(mask_region(&away, rect, (200, 200)), None);
    }

    /// The resample itself: one overlay per mask, at the region's own size,
    /// with the row slicing staying inside the frame buffer.
    #[test]
    fn a_mask_resamples_the_frames_own_pixels() {
        let frame = (64u32, 48u32);
        let rgba = vec![128u8; frame.0 as usize * frame.1 as usize * 4];
        let rect = Rect {
            x: 0.,
            y: 0.,
            width: 64.,
            height: 48.,
        };
        let mut blur = shape(AnnotationType::Mask, 8., 8., 32., 24.);
        blur.mask_type = Some(MaskType::Blur);
        blur.mask_level = Some(16.);
        let mut pixelate = shape(AnnotationType::Mask, 40., 30., 20., 16.);
        pixelate.id = "b".into();
        pixelate.mask_type = Some(MaskType::Pixelate);
        pixelate.mask_level = Some(7.);

        let overlays = build_mask_overlays(&rgba, frame, &[blur, pixelate], rect);
        assert_eq!(overlays.len(), 2);
        assert_eq!(
            overlays[0].rect,
            Rect {
                x: 8.,
                y: 8.,
                width: 32.,
                height: 24.
            }
        );
        assert_eq!(
            overlays[1].rect,
            Rect {
                x: 40.,
                y: 30.,
                width: 20.,
                height: 16.
            }
        );

        // A frame buffer that does not match the size it was handed is not
        // sliced at all.
        assert!(build_mask_overlays(&rgba[..16], frame, &[], rect).is_empty());
    }

    /// A finished stroke stores fractions of its own box, so a later resize
    /// carries the samples with it (`:449-453`, `:915-921`).
    #[test]
    fn a_stroke_normalizes_into_its_box_and_denormalizes_back() {
        let raw = [[10., 20.], [30., 20.], [30., 60.]];
        let normalized = normalize_draw_points(&raw, 10., 20., 20., 40.);
        assert_eq!(normalized, vec![[0., 0.], [1., 0.], [1., 1.]]);

        let mut annotation = shape(AnnotationType::Draw, 10., 20., 20., 40.);
        annotation.points = Some(normalized);
        assert_eq!(draw_points(&annotation), raw.to_vec());
    }

    /// A zero-width box would divide by zero; the source's `|| 1` is why it
    /// does not (`:449-450`).
    #[test]
    fn a_flat_stroke_normalizes_against_one_pixel() {
        let normalized = normalize_draw_points(&[[5., 5.], [5., 25.]], 5., 5., 0., 20.);
        assert_eq!(normalized, vec![[0., 0.], [0., 1.]]);
    }

    /// A resize dragged through the origin mirrors the samples rather than
    /// leaving the stroke inside out (`:544-556`).
    #[test]
    fn a_stroke_dragged_inside_out_mirrors_its_samples() {
        let points = [[0., 0.25], [1., 0.75]];
        assert_eq!(
            flip_draw_points(&points, true, false),
            vec![[1., 0.25], [0., 0.75]]
        );
        assert_eq!(
            flip_draw_points(&points, false, true),
            vec![[0., 0.75], [1., 0.25]]
        );
        assert_eq!(flip_draw_points(&points, false, false), points.to_vec());
    }

    /// `transparent` is a sentinel, not a colour: it paints nothing at all.
    #[test]
    fn transparent_paints_nothing_and_a_hex_carries_the_opacity() {
        assert!(annotation_color("transparent", 1.).is_none());
        assert!(annotation_color("", 1.).is_none());
        let color = annotation_color("#F05656", 0.5).expect("a hex colour");
        assert!((color.a - 0.5).abs() < 0.001);
    }

    /// The drag-end snapshot only records when the drag moved something.
    #[test]
    fn an_unmoved_drag_is_not_a_change() {
        let before = shape(AnnotationType::Rectangle, 0., 0., 10., 10.);
        let mut after = before.clone();
        assert!(!geometry_changed(&before, &after));
        after.x = 1.;
        assert!(geometry_changed(&before, &after));
    }
}
