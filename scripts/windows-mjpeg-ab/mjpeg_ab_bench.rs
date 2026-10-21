use super::*;
use cap_mediafoundation_utils::IMFMediaBufferExt;
use ffmpeg::format::Pixel;
use std::{io::Write, time::Instant};
use windows::Win32::Media::MediaFoundation::{IMFMediaBuffer, MFCreateMemoryBuffer};

include!("mjpeg_ab_attach.rs");

type CameraBuffer = Arc<Mutex<IMFMediaBuffer>>;

const POOL: usize = 30;
const WARMUP: usize = 30;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> isize;
    fn GetProcessTimes(
        process: isize,
        creation: *mut u64,
        exit: *mut u64,
        kernel: *mut u64,
        user: *mut u64,
    ) -> i32;
}

fn process_cpu_us() -> u64 {
    let (mut creation, mut exit, mut kernel, mut user) = (0u64, 0u64, 0u64, 0u64);
    unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        );
    }
    (kernel + user) / 10
}

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn source_frame(width: u32, height: u32, seed: usize) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(Pixel::YUVJ422P, width, height);
    let mut noise = 0x9e37_79b9u32.wrapping_mul(seed as u32 + 1);
    for plane in 0..frame.planes() {
        let stride = frame.stride(plane);
        let (w, h) = (
            frame.plane_width(plane) as usize,
            frame.plane_height(plane) as usize,
        );
        let data = frame.data_mut(plane);
        for y in 0..h {
            for x in 0..w {
                noise = noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let base = (x * 255 / w.max(1) + y * 128 / h.max(1) + seed * 7 + plane * 40) as u32;
                data[y * stride + x] = ((base + (noise >> 28)) & 0xff) as u8;
            }
        }
    }
    frame
}

fn encode_mjpeg(frame: &ffmpeg::frame::Video) -> Vec<u8> {
    let codec = ffmpeg::codec::encoder::find(ffmpeg::codec::Id::MJPEG).unwrap();
    let mut encoder = ffmpeg::codec::context::Context::new_with_codec(codec)
        .encoder()
        .video()
        .unwrap();
    encoder.set_width(frame.width());
    encoder.set_height(frame.height());
    encoder.set_format(Pixel::YUVJ422P);
    encoder.set_time_base((1, 30));
    encoder.set_flags(ffmpeg::codec::Flags::QSCALE);
    encoder.set_global_quality(3 * 118);
    let mut encoder = encoder.open().unwrap();
    let mut frame = frame.clone();
    unsafe { (*frame.as_mut_ptr()).quality = 3 * 118 };
    frame.set_pts(Some(0));
    encoder.send_frame(&frame).unwrap();
    encoder.send_eof().unwrap();
    let mut packet = ffmpeg::Packet::empty();
    encoder.receive_packet(&mut packet).unwrap();
    packet.data().unwrap().to_vec()
}

fn mf_buffer(bytes: &[u8]) -> CameraBuffer {
    let buffer = unsafe { MFCreateMemoryBuffer(bytes.len() as u32) }.unwrap();
    buffer.lock_for_write().unwrap().copy_from_slice(bytes);
    unsafe { buffer.SetCurrentLength(bytes.len() as u32) }.unwrap();
    #[allow(clippy::arc_with_non_send_sync)]
    Arc::new(Mutex::new(buffer))
}

fn digest(frame: &ffmpeg::frame::Video) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut mix = |value: u64| {
        hash ^= value;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    };
    let header = format!(
        "{:?} {}x{} {:?} {:?}",
        frame.format(),
        frame.width(),
        frame.height(),
        frame.color_range(),
        frame.color_space()
    );
    for byte in header.bytes() {
        mix(byte as u64);
    }
    for plane in 0..frame.planes() {
        let stride = frame.stride(plane);
        let row = frame.plane_width(plane) as usize
            * if frame.format() == Pixel::NV12 && plane == 1 {
                2
            } else {
                1
            };
        let data = frame.data(plane);
        for y in 0..frame.plane_height(plane) as usize {
            for chunk in data[y * stride..y * stride + row].chunks(8) {
                let mut word = [0u8; 8];
                word[..chunk.len()].copy_from_slice(chunk);
                mix(u64::from_le_bytes(word));
            }
        }
    }
    hash
}

fn percentile(values: &mut [f64], p: f64) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    values[((values.len() - 1) as f64 * p).round() as usize]
}

fn decoded_output_digests(path: &std::path::Path) -> Vec<u64> {
    let mut input = ffmpeg::format::input(&path).unwrap();
    let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
    let index = stream.index();
    let mut decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .unwrap()
        .decoder()
        .video()
        .unwrap();
    let mut digests = Vec::new();
    let mut frame = ffmpeg::frame::Video::empty();
    for (stream, packet) in input.packets() {
        if stream.index() != index {
            continue;
        }
        decoder.send_packet(&packet).unwrap();
        while decoder.receive_frame(&mut frame).is_ok() {
            digests.push(digest(&frame));
        }
    }
    decoder.send_eof().unwrap();
    while decoder.receive_frame(&mut frame).is_ok() {
        digests.push(digest(&frame));
    }
    digests
}

#[test]
#[ignore]
fn mjpeg_ab_bench() {
    ffmpeg::init().unwrap();
    let variant = env("CAP_AB_VARIANT", "unknown");
    let mode = env("CAP_AB_MODE", "cpu");
    let res = env("CAP_AB_RES", "1920x1080");
    let (width, height) = res
        .split_once('x')
        .map(|(w, h)| (w.parse::<u32>().unwrap(), h.parse::<u32>().unwrap()))
        .unwrap();
    let frames: usize = env("CAP_AB_FRAMES", "600").parse().unwrap();
    let preview_on = env("CAP_AB_PREVIEW", "1") == "1";
    let encode = mode == "verify" || env("CAP_AB_ENCODE", "0") == "1";
    let out_dir = std::path::PathBuf::from(env("CAP_AB_OUT", "."));
    std::fs::create_dir_all(&out_dir).unwrap();

    let pool: Vec<Vec<u8>> = (0..POOL)
        .map(|seed| encode_mjpeg(&source_frame(width, height, seed)))
        .collect();
    let mjpeg_kb = pool.iter().map(Vec::len).sum::<usize>() as f64 / POOL as f64 / 1024.0;

    let tag = format!(
        "{variant}-{res}-{}-{}",
        if preview_on { "preview" } else { "nopreview" },
        if encode { "enc" } else { "noenc" }
    );
    let mp4_path = out_dir.join(format!("{tag}.mp4"));
    let mut output = encode.then(|| ffmpeg::format::output(&mp4_path).unwrap());
    let mut encoder = output.as_mut().map(|output| {
        cap_enc_ffmpeg::h264::H264Encoder::builder(cap_media_info::VideoInfo::from_raw_ffmpeg(
            Pixel::YUVJ422P,
            width,
            height,
            30,
        ))
        .with_encoder_priority_override(&["libx264"])
        .build(output)
        .unwrap()
    });
    if let Some(output) = output.as_mut() {
        output.write_header().unwrap();
    }

    let mut state = CallbackState::default();
    let mut preview_decoder = MjpegDecoder::default();
    let mut encoder_decoder = MjpegDecoder::default();
    let mut input_digests = Vec::with_capacity(frames);
    let (mut callback_us, mut preview_us, mut convert_us) = (Vec::new(), Vec::new(), Vec::new());
    let mut preview_decodes = 0usize;
    let mut encoder_decodes = 0usize;
    let mut measured = 0usize;
    let mut cpu_start = 0u64;
    let mut wall_start = Instant::now();

    for index in 0..WARMUP + frames {
        if index == WARMUP {
            cpu_start = process_cpu_us();
            wall_start = Instant::now();
        }
        let bytes = &pool[index % POOL];

        let started = Instant::now();
        let (native, preview, preview_ready) =
            run_callback(bytes, width, height, preview_on, &mut state, &mut preview_decoder);
        let callback_done = started.elapsed();

        let native = native.expect("native frame");
        let convert_started = Instant::now();
        let converted = camera_frame_to_ffmpeg(&native, &mut encoder_decoder).unwrap();
        let convert_done = convert_started.elapsed();

        let shared = preview
            .as_ref()
            .is_some_and(|preview| preview.data(0).as_ptr() == converted.data(0).as_ptr());

        if index >= WARMUP {
            measured += 1;
            callback_us.push(callback_done.as_secs_f64() * 1e6);
            convert_us.push(convert_done.as_secs_f64() * 1e6);
            if let Some(ready) = preview_ready {
                preview_us.push(ready.saturating_duration_since(started).as_secs_f64() * 1e6);
                preview_decodes += 1;
            }
            if !shared {
                encoder_decodes += 1;
            }
            if mode == "verify" {
                input_digests.push(digest(&converted));
            }
        }

        if let (Some(encoder), Some(output)) = (encoder.as_mut(), output.as_mut()) {
            encoder
                .queue_frame(
                    converted,
                    Duration::from_micros(index as u64 * 1_000_000 / 30),
                    output,
                )
                .unwrap();
        }
        drop(native);
        drop(preview);
    }

    if let (Some(encoder), Some(output)) = (encoder.as_mut(), output.as_mut()) {
        encoder.flush(output).unwrap();
        output.write_trailer().unwrap();
    }
    let cpu = process_cpu_us() - cpu_start;
    let wall = wall_start.elapsed();
    drop(encoder);
    drop(output);

    let p = |values: &mut Vec<f64>, q: f64| {
        if values.is_empty() {
            0.0
        } else {
            percentile(values, q)
        }
    };
    println!(
        "RESULT variant={variant} mode={mode} res={res} preview={} encode={} frames={measured} mjpeg_kb={mjpeg_kb:.0} cpu_us_per_frame={:.1} wall_us_per_frame={:.1} decodes_per_frame={:.3} preview_decodes={preview_decodes} encoder_decodes={encoder_decodes} callback_p50_us={:.1} callback_p95_us={:.1} preview_ready_p50_us={:.1} preview_ready_p95_us={:.1} convert_p50_us={:.1} convert_p95_us={:.1}",
        preview_on as u8,
        encode as u8,
        cpu as f64 / measured as f64,
        wall.as_secs_f64() * 1e6 / measured as f64,
        (preview_decodes + encoder_decodes) as f64 / measured as f64,
        p(&mut callback_us.clone(), 0.5),
        p(&mut callback_us, 0.95),
        p(&mut preview_us.clone(), 0.5),
        p(&mut preview_us, 0.95),
        p(&mut convert_us.clone(), 0.5),
        p(&mut convert_us, 0.95),
    );

    if mode == "verify" {
        let mut file = std::fs::File::create(out_dir.join(format!("{tag}-input.txt"))).unwrap();
        for (index, value) in input_digests.iter().enumerate() {
            writeln!(file, "{index} {value:016x}").unwrap();
        }
        let decoded = decoded_output_digests(&mp4_path);
        let mut file = std::fs::File::create(out_dir.join(format!("{tag}-decoded.txt"))).unwrap();
        for (index, value) in decoded.iter().enumerate() {
            writeln!(file, "{index} {value:016x}").unwrap();
        }
        println!(
            "VERIFY variant={variant} res={res} preview={} input_frames={} decoded_frames={}",
            preview_on as u8,
            input_digests.len(),
            decoded.len()
        );
    }
}
