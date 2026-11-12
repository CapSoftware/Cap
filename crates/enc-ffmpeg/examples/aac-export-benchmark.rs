use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use cap_enc_ffmpeg::{PacketQueue, aac::AACEncoder};
use cap_media_info::AudioInfo;
use ffmpeg::{
    ChannelLayout,
    codec::context,
    format::{self, Sample, sample::Type},
    frame, media, software,
};

const RATE: u32 = 48_000;
const EXPORT_FPS: usize = 30;
const CHUNK_SAMPLES: usize = RATE as usize / EXPORT_FPS;

fn decode_to_stereo(path: &Path) -> Vec<f32> {
    let mut input = format::input(path).unwrap();
    let stream = input.streams().best(media::Type::Audio).unwrap();
    let stream_index = stream.index();
    let mut decoder = context::Context::from_parameters(stream.parameters())
        .unwrap()
        .decoder()
        .audio()
        .unwrap();
    let input_layout = if decoder.channel_layout().is_empty() {
        AudioInfo::new_raw(decoder.format(), decoder.rate(), decoder.channels()).channel_layout()
    } else {
        decoder.channel_layout()
    };
    let mut resampler = software::resampler(
        (decoder.format(), input_layout, decoder.rate()),
        (Sample::F32(Type::Packed), ChannelLayout::STEREO, RATE),
    )
    .unwrap();

    let mut samples = Vec::new();
    let mut append_samples = |resampled: &frame::Audio| {
        if resampled.samples() == 0 {
            return;
        }
        let bytes = resampled.samples() * 2 * std::mem::size_of::<f32>();
        samples.extend(
            resampled.data(0)[..bytes]
                .chunks_exact(std::mem::size_of::<f32>())
                .map(|b| f32::from_ne_bytes([b[0], b[1], b[2], b[3]])),
        );
    };
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
            append_samples(&resampled);
        }
    }
    decoder.send_eof().unwrap();
    while decoder.receive_frame(&mut decoded).is_ok() {
        decoded.set_channel_layout(input_layout);
        resampler.run(&decoded, &mut resampled).unwrap();
        append_samples(&resampled);
    }
    while resampler.delay().is_some() {
        let mut tail = frame::Audio::new(Sample::F32(Type::Packed), 0, ChannelLayout::STEREO);
        resampler.flush(&mut tail).unwrap();
        if tail.samples() == 0 {
            break;
        }
        append_samples(&tail);
    }
    samples
}

fn stereo_frame(data: &[f32]) -> frame::Audio {
    let mut frame = frame::Audio::new(
        Sample::F32(Type::Packed),
        data.len() / 2,
        ChannelLayout::STEREO,
    );
    frame.set_rate(RATE);
    for (sample, bytes) in data.iter().zip(
        frame
            .data_mut(0)
            .chunks_exact_mut(std::mem::size_of::<f32>()),
    ) {
        bytes.copy_from_slice(&sample.to_ne_bytes());
    }
    frame
}

fn encode_once(pcm: &[f32], out: &Path) -> (Duration, usize, usize, String) {
    let mut output = format::output(out).unwrap();
    let info = AudioInfo::new(Sample::F32(Type::Packed), RATE, 2).unwrap();
    let mut encoder = AACEncoder::init_for_export(info, &mut output).unwrap();
    let codec = encoder.codec_name().unwrap_or_default();
    output.write_header().unwrap();
    let time_base = output.stream(encoder.stream_index()).unwrap().time_base();
    let mut queue = PacketQueue::new(time_base);

    let start = Instant::now();
    let mut pts = 0i64;
    for chunk in pcm.chunks(CHUNK_SAMPLES * 2) {
        let mut frame = stereo_frame(chunk);
        frame.set_pts(Some(pts));
        pts += (chunk.len() / 2) as i64;
        encoder
            .send_frame_to(frame, Duration::MAX, &mut queue)
            .unwrap();
    }
    encoder.flush_to(&mut queue).unwrap();
    let elapsed = start.elapsed();
    let packets = queue.take();
    let bytes = packets.iter().map(|packet| packet.size()).sum();
    let count = packets.len();
    for packet in packets {
        packet.write_interleaved(&mut output).unwrap();
    }
    output.write_trailer().unwrap();
    (elapsed, count, bytes, codec)
}

fn snr_db(reference: &[f32], decoded: &[f32]) -> f64 {
    let (signal, noise) =
        reference
            .iter()
            .zip(decoded)
            .fold((0f64, 0f64), |(signal, noise), (&r, &d)| {
                let (r, d) = (f64::from(r), f64::from(d));
                (signal + r * r, noise + (r - d) * (r - d))
            });
    10.0 * (signal / noise.max(f64::MIN_POSITIVE)).log10()
}

fn main() {
    ffmpeg::init().unwrap();
    let mut args = std::env::args().skip(1);
    let source = PathBuf::from(
        args.next()
            .expect("usage: aac-export-benchmark <audio file> [rounds]"),
    );
    let rounds: usize = args.next().map(|r| r.parse().unwrap()).unwrap_or(5);

    let pcm = decode_to_stereo(&source);
    let audio_secs = pcm.len() as f64 / 2.0 / f64::from(RATE);
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("audio.mp4");

    let mut times = Vec::with_capacity(rounds);
    for round in 0..rounds {
        let (elapsed, packets, bytes, codec) = encode_once(&pcm, &out);
        println!(
            "round {round}: codec={codec} audio={audio_secs:.2}s encode={:.1}ms ({:.1}x realtime) packets={packets} bytes={bytes}",
            elapsed.as_secs_f64() * 1000.0,
            audio_secs / elapsed.as_secs_f64()
        );
        times.push(elapsed.as_secs_f64() * 1000.0);
    }
    let decoded = decode_to_stereo(&out);
    println!(
        "round-trip SNR {:.2} dB, decoded {} of {} samples",
        snr_db(&pcm, &decoded),
        decoded.len() / 2,
        pcm.len() / 2
    );
    times.sort_by(f64::total_cmp);
    println!(
        "aac-export: median {:.1}ms min {:.1}ms max {:.1}ms over {rounds} rounds for {audio_secs:.2}s of audio",
        times[times.len() / 2],
        times[0],
        times[times.len() - 1]
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_preserves_full_resampled_audio() {
        ffmpeg::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.wav");

        for (input_rate, input_samples) in [
            (44_100u32, 44_100u32),
            (48_000, 48_000),
            (96_000, 96_000),
            (44_100, 441),
        ] {
            let data_bytes = input_samples * 2;
            let mut wav = Vec::new();
            wav.extend_from_slice(b"RIFF");
            wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
            wav.extend_from_slice(b"WAVEfmt ");
            wav.extend_from_slice(&16u32.to_le_bytes());
            wav.extend_from_slice(&1u16.to_le_bytes());
            wav.extend_from_slice(&1u16.to_le_bytes());
            wav.extend_from_slice(&input_rate.to_le_bytes());
            wav.extend_from_slice(&(input_rate * 2).to_le_bytes());
            wav.extend_from_slice(&2u16.to_le_bytes());
            wav.extend_from_slice(&16u16.to_le_bytes());
            wav.extend_from_slice(b"data");
            wav.extend_from_slice(&data_bytes.to_le_bytes());
            for _ in 0..input_samples {
                wav.extend_from_slice(&8192i16.to_le_bytes());
            }
            std::fs::write(&path, wav).unwrap();

            let samples = decode_to_stereo(&path);
            let expected_samples =
                u64::from(input_samples) * u64::from(RATE) / u64::from(input_rate);
            assert_eq!(
                samples.len(),
                expected_samples as usize * 2,
                "{input_samples} samples at {input_rate} Hz"
            );
            assert!(
                samples[samples.len() - 2..]
                    .iter()
                    .all(|sample| *sample > 0.1)
            );
        }
    }
}
