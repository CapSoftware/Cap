use std::path::PathBuf;

#[derive(Debug)]
pub struct CleanInstantRecording {
    project_path: PathBuf,
    expected_audio: bool,
}

impl CleanInstantRecording {
    pub(super) fn new(project_path: PathBuf, expected_audio: bool) -> Self {
        Self {
            project_path,
            expected_audio,
        }
    }

    pub(crate) fn into_parts(self) -> (PathBuf, bool) {
        (self.project_path, self.expected_audio)
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Actor, ActorState, Cancel, Pause, Pipeline, Stop, current_time_f64};
    use super::CleanInstantRecording;
    use crate::{
        output_pipeline::{
            AudioFrame, AudioMuxer, ChannelAudioSource, ChannelAudioSourceConfig,
            ChannelVideoSource, ChannelVideoSourceConfig, Muxer, OutputPipeline, TaskPool,
            VideoFrame, VideoMuxer,
        },
        recovery::RecoveryManager,
        sources::screen_capture::ScreenCaptureTarget,
    };
    use cap_media_info::{AudioInfo, VideoInfo};
    use cap_timestamp::{Timestamp, Timestamps};
    use kameo::{Actor as _, prelude::ActorRef};
    use std::{
        ffi::OsString,
        fs,
        path::{Path, PathBuf},
        sync::{Arc, atomic::AtomicBool},
        time::Duration,
    };

    #[derive(Clone, Copy)]
    struct Frame(Timestamp);

    impl VideoFrame for Frame {
        fn timestamp(&self) -> Timestamp {
            self.0
        }
    }

    struct TestMuxer(bool);

    impl Muxer for TestMuxer {
        type Config = bool;

        async fn setup(
            fail: bool,
            _: PathBuf,
            _: Option<VideoInfo>,
            _: Option<AudioInfo>,
            _: Arc<AtomicBool>,
            _: &mut TaskPool,
        ) -> anyhow::Result<Self> {
            Ok(Self(fail))
        }

        fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
            Ok(if self.0 {
                Err(anyhow::anyhow!("output finalization failed"))
            } else {
                Ok(())
            })
        }
    }

    impl VideoMuxer for TestMuxer {
        type VideoFrame = Frame;

        fn send_video_frame(&mut self, _: Frame, _: Duration) -> anyhow::Result<()> {
            Ok(())
        }
    }

    impl AudioMuxer for TestMuxer {
        fn send_audio_frame(&mut self, _: AudioFrame, _: Duration) -> anyhow::Result<()> {
            Ok(())
        }
    }

    #[derive(Clone, Copy)]
    enum OutputFiles {
        Segmented,
        Progressive,
        InitOnly,
        Missing,
    }

    struct Fixture {
        actor: ActorRef<Actor>,
        video_cancel: tokio_util::sync::CancellationToken,
        video_sender: Option<flume::Sender<Frame>>,
        audio_sender: Option<futures::channel::mpsc::Sender<AudioFrame>>,
    }

    impl Fixture {
        async fn close_sources_after_stop(&mut self) {
            self.video_cancel.cancelled().await;
            drop(self.video_sender.take());
            drop(self.audio_sender.take());
        }
    }

    async fn fixture(project: &Path, output: OutputFiles, with_audio: bool, fail: bool) -> Fixture {
        #[cfg(target_os = "linux")]
        let lifetime = super::super::InstantLifetimeOwner::new();
        let timestamps = Timestamps::now();
        let video_info = VideoInfo::from_raw(cap_media_info::RawVideoFormat::Bgra, 4, 4, 30);
        let progressive = matches!(output, OutputFiles::Progressive);
        let segments_dir = project.join(if progressive {
            "content"
        } else {
            "content/display"
        });
        fs::create_dir_all(&segments_dir).unwrap();
        match output {
            OutputFiles::Segmented => {
                fs::write(segments_dir.join("init.mp4"), b"init").unwrap();
                fs::write(segments_dir.join("segment-1.m4s"), b"segment").unwrap();
            }
            OutputFiles::Progressive => {
                fs::write(segments_dir.join("output.mp4"), b"progressive").unwrap();
            }
            OutputFiles::InitOnly => {
                fs::write(segments_dir.join("init.mp4"), b"init").unwrap();
            }
            OutputFiles::Missing => {}
        }
        let (video_sender, video_receiver) = flume::bounded(4);
        let build = OutputPipeline::builder(segments_dir.clone())
            .with_video::<ChannelVideoSource<Frame>>(ChannelVideoSourceConfig::new(
                video_info,
                video_receiver,
            ))
            .with_timestamps(timestamps)
            .build::<TestMuxer>(fail);
        #[cfg(target_os = "linux")]
        let build = lifetime.lifecycle.0.scope.run(build);
        let video = build.await.unwrap();
        video_sender
            .send(Frame(Timestamp::Instant(timestamps.instant())))
            .unwrap();
        let mut audio_sender = None;
        let audio = if with_audio {
            let info = AudioInfo::new_raw(
                cap_media_info::Sample::F32(cap_media_info::Type::Packed),
                48_000,
                2,
            );
            let (mut sender, receiver) = futures::channel::mpsc::channel(4);
            let build = OutputPipeline::builder(project.join("content/audio"))
                .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(
                    info, receiver,
                ))
                .with_timestamps(timestamps)
                .build::<TestMuxer>(false);
            #[cfg(target_os = "linux")]
            let build = lifetime.lifecycle.0.scope.run(build);
            let audio = build.await.unwrap();
            sender
                .try_send(AudioFrame::new(
                    info.empty_frame(960),
                    Timestamp::Instant(timestamps.instant()),
                ))
                .unwrap();
            audio_sender = Some(sender);
            Some(audio)
        } else {
            None
        };
        let video_cancel = video.cancel_token();
        let actor = Actor::spawn(Actor {
            recording_dir: project.to_path_buf(),
            output_dir: segments_dir.clone(),
            capture_target: if progressive {
                ScreenCaptureTarget::CameraOnly
            } else {
                ScreenCaptureTarget::Display {
                    id: "0".parse().unwrap(),
                }
            },
            video_info,
            state: ActorState::Recording {
                pipeline: Pipeline {
                    video,
                    audio,
                    video_info,
                    segments_dir,
                    segment_rx: None,
                },
                segment_start_time: current_time_f64(),
            },
            total_pause_duration: Duration::ZERO,
            pause_started_at: None,
            terminal_stop_error: None,
            #[cfg(target_os = "linux")]
            lifetime,
        });
        Fixture {
            actor,
            video_cancel,
            video_sender: Some(video_sender),
            audio_sender,
        }
    }

    async fn stop(fixture: &mut Fixture) -> anyhow::Result<super::super::CompletedRecording> {
        let actor = fixture.actor.clone();
        tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(actor.ask(Stop), fixture.close_sources_after_stop()).0
        })
        .await
        .unwrap()
        .map_err(anyhow::Error::from)
    }

    async fn finish(fixture: Fixture) {
        fixture.actor.kill();
        tokio::time::timeout(Duration::from_secs(2), fixture.actor.wait_for_stop())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn live_and_paused_segmented_outputs_issue_one_matching_completion() {
        for (paused, with_audio) in [(false, false), (false, true), (true, false), (true, true)] {
            let directory = tempfile::tempdir().unwrap();
            let mut fixture =
                fixture(directory.path(), OutputFiles::Segmented, with_audio, false).await;
            if paused {
                fixture.actor.ask(Pause).await.unwrap();
            }
            let mut completed = stop(&mut fixture).await.unwrap();
            let token = completed.clean_completion.take().unwrap();
            assert_eq!(
                token.into_parts(),
                (directory.path().to_path_buf(), with_audio)
            );
            assert!(stop(&mut fixture).await.unwrap().clean_completion.is_none());
            finish(fixture).await;
        }
    }

    #[tokio::test]
    async fn cancelled_output_does_not_issue_completion() {
        let directory = tempfile::tempdir().unwrap();
        let mut fixture = fixture(directory.path(), OutputFiles::Segmented, true, false).await;
        let actor = fixture.actor.clone();
        tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(actor.ask(Cancel), fixture.close_sources_after_stop()).0
        })
        .await
        .unwrap()
        .unwrap();
        assert!(stop(&mut fixture).await.unwrap().clean_completion.is_none());
        finish(fixture).await;
    }

    #[tokio::test]
    async fn progressive_and_incomplete_outputs_do_not_issue_completion() {
        for output in [
            OutputFiles::Progressive,
            OutputFiles::InitOnly,
            OutputFiles::Missing,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let mut fixture = fixture(directory.path(), output, false, false).await;
            assert!(stop(&mut fixture).await.unwrap().clean_completion.is_none());
            finish(fixture).await;
        }
    }

    #[tokio::test]
    async fn failed_finalization_never_issues_completion() {
        let directory = tempfile::tempdir().unwrap();
        let mut fixture = fixture(directory.path(), OutputFiles::Segmented, true, true).await;
        for _ in 0..2 {
            assert!(
                stop(&mut fixture)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("output finalization failed")
            );
        }
        finish(fixture).await;
    }

    fn entries(path: &Path) -> Vec<OsString> {
        let mut entries = fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        entries.sort();
        entries
    }

    #[test]
    fn completion_for_another_project_does_not_touch_either_project() {
        let directory = tempfile::tempdir().unwrap();
        let recorded = directory.path().join("recorded.cap");
        let other = directory.path().join("other.cap");
        for project in [&recorded, &other] {
            fs::create_dir_all(project.join("content")).unwrap();
            fs::write(project.join("content/original.m4s"), b"original bytes").unwrap();
        }
        let completion = CleanInstantRecording::new(recorded.clone(), true);
        let result = RecoveryManager::finalize_completed_instant_output(
            &other.join("content/display"),
            &other.join("content/audio"),
            &other.join("content/output.mp4"),
            completion,
        );
        assert!(result.is_err());
        for project in [&recorded, &other] {
            assert_eq!(entries(project), vec![OsString::from("content")]);
            assert_eq!(
                entries(&project.join("content")),
                vec![OsString::from("original.m4s")]
            );
            assert_eq!(
                fs::read(project.join("content/original.m4s")).unwrap(),
                b"original bytes"
            );
        }
    }
}
