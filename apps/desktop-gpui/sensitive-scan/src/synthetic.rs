use ab_glyph::{Font, FontRef, PxScale, ScaleFont, point};

use crate::frame::{LumaFrame, Rect};

pub const SANS: &[u8] = include_bytes!("../../assets/fonts/Geist.ttf");

pub fn sans() -> FontRef<'static> {
    FontRef::try_from_slice(SANS).expect("bundled font")
}

pub struct Canvas {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl Canvas {
    pub fn new(width: u32, height: u32, background: u8) -> Self {
        Self {
            width,
            height,
            pixels: vec![background; width as usize * height as usize],
        }
    }

    pub fn fill(&mut self, rect: Rect, value: u8) {
        let x0 = rect.x0.max(0.0) as u32;
        let y0 = rect.y0.max(0.0) as u32;
        let x1 = (rect.x1.max(0.0) as u32).min(self.width);
        let y1 = (rect.y1.max(0.0) as u32).min(self.height);
        for y in y0..y1 {
            let row = (y * self.width) as usize;
            self.pixels[row + x0 as usize..row + x1 as usize].fill(value);
        }
    }

    pub fn text(
        &mut self,
        font: &FontRef,
        size: f32,
        x: f32,
        top: f32,
        text: &str,
        ink: u8,
    ) -> Rect {
        let scaled = font.as_scaled(PxScale::from(size));
        let baseline = top + scaled.ascent();
        let mut caret = x;
        let mut previous = None;
        for c in text.chars() {
            let id = scaled.glyph_id(c);
            if let Some(previous) = previous {
                caret += scaled.kern(previous, id);
            }
            let glyph = id.with_scale_and_position(PxScale::from(size), point(caret, baseline));
            caret += scaled.h_advance(id);
            previous = Some(id);
            let Some(outlined) = font.outline_glyph(glyph) else {
                continue;
            };
            let bounds = outlined.px_bounds();
            outlined.draw(|gx, gy, coverage| {
                let px = bounds.min.x as i32 + gx as i32;
                let py = bounds.min.y as i32 + gy as i32;
                if px < 0 || py < 0 || px as u32 >= self.width || py as u32 >= self.height {
                    return;
                }
                let index = py as usize * self.width as usize + px as usize;
                let background = f32::from(self.pixels[index]);
                let blended = background + (f32::from(ink) - background) * coverage.clamp(0.0, 1.0);
                self.pixels[index] = blended.round() as u8;
            });
        }
        Rect::new(x, top, caret, top + scaled.ascent() - scaled.descent())
    }

    pub fn view(
        &self,
        left: f32,
        top: f32,
        width: u32,
        height: u32,
        zoom: f32,
        background: u8,
    ) -> LumaFrame {
        let mut pixels = vec![background; width as usize * height as usize];
        for y in 0..height {
            for x in 0..width {
                let sx = left + (x as f32 - width as f32 / 2.0) / zoom + width as f32 / 2.0;
                let sy = top + (y as f32 - height as f32 / 2.0) / zoom + height as f32 / 2.0;
                let (ix, iy) = (sx.floor() as i64, sy.floor() as i64);
                if ix < 0
                    || iy < 0
                    || ix + 1 >= i64::from(self.width)
                    || iy + 1 >= i64::from(self.height)
                {
                    continue;
                }
                let (fx, fy) = (sx - ix as f32, sy - iy as f32);
                let at = |dx: i64, dy: i64| {
                    f32::from(self.pixels[((iy + dy) * i64::from(self.width) + ix + dx) as usize])
                };
                let value = at(0, 0) * (1.0 - fx) * (1.0 - fy)
                    + at(1, 0) * fx * (1.0 - fy)
                    + at(0, 1) * (1.0 - fx) * fy
                    + at(1, 1) * fx * fy;
                pixels[(y * width + x) as usize] = value.round() as u8;
            }
        }
        LumaFrame::new(width, height, pixels)
    }
}

pub fn view_rect(rect: Rect, left: f32, top: f32, width: u32, height: u32, zoom: f32) -> Rect {
    let (cx, cy) = (width as f32 / 2.0, height as f32 / 2.0);
    let map_x = |x: f32| (x - left - cx) * zoom + cx;
    let map_y = |y: f32| (y - top - cy) * zoom + cy;
    Rect::new(
        map_x(rect.x0),
        map_y(rect.y0),
        map_x(rect.x1),
        map_y(rect.y1),
    )
}

pub const PROSE: &[&str] = &[
    "Release notes for the billing dashboard and the new export queue",
    "Customers on the yearly plan can now switch seats from the admin page",
    "Our support team answers within one business day across time zones",
    "The webhook retries three times with exponential backoff before failing",
    "Pull requests need one approving review and a green build to merge",
    "Recording quality defaults to 1080p at 30 frames per second on laptops",
    "Invoices are generated on the first of each month in the account currency",
    "Use the command palette to jump between projects without the mouse",
    "Storage usage is calculated nightly and shown on the organization page",
    "We rotate on-call weekly and hand over every Monday at nine",
];
