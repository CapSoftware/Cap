use super::*;
use crate::{
    feeds::microphone::synthetic::SyntheticMicrophone,
    output_pipeline::{AudioMuxer, Muxer, OutputPipeline, TaskPool},
};
use std::ops::Deref;

struct CaptureMuxer {
    info: AudioInfo,
    frames: flume::Sender<(AudioInfo, AudioFrame)>,
}

impl Muxer for CaptureMuxer {
    type Config = flume::Sender<(AudioInfo, AudioFrame)>;

    async fn setup(
        frames: Self::Config,
        _: std::path::PathBuf,
        _: Option<VideoInfo>,
        audio: Option<AudioInfo>,
        _: Arc<AtomicBool>,
        _: &mut TaskPool,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            info: audio.expect("audio source configured"),
            frames,
        })
    }

    fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
        Ok(Ok(()))
    }
}

impl AudioMuxer for CaptureMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, _: Duration) -> anyhow::Result<()> {
        self.frames.send((self.info, frame))?;
        Ok(())
    }
}

#[tokio::test]
async fn linux_system_audio_preserves_stereo_channels() {
    for rate in [44_100, 48_000, 96_000] {
        let input = SyntheticMicrophone::spawn("stereo-monitor", rate, 2);
        let lock = input.lock().await.unwrap();
        let actor = lock.deref().clone();
        let config = SystemAudioSourceConfig {
            feed_lock: Arc::new(lock),
            device_name: "stereo-monitor".into(),
            monitor_route: None,
            feed: OwnedSystemAudioFeed {
                actor,
                build_scope: None,
                stopped: false,
            },
        };
        let (frames, received) = flume::unbounded();
        let temp = tempfile::tempdir().unwrap();
        let pipeline = OutputPipeline::builder(temp.path().join("system.ogg"))
            .with_audio_source::<SystemAudioSource>(config)
            .build::<CaptureMuxer>(frames)
            .await
            .unwrap();
        let samples: Vec<f32> = (0..rate / 100).flat_map(|_| [0.25, -0.25]).collect();
        input
            .push(&samples, Timestamp::Instant(Instant::now()))
            .await;
        let (info, frame) = tokio::time::timeout(Duration::from_secs(2), received.recv_async())
            .await
            .expect("system audio reached the muxer")
            .unwrap();
        pipeline.stop().await.unwrap();

        assert_eq!(info.channels, 2, "system audio at {rate} Hz became mono");
        assert_eq!(info.sample_rate, 48_000);
        assert_eq!(frame.inner.channels(), 2);
        assert!(frame.inner.samples() > 100);
        let samples = frame.inner.samples();
        let bytes = &frame.inner.data(0)[..samples * 2 * size_of::<f32>()];
        for pair in bytes.chunks_exact(2 * size_of::<f32>()).skip(32) {
            let left = f32::from_ne_bytes(pair[..4].try_into().unwrap());
            let right = f32::from_ne_bytes(pair[4..].try_into().unwrap());
            assert!((left - 0.25).abs() < 0.001, "left channel: {left}");
            assert!((right + 0.25).abs() < 0.001, "right channel: {right}");
        }
    }
}
