import os
from pathlib import Path
root = Path(os.environ["RUNNER_TEMP"]) / "mixer-pause"
method = '            async fn process_mixed_pause_probe(&mut self, frame: AudioFrame, wall: Duration) -> AudioFrameOutcome {\n                process_audio_frame(\n                    AudioFrameProcessContext {\n                        audio_info: &self.info,\n                        sample_rate: self.info.sample_rate,\n                        master_clock: &self.master_clock,\n                        muxer: &self.muxer,\n                        health_tx: &self.health_tx,\n                        shared_pause: &self.shared_pause,\n                        video_start_gate: None,\n                        start_gate: &self.start_gate,\n                        allow_audio_degradation: true,\n                        origin: FrameProcessOrigin::Live,\n                        observed_at: self.timestamps.instant() + wall,\n                        timestamps: self.timestamps,\n                        anchor: self.anchor,\n                    },\n                    AudioFrameProcessState {\n                        timestamp_generator: &mut self.timestamp_generator,\n                        gap_tracker: &mut self.gap_tracker,\n                        gate_applied: &mut self.gate_applied,\n                        held_before_start: &mut self.held_before_start,\n                        start_admitted: &mut self.start_admitted,\n                        first_tx: &mut self.first_tx,\n                        frame_count: &mut self.frame_count,\n                        dropped_during_pause: &mut self.dropped_during_pause,\n                    },\n                    frame,\n                ).await.unwrap()\n            }\n\n'
test = '        #[tokio::test]\n        async fn mixer_pause_keeps_pre_pause_capture() {\n            let mut harness = AudioTimelineHarness::new();\n            harness.info = AudioMixer::INFO;\n            let mut builder = AudioMixer::builder()\n                .with_timestamps(harness.timestamps)\n                .with_master_clock(harness.master_clock.clone());\n            let (system, system_rx) = mpsc::channel(8);\n            let (mut mic, mic_rx) = mpsc::channel(8);\n            builder.add_source(AudioMixer::INFO, system_rx);\n            builder.add_source(AudioMixer::INFO, mic_rx);\n            let (output, mut received) = mpsc::channel(32);\n            let mut mixer = builder.build(output).unwrap();\n            let mut bytes = vec![0; 4_800 * 8];\n            bytes[960 * 8 + 4..960 * 8 + 8].copy_from_slice(&0.5_f32.to_le_bytes());\n            mic.try_send(AudioFrame::new(\n                AudioMixer::INFO.wrap_frame(&bytes),\n                Timestamp::Instant(harness.timestamps.instant()),\n            )).unwrap();\n            let mut retained = 0;\n            for (millis, paused) in [(100, false), (1_000, true)] {\n                harness.shared_pause.flag.store(paused, Ordering::Release);\n                assert!(mixer.tick_for_pause_probe(\n                    harness.timestamps,\n                    Timestamp::Instant(harness.timestamps.instant() + Duration::from_millis(millis)),\n                ).unwrap());\n                while let Ok(Some(frame)) = received.try_next() {\n                    let has_impulse = frame.inner.data(0)[..frame.inner.samples() * 8]\n                        .chunks_exact(4)\n                        .any(|sample| f32::from_le_bytes(sample.try_into().unwrap()).abs() > 0.01);\n                    let outcome = harness.process_mixed_pause_probe(frame, Duration::from_millis(millis)).await;\n                    if has_impulse && matches!(outcome, AudioFrameOutcome::Sent) {\n                        retained += 1;\n                    }\n                }\n            }\n            drop(system);\n            drop(mic);\n            eprintln!("PAUSE retained_impulses={retained} committed_samples={} dropped_during_pause={}", harness.timestamp_generator.total_samples, harness.dropped_during_pause);\n            assert_eq!(retained, 1);\n        }\n\n'
wrapper = '#[cfg(test)]\nimpl AudioMixer {\n    pub(crate) fn tick_for_pause_probe(&mut self, start: Timestamps, now: Timestamp) -> anyhow::Result<bool> {\n        self.tick(start, now)\n    }\n}\n\n'
for arm in ["main", "candidate"]:
    core = (root / f"{arm}-core.rs").read_text()
    needle = "            fn committed_audio(&mut self) -> Duration {"
    assert core.count(needle) == 1
    capture_timed = "    capture_time_pause: bool," in core
    arm_method = method
    arm_test = test
    if capture_timed:
        arm_method = method.replace(
            "                        shared_pause: &self.shared_pause,",
            "                        shared_pause: &self.shared_pause,\n                        capture_time_pause: true,",
        )
        arm_test = test.replace(
            "                harness.shared_pause.flag.store(paused, Ordering::Release);",
            "                harness.shared_pause.set_paused_at(paused, harness.timestamps.instant() + Duration::from_millis(100));",
        )
    core = core.replace(needle, arm_method + needle)
    needle = '        #[tokio::test(flavor = "current_thread")]\n        async fn primed_track_holds_audio_until_the_start_gate_arms()'
    assert core.count(needle) == 1
    core = core.replace(needle, arm_test + needle)
    (root / f"{arm}-core.rs").write_text(core)
    mixer = root / f"{arm}-mixer.rs"
    mixer.write_text(mixer.read_text() + "\n" + wrapper)
