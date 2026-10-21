use cap_gpui_kernels::screenshot as candidate;
use std::{hint::black_box, time::Instant};

type Blit = fn(&mut [u8], (u32, u32), &[u8], (u32, u32), (i64, i64));

// The export canvas is cleared to zero for a transparent background and
// filled with white otherwise, so those two are the shipping backdrops.
#[derive(Clone, Copy)]
enum Backdrop {
    Varying,
    Transparent,
    OpaqueWhite,
}

#[derive(Clone, Copy)]
enum Alpha {
    Solid(u8),
    Mixed,
    Edge,
    Sparse,
}

fn main() {
    use Alpha::{Edge, Mixed, Solid, Sparse};
    use Backdrop::{OpaqueWhite, Transparent, Varying};

    println!("workload,backdrop,sample,before_ns,after_ns");
    for (name, size, offset, alpha, backdrop) in [
        (
            "opaque-1080p",
            (1920u32, 1080u32),
            (0, 0),
            Solid(255),
            Varying,
        ),
        ("opaque-4k", (3840, 2160), (0, 0), Solid(255), Varying),
        ("opaque-portrait", (2160, 3840), (0, 0), Solid(255), Varying),
        (
            "opaque-expanded",
            (3840, 2160),
            (100, 80),
            Solid(255),
            Varying,
        ),
        (
            "opaque-clipped",
            (3840, 2160),
            (-2000, -1200),
            Solid(255),
            Varying,
        ),
        ("translucent-4k", (3840, 2160), (0, 0), Solid(128), Varying),
        ("edge-alpha-4k", (3840, 2160), (0, 0), Edge, Varying),
        ("sparse-alpha-4k", (3840, 2160), (0, 0), Sparse, Varying),
        ("mixed-4k", (3840, 2160), (0, 0), Mixed, Varying),
        ("transparent-4k", (3840, 2160), (0, 0), Solid(0), Varying),
        ("outside-4k", (3840, 2160), (4000, 0), Solid(255), Varying),
        (
            "translucent-4k",
            (3840, 2160),
            (0, 0),
            Solid(128),
            Transparent,
        ),
        (
            "translucent-4k",
            (3840, 2160),
            (0, 0),
            Solid(128),
            OpaqueWhite,
        ),
        ("mixed-4k", (3840, 2160), (0, 0), Mixed, Transparent),
        ("mixed-4k", (3840, 2160), (0, 0), Mixed, OpaqueWhite),
        ("sparse-alpha-4k", (3840, 2160), (0, 0), Sparse, OpaqueWhite),
        ("edge-alpha-4k", (3840, 2160), (0, 0), Edge, OpaqueWhite),
    ] {
        let dst_size = if name == "opaque-expanded" {
            (size.0 + 200, size.1 + 160)
        } else {
            size
        };
        let src: Vec<u8> = (0..size.0 * size.1)
            .flat_map(|i| {
                [
                    i as u8,
                    (i >> 8) as u8,
                    i.wrapping_mul(17) as u8,
                    match alpha {
                        Mixed => i as u8,
                        Edge if i % size.0 == size.0 - 1 => 128,
                        Sparse if i % 1024 == 1023 => 128,
                        Edge | Sparse => 255,
                        Solid(alpha) => alpha,
                    },
                ]
            })
            .collect();
        let initial: Vec<u8> = (0..dst_size.0 * dst_size.1)
            .flat_map(|i| match backdrop {
                Varying => [53, 71, 89, (i % 256) as u8],
                Transparent => [0, 0, 0, 0],
                OpaqueWhite => [255, 255, 255, 255],
            })
            .collect();
        let mut before = initial.clone();
        let mut after = initial.clone();
        baseline::blit_over_offset(&mut before, dst_size, &src, size, offset);
        candidate::blit_over_offset(&mut after, dst_size, &src, size, offset);
        assert_eq!(before, after, "{name}");
        for sample in 0..35 {
            before.copy_from_slice(&initial);
            after.copy_from_slice(&initial);
            let run = |f: Blit, dst: &mut [u8]| {
                let start = Instant::now();
                f(
                    black_box(dst),
                    black_box(dst_size),
                    black_box(&src),
                    black_box(size),
                    black_box(offset),
                );
                start.elapsed().as_nanos()
            };
            let (old, new) = if sample % 2 == 0 {
                let old = run(baseline::blit_over_offset, &mut before);
                (old, run(candidate::blit_over_offset, &mut after))
            } else {
                let new = run(candidate::blit_over_offset, &mut after);
                (run(baseline::blit_over_offset, &mut before), new)
            };
            black_box((&before, &after));
            if sample >= 5 {
                let backdrop = match backdrop {
                    Varying => "varying",
                    Transparent => "transparent",
                    OpaqueWhite => "opaque-white",
                };
                println!("{name},{backdrop},{},{old},{new}", sample - 5);
            }
        }
    }
}

// Preserved from 40b06b92ac57b87f9bdb52e4eff8429d0ea319c3 so both paths use the same build and inputs.
mod baseline {
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

    pub fn blit_over_offset(
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
}
