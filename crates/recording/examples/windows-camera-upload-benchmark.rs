//! Measures the Windows native camera upload path: the per-frame media buffer
//! copy plus `upload_mf_buffer_to_texture`. `before` replays frames through an
//! inline copy of the previous path (new `MFCreateMemoryBuffer` and new
//! `CreateTexture2D` per frame), `after` through the pooled buffers and the
//! library upload.
//!
//!   cargo build --release -p cap-recording --example windows-camera-upload-benchmark
//!   windows-camera-upload-benchmark capture frames.bin [camera name]
//!   windows-camera-upload-benchmark both frames.bin
//!   windows-camera-upload-benchmark before frames.bin
//!   windows-camera-upload-benchmark after frames.bin
//!   windows-camera-upload-benchmark validate

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("windows-camera-upload-benchmark: skipped (not Windows)");
}

#[cfg(target_os = "windows")]
fn main() -> anyhow::Result<()> {
    windows_bench::run()
}

#[cfg(target_os = "windows")]
mod windows_bench {
    use anyhow::{Context, bail};
    use cap_camera_windows::PixelFormat;
    use cap_mediafoundation_utils::IMFMediaBufferExt;
    use cap_recording::{CameraBuffers, NativeCameraFrame, upload_mf_buffer_to_texture};
    use std::{
        fs::File,
        io::{BufReader, BufWriter, Read, Write},
        sync::{Arc, Mutex, mpsc},
        time::{Duration, Instant},
    };
    use windows::Win32::{
        Foundation::{FILETIME, HMODULE},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            Direct3D11::*,
            Dxgi::{Common::*, IDXGIDevice},
        },
        Media::MediaFoundation::{IMFMediaBuffer, MFCreateMemoryBuffer},
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };
    use windows::core::Interface;

    const FRAME_COUNT: usize = 300;
    const WARMUP_FRAMES: usize = 30;
    const REPEATS: usize = 5;
    const POOL_SIZE: usize = 3;

    struct RawFrame {
        bytes: Vec<u8>,
        width: u32,
        height: u32,
        pixel_format: PixelFormat,
        bottom_up: bool,
        counter: i64,
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Side {
        Before,
        After,
    }

    struct Stats {
        median: f64,
        p95: f64,
        mean: f64,
        cpu: f64,
    }

    struct Gpu {
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        query: ID3D11Query,
    }

    impl Gpu {
        fn new() -> anyhow::Result<Self> {
            let mut device = None;
            unsafe {
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    None,
                )?;
            }
            let device = device.context("No hardware D3D11 device")?;
            let adapter = unsafe { device.cast::<IDXGIDevice>()?.GetAdapter()?.GetDesc()? };
            println!(
                "GPU: {}",
                String::from_utf16_lossy(&adapter.Description).trim_end_matches('\0')
            );
            let context = unsafe { device.GetImmediateContext()? };
            let mut query = None;
            unsafe {
                device.CreateQuery(
                    &D3D11_QUERY_DESC {
                        Query: D3D11_QUERY_EVENT,
                        MiscFlags: 0,
                    },
                    Some(&mut query),
                )?;
            }
            Ok(Self {
                device,
                context,
                query: query.context("No event query")?,
            })
        }

        fn flush(&self) {
            unsafe { self.context.Flush() };
        }

        fn wait(&self) -> anyhow::Result<()> {
            unsafe {
                self.context.End(&self.query);
                self.context.Flush();
            }
            let start = Instant::now();
            loop {
                let mut done = 0u32;
                unsafe {
                    self.context.GetData(
                        &self.query,
                        Some((&mut done as *mut u32).cast()),
                        4,
                        D3D11_ASYNC_GETDATA_DONOTFLUSH.0 as u32,
                    )?;
                }
                if done != 0 {
                    return Ok(());
                }
                if start.elapsed() > Duration::from_secs(10) {
                    bail!("GPU completion timeout");
                }
                std::hint::spin_loop();
            }
        }
    }

    fn format_code(format: PixelFormat) -> anyhow::Result<u32> {
        Ok(match format {
            PixelFormat::YUYV422 => 0,
            PixelFormat::UYVY422 => 1,
            PixelFormat::NV12 => 2,
            PixelFormat::RGB32 => 3,
            PixelFormat::ARGB => 4,
            _ => bail!("Unsupported capture format {format:?}"),
        })
    }

    fn format_from_code(code: u32) -> anyhow::Result<PixelFormat> {
        Ok(match code {
            0 => PixelFormat::YUYV422,
            1 => PixelFormat::UYVY422,
            2 => PixelFormat::NV12,
            3 => PixelFormat::RGB32,
            4 => PixelFormat::ARGB,
            _ => bail!("Invalid saved format {code}"),
        })
    }

    fn capture(path: &str, name: Option<&str>) -> anyhow::Result<()> {
        let camera = cap_camera::list_cameras()
            .find(|camera| name.is_none_or(|name| camera.display_name().contains(name)))
            .context("Camera not found")?;
        println!("Camera: {} {:?}", camera.display_name(), camera.model_id());
        let mut formats = camera.formats().context("No camera formats")?;
        formats.retain(|format| {
            matches!(
                format.pixel_format_name().as_deref(),
                Some("YUYV422" | "NV12" | "RGB32" | "ARGB")
            )
        });
        formats.sort_by_key(|format| {
            (
                format.width().abs_diff(1920) + format.height().abs_diff(1080),
                ((format.frame_rate() - 30.0).abs() * 100.0) as u32,
                format.pixel_format_name().as_deref() != Some("YUYV422"),
            )
        });
        let format = formats
            .into_iter()
            .next()
            .context("No uncompressed camera format")?;
        println!(
            "Mode: {}x{} @ {} fps {:?}",
            format.width(),
            format.height(),
            format.frame_rate(),
            format.pixel_format_name()
        );

        let (tx, rx) = mpsc::sync_channel(FRAME_COUNT);
        let handle = camera.start_capturing(format, move |frame| {
            let native = frame.native();
            if let Ok(bytes) = native.bytes() {
                let _ = tx.try_send(RawFrame {
                    bytes: bytes.to_vec(),
                    width: native.width as u32,
                    height: native.height as u32,
                    pixel_format: native.pixel_format,
                    bottom_up: native.is_bottom_up,
                    counter: native.perf_counter,
                });
            }
        })?;
        let frames = (0..FRAME_COUNT)
            .map(|_| rx.recv_timeout(Duration::from_secs(15)))
            .collect::<Result<Vec<_>, _>>()?;
        handle.stop_capturing().map_err(anyhow::Error::msg)?;
        if frames.iter().any(|frame| frame.bottom_up) {
            bail!("The before path does not support bottom-up frames");
        }

        let mut file = BufWriter::new(File::create(path)?);
        for frame in &frames {
            for value in [
                frame.width,
                frame.height,
                format_code(frame.pixel_format)?,
                u32::from(frame.bottom_up),
                frame.bytes.len() as u32,
            ] {
                file.write_all(&value.to_le_bytes())?;
            }
            file.write_all(&frame.counter.to_le_bytes())?;
            file.write_all(&frame.bytes)?;
        }
        file.flush()?;
        println!(
            "Captured {} frames {:?} {}x{} bottom_up={} bytes={}",
            frames.len(),
            frames[0].pixel_format,
            frames[0].width,
            frames[0].height,
            frames[0].bottom_up,
            frames[0].bytes.len()
        );
        Ok(())
    }

    fn load(path: &str) -> anyhow::Result<Vec<RawFrame>> {
        let mut file = BufReader::new(File::open(path)?);
        let mut frames = Vec::with_capacity(FRAME_COUNT);
        for _ in 0..FRAME_COUNT {
            let mut values = [0u32; 5];
            for value in &mut values {
                let mut bytes = [0; 4];
                file.read_exact(&mut bytes)?;
                *value = u32::from_le_bytes(bytes);
            }
            let mut counter = [0; 8];
            file.read_exact(&mut counter)?;
            let mut bytes = vec![0; values[4] as usize];
            file.read_exact(&mut bytes)?;
            frames.push(RawFrame {
                bytes,
                width: values[0],
                height: values[1],
                pixel_format: format_from_code(values[2])?,
                bottom_up: values[3] != 0,
                counter: i64::from_le_bytes(counter),
            });
        }
        Ok(frames)
    }

    fn fill_buffer(buffer: &IMFMediaBuffer, bytes: &[u8]) -> anyhow::Result<()> {
        buffer.lock_for_write()?[..bytes.len()].copy_from_slice(bytes);
        unsafe { buffer.SetCurrentLength(bytes.len() as u32)? };
        Ok(())
    }

    fn native_frame(raw: &RawFrame, buffer: Arc<Mutex<IMFMediaBuffer>>) -> NativeCameraFrame {
        NativeCameraFrame {
            buffer,
            pixel_format: raw.pixel_format,
            width: raw.width,
            height: raw.height,
            is_bottom_up: raw.bottom_up,
            timestamp: cap_timestamp::Timestamp::PerformanceCounter(
                cap_timestamp::PerformanceCounterTimestamp::new(raw.counter),
            ),
        }
    }

    fn new_frame(raw: &RawFrame) -> anyhow::Result<NativeCameraFrame> {
        let buffer = unsafe { MFCreateMemoryBuffer(raw.bytes.len() as u32)? };
        fill_buffer(&buffer, &raw.bytes)?;
        Ok(native_frame(raw, Arc::from(Mutex::new(buffer))))
    }

    fn pooled_frame(
        raw: &RawFrame,
        pool: &mut Vec<(NativeCameraFrame, usize)>,
    ) -> anyhow::Result<NativeCameraFrame> {
        let reusable = pool
            .iter()
            .find(|(frame, capacity)| {
                *capacity >= raw.bytes.len() && Arc::strong_count(&frame.buffer) == 1
            })
            .map(|(frame, _)| frame.buffer.clone());
        let Some(buffer) = reusable else {
            let frame = new_frame(raw)?;
            if pool.len() < POOL_SIZE {
                pool.push((frame.clone(), raw.bytes.len()));
            }
            return Ok(frame);
        };
        {
            let guard = buffer
                .lock()
                .map_err(|_| anyhow::anyhow!("Buffer poisoned"))?;
            fill_buffer(&guard, &raw.bytes)?;
        }
        Ok(native_frame(raw, buffer))
    }

    fn legacy_upload(device: &ID3D11Device, raw: &RawFrame) -> anyhow::Result<ID3D11Texture2D> {
        let (format, rows) = match (raw.pixel_format, raw.bottom_up) {
            (PixelFormat::NV12, false) => (DXGI_FORMAT_NV12, raw.height + raw.height / 2),
            (PixelFormat::YUYV422, false) => (DXGI_FORMAT_YUY2, raw.height),
            (PixelFormat::RGB32 | PixelFormat::ARGB, false) => {
                (DXGI_FORMAT_B8G8R8A8_UNORM, raw.height)
            }
            _ => bail!("The before path supports top-down NV12, YUYV422, RGB32 and ARGB frames"),
        };
        let frame = new_frame(raw)?;
        let buffer = frame
            .buffer
            .lock()
            .map_err(|_| anyhow::anyhow!("Buffer poisoned"))?;
        let lock = buffer.lock()?;
        let data = &*lock;
        let desc = D3D11_TEXTURE2D_DESC {
            Width: raw.width,
            Height: raw.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let init = D3D11_SUBRESOURCE_DATA {
            pSysMem: data.as_ptr().cast(),
            SysMemPitch: (data.len() / rows as usize) as u32,
            SysMemSlicePitch: 0,
        };
        let mut texture = None;
        unsafe { device.CreateTexture2D(&desc, Some(&init), Some(&mut texture))? };
        texture.context("CreateTexture2D returned no texture")
    }

    fn process_cpu_seconds() -> anyhow::Result<f64> {
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )?;
        }
        let ticks =
            |time: FILETIME| ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64;
        Ok((ticks(kernel) + ticks(user)) as f64 / 10_000_000.0)
    }

    fn measure(gpu: &Gpu, frames: &[RawFrame], side: Side, wait: bool) -> anyhow::Result<Stats> {
        let mut samples = Vec::with_capacity(frames.len() * REPEATS);
        let mut cpu = 0.0;
        for _ in 0..REPEATS {
            let mut buffers = CameraBuffers::new();
            let mut pool = Vec::new();
            let mut upload = |raw: &RawFrame| -> anyhow::Result<ID3D11Texture2D> {
                match side {
                    Side::Before => legacy_upload(&gpu.device, raw),
                    Side::After => {
                        let frame = pooled_frame(raw, &mut pool)?;
                        Ok(upload_mf_buffer_to_texture(
                            &gpu.device,
                            &frame,
                            &mut buffers,
                        )?)
                    }
                }
            };
            for raw in frames.iter().take(WARMUP_FRAMES) {
                drop(upload(raw)?);
                gpu.flush();
            }
            gpu.wait()?;
            let cpu_start = process_cpu_seconds()?;
            for raw in frames {
                let start = Instant::now();
                let texture = upload(raw)?;
                if wait {
                    gpu.wait()?;
                } else {
                    gpu.flush();
                }
                drop(texture);
                samples.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            gpu.wait()?;
            cpu += process_cpu_seconds()? - cpu_start;
        }
        samples.sort_by(f64::total_cmp);
        Ok(Stats {
            median: samples[samples.len() / 2],
            p95: samples[(samples.len() * 95).div_ceil(100) - 1],
            mean: samples.iter().sum::<f64>() / samples.len() as f64,
            cpu,
        })
    }

    fn bench(path: &str, sides: &[Side]) -> anyhow::Result<()> {
        let frames = load(path)?;
        let gpu = Gpu::new()?;
        println!(
            "Frames: {} x {:?} {}x{}, {WARMUP_FRAMES} warmup, {REPEATS} repeats",
            frames.len(),
            frames[0].pixel_format,
            frames[0].width,
            frames[0].height
        );
        for (wait, mode) in [(false, "submit"), (true, "gpu-complete")] {
            let mut results = Vec::new();
            for &side in sides {
                let stats = measure(&gpu, &frames, side, wait)?;
                println!(
                    "{mode} {}: median_ms={:.3} p95_ms={:.3} mean_ms={:.3} cpu_s={:.3}",
                    if side == Side::Before {
                        "before"
                    } else {
                        "after"
                    },
                    stats.median,
                    stats.p95,
                    stats.mean,
                    stats.cpu
                );
                results.push(stats);
            }
            if let [before, after] = results.as_slice() {
                println!(
                    "{mode} speedup: median {:.2}x p95 {:.2}x mean {:.2}x cpu {:.2}x",
                    before.median / after.median,
                    before.p95 / after.p95,
                    before.mean / after.mean,
                    before.cpu / after.cpu
                );
            }
        }
        Ok(())
    }

    fn validate() -> anyhow::Result<()> {
        let gpu = Gpu::new()?;
        let mut buffers = CameraBuffers::new();
        let mut checks = Vec::new();
        for (width, height) in [(64u32, 32u32), (128, 48), (64, 32)] {
            for format in [
                PixelFormat::YUYV422,
                PixelFormat::UYVY422,
                PixelFormat::NV12,
                PixelFormat::RGB32,
                PixelFormat::ARGB,
            ] {
                for flip in [false, true] {
                    for sequence in 0..3u8 {
                        let row_bytes = width as usize
                            * match format {
                                PixelFormat::NV12 => 1,
                                PixelFormat::RGB32 | PixelFormat::ARGB => 4,
                                _ => 2,
                            };
                        let pitch = row_bytes + 16;
                        let rows = height as usize
                            + if format == PixelFormat::NV12 {
                                height as usize / 2
                            } else {
                                0
                            };
                        let mut bytes = vec![0; pitch * rows];
                        for (row, data) in bytes.chunks_exact_mut(pitch).enumerate() {
                            for (column, value) in data.iter_mut().enumerate() {
                                *value = (row as u8)
                                    .wrapping_mul(7)
                                    .wrapping_add(column as u8)
                                    .wrapping_add(sequence.wrapping_mul(53));
                            }
                        }
                        let mut expected = vec![0; row_bytes * rows];
                        for row in 0..rows {
                            let source_row = if !flip {
                                row
                            } else if row < height as usize {
                                height as usize - 1 - row
                            } else {
                                rows - 1 - (row - height as usize)
                            };
                            let source = &bytes[source_row * pitch..source_row * pitch + row_bytes];
                            let dest = &mut expected[row * row_bytes..(row + 1) * row_bytes];
                            if format == PixelFormat::UYVY422 {
                                for (src, dst) in
                                    source.chunks_exact(4).zip(dest.chunks_exact_mut(4))
                                {
                                    dst.copy_from_slice(&[src[1], src[0], src[3], src[2]]);
                                }
                            } else {
                                dest.copy_from_slice(source);
                            }
                        }
                        let raw = RawFrame {
                            bytes,
                            width,
                            height,
                            pixel_format: format,
                            bottom_up: flip,
                            counter: 0,
                        };
                        let frame = new_frame(&raw)?;
                        let texture =
                            upload_mf_buffer_to_texture(&gpu.device, &frame, &mut buffers)?;
                        let mut desc = D3D11_TEXTURE2D_DESC::default();
                        unsafe { texture.GetDesc(&mut desc) };
                        desc.Usage = D3D11_USAGE_STAGING;
                        desc.BindFlags = 0;
                        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                        let mut readback = None;
                        unsafe {
                            gpu.device
                                .CreateTexture2D(&desc, None, Some(&mut readback))?;
                            gpu.context.CopyResource(
                                readback.as_ref().context("No readback texture")?,
                                &texture,
                            );
                        }
                        checks.push((readback, expected, row_bytes, rows, format, flip));
                    }
                }
            }
        }
        gpu.wait()?;
        let count = checks.len();
        for (readback, expected, row_bytes, rows, format, flip) in checks {
            let readback = readback.context("No readback texture")?;
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            unsafe {
                gpu.context
                    .Map(&readback, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            }
            let matches = (0..rows).all(|row| {
                let actual = unsafe {
                    std::slice::from_raw_parts(
                        mapped
                            .pData
                            .cast::<u8>()
                            .add(row * mapped.RowPitch as usize),
                        row_bytes,
                    )
                };
                actual == &expected[row * row_bytes..(row + 1) * row_bytes]
            });
            unsafe { gpu.context.Unmap(&readback, 0) };
            if !matches {
                bail!("Readback mismatch for {format:?} flip={flip}");
            }
        }
        println!("Validation: {count} GPU readbacks matched");
        Ok(())
    }

    pub fn run() -> anyhow::Result<()> {
        cap_mediafoundation_utils::thread_init();
        let args: Vec<String> = std::env::args().skip(1).collect();
        let path = || {
            args.get(1)
                .map(String::as_str)
                .context("Expected a frames file path")
        };
        match args.first().map(String::as_str) {
            Some("capture") => capture(path()?, args.get(2).map(String::as_str)),
            Some("before") => bench(path()?, &[Side::Before]),
            Some("after") => bench(path()?, &[Side::After]),
            Some("both") => bench(path()?, &[Side::Before, Side::After]),
            Some("validate") => validate(),
            _ => bail!(
                "Usage: capture <frames.bin> [camera name] | before <frames.bin> | after <frames.bin> | both <frames.bin> | validate"
            ),
        }
    }
}
