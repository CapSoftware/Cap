use cap_gpui_kernels::frame;
use std::{hint::black_box, time::Instant};

type Convert = fn(&[u8], usize, usize, usize) -> Option<Vec<u8>>;

fn before(data: &[u8], width: usize, stride: usize, rows: usize) -> Option<Vec<u8>> {
    let rgba = frame::unpad_rows(data, width * 4, stride, rows)?;
    let mut bgra = rgba.clone();
    frame::swap_red_blue(&mut bgra);
    black_box(&rgba);
    Some(bgra)
}

fn after(data: &[u8], width: usize, stride: usize, rows: usize) -> Option<Vec<u8>> {
    frame::unpad_rgba_to_bgra(data, width, stride, rows)
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn main() {
    println!(
        "| frame | tight MB | before median | after median | speedup | bytes written before | bytes written after |"
    );
    println!("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (name, width, height) in [
        ("1080p", 1920usize, 1080usize),
        ("4K", 3840, 2160),
        ("5K", 5120, 2880),
        ("5K + 40 padding", 6760, 3802),
    ] {
        let stride = (width * 4).next_multiple_of(256);
        let src: Vec<u8> = (0..stride * height).map(|i| (i * 7 + i / 251) as u8).collect();
        assert_eq!(
            before(&src, width, stride, height),
            after(&src, width, stride, height)
        );
        let mut old = Vec::new();
        let mut new = Vec::new();
        for sample in 0..45 {
            let run = |f: Convert| {
                let start = Instant::now();
                let out = black_box(f(
                    black_box(&src),
                    black_box(width),
                    black_box(stride),
                    black_box(height),
                ));
                drop(out);
                start.elapsed().as_secs_f64() * 1000.0
            };
            let (a, b) = if sample % 2 == 0 {
                let a = run(before);
                (a, run(after))
            } else {
                let b = run(after);
                (run(before), b)
            };
            if sample >= 5 {
                old.push(a);
                new.push(b);
            }
        }
        let tight = width * height * 4;
        let (old, new) = (median(&mut old), median(&mut new));
        println!(
            "| {name} ({width}x{height}) | {:.1} | {old:.2} ms | {new:.2} ms | {:.2}x | {:.1} MB | {:.1} MB |",
            tight as f64 / 1e6,
            old / new,
            3.0 * tight as f64 / 1e6,
            tight as f64 / 1e6,
        );
    }
}
