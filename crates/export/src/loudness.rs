use ffmpeg::{
    ChannelLayout, Dictionary, Packet, Rational,
    codec::{self, context},
    encoder, filter,
    format::{self, Sample, sample::Type},
    frame, media,
};
use std::path::{Path, PathBuf};

pub const SOCIAL_TARGET_LUFS: f32 = -14.0;
const TRUE_PEAK_LIMIT: f32 = 0.891_251; // -1 dBTP
const MAX_GAIN_DB: f32 = 20.0;
const MIN_ADJUSTMENT_DB: f32 = 0.5;
const MAX_PASSES: usize = 3;
const LIMITER_HEADROOM_DB: f32 = 6.0;
const OUTPUT_BITRATE: usize = 320_000;

#[derive(Debug, thiserror::Error)]
pub enum LoudnessError {
    #[error("{0}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("AAC encoder not available")]
    EncoderNotFound,
}

fn layout_for(decoder: &ffmpeg::decoder::Audio) -> ChannelLayout {
    let layout = decoder.channel_layout();
    if layout.bits() == 0 {
        ChannelLayout::default(i32::from(decoder.channels().max(1)))
    } else {
        layout
    }
}

fn filter_graph(
    decoder: &ffmpeg::decoder::Audio,
    time_base: Rational,
    processing: &str,
) -> Result<filter::Graph, ffmpeg::Error> {
    let mut graph = filter::Graph::new();
    graph.add(
        &filter::find("abuffer").ok_or(ffmpeg::Error::FilterNotFound)?,
        "in",
        &format!(
            "time_base={}/{}:sample_rate={}:sample_fmt={}:channel_layout=0x{:x}",
            time_base.numerator(),
            time_base.denominator(),
            decoder.rate(),
            decoder.format().name(),
            layout_for(decoder).bits(),
        ),
    )?;
    graph.add(
        &filter::find("abuffersink").ok_or(ffmpeg::Error::FilterNotFound)?,
        "out",
        "",
    )?;
    graph.output("in", 0)?.input("out", 0)?.parse(processing)?;
    graph.validate()?;
    Ok(graph)
}

fn drain_graph(
    graph: &mut filter::Graph,
    mut visit: impl FnMut(&frame::Audio) -> Result<(), LoudnessError>,
) -> Result<(), LoudnessError> {
    let mut output = frame::Audio::empty();
    loop {
        match graph.get("out").unwrap().sink().frame(&mut output) {
            Ok(()) => {
                visit(&output)?;
                unsafe { ffmpeg::ffi::av_frame_unref(output.as_mut_ptr()) };
            }
            Err(ffmpeg::Error::Eof) => return Ok(()),
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => return Ok(()),
            Err(error) => return Err(error.into()),
        }
    }
}

fn audio_decoder(
    input: &format::context::Input,
) -> Result<Option<(usize, Rational, ffmpeg::decoder::Audio)>, ffmpeg::Error> {
    let Some(stream) = input.streams().best(media::Type::Audio) else {
        return Ok(None);
    };
    let decoder = context::Context::from_parameters(stream.parameters())?
        .decoder()
        .audio()?;
    Ok(Some((stream.index(), stream.time_base(), decoder)))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Loudness {
    pub integrated_lufs: f32,
    pub true_peak: f32,
}

pub fn measure_loudness(path: &Path) -> Result<Option<Loudness>, LoudnessError> {
    let mut input = format::input(&path)?;
    let Some((index, time_base, mut decoder)) = audio_decoder(&input)? else {
        return Ok(None);
    };
    let mut graph = filter_graph(&decoder, time_base, "ebur128=metadata=1:peak=true")?;
    let mut level = None;
    let mut true_peak = 0.0f32;
    let mut decoded = frame::Audio::empty();
    let mut read_level = |frame: &frame::Audio| {
        let metadata = frame.metadata();
        if let Some(value) = metadata.get("lavfi.r128.I") {
            level = value.parse::<f32>().ok().filter(|v| v.is_finite());
        }
        if let Some(peak) = metadata
            .get("lavfi.r128.true_peak")
            .and_then(|value| value.parse::<f32>().ok())
            .filter(|v| v.is_finite())
        {
            true_peak = true_peak.max(peak);
        }
        Ok(())
    };
    for (stream, packet) in input.packets() {
        if stream.index() != index {
            continue;
        }
        decoder.send_packet(&packet)?;
        while decoder.receive_frame(&mut decoded).is_ok() {
            graph.get("in").unwrap().source().add(&decoded)?;
            drain_graph(&mut graph, &mut read_level)?;
        }
    }
    decoder.send_eof()?;
    while decoder.receive_frame(&mut decoded).is_ok() {
        graph.get("in").unwrap().source().add(&decoded)?;
    }
    graph.get("in").unwrap().source().flush()?;
    drain_graph(&mut graph, &mut read_level)?;
    Ok(level
        .filter(|level| *level > -70.0)
        .map(|integrated_lufs| Loudness {
            integrated_lufs,
            true_peak,
        }))
}

pub fn normalization_gain_db(measured: Loudness, target_lufs: f32) -> Option<f32> {
    let gain = (target_lufs - measured.integrated_lufs).clamp(-MAX_GAIN_DB, MAX_GAIN_DB);
    (gain.abs() >= MIN_ADJUSTMENT_DB || measured.true_peak > TRUE_PEAK_LIMIT).then_some(gain)
}

fn rewrite_audio(path: &Path, temp_path: &Path, gain_db: f32) -> Result<(), LoudnessError> {
    let mut input = format::input(&path)?;
    let Some((audio_index, audio_time_base, mut decoder)) = audio_decoder(&input)? else {
        return Ok(());
    };
    let mut output = format::output(temp_path)?;

    let codec = encoder::find_by_name("aac").ok_or(LoudnessError::EncoderNotFound)?;
    let layout = ChannelLayout::default(i32::from(decoder.channels().clamp(1, 2)));
    let rate = decoder.rate() as i32;
    let mut audio_encoder = context::Context::new_with_codec(codec).encoder().audio()?;
    audio_encoder.set_bit_rate(OUTPUT_BITRATE);
    audio_encoder.set_rate(rate);
    audio_encoder.set_format(Sample::F32(Type::Planar));
    audio_encoder.set_channel_layout(layout);
    audio_encoder.set_time_base(Rational(1, rate));
    if output
        .format()
        .flags()
        .contains(format::Flags::GLOBAL_HEADER)
    {
        audio_encoder.set_flags(codec::Flags::GLOBAL_HEADER);
    }
    let mut audio_encoder = audio_encoder.open_as(codec)?;

    let mut stream_map = vec![None; input.nb_streams() as usize];
    let mut out_audio_index = 0;
    for stream in input.streams() {
        let medium = stream.parameters().medium();
        if stream.index() == audio_index {
            let mut out = output.add_stream(codec)?;
            out.set_time_base(Rational(1, rate));
            out.set_parameters(&audio_encoder);
            out_audio_index = out.index();
            stream_map[stream.index()] = Some(out.index());
        } else if matches!(medium, media::Type::Video | media::Type::Subtitle) {
            let mut out = output.add_stream(encoder::find(codec::Id::None))?;
            out.set_parameters(stream.parameters());
            unsafe { (*out.parameters().as_mut_ptr()).codec_tag = 0 };
            stream_map[stream.index()] = Some(out.index());
        }
    }
    let mut options = Dictionary::new();
    options.set("movflags", "+faststart");
    output.write_header_with(options)?;

    let processing = format!(
        "volume={gain_db}dB,aresample=192000,alimiter=limit={TRUE_PEAK_LIMIT}:attack=5:release=80:level=false:latency=true,aresample={rate},aformat=sample_fmts=fltp:channel_layouts=0x{:x}",
        layout.bits()
    );
    let mut graph = filter_graph(&decoder, audio_time_base, &processing)?;
    graph
        .get("out")
        .unwrap()
        .sink()
        .set_frame_size(audio_encoder.frame_size());

    let out_audio_time_base = output.stream(out_audio_index).unwrap().time_base();
    let mut next_pts = 0i64;
    let mut encode = |frame: &frame::Audio,
                      encoder_: &mut ffmpeg::encoder::Audio,
                      output: &mut format::context::Output|
     -> Result<(), LoudnessError> {
        let mut frame = frame.clone();
        frame.set_pts(Some(next_pts));
        next_pts += frame.samples() as i64;
        encoder_.send_frame(&frame)?;
        write_encoded(encoder_, output, rate, out_audio_index, out_audio_time_base)
    };

    let mut decoded = frame::Audio::empty();
    let stream_time_bases: Vec<(Rational, Option<Rational>)> = input
        .streams()
        .map(|stream| {
            (
                stream.time_base(),
                stream_map[stream.index()].map(|out| output.stream(out).unwrap().time_base()),
            )
        })
        .collect();
    for (stream, mut packet) in input.packets() {
        let index = stream.index();
        if index == audio_index {
            decoder.send_packet(&packet)?;
            while decoder.receive_frame(&mut decoded).is_ok() {
                graph.get("in").unwrap().source().add(&decoded)?;
                drain_graph(&mut graph, |frame| {
                    encode(frame, &mut audio_encoder, &mut output)
                })?;
            }
        } else if let (Some(out_index), (in_tb, Some(out_tb))) =
            (stream_map[index], stream_time_bases[index])
        {
            packet.rescale_ts(in_tb, out_tb);
            packet.set_position(-1);
            packet.set_stream(out_index);
            packet.write_interleaved(&mut output)?;
        }
    }
    decoder.send_eof()?;
    while decoder.receive_frame(&mut decoded).is_ok() {
        graph.get("in").unwrap().source().add(&decoded)?;
    }
    graph.get("in").unwrap().source().flush()?;
    drain_graph(&mut graph, |frame| {
        encode(frame, &mut audio_encoder, &mut output)
    })?;
    audio_encoder.send_eof()?;
    write_encoded(
        &mut audio_encoder,
        &mut output,
        rate,
        out_audio_index,
        out_audio_time_base,
    )?;
    output.write_trailer()?;
    drop(output);
    Ok(())
}

fn write_encoded(
    encoder_: &mut ffmpeg::encoder::Audio,
    output: &mut format::context::Output,
    rate: i32,
    stream_index: usize,
    stream_time_base: Rational,
) -> Result<(), LoudnessError> {
    let mut packet = Packet::empty();
    while encoder_.receive_packet(&mut packet).is_ok() {
        packet.rescale_ts(Rational(1, rate), stream_time_base);
        packet.set_stream(stream_index);
        packet.write_interleaved(output)?;
    }
    Ok(())
}

pub fn normalize_file_loudness(
    path: &Path,
    target_lufs: f32,
) -> Result<Option<f32>, LoudnessError> {
    let Some(measured) = measure_loudness(path)? else {
        return Ok(None);
    };
    let Some(mut gain) = normalization_gain_db(measured, target_lufs) else {
        return Ok(None);
    };
    tracing::info!(
        measured = measured.integrated_lufs,
        true_peak = measured.true_peak,
        target_lufs,
        gain,
        path = %path.display(),
        "Normalizing export loudness"
    );
    let temp_path: PathBuf = path.with_extension(format!(
        "loudness.{}",
        path.extension().and_then(|e| e.to_str()).unwrap_or("mp4")
    ));
    let result = render_at_target(path, &temp_path, target_lufs, &mut gain)
        .and_then(|()| std::fs::rename(&temp_path, path).map_err(LoudnessError::from));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result.map(|()| Some(gain))
}

// The true-peak limiter removes loudness when a quiet recording needs a large
// boost, so a single pass at the measured gain lands short of the target.
fn render_at_target(
    path: &Path,
    temp_path: &Path,
    target_lufs: f32,
    gain: &mut f32,
) -> Result<(), LoudnessError> {
    for _ in 0..MAX_PASSES {
        rewrite_audio(path, temp_path, *gain)?;
        let Some(rendered) = measure_loudness(temp_path)? else {
            return Ok(());
        };
        let shortfall = target_lufs - rendered.integrated_lufs;
        let next = (*gain + shortfall).clamp(
            -MAX_GAIN_DB - LIMITER_HEADROOM_DB,
            MAX_GAIN_DB + LIMITER_HEADROOM_DB,
        );
        if shortfall.abs() < MIN_ADJUSTMENT_DB || (next - *gain).abs() < f32::EPSILON {
            return Ok(());
        }
        *gain = next;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loudness(integrated_lufs: f32, true_peak: f32) -> Loudness {
        Loudness {
            integrated_lufs,
            true_peak,
        }
    }

    fn write_sine_wav(path: &Path, amplitude: f32, seconds: u32) {
        let rate = 48_000u32;
        let samples: Vec<i16> = (0..rate * seconds)
            .map(|i| {
                let t = i as f32 / rate as f32;
                (amplitude * (std::f32::consts::TAU * 440.0 * t).sin() * f32::from(i16::MAX)) as i16
            })
            .collect();
        let data_len = (samples.len() * 2) as u32;
        let mut bytes = Vec::with_capacity(44 + data_len as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        std::fs::write(path, bytes).unwrap();
    }

    fn aac_fixture(dir: &Path, name: &str, amplitude: f32) -> PathBuf {
        let wav = dir.join(format!("{name}.wav"));
        write_sine_wav(&wav, amplitude, 6);
        let m4a = dir.join(format!("{name}.m4a"));
        rewrite_audio(&wav, &m4a, 0.0).unwrap();
        m4a
    }

    #[test]
    fn normalizes_a_quiet_file_to_the_target_with_a_true_peak_limit() {
        ffmpeg::init().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = aac_fixture(dir.path(), "quiet", 0.02);
        let before = measure_loudness(&path).unwrap().unwrap();
        assert!(before.integrated_lufs < -30.0, "before {before:?}");

        let gain = normalize_file_loudness(&path, SOCIAL_TARGET_LUFS).unwrap();
        assert!(gain.is_some());
        let after = measure_loudness(&path).unwrap().unwrap();
        assert!(
            (after.integrated_lufs - SOCIAL_TARGET_LUFS).abs() < 1.0,
            "after {after:?}"
        );
        assert!(after.true_peak <= TRUE_PEAK_LIMIT * 1.06, "after {after:?}");
        assert!(!path.with_extension("loudness.m4a").exists());
    }

    #[test]
    fn limits_peaks_even_when_loudness_is_on_target() {
        let hot = loudness(-14.2, 1.0);
        assert!(normalization_gain_db(hot, SOCIAL_TARGET_LUFS).is_some());
        let clean = loudness(-14.2, 0.5);
        assert!(normalization_gain_db(clean, SOCIAL_TARGET_LUFS).is_none());
    }

    #[test]
    #[ignore = "normalizes a real file named by CAP_LOUDNESS_TEST_FILE"]
    fn normalizes_a_real_file_to_the_target() {
        let Ok(path) = std::env::var("CAP_LOUDNESS_TEST_FILE") else {
            return;
        };
        ffmpeg::init().unwrap();
        let path = Path::new(&path);
        let before = measure_loudness(path).unwrap().unwrap();
        let gain = normalize_file_loudness(path, SOCIAL_TARGET_LUFS).unwrap();
        let after = measure_loudness(path).unwrap().unwrap();
        println!("before {before:?}, gain {gain:?}, after {after:?}");
        assert!(
            (after.integrated_lufs - SOCIAL_TARGET_LUFS).abs() < 1.0,
            "after {after:?}"
        );
    }

    #[test]
    fn gain_targets_social_loudness_within_limits() {
        let quiet_peak = 0.5;
        assert_eq!(
            normalization_gain_db(loudness(-20.0, quiet_peak), SOCIAL_TARGET_LUFS),
            Some(6.0)
        );
        assert_eq!(
            normalization_gain_db(loudness(-14.2, quiet_peak), SOCIAL_TARGET_LUFS),
            None
        );
        assert_eq!(
            normalization_gain_db(loudness(-60.0, quiet_peak), SOCIAL_TARGET_LUFS),
            Some(20.0)
        );
        assert_eq!(
            normalization_gain_db(loudness(-8.0, quiet_peak), SOCIAL_TARGET_LUFS),
            Some(-6.0)
        );
    }
}
