from pathlib import Path

path = Path("crates/recording/src/sources/audio_mixer.rs")
source = path.read_text()
needle = "    #[tokio::test]\n    async fn mix_sources()"
probe = '''    #[test]
    #[ignore]
    fn mixer_cpu_long_two_input_mix() {
        use std::hint::black_box;
        let timestamps = Timestamps::now();
        let mut builder = AudioMixer::builder().with_timestamps(timestamps);
        let mut inputs = Vec::new();
        for _ in 0..2 {
            let (sender, receiver) = mpsc::channel(4);
            builder.add_source(AudioMixer::INFO, receiver);
            inputs.push(sender);
        }
        let (sender, mut receiver) = mpsc::channel(16);
        let mut mixer = builder.build(sender).unwrap();
        let mut samples = 0_u64;
        let mut checksum = 0_f64;
        let pcm = vec![0.25_f32; 960 * 2];
        let bytes: Vec<u8> = pcm.iter().flat_map(|sample| sample.to_le_bytes()).collect();
        for chunk in 0..300_000_u64 {
            let timestamp = Timestamp::Instant(timestamps.instant() + Duration::from_millis(chunk * 20));
            for input in &mut inputs {
                input.try_send(AudioFrame::new(AudioMixer::INFO.wrap_frame(black_box(&bytes)), timestamp)).unwrap();
            }
            assert!(mixer.tick(timestamps, timestamp).unwrap());
            while let Ok(Some(frame)) = receiver.try_next() {
                samples += frame.inner.samples() as u64;
                checksum += f64::from(f32::from_le_bytes(frame.inner.data(0)[..4].try_into().unwrap()));
                black_box(&frame);
            }
        }
        assert!(samples > 0);
        assert!(checksum > 0.0);
        eprintln!("MIXER_CPU samples={samples} checksum={checksum}");
    }

'''
assert source.count(needle) == 1
path.write_text(source.replace(needle, probe + needle))
