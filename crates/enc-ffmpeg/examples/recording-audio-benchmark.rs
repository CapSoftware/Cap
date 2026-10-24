#[cfg(target_os = "macos")]
mod benchmark {
    use std::{
        path::{Path, PathBuf},
        time::{Duration, Instant},
    };

    use cap_enc_ffmpeg::fragmented_audio::FragmentedAudioFile;
    use cap_media_info::AudioInfo;
    use ffmpeg::{
        ChannelLayout,
        codec::context,
        format::{self, Sample, sample::Type},
        frame, media, software,
    };

    const RATE: u32 = 48_000;
    const FRAME_SAMPLES: usize = 960;

    fn cpu_secs() -> f64 {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
        let usage = unsafe { usage.assume_init() };
        let secs = |time: libc::timeval| time.tv_sec as f64 + time.tv_usec as f64 / 1_000_000.0;
        secs(usage.ru_utime) + secs(usage.ru_stime)
    }

    fn decode_to_mono(path: &Path) -> Vec<f32> {
        let mut input = format::input(path).unwrap();
        let stream = input.streams().best(media::Type::Audio).unwrap();
        let stream_index = stream.index();
        let mut decoder = context::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .audio()
            .unwrap();
        let input_layout = if decoder.channel_layout().is_empty() {
            AudioInfo::new_raw(decoder.format(), decoder.rate(), decoder.channels())
                .channel_layout()
        } else {
            decoder.channel_layout()
        };
        let mut resampler = software::resampler(
            (decoder.format(), input_layout, decoder.rate()),
            (Sample::F32(Type::Packed), ChannelLayout::MONO, RATE),
        )
        .unwrap();

        let mut samples = Vec::new();
        let mut decoded = frame::Audio::empty();
        let mut resampled = frame::Audio::empty();
        for (stream, packet) in input.packets() {
            if stream.index() != stream_index {
                continue;
            }
            decoder.send_packet(&packet).unwrap();
            while decoder.receive_frame(&mut decoded).is_ok() {
                decoded.set_channel_layout(input_layout);
                resampler.run(&decoded, &mut resampled).unwrap();
                samples.extend_from_slice(resampled.plane::<f32>(0));
            }
        }
        decoder.send_eof().unwrap();
        while decoder.receive_frame(&mut decoded).is_ok() {
            decoded.set_channel_layout(input_layout);
            resampler.run(&decoded, &mut resampled).unwrap();
            samples.extend_from_slice(resampled.plane::<f32>(0));
        }
        while resampler.delay().is_some() {
            resampler.flush(&mut resampled).unwrap();
            if resampled.samples() == 0 {
                break;
            }
            samples.extend_from_slice(resampled.plane::<f32>(0));
        }
        samples
    }

    fn synthetic(seconds: usize) -> Vec<f32> {
        let mut state = 0x9e37_79b9_u32;
        let mut low = 0.0_f32;
        (0..seconds * RATE as usize)
            .map(|index| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let white = state as f32 / u32::MAX as f32 - 0.5;
                low = 0.98f32.mul_add(low, 0.02 * white);
                let time = index as f32 / RATE as f32;
                0.15 * (std::f32::consts::TAU * 220.0 * time).sin() + 0.4 * low
            })
            .collect()
    }

    fn encode_run(
        path: &Path,
        channels: u16,
        mono: &[f32],
        prefer_audiotoolbox: bool,
    ) -> (f64, f64, u64) {
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), RATE, channels);
        let cpu_started = cpu_secs();
        let wall_started = Instant::now();
        let mut file = FragmentedAudioFile::init_with_encoder_preference(
            path.into(),
            info,
            prefer_audiotoolbox,
        )
        .unwrap();
        let expected = if prefer_audiotoolbox { "aac_at" } else { "aac" };
        assert_eq!(
            file.encoder().codec_name().as_deref(),
            Some(expected),
            "requested {expected} but the encoder opened {:?} (aac_at init fell back)",
            file.encoder().codec_name()
        );
        for (index, chunk) in mono.chunks(FRAME_SAMPLES).enumerate() {
            let mut frame = frame::Audio::new(
                Sample::F32(Type::Packed),
                chunk.len(),
                info.channel_layout(),
            );
            frame.set_rate(RATE);
            for (i, bytes) in frame.data_mut(0)[..chunk.len() * usize::from(channels) * 4]
                .chunks_exact_mut(4)
                .enumerate()
            {
                bytes.copy_from_slice(&chunk[i / usize::from(channels)].to_le_bytes());
            }
            file.queue_frame(
                frame,
                Duration::from_secs_f64((index * FRAME_SAMPLES) as f64 / f64::from(RATE)),
            )
            .unwrap();
        }
        file.finish().unwrap().unwrap();
        let wall = wall_started.elapsed().as_secs_f64();
        let cpu = cpu_secs() - cpu_started;
        let bytes = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        (cpu, wall, bytes)
    }

    fn median(values: &[f64]) -> f64 {
        let mut sorted = values.to_vec();
        sorted.sort_by(f64::total_cmp);
        sorted[sorted.len() / 2]
    }

    pub fn run() {
        let mut arguments = std::env::args().skip(1);
        let input = arguments.next().map(PathBuf::from);
        let rounds = arguments
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(5)
            .max(1);

        let mono = input
            .as_deref()
            .map(decode_to_mono)
            .unwrap_or_else(|| synthetic(60));
        let audio_secs = mono.len() as f64 / f64::from(RATE);
        println!(
            "input: {} ({audio_secs:.1}s of 48 kHz mono), {rounds} rounds",
            input
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "synthetic".to_string())
        );

        let dir = std::env::temp_dir().join("cap-recording-audio-benchmark");
        std::fs::create_dir_all(&dir).unwrap();

        let configs = [
            ("aac", 1u16, false),
            ("aac_at", 1, true),
            ("aac", 2, false),
            ("aac_at", 2, true),
        ];
        let mut runs = vec![(Vec::<f64>::new(), Vec::<f64>::new(), 0u64); configs.len()];
        for round in 0..rounds {
            for (index, &(name, channels, prefer)) in configs.iter().enumerate() {
                let path = dir.join(format!("{name}-{channels}ch-{round}.m4a"));
                let _ = std::fs::remove_file(&path);
                let (cpu, wall, bytes) = encode_run(&path, channels, &mono, prefer);
                runs[index].0.push(cpu);
                runs[index].1.push(wall);
                runs[index].2 = bytes;
            }
        }

        println!("encoder  ch  cpu_ms/s  wall_s  kbps");
        for (index, &(name, channels, _)) in configs.iter().enumerate() {
            let (cpus, walls, bytes) = &runs[index];
            let cpu_ms = median(cpus) * 1_000.0 / audio_secs;
            let kbps = *bytes as f64 * 8.0 / audio_secs / 1_000.0;
            println!(
                "{name:<8} {channels}   {cpu_ms:>8.1}  {:>6.2}  {kbps:>6.1}",
                median(walls)
            );
        }
        for channels in [1usize, 2] {
            let aac = median(&runs[channels * 2 - 2].0);
            let at = median(&runs[channels * 2 - 1].0);
            println!("cpu ratio aac_at/aac ({channels}ch): {:.2}", at / aac);
        }
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    benchmark::run();
    #[cfg(not(target_os = "macos"))]
    eprintln!(
        "recording-audio-benchmark compares FFmpeg aac with AudioToolbox aac_at and only runs on macOS"
    );
}
