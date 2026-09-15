use super::*;
use crate::{AudioRenderer, SegmentAudioTimingRepair, audio_segment_from_decoded};
use cap_audio::{AudioChunk, DecodedAudio, ProgressiveAudio, ProgressiveAudioTestProducer};
use cap_project::{
    ClipConfiguration, ProjectConfiguration, TimelineConfiguration, TimelineSegment,
};

fn sources(duration: f64, loader: Option<ProgressiveAudio>) -> PreparingAudioSources {
    PreparingAudioSources {
        project: Arc::new(ProjectConfiguration {
            timeline: Some(TimelineConfiguration {
                segments: vec![TimelineSegment {
                    recording_clip: 0,
                    start: 0.0,
                    end: duration,
                    timescale: 1.0,
                    ..Default::default()
                }],
                transitions: vec![],
                zoom_segments: vec![],
                scene_segments: vec![],
                mask_segments: vec![],
                text_segments: vec![],
                caption_segments: vec![],
                keyboard_segments: vec![],
                audio_segments: vec![],
                style_segments: vec![],
                image_segments: vec![],
                camera3d_segments: vec![],
            }),
            clips: vec![ClipConfiguration::default()],
            ..Default::default()
        }),
        required: vec![[loader.is_some(), false]],
        tracks: vec![[loader, None]],
        repairs: vec![SegmentAudioTimingRepair::default()],
    }
}

fn audio(frames: usize) -> Arc<AudioData> {
    Arc::new(AudioData::from_raw_f32(
        (0..frames * 2)
            .map(|index| ((index * 71 + 13) % 1009) as f32 / 1300.0 - 0.4)
            .collect(),
        2,
    ))
}

fn append(
    producer: &ProgressiveAudioTestProducer,
    audio: &AudioData,
    range: std::ops::Range<usize>,
) {
    producer
        .append(AudioChunk {
            source_start_sample: range.start as u64,
            channels: 2,
            samples: audio.samples()[range.start * 2..range.end * 2].to_vec(),
        })
        .unwrap();
}

fn info<T: FromSampleBytes>(rate: u32, channels: u16) -> AudioInfo {
    AudioInfo::new_raw(
        cap_media_info::ffmpeg_sample_format_for(T::FORMAT).unwrap(),
        rate,
        channels,
    )
}

fn spawn<T: FromSampleBytes + cpal::FromSample<f32>>(
    sources: PreparingAudioSources,
    info: AudioInfo,
    start: f64,
    runtime: tokio::runtime::Handle,
) -> Result<(PreparingAudioBuffer<T>, PreparingAudioOutputHandle), String> {
    let total = sources.total_duration();
    let (buffer, handle) = PreparingAudioBuffer::spawn(sources, info, start, runtime)?;
    handle.set_playable_until(total)?;
    Ok((buffer, handle))
}

async fn until(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("Preparing output did not reach the expected state");
}

async fn drain<T: FromSampleBytes + cpal::FromSample<f32>>(
    buffer: &mut PreparingAudioBuffer<T>,
) -> Vec<T> {
    let mut actual = Vec::new();
    let mut scratch = vec![T::EQUILIBRIUM; 733 * buffer.channels];
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frames = buffer.fill(&mut scratch, 0.0);
            actual.extend_from_slice(&scratch[..frames * buffer.channels]);
            if buffer.is_terminal() {
                break;
            }
            if frames == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
    })
    .await
    .expect("Preparing output did not drain");
    actual
}

fn ordinary_reference<T: FromSampleBytes + cpal::FromSample<f32>>(
    sources: &PreparingAudioSources,
    audio: Arc<AudioData>,
    output_info: AudioInfo,
    start: f64,
) -> Vec<T> {
    let policy =
        preparing_audio_output_policy(sources.total_duration(), output_info, start).unwrap();
    let decoded = Arc::new(DecodedAudio::from(audio));
    let mut renderer = AudioRenderer::new(vec![audio_segment_from_decoded(
        Some(decoded),
        None,
        sources.repairs[0],
    )]);
    renderer.set_playhead(policy.render_start_seconds, &sources.project);
    let mut resampler = AudioResampler::new(policy.render_info).unwrap();
    let mut bytes = Vec::new();
    while let Some(frame) = renderer.render_frame(MIX_FRAMES, &sources.project) {
        bytes.extend_from_slice(resampler.queue_and_process_frame(&frame));
    }
    while let Some(tail) = resampler.flush_frame() {
        if tail.is_empty() {
            break;
        }
        bytes.extend_from_slice(tail);
    }
    let width = if policy.convert_from_f32 {
        f32::BYTE_SIZE
    } else {
        T::BYTE_SIZE
    };
    let limit = (sources.total_duration() * f64::from(output_info.sample_rate)) as usize
        - (start * f64::from(output_info.sample_rate)) as usize;
    bytes
        .chunks_exact(width)
        .skip(policy.skip_output_frames * output_info.channels)
        .take(limit * output_info.channels)
        .map(|sample| {
            if policy.convert_from_f32 {
                T::from_sample(f32::from_bytes(sample))
            } else {
                T::from_bytes(sample)
            }
        })
        .collect()
}

trait ExactSample {
    fn bits(self) -> u64;
}

impl ExactSample for f32 {
    fn bits(self) -> u64 {
        u64::from(self.to_bits())
    }
}

impl ExactSample for f64 {
    fn bits(self) -> u64 {
        self.to_bits()
    }
}

impl ExactSample for i16 {
    fn bits(self) -> u64 {
        u64::from(self as u16)
    }
}

async fn assert_reference<T: FromSampleBytes + cpal::FromSample<f32> + PartialEq + ExactSample>(
    duration: f64,
    start: f64,
    rate: u32,
    channels: u16,
) {
    let raw = audio(120_000);
    let mut sources = sources(duration, Some(ProgressiveAudio::ready(Some(raw.clone()))));
    let output_info = info::<T>(rate, channels);
    if duration > 1000.0 {
        Arc::make_mut(&mut sources.project).clips[0].offsets.mic = -1799.0;
    }
    let policy = preparing_audio_output_policy(duration, output_info, start).unwrap();
    let short = duration < 1000.0;
    assert_eq!(policy.convert_from_f32, short);
    assert_eq!(
        policy.render_start_seconds,
        if short { (start - 1.0).max(0.0) } else { start }
    );
    assert_eq!(
        policy.render_info.sample_format,
        if short {
            AudioData::SAMPLE_FORMAT
        } else {
            output_info.sample_format
        }
    );
    assert_eq!(
        policy.skip_output_frames,
        if short {
            (start * f64::from(rate)) as usize - ((start - 1.0).max(0.0) * f64::from(rate)) as usize
        } else {
            0
        }
    );
    let expected = ordinary_reference::<T>(&sources, raw, output_info, start);
    let (mut buffer, handle) = spawn::<T>(
        sources,
        output_info,
        start,
        tokio::runtime::Handle::current(),
    )
    .unwrap();
    assert_eq!(
        buffer.samples.as_ref().unwrap().capacity().get(),
        rate as usize * usize::from(channels) * 2
    );
    let actual = drain(&mut buffer).await;
    assert_eq!(
        actual.len(),
        ((duration * f64::from(rate)) as usize - (start * f64::from(rate)) as usize)
            * usize::from(channels)
    );
    assert_eq!(actual.len(), expected.len());
    assert!(actual.iter().any(|&sample| sample != T::EQUILIBRIUM));
    assert_eq!(
        actual
            .iter()
            .zip(&expected)
            .position(|(&a, &b)| a.bits() != b.bits()),
        None
    );
    assert!(
        handle
            .status(Instant::now() + Duration::from_secs(10))
            .ended
    );
    drop(buffer);
    handle.stop_and_wait().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn output_matches_ordinary_resampling_preroll_formats_channels_and_tail() {
    for (rate, channels) in [(48_000, 2), (44_100, 2), (44_100, 1)] {
        assert_reference::<f32>(2.013_345, 1.123_45, rate, channels).await;
        assert_reference::<i16>(2.013_345, 1.123_45, rate, channels).await;
    }
    assert_reference::<i16>(1_800.013_345, 1_799.923_45, 44_100, 2).await;
    assert_reference::<f64>(1_800.013_345, 1_799.923_45, 48_000, 2).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_preserves_resampler_and_only_valid_frames_advance() {
    let raw = audio(70_000);
    let (loader, producer) = ProgressiveAudioTestProducer::new();
    let sources = sources(70_000.0 / 48_000.0, Some(loader.clone()));
    let expected = ordinary_reference::<i16>(&sources, raw.clone(), info::<i16>(44_100, 2), 0.0);
    let (mut buffer, handle) = spawn::<i16>(
        sources,
        info::<i16>(44_100, 2),
        0.0,
        tokio::runtime::Handle::current(),
    )
    .unwrap();
    let mut scratch = [19; 1024];
    assert_eq!(buffer.fill(&mut scratch, 0.0), 0);
    assert_eq!(scratch, [0; 1024]);
    assert!(!buffer.is_terminal());
    append(&producer, &raw, 0..32_768);
    until(|| buffer.control.produced.load(Ordering::Acquire) > 20_000).await;
    let mut actual = Vec::new();
    loop {
        let frames = buffer.fill(&mut scratch, 0.0);
        actual.extend_from_slice(&scratch[..frames * 2]);
        if frames == 0 {
            break;
        }
    }
    assert!(!actual.is_empty());
    assert!(!loader.progress().complete);
    assert!(
        handle
            .status(Instant::now() + Duration::from_secs(2))
            .buffering
    );
    let frozen = handle
        .status(Instant::now() + Duration::from_secs(2))
        .playhead_seconds;
    assert_eq!(
        handle
            .status(Instant::now() + Duration::from_secs(3))
            .playhead_seconds,
        frozen
    );
    append(&producer, &raw, 32_768..65_536);
    append(&producer, &raw, 65_536..70_000);
    producer.finish().unwrap();
    actual.extend(drain(&mut buffer).await);
    assert_eq!(actual.len(), expected.len());
    assert_eq!(
        actual
            .iter()
            .zip(&expected)
            .position(|(&a, &b)| a.bits() != b.bits()),
        None
    );
    drop(buffer);
    handle.stop_and_wait().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hardware_silence_gaps_and_delayed_spans_do_not_advance_media_clock() {
    let (mut buffer, handle) = spawn::<f32>(
        sources(1.0, None),
        info::<f32>(48_000, 2),
        0.0,
        tokio::runtime::Handle::current(),
    )
    .unwrap();
    until(|| buffer.control.eof.load(Ordering::Acquire)).await;
    let epoch = buffer.control.epoch;
    let mut scratch = vec![7.0; 4800 * 2];
    assert_eq!(buffer.fill_at(&mut scratch, 0.1, epoch), 4800);
    assert!(scratch.iter().all(|&value| value == 0.0));
    assert_eq!(
        handle
            .status(epoch + Duration::from_millis(50))
            .playhead_seconds,
        0.0
    );
    assert_eq!(
        handle
            .status(epoch + Duration::from_millis(150))
            .playhead_seconds,
        0.05
    );
    assert_eq!(
        handle
            .status(epoch + Duration::from_millis(900))
            .playhead_seconds,
        0.1
    );
    assert_eq!(
        buffer.fill_at(&mut scratch, 0.2, epoch + Duration::from_secs(1)),
        4800
    );
    assert_eq!(
        handle
            .status(epoch + Duration::from_millis(1100))
            .playhead_seconds,
        0.1
    );
    assert_eq!(
        handle
            .status(epoch + Duration::from_millis(1250))
            .playhead_seconds,
        0.15
    );
    assert_eq!(
        handle
            .status(epoch + Duration::from_millis(1400))
            .playhead_seconds,
        0.2
    );
    drop(buffer);
    handle.stop_and_wait().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bounded_history_applies_backpressure_without_losing_future_clock_spans() {
    let (mut buffer, handle) = spawn::<f32>(
        sources(1.0, None),
        info::<f32>(48_000, 2),
        0.0,
        tokio::runtime::Handle::current(),
    )
    .unwrap();
    until(|| buffer.control.eof.load(Ordering::Acquire)).await;
    let epoch = buffer.control.epoch;
    let mut scratch = [1.0; 2];
    for index in 0..HISTORY_SPANS {
        assert_eq!(
            buffer.fill_at(&mut scratch, 10.0 + index as f64 / 1000.0, epoch),
            1
        );
    }
    assert_eq!(handle.status(epoch).playhead_seconds, 0.0);
    let before = buffer.control.consumed.load(Ordering::Acquire);
    assert_eq!(buffer.fill_at(&mut scratch, 12.0, epoch), 0);
    assert_eq!(buffer.control.consumed.load(Ordering::Acquire), before);
    assert_eq!(
        buffer.fill_at(&mut scratch, 0.0, epoch + Duration::from_secs(15)),
        1
    );
    assert_eq!(
        handle
            .status(epoch + Duration::from_secs(15))
            .playhead_seconds,
        HISTORY_SPANS as f64 / 48_000.0
    );
    drop(buffer);
    handle.stop_and_wait().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_joins_pending_and_full_workers_after_actual_receiver_removal() {
    for mode in 0..3 {
        let (loader, producer) = ProgressiveAudioTestProducer::new();
        let mut sources = sources(10.0, (mode == 0).then_some(loader));
        if mode == 2 {
            sources.required[0][0] = true;
        }
        let project = Arc::downgrade(&sources.project);
        let (buffer, handle) = spawn::<f32>(
            sources,
            info::<f32>(48_000, 2),
            0.0,
            tokio::runtime::Handle::current(),
        )
        .unwrap();
        if mode == 1 {
            until(|| buffer.control.produced.load(Ordering::Acquire) >= 96_000).await;
        }
        let mut stop = Box::pin(handle.stop_and_wait());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut stop)
                .await
                .is_err()
        );
        assert!(!buffer.control.removed.load(Ordering::Acquire));
        drop(stop);
        drop(buffer);
        tokio::time::timeout(Duration::from_secs(2), handle.stop_and_wait())
            .await
            .unwrap()
            .unwrap();
        assert!(project.upgrade().is_none());
        drop(producer);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_loader_is_terminal_without_valid_ack_and_cleanup_still_succeeds() {
    let (loader, producer) = ProgressiveAudioTestProducer::new();
    let (mut buffer, handle) = spawn::<f32>(
        sources(1.0, Some(loader)),
        info::<f32>(48_000, 2),
        0.0,
        tokio::runtime::Handle::current(),
    )
    .unwrap();
    producer.fail("injected audio failure".into());
    until(|| buffer.is_terminal()).await;
    let mut scratch = [1.0; 1024];
    assert_eq!(buffer.fill(&mut scratch, 0.0), 0);
    assert!(scratch.iter().all(|&sample| sample == 0.0));
    assert_eq!(
        handle.status(Instant::now()).error.as_deref(),
        Some("injected audio failure")
    );
    assert!(!handle.status(Instant::now()).ended);
    drop(buffer);
    handle.stop_and_wait().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_latency_fails_closed_and_zero_length_callbacks_preserve_samples() {
    let (mut buffer, handle) = spawn::<f32>(
        sources(0.1, None),
        info::<f32>(48_000, 2),
        0.0,
        tokio::runtime::Handle::current(),
    )
    .unwrap();
    until(|| buffer.control.eof.load(Ordering::Acquire)).await;
    assert_eq!(buffer.fill(&mut [], 0.0), 0);
    assert_eq!(buffer.control.consumed.load(Ordering::Acquire), 0);
    assert_eq!(buffer.fill(&mut [1.0; 16], f64::NAN), 0);
    assert!(buffer.is_terminal());
    assert!(handle.status(Instant::now()).error.is_some());
    assert_eq!(buffer.control.consumed.load(Ordering::Acquire), 0);
    drop(buffer);
    handle.stop_and_wait().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn panic_boundary_retains_actual_native_join_and_sticky_error() {
    let (loader, producer) = ProgressiveAudioTestProducer::new();
    let (buffer, handle) = spawn::<f32>(
        sources(1.0, Some(loader)),
        info::<f32>(48_000, 2),
        0.0,
        tokio::runtime::Handle::current(),
    )
    .unwrap();
    let owned = Arc::new(());
    let weak = Arc::downgrade(&owned);
    let joined = spawn_producer(
        buffer.control.clone(),
        tokio::runtime::Handle::current(),
        move || {
            let _owned = owned;
            panic!("injected native producer panic");
        },
    )
    .unwrap();
    joined.await.unwrap();
    assert!(weak.upgrade().is_none());
    assert!(buffer.is_terminal());
    assert_eq!(
        handle.status(Instant::now()).error.as_deref(),
        Some("Preparing audio producer panicked")
    );
    drop(buffer);
    handle.stop_and_wait().await.unwrap();
    drop(producer);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn installation_without_ambient_runtime_uses_retained_runtime_and_stops_at_end() {
    let runtime = tokio::runtime::Handle::current();
    let (mut buffer, handle) = std::thread::spawn(move || {
        assert!(tokio::runtime::Handle::try_current().is_err());
        spawn::<f32>(sources(0.125, None), info::<f32>(48_000, 2), 0.125, runtime).unwrap()
    })
    .join()
    .unwrap();
    until(|| buffer.is_terminal()).await;
    assert_eq!(buffer.fill(&mut [1.0; 32], 0.0), 0);
    assert_eq!(buffer.control.produced.load(Ordering::Acquire), 0);
    assert!(handle.status(Instant::now()).ended);
    drop(buffer);
    handle.stop_and_wait().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirmed_prefix_gates_queued_audio_and_growth_preserves_every_sample() {
    let raw = audio(48_000);
    let sources = sources(1.0, Some(ProgressiveAudio::ready(Some(raw.clone()))));
    let expected = ordinary_reference::<f32>(&sources, raw, info::<f32>(48_000, 2), 0.0);
    let (mut buffer, handle) = PreparingAudioBuffer::<f32>::spawn(
        sources,
        info::<f32>(48_000, 2),
        0.0,
        tokio::runtime::Handle::current(),
    )
    .unwrap();
    until(|| buffer.control.eof.load(Ordering::Acquire)).await;
    let epoch = buffer.control.epoch;
    let mut scratch = vec![1.0; 9600 * 2];
    assert_eq!(buffer.fill_at(&mut scratch, 0.0, epoch), 0);
    assert!(!buffer.is_terminal());
    assert_eq!(buffer.control.consumed.load(Ordering::Acquire), 0);
    handle.set_playable_until(0.1).unwrap();
    assert_eq!(buffer.fill_at(&mut scratch, 0.0, epoch), 4800);
    let mut actual = scratch[..4800 * 2].to_vec();
    assert!(scratch[4800 * 2..].iter().all(|&sample| sample == 0.0));
    assert_eq!(
        buffer.fill_at(&mut scratch, 0.0, epoch + Duration::from_secs(1)),
        0
    );
    let paused = handle.status(epoch + Duration::from_secs(1));
    assert_eq!(paused.playhead_seconds, 0.1);
    assert!(paused.buffering);
    assert!(!paused.ended);
    assert!(handle.set_playable_until(f64::NAN).is_err());
    assert!(handle.set_playable_until(1.1).is_err());
    handle.set_playable_until(0.05).unwrap();
    assert_eq!(buffer.control.permitted.load(Ordering::Acquire), 4800);
    handle.set_playable_until(1.0).unwrap();
    actual.extend(drain(&mut buffer).await);
    assert_eq!(actual.len(), expected.len());
    assert_eq!(
        actual
            .iter()
            .zip(&expected)
            .position(|(a, b)| a.to_bits() != b.to_bits()),
        None
    );
    drop(buffer);
    handle.stop_and_wait().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_output_bounds_fail_before_a_producer_is_started() {
    for invalid in [
        info::<f32>(0, 2),
        info::<f32>(48_000, 9),
        info::<f32>(u32::MAX, 8),
        info::<i16>(48_000, 2),
    ] {
        assert!(
            PreparingAudioBuffer::<f32>::spawn(
                sources(1.0, None),
                invalid,
                0.0,
                tokio::runtime::Handle::current()
            )
            .is_err()
        );
    }
    assert!(
        PreparingAudioBuffer::<f32>::spawn(
            sources(1.0, None),
            info::<f32>(48_000, 2),
            f64::NAN,
            tokio::runtime::Handle::current()
        )
        .is_err()
    );
}
