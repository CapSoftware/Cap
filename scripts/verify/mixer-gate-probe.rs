#[cfg(test)]
mod controlled_mixer_gate_probe {
    use super::*;

    #[derive(Default)]
    struct CapturedPcm {
        pcm: Vec<[f32; 2]>,
        first_capture: Option<Timestamp>,
        first_timeline: Option<Duration>,
    }

    struct ProbeMuxer(Arc<std::sync::Mutex<CapturedPcm>>);

    impl Muxer for ProbeMuxer {
        type Config = Arc<std::sync::Mutex<CapturedPcm>>;

        async fn setup(
            config: Self::Config,
            _: PathBuf,
            _: Option<VideoInfo>,
            _: Option<AudioInfo>,
            _: Arc<AtomicBool>,
            _: &mut TaskPool,
        ) -> anyhow::Result<Self> {
            Ok(Self(config))
        }

        fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
            Ok(Ok(()))
        }
    }

    impl AudioMuxer for ProbeMuxer {
        fn send_audio_frame(
            &mut self,
            frame: AudioFrame,
            timestamp: Duration,
        ) -> anyhow::Result<()> {
            let mut captured = self.0.lock().unwrap();
            captured.first_capture.get_or_insert(frame.timestamp);
            captured.first_timeline.get_or_insert(timestamp);
            captured.pcm.extend(
                frame.inner.data(0)[..frame.inner.samples() * 8]
                    .chunks_exact(8)
                    .map(|pair| {
                        [
                            f32::from_ne_bytes(pair[..4].try_into().unwrap()),
                            f32::from_ne_bytes(pair[4..].try_into().unwrap()),
                        ]
                    }),
            );
            Ok(())
        }
    }

    #[tokio::test]
    async fn identical_capture_timestamps_and_gate_probe() {
        ffmpeg::init().unwrap();
        for backlog in [false, true] {
            for origin_ns in [0, 1_234_567] {
                for gate_ns in [517_000_000, 517_600_000, 518_000_000] {
                    let timestamps = Timestamps::now();
                    let master_clock = MasterClock::new(timestamps, 48_000);
                    let info = AudioMixer::INFO;
                    let mono = AudioInfo {
                        channels: 1,
                        ..info
                    };
                    let (mut system, system_rx) = mpsc::channel(64);
                    let (mut mic, mic_rx) = mpsc::channel(64);
                    let (output, mut received) = mpsc::channel(128);
                    let mut builder = AudioMixer::builder()
                        .with_timestamps(timestamps)
                        .with_master_clock(master_clock.clone());
                    builder.add_source(info, system_rx);
                    builder.add_source(mono, mic_rx);
                    let mut mixer = builder.build(output).unwrap();
                    let gate = RecordingStartGate::new();
                    assert!(gate.arm_at(timestamps + Duration::from_nanos(gate_ns)));
                    let start_gate = Some(gate.clone());
                    let captured = Arc::new(std::sync::Mutex::new(CapturedPcm::default()));
                    let muxer = Arc::new(Mutex::new(ProbeMuxer(captured.clone())));
                    let (health_tx, _) = new_health_channel();
                    let shared_pause = SharedWallClockPause::new(Arc::new(AtomicBool::new(false)));
                    let mut generator =
                        AudioTimestampGenerator::from_master_clock(master_clock.clone());
                    let mut gap_tracker = AudioGapTracker::new(false, timestamps);
                    let mut gate_applied = true;
                    let mut held = 0;
                    let mut admitted = false;
                    let mut first_tx = None;
                    let mut frame_count = 0;
                    let mut paused = 0;
                    let mut first_mixed_ns = None;
                    let mut input_samples = 0;
                    let mut trim_point = None;
                    let mut first_admitted_ns = None;
                    for chunk in 0..50 {
                        let capture_ns = origin_ns + chunk * 20_000_000;
                        let mut system_bytes = vec![0; 960 * 8];
                        if chunk == 40 {
                            system_bytes[20 * 8..20 * 8 + 4]
                                .copy_from_slice(&0.8_f32.to_ne_bytes());
                        }
                        system
                            .try_send(AudioFrame::new(
                                info.wrap_frame(&system_bytes),
                                Timestamp::Instant(
                                    timestamps.instant() + Duration::from_nanos(capture_ns),
                                ),
                            ))
                            .unwrap();
                        if chunk >= 10 {
                            let mut mic_bytes = vec![0; 960 * 4];
                            if chunk == 40 {
                                mic_bytes[20 * 4..20 * 4 + 4]
                                    .copy_from_slice(&0.4_f32.to_ne_bytes());
                            }
                            mic.try_send(AudioFrame::new(
                                mono.wrap_frame(&mic_bytes),
                                Timestamp::Instant(
                                    timestamps.instant() + Duration::from_nanos(capture_ns),
                                ),
                            ))
                            .unwrap();
                        }
                        if backlog && chunk != 49 {
                            continue;
                        }
                        let observed_at =
                            timestamps.instant() + Duration::from_nanos(capture_ns + 20_000_000);
                        assert!(
                            mixer
                                .tick_for_gate_probe(Timestamp::Instant(observed_at))
                                .unwrap()
                        );
                        while let Ok(Some(frame)) = received.try_next() {
                            let mixed_ns = frame.timestamp.duration_since(timestamps).as_nanos();
                            first_mixed_ns.get_or_insert(mixed_ns);
                            let trim = match gate.admit_audio(
                                frame.timestamp,
                                frame.inner.samples(),
                                48_000,
                            ) {
                                AudioAdmission::Drop => None,
                                AudioAdmission::Trim { samples } => Some(samples),
                                AudioAdmission::Admit => Some(0),
                            };
                            if let Some(trim) = trim {
                                trim_point.get_or_insert(input_samples + trim);
                                first_admitted_ns.get_or_insert(
                                    mixed_ns + trim as u128 * 1_000_000_000 / 48_000,
                                );
                            }
                            input_samples += frame.inner.samples();
                            process_audio_frame(
                                AudioFrameProcessContext {
                                    audio_info: &info,
                                    sample_rate: 48_000,
                                    master_clock: &master_clock,
                                    muxer: &muxer,
                                    health_tx: &health_tx,
                                    shared_pause: &shared_pause,
                                    capture_time_pause: true,
                                    video_start_gate: None,
                                    start_gate: &start_gate,
                                    allow_audio_degradation: false,
                                    origin: FrameProcessOrigin::Live,
                                    observed_at,
                                    timestamps,
                                    anchor: AudioAnchor::PipelineEpoch,
                                },
                                AudioFrameProcessState {
                                    timestamp_generator: &mut generator,
                                    gap_tracker: &mut gap_tracker,
                                    gate_applied: &mut gate_applied,
                                    held_before_start: &mut held,
                                    start_admitted: &mut admitted,
                                    first_tx: &mut first_tx,
                                    frame_count: &mut frame_count,
                                    dropped_during_pause: &mut paused,
                                },
                                frame,
                            )
                            .await
                            .unwrap();
                        }
                    }
                    let captured = captured.lock().unwrap();
                    let peaks: Vec<_> = captured
                        .pcm
                        .iter()
                        .enumerate()
                        .filter_map(|(index, pair)| (pair[0].abs() > 0.1).then_some(index))
                        .collect();
                    assert!(!peaks.is_empty());
                    assert_eq!(first_mixed_ns, Some(u128::from(origin_ns)));
                    eprintln!(
                        "MIXER_GATE_PROBE {}",
                        serde_json::json!({
                            "backlog": backlog,
                            "origin_ns": origin_ns,
                            "gate_ns": gate_ns,
                            "first_mixed_ns": first_mixed_ns,
                            "trim_point_samples": trim_point,
                            "first_admitted_ns": first_admitted_ns,
                            "first_committed_capture_ns": captured.first_capture.unwrap().duration_since(timestamps).as_nanos(),
                            "first_committed_timeline_ns": captured.first_timeline.unwrap().as_nanos(),
                            "peaks": peaks,
                            "total_samples": captured.pcm.len(),
                            "silence_inserted_ns": gap_tracker.total_silence_inserted.as_nanos(),
                            "overlap_dropped_frames": gap_tracker.overlap_dropped_frames,
                            "overlap_trimmed_ns": gap_tracker.total_overlap_trimmed.as_nanos(),
                        })
                    );
                }
            }
        }
    }
}
