#[cfg(not(windows))]
fn main() {
    eprintln!("Windows only");
}

#[cfg(windows)]
fn main() -> anyhow::Result<()> {
    windows_bench::run()
}

#[cfg(windows)]
mod windows_bench {
    use anyhow::{Context, anyhow};
    use cap_enc_ffmpeg::h264::H264Encoder;
    use cap_media_info::VideoInfo;
    use cap_mediafoundation_ffmpeg::{H264StreamMuxer, MuxerConfig};
    use std::{
        path::Path,
        sync::{Arc, atomic::AtomicBool},
        time::{Duration, Instant},
    };
    use windows::{
        Foundation::TimeSpan,
        Graphics::SizeInt32,
        Win32::{
            Foundation::FILETIME,
            Graphics::{Direct3D11::*, Dxgi::Common::*},
            System::Threading::{GetCurrentProcess, GetProcessTimes},
        },
    };

    fn cpu_seconds() -> anyhow::Result<f64> {
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
            |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
        Ok((ticks(kernel) + ticks(user)) as f64 / 10_000_000.0)
    }

    fn textures(
        device: &ID3D11Device,
        width: u32,
        height: u32,
    ) -> anyhow::Result<Vec<ID3D11Texture2D>> {
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
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            ..Default::default()
        };
        (0..8)
            .map(|index| {
                let mut pixels = vec![0u8; width as usize * height as usize * 4];
                for (offset, pixel) in pixels.chunks_exact_mut(4).enumerate() {
                    let x = offset % width as usize;
                    let y = offset / width as usize;
                    pixel.copy_from_slice(&[
                        ((x / 8 + index * 13) % 256) as u8,
                        ((y / 8 + index * 7) % 256) as u8,
                        ((x / 16 + y / 16 + index * 5) % 256) as u8,
                        255,
                    ]);
                }
                let initial = D3D11_SUBRESOURCE_DATA {
                    pSysMem: pixels.as_ptr().cast(),
                    SysMemPitch: width * 4,
                    ..Default::default()
                };
                let mut texture = None;
                unsafe {
                    device.CreateTexture2D(&desc, Some(&initial), Some(&mut texture))?;
                }
                texture.context("texture missing")
            })
            .collect()
    }

    fn check_pixels(frame: &ffmpeg::frame::Video, index: usize) -> anyhow::Result<()> {
        let index = index % 8;
        let red = ((1000 / 8 + index * 13) % 256) as f64;
        let green = ((500 / 8 + index * 7) % 256) as f64;
        let blue = ((1000 / 16 + 500 / 16 + index * 5) % 256) as f64;
        let expected = 16.0 + (0.2126 * red + 0.7152 * green + 0.0722 * blue) * 219.0 / 255.0;
        let actual = frame.data(0)[500 * frame.stride(0) + 1000] as f64;
        if (expected - actual).abs() > 4.0 {
            return Err(anyhow!(
                "frame {index}: expected BT.709 luma {expected:.2}, got {actual}"
            ));
        }
        Ok(())
    }

    fn decode(path: &Path) -> anyhow::Result<usize> {
        let mut input = ffmpeg::format::input(path)?;
        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .context("video stream")?;
        let index = stream.index();
        let mut decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())?
            .decoder()
            .video()?;
        let mut decoded = ffmpeg::frame::Video::empty();
        let mut count = 0;
        for (stream, packet) in input.packets() {
            if stream.index() != index {
                continue;
            }
            decoder.send_packet(&packet)?;
            while decoder.receive_frame(&mut decoded).is_ok() {
                check_pixels(&decoded, count)?;
                count += 1;
            }
        }
        decoder.send_eof()?;
        while decoder.receive_frame(&mut decoded).is_ok() {
            check_pixels(&decoded, count)?;
            count += 1;
        }
        Ok(count)
    }

    fn trial(
        device: &ID3D11Device,
        textures: &[ID3D11Texture2D],
        size: SizeInt32,
        mode: &str,
        frames: usize,
        path: &Path,
    ) -> anyhow::Result<()> {
        let width = size.Width as u32;
        let height = size.Height as u32;
        let mut output = ffmpeg::format::output(path)?;
        let mut latencies = Vec::with_capacity(frames);
        let cpu_start;
        let started;
        let elapsed;
        let cpu;
        let outputs;
        if mode == "texture" {
            let mut encoder = cap_enc_mediafoundation::H264Encoder::new(
                device,
                DXGI_FORMAT_R8G8B8A8_UNORM,
                size,
                30,
                0.15,
            )?;
            encoder.validate()?;
            let mut muxer = H264StreamMuxer::new(
                &mut output,
                MuxerConfig {
                    width,
                    height,
                    fps: 30,
                    bitrate: encoder.bitrate(),
                    ..Default::default()
                },
            )?;
            output.write_header()?;
            let mut inputs = 0;
            let mut previous = Instant::now();
            cpu_start = cpu_seconds()?;
            started = Instant::now();
            let health = encoder.run(
                Arc::new(AtomicBool::new(false)),
                || {
                    if inputs > 0 {
                        latencies.push(previous.elapsed().as_secs_f64() * 1000.0);
                    }
                    if inputs == frames {
                        return Ok(None);
                    }
                    previous = Instant::now();
                    let texture = textures[inputs % textures.len()].clone();
                    let timestamp = TimeSpan {
                        Duration: inputs as i64 * 10_000_000 / 30,
                    };
                    inputs += 1;
                    Ok(Some((texture, timestamp)))
                },
                |sample| {
                    muxer.write_sample(&sample, &mut output).map_err(|error| {
                        windows::core::Error::new(
                            windows::core::HRESULT(0x80004005u32 as i32),
                            error.to_string(),
                        )
                    })
                },
            )?;
            elapsed = started.elapsed();
            cpu = cpu_seconds()? - cpu_start;
            outputs = health.total_frames_encoded as usize;
            println!(
                "MF inputs={inputs} samples={outputs} healthy={}",
                health.is_healthy
            );
        } else {
            let info = VideoInfo::from_raw_ffmpeg(ffmpeg::format::Pixel::RGBA, width, height, 30);
            let mut encoder = H264Encoder::builder(info).build(&mut output)?;
            let conversion = encoder.conversion_requirements();
            println!(
                "FFmpeg hardware={} conversion={:?}->{:?}",
                encoder.is_hardware(),
                conversion.input_format,
                conversion.output_format
            );
            output.write_header()?;
            let context = unsafe { device.GetImmediateContext()? };
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe {
                textures[0].GetDesc(&mut desc);
            }
            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            let mut staging = None;
            unsafe {
                device.CreateTexture2D(&desc, None, Some(&mut staging))?;
            }
            let staging = staging.context("staging texture")?;
            let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBA, width, height);
            cpu_start = cpu_seconds()?;
            started = Instant::now();
            for index in 0..frames {
                let frame_started = Instant::now();
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                unsafe {
                    context.CopyResource(&staging, &textures[index % textures.len()]);
                    context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
                    let stride = frame.stride(0);
                    for (row, destination) in frame
                        .data_mut(0)
                        .chunks_mut(stride)
                        .take(height as usize)
                        .enumerate()
                    {
                        std::ptr::copy_nonoverlapping(
                            mapped
                                .pData
                                .cast::<u8>()
                                .add(row * mapped.RowPitch as usize),
                            destination.as_mut_ptr(),
                            width as usize * 4,
                        );
                    }
                    context.Unmap(&staging, 0);
                }
                let mut reference = ffmpeg::frame::Video::empty();
                let status =
                    unsafe { ffmpeg::ffi::av_frame_ref(reference.as_mut_ptr(), frame.as_ptr()) };
                if status < 0 {
                    return Err(anyhow!("av_frame_ref: {status}"));
                }
                encoder.queue_frame(
                    reference,
                    Duration::from_micros(index as u64 * 1_000_000 / 30),
                    &mut output,
                )?;
                latencies.push(frame_started.elapsed().as_secs_f64() * 1000.0);
            }
            encoder.flush(&mut output)?;
            elapsed = started.elapsed();
            cpu = cpu_seconds()? - cpu_start;
            outputs = frames;
        }
        output.write_trailer()?;
        drop(output);
        let decoded = decode(path)?;
        latencies.sort_by(f64::total_cmp);
        let mean = latencies.iter().sum::<f64>() / latencies.len() as f64;
        println!(
            "RESULT mode={mode} size={width}x{height} inputs={frames} outputs={outputs} decoded={decoded} wall_ms={:.3} ms_per_input={:.4} mean_interval_ms={mean:.4} median_interval_ms={:.4} cpu_ms_per_input={:.4}",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_secs_f64() * 1000.0 / frames as f64,
            latencies[latencies.len() / 2],
            cpu * 1000.0 / frames as f64
        );
        if decoded != outputs || decoded != frames || decoded == 0 {
            return Err(anyhow!("decoded count mismatch"));
        }
        Ok(())
    }

    pub fn run() -> anyhow::Result<()> {
        cap_mediafoundation_utils::thread_init();
        ffmpeg::init()?;
        tracing_subscriber::fmt()
            .with_env_filter("info")
            .with_ansi(false)
            .init();
        let args: Vec<String> = std::env::args().collect();
        let width: i32 = args.get(1).context("width")?.parse()?;
        let height: i32 = args.get(2).context("height")?.parse()?;
        let frames: usize = args.get(3).context("frames")?.parse()?;
        let repeats: usize = args.get(4).context("repeats")?.parse()?;
        let directory = Path::new(args.get(5).context("output directory")?);
        std::fs::create_dir_all(directory)?;
        let device = cap_enc_mediafoundation::d3d::create_d3d_device()?;
        let textures = textures(&device, width as u32, height as u32)?;
        let size = SizeInt32 {
            Width: width,
            Height: height,
        };
        for repeat in 0..repeats {
            let modes = if repeat % 2 == 0 {
                ["fallback", "texture"]
            } else {
                ["texture", "fallback"]
            };
            for mode in modes {
                println!("TRIAL repeat={repeat} mode={mode}");
                trial(
                    &device,
                    &textures,
                    size,
                    mode,
                    frames,
                    &directory.join(format!("{width}x{height}-{repeat}-{mode}.mp4")),
                )?;
            }
        }
        Ok(())
    }
}
