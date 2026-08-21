//! Screenshot export compositing -- `screenshot-editor/screenshotExport.ts`
//! and the encode half of `useScreenshotExport.ts`, natively.
//!
//! The Tauri editor exports in two stages: the GPU renders the *styled*
//! screenshot (background, padding, shadow -- everything but annotations) at
//! export resolution, and a `<canvas>` pass then bakes the annotations in
//! (`renderScreenshotExportCanvas`, `screenshotExport.ts:250-338`). This
//! module is that canvas pass: scale the frame-space annotations up to the
//! export frame, re-apply the mask filters at export resolution, draw the
//! shapes with tiny-skia and the text with cosmic-text, and expand the output
//! to the union of the image and every annotation's box.
//!
//! It also carries the share fingerprint (`screenshotProjectFingerprint`,
//! `:419-431`) and the per-destination encodings (`exportImage`,
//! `useScreenshotExport.ts:139-253`): PNG for Save, PNG-over-white for Copy,
//! and JPEG at 0.9 for Share unless the output actually needs its alpha.
//!
//! Everything here is pure CPU work on plain buffers -- the callers run it on
//! the background executor.

use std::sync::{Mutex, OnceLock};

use cap_project::{Annotation, AnnotationType, ProjectConfiguration};

use crate::screenshot_annotations::{self as annotations, Rect};
use crate::screenshot_editor::has_no_visible_background;

/// One export-resolution GPU render, plus the size the *preview* renders the
/// same config at. Annotations live in preview-frame space
/// (`AnnotationLayer.tsx`'s viewBox), so the compositor's scale factors are
/// `export / base` -- exactly `canvas.width / frame.width` over there, where
/// `frame` is `latestFrame()` after `waitForSyncedPreview`.
pub struct RawFrame {
    /// Tight RGBA, straight alpha -- the wgpu row padding already stripped.
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// What `ProjectUniforms::get_output_size` yields for the preview's own
    /// `get_base_size` resolution -- i.e. the dimensions the preview frame for
    /// this config actually has.
    pub base_width: u32,
    pub base_height: u32,
}

/// The composited output canvas -- straight-alpha RGBA.
pub struct Composited {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// The output canvas rect before rounding: where the working canvas lands
/// inside it, and its final pixel size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ExportBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub width: u32,
    pub height: u32,
}

// ---------------------------------------------------------------------------
// Annotation scaling (`scaleAnnotations`, `screenshotExport.ts:232-248`)
// ---------------------------------------------------------------------------

/// Scale every annotation from preview-frame space into export space: x/w by
/// the x factor, y/h by the y factor, and strokeWidth/maskLevel by the average
/// of the two. `points` are fractions of the stroke's own box, so they ride
/// along untouched.
pub fn scale_annotations(list: &[Annotation], scale_x: f64, scale_y: f64) -> Vec<Annotation> {
    let scalar = (scale_x + scale_y) / 2.;
    list.iter()
        .map(|annotation| Annotation {
            x: annotation.x * scale_x,
            y: annotation.y * scale_y,
            width: annotation.width * scale_x,
            height: annotation.height * scale_y,
            stroke_width: annotation.stroke_width * scalar,
            mask_level: annotation.mask_level.map(|level| level * scalar),
            ..annotation.clone()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The composite (`renderScreenshotExportCanvas`)
// ---------------------------------------------------------------------------

/// The output canvas rect: the working canvas's own rect, unioned with every
/// non-mask annotation's normalized box (`:307-325`). `Math.max(1,
/// Math.round(..))` on each axis.
pub fn export_bounds(scaled: &[Annotation], canvas: (u32, u32)) -> ExportBounds {
    let mut min_x = 0f64;
    let mut min_y = 0f64;
    let mut max_x = f64::from(canvas.0);
    let mut max_y = f64::from(canvas.1);

    for annotation in scaled {
        if annotation.annotation_type == AnnotationType::Mask {
            continue;
        }
        let left = annotation.x.min(annotation.x + annotation.width);
        let right = annotation.x.max(annotation.x + annotation.width);
        let top = annotation.y.min(annotation.y + annotation.height);
        let bottom = annotation.y.max(annotation.y + annotation.height);
        min_x = min_x.min(left);
        max_x = max_x.max(right);
        min_y = min_y.min(top);
        max_y = max_y.max(bottom);
    }

    ExportBounds {
        min_x,
        min_y,
        width: ((max_x - min_x).round() as i64).max(1) as u32,
        height: ((max_y - min_y).round() as i64).max(1) as u32,
    }
}

/// The whole canvas pass. Faithfully in the source's order: masks from an
/// unmodified copy of the frame, then the shape/text draw, then the expanded
/// output canvas -- white-filled unless the background is invisible -- with
/// the working canvas blitted at `(-minX, -minY)`.
///
/// Two deliberate matches of the source's own quirks: annotations are drawn
/// onto the *frame-sized* working canvas, so the parts dragged past the frame
/// are clipped there and the union expansion only pads the margins (that is
/// what `drawAnnotations(ctx, ..)` before the final `drawImage` does); and the
/// blit offset is rounded to a whole pixel where the browser would resample at
/// a fractional one.
pub fn composite(raw: &RawFrame, config: &ProjectConfiguration) -> Composited {
    let width = raw.width.max(1);
    let height = raw.height.max(1);
    let scale_x = f64::from(width) / f64::from(raw.base_width.max(1));
    let scale_y = f64::from(height) / f64::from(raw.base_height.max(1));
    let scaled = scale_annotations(&config.annotations, scale_x, scale_y);

    let mut canvas = raw.rgba.clone();

    // `applyMaskAnnotations(ctx, sourceCanvas, .., {x:0,y:0,w,h})` -- every
    // mask samples the untouched `raw.rgba`, so overlapping masks never
    // re-filter each other's output.
    let full = Rect {
        x: 0.,
        y: 0.,
        width: f64::from(width),
        height: f64::from(height),
    };
    for mask in &scaled {
        if mask.annotation_type != AnnotationType::Mask {
            continue;
        }
        if let Some((x0, y0, region)) =
            annotations::masked_region_image(&raw.rgba, (width, height), mask, full)
        {
            blit_over(&mut canvas, (width, height), &region, (x0, y0));
        }
    }

    draw_annotations_onto(&mut canvas, width, height, &scaled);

    let bounds = export_bounds(&scaled, (width, height));
    let mut out = vec![0u8; bounds.width as usize * bounds.height as usize * 4];
    if !has_no_visible_background(&config.background.source) {
        out.fill(255);
    }
    let offset = (
        (-bounds.min_x).round() as i64,
        (-bounds.min_y).round() as i64,
    );
    blit_over_offset(
        &mut out,
        (bounds.width, bounds.height),
        &canvas,
        (width, height),
        offset,
    );

    Composited {
        rgba: out,
        width: bounds.width,
        height: bounds.height,
    }
}

// ---------------------------------------------------------------------------
// Transparency + encodings (`canvasNeedsTransparency`, `exportImage`)
// ---------------------------------------------------------------------------

/// `canvasNeedsTransparency` (`screenshotExport.ts:356-371`): only a project
/// whose background is invisible can need alpha at all, and only then is the
/// output actually scanned.
pub fn needs_transparency(out: &Composited, config: &ProjectConfiguration) -> bool {
    if !has_no_visible_background(&config.background.source) {
        return false;
    }
    out.rgba
        .iter()
        .skip(3)
        .step_by(4)
        .any(|&alpha| alpha != 255)
}

/// `withWhiteBackground` (`useScreenshotExport.ts:18-28`).
pub fn flatten_onto_white(out: &Composited) -> Composited {
    let mut rgba = vec![255u8; out.rgba.len()];
    blit_over_offset(
        &mut rgba,
        (out.width, out.height),
        &out.rgba,
        (out.width, out.height),
        (0, 0),
    );
    Composited {
        rgba,
        width: out.width,
        height: out.height,
    }
}

/// The one PNG encode every destination shares -- and the Phase 1-2 "styled
/// frame straight to PNG" path, still callable through
/// `screenshot_editor::render_export_png`.
pub fn encode_rgba_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    use image::ImageEncoder as _;
    let mut png = std::io::Cursor::new(Vec::new());
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("Failed to encode screenshot export: {e}"))?;
    Ok(png.into_inner())
}

fn encode_png(out: &Composited) -> Result<Vec<u8>, String> {
    encode_rgba_png(&out.rgba, out.width, out.height)
}

/// `canvasToBlob(canvas, "image/jpeg", 0.9)`. JPEG has no alpha channel; the
/// share flow only ever picks it when the output is fully opaque, and the
/// flatten here is the same belt the browser's own encode wears.
fn encode_jpeg(out: &Composited) -> Result<Vec<u8>, String> {
    let flat = flatten_onto_white(out);
    let rgb: Vec<u8> = flat
        .rgba
        .chunks_exact(4)
        .flat_map(|px| [px[0], px[1], px[2]])
        .collect();
    let mut buffer = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 90)
        .encode(
            &rgb,
            flat.width,
            flat.height,
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("Failed to encode screenshot export: {e}"))?;
    Ok(buffer)
}

/// An encoded export, tagged with the content type the upload sends.
pub enum EncodedImage {
    Png(Vec<u8>),
    Jpeg(Vec<u8>),
}

impl EncodedImage {
    pub fn content_type(&self) -> &'static str {
        match self {
            Self::Png(_) => "image/png",
            Self::Jpeg(_) => "image/jpeg",
        }
    }

    pub fn into_bytes(self) -> Vec<u8> {
        match self {
            Self::Png(bytes) | Self::Jpeg(bytes) => bytes,
        }
    }
}

/// Share: JPEG at 0.9 unless the output needs its alpha, then PNG
/// (`useScreenshotExport.ts:191-198`).
pub fn encode_for_share(
    out: &Composited,
    config: &ProjectConfiguration,
) -> Result<EncodedImage, String> {
    if needs_transparency(out, config) {
        encode_png(out).map(EncodedImage::Png)
    } else {
        encode_jpeg(out).map(EncodedImage::Jpeg)
    }
}

/// Copy: always PNG, composited over white when transparency is not needed
/// (`:183-198` -- `withWhiteBackground` only on the clipboard path).
pub fn encode_for_copy(out: &Composited, config: &ProjectConfiguration) -> Result<Vec<u8>, String> {
    if needs_transparency(out, config) {
        encode_png(out)
    } else {
        encode_png(&flatten_onto_white(out))
    }
}

/// Save: PNG of the output canvas as it stands (`:198` -- no transparency
/// check and no white pass on the file path).
pub fn encode_for_save(out: &Composited) -> Result<Vec<u8>, String> {
    encode_png(out)
}

// ---------------------------------------------------------------------------
// The share fingerprint (`screenshotProjectFingerprint`)
// ---------------------------------------------------------------------------

/// `stableValue` (`screenshotExport.ts:373-392`): arrays element-wise, objects
/// rebuilt with their keys sorted, everything else as-is. serde's skip
/// attributes have already dropped the `None`s JS would have dropped as
/// `undefined`.
fn stable_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(stable_value).collect())
        }
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut sorted = serde_json::Map::new();
            for key in keys {
                sorted.insert(key.clone(), stable_value(&map[key]));
            }
            serde_json::Value::Object(sorted)
        }
        other => other.clone(),
    }
}

fn stable_stringify(value: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string(&stable_value(value))
        .map_err(|e| format!("Failed to serialize screenshot config: {e}"))
}

/// The content hash the share flow compares against `sharing.contentHash`:
/// the key-sorted config JSON, annotations included, SHA-256'd. Stable across
/// runs of this app -- which is the contract; a hash minted by the Tauri app
/// simply misses and re-uploads against the same video id.
pub fn content_hash(config: &ProjectConfiguration) -> Result<String, String> {
    use sha2::Digest as _;
    let value = serde_json::to_value(config)
        .map_err(|e| format!("Failed to serialize screenshot config: {e}"))?;
    let payload = stable_stringify(&value)?;
    let digest = sha2::Sha256::digest(payload.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(format!("sha256:{hex}"))
}

// ---------------------------------------------------------------------------
// Pixel plumbing
// ---------------------------------------------------------------------------

/// Straight-alpha source-over of one pixel -- what `drawImage` does.
fn blend_pixel_over(dst: &mut [u8], src: [u8; 4]) {
    if src[3] == 0 {
        return;
    }
    if src[3] == 255 {
        dst.copy_from_slice(&src);
        return;
    }
    let sa = f32::from(src[3]) / 255.;
    let da = f32::from(dst[3]) / 255.;
    let oa = sa + da * (1. - sa);
    if oa <= 0. {
        dst.fill(0);
        return;
    }
    for channel in 0..3 {
        let s = f32::from(src[channel]);
        let d = f32::from(dst[channel]);
        dst[channel] = ((s * sa + d * da * (1. - sa)) / oa).round().clamp(0., 255.) as u8;
    }
    dst[3] = (oa * 255.).round() as u8;
}

/// Source-over blit of a filtered mask region into the working canvas.
fn blit_over(canvas: &mut [u8], size: (u32, u32), region: &image::RgbaImage, at: (u32, u32)) {
    let stride = size.0 as usize * 4;
    for (row_index, row) in region.rows().enumerate() {
        let y = at.1 as usize + row_index;
        if y >= size.1 as usize {
            break;
        }
        for (column_index, pixel) in row.enumerate() {
            let x = at.0 as usize + column_index;
            if x >= size.0 as usize {
                break;
            }
            let start = y * stride + x * 4;
            blend_pixel_over(&mut canvas[start..start + 4], pixel.0);
        }
    }
}

/// Source-over blit of one straight-alpha buffer into another at a (possibly
/// negative) offset, clipping to the destination.
fn blit_over_offset(
    dst: &mut [u8],
    dst_size: (u32, u32),
    src: &[u8],
    src_size: (u32, u32),
    offset: (i64, i64),
) {
    let dst_stride = dst_size.0 as usize * 4;
    let src_stride = src_size.0 as usize * 4;
    for src_y in 0..src_size.1 as i64 {
        let dst_y = src_y + offset.1;
        if dst_y < 0 || dst_y >= i64::from(dst_size.1) {
            continue;
        }
        for src_x in 0..src_size.0 as i64 {
            let dst_x = src_x + offset.0;
            if dst_x < 0 || dst_x >= i64::from(dst_size.0) {
                continue;
            }
            let src_start = src_y as usize * src_stride + src_x as usize * 4;
            let dst_start = dst_y as usize * dst_stride + dst_x as usize * 4;
            let pixel = [
                src[src_start],
                src[src_start + 1],
                src[src_start + 2],
                src[src_start + 3],
            ];
            blend_pixel_over(&mut dst[dst_start..dst_start + 4], pixel);
        }
    }
}

/// `(c * a + 127) / 255` rounding both ways -- the standard integer
/// premultiply pair. tiny-skia's pixmaps are premultiplied, our canvases are
/// straight, so the draw pass converts in and back out.
fn premultiply(rgba: &mut [u8]) {
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = u16::from(pixel[3]);
        if alpha == 255 {
            continue;
        }
        for channel in 0..3 {
            pixel[channel] = ((u16::from(pixel[channel]) * alpha + 127) / 255) as u8;
        }
    }
}

fn demultiply(rgba: &mut [u8]) {
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = u32::from(pixel[3]);
        if alpha == 255 || alpha == 0 {
            continue;
        }
        for channel in 0..3 {
            let value = (u32::from(pixel[channel]) * 255 + alpha / 2) / alpha;
            pixel[channel] = value.min(255) as u8;
        }
    }
}

// ---------------------------------------------------------------------------
// The shape draw (`drawAnnotations`, `screenshotExport.ts:42-121`)
// ---------------------------------------------------------------------------

fn skia_color(rgb: [u8; 3], alpha: f32) -> Option<tiny_skia::Color> {
    tiny_skia::Color::from_rgba(
        f32::from(rgb[0]) / 255.,
        f32::from(rgb[1]) / 255.,
        f32::from(rgb[2]) / 255.,
        alpha.clamp(0., 1.),
    )
}

fn skia_paint(color: tiny_skia::Color) -> tiny_skia::Paint<'static> {
    let mut paint = tiny_skia::Paint::default();
    paint.set_color(color);
    paint.anti_alias = true;
    paint
}

/// `ctx.lineWidth` semantics: canvas' default join is miter with limit 10.
fn skia_stroke(width: f64, round: bool) -> tiny_skia::Stroke {
    tiny_skia::Stroke {
        width: width.max(0.) as f32,
        miter_limit: 10.,
        line_cap: if round {
            tiny_skia::LineCap::Round
        } else {
            tiny_skia::LineCap::Butt
        },
        line_join: if round {
            tiny_skia::LineJoin::Round
        } else {
            tiny_skia::LineJoin::Miter
        },
        dash: None,
    }
}

/// Draw every non-mask annotation onto the straight-alpha canvas, in list
/// order -- rect, ellipse, arrow, freehand with tiny-skia, text with
/// cosmic-text, each under its own `globalAlpha`.
fn draw_annotations_onto(canvas: &mut [u8], width: u32, height: u32, scaled: &[Annotation]) {
    premultiply(canvas);
    if let Some(mut pixmap) = tiny_skia::PixmapMut::from_bytes(canvas, width, height) {
        for annotation in scaled {
            if annotation.annotation_type == AnnotationType::Mask {
                continue;
            }
            draw_one(&mut pixmap, annotation);
        }
    }
    demultiply(canvas);
}

fn draw_one(pixmap: &mut tiny_skia::PixmapMut<'_>, annotation: &Annotation) {
    let stroke_color = annotations::parse_css_rgba(&annotation.stroke_color, annotation.opacity);
    let fill_color = annotations::parse_css_rgba(&annotation.fill_color, annotation.opacity);
    let transform = tiny_skia::Transform::identity();

    match annotation.annotation_type {
        AnnotationType::Mask => {}
        AnnotationType::Rectangle => {
            let rect = annotations::normalized_rect(annotation);
            let Some(skia_rect) = tiny_skia::Rect::from_xywh(
                rect.x as f32,
                rect.y as f32,
                (rect.width as f32).max(f32::EPSILON),
                (rect.height as f32).max(f32::EPSILON),
            ) else {
                return;
            };
            let path = {
                let mut builder = tiny_skia::PathBuilder::new();
                builder.push_rect(skia_rect);
                builder.finish()
            };
            let Some(path) = path else { return };
            if let Some(color) = fill_color.and_then(|(rgb, a)| skia_color(rgb, a)) {
                pixmap.fill_path(
                    &path,
                    &skia_paint(color),
                    tiny_skia::FillRule::Winding,
                    transform,
                    None,
                );
            }
            if let Some(color) = stroke_color.and_then(|(rgb, a)| skia_color(rgb, a))
                && annotation.stroke_width > 0.
            {
                pixmap.stroke_path(
                    &path,
                    &skia_paint(color),
                    &skia_stroke(annotation.stroke_width, false),
                    transform,
                    None,
                );
            }
        }
        AnnotationType::Circle => {
            let rect = annotations::normalized_rect(annotation);
            // The preview's own guard: SVG (and the canvas) render nothing for
            // a zero radius.
            if rect.width <= 0. || rect.height <= 0. {
                return;
            }
            let Some(oval) = tiny_skia::Rect::from_xywh(
                rect.x as f32,
                rect.y as f32,
                rect.width as f32,
                rect.height as f32,
            ) else {
                return;
            };
            let path = {
                let mut builder = tiny_skia::PathBuilder::new();
                builder.push_oval(oval);
                builder.finish()
            };
            let Some(path) = path else { return };
            if let Some(color) = fill_color.and_then(|(rgb, a)| skia_color(rgb, a)) {
                pixmap.fill_path(
                    &path,
                    &skia_paint(color),
                    tiny_skia::FillRule::Winding,
                    transform,
                    None,
                );
            }
            if let Some(color) = stroke_color.and_then(|(rgb, a)| skia_color(rgb, a))
                && annotation.stroke_width > 0.
            {
                pixmap.stroke_path(
                    &path,
                    &skia_paint(color),
                    &skia_stroke(annotation.stroke_width, false),
                    transform,
                    None,
                );
            }
        }
        AnnotationType::Arrow => {
            let Some(color) = stroke_color.and_then(|(rgb, a)| skia_color(rgb, a)) else {
                return;
            };
            let end = (
                annotation.x + annotation.width,
                annotation.y + annotation.height,
            );
            let angle = (end.1 - annotation.y).atan2(end.0 - annotation.x);
            let head = annotations::arrow_head_points(end.0, end.1, angle, annotation.stroke_width);
            if annotation.stroke_width > 0. {
                let mut builder = tiny_skia::PathBuilder::new();
                builder.move_to(annotation.x as f32, annotation.y as f32);
                builder.line_to(head.base.0 as f32, head.base.1 as f32);
                if let Some(path) = builder.finish() {
                    pixmap.stroke_path(
                        &path,
                        &skia_paint(color),
                        &skia_stroke(annotation.stroke_width, true),
                        transform,
                        None,
                    );
                }
            }
            let mut builder = tiny_skia::PathBuilder::new();
            builder.move_to(head.points[0].0 as f32, head.points[0].1 as f32);
            builder.line_to(head.points[1].0 as f32, head.points[1].1 as f32);
            builder.line_to(head.points[2].0 as f32, head.points[2].1 as f32);
            builder.close();
            if let Some(path) = builder.finish() {
                pixmap.fill_path(
                    &path,
                    &skia_paint(color),
                    tiny_skia::FillRule::Winding,
                    transform,
                    None,
                );
            }
        }
        AnnotationType::Draw => {
            let Some(color) = stroke_color.and_then(|(rgb, a)| skia_color(rgb, a)) else {
                return;
            };
            if annotation.stroke_width <= 0. {
                return;
            }
            let points = annotations::draw_points(annotation);
            if points.len() < 2 {
                return;
            }
            let segments = annotations::smooth_path(&points);
            let mut builder = tiny_skia::PathBuilder::new();
            for segment in &segments {
                match *segment {
                    annotations::PathSegment::Move { x, y } => builder.move_to(x as f32, y as f32),
                    annotations::PathSegment::Line { x, y } => builder.line_to(x as f32, y as f32),
                    annotations::PathSegment::Quad { cx, cy, x, y } => {
                        builder.quad_to(cx as f32, cy as f32, x as f32, y as f32)
                    }
                }
            }
            if let Some(path) = builder.finish() {
                pixmap.stroke_path(
                    &path,
                    &skia_paint(color),
                    &skia_stroke(annotation.stroke_width, true),
                    transform,
                    None,
                );
            }
        }
        AnnotationType::Text => draw_text(pixmap, annotation),
    }
}

// ---------------------------------------------------------------------------
// Text (`ctx.font = `${ann.height}px sans-serif``, `:113-117`)
// ---------------------------------------------------------------------------

/// One process-wide font system: `FontSystem::new` walks the installed font
/// database, which is far too slow to redo per export.
static TEXT_STACK: OnceLock<Mutex<(cosmic_text::FontSystem, cosmic_text::SwashCache)>> =
    OnceLock::new();

/// `<text>` at `font-size = height`, baseline at `y + height`, filled with the
/// stroke colour -- the same placement the preview's `paint_text` resolves,
/// down to the Helvetica the renderer maps `sans-serif` to.
fn draw_text(pixmap: &mut tiny_skia::PixmapMut<'_>, annotation: &Annotation) {
    let Some(text) = annotation.text.as_deref().filter(|text| !text.is_empty()) else {
        return;
    };
    let Some((rgb, alpha)) =
        annotations::parse_css_rgba(&annotation.stroke_color, annotation.opacity)
    else {
        return;
    };
    let font_size = (annotation.height as f32).max(1.);
    // One line, like the preview: a stray newline becomes a space.
    let text = text.replace('\n', " ");

    let stack = TEXT_STACK.get_or_init(|| {
        Mutex::new((
            cosmic_text::FontSystem::new(),
            cosmic_text::SwashCache::new(),
        ))
    });
    let mut guard = match stack.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let (font_system, swash_cache) = &mut *guard;

    let mut buffer =
        cosmic_text::Buffer::new(font_system, cosmic_text::Metrics::new(font_size, font_size));
    buffer.set_size(font_system, None, None);
    let attrs = cosmic_text::Attrs::new().family(cosmic_text::Family::Name(annotations::TEXT_FONT));
    buffer.set_text(font_system, &text, &attrs, cosmic_text::Shaping::Advanced);
    buffer.shape_until_scroll(font_system, false);

    // The buffer's own baseline, cancelled out so ours lands exactly at
    // `y + height`.
    let line_y = buffer
        .layout_runs()
        .next()
        .map(|run| run.line_y)
        .unwrap_or(font_size);
    let origin_x = annotation.x;
    let origin_y = annotation.y + annotation.height - f64::from(line_y);

    let color = cosmic_text::Color::rgba(rgb[0], rgb[1], rgb[2], (alpha * 255.).round() as u8);
    let (canvas_width, canvas_height) = (pixmap.width(), pixmap.height());
    let data = pixmap.data_mut();
    buffer.draw(font_system, swash_cache, color, |x, y, w, h, pixel| {
        blend_rect_premultiplied(
            data,
            (canvas_width, canvas_height),
            (origin_x + f64::from(x), origin_y + f64::from(y)),
            (w, h),
            pixel,
        );
    });
}

/// Premultiplied source-over of one glyph-coverage rect (cosmic-text hands
/// back the coverage folded into the colour's alpha).
fn blend_rect_premultiplied(
    data: &mut [u8],
    size: (u32, u32),
    at: (f64, f64),
    rect: (u32, u32),
    color: cosmic_text::Color,
) {
    let alpha = f32::from(color.a()) / 255.;
    if alpha <= 0. {
        return;
    }
    let src = [
        (f32::from(color.r()) * alpha).round() as u8,
        (f32::from(color.g()) * alpha).round() as u8,
        (f32::from(color.b()) * alpha).round() as u8,
        color.a(),
    ];
    let inverse = 1. - alpha;
    let stride = size.0 as usize * 4;
    let x0 = at.0.round() as i64;
    let y0 = at.1.round() as i64;
    for row in 0..i64::from(rect.1) {
        let y = y0 + row;
        if y < 0 || y >= i64::from(size.1) {
            continue;
        }
        for column in 0..i64::from(rect.0) {
            let x = x0 + column;
            if x < 0 || x >= i64::from(size.0) {
                continue;
            }
            let start = y as usize * stride + x as usize * 4;
            for channel in 0..4 {
                let d = f32::from(data[start + channel]);
                data[start + channel] =
                    (f32::from(src[channel]) + d * inverse).round().min(255.) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::BackgroundSource;
    use serde_json::json;

    fn annotation(kind: AnnotationType, x: f64, y: f64, w: f64, h: f64) -> Annotation {
        Annotation {
            id: "a".into(),
            annotation_type: kind,
            x,
            y,
            width: w,
            height: h,
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

    fn invisible_background(config: &mut ProjectConfiguration) {
        config.background.source = BackgroundSource::Color {
            value: [0, 0, 0],
            alpha: 0,
        };
    }

    /// `stableValue`: keys sorted at every depth, arrays kept in order.
    #[test]
    fn stable_stringify_sorts_keys_recursively() {
        let value = json!({
            "zeta": { "b": 1, "a": [ { "y": 2, "x": 1 } ] },
            "alpha": 3,
        });
        assert_eq!(
            stable_stringify(&value).unwrap(),
            r#"{"alpha":3,"zeta":{"a":[{"x":1,"y":2}],"b":1}}"#
        );
    }

    /// The fingerprint is stable for the same config and moves when an
    /// annotation moves -- which is what decides re-upload vs copied link.
    #[test]
    fn content_hash_is_stable_and_annotation_sensitive() {
        let mut config = ProjectConfiguration::default();
        config
            .annotations
            .push(annotation(AnnotationType::Rectangle, 10., 10., 40., 20.));
        let first = content_hash(&config).unwrap();
        let again = content_hash(&config).unwrap();
        assert_eq!(first, again);
        assert!(first.starts_with("sha256:"));
        assert_eq!(first.len(), "sha256:".len() + 64);

        config.annotations[0].x = 11.;
        assert_ne!(content_hash(&config).unwrap(), first);
    }

    /// `scaleAnnotations`: x/w by the x factor, y/h by the y factor,
    /// strokeWidth and maskLevel by the average, points untouched.
    #[test]
    fn scale_annotations_uses_axis_factors_and_the_average_scalar() {
        let mut mask = annotation(AnnotationType::Mask, 10., 20., 30., 40.);
        mask.mask_level = Some(8.);
        let mut stroke = annotation(AnnotationType::Draw, 1., 2., 3., 4.);
        stroke.points = Some(vec![[0.25, 0.75]]);

        let scaled = scale_annotations(&[mask, stroke], 2., 4.);
        assert_eq!(
            (scaled[0].x, scaled[0].y, scaled[0].width, scaled[0].height),
            (20., 80., 60., 160.)
        );
        assert_eq!(scaled[0].stroke_width, 12.); // 4 * (2+4)/2
        assert_eq!(scaled[0].mask_level, Some(24.)); // 8 * 3
        assert_eq!(scaled[1].mask_level, None);
        assert_eq!(scaled[1].points, Some(vec![[0.25, 0.75]]));
    }

    /// The union expansion: annotations dragged past the frame stretch the
    /// output, negative boxes normalize first, and masks never count.
    #[test]
    fn export_bounds_unions_the_canvas_with_non_mask_annotations() {
        let inside = annotation(AnnotationType::Rectangle, 10., 10., 20., 20.);
        assert_eq!(
            export_bounds(&[inside], (100, 50)),
            ExportBounds {
                min_x: 0.,
                min_y: 0.,
                width: 100,
                height: 50
            }
        );

        let overflowing = annotation(AnnotationType::Arrow, 90., -10., 30., 15.);
        let bounds = export_bounds(&[overflowing], (100, 50));
        assert_eq!((bounds.min_x, bounds.min_y), (0., -10.));
        assert_eq!((bounds.width, bounds.height), (120, 60));

        let negative = annotation(AnnotationType::Rectangle, -5., 0., -10., 10.);
        let bounds = export_bounds(&[negative], (100, 50));
        assert_eq!(bounds.min_x, -15.);
        assert_eq!(bounds.width, 115);

        let mask = annotation(AnnotationType::Mask, -50., -50., 300., 300.);
        assert_eq!(
            export_bounds(&[mask], (100, 50)),
            ExportBounds {
                min_x: 0.,
                min_y: 0.,
                width: 100,
                height: 50
            }
        );
    }

    /// `canvasNeedsTransparency`: a visible background short-circuits to
    /// false; an invisible one scans the actual alpha.
    #[test]
    fn transparency_is_only_needed_when_the_background_is_invisible_and_alpha_shows() {
        let opaque = Composited {
            rgba: vec![255, 0, 0, 255, 0, 255, 0, 255],
            width: 2,
            height: 1,
        };
        let translucent = Composited {
            rgba: vec![255, 0, 0, 255, 0, 255, 0, 128],
            width: 2,
            height: 1,
        };

        let visible = ProjectConfiguration::default();
        assert!(!needs_transparency(&translucent, &visible));

        let mut invisible = ProjectConfiguration::default();
        invisible_background(&mut invisible);
        assert!(!needs_transparency(&opaque, &invisible));
        assert!(needs_transparency(&translucent, &invisible));
    }

    /// The share encoding: PNG only when the output needs its alpha, JPEG
    /// otherwise; Copy flattens onto white first.
    #[test]
    fn share_picks_jpeg_unless_alpha_is_needed_and_copy_flattens() {
        let translucent = Composited {
            rgba: vec![255, 0, 0, 128],
            width: 1,
            height: 1,
        };

        let visible = ProjectConfiguration::default();
        assert!(matches!(
            encode_for_share(&translucent, &visible).unwrap(),
            EncodedImage::Jpeg(_)
        ));

        let mut invisible = ProjectConfiguration::default();
        invisible_background(&mut invisible);
        assert!(matches!(
            encode_for_share(&translucent, &invisible).unwrap(),
            EncodedImage::Png(_)
        ));

        // Copy over a visible background composites onto white: decoding the
        // PNG back shows the half-red pixel blended with white.
        let png = encode_for_copy(&translucent, &visible).unwrap();
        let decoded = image::load_from_memory(&png).unwrap().to_rgba8();
        let pixel = decoded.get_pixel(0, 0).0;
        assert_eq!(pixel[3], 255);
        assert_eq!(pixel[0], 255);
        assert!(pixel[1] >= 127 && pixel[1] <= 128, "{pixel:?}");
    }

    /// `withWhiteBackground` leaves an opaque canvas untouched.
    #[test]
    fn flattening_an_opaque_canvas_is_the_identity() {
        let out = Composited {
            rgba: vec![10, 20, 30, 255, 40, 50, 60, 255],
            width: 2,
            height: 1,
        };
        assert_eq!(flatten_onto_white(&out).rgba, out.rgba);
    }

    /// A composite with no annotations is the frame itself over the white
    /// output canvas, and an annotation past the edge pads the output --
    /// matching the source, the part outside the frame is clipped by the
    /// working canvas, so the pad is background-coloured.
    #[test]
    fn composite_passes_the_frame_through_and_pads_for_overflow() {
        let raw = RawFrame {
            rgba: [0u8, 0, 255, 255].repeat(16), // 4x4 solid blue
            width: 4,
            height: 4,
            base_width: 4,
            base_height: 4,
        };
        let config = ProjectConfiguration::default();
        let out = composite(&raw, &config);
        assert_eq!((out.width, out.height), (4, 4));
        assert_eq!(&out.rgba[..4], &[0, 0, 255, 255]);

        // A rectangle hanging entirely past the right edge: its stroke band
        // (x 4..12 at width 4) misses the 4px working canvas, so -- like the
        // source -- the expansion pads white with nothing drawn in it.
        let mut with_overflow = ProjectConfiguration::default();
        with_overflow
            .annotations
            .push(annotation(AnnotationType::Rectangle, 6., 0., 4., 4.));
        let out = composite(&raw, &with_overflow);
        assert_eq!((out.width, out.height), (10, 4));
        // Column 0 is still the frame's blue...
        assert_eq!(&out.rgba[..4], &[0, 0, 255, 255]);
        // ...and the padded margin past the frame is the white fill.
        let margin = 9 * 4;
        assert_eq!(&out.rgba[margin..margin + 4], &[255, 255, 255, 255]);
    }

    /// Premultiply/demultiply round-trips opaque pixels exactly; a fully
    /// transparent pixel's colour is unrecoverable by definition and zeroes.
    #[test]
    fn premultiply_roundtrip_is_exact_for_opaque_pixels() {
        let mut rgba = vec![13, 200, 91, 255, 1, 2, 3, 0];
        premultiply(&mut rgba);
        demultiply(&mut rgba);
        assert_eq!(rgba, vec![13, 200, 91, 255, 0, 0, 0, 0]);
    }
}
