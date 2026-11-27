use std::{
    fs::File,
    io::{BufWriter, Write},
    sync::{Mutex, OnceLock},
};

static SINK: OnceLock<Option<Mutex<BufWriter<File>>>> = OnceLock::new();
static CODE: OnceLock<Option<(usize, usize, usize)>> = OnceLock::new();

fn sink() -> Option<&'static Mutex<BufWriter<File>>> {
    SINK.get_or_init(|| {
        std::env::var("CAP_WIN_FRAME_TRACE")
            .ok()
            .and_then(|p| File::create(p).ok())
            .map(|f| Mutex::new(BufWriter::with_capacity(1 << 20, f)))
    })
    .as_ref()
}

pub fn enabled() -> bool {
    sink().is_some()
}

pub fn line(args: std::fmt::Arguments) {
    if let Some(m) = sink()
        && let Ok(mut w) = m.lock()
    {
        let _ = w.write_fmt(args);
        let _ = w.write_all(b"\n");
    }
}

pub fn flush() {
    if let Some(m) = sink()
        && let Ok(mut w) = m.lock()
    {
        let _ = w.flush();
    }
}

pub fn qpc_ns() -> i64 {
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    static FREQ: OnceLock<i64> = OnceLock::new();
    let f = *FREQ.get_or_init(|| {
        let mut f = 0i64;
        unsafe {
            let _ = QueryPerformanceFrequency(&mut f);
        }
        f.max(1)
    });
    let mut v = 0i64;
    unsafe {
        let _ = QueryPerformanceCounter(&mut v);
    }
    ((v as i128) * 1_000_000_000 / f as i128) as i64
}

fn code() -> Option<(usize, usize, usize)> {
    *CODE.get_or_init(|| {
        let v = std::env::var("CAP_WIN_FRAME_TRACE_CODE").ok()?;
        let p: Vec<usize> = v.split(',').filter_map(|x| x.trim().parse().ok()).collect();
        (p.len() == 3).then(|| (p[0], p[1], p[2]))
    })
}

fn crc8(v: u32) -> u32 {
    let mut crc: u32 = 0;
    for b in [(v >> 16) & 0x3F, (v >> 8) & 0xFF, v & 0xFF] {
        crc ^= b;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                ((crc << 1) ^ 0x07) & 0xFF
            } else {
                (crc << 1) & 0xFF
            };
        }
    }
    crc
}

pub fn decode_rgba(data: &[u8], pitch: usize) -> i64 {
    let Some((cell, x, y)) = code() else {
        return -2;
    };
    let q = (cell / 4).max(1);
    let sample = |cx: usize, cy: usize| -> f64 {
        let mut s = 0u64;
        let mut n = 0u64;
        for yy in cy.saturating_sub(q)..cy + q {
            for xx in cx.saturating_sub(q)..cx + q {
                let o = yy * pitch + xx * 4;
                if o + 2 < data.len() {
                    s += data[o] as u64 + data[o + 1] as u64 + data[o + 2] as u64;
                    n += 3;
                }
            }
        }
        if n == 0 { 0.0 } else { s as f64 / n as f64 }
    };
    let at = |c: usize, r: usize| sample(x + c * cell + cell / 2, y + r * cell + cell / 2);
    let pil: Vec<f64> = (0..10).map(|c| at(c, 0)).collect();
    let whites: Vec<f64> = pil.iter().step_by(2).copied().collect();
    let blacks: Vec<f64> = pil.iter().skip(1).step_by(2).copied().collect();
    let minw = whites.iter().cloned().fold(f64::MAX, f64::min);
    let maxb = blacks.iter().cloned().fold(f64::MIN, f64::max);
    if minw - maxb < 40.0 {
        return -1;
    }
    let mw = whites.iter().sum::<f64>() / whites.len() as f64;
    let mb = blacks.iter().sum::<f64>() / blacks.len() as f64;
    let thr = (mw + mb) / 2.0;
    let margin = (mw - mb) * 0.25;
    let mut bits: u32 = 0;
    for k in 0..30 {
        let v = at(k % 10, 1 + k / 10);
        if (v - thr).abs() < margin {
            return -1;
        }
        bits = (bits << 1) | u32::from(v > thr);
    }
    let idx = bits >> 8;
    if crc8(idx) != (bits & 0xFF) {
        return -1;
    }
    i64::from(idx)
}
