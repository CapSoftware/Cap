// Capture-only probe: how many distinct stimulus frames reach a consumer through
// WGC or DXGI desktop duplication, with Cap-like and alternative frame handling.
//
// wgcprobe --mode wgc|dxgi --secs 20 --stim DIR --out FILE.csv
//          [--pool 4] [--min-interval-us 16667|0] [--cursor 1] [--fmt rgba|bgra]
//          [--release immediate|hold|ring] [--work-us 0] [--queue 240] [--ring 8]
//
// immediate: decode a small code region by delayed readback, release the WGC frame at once.
// hold:      hand the WGC frame to a worker (Cap today): full CopyResource + Map + memcpy,
//            sleep work-us, then release. Callback blocks up to 50 ms when the queue is full.
// ring:      copy the WGC surface into a probe-owned texture, release the WGC frame at once,
//            worker reads back the copy like hold; drop (never block) when no copy is free.
use std::{
    collections::VecDeque,
    fs::File,
    io::{BufWriter, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender, TrySendError},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use windows::{
    core::{Interface, Result},
    Foundation::TypedEventHandler,
    Graphics::{
        Capture::{Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
    },
    Win32::{
        Foundation::{HMODULE, POINT},
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0},
            Direct3D11::*,
            Dwm::{DwmGetCompositionTimingInfo, DWM_TIMING_INFO},
            Dxgi::{Common::*, *},
            Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY},
        },
        System::{
            Performance::{QueryPerformanceCounter, QueryPerformanceFrequency},
            WinRT::{
                Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
                Graphics::Capture::IGraphicsCaptureItemInterop,
                RoInitialize, RO_INIT_MULTITHREADED,
            },
        },
        UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
    },
};

static QPC_FREQ: OnceLock<i64> = OnceLock::new();

fn qpc_ns() -> i64 {
    let mut v = 0i64;
    unsafe {
        let _ = QueryPerformanceCounter(&mut v);
    }
    qpc_to_ns(v)
}

fn qpc_to_ns(v: i64) -> i64 {
    let f = *QPC_FREQ.get_or_init(|| {
        let mut f = 0i64;
        unsafe {
            let _ = QueryPerformanceFrequency(&mut f);
        }
        f
    });
    ((v as i128) * 1_000_000_000 / f as i128) as i64
}

#[derive(Clone)]
struct Args {
    mode: String,
    secs: f64,
    stim: String,
    out: String,
    pool: i32,
    min_interval_us: u64,
    cursor: bool,
    fmt: String,
    release: String,
    work_us: u64,
    queue: usize,
    ring: usize,
    adapter: Option<u32>,
    map_mode: String,
    memload: bool,
    gpucopy: bool,
}

fn parse_args() -> Args {
    let mut a = Args {
        mode: "wgc".into(),
        secs: 20.0,
        stim: String::new(),
        out: "probe.csv".into(),
        pool: 4,
        min_interval_us: 16_667,
        cursor: true,
        fmt: "rgba".into(),
        release: "immediate".into(),
        work_us: 0,
        queue: 240,
        ring: 8,
        adapter: None,
        map_mode: "sync".into(),
        memload: false,
        gpucopy: false,
    };
    let v: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i + 1 < v.len() {
        let (k, val) = (v[i].as_str(), v[i + 1].clone());
        match k {
            "--mode" => a.mode = val,
            "--secs" => a.secs = val.parse().unwrap(),
            "--stim" => a.stim = val,
            "--out" => a.out = val,
            "--pool" => a.pool = val.parse().unwrap(),
            "--min-interval-us" => a.min_interval_us = val.parse().unwrap(),
            "--cursor" => a.cursor = val != "0",
            "--fmt" => a.fmt = val,
            "--release" => a.release = val,
            "--work-us" => a.work_us = val.parse().unwrap(),
            "--queue" => a.queue = val.parse().unwrap(),
            "--ring" => a.ring = val.parse().unwrap(),
            "--adapter" => a.adapter = Some(val.parse().unwrap()),
            "--map" => a.map_mode = val,
            "--memload" => a.memload = val != "0",
            "--gpucopy" => a.gpucopy = val != "0",
            _ => panic!("unknown arg {k}"),
        }
        i += 2;
    }
    a
}

#[derive(Clone, Copy)]
struct Code {
    cell: u32,
    rx: u32,
    ry: u32,
    rw: u32,
    rh: u32,
}

fn load_code(stim: &str) -> Code {
    let path = format!("{stim}/stimulus.json");
    for _ in 0..200 {
        if std::fs::metadata(&path).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    std::thread::sleep(Duration::from_millis(200));
    let text = std::fs::read_to_string(&path).expect("stimulus.json");
    let j: serde_json::Value = serde_json::from_str(&text).unwrap();
    let c = &j["code"];
    let cell = c["cell"].as_f64().unwrap() as u32;
    let x = c["x"].as_f64().unwrap() as u32;
    let y = c["y"].as_f64().unwrap() as u32;
    Code {
        cell,
        rx: x - cell,
        ry: y - cell,
        rw: cell * 12,
        rh: cell * 6,
    }
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

// data points at the region origin's row 0; pitch in bytes.
fn decode(data: &[u8], pitch: usize, ox: usize, oy: usize, cell: usize) -> Option<u32> {
    decode_bpp(data, pitch, ox, oy, cell, 4)
}

fn decode_bpp(data: &[u8], pitch: usize, ox: usize, oy: usize, cell: usize, bpp: usize) -> Option<u32> {
    let q = (cell / 4).max(1);
    let sample = |cx: usize, cy: usize| -> f64 {
        let mut s = 0u64;
        let mut n = 0u64;
        for yy in cy.saturating_sub(q)..cy + q {
            for xx in cx.saturating_sub(q)..cx + q {
                let o = yy * pitch + xx * bpp;
                if bpp == 1 {
                    if o < data.len() {
                        s += data[o] as u64;
                        n += 1;
                    }
                } else if o + 2 < data.len() {
                    s += data[o] as u64 + data[o + 1] as u64 + data[o + 2] as u64;
                    n += 3;
                }
            }
        }
        if n == 0 {
            0.0
        } else {
            s as f64 / n as f64
        }
    };
    let at = |c: usize, r: usize| sample(ox + cell + c * cell + cell / 2, oy + cell + r * cell + cell / 2);
    let pil: Vec<f64> = (0..10).map(|c| at(c, 0)).collect();
    let whites: Vec<f64> = pil.iter().step_by(2).copied().collect();
    let blacks: Vec<f64> = pil.iter().skip(1).step_by(2).copied().collect();
    let minw = whites.iter().cloned().fold(f64::MAX, f64::min);
    let maxb = blacks.iter().cloned().fold(f64::MIN, f64::max);
    if minw - maxb < 40.0 {
        return None;
    }
    let mw = whites.iter().sum::<f64>() / whites.len() as f64;
    let mb = blacks.iter().sum::<f64>() / blacks.len() as f64;
    let thr = (mw + mb) / 2.0;
    let margin = (mw - mb) * 0.25;
    let mut bits: u32 = 0;
    for k in 0..30 {
        let v = at(k % 10, 1 + k / 10);
        if (v - thr).abs() < margin {
            return None;
        }
        bits = (bits << 1) | u32::from(v > thr);
    }
    let idx = bits >> 8;
    if crc8(idx) != (bits & 0xFF) {
        return None;
    }
    Some(idx)
}

#[derive(Clone, Copy, Default)]
struct Rec {
    seq: u64,
    cb_ns: i64,
    src_ns: i64,
    acc: u32,
    idx: i64,
    done_ns: i64,
    status: u8,
}

const ST_OK: u8 = 0;
const ST_DROPPED: u8 = 1;
const ST_NOIMG: u8 = 2;

struct Sink {
    w: Mutex<(BufWriter<File>, Vec<Rec>)>,
}

impl Sink {
    fn put(&self, r: Rec) {
        let mut g = self.w.lock().unwrap();
        let _ = writeln!(
            g.0,
            "{},{},{},{},{},{},{}",
            r.seq, r.cb_ns, r.src_ns, r.acc, r.idx, r.done_ns, r.status
        );
        g.1.push(r);
    }
}

fn staging(device: &ID3D11Device, w: u32, h: u32, fmt: DXGI_FORMAT) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: fmt,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut t = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut t))? };
    Ok(t.unwrap())
}

fn default_tex(device: &ID3D11Device, w: u32, h: u32, fmt: DXGI_FORMAT) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: fmt,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut t = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut t))? };
    Ok(t.unwrap())
}

// Small delayed readback of the code region: copy now, map a few frames later.
struct CodeReader {
    ctx: ID3D11DeviceContext,
    ring: Vec<ID3D11Texture2D>,
    pending: VecDeque<(usize, Rec)>,
    next: usize,
    code: Code,
}

const READ_DELAY: usize = 4;

impl CodeReader {
    fn new(device: &ID3D11Device, ctx: &ID3D11DeviceContext, code: Code, fmt: DXGI_FORMAT) -> Result<Self> {
        let mut ring = Vec::new();
        for _ in 0..16 {
            ring.push(staging(device, code.rw, code.rh, fmt)?);
        }
        Ok(Self {
            ctx: ctx.clone(),
            ring,
            pending: VecDeque::new(),
            next: 0,
            code,
        })
    }

    fn push(&mut self, src: &ID3D11Texture2D, rec: Rec, sink: &Sink) {
        if self.pending.len() >= self.ring.len() - 1 {
            self.pop(sink);
        }
        let slot = self.next % self.ring.len();
        self.next += 1;
        let b = D3D11_BOX {
            left: self.code.rx,
            top: self.code.ry,
            front: 0,
            right: self.code.rx + self.code.rw,
            bottom: self.code.ry + self.code.rh,
            back: 1,
        };
        unsafe {
            self.ctx
                .CopySubresourceRegion(&self.ring[slot], 0, 0, 0, 0, src, 0, Some(&b));
        }
        self.pending.push_back((slot, rec));
        while self.pending.len() > READ_DELAY {
            self.pop(sink);
        }
    }

    fn pop(&mut self, sink: &Sink) {
        let Some((slot, mut rec)) = self.pending.pop_front() else {
            return;
        };
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        if unsafe { self.ctx.Map(&self.ring[slot], 0, D3D11_MAP_READ, 0, Some(&mut m)) }.is_ok() {
            let len = (m.RowPitch * self.code.rh) as usize;
            let data = unsafe { std::slice::from_raw_parts(m.pData as *const u8, len) };
            rec.idx = decode(data, m.RowPitch as usize, 0, 0, self.code.cell as usize)
                .map(i64::from)
                .unwrap_or(-1);
            unsafe { self.ctx.Unmap(&self.ring[slot], 0) };
        }
        rec.done_ns = qpc_ns();
        sink.put(rec);
    }

    fn flush(&mut self, sink: &Sink) {
        while !self.pending.is_empty() {
            self.pop(sink);
        }
    }
}

// Worker that does what Cap's encoder thread does with each frame before the encoder:
// full CopyResource to staging + Map + memcpy of every row.
struct FullReader {
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    stage: Option<(ID3D11Texture2D, u32, u32)>,
    buf: Vec<u8>,
    code: Code,
    fmt: DXGI_FORMAT,
    work: Duration,
    map_mode: String,
    pipe: VecDeque<(ID3D11Texture2D, Rec, Option<Direct3D11CaptureFrame>)>,
    pipe_free: Vec<ID3D11Texture2D>,
    small: Option<CodeReader>,
}

impl FullReader {
    fn read_pipe(&mut self, tex: &ID3D11Texture2D, rec: Rec, frame: Option<Direct3D11CaptureFrame>, sink: &Sink) {
        let mut d = D3D11_TEXTURE2D_DESC::default();
        unsafe { tex.GetDesc(&mut d) };
        if self.pipe.is_empty() && self.pipe_free.is_empty() {
            for _ in 0..4 {
                self.pipe_free.push(staging(&self.device, d.Width, d.Height, self.fmt).unwrap());
            }
        }
        if self.pipe_free.is_empty() {
            self.drain_one(sink, d.Width, d.Height);
        }
        let st = self.pipe_free.pop().unwrap();
        unsafe { self.ctx.CopyResource(&st, tex) };
        unsafe { self.ctx.Flush() };
        self.pipe.push_back((st, rec, frame));
        while self.pipe.len() > 2 {
            self.drain_one(sink, d.Width, d.Height);
        }
    }

    fn drain_one(&mut self, sink: &Sink, w: u32, h: u32) {
        let Some((st, mut rec, frame)) = self.pipe.pop_front() else { return };
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        if unsafe { self.ctx.Map(&st, 0, D3D11_MAP_READ, 0, Some(&mut m)) }.is_ok() {
            let pitch = m.RowPitch as usize;
            let data = unsafe { std::slice::from_raw_parts(m.pData as *const u8, pitch * h as usize) };
            let row = w as usize * 4;
            self.buf.resize(row * h as usize, 0);
            for y in 0..h as usize {
                self.buf[y * row..(y + 1) * row].copy_from_slice(&data[y * pitch..y * pitch + row]);
            }
            rec.idx = decode(data, pitch, self.code.rx as usize, self.code.ry as usize, self.code.cell as usize)
                .map(i64::from)
                .unwrap_or(-1);
            unsafe { self.ctx.Unmap(&st, 0) };
        }
        drop(frame);
        if !self.work.is_zero() {
            std::thread::sleep(self.work);
        }
        rec.done_ns = qpc_ns();
        sink.put(rec);
        self.pipe_free.push(st);
    }

    fn flush(&mut self, sink: &Sink) {
        while let Some((st, _, _)) = self.pipe.front() {
            let mut d = D3D11_TEXTURE2D_DESC::default();
            unsafe { st.GetDesc(&mut d) };
            self.drain_one(sink, d.Width, d.Height);
        }
    }

    fn read(&mut self, tex: &ID3D11Texture2D, mut rec: Rec, sink: &Sink) {
        let mut d = D3D11_TEXTURE2D_DESC::default();
        unsafe { tex.GetDesc(&mut d) };
        if self.stage.as_ref().map(|s| (s.1, s.2)) != Some((d.Width, d.Height)) {
            self.stage = Some((staging(&self.device, d.Width, d.Height, self.fmt).unwrap(), d.Width, d.Height));
        }
        let st = self.stage.as_ref().unwrap().0.clone();
        unsafe { self.ctx.CopyResource(&st, tex) };
        if self.map_mode == "nomap" {
            if self.small.is_none() {
                self.small = Some(CodeReader::new(&self.device, &self.ctx, self.code, self.fmt).unwrap());
            }
            self.small.as_mut().unwrap().push(tex, rec, sink);
            return;
        }
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        let mapped = if self.map_mode == "poll" {
            unsafe { self.ctx.Flush() };
            let mut ok = false;
            for _ in 0..400 {
                match unsafe { self.ctx.Map(&st, 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32, Some(&mut m)) } {
                    Ok(()) => {
                        ok = true;
                        break;
                    }
                    Err(e) if e.code() == DXGI_ERROR_WAS_STILL_DRAWING => std::thread::sleep(Duration::from_micros(500)),
                    Err(_) => break,
                }
            }
            ok
        } else {
            unsafe { self.ctx.Map(&st, 0, D3D11_MAP_READ, 0, Some(&mut m)) }.is_ok()
        };
        if mapped {
            let pitch = m.RowPitch as usize;
            let len = pitch * d.Height as usize;
            let data = unsafe { std::slice::from_raw_parts(m.pData as *const u8, len) };
            let row = d.Width as usize * 4;
            if self.map_mode != "nocopy" {
                self.buf.resize(row * d.Height as usize, 0);
                for y in 0..d.Height as usize {
                    self.buf[y * row..(y + 1) * row].copy_from_slice(&data[y * pitch..y * pitch + row]);
                }
            }
            rec.idx = decode(data, pitch, self.code.rx as usize, self.code.ry as usize, self.code.cell as usize)
                .map(i64::from)
                .unwrap_or(-1);
            unsafe { self.ctx.Unmap(&st, 0) };
        }
        if !self.work.is_zero() {
            std::thread::sleep(self.work);
        }
        rec.done_ns = qpc_ns();
        sink.put(rec);
    }
}

struct Nv12Reader {
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    code: Code,
    readback: bool,
    state: Option<Nv12State>,
    pending: VecDeque<(usize, Rec, Option<Direct3D11CaptureFrame>)>,
    next: usize,
    buf: Vec<u8>,
    small: Option<CodeReader>,
    fmt: DXGI_FORMAT,
    failed: Option<String>,
}

struct Nv12State {
    vdev: ID3D11VideoDevice,
    vctx: ID3D11VideoContext,
    en: ID3D11VideoProcessorEnumerator,
    vp: ID3D11VideoProcessor,
    outs: Vec<(ID3D11Texture2D, ID3D11VideoProcessorOutputView)>,
    stages: Vec<ID3D11Texture2D>,
    w: u32,
    h: u32,
}

const NV12_SLOTS: usize = 4;

impl Nv12Reader {
    fn init(&mut self, w: u32, h: u32) -> Result<()> {
        let vdev: ID3D11VideoDevice = self.device.cast()?;
        let vctx: ID3D11VideoContext = self.ctx.cast()?;
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
            InputWidth: w,
            InputHeight: h,
            OutputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
            OutputWidth: w,
            OutputHeight: h,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        let en = unsafe { vdev.CreateVideoProcessorEnumerator(&desc)? };
        let vp = unsafe { vdev.CreateVideoProcessor(&en, 0)? };
        if let Ok(c1) = vctx.cast::<ID3D11VideoContext1>() {
            unsafe {
                c1.VideoProcessorSetStreamColorSpace1(&vp, 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
                c1.VideoProcessorSetOutputColorSpace1(&vp, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
            }
        }
        let mut outs = Vec::new();
        let mut stages = Vec::new();
        for _ in 0..NV12_SLOTS {
            let tdesc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut t = None;
            unsafe { self.device.CreateTexture2D(&tdesc, None, Some(&mut t))? };
            let t = t.unwrap();
            let vdesc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };
            let mut v = None;
            unsafe { vdev.CreateVideoProcessorOutputView(&t, &en, &vdesc, Some(&mut v))? };
            outs.push((t, v.unwrap()));
            stages.push(staging(&self.device, w, h, DXGI_FORMAT_NV12)?);
        }
        self.state = Some(Nv12State { vdev, vctx, en, vp, outs, stages, w, h });
        Ok(())
    }

    fn blit(&self, src: &ID3D11Texture2D, slot: usize) -> Result<()> {
        let st = self.state.as_ref().unwrap();
        let idesc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 },
            },
        };
        let mut input = None;
        unsafe { st.vdev.CreateVideoProcessorInputView(src, &st.en, &idesc, Some(&mut input))? };
        let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            OutputIndex: 0,
            InputFrameOrField: 0,
            pInputSurface: std::mem::ManuallyDrop::new(input),
            ..Default::default()
        };
        let r = unsafe { st.vctx.VideoProcessorBlt(&st.vp, &st.outs[slot].1, 0, std::slice::from_ref(&stream)) };
        unsafe { std::mem::ManuallyDrop::drop(&mut stream.pInputSurface) };
        r
    }

    fn read(&mut self, tex: &ID3D11Texture2D, rec: Rec, frame: Option<Direct3D11CaptureFrame>, sink: &Sink) {
        let mut d = D3D11_TEXTURE2D_DESC::default();
        unsafe { tex.GetDesc(&mut d) };
        if self.state.is_none() && self.failed.is_none() {
            if let Err(e) = self.init(d.Width, d.Height) {
                self.failed = Some(format!("init: {e:?}"));
            }
        }
        if self.small.is_none() {
            self.small = Some(CodeReader::new(&self.device, &self.ctx, self.code, self.fmt).unwrap());
        }
        if self.failed.is_some() {
            self.small.as_mut().unwrap().push(tex, rec, sink);
            return;
        }
        if self.pending.len() >= NV12_SLOTS - 1 {
            self.drain_one(sink);
        }
        let slot = self.next % NV12_SLOTS;
        self.next += 1;
        if let Err(e) = self.blit(tex, slot) {
            self.failed = Some(format!("blit: {e:?}"));
            self.small.as_mut().unwrap().push(tex, rec, sink);
            return;
        }
        if !self.readback {
            self.small.as_mut().unwrap().push(tex, rec, sink);
            drop(frame);
            return;
        }
        let st = self.state.as_ref().unwrap();
        unsafe { self.ctx.CopyResource(&st.stages[slot], &st.outs[slot].0) };
        unsafe { self.ctx.Flush() };
        drop(frame);
        self.pending.push_back((slot, rec, None));
        while self.pending.len() > 2 {
            self.drain_one(sink);
        }
    }

    fn drain_one(&mut self, sink: &Sink) {
        let Some((slot, mut rec, frame)) = self.pending.pop_front() else { return };
        let (stage, w, h) = {
            let st = self.state.as_ref().unwrap();
            (st.stages[slot].clone(), st.w, st.h)
        };
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        if unsafe { self.ctx.Map(&stage, 0, D3D11_MAP_READ, 0, Some(&mut m)) }.is_ok() {
            let pitch = m.RowPitch as usize;
            let len = pitch * h as usize * 3 / 2;
            let data = unsafe { std::slice::from_raw_parts(m.pData as *const u8, len) };
            let row = w as usize;
            self.buf.resize(row * h as usize * 3 / 2, 0);
            for y in 0..(h as usize * 3 / 2) {
                self.buf[y * row..(y + 1) * row].copy_from_slice(&data[y * pitch..y * pitch + row]);
            }
            rec.idx = decode_bpp(data, pitch, self.code.rx as usize, self.code.ry as usize, self.code.cell as usize, 1)
                .map(i64::from)
                .unwrap_or(-1);
            unsafe { self.ctx.Unmap(&stage, 0) };
        }
        drop(frame);
        rec.done_ns = qpc_ns();
        sink.put(rec);
    }
}

fn create_device(adapter_index: Option<u32>) -> Result<(ID3D11Device, ID3D11DeviceContext, String)> {
    let mut device: Option<ID3D11Device> = None;
    let mut ctx: Option<ID3D11DeviceContext> = None;
    let adapter: Option<IDXGIAdapter1> = match adapter_index {
        Some(i) => {
            let f: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
            Some(unsafe { f.EnumAdapters1(i)? })
        }
        None => None,
    };
    let driver = if adapter.is_some() { D3D_DRIVER_TYPE_UNKNOWN } else { D3D_DRIVER_TYPE_HARDWARE };
    let base: Option<IDXGIAdapter> = adapter.as_ref().map(|a| a.cast().unwrap());
    unsafe {
        D3D11CreateDevice(
            base.as_ref(),
            driver,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device as *mut _),
            None,
            Some(&mut ctx as *mut _),
        )?;
    }
    let device = device.unwrap();
    if let Ok(mt) = device.cast::<ID3D11Multithread>() {
        unsafe {
            let _ = mt.SetMultithreadProtected(true);
        }
    }
    let a = unsafe { device.cast::<IDXGIDevice>()?.GetAdapter()? };
    let desc = unsafe { a.GetDesc()? };
    let name = String::from_utf16_lossy(&desc.Description).trim_end_matches('\0').to_string();
    Ok((device, ctx.unwrap(), name))
}

fn dwm() -> DWM_TIMING_INFO {
    let mut t = DWM_TIMING_INFO {
        cbSize: std::mem::size_of::<DWM_TIMING_INFO>() as u32,
        ..Default::default()
    };
    unsafe {
        let _ = DwmGetCompositionTimingInfo(Default::default(), &mut t);
    }
    t
}

pub fn run() -> anyhow_lite::R {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        RoInitialize(RO_INIT_MULTITHREADED)?;
    }
    let a = parse_args();
    let code = load_code(&a.stim);
    let fmt = if a.fmt == "bgra" { DXGI_FORMAT_B8G8R8A8_UNORM } else { DXGI_FORMAT_R8G8B8A8_UNORM };
    let (device, ctx, adapter) = create_device(a.adapter)?;
    let file = File::create(&a.out)?;
    let sink = Arc::new(Sink {
        w: Mutex::new((BufWriter::new(file), Vec::new())),
    });
    sink.w.lock().unwrap().0.write_all(b"seq,cb_ns,src_ns,acc,idx,done_ns,status\n")?;

    let dwm0 = dwm();
    let t0 = qpc_ns();
    let start = Instant::now();
    let seq = Arc::new(AtomicU64::new(0));
    let dropped = Arc::new(AtomicU64::new(0));
    let mut extra = serde_json::Map::new();

    if a.mode == "dxgi" {
        let out = unsafe { device.cast::<IDXGIDevice>()?.GetAdapter()?.EnumOutputs(0)? };
        let out1: IDXGIOutput1 = out.cast()?;
        let dup = unsafe { out1.DuplicateOutput(&device)? };
        let mut reader = CodeReader::new(&device, &ctx, code, DXGI_FORMAT_B8G8R8A8_UNORM)?;
        let mut noimg = 0u64;
        while start.elapsed().as_secs_f64() < a.secs {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut res: Option<IDXGIResource> = None;
            match unsafe { dup.AcquireNextFrame(100, &mut info, &mut res) } {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => continue,
                Err(e) => return Err(e.into()),
            }
            let cb = qpc_ns();
            let s = seq.fetch_add(1, Ordering::Relaxed);
            if info.LastPresentTime == 0 {
                noimg += 1;
                sink.put(Rec { seq: s, cb_ns: cb, status: ST_NOIMG, idx: -1, ..Default::default() });
            } else {
                let tex: ID3D11Texture2D = res.unwrap().cast()?;
                let rec = Rec {
                    seq: s,
                    cb_ns: cb,
                    src_ns: qpc_to_ns(info.LastPresentTime),
                    acc: info.AccumulatedFrames,
                    idx: -1,
                    ..Default::default()
                };
                reader.push(&tex, rec, &sink);
            }
            unsafe { dup.ReleaseFrame()? };
        }
        reader.flush(&sink);
        extra.insert("noimg".into(), noimg.into());
    } else {
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let hmon = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
        let item: GraphicsCaptureItem = unsafe { interop.CreateForMonitor(hmon)? };
        let size = item.Size()?;
        let d3d: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>()?)? }.cast()?;
        let pf = if a.fmt == "bgra" {
            DirectXPixelFormat::B8G8R8A8UIntNormalized
        } else {
            DirectXPixelFormat::R8G8B8A8UIntNormalized
        };
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&d3d, pf, a.pool, size)?;
        let session = pool.CreateCaptureSession(&item)?;
        let _ = session.SetIsBorderRequired(false);
        let _ = session.SetIsCursorCaptureEnabled(a.cursor);
        if a.min_interval_us > 0 {
            session.SetMinUpdateInterval(Duration::from_micros(a.min_interval_us).into())?;
        }

        type Held = (Option<Direct3D11CaptureFrame>, ID3D11Texture2D, Rec);
        let (tx, rx): (SyncSender<Held>, Receiver<Held>) = sync_channel(a.queue.max(1));
        let free: Arc<Mutex<Vec<ID3D11Texture2D>>> = Arc::new(Mutex::new(Vec::new()));
        if a.release == "ring" {
            let mut f = free.lock().unwrap();
            for _ in 0..a.ring {
                f.push(default_tex(&device, size.Width as u32, size.Height as u32, fmt)?);
            }
        }
        let worker = if a.release == "immediate" {
            None
        } else {
            let mut fr = FullReader {
                device: device.clone(),
                ctx: ctx.clone(),
                stage: None,
                buf: Vec::new(),
                code,
                fmt,
                work: Duration::from_micros(a.work_us),
                map_mode: a.map_mode.clone(),
                pipe: VecDeque::new(),
                pipe_free: Vec::new(),
                small: None,
            };
            let sink = sink.clone();
            let free = free.clone();
            let is_ring = a.release == "ring";
            let mut nv = (a.release == "nv12").then(|| Nv12Reader {
                device: device.clone(),
                ctx: ctx.clone(),
                code,
                readback: a.map_mode != "nv12blit",
                state: None,
                pending: VecDeque::new(),
                next: 0,
                buf: Vec::new(),
                small: None,
                fmt,
                failed: None,
            });
            let mut nv_logged = false;
            Some(std::thread::spawn(move || {
                while let Ok((frame, tex, rec)) = rx.recv() {
                    if let Some(nv) = nv.as_mut() {
                        nv.read(&tex, rec, frame, &sink);
                        if !nv_logged {
                            if let Some(f) = nv.failed.as_ref() {
                                eprintln!("nv12 path failed: {f}");
                                nv_logged = true;
                            }
                        }
                        continue;
                    }
                    if fr.map_mode == "pipe" && !is_ring {
                        fr.read_pipe(&tex, rec, frame, &sink);
                        continue;
                    }
                    fr.read(&tex, rec, &sink);
                    drop(frame);
                    if is_ring {
                        free.lock().unwrap().push(tex);
                    }
                }
                fr.flush(&sink);
            }))
        };
        let reader = Arc::new(Mutex::new(CodeReader::new(&device, &ctx, code, fmt)?));
        let cb_nv12 = (a.release == "immediate" && a.map_mode.starts_with("cb")).then(|| {
            Mutex::new(Nv12Reader {
                device: device.clone(),
                ctx: ctx.clone(),
                code,
                readback: a.map_mode == "cbstage",
                state: None,
                pending: VecDeque::new(),
                next: 0,
                buf: Vec::new(),
                small: None,
                fmt,
                failed: None,
            })
        });
        if a.memload {
            let secs = a.secs;
            std::thread::spawn(move || {
                let src = vec![7u8; 1920 * 1080 * 4];
                let mut dst = vec![0u8; 1920 * 1080 * 4];
                let t0 = Instant::now();
                while t0.elapsed().as_secs_f64() < secs + 1.0 {
                    let tick = Instant::now();
                    dst.copy_from_slice(&src);
                    std::hint::black_box(&dst);
                    let spent = tick.elapsed();
                    if spent < Duration::from_micros(16_667) {
                        std::thread::sleep(Duration::from_micros(16_667) - spent);
                    }
                }
            });
        }
        let gpu_sink: Option<ID3D11Texture2D> = if a.gpucopy {
            Some(default_tex(&device, size.Width as u32, size.Height as u32, fmt)?)
        } else {
            None
        };
        let release = a.release.clone();
        let ctx2 = ctx.clone();
        let (sink2, seq2, dropped2, reader2, free2) =
            (sink.clone(), seq.clone(), dropped.clone(), reader.clone(), free.clone());
        let tx2 = Mutex::new(Some(tx));
        let token = pool.FrameArrived(&TypedEventHandler::new(
            move |p: windows::core::Ref<'_, Direct3D11CaptureFramePool>, _| -> Result<()> {
                let Some(p) = p.as_ref() else { return Ok(()) };
                let frame = p.TryGetNextFrame()?;
                let cb = qpc_ns();
                let s = seq2.fetch_add(1, Ordering::Relaxed);
                let src = frame.SystemRelativeTime()?.Duration * 100;
                let tex: ID3D11Texture2D = unsafe {
                    frame
                        .Surface()?
                        .cast::<IDirect3DDxgiInterfaceAccess>()?
                        .GetInterface::<ID3D11Texture2D>()?
                };
                let rec = Rec { seq: s, cb_ns: cb, src_ns: src, idx: -1, ..Default::default() };
                match release.as_str() {
                    "immediate" if cb_nv12.is_some() => {
                        cb_nv12.as_ref().unwrap().lock().unwrap().read(&tex, rec, None, &sink2);
                        drop(frame);
                    }
                    "immediate" => {
                        if let Some(g) = gpu_sink.as_ref() {
                            unsafe { ctx2.CopyResource(g, &tex) };
                        }
                        reader2.lock().unwrap().push(&tex, rec, &sink2);
                        drop(frame);
                    }
                    "ring" => {
                        let own = free2.lock().unwrap().pop();
                        match own {
                            Some(own) => {
                                unsafe { ctx2.CopyResource(&own, &tex) };
                                drop(frame);
                                if let Some(tx) = tx2.lock().unwrap().as_ref() {
                                    if tx.try_send((None, own, rec)).is_err() {
                                        dropped2.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                            }
                            None => {
                                drop(frame);
                                dropped2.fetch_add(1, Ordering::Relaxed);
                                sink2.put(Rec { status: ST_DROPPED, ..rec });
                            }
                        }
                    }
                    _ => {
                        let g = tx2.lock().unwrap();
                        let Some(tx) = g.as_ref() else { return Ok(()) };
                        let mut item = (Some(frame), tex, rec);
                        let deadline = Instant::now() + Duration::from_millis(50);
                        loop {
                            match tx.try_send(item) {
                                Ok(()) => break,
                                Err(TrySendError::Full(back)) => {
                                    if Instant::now() >= deadline {
                                        dropped2.fetch_add(1, Ordering::Relaxed);
                                        sink2.put(Rec { status: ST_DROPPED, ..back.2 });
                                        break;
                                    }
                                    item = back;
                                    std::thread::sleep(Duration::from_micros(500));
                                }
                                Err(TrySendError::Disconnected(_)) => break,
                            }
                        }
                    }
                }
                Ok(())
            },
        ))?;
        session.StartCapture()?;
        std::thread::sleep(Duration::from_secs_f64(a.secs));
        pool.RemoveFrameArrived(token)?;
        std::thread::sleep(Duration::from_millis(100));
        session.Close()?;
        reader.lock().unwrap().flush(&sink);
        drop(worker);
        pool.Close()?;
        extra.insert("pool_w".into(), size.Width.into());
        extra.insert("pool_h".into(), size.Height.into());
    }
    std::thread::sleep(Duration::from_millis(500));
    let t1 = qpc_ns();
    let dwm1 = dwm();

    let g = sink.w.lock().unwrap();
    let recs = &g.1;
    let mut ok: Vec<&Rec> = recs.iter().filter(|r| r.status == ST_OK).collect();
    ok.sort_by_key(|r| r.seq);
    let delivered = ok.len();
    let decoded: Vec<i64> = ok.iter().filter(|r| r.idx >= 0).map(|r| r.idx).collect();
    let mut uniq = decoded.clone();
    uniq.sort();
    uniq.dedup();
    let dups = decoded.windows(2).filter(|w| w[0] == w[1]).count();
    let backwards = decoded.windows(2).filter(|w| w[1] < w[0]).count();
    let (first, last) = (uniq.first().copied().unwrap_or(0), uniq.last().copied().unwrap_or(0));
    let span = if uniq.is_empty() { 0 } else { last - first + 1 };
    let mut gaps: Vec<f64> = ok.windows(2).map(|w| (w[1].cb_ns - w[0].cb_ns) as f64 / 1e6).collect();
    gaps.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let pct = |p: f64| -> f64 {
        if gaps.is_empty() {
            0.0
        } else {
            gaps[((gaps.len() - 1) as f64 * p) as usize]
        }
    };
    let lat: Vec<i64> = ok.iter().filter(|r| r.src_ns > 0).map(|r| r.cb_ns - r.src_ns).collect();
    let mean_lat = if lat.is_empty() { 0.0 } else { lat.iter().sum::<i64>() as f64 / lat.len() as f64 / 1e6 };
    let active = if ok.len() > 1 { (ok[ok.len() - 1].cb_ns - ok[0].cb_ns) as f64 / 1e9 } else { 0.0 };
    let mut s = serde_json::json!({
        "mode": a.mode, "release": a.release, "pool": a.pool, "min_interval_us": a.min_interval_us,
        "cursor": a.cursor, "fmt": a.fmt, "work_us": a.work_us, "queue": a.queue, "ring": a.ring,
        "adapter": adapter, "secs": a.secs, "active_s": active,
        "callbacks": recs.len(), "delivered": delivered, "dropped": dropped.load(Ordering::Relaxed),
        "decoded": decoded.len(), "unique": uniq.len(), "consecutive_dups": dups, "backwards": backwards,
        "first_idx": first, "last_idx": last, "span": span, "missed_in_span": span - uniq.len() as i64,
        "delivered_fps": if active > 0.0 { delivered as f64 / active } else { 0.0 },
        "unique_fps": if active > 0.0 { uniq.len() as f64 / active } else { 0.0 },
        "gap_ms_p50": pct(0.5), "gap_ms_p99": pct(0.99), "gap_ms_max": pct(1.0),
        "latency_ms_mean": mean_lat,
        "dwm_frames": dwm1.cFrame.saturating_sub(dwm0.cFrame),
        "dwm_refreshes": dwm1.cRefresh.saturating_sub(dwm0.cRefresh),
        "dwm_frames_displayed": dwm1.cFramesDisplayed.saturating_sub(dwm0.cFramesDisplayed),
        "dwm_frames_dropped": dwm1.cFramesDropped.saturating_sub(dwm0.cFramesDropped),
        "dwm_frames_missed": dwm1.cFramesMissed.saturating_sub(dwm0.cFramesMissed),
        "dwm_window_s": (t1 - t0) as f64 / 1e9,
        "t0_ns": t0, "t1_ns": t1,
    });
    for (k, v) in extra {
        s[k] = v;
    }
    println!("{s}");
    std::fs::write(format!("{}.json", a.out), s.to_string())?;
    Ok(())
}

mod anyhow_lite {
    pub type R = std::result::Result<(), Box<dyn std::error::Error>>;
}
