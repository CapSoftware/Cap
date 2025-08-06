use gif::{Encoder, Frame, Repeat};
use std::fs::File;
use std::path::Path;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum GifEncodingError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("GIF encoding error: {0}")]
    Gif(#[from] gif::EncodingError),
    #[error("Invalid frame data")]
    InvalidFrameData,
}

pub struct GifEncoderWrapper {
    encoder: Encoder<File>,
    width: u16,
    height: u16,
    frame_delay: u16,
}

impl GifEncoderWrapper {
    pub fn new<P: AsRef<Path>>(
        path: P,
        width: u32,
        height: u32,
        fps: u32,
    ) -> Result<Self, GifEncodingError> {
        let file = File::create(path)?;

        let global_palette = create_default_palette();
        let mut encoder = Encoder::new(file, width as u16, height as u16, &global_palette)?;
        encoder.set_repeat(Repeat::Infinite)?;

        let frame_delay = (100.0 / fps as f32) as u16;

        Ok(Self {
            encoder,
            width: width as u16,
            height: height as u16,
            frame_delay,
        })
    }

    pub fn add_frame(
        &mut self,
        frame_data: &[u8],
        padded_bytes_per_row: usize,
    ) -> Result<(), GifEncodingError> {
        let width = self.width as usize;
        let height = self.height as usize;
        let mut indexed_data = Vec::with_capacity(width * height);

        let mut rgb_data = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            let row_start = y * padded_bytes_per_row;
            for x in 0..width {
                let pixel_start = row_start + x * 4;
                if pixel_start + 2 < frame_data.len() {
                    rgb_data.push(frame_data[pixel_start] as i32);
                    rgb_data.push(frame_data[pixel_start + 1] as i32);
                    rgb_data.push(frame_data[pixel_start + 2] as i32);
                } else {
                    return Err(GifEncodingError::InvalidFrameData);
                }
            }
        }

        for y in 0..height {
            for x in 0..width {
                let idx = (y * width + x) * 3;
                let r = rgb_data[idx].clamp(0, 255) as u8;
                let g = rgb_data[idx + 1].clamp(0, 255) as u8;
                let b = rgb_data[idx + 2].clamp(0, 255) as u8;

                let palette_idx = find_closest_palette_index(r, g, b);
                indexed_data.push(palette_idx);

                let (pr, pg, pb) = get_palette_color(palette_idx);

                let er = r as i32 - pr as i32;
                let eg = g as i32 - pg as i32;
                let eb = b as i32 - pb as i32;

                if x + 1 < width {
                    let idx_right = (y * width + x + 1) * 3;
                    rgb_data[idx_right] += (er * 7) / 16;
                    rgb_data[idx_right + 1] += (eg * 7) / 16;
                    rgb_data[idx_right + 2] += (eb * 7) / 16;
                }
                if y + 1 < height {
                    if x > 0 {
                        let idx_bottom_left = ((y + 1) * width + x - 1) * 3;
                        rgb_data[idx_bottom_left] += (er * 3) / 16;
                        rgb_data[idx_bottom_left + 1] += (eg * 3) / 16;
                        rgb_data[idx_bottom_left + 2] += (eb * 3) / 16;
                    }
                    let idx_bottom = ((y + 1) * width + x) * 3;
                    rgb_data[idx_bottom] += (er * 5) / 16;
                    rgb_data[idx_bottom + 1] += (eg * 5) / 16;
                    rgb_data[idx_bottom + 2] += (eb * 5) / 16;

                    if x + 1 < width {
                        let idx_bottom_right = ((y + 1) * width + x + 1) * 3;
                        rgb_data[idx_bottom_right] += er / 16;
                        rgb_data[idx_bottom_right + 1] += eg / 16;
                        rgb_data[idx_bottom_right + 2] += eb / 16;
                    }
                }
            }
        }

        let mut frame = Frame::from_indexed_pixels(self.width, self.height, indexed_data, None);
        frame.delay = self.frame_delay;

        self.encoder.write_frame(&frame)?;
        Ok(())
    }

    pub fn finish(self) -> Result<(), GifEncodingError> {
        drop(self.encoder);
        Ok(())
    }
}

fn create_default_palette() -> Vec<u8> {
    let mut palette = Vec::with_capacity(256 * 3);

    for r in 0..6 {
        for g in 0..7 {
            for b in 0..6 {
                palette.push((r * 255 / 5) as u8);
                palette.push((g * 255 / 6) as u8);
                palette.push((b * 255 / 5) as u8);
            }
        }
    }

    palette.push(0);
    palette.push(0);
    palette.push(0);
    palette.push(85);
    palette.push(85);
    palette.push(85);
    palette.push(170);
    palette.push(170);
    palette.push(170);
    palette.push(255);
    palette.push(255);
    palette.push(255);

    assert_eq!(palette.len(), 256 * 3, "Palette must be exactly 256 colors");
    palette
}

fn find_closest_palette_index(r: u8, g: u8, b: u8) -> u8 {
    let r_idx = ((r as u32 * 5) / 255).min(5) as u8;
    let g_idx = ((g as u32 * 6) / 255).min(6) as u8;
    let b_idx = ((b as u32 * 5) / 255).min(5) as u8;

    if (r as i32 - g as i32).abs() < 30
        && (g as i32 - b as i32).abs() < 30
        && (r as i32 - b as i32).abs() < 30
    {
        let gray = ((r as u32 + g as u32 + b as u32) / 3) as u8;
        if gray < 43 {
            return 252;
        } else if gray < 128 {
            return 253;
        } else if gray < 213 {
            return 254;
        } else {
            return 255;
        }
    }

    r_idx * 42 + g_idx * 6 + b_idx
}

fn get_palette_color(index: u8) -> (u8, u8, u8) {
    if index < 252 {
        let r_idx = (index / 42) as u32;
        let rem = index % 42;
        let g_idx = (rem / 6) as u32;
        let b_idx = (rem % 6) as u32;

        let r = ((r_idx * 255) / 5) as u8;
        let g = ((g_idx * 255) / 6) as u8;
        let b = ((b_idx * 255) / 5) as u8;
        (r, g, b)
    } else {
        match index {
            252 => (0, 0, 0),
            253 => (85, 85, 85),
            254 => (170, 170, 170),
            255 => (255, 255, 255),
            _ => (0, 0, 0),
        }
    }
}
