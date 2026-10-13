use cap_audio::{waveform_peaks, waveform_peaks_from_slices};
use std::time::Instant;

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

fn time<R>(runs: usize, mut f: impl FnMut() -> R) -> (f64, R) {
    let mut times = Vec::new();
    let mut out = None;
    for _ in 0..runs {
        let start = Instant::now();
        let r = std::hint::black_box(f());
        times.push(start.elapsed().as_secs_f64() * 1000.0);
        out = Some(r);
    }
    (median(times), out.unwrap())
}

const SLICE: usize = 32_768 * 2;
const POOL: usize = 256;

fn make_pool(seed: u32) -> Vec<Vec<f32>> {
    let mut state = seed;
    (0..POOL)
        .map(|b| {
            (0..SLICE)
                .map(|i| {
                    state ^= state << 13;
                    state ^= state >> 17;
                    state ^= state << 5;
                    let n = (state as f32 / u32::MAX as f32) * 2.0 - 1.0;
                    n * (((b * SLICE + i) / 48_000) % 9) as f32 / 9.0
                })
                .collect()
        })
        .collect()
}

fn track(pool: &[Vec<f32>], minutes: usize, offset: usize) -> Vec<&[f32]> {
    let total = minutes * 60 * 48_000 * 2;
    let n = total.div_ceil(SLICE);
    (0..n)
        .map(|i| {
            let s = pool[(i + offset) % POOL].as_slice();
            if i == n - 1 {
                &s[..total - i * SLICE]
            } else {
                s
            }
        })
        .collect()
}

fn four_tracks(label: &str, tracks: &[Vec<&[f32]>], runs: usize) {
    let (old_seq, _) = time(runs, || {
        tracks
            .iter()
            .map(|t| waveform_peaks(t.iter().flat_map(|s| s.iter()), 2))
            .collect::<Vec<_>>()
    });
    let (new_seq, _) = time(runs, || {
        tracks
            .iter()
            .map(|t| waveform_peaks_from_slices(t, 2, 48_000))
            .collect::<Vec<_>>()
    });
    let (new_par, _) = time(runs, || {
        std::thread::scope(|s| {
            let handles: Vec<_> = tracks
                .iter()
                .map(|t| s.spawn(move || waveform_peaks_from_slices(t, 2, 48_000)))
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .collect::<Vec<_>>()
        })
    });
    println!(
        "4x60 min tracks, {label}: old sequential {old_seq:8.2} ms | new sequential {new_seq:8.2} ms ({:.2}x) | new 4 threads {new_par:8.2} ms ({:.2}x)",
        old_seq / new_seq,
        old_seq / new_par
    );
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "both".into());
    let runs = 7;
    let pool = make_pool(0x1234_5678);
    println!("runs={runs} slice={SLICE} samples (BLOCK_FRAMES*2ch) pool={POOL} slices (64 MiB)");
    for minutes in [10, 60, 120] {
        let slices = track(&pool, minutes, 0);
        let (old_ms, old) = if mode != "new" {
            let (t, o) = time(runs, || {
                waveform_peaks(slices.iter().flat_map(|s| s.iter()), 2)
            });
            (t, Some(o))
        } else {
            (f64::NAN, None)
        };
        let (new_ms, new) = time(runs, || waveform_peaks_from_slices(&slices, 2, 48_000));
        let max_diff = old
            .map(|o| {
                assert_eq!(o.len(), new.len());
                o.iter()
                    .zip(&new)
                    .map(|(a, b)| (a - b).abs())
                    .fold(0.0_f32, f32::max)
            })
            .unwrap_or(f32::NAN);
        println!(
            "{minutes:>3} min stereo: old {old_ms:8.2} ms | new {new_ms:8.2} ms | speedup {:5.2}x | max |diff| {max_diff:.3e} dB | blocks {}",
            old_ms / new_ms,
            new.len()
        );
    }
    let shared: Vec<Vec<&[f32]>> = (0..4).map(|t| track(&pool, 60, t * 37)).collect();
    four_tracks("shared-buffer (one 64 MiB pool)", &shared, runs);
    drop(shared);
    let pools: Vec<Vec<Vec<f32>>> = (1..=4u32)
        .map(|t| make_pool(0x9E37_79B9_u32.wrapping_mul(t)))
        .collect();
    let separate: Vec<Vec<&[f32]>> = pools.iter().map(|p| track(p, 60, 0)).collect();
    four_tracks("separate buffers (64 MiB pool per track)", &separate, runs);
}
