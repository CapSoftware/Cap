use cap_gpui_kernels::mask_cache::{MaskEntry, MaskFrame, MaskRequest, mask_region, update_masks};
use std::{hint::black_box, sync::Arc, time::Instant};

const SIZE: (u32, u32) = (3840, 2160);
const WARMUP: usize = 12;
const EVENTS: usize = 120;
#[derive(Clone)]
struct Overlay {
    rect: [f64; 4],
    image: Arc<image::RgbaImage>,
}

type CachedOverlay = MaskEntry<Overlay>;

fn overlay(request: &MaskRequest, rgba: &[u8]) -> Option<Overlay> {
    let processed = request.filter(rgba)?;
    Some(Overlay {
        rect: [
            f64::from(request.region.0),
            f64::from(request.region.1),
            f64::from(processed.width()),
            f64::from(processed.height()),
        ],
        image: Arc::new(processed),
    })
}

fn requests(count: usize, pixelate: bool, event: usize) -> Vec<MaskRequest> {
    let content = [0., 0., f64::from(SIZE.0), f64::from(SIZE.1)];
    (0..count)
        .map(|index| {
            let x = 80. + (index % 4) as f64 * 720. + if index == 0 { event as f64 } else { 0. };
            let y = 80. + (index / 4) as f64 * 440.;
            MaskRequest {
                id: index.to_string(),
                frame: MaskFrame {
                    revision: 1,
                    size: SIZE,
                    content: content.map(f64::to_bits),
                    padding: 0_f64.to_bits(),
                    crop: None,
                },
                region: mask_region([x, y, 640., 360.], content, SIZE).unwrap(),
                pixelate,
                level: 16_f64.to_bits(),
            }
        })
        .collect()
}

fn rebuild_all(requests: &[MaskRequest], rgba: &[u8], calls: &mut usize) -> Vec<Overlay> {
    let mut overlays = Vec::new();
    for request in requests {
        *calls += 1;
        if let Some(overlay) = overlay(request, rgba) {
            overlays.push(overlay);
        }
    }
    overlays
}

fn cached(
    previous: &[CachedOverlay],
    requests: &[MaskRequest],
    rgba: &[u8],
    calls: &mut usize,
) -> Vec<CachedOverlay> {
    update_masks(previous, requests, |request| {
        *calls += 1;
        overlay(request, rgba)
    })
}

fn stats(samples: &mut [f64]) -> (f64, f64) {
    samples.sort_by(f64::total_cmp);
    (
        samples.iter().sum::<f64>() / samples.len() as f64,
        (samples[samples.len() / 2 - 1] + samples[samples.len() / 2]) / 2.,
    )
}

fn main() {
    let rgba: Vec<u8> = (0..SIZE.0 * SIZE.1)
        .flat_map(|i| {
            let x = i % SIZE.0;
            let y = i / SIZE.0;
            [
                (x * 13 + y * 7) as u8,
                (x * 3 + y * 17) as u8,
                (x ^ (y * 11)) as u8,
                (128 + (x * 5 + y * 3) % 128) as u8,
            ]
        })
        .collect();
    println!(
        "Screenshot mask overlay preparation: {} / {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    println!(
        "3840x2160 RGBA; 640x360 masks; level 16; {WARMUP} warmup pairs; {EVENTS} measured drag events"
    );
    println!(
        "Alternating old/new execution order; warm cache; geometry and byte comparison after every event outside timing."
    );
    println!(
        "Includes cache diff, filtering, Arc allocation and retired CPU image release. Excludes GPUI conversion, scheduling, atlas and painting."
    );
    println!(
        "| Mode | Masks | Old mean ms | New mean ms | Old median ms | New median ms | Mean speedup | Old calls | New calls |"
    );
    println!("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for pixelate in [false, true] {
        for count in [1, 4, 8, 16] {
            let initial = requests(count, pixelate, 0);
            let mut old = rebuild_all(&initial, &rgba, &mut 0);
            let mut new = cached(&[], &initial, &rgba, &mut 0);
            let mut old_samples = Vec::with_capacity(EVENTS);
            let mut new_samples = Vec::with_capacity(EVENTS);
            let mut old_calls = 0;
            let mut new_calls = 0;
            for event in 1..=WARMUP + EVENTS {
                let requests = requests(count, pixelate, event);
                let mut run_old = || {
                    let start = Instant::now();
                    old = rebuild_all(black_box(&requests), black_box(&rgba), &mut old_calls);
                    start.elapsed().as_secs_f64() * 1000.
                };
                let mut run_new = || {
                    let start = Instant::now();
                    new = cached(
                        black_box(&new),
                        black_box(&requests),
                        black_box(&rgba),
                        &mut new_calls,
                    );
                    start.elapsed().as_secs_f64() * 1000.
                };
                let (old_ms, new_ms) = if event % 2 == 0 {
                    let new_ms = run_new();
                    (run_old(), new_ms)
                } else {
                    let old_ms = run_old();
                    (old_ms, run_new())
                };
                assert_eq!(old.len(), count);
                assert_eq!(new.len(), count);
                for (old, new) in old.iter().zip(&new) {
                    let expected_rect = [
                        f64::from(new.request.region.0),
                        f64::from(new.request.region.1),
                        f64::from(new.request.region.2),
                        f64::from(new.request.region.3),
                    ];
                    assert_eq!(old.rect, expected_rect);
                    let new_overlay = new.value.as_ref().unwrap();
                    assert_eq!(old.rect, new_overlay.rect);
                    assert_eq!(
                        old.image.as_raw(),
                        new_overlay.image.as_raw(),
                        "event {event}, mask {}",
                        new.request.id
                    );
                }
                if event <= WARMUP {
                    old_calls = 0;
                    new_calls = 0;
                } else {
                    old_samples.push(old_ms);
                    new_samples.push(new_ms);
                }
            }
            assert_eq!(old_calls, count * EVENTS);
            assert_eq!(new_calls, EVENTS);
            let (old_mean, old_median) = stats(&mut old_samples);
            let (new_mean, new_median) = stats(&mut new_samples);
            let mode = if pixelate { "pixelate" } else { "blur" };
            println!(
                "| {mode} | {count} | {old_mean:.3} | {new_mean:.3} | {old_median:.3} | {new_median:.3} | {:.2}x | {old_calls} | {new_calls} |",
                old_mean / new_mean
            );
        }
    }
    println!("All overlay geometry and bytes matched at every warmup and measured event.");
}
