use super::*;
use crate::{
    feeds::microphone::synthetic::SyntheticMicrophone,
    output_pipeline::{
        AudioFrame, AudioMuxer, ChannelAudioSource, ChannelAudioSourceConfig, Muxer,
        OutputPipeline, PipelineBuildScope, TaskPool,
    },
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
            ends_take_when_lost: false,
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

#[tokio::test]
async fn terminal_system_audio_failure_ends_its_pipeline_and_leaves_the_mic() {
    let scope = PipelineBuildScope::new_studio_lifetime();
    let input = SyntheticMicrophone::spawn("speakers.monitor", 48_000, 2);
    let lock = input.lock().await.unwrap();
    let health = lock.source_health();
    let actor = lock.deref().clone();
    let (frames, received) = flume::unbounded();
    let (mic_frames, mic_received) = flume::unbounded();
    let temp = tempfile::tempdir().unwrap();
    let built = scope
        .run(async {
            let pipeline = OutputPipeline::builder(temp.path().join("system.ogg"))
                .with_audio_source::<SystemAudioSource>(SystemAudioSourceConfig {
                    feed_lock: Arc::new(lock),
                    device_name: "speakers.monitor".into(),
                    monitor_route: None,
                    feed: OwnedSystemAudioFeed {
                        actor,
                        build_scope: PipelineBuildScope::current(),
                        stopped: false,
                    },
                    ends_take_when_lost: true,
                })
                .build::<CaptureMuxer>(frames)
                .await
                .unwrap();
            let mic_info = AudioInfo::new_raw(
                cap_media_info::Sample::F32(cap_media_info::Type::Packed),
                48_000,
                1,
            );
            let (mic_tx, mic_rx) = futures::channel::mpsc::channel(4);
            let microphone = OutputPipeline::builder(temp.path().join("mic.ogg"))
                .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(
                    mic_info, mic_rx,
                ))
                .build::<CaptureMuxer>(mic_frames)
                .await
                .unwrap();
            (pipeline, microphone.cancel_token(), microphone, mic_tx)
        })
        .await;
    let (pipeline, microphone_cancel, microphone, mut mic_tx) = built;
    let _microphone = microphone;
    input
        .push(
            &[0.25, -0.25],
            cap_timestamp::Timestamp::Instant(std::time::Instant::now()),
        )
        .await;
    tokio::time::timeout(Duration::from_secs(2), received.recv_async())
        .await
        .expect("system audio reached the muxer")
        .unwrap();
    health.fail("speakers.monitor removed".into());
    tokio::time::timeout(Duration::from_secs(3), pipeline.done_fut())
        .await
        .expect("terminal system audio loss left the pipeline running")
        .expect("terminal system audio loss failed the pipeline");
    assert!(
        !microphone_cancel.is_cancelled(),
        "an active mic was cancelled with system audio"
    );
    let mic_info = AudioInfo::new_raw(
        cap_media_info::Sample::F32(cap_media_info::Type::Packed),
        48_000,
        1,
    );
    mic_tx
        .try_send(AudioFrame::new(
            mic_info.wrap_frame(&0.5f32.to_ne_bytes()),
            cap_timestamp::Timestamp::Instant(std::time::Instant::now()),
        ))
        .expect("mic sender closed after system audio ended");
    tokio::time::timeout(Duration::from_secs(2), mic_received.recv_async())
        .await
        .expect("mic audio did not reach its muxer after system audio ended")
        .unwrap();
}

#[tokio::test]
async fn transient_system_audio_failure_keeps_the_pipeline_and_later_samples() {
    let scope = PipelineBuildScope::new_studio_lifetime();
    let input = SyntheticMicrophone::spawn("speakers.monitor", 48_000, 2);
    let lock = input.lock().await.unwrap();
    let health = lock.source_health();
    let actor = lock.deref().clone();
    let (frames, received) = flume::unbounded();
    let temp = tempfile::tempdir().unwrap();
    let pipeline = scope
        .run(async {
            OutputPipeline::builder(temp.path().join("system.ogg"))
                .with_audio_source::<SystemAudioSource>(SystemAudioSourceConfig {
                    feed_lock: Arc::new(lock),
                    device_name: "speakers.monitor".into(),
                    monitor_route: None,
                    feed: OwnedSystemAudioFeed {
                        actor,
                        build_scope: PipelineBuildScope::current(),
                        stopped: false,
                    },
                    ends_take_when_lost: true,
                })
                .build::<CaptureMuxer>(frames)
                .await
                .unwrap()
        })
        .await;
    input
        .push(
            &[0.25, -0.25],
            cap_timestamp::Timestamp::Instant(std::time::Instant::now()),
        )
        .await;
    tokio::time::timeout(Duration::from_secs(2), received.recv_async())
        .await
        .expect("system audio reached the muxer")
        .unwrap();
    health.test_backend_failure();
    input
        .push(
            &[0.5, -0.5],
            cap_timestamp::Timestamp::Instant(std::time::Instant::now()),
        )
        .await;
    let still_running = tokio::time::timeout(Duration::from_millis(400), pipeline.done_fut()).await;
    assert!(
        still_running.is_err(),
        "a transient system audio error ended the pipeline"
    );
    health.test_recover_backend();
    input
        .push(
            &[0.25, -0.25],
            cap_timestamp::Timestamp::Instant(std::time::Instant::now()),
        )
        .await;
    tokio::time::timeout(Duration::from_secs(2), received.recv_async())
        .await
        .expect("system audio did not recover")
        .unwrap();
    let still_running = tokio::time::timeout(Duration::from_millis(200), pipeline.done_fut()).await;
    assert!(still_running.is_err(), "recovered system audio ended");
}
