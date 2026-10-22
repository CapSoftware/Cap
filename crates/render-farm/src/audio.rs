use crate::{project::LoadedProject, video::base64_encode};
use anyhow::{Context, Result, anyhow, bail};
use cap_editor::AudioRenderer;
use cap_project::StudioRecordingMeta;
use ffmpeg::{ChannelLayout, format::Sample, format::sample::Type, frame};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{BufWriter, Write},
    path::PathBuf,
    time::Instant,
};

pub const SAMPLE_RATE: i64 = 48_000;
pub const PACKET_SAMPLES: i64 = 1024;
/// The AAC encoder's priming delay. The final MP4's audio edit list skips it,
/// so global packet `j` presents samples starting at `(j - 1) * 1024`.
pub const PRIMING: i64 = 1024;
const AAC_BITRATE: usize = 320_000;

#[derive(Deserialize)]
pub struct AudioRequest {
    pub project: PathBuf,
    pub fps: u32,
    /// Output-timeline sample range this section owns: every AAC packet whose
    /// first presented sample falls in `[start, end)`. `start` is a multiple of
    /// 1024; section 0 also owns the priming packet.
    pub section: [i64; 2],
    /// Samples rendered and encoded before `start` and thrown away, so the
    /// encoder, resampler and Studio Sound state match an unbroken export at
    /// the seam.
    pub preroll: i64,
    pub out: PathBuf,
}

#[derive(Serialize)]
pub struct AudioResult {
    /// Global index of the first packet in `out`.
    pub first_packet: u64,
    pub sizes: Vec<u32>,
    /// AudioSpecificConfig.
    pub extradata: String,
    pub total_samples: i64,
    pub timings: AudioTimings,
}

#[derive(Serialize, Default)]
pub struct AudioTimings {
    pub load_ms: u64,
    pub decode_ms: u64,
    pub render_ms: u64,
    pub total_ms: u64,
}

pub async fn render(request: AudioRequest) -> Result<AudioResult> {
    let started = Instant::now();
    let mut timings = AudioTimings::default();
    let project = LoadedProject::load(&request.project)?;
    let total_frames = project.total_frames(request.fps) as i64;
    let total_samples = total_frames * SAMPLE_RATE / request.fps as i64;
    let [start, end] = request.section;
    if start % PACKET_SAMPLES != 0 || request.preroll % PACKET_SAMPLES != 0 || start >= end {
        bail!("misaligned audio section {:?}", request.section);
    }
    let end = end.min(total_samples);
    let is_last = end >= total_samples;
    timings.load_ms = started.elapsed().as_millis() as u64;

    let phase = Instant::now();
    let input_start_secs = ((start - request.preroll).max(0)) as f64 / SAMPLE_RATE as f64;
    let render_end_secs = (end + 2 * PACKET_SAMPLES) as f64 / SAMPLE_RATE as f64;
    let windows = source_windows(&project, input_start_secs, render_end_secs);
    let segments = load_audio_segments(&project, &windows).await?;
    let music = cap_editor::load_music_tracks_uncached(&project.config, &project.path);
    timings.decode_ms = phase.elapsed().as_millis() as u64;

    let phase = Instant::now();
    let input_start = (start - request.preroll).max(0);
    let keep_from = if start == 0 { -PRIMING } else { start };
    let render_until = if is_last {
        end
    } else {
        (end + 2 * PACKET_SAMPLES).min(total_samples)
    };

    let mut renderer = AudioRenderer::new(segments).with_music(music);
    renderer.set_playhead(input_start as f64 / SAMPLE_RATE as f64, &project.config);

    let codec = ffmpeg::encoder::find(ffmpeg::codec::Id::AAC).context("aac encoder")?;
    let context = ffmpeg::codec::context::Context::new_with_codec(codec);
    let mut encoder = context.encoder().audio()?;
    encoder.set_rate(SAMPLE_RATE as i32);
    encoder.set_channel_layout(ChannelLayout::STEREO);
    encoder.set_format(Sample::F32(Type::Planar));
    encoder.set_bit_rate(AAC_BITRATE);
    encoder.set_time_base(ffmpeg::Rational::new(1, SAMPLE_RATE as i32));
    encoder.set_flags(ffmpeg::codec::flag::Flags::GLOBAL_HEADER);
    let mut encoder = encoder.open_as(codec)?;
    let extradata = unsafe {
        let pointer = encoder.as_ptr();
        std::slice::from_raw_parts((*pointer).extradata, (*pointer).extradata_size as usize)
            .to_vec()
    };

    let mut output = BufWriter::with_capacity(4 << 20, File::create(&request.out)?);
    let mut sizes = Vec::new();
    let mut first_packet: Option<i64> = None;
    let mut packet = ffmpeg::Packet::empty();
    let mut drain = |encoder: &mut ffmpeg::encoder::Audio,
                     sizes: &mut Vec<u32>,
                     first_packet: &mut Option<i64>|
     -> Result<bool> {
        while encoder.receive_packet(&mut packet).is_ok() {
            let pts = packet
                .pts()
                .ok_or_else(|| anyhow!("aac packet without pts"))?;
            let global_start = input_start + pts;
            if global_start < keep_from {
                continue;
            }
            if global_start >= end {
                return Ok(true);
            }
            let index = (global_start + PRIMING) / PACKET_SAMPLES;
            match first_packet {
                None => *first_packet = Some(index),
                Some(first) if index != *first + sizes.len() as i64 => {
                    bail!("audio packet {index} out of sequence");
                }
                _ => {}
            }
            let data = packet.data().ok_or_else(|| anyhow!("empty aac packet"))?;
            output.write_all(data)?;
            sizes.push(data.len() as u32);
        }
        Ok(false)
    };

    let mut position = input_start;
    let mut planar = frame::Audio::new(
        Sample::F32(Type::Planar),
        PACKET_SAMPLES as usize,
        ChannelLayout::STEREO,
    );
    planar.set_rate(SAMPLE_RATE as u32);
    let mut done = false;
    while position < render_until && !done {
        let count = (render_until - position).min(PACKET_SAMPLES) as usize;
        let interleaved = renderer
            .render_frame_raw(count, &project.config)
            .map(|(_, data)| data)
            .unwrap_or_default();
        // The encoder may still hold a reference to the previous frame's buffer.
        unsafe { ffmpeg::ffi::av_frame_make_writable(planar.as_mut_ptr()) };
        {
            let (left, right) = split_planes(&mut planar);
            for index in 0..PACKET_SAMPLES as usize {
                let (l, r) = if index < count {
                    (
                        interleaved.get(index * 2).copied().unwrap_or(0.0),
                        interleaved.get(index * 2 + 1).copied().unwrap_or(0.0),
                    )
                } else {
                    (0.0, 0.0)
                };
                left[index] = l;
                right[index] = r;
            }
        }
        if count < PACKET_SAMPLES as usize {
            // A partial final frame: the encoder must see its true length.
            let mut tail =
                frame::Audio::new(Sample::F32(Type::Planar), count, ChannelLayout::STEREO);
            tail.set_rate(SAMPLE_RATE as u32);
            {
                let (left, right) = split_planes(&mut tail);
                let (source_left, source_right) = split_planes(&mut planar);
                left[..count].copy_from_slice(&source_left[..count]);
                right[..count].copy_from_slice(&source_right[..count]);
            }
            tail.set_pts(Some(position - input_start));
            encoder.send_frame(&tail)?;
        } else {
            planar.set_pts(Some(position - input_start));
            encoder.send_frame(&planar)?;
        }
        position += count as i64;
        done = drain(&mut encoder, &mut sizes, &mut first_packet)?;
    }
    if is_last && !done {
        encoder.send_eof()?;
        drain(&mut encoder, &mut sizes, &mut first_packet)?;
    }
    output.flush()?;
    timings.render_ms = phase.elapsed().as_millis() as u64;

    let expected_first = if start == 0 {
        0
    } else {
        (start + PRIMING) / PACKET_SAMPLES
    };
    let first = first_packet.ok_or_else(|| anyhow!("audio section produced no packets"))?;
    if first != expected_first {
        bail!("audio section starts at packet {first}, expected {expected_first}");
    }
    let expected_end = if is_last {
        (end + PRIMING + PACKET_SAMPLES - 1) / PACKET_SAMPLES
    } else {
        (end + PRIMING) / PACKET_SAMPLES
    };
    if first + sizes.len() as i64 != expected_end {
        bail!(
            "audio section {:?} produced packets {first}..{}, expected ..{expected_end}",
            request.section,
            first + sizes.len() as i64
        );
    }
    timings.total_ms = started.elapsed().as_millis() as u64;
    Ok(AudioResult {
        first_packet: first as u64,
        sizes,
        extradata: base64_encode(&extradata),
        total_samples,
        timings,
    })
}

fn split_planes(frame: &mut frame::Audio) -> (&mut [f32], &mut [f32]) {
    let samples = frame.samples();
    unsafe {
        let pointer = frame.as_mut_ptr();
        let left = std::slice::from_raw_parts_mut((*pointer).data[0] as *mut f32, samples);
        let right = std::slice::from_raw_parts_mut((*pointer).data[1] as *mut f32, samples);
        (left, right)
    }
}

/// Source seconds each recording clip's audio is read over for an output
/// range, widened for mic offsets and the enhancer/speed pre-roll.
fn source_windows(project: &LoadedProject, from: f64, to: f64) -> Vec<Option<(f64, f64)>> {
    let clips = project.recordings.segments.len();
    let mut windows: Vec<Option<(f64, f64)>> = vec![None; clips];
    let mut time = from;
    while time <= to {
        if let Some((source, segment)) = project.config.get_segment_time(time) {
            let index = segment.recording_clip as usize;
            if let Some(window) = windows.get_mut(index) {
                *window = Some(match *window {
                    Some((low, high)) => (low.min(source), high.max(source)),
                    None => (source, source),
                });
            }
        }
        time += 0.02;
    }
    let margin = 5.0
        + project
            .config
            .clips
            .iter()
            .map(|clip| clip.offsets.mic.abs().max(clip.offsets.system_audio.abs()) as f64)
            .fold(0.0, f64::max);
    windows
        .into_iter()
        .map(|window| window.map(|(low, high)| ((low - margin).max(0.0), high + margin)))
        .collect()
}

async fn load_audio_segments(
    project: &LoadedProject,
    windows: &[Option<(f64, f64)>],
) -> Result<Vec<cap_editor::AudioSegment>> {
    let legacy_log = std::fs::read_to_string(
        project
            .recording_meta
            .project_path
            .join("recording-logs.log"),
    )
    .ok();
    let repairs =
        cap_editor::segment_audio_timing_repairs(&project.studio_meta, legacy_log.as_deref());
    let tracks: Vec<(Option<PathBuf>, Option<PathBuf>)> = match &project.studio_meta {
        StudioRecordingMeta::SingleSegment { segment } => vec![(
            segment
                .audio
                .as_ref()
                .map(|audio| project.recording_meta.path(&audio.path)),
            None,
        )],
        StudioRecordingMeta::MultipleSegments { inner } => inner
            .segments
            .iter()
            .map(|segment| {
                (
                    segment
                        .mic
                        .as_ref()
                        .map(|audio| project.recording_meta.path(&audio.path)),
                    segment
                        .system_audio
                        .as_ref()
                        .map(|audio| project.recording_meta.path(&audio.path)),
                )
            })
            .collect(),
    };
    let mut segments = Vec::with_capacity(tracks.len());
    for (index, (mic, system)) in tracks.into_iter().enumerate() {
        let window = windows.get(index).copied().flatten();
        let recorded = project.recordings.segments.get(index);
        let mic_duration = recorded
            .and_then(|segment| segment.mic.as_ref())
            .map(|audio| audio.duration);
        let system_duration = recorded
            .and_then(|segment| segment.system_audio.as_ref())
            .map(|audio| audio.duration);
        let mic = load_track(mic, "mic", window, mic_duration).await?;
        let system = load_track(system, "system audio", window, system_duration).await?;
        segments.push(cap_editor::audio_segment_from_decoded(
            mic,
            system,
            repairs.get(index).copied().unwrap_or_default(),
        ));
    }
    Ok(segments)
}

/// Decodes only the first `VOICE_PROFILE_SAMPLES` (what Studio Sound's voice
/// profile reads) plus the section's source window, placed at their true
/// offsets in a zero-backed buffer. Within the window the renderer sees exactly
/// the samples a full decode would give it, but a 2 h mic costs seconds of
/// decode instead of tens, and untouched zero pages cost no memory.
async fn load_track(
    path: Option<PathBuf>,
    label: &str,
    window: Option<(f64, f64)>,
    duration: Option<f64>,
) -> Result<Option<std::sync::Arc<cap_audio::DecodedAudio>>> {
    let Some(path) = path else {
        return Ok(None);
    };
    let Some((from, to)) = window else {
        return Ok(None);
    };
    let label = label.to_string();
    tokio::task::spawn_blocking(move || {
        let rate = SAMPLE_RATE as f64;
        let profile =
            cap_audio::AudioData::from_file_range(&path, 0, cap_audio::VOICE_PROFILE_SAMPLES)
                .map_err(|error| anyhow!("{label} profile: {error}"))?;
        let start = (from * rate) as usize;
        let duration_samples = duration.map(|seconds| (seconds * rate).round() as usize);
        // Near the end of the recording, decode through EOF so the track keeps
        // its exact decoded length; elsewhere the container length is enough.
        let near_end = duration_samples.is_none_or(|total| (to * rate) as usize + 48_000 >= total);
        let end = if near_end {
            usize::MAX / 4
        } else {
            (to * rate) as usize
        };
        let section = cap_audio::AudioData::from_file_range(&path, start, end)
            .map_err(|error| anyhow!("{label} window: {error}"))?;
        let channels = section.channels().max(profile.channels()) as usize;
        let section_start = section.source_start_sample();
        let decoded_end = section_start + section.sample_count();
        let total = if near_end {
            decoded_end
        } else {
            decoded_end.max(duration_samples.unwrap_or(0))
        }
        .max(profile.sample_count());
        let mut samples = vec![0.0f32; total * channels];
        let copy = |samples: &mut [f32], data: &cap_audio::AudioData| {
            let offset = data.source_start_sample() * channels;
            let source = data.samples();
            if data.channels() as usize == channels {
                samples[offset..offset + source.len()].copy_from_slice(source);
            }
        };
        copy(&mut samples, &profile);
        copy(&mut samples, &section);
        let data =
            std::sync::Arc::new(cap_audio::AudioData::from_samples(samples, channels as u16));
        Ok(Some(std::sync::Arc::new(cap_audio::DecodedAudio::from(
            data,
        ))))
    })
    .await?
}
