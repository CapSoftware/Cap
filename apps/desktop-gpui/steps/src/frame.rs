use tiny_skia::{FillRule, Paint, PathBuilder, PixmapMut, Stroke, Transform};

use crate::{Point, Step};

const CROP_SHARE: f64 = 0.5;
const MIN_CROP_WIDTH: u32 = 960;
const CROP_ASPECT: f64 = 16.0 / 10.0;
const DRAG_MARGIN: f64 = 0.08;
const RING_SHARE: f64 = 0.022;
const MIN_RING_RADIUS: f64 = 14.0;
const HIGHLIGHT: [u8; 3] = [0x47, 0x85, 0xFF];
const HIGHLIGHT_FILL_ALPHA: u8 = 46;
const HALO_ALPHA: u8 = 230;
const HALO_WIDTH: f32 = 1.5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepImage {
    pub size: Size,
    pub rgba: Vec<u8>,
}

fn even_down(value: u32) -> u32 {
    value & !1
}

fn even_up(value: u32) -> u32 {
    value.saturating_add(1) & !1
}

pub fn crop_for(step: &Step, frame: Size) -> Rect {
    let whole = Rect {
        x: 0,
        y: 0,
        width: frame.width,
        height: frame.height,
    };
    let Some(from) = step.position else {
        return whole;
    };
    if frame.width < 2 || frame.height < 2 {
        return whole;
    }
    let to = step.drag_to.unwrap_or(from);
    let (frame_width, frame_height) = (f64::from(frame.width), f64::from(frame.height));
    let room = 1.0 - 2.0 * DRAG_MARGIN;
    let needed_width = ((from.x - to.x).abs() * frame_width / room).ceil();
    let needed_height = ((from.y - to.y).abs() * frame_height / room).ceil();

    let standard = ((frame_width * CROP_SHARE).round() as u32).max(MIN_CROP_WIDTH.min(frame.width));
    let width = even_up(
        standard
            .max(needed_width as u32)
            .max((needed_height * CROP_ASPECT).ceil() as u32),
    )
    .min(even_down(frame.width));
    let tall_enough =
        even_down((f64::from(width) / CROP_ASPECT) as u32).max(even_up(needed_height as u32));
    let height = tall_enough.min(even_down(frame.height));

    let centre_x = (from.x + to.x) / 2.0 * frame_width;
    let centre_y = (from.y + to.y) / 2.0 * frame_height;
    let place = |centre: f64, length: u32, limit: u32| {
        ((centre - f64::from(length) / 2.0).round().max(0.0) as u32).min(limit - length)
    };
    Rect {
        x: place(centre_x, width, frame.width),
        y: place(centre_y, height, frame.height),
        width,
        height,
    }
}

pub fn render_step_image(frame_rgba: &[u8], frame: Size, step: &Step) -> Option<StepImage> {
    let row_bytes = (frame.width as usize).checked_mul(4)?;
    let expected = row_bytes.checked_mul(frame.height as usize)?;
    if expected == 0 || frame_rgba.len() != expected {
        return None;
    }
    let crop = crop_for(step, frame);
    let mut rgba = Vec::with_capacity(crop.width as usize * crop.height as usize * 4);
    for row in crop.y..crop.y + crop.height {
        let start = row as usize * row_bytes + crop.x as usize * 4;
        rgba.extend_from_slice(&frame_rgba[start..start + crop.width as usize * 4]);
    }
    let mut image = StepImage {
        size: Size {
            width: crop.width,
            height: crop.height,
        },
        rgba,
    };
    if let Some(position) = step.position {
        let in_crop = |point: Point| {
            (
                (point.x * f64::from(frame.width) - f64::from(crop.x)) as f32,
                (point.y * f64::from(frame.height) - f64::from(crop.y)) as f32,
            )
        };
        highlight(&mut image, in_crop(position), step.drag_to.map(in_crop));
    }
    Some(image)
}

fn paint(alpha: u8, colour: [u8; 3]) -> Paint<'static> {
    let mut paint = Paint::default();
    paint.set_color_rgba8(colour[0], colour[1], colour[2], alpha);
    paint.anti_alias = true;
    paint
}

/// A ring that leaves what is inside it readable, with a pale edge so it
/// still shows on a blue interface.
fn highlight(image: &mut StepImage, centre: (f32, f32), drag_to: Option<(f32, f32)>) {
    let radius = (f64::from(image.size.width) * RING_SHARE).max(MIN_RING_RADIUS) as f32;
    let width = (radius * 0.25).max(4.0);
    let Some(mut pixmap) =
        PixmapMut::from_bytes(&mut image.rgba, image.size.width, image.size.height)
    else {
        return;
    };
    let Some(ring) = PathBuilder::from_circle(centre.0, centre.1, radius) else {
        return;
    };
    let identity = Transform::identity();
    if let Some(to) = drag_to {
        arrow(&mut pixmap, centre, to, radius, width);
    }
    pixmap.fill_path(
        &ring,
        &paint(HIGHLIGHT_FILL_ALPHA, HIGHLIGHT),
        FillRule::Winding,
        identity,
        None,
    );
    if let Some(edge) =
        PathBuilder::from_circle(centre.0, centre.1, radius + width / 2.0 + HALO_WIDTH / 2.0)
    {
        let stroke = Stroke {
            width: HALO_WIDTH,
            ..Stroke::default()
        };
        pixmap.stroke_path(&edge, &paint(HALO_ALPHA, [255; 3]), &stroke, identity, None);
    }
    let stroke = Stroke {
        width,
        ..Stroke::default()
    };
    pixmap.stroke_path(&ring, &paint(255, HIGHLIGHT), &stroke, identity, None);
}

fn arrow(pixmap: &mut PixmapMut, from: (f32, f32), to: (f32, f32), radius: f32, width: f32) {
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    let length = dx.hypot(dy);
    let head = width * 3.5;
    if length <= radius + head {
        return;
    }
    let (ux, uy) = (dx / length, dy / length);
    let neck = (to.0 - ux * head, to.1 - uy * head);
    let half = head * 0.6;

    let mut shaft = PathBuilder::new();
    shaft.move_to(from.0 + ux * radius, from.1 + uy * radius);
    shaft.line_to(neck.0, neck.1);
    let mut tip = PathBuilder::new();
    tip.move_to(to.0, to.1);
    tip.line_to(neck.0 - uy * half, neck.1 + ux * half);
    tip.line_to(neck.0 + uy * half, neck.1 - ux * half);
    tip.close();
    let (Some(shaft), Some(tip)) = (shaft.finish(), tip.finish()) else {
        return;
    };

    let identity = Transform::identity();
    let pale = paint(HALO_ALPHA, [255; 3]);
    let blue = paint(255, HIGHLIGHT);
    let edge = Stroke {
        width: width + HALO_WIDTH * 2.0,
        ..Stroke::default()
    };
    pixmap.stroke_path(&shaft, &pale, &edge, identity, None);
    let edge = Stroke {
        width: HALO_WIDTH * 2.0,
        ..Stroke::default()
    };
    pixmap.stroke_path(&tip, &pale, &edge, identity, None);
    let line = Stroke {
        width,
        ..Stroke::default()
    };
    pixmap.stroke_path(&shaft, &blue, &line, identity, None);
    pixmap.fill_path(&tip, &blue, FillRule::Winding, identity, None);
}

pub fn encode_png(image: &StepImage) -> Result<Vec<u8>, String> {
    use ::image::ImageEncoder;

    let mut png = Vec::new();
    ::image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            &image.rgba,
            image.size.width,
            image.size.height,
            ::image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| error.to_string())?;
    Ok(png)
}
