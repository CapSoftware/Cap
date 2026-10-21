use ffmpeg::{
    ChannelLayout, Dictionary, Packet, Rational,
    codec::{self, context},
    encoder, filter,
    format::{self, Sample, sample::Type},
    frame, media,
};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

pub const SOCIAL_TARGET_LUFS: f32 = -14.0;
const TRUE_PEAK_LIMIT: f32 = 0.891_251; // -1 dBTP
const MAX_GAIN_DB: f32 = 20.0;
const MIN_ADJUSTMENT_DB: f32 = 0.5;
const MAX_PASSES: usize = 3;
const LIMITER_HEADROOM_DB: f32 = 6.0;
const OUTPUT_BITRATE: usize = 320_000;
/// How often (in packets) the streaming loops look at the cancel flag.
const CANCEL_CHECK_PACKETS: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum LoudnessError {
    #[error("{0}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("AAC encoder not available")]
    EncoderNotFound,
    #[error("Loudness normalization cancelled")]
    Cancelled,
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
    measure(path, &AtomicBool::new(false))
}

fn measure(path: &Path, cancel: &AtomicBool) -> Result<Option<Loudness>, LoudnessError> {
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
    for (count, (stream, packet)) in input.packets().enumerate() {
        if count % CANCEL_CHECK_PACKETS == 0 {
            check_cancel(cancel)?;
        }
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

/// Encodes the best audio stream of `source` to an audio-only AAC file at
/// `dest`, `gain_db` louder and true-peak limited. Nothing else is copied:
/// the passes that search for the right gain only ever touch the audio.
fn encode_audio(
    source: &Path,
    dest: &Path,
    gain_db: f32,
    cancel: &AtomicBool,
) -> Result<bool, LoudnessError> {
    let mut input = format::input(&source)?;
    let Some((audio_index, audio_time_base, mut decoder)) = audio_decoder(&input)? else {
        return Ok(false);
    };
    let mut output = format::output(dest)?;

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
    let out_audio_index = {
        let mut out = output.add_stream(codec)?;
        out.set_time_base(Rational(1, rate));
        out.set_parameters(&audio_encoder);
        out.index()
    };
    output.write_header()?;

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
    for (count, (stream, packet)) in input.packets().enumerate() {
        if count % CANCEL_CHECK_PACKETS == 0 {
            check_cancel(cancel)?;
        }
        if stream.index() != audio_index {
            continue;
        }
        decoder.send_packet(&packet)?;
        while decoder.receive_frame(&mut decoded).is_ok() {
            graph.get("in").unwrap().source().add(&decoded)?;
            drain_graph(&mut graph, |frame| {
                encode(frame, &mut audio_encoder, &mut output)
            })?;
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
    Ok(true)
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

/// One packet waiting to be written by [`mux_audio_into`], with its decode
/// time in seconds so the two inputs can be interleaved in order.
struct Pending {
    packet: Packet,
    from: Rational,
    to: Rational,
    out_index: usize,
    seconds: f64,
}

fn pending(packet: Packet, from: Rational, to: Rational, out_index: usize) -> Pending {
    let ts = packet.dts().or(packet.pts()).unwrap_or(0);
    let seconds = ts as f64 * f64::from(from.numerator()) / f64::from(from.denominator().max(1));
    Pending {
        packet,
        from,
        to,
        out_index,
        seconds,
    }
}

/// Writes `dest`: every video and subtitle stream of `video_source` copied
/// as-is, plus the single audio stream of `audio_source` (already encoded),
/// interleaved by decode time. The one and only pass over the video.
fn mux_audio_into(
    video_source: &Path,
    audio_source: &Path,
    dest: &Path,
    cancel: &AtomicBool,
) -> Result<(), LoudnessError> {
    let mut video_input = format::input(&video_source)?;
    let mut audio_input = format::input(&audio_source)?;
    let audio_stream = audio_input
        .streams()
        .best(media::Type::Audio)
        .ok_or(ffmpeg::Error::StreamNotFound)?;
    let audio_in_index = audio_stream.index();
    let audio_in_time_base = audio_stream.time_base();
    let audio_parameters = audio_stream.parameters();

    let mut output = format::output(dest)?;
    let mut video_map = vec![None; video_input.nb_streams() as usize];
    for stream in video_input.streams() {
        if matches!(
            stream.parameters().medium(),
            media::Type::Video | media::Type::Subtitle
        ) {
            let mut out = output.add_stream(encoder::find(codec::Id::None))?;
            out.set_parameters(stream.parameters());
            unsafe { (*out.parameters().as_mut_ptr()).codec_tag = 0 };
            video_map[stream.index()] = Some((out.index(), stream.time_base()));
        }
    }
    let audio_out_index = {
        let mut out = output.add_stream(encoder::find(codec::Id::None))?;
        out.set_parameters(audio_parameters);
        unsafe { (*out.parameters().as_mut_ptr()).codec_tag = 0 };
        out.index()
    };
    let mut options = Dictionary::new();
    options.set("movflags", "+faststart");
    output.write_header_with(options)?;
    let out_time_bases: Vec<Rational> = (0..output.nb_streams() as usize)
        .map(|index| output.stream(index).unwrap().time_base())
        .collect();

    let mut video_packets = video_input.packets().filter_map(|(stream, packet)| {
        let (out_index, from) = video_map[stream.index()]?;
        Some(pending(packet, from, out_time_bases[out_index], out_index))
    });
    let mut audio_packets = audio_input
        .packets()
        .filter(|(stream, _)| stream.index() == audio_in_index)
        .map(|(_, packet)| {
            pending(
                packet,
                audio_in_time_base,
                out_time_bases[audio_out_index],
                audio_out_index,
            )
        });

    let mut next_video = video_packets.next();
    let mut next_audio = audio_packets.next();
    let mut written = 0usize;
    loop {
        let take_video = match (&next_video, &next_audio) {
            (Some(video), Some(audio)) => video.seconds <= audio.seconds,
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (None, None) => break,
        };
        let item = if take_video {
            std::mem::replace(&mut next_video, video_packets.next())
        } else {
            std::mem::replace(&mut next_audio, audio_packets.next())
        };
        let Some(Pending {
            mut packet,
            from,
            to,
            out_index,
            ..
        }) = item
        else {
            continue;
        };
        if written % CANCEL_CHECK_PACKETS == 0 {
            check_cancel(cancel)?;
        }
        written += 1;
        packet.rescale_ts(from, to);
        packet.set_position(-1);
        packet.set_stream(out_index);
        packet.write_interleaved(&mut output)?;
    }
    output.write_trailer()?;
    Ok(())
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), LoudnessError> {
    if cancel.load(Ordering::Relaxed) {
        Err(LoudnessError::Cancelled)
    } else {
        Ok(())
    }
}

/// A fresh, randomly named file next to `path` for the rewritten export.
/// Created exclusively, so it can never be (or follow) a file someone else
/// put there; and verified again before it replaces the export.
fn scratch_beside(path: &Path) -> Result<tempfile::NamedTempFile, LoudnessError> {
    let dir = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
    Ok(tempfile::Builder::new()
        .prefix(".cap-loudness-")
        .suffix(&format!(".{extension}"))
        .tempfile_in(dir)?)
}

/// The scratch path must still be the regular file `tempfile` created (same
/// inode), not something swapped in while FFmpeg was writing.
fn verify_scratch(scratch: &tempfile::NamedTempFile) -> Result<(), LoudnessError> {
    let on_disk = std::fs::symlink_metadata(scratch.path())?;
    let ours = scratch.as_file().metadata()?;
    let same = on_disk.file_type().is_file() && {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            on_disk.ino() == ours.ino() && on_disk.dev() == ours.dev()
        }
        #[cfg(not(unix))]
        {
            on_disk.len() == ours.len()
        }
    };
    if same {
        Ok(())
    } else {
        Err(LoudnessError::Io(std::io::Error::other(
            "the loudness scratch file was replaced while writing",
        )))
    }
}

/// Normalizes the export at `path` to `target_lufs` in place. The gain search
/// runs on an audio-only scratch file in a private temp directory; the video
/// is remuxed exactly once, into a fresh file beside the export that then
/// atomically replaces it. `cancel` is checked between passes and while
/// streaming; a cancelled or failed run leaves the export untouched.
pub fn normalize_file_loudness(
    path: &Path,
    target_lufs: f32,
    cancel: &AtomicBool,
) -> Result<Option<f32>, LoudnessError> {
    let Some(measured) = measure(path, cancel)? else {
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
    let work = tempfile::Builder::new().prefix("cap-loudness-").tempdir()?;
    let audio = work.path().join("audio.m4a");
    if !render_at_target(path, &audio, target_lufs, &mut gain, cancel)? {
        return Ok(None);
    }
    check_cancel(cancel)?;
    let scratch = scratch_beside(path)?;
    mux_audio_into(path, &audio, scratch.path(), cancel)?;
    check_cancel(cancel)?;
    verify_scratch(&scratch)?;
    scratch.persist(path).map_err(|error| error.error)?;
    Ok(Some(gain))
}

// The true-peak limiter removes loudness when a quiet recording needs a large
// boost, so a single pass at the measured gain lands short of the target.
// Each pass re-encodes only the audio.
fn render_at_target(
    source: &Path,
    audio: &Path,
    target_lufs: f32,
    gain: &mut f32,
    cancel: &AtomicBool,
) -> Result<bool, LoudnessError> {
    for _ in 0..MAX_PASSES {
        check_cancel(cancel)?;
        if !encode_audio(source, audio, *gain, cancel)? {
            return Ok(false);
        }
        let Some(rendered) = measure(audio, cancel)? else {
            return Ok(true);
        };
        let shortfall = target_lufs - rendered.integrated_lufs;
        let next = (*gain + shortfall).clamp(
            -MAX_GAIN_DB - LIMITER_HEADROOM_DB,
            MAX_GAIN_DB + LIMITER_HEADROOM_DB,
        );
        if shortfall.abs() < MIN_ADJUSTMENT_DB || (next - *gain).abs() < f32::EPSILON {
            return Ok(true);
        }
        *gain = next;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
        encode_audio(&wav, &m4a, 0.0, &AtomicBool::new(false)).unwrap();
        m4a
    }

    #[test]
    fn normalizes_a_quiet_file_to_the_target_with_a_true_peak_limit() {
        ffmpeg::init().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = aac_fixture(dir.path(), "quiet", 0.02);
        let before = measure_loudness(&path).unwrap().unwrap();
        assert!(before.integrated_lufs < -30.0, "before {before:?}");

        let gain =
            normalize_file_loudness(&path, SOCIAL_TARGET_LUFS, &AtomicBool::new(false)).unwrap();
        assert!(gain.is_some());
        let after = measure_loudness(&path).unwrap().unwrap();
        assert!(
            (after.integrated_lufs - SOCIAL_TARGET_LUFS).abs() < 1.0,
            "after {after:?}"
        );
        assert!(after.true_peak <= TRUE_PEAK_LIMIT * 1.06, "after {after:?}");
        assert!(!path.with_extension("loudness.m4a").exists());
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// The old predictable `<name>.loudness.<ext>` is never touched, and no
    /// scratch file is left behind next to the export.
    #[test]
    fn never_touches_a_file_with_the_old_scratch_name_and_leaves_no_scratch() {
        ffmpeg::init().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = aac_fixture(dir.path(), "quiet", 0.02);
        std::fs::remove_file(dir.path().join("quiet.wav")).unwrap();
        let bystander = path.with_extension("loudness.m4a");
        std::fs::write(&bystander, b"the user's own file").unwrap();
        normalize_file_loudness(&path, SOCIAL_TARGET_LUFS, &AtomicBool::new(false))
            .unwrap()
            .unwrap();
        assert_eq!(std::fs::read(&bystander).unwrap(), b"the user's own file");
        assert_eq!(entries(dir.path()), vec!["quiet.loudness.m4a", "quiet.m4a"]);
    }

    #[test]
    fn a_cancelled_run_leaves_the_export_untouched() {
        ffmpeg::init().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = aac_fixture(dir.path(), "quiet", 0.02);
        let before = std::fs::read(&path).unwrap();
        let result = normalize_file_loudness(&path, SOCIAL_TARGET_LUFS, &AtomicBool::new(true));
        assert!(
            matches!(result, Err(LoudnessError::Cancelled)),
            "{result:?}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(entries(dir.path()), vec!["quiet.m4a", "quiet.wav"]);
    }

    /// Decodes the best audio stream to mono f32 at 48kHz.
    fn decode_mono(path: &Path) -> Vec<f32> {
        let mut input = format::input(&path).unwrap();
        let (index, time_base, mut decoder) = audio_decoder(&input).unwrap().unwrap();
        let mut graph = filter_graph(
            &decoder,
            time_base,
            "aresample=48000,aformat=sample_fmts=flt:channel_layouts=mono",
        )
        .unwrap();
        let mut samples = Vec::new();
        let mut collect = |frame: &frame::Audio| {
            samples.extend_from_slice(&frame.plane::<f32>(0)[..frame.samples()]);
            Ok(())
        };
        let mut decoded = frame::Audio::empty();
        for (stream, packet) in input.packets() {
            if stream.index() != index {
                continue;
            }
            decoder.send_packet(&packet).unwrap();
            while decoder.receive_frame(&mut decoded).is_ok() {
                graph.get("in").unwrap().source().add(&decoded).unwrap();
                drain_graph(&mut graph, &mut collect).unwrap();
            }
        }
        decoder.send_eof().unwrap();
        while decoder.receive_frame(&mut decoded).is_ok() {
            graph.get("in").unwrap().source().add(&decoded).unwrap();
        }
        graph.get("in").unwrap().source().flush().unwrap();
        drain_graph(&mut graph, &mut collect).unwrap();
        samples
    }

    fn loudest_sample(samples: &[f32]) -> usize {
        samples
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
            .unwrap()
            .0
    }

    /// The A/V sync guard: the rewritten audio must start exactly where the
    /// original did. A click at 3.000s in a quiet bed is found at the same
    /// sample (within 1ms) before and after normalization, so AAC priming
    /// and the limiter's lookahead don't shift the track against the video.
    #[test]
    fn normalization_keeps_audio_timing() {
        ffmpeg::init().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("click.wav");
        let rate = 48_000usize;
        let mut samples: Vec<i16> = (0..rate * 6)
            .map(|i| {
                let t = i as f32 / rate as f32;
                (0.01 * (std::f32::consts::TAU * 220.0 * t).sin() * f32::from(i16::MAX)) as i16
            })
            .collect();
        for sample in &mut samples[rate * 3..rate * 3 + 48] {
            *sample = i16::MAX / 2;
        }
        let data_len = (samples.len() * 2) as u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&(rate as u32).to_le_bytes());
        bytes.extend_from_slice(&(rate as u32 * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        std::fs::write(&wav, bytes).unwrap();
        let path = dir.path().join("click.m4a");
        encode_audio(&wav, &path, 0.0, &AtomicBool::new(false)).unwrap();

        let before = loudest_sample(&decode_mono(&path));
        normalize_file_loudness(&path, SOCIAL_TARGET_LUFS, &AtomicBool::new(false))
            .unwrap()
            .expect("the quiet bed needs a boost");
        let after = loudest_sample(&decode_mono(&path));
        let shift_ms = (after as f64 - before as f64) * 1000.0 / rate as f64;
        assert!(shift_ms.abs() <= 1.0, "audio moved by {shift_ms}ms");
        let original = (before as f64 - (rate * 3) as f64) * 1000.0 / rate as f64;
        assert!(
            original.abs() <= 1.0,
            "the AAC fixture itself is {original}ms off"
        );
    }

    /// Every video packet's timing, in seconds, for comparing remuxes.
    fn video_timeline(path: &Path) -> Vec<(i64, i64, usize)> {
        let mut input = format::input(&path).unwrap();
        let stream = input.streams().best(media::Type::Video).unwrap();
        let (index, tb) = (stream.index(), stream.time_base());
        // Microseconds, so a remux that picks another time base still compares.
        let us = move |ts: Option<i64>| {
            ts.map_or(i64::MIN, |ts| {
                (ts as f64 * f64::from(tb.numerator()) * 1e6 / f64::from(tb.denominator())).round()
                    as i64
            })
        };
        input
            .packets()
            .filter(|(stream, _)| stream.index() == index)
            .map(|(_, packet)| (us(packet.pts()), us(packet.dts()), packet.size()))
            .collect()
    }

    /// Offset (in samples) of `b` against `a` that lines their waveforms up
    /// best, searched within +-`max` samples over a window from 1s in.
    fn best_lag(a: &[f32], b: &[f32], max: isize) -> isize {
        let start = 48_000usize;
        let len = (48_000 * 10).min(a.len().saturating_sub(start + max as usize));
        (-max..=max)
            .max_by(|x, y| {
                let score = |lag: isize| -> f64 {
                    (0..len)
                        .map(|i| {
                            let j = (start + i) as isize + lag;
                            f64::from(a[start + i])
                                * f64::from(b.get(j as usize).copied().unwrap_or(0.0))
                        })
                        .sum()
                };
                score(*x).total_cmp(&score(*y))
            })
            .unwrap()
    }

    /// A/V sync on a real export: normalize a copy, then check the video
    /// packets are byte-for-byte the same timeline and the audio sits within
    /// 1ms of where it was. Never touches the original file.
    #[test]
    #[ignore = "checks A/V sync on a real export named by CAP_LOUDNESS_AV_FILE"]
    fn normalizing_a_real_export_keeps_av_sync() {
        let Ok(original) = std::env::var("CAP_LOUDNESS_AV_FILE") else {
            return;
        };
        ffmpeg::init().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join("export.mp4");
        std::fs::copy(&original, &copy).unwrap();
        let before_video = video_timeline(&copy);
        let before_audio = decode_mono(&copy);
        let before = measure_loudness(&copy).unwrap().unwrap();
        let gain =
            normalize_file_loudness(&copy, SOCIAL_TARGET_LUFS, &AtomicBool::new(false)).unwrap();
        let after = measure_loudness(&copy).unwrap().unwrap();
        let after_video = video_timeline(&copy);
        let after_audio = decode_mono(&copy);
        let lag = best_lag(&before_audio, &after_audio, 480);
        println!(
            "before {before:?}, gain {gain:?}, after {after:?}, video packets {}, audio lag {:.2}ms, audio length {} -> {} samples",
            before_video.len(),
            lag as f64 / 48.0,
            before_audio.len(),
            after_audio.len(),
        );
        if let Some((at, (a, b))) = before_video
            .iter()
            .zip(&after_video)
            .enumerate()
            .find(|(_, (a, b))| a != b)
        {
            panic!("video packet {at} changed: {a:?} -> {b:?}");
        }
        assert_eq!(before_video.len(), after_video.len(), "video packet count");
        assert!(lag.abs() <= 48, "audio moved by {:.2}ms", lag as f64 / 48.0);
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
        let gain =
            normalize_file_loudness(path, SOCIAL_TARGET_LUFS, &AtomicBool::new(false)).unwrap();
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
