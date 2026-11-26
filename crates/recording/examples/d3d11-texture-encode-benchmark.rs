//! `cargo run -p cap-recording --example d3d11-texture-encode-benchmark --release`

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows only. Run this on DESKTOP-MQ99RT1.");
}

#[cfg(windows)]
fn main() {
    windows::run();
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use cap_enc_ffmpeg::h264::H264Preset;
    use cap_enc_ffmpeg::remux::concatenate_m4s_segments_with_init;
    use cap_enc_ffmpeg::segmented_stream::{SegmentedVideoEncoder, SegmentedVideoEncoderConfig};
    use cap_media_info::{RawVideoFormat, VideoInfo};
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
        D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device,
        ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC};
    use windows::Win32::Graphics::Dxgi::{IDXGIAdapter, IDXGIDevice};
    use windows::core::Interface;

    use cap_recording::GpuTextureRing;

    const WARMUP: usize = 30;
    const FRAMES: usize = 300;
    const RUNS: usize = 5;
    const SOURCES: usize = 4;
    const FPS: u32 = 60;
    const FRAME_TICK_US: u64 = 1_000_000 / 60;

    #[repr(C)]
    struct Filetime {
        low: u32,
        high: u32,
    }

    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn GetProcessTimes(
            process: *mut c_void,
            created: *mut Filetime,
            exited: *mut Filetime,
            kernel: *mut Filetime,
            user: *mut Filetime,
        ) -> i32;
    }

    fn process_cpu() -> Duration {
        let mut created = Filetime { low: 0, high: 0 };
        let mut exited = Filetime { low: 0, high: 0 };
        let mut kernel = Filetime { low: 0, high: 0 };
        let mut user = Filetime { low: 0, high: 0 };
        let ok = unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        };
        if ok == 0 {
            return Duration::ZERO;
        }
        let ticks = (u64::from(kernel.high) << 32 | u64::from(kernel.low))
            + (u64::from(user.high) << 32 | u64::from(user.low));
        Duration::from_nanos(ticks.saturating_mul(100))
    }

    fn frame_timestamp(index: usize) -> Duration {
        Duration::from_micros(index as u64 * FRAME_TICK_US)
    }

    fn repeats_previous(index: usize) -> bool {
        index % 2 == 1
    }

    fn reference_frame(frame: &ffmpeg::frame::Video) -> ffmpeg::frame::Video {
        let mut reference = ffmpeg::frame::Video::empty();
        let status = unsafe { ffmpeg::ffi::av_frame_ref(reference.as_mut_ptr(), frame.as_ptr()) };
        assert!(status >= 0, "av_frame_ref {status}");
        reference
    }

    fn median(values: &mut [u128]) -> u128 {
        values.sort_unstable();
        let mid = values.len() / 2;
        if values.len().is_multiple_of(2) {
            values[mid - 1].midpoint(values[mid])
        } else {
            values[mid]
        }
    }

    struct Device {
        device: ID3D11Device,
        context: ID3D11DeviceContext,
    }

    fn open_device() -> Device {
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
            )
            .expect("D3D11CreateDevice");
        }
        let device = device.expect("D3D11 device");
        if let Ok(multithread) = device.cast::<ID3D11Multithread>() {
            let _ = unsafe { multithread.SetMultithreadProtected(true) };
        }
        let context = unsafe { device.GetImmediateContext() }.expect("immediate context");
        Device { device, context }
    }

    fn rgba_texture(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        cpu_read: bool,
    ) -> ID3D11Texture2D {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: if cpu_read {
                D3D11_USAGE_STAGING
            } else {
                D3D11_USAGE_DEFAULT
            },
            BindFlags: if cpu_read {
                0
            } else {
                (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32
            },
            CPUAccessFlags: if cpu_read {
                windows::Win32::Graphics::Direct3D11::D3D11_CPU_ACCESS_READ.0 as u32
            } else {
                0
            },
            MiscFlags: 0,
        };
        let mut texture = None;
        unsafe {
            device
                .CreateTexture2D(&desc, None, Some(&mut texture))
                .expect("CreateTexture2D");
        }
        texture.expect("texture")
    }

    fn paint(device: &Device, texture: &ID3D11Texture2D, width: u32, height: u32, index: usize) {
        let stride = width as usize * 4;
        let mut bytes = vec![0u8; stride * height as usize];
        let shift = index * 4;
        for row in 0..height as usize {
            for col in 0..width as usize {
                let pixel = (row * stride) + col * 4;
                bytes[pixel] = ((col + shift) % 251) as u8;
                bytes[pixel + 1] = ((row + shift) % 251) as u8;
                bytes[pixel + 2] = ((row + col + shift) % 251) as u8;
                bytes[pixel + 3] = 255;
            }
        }
        unsafe {
            device.context.UpdateSubresource(
                texture,
                0,
                None,
                bytes.as_ptr() as *const c_void,
                stride as u32,
                0,
            );
        }
    }

    fn adapter_description(device: &ID3D11Device) -> String {
        let Ok(dxgi) = device.cast::<IDXGIDevice>() else {
            return "unknown".to_string();
        };
        let Ok(adapter) = (unsafe { dxgi.GetAdapter() }) else {
            return "unknown".to_string();
        };
        let Ok(desc) = (unsafe { IDXGIAdapter::GetDesc(&adapter) }) else {
            return "unknown".to_string();
        };
        let end = desc
            .Description
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(desc.Description.len());
        String::from_utf16_lossy(&desc.Description[..end])
    }

    fn readback(
        context: &ID3D11DeviceContext,
        source: &ID3D11Texture2D,
        staging: &ID3D11Texture2D,
        frame: &mut ffmpeg::frame::Video,
        width: u32,
        height: u32,
    ) {
        unsafe {
            context.CopyResource(staging, source);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            context
                .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .expect("Map");
            let src_stride = mapped.RowPitch as usize;
            let row_bytes = width as usize * 4;
            let dest_stride = frame.stride(0);
            let dest = frame.data_mut(0);
            for row in 0..height as usize {
                dest[row * dest_stride..row * dest_stride + row_bytes].copy_from_slice(
                    std::slice::from_raw_parts(
                        (mapped.pData as *const u8).add(row * src_stride),
                        row_bytes,
                    ),
                );
            }
            context.Unmap(staging, 0);
        }
    }

    struct Run {
        wall: Duration,
        cpu: Duration,
        decoded: usize,
        encoder: String,
        sw: String,
        ring_capacity: Option<u32>,
        ring_high_water: Option<u32>,
    }

    fn decode_count(path: &Path) -> usize {
        let mut input = ffmpeg::format::input(path).expect("open assembled output");
        let stream_index = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .expect("video stream")
            .index();
        let params = input.stream(stream_index).unwrap().parameters();
        let context = ffmpeg::codec::context::Context::from_parameters(params).expect("context");
        let mut decoder = context.decoder().video().expect("decoder");
        let mut frame = ffmpeg::frame::Video::empty();
        let mut count = 0usize;
        for (stream, packet) in input.packets() {
            if stream.index() != stream_index {
                continue;
            }
            if decoder.send_packet(&packet).is_ok() {
                while decoder.receive_frame(&mut frame).is_ok() {
                    count += 1;
                }
            }
        }
        if decoder.send_eof().is_ok() {
            while decoder.receive_frame(&mut frame).is_ok() {
                count += 1;
            }
        }
        count
    }

    fn assemble(dir: &Path) -> PathBuf {
        let mut segments: Vec<PathBuf> = std::fs::read_dir(dir)
            .expect("read segment dir")
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext == "m4s"))
            .collect();
        segments.sort();
        assert!(!segments.is_empty(), "no media segments in {dir:?}");
        let output = dir.join("assembled.mp4");
        concatenate_m4s_segments_with_init(&dir.join("init.mp4"), &segments, &output)
            .expect("assemble segments");
        output
    }

    fn run_readback(
        dir: &Path,
        device: &Device,
        sources: &[ID3D11Texture2D],
        staging: &ID3D11Texture2D,
        info: VideoInfo,
    ) -> Run {
        let mut encoder = SegmentedVideoEncoder::init(
            dir.to_path_buf(),
            info,
            SegmentedVideoEncoderConfig {
                preset: H264Preset::Ultrafast,
                ..Default::default()
            },
        )
        .expect("readback encoder");
        let encoder_name = encoder.codec_name();
        let mut reusable =
            ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBA, info.width, info.height);
        let mut last = ffmpeg::frame::Video::empty();
        for i in 0..WARMUP {
            let frame = readback_frame(device, sources, staging, info, &mut reusable, &mut last, i);
            encoder
                .queue_frame(frame, frame_timestamp(i))
                .expect("warmup readback");
        }
        let wall_start = Instant::now();
        let cpu_start = process_cpu();
        for i in 0..FRAMES {
            let index = WARMUP + i;
            let frame = readback_frame(
                device,
                sources,
                staging,
                info,
                &mut reusable,
                &mut last,
                index,
            );
            encoder
                .queue_frame(frame, frame_timestamp(index))
                .expect("readback frame");
        }
        let wall = wall_start.elapsed();
        let cpu = process_cpu().saturating_sub(cpu_start);
        encoder.finish().expect("finish readback");
        let decoded = decode_count(&assemble(dir));
        Run {
            wall,
            cpu,
            decoded,
            encoder: encoder_name,
            sw: "frames rgba".to_string(),
            ring_capacity: None,
            ring_high_water: None,
        }
    }

    fn readback_frame(
        device: &Device,
        sources: &[ID3D11Texture2D],
        staging: &ID3D11Texture2D,
        info: VideoInfo,
        reusable: &mut ffmpeg::frame::Video,
        last: &mut ffmpeg::frame::Video,
        index: usize,
    ) -> ffmpeg::frame::Video {
        if repeats_previous(index) {
            return reference_frame(last);
        }
        readback(
            &device.context,
            &sources[index % SOURCES],
            staging,
            reusable,
            info.width,
            info.height,
        );
        let mut owned =
            ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBA, info.width, info.height);
        std::mem::swap(&mut owned, reusable);
        *last = owned;
        reference_frame(last)
    }

    fn texture_refusal(ring: &GpuTextureRing, encoder: &str, sw: &str, reason: &str) -> String {
        format!(
            "{reason} encoder {encoder} {sw} ring {} high-water {}",
            ring.capacity(),
            ring.high_water()
        )
    }

    fn run_texture(
        dir: &Path,
        device: &Device,
        sources: &[ID3D11Texture2D],
        info: VideoInfo,
    ) -> Result<Run, String> {
        let mut encoder = SegmentedVideoEncoder::init(
            dir.to_path_buf(),
            info,
            SegmentedVideoEncoderConfig {
                preset: H264Preset::Ultrafast,
                d3d11_device: Some(device.device.as_raw() as usize),
                ..Default::default()
            },
        )
        .map_err(|error| error.to_string())?;
        let encoder_name = encoder.codec_name();
        if !encoder.is_d3d11_hw_input() {
            return Err(format!("{} encoder {encoder_name}", encoder.d3d11_status()));
        }
        let sw = format!("hw sw_format {}", encoder.d3d11_status());
        let mut ring = GpuTextureRing::new(device.device.clone())
            .ok_or_else(|| "no immediate context".to_string())?;
        for i in 0..WARMUP {
            queue_texture(
                &mut encoder,
                &mut ring,
                sources,
                info,
                &encoder_name,
                &sw,
                i,
            )?;
        }
        let wall_start = Instant::now();
        let cpu_start = process_cpu();
        for i in 0..FRAMES {
            queue_texture(
                &mut encoder,
                &mut ring,
                sources,
                info,
                &encoder_name,
                &sw,
                WARMUP + i,
            )?;
        }
        let wall = wall_start.elapsed();
        let cpu = process_cpu().saturating_sub(cpu_start);
        encoder
            .finish()
            .map_err(|error| texture_refusal(&ring, &encoder_name, &sw, &error.to_string()))?;
        let decoded = decode_count(&assemble(dir));
        Ok(Run {
            wall,
            cpu,
            decoded,
            encoder: encoder_name,
            sw,
            ring_capacity: Some(ring.capacity()),
            ring_high_water: Some(ring.high_water()),
        })
    }

    fn queue_texture(
        encoder: &mut SegmentedVideoEncoder,
        ring: &mut GpuTextureRing,
        sources: &[ID3D11Texture2D],
        info: VideoInfo,
        encoder_name: &str,
        sw: &str,
        index: usize,
    ) -> Result<(), String> {
        let submitted = if repeats_previous(index) {
            ring.resubmit_last()
        } else {
            ring.submit_from(&sources[index % SOURCES], info.width, info.height)
        };
        let (texture, lifetime) =
            submitted.ok_or_else(|| texture_refusal(ring, encoder_name, sw, ring.refusal()))?;
        unsafe {
            encoder
                .queue_d3d11_texture(texture, frame_timestamp(index), Some(lifetime))
                .map_err(|error| texture_refusal(ring, encoder_name, sw, &error.to_string()))?;
        }
        Ok(())
    }

    fn report(label: &str, path: &str, runs: &[Run]) {
        let mut wall: Vec<u128> = runs.iter().map(|run| run.wall.as_millis()).collect();
        let mut cpu: Vec<u128> = runs.iter().map(|run| run.cpu.as_millis()).collect();
        let wall_min = *wall.iter().min().unwrap_or(&0);
        let wall_max = *wall.iter().max().unwrap_or(&0);
        let cpu_min = *cpu.iter().min().unwrap_or(&0);
        let cpu_max = *cpu.iter().max().unwrap_or(&0);
        let encoder = runs
            .first()
            .map(|run| run.encoder.as_str())
            .unwrap_or("unknown");
        let sw = runs.first().map(|run| run.sw.as_str()).unwrap_or("unknown");
        let capacity = runs.iter().find_map(|run| run.ring_capacity);
        let high_water = runs.iter().filter_map(|run| run.ring_high_water).max();
        let ring_text = match (capacity, high_water) {
            (Some(capacity), Some(peak)) => format!(" ring {capacity} high-water {peak}"),
            _ => String::new(),
        };
        println!(
            "{label} {path} encoder {encoder} {sw}{ring_text} wall median {} ms range {wall_min}-{wall_max} cpu median {} ms range {cpu_min}-{cpu_max} decoded {:?}",
            median(&mut wall),
            median(&mut cpu),
            runs.iter().map(|run| run.decoded).collect::<Vec<_>>()
        );
    }

    pub fn run() {
        ffmpeg::init().ok();
        let device = open_device();
        let expected = WARMUP + FRAMES;
        let mut failed = false;
        println!("adapter: {}", adapter_description(&device.device));
        println!(
            "frames {FRAMES} warmup {WARMUP} runs {RUNS} fps {FPS} tick {FRAME_TICK_US}us repeat every other frame expected decoded {expected}"
        );
        for (width, height) in [(1920u32, 1080u32), (3840, 2160)] {
            let info = VideoInfo::from_raw(RawVideoFormat::Rgba, width, height, FPS);
            let sources: Vec<_> = (0..SOURCES)
                .map(|index| {
                    let texture = rgba_texture(&device.device, width, height, false);
                    paint(&device, &texture, width, height, index);
                    texture
                })
                .collect();
            let staging = rgba_texture(&device.device, width, height, true);
            let base = std::env::temp_dir().join(format!("d3d11-texture-bench-{width}x{height}"));
            let _ = std::fs::remove_dir_all(&base);
            let mut readback_runs = Vec::new();
            let mut texture_runs = Vec::new();
            let mut texture_refusal = None;
            for run_index in 0..RUNS {
                let readback_dir = base.join(format!("readback-{run_index}"));
                std::fs::create_dir_all(&readback_dir).expect("readback dir");
                let readback = run_readback(&readback_dir, &device, &sources, &staging, info);
                if readback.decoded != expected {
                    failed = true;
                }
                readback_runs.push(readback);

                let texture_dir = base.join(format!("texture-{run_index}"));
                std::fs::create_dir_all(&texture_dir).expect("texture dir");
                match run_texture(&texture_dir, &device, &sources, info) {
                    Ok(texture) => {
                        if texture.decoded != expected {
                            failed = true;
                        }
                        texture_runs.push(texture);
                    }
                    Err(reason) => {
                        if texture_refusal.is_none() {
                            texture_refusal = Some(reason);
                        }
                    }
                }
            }
            let label = format!("{width}x{height}");
            report(&label, "readback", &readback_runs);
            if !texture_runs.is_empty() {
                report(&label, "texture", &texture_runs);
            }
            if let Some(reason) = texture_refusal {
                println!("{label} texture refused: {reason}");
            }
        }
        if failed {
            eprintln!("decoded frame count did not match frames submitted");
            std::process::exit(1);
        }
    }
}
