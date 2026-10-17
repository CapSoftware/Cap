use std::{hint::black_box, time::Instant};

mod baseline {
    pub fn is_opaque(rgba: &[u8]) -> bool {
        const ALPHA_MASK: u128 = 0xff000000ff000000ff000000ff000000;
        let mut blocks = rgba.chunks_exact(16);
        blocks
            .by_ref()
            .all(|block| u128::from_le_bytes(block.try_into().unwrap()) & ALPHA_MASK == ALPHA_MASK)
            && blocks
                .remainder()
                .iter()
                .skip(3)
                .step_by(4)
                .all(|&alpha| alpha == 255)
    }

    pub fn has_translucent_pixel(rgba: &[u8]) -> bool {
        rgba.iter().skip(3).step_by(4).any(|&alpha| alpha != 255)
    }

    pub fn flatten_onto_white(rgba: &[u8]) -> Vec<u8> {
        let mut rgba = rgba.to_vec();
        for pixel in rgba.chunks_exact_mut(4) {
            let alpha = u32::from(pixel[3]);
            for channel in &mut pixel[..3] {
                *channel = ((u32::from(*channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
            }
            pixel[3] = 255;
        }
        rgba
    }

    pub fn premultiply(rgba: &mut [u8]) {
        for pixel in rgba.chunks_exact_mut(4) {
            let alpha = u16::from(pixel[3]);
            if alpha == 255 {
                continue;
            }
            for channel in &mut pixel[..3] {
                *channel = ((u16::from(*channel) * alpha + 127) / 255) as u8;
            }
        }
    }

    pub fn demultiply(rgba: &mut [u8]) {
        for pixel in rgba.chunks_exact_mut(4) {
            let alpha = u32::from(pixel[3]);
            if alpha == 255 || alpha == 0 {
                continue;
            }
            for channel in &mut pixel[..3] {
                let value = (u32::from(*channel) * 255 + alpha / 2) / alpha;
                *channel = value.min(255) as u8;
            }
        }
    }
}

use cap_gpui_kernels::screenshot as candidate;

fn main() {
    println!("benchmark,workload,pixels,sample,before_ns,after_ns");

    for (name, width, height) in [
        ("1080p", 1920u32, 1080u32),
        ("retina", 3024, 1964),
        ("4k", 3840, 2160),
    ] {
        let num_pixels = (width * height) as usize;
        let mut opaque = Vec::with_capacity(num_pixels * 4);
        let mut mixed = Vec::with_capacity(num_pixels * 4);

        for i in 0..num_pixels {
            let r = (i * 7) as u8;
            let g = (i * 13) as u8;
            let b = (i * 31) as u8;
            opaque.extend_from_slice(&[r, g, b, 255]);
            let a = if i % 100 == 0 { (i % 256) as u8 } else { 255 };
            mixed.extend_from_slice(&[r, g, b, a]);
        }

        // 1. is_opaque on opaque buffer
        {
            let b = baseline::is_opaque(&opaque);
            let c = candidate::is_opaque(&opaque);
            assert_eq!(b, c);
            for sample in 0..20 {
                let start_o = Instant::now();
                black_box(baseline::is_opaque(black_box(&opaque)));
                let old_t = start_o.elapsed().as_nanos();

                let start_n = Instant::now();
                black_box(candidate::is_opaque(black_box(&opaque)));
                let new_t = start_n.elapsed().as_nanos();
                if sample >= 5 {
                    println!(
                        "is_opaque_solid,{name},{num_pixels},{},{old_t},{new_t}",
                        sample - 5
                    );
                }
            }
        }

        // 2. has_translucent_pixel on opaque buffer
        {
            let b = baseline::has_translucent_pixel(&opaque);
            let c = candidate::has_translucent_pixel(&opaque);
            assert_eq!(b, c);
            for sample in 0..20 {
                let start_o = Instant::now();
                black_box(baseline::has_translucent_pixel(black_box(&opaque)));
                let old_t = start_o.elapsed().as_nanos();

                let start_n = Instant::now();
                black_box(candidate::has_translucent_pixel(black_box(&opaque)));
                let new_t = start_n.elapsed().as_nanos();
                if sample >= 5 {
                    println!(
                        "has_translucent_solid,{name},{num_pixels},{},{old_t},{new_t}",
                        sample - 5
                    );
                }
            }
        }

        // 3. flatten_onto_white on opaque buffer
        {
            let b = baseline::flatten_onto_white(&opaque);
            let c = candidate::flatten_onto_white(&opaque);
            assert_eq!(b, c);
            for sample in 0..20 {
                let start_o = Instant::now();
                black_box(baseline::flatten_onto_white(black_box(&opaque)));
                let old_t = start_o.elapsed().as_nanos();

                let start_n = Instant::now();
                black_box(candidate::flatten_onto_white(black_box(&opaque)));
                let new_t = start_n.elapsed().as_nanos();
                if sample >= 5 {
                    println!(
                        "flatten_white_solid,{name},{num_pixels},{},{old_t},{new_t}",
                        sample - 5
                    );
                }
            }
        }

        // 4. flatten_onto_white on mixed buffer
        {
            let b = baseline::flatten_onto_white(&mixed);
            let c = candidate::flatten_onto_white(&mixed);
            assert_eq!(b, c);
            for sample in 0..20 {
                let start_o = Instant::now();
                black_box(baseline::flatten_onto_white(black_box(&mixed)));
                let old_t = start_o.elapsed().as_nanos();

                let start_n = Instant::now();
                black_box(candidate::flatten_onto_white(black_box(&mixed)));
                let new_t = start_n.elapsed().as_nanos();
                if sample >= 5 {
                    println!(
                        "flatten_white_mixed,{name},{num_pixels},{},{old_t},{new_t}",
                        sample - 5
                    );
                }
            }
        }

        // 5. premultiply on opaque buffer
        {
            let mut buf_b = opaque.clone();
            let mut buf_c = opaque.clone();
            baseline::premultiply(&mut buf_b);
            candidate::premultiply(&mut buf_c);
            assert_eq!(buf_b, buf_c);
            for sample in 0..20 {
                buf_b.copy_from_slice(&opaque);
                buf_c.copy_from_slice(&opaque);

                let start_o = Instant::now();
                baseline::premultiply(black_box(&mut buf_b));
                let old_t = start_o.elapsed().as_nanos();

                let start_n = Instant::now();
                candidate::premultiply(black_box(&mut buf_c));
                let new_t = start_n.elapsed().as_nanos();
                if sample >= 5 {
                    println!(
                        "premultiply_solid,{name},{num_pixels},{},{old_t},{new_t}",
                        sample - 5
                    );
                }
            }
        }

        // 6. premultiply on mixed buffer
        {
            let mut buf_b = mixed.clone();
            let mut buf_c = mixed.clone();
            baseline::premultiply(&mut buf_b);
            candidate::premultiply(&mut buf_c);
            assert_eq!(buf_b, buf_c);
            for sample in 0..20 {
                buf_b.copy_from_slice(&mixed);
                buf_c.copy_from_slice(&mixed);

                let start_o = Instant::now();
                baseline::premultiply(black_box(&mut buf_b));
                let old_t = start_o.elapsed().as_nanos();

                let start_n = Instant::now();
                candidate::premultiply(black_box(&mut buf_c));
                let new_t = start_n.elapsed().as_nanos();
                if sample >= 5 {
                    println!(
                        "premultiply_mixed,{name},{num_pixels},{},{old_t},{new_t}",
                        sample - 5
                    );
                }
            }
        }

        // 7. demultiply on opaque buffer
        {
            let mut buf_b = opaque.clone();
            let mut buf_c = opaque.clone();
            baseline::demultiply(&mut buf_b);
            candidate::demultiply(&mut buf_c);
            assert_eq!(buf_b, buf_c);
            for sample in 0..20 {
                buf_b.copy_from_slice(&opaque);
                buf_c.copy_from_slice(&opaque);

                let start_o = Instant::now();
                baseline::demultiply(black_box(&mut buf_b));
                let old_t = start_o.elapsed().as_nanos();

                let start_n = Instant::now();
                candidate::demultiply(black_box(&mut buf_c));
                let new_t = start_n.elapsed().as_nanos();
                if sample >= 5 {
                    println!(
                        "demultiply_solid,{name},{num_pixels},{},{old_t},{new_t}",
                        sample - 5
                    );
                }
            }
        }
    }
}
