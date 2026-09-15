use super::*;
use cap_enc_ffmpeg::{
    RelocatableSource,
    h264::DEFAULT_KEYFRAME_INTERVAL_SECS,
    segmented_stream::{SegmentedVideoEncoder, SegmentedVideoEncoderConfig},
};
use cap_project::{ClipConfiguration, ClipOffsets, CursorMeta, TimelineConfiguration};
use cap_rendering::{
    ManagedVideoTrackInput, RecordingSegmentDecoders, RenderedFrame, SegmentVideoPaths,
};
use std::{
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

struct SourceLease {
    location: Arc<Mutex<PathBuf>>,
    after_close: PathBuf,
    released: Arc<AtomicBool>,
    rename_succeeded: Arc<AtomicBool>,
}

impl Drop for SourceLease {
    fn drop(&mut self) {
        let location = self.location.lock().unwrap();
        self.rename_succeeded.store(
            std::fs::rename(location.as_path(), &self.after_close).is_ok(),
            Ordering::Release,
        );
        self.released.store(true, Ordering::Release);
    }
}

struct Fixture {
    directory: tempfile::TempDir,
    source: RelocatableSource,
    location: Arc<Mutex<PathBuf>>,
    released: Arc<AtomicBool>,
    rename_succeeded: Arc<AtomicBool>,
    metadata: RecordingMeta,
    reference_metadata: RecordingMeta,
    display: Vec<PathBuf>,
    camera: Vec<PathBuf>,
    project: ProjectConfiguration,
    cursor: Arc<CursorEvents>,
    assets: FrozenRecordedCursorAssets,
}

fn encode_track(
    root: &Path,
    track: &str,
    width: u32,
    height: u32,
    fps: u32,
    mut noise: u32,
) -> Vec<PathBuf> {
    let directory = root.join(track);
    let mut encoder = SegmentedVideoEncoder::init(
        directory.clone(),
        cap_media_info::VideoInfo {
            pixel_format: cap_media_info::Pixel::NV12,
            width,
            height,
            time_base: ffmpeg::Rational(1, 1_000_000),
            frame_rate: ffmpeg::Rational(fps as i32, 1),
        },
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_secs(1),
            bpp: 4.0,
            ..Default::default()
        },
    )
    .unwrap();
    let frame_count = u64::from(fps) * u64::from(DEFAULT_KEYFRAME_INTERVAL_SECS) * 3;
    for index in 0..frame_count {
        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, width, height);
        for byte in frame.data_mut(0) {
            noise ^= noise << 13;
            noise ^= noise >> 17;
            noise ^= noise << 5;
            *byte = (noise % 220 + 16) as u8;
        }
        frame.data_mut(1).fill(128);
        encoder
            .queue_frame(
                frame,
                Duration::from_micros(index * 1_000_000 / u64::from(fps)),
            )
            .unwrap();
    }
    encoder.finish().unwrap();
    let mut paths = std::fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "m4s"))
        .map(|path| PathBuf::from(track).join(path.file_name().unwrap()))
        .collect::<Vec<_>>();
    paths.sort();
    assert!(paths.len() >= 3);
    paths.insert(0, PathBuf::from(track).join("init.mp4"));
    paths
}

fn finalize_track(root: &Path, paths: &[PathBuf], output: &Path) {
    cap_enc_ffmpeg::remux::concatenate_m4s_segments_with_init(
        &root.join(&paths[0]),
        &paths[1..]
            .iter()
            .map(|path| root.join(path))
            .collect::<Vec<_>>(),
        output,
    )
    .unwrap();
    assert!(cap_enc_ffmpeg::remux::probe_video_can_decode(output).unwrap());
}

fn fixture(svg: bool) -> Fixture {
    ffmpeg::init().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let original = directory.path().join("original");
    let reference = directory.path().join("reference");
    std::fs::create_dir(&original).unwrap();
    std::fs::create_dir(&reference).unwrap();
    let display = encode_track(&original, "display", 160, 120, 30, 123456789);
    let camera = encode_track(&original, "camera", 80, 80, 24, 987654321);
    finalize_track(&original, &display, &reference.join("display.mp4"));
    finalize_track(&original, &camera, &reference.join("camera.mp4"));
    let mut image = image::RgbaImage::new(16, 24);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        *pixel = image::Rgba([255, (x * 13) as u8, (y * 9) as u8, 220]);
    }
    let mut png = Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png).unwrap();
    let bytes: Arc<[u8]> = png.into_inner().into();
    std::fs::write(reference.join("cursor.png"), &bytes).unwrap();
    let cursor_meta: CursorMeta = serde_json::from_value(serde_json::json!({
        "imagePath": "cursor.png",
        "hotspot": {"x": 0.25, "y": 0.125},
        "shape": svg.then_some("MacOS|Arrow")
    }))
    .unwrap();
    let mut metadata: RecordingMeta = serde_json::from_value(serde_json::json!({
        "platform": "MacOS", "pretty_name": "Preparing preview native test", "sharing": null,
        "segments": [{
            "display": {"path": "display", "fps": 30, "start_time": 0.0},
            "camera": {"path": "camera", "fps": 24, "start_time": 0.125},
            "mic": {"path": "mic.aac", "start_time": 0.25}
        }],
        "cursors": {"arrow": cursor_meta},
        "status": {"status": "NeedsRemux"}
    }))
    .unwrap();
    metadata.project_path = original.clone();
    let mut reference_metadata = metadata.clone();
    reference_metadata.project_path = reference;
    let cap_project::RecordingMetaInner::Studio(studio) = &mut reference_metadata.inner else {
        panic!("Studio metadata expected");
    };
    let cap_project::StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
        panic!("Indexed metadata expected");
    };
    inner.segments[0].display.path = "display.mp4".into();
    inner.segments[0].camera.as_mut().unwrap().path = "camera.mp4".into();
    inner.status = Some(cap_project::StudioRecordingStatus::Complete);
    let mut project = ProjectConfiguration {
        timeline: Some(
            serde_json::from_value::<TimelineConfiguration>(serde_json::json!({
                "segments": [{"recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 3.25}],
                "zoomSegments": [{"start": 0.3, "end": 2.7, "amount": 1.6, "mode": "auto"}]
            }))
            .unwrap(),
        ),
        clips: vec![ClipConfiguration {
            index: 0,
            offsets: ClipOffsets {
                camera: 0.25,
                mic: 0.03125,
                system_audio: 0.0,
            },
            offsets_auto_calculated: true,
        }],
        ..Default::default()
    };
    project.cursor.use_svg = svg;
    project.cursor.hide_when_idle = false;
    project.cursor.size = 150;
    project.cursor.motion_blur = 0.0;
    project.background.padding = 8.0;
    project.background.shadow = 0.0;
    project.camera.hide = false;
    project.camera.size = 30.0;
    project.camera.shadow = 0.0;
    let cursor = Arc::new(CursorEvents {
        moves: [
            (0.0, 0.1, 0.15),
            (300.0, 0.2, 0.3),
            (600.0, 0.7, 0.25),
            (1100.0, 0.8, 0.7),
            (1800.0, 0.4, 0.6),
            (2600.0, 0.2, 0.3),
            (3500.0, 0.8, 0.8),
        ]
        .into_iter()
        .map(|(time_ms, x, y)| cap_project::CursorMoveEvent {
            active_modifiers: Vec::new(),
            cursor_id: "arrow".into(),
            time_ms,
            x,
            y,
        })
        .collect(),
        clicks: Vec::new(),
    });
    let assets = FrozenRecordedCursorAssets::new([("arrow".into(), cursor_meta, bytes)]).unwrap();
    let location = Arc::new(Mutex::new(original.clone()));
    let released = Arc::new(AtomicBool::new(false));
    let rename_succeeded = Arc::new(AtomicBool::new(false));
    let source = RelocatableSource::new_with_owner(
        original,
        Arc::new(SourceLease {
            location: location.clone(),
            after_close: directory.path().join("released-after-native-join"),
            released: released.clone(),
            rename_succeeded: rename_succeeded.clone(),
        }),
    )
    .unwrap();
    Fixture {
        directory,
        source,
        location,
        released,
        rename_succeeded,
        metadata,
        reference_metadata,
        display,
        camera,
        project,
        cursor,
        assets,
    }
}

impl Fixture {
    fn input(&self) -> PreparingPreviewInput {
        let metadata = self.metadata.studio_meta().unwrap();
        PreparingPreviewInput {
            recording_meta: self.metadata.clone(),
            project: self.project.clone(),
            segments: (0..self.project.clips.len())
                .map(|index| PreparingPreviewSegment {
                    video: ManagedSegmentVideoInput::new(
                        index,
                        metadata,
                        ManagedVideoTrackInput::new(self.source.clone(), self.display.clone())
                            .unwrap(),
                        Some(
                            ManagedVideoTrackInput::new(self.source.clone(), self.camera.clone())
                                .unwrap(),
                        ),
                    )
                    .unwrap(),
                    cursor: self.cursor.clone(),
                })
                .collect(),
            cursor_assets: self.assets.clone(),
        }
    }

    fn relocate(&self, name: &str) {
        let destination = self.directory.path().join(name);
        self.source.relocate(destination.clone()).unwrap();
        *self.location.lock().unwrap() = destination;
    }
}

fn visible_rgba(frame: &RenderedFrame) -> Vec<u8> {
    let row_bytes = (frame.width as usize).checked_mul(4).unwrap();
    let stride = frame.padded_bytes_per_row as usize;
    let rows = frame.height as usize;
    assert!(row_bytes > 0 && rows > 0);
    assert!(stride >= row_bytes);
    assert_eq!(frame.data.len(), stride.checked_mul(rows).unwrap());
    frame
        .data
        .chunks_exact(frame.padded_bytes_per_row as usize)
        .take(frame.height as usize)
        .flat_map(|row| row[..frame.width as usize * 4].iter().copied())
        .collect()
}

async fn ordinary_composed_frames(
    fixture: &Fixture,
    frame_numbers: &[u32],
    force_ffmpeg: bool,
) -> Vec<(RenderedFrame, FrameLayout)> {
    let metadata = &fixture.reference_metadata;
    let studio = metadata.studio_meta().unwrap();
    let mut decoders = Vec::new();
    for index in 0..fixture.project.clips.len() {
        decoders.push(
            RecordingSegmentDecoders::new(
                metadata,
                studio,
                SegmentVideoPaths {
                    display: metadata.project_path.join("display.mp4"),
                    camera: Some(metadata.project_path.join("camera.mp4")),
                },
                index,
                force_ffmpeg,
            )
            .await
            .unwrap(),
        );
    }
    #[cfg(target_os = "macos")]
    if !force_ffmpeg {
        for decoder in &decoders {
            assert_eq!(
                decoder.screen_decoder_status().decoder_type,
                cap_rendering::decoder::DecoderType::AVAssetReader,
            );
            assert_eq!(
                decoder.camera_decoder_status().unwrap().decoder_type,
                cap_rendering::decoder::DecoderType::AVAssetReader,
            );
        }
    }
    let duration = fixture.project.timeline.as_ref().unwrap().duration();
    let constants = RenderVideoConstants::new_with_options(
        RenderOptions {
            screen_size: XY::new(160, 120),
            camera_size: Some(XY::new(80, 80)),
            preserve_screen_alpha: false,
        },
        metadata.clone(),
        studio.clone(),
    )
    .await
    .unwrap();
    let mut layers = RendererLayers::new_with_options(
        &constants.device,
        &constants.queue,
        constants.is_software_adapter,
    );
    layers.preload_cursor_assets(
        &constants,
        fixture.project.cursor.use_svg,
        fixture.project.cursor.cursor_type(),
    );
    let mut renderer = FrameRenderer::new(&constants);
    let mut cache = PreviewCursorCache::default();
    let mut result = Vec::new();
    let mut cursor_positions = Vec::new();
    let mut zoom_amounts = Vec::new();
    for &frame_number in frame_numbers {
        let time = f64::from(frame_number) / 30.0;
        let (segment_time, segment) = fixture.project.get_segment_time(time).unwrap();
        let frames = decoders[segment.recording_clip as usize]
            .get_frames_initial(
                segment_time as f32,
                true,
                true,
                fixture.project.clips[segment.recording_clip as usize].offsets,
            )
            .await
            .unwrap();
        let timeline = cache.get(segment.recording_clip, &fixture.cursor, &fixture.project);
        let mut zoom = ZoomTransformTimeline::from_project_for_clip(
            &fixture.project,
            &fixture.cursor,
            duration,
            constants.options.screen_size,
            segment.recording_clip,
        );
        zoom.ensure_precomputed_until((frame_number as f32 + 1.0) / 30.0);
        let uniforms = match timeline {
            Some(timeline) => ProjectUniforms::new_with_precomputed_cursor(
                &constants,
                &fixture.project,
                frame_number,
                30,
                XY::new(320, 240),
                &fixture.cursor,
                &frames,
                duration,
                &zoom,
                &timeline,
            ),
            None => ProjectUniforms::new(
                &constants,
                &fixture.project,
                frame_number,
                30,
                XY::new(320, 240),
                &fixture.cursor,
                &frames,
                duration,
                &zoom,
            ),
        };
        zoom_amounts.push(uniforms.zoom.display_amount());
        cursor_positions.push(
            uniforms
                .prev_cursor
                .as_ref()
                .expect("The recorded cursor must have a preceding sample")
                .position
                .coord,
        );
        let layout = uniforms.frame_layout();
        assert!(layout.camera.is_some());
        result.push((
            renderer
                .render_immediate(frames, uniforms, &fixture.cursor, true, &mut layers)
                .await
                .unwrap(),
            layout,
        ));
    }
    assert!(cursor_positions.windows(2).any(|pair| pair[0] != pair[1]));
    assert!(
        zoom_amounts
            .iter()
            .any(|amount| (amount - 1.0).abs() > 0.01)
    );
    drop(decoders);
    result
}

async fn composed_parity(fixture: Fixture, frames: &[u32]) {
    composed_parity_with_reference(fixture, frames, true, EditorFrameFormat::Rgba).await;
}

#[tokio::test]
async fn native_preparing_playback_seeks_match_ordinary_and_handoff_joins_sources() {
    let mut fixture = fixture(false);
    for metadata in [&mut fixture.metadata, &mut fixture.reference_metadata] {
        let cap_project::RecordingMetaInner::Studio(studio) = &mut metadata.inner else {
            panic!("Studio metadata expected");
        };
        let cap_project::StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
            panic!("Indexed metadata expected");
        };
        inner.segments[0].mic = None;
    }
    let expected = ordinary_composed_frames(&fixture, &[0, 45], true).await;
    let (frames, mut received) = tokio::sync::mpsc::unbounded_channel();
    let session = crate::PreparingPlaybackSession::spawn(
        fixture.input(),
        vec![crate::PreparingAudioSegmentInput {
            mic: None,
            system_audio: None,
            timing_repair: Default::default(),
        }],
        crate::PreparingPlaybackOptions {
            preview: PreparingPreviewOptions::default(),
            fps: 30,
            resolution: XY::new(320, 240),
        },
        Arc::new(crate::AudioOutput::new_headless(Box::new(|_, _| {}))),
        Box::new(move |request, output, layout| {
            let EditorFrameOutput::Rgba(frame) = output else {
                panic!("Expected RGBA frame");
            };
            let _ = frames.send((request, frame, layout));
        }),
    )
    .unwrap();
    let controller = session.controller();
    let stop = session.stop_handle();
    let mut updates = session.updates();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if updates.borrow_and_update().progress.preview_available {
                break;
            }
            updates.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(updates.borrow().progress.playable_until, 3.25);
    for (index, (expected, expected_layout)) in expected.into_iter().enumerate() {
        if index == 1 {
            fixture.relocate("retained-during-playback");
            tokio::time::timeout(Duration::from_secs(15), controller.seek(1.5))
                .await
                .unwrap()
                .unwrap();
        }
        let (request, actual, layout) =
            tokio::time::timeout(Duration::from_secs(15), received.recv())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(request.frame_number, if index == 0 { 0 } else { 45 });
        assert_eq!(layout, expected_layout);
        assert_eq!(visible_rgba(&actual), visible_rgba(&expected));
    }
    let seeks = [0.3, 1.0, 2.0, 1.1, 1.5].map(|time| controller.seek(time));
    let results = tokio::time::timeout(Duration::from_secs(15), futures::future::join_all(seeks))
        .await
        .unwrap();
    assert!(results.last().unwrap().is_ok());
    let mut last_seek_frame = None;
    while let Ok((request, _, _)) = received.try_recv() {
        last_seek_frame = Some(request.frame_number);
    }
    assert_eq!(last_seek_frame, Some(45));
    controller.set_playing(true).await.unwrap();
    let (request, _, _) = tokio::time::timeout(Duration::from_secs(15), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(request.frame_number >= 45);
    controller.set_playing(false).await.unwrap();
    let paused = updates.borrow().clone();
    assert!(!paused.playback.playing);
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(
        updates.borrow().playback.playhead_seconds,
        paused.playback.playhead_seconds
    );
    controller.set_playing(true).await.unwrap();
    drop(fixture.source);
    let exit = tokio::time::timeout(Duration::from_secs(15), stop.stop_and_wait())
        .await
        .unwrap();
    assert!(exit.error.is_none(), "{:?}", exit.error);
    assert_eq!(
        exit.snapshot.progress.phase,
        crate::PreparingEditorPhase::Handoff
    );
    assert!(exit.snapshot.playback.playing);
    assert!(exit.snapshot.playback.playhead_seconds >= 1.5);
    assert!(exit.snapshot.playback.playhead_seconds < 3.25);
    let preview = exit.preview.unwrap();
    assert_eq!(preview.reason, PreparingPreviewError::Cancelled);
    assert_eq!(preview.workers.len(), 1);
    assert!(fixture.released.load(Ordering::Acquire));
    assert!(fixture.rename_succeeded.load(Ordering::Acquire));
}

#[tokio::test]
async fn native_preparing_image_does_not_enable_playback_with_unavailable_declared_audio() {
    let fixture = fixture(false);
    let session = crate::PreparingPlaybackSession::spawn(
        fixture.input(),
        vec![crate::PreparingAudioSegmentInput {
            mic: None,
            system_audio: None,
            timing_repair: Default::default(),
        }],
        crate::PreparingPlaybackOptions {
            preview: PreparingPreviewOptions::default(),
            fps: 30,
            resolution: XY::new(320, 240),
        },
        Arc::new(crate::AudioOutput::new_headless(Box::new(|_, _| {}))),
        Box::new(|_, _, _| {}),
    )
    .unwrap();
    let mut updates = session.updates();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if updates.borrow_and_update().progress.preview_available {
                break;
            }
            updates.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(updates.borrow().progress.playable_until, 0.0);
    assert!(session.controller().seek(0.0).await.is_err());
    assert!(session.controller().set_playing(true).await.is_err());
    let stop = session.stop_handle();
    drop(fixture.source);
    drop(session);
    let exit = tokio::time::timeout(Duration::from_secs(15), stop.stop_and_wait())
        .await
        .unwrap();
    assert!(exit.error.is_none(), "{:?}", exit.error);
    assert!(!exit.snapshot.playback.playing);
    assert!(fixture.released.load(Ordering::Acquire));
    assert!(fixture.rename_succeeded.load(Ordering::Acquire));
}

#[tokio::test]
async fn native_preparing_playback_audio_matches_completed_pcm_and_releases_its_source() {
    use cap_audio::AudioSampleSource;
    use std::io::Write;
    use std::sync::atomic::AtomicUsize;

    let mut fixture = fixture(false);
    let expected_metadata = fixture.metadata.clone();
    let cap_project::RecordingMetaInner::Studio(studio) = &mut fixture.metadata.inner else {
        panic!("Studio metadata expected");
    };
    let cap_project::StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
        panic!("Indexed metadata expected");
    };
    inner.segments[0].mic.as_mut().unwrap().gap_summary = Some(cap_project::AudioGapSummary {
        total_overlap_trimmed_ms: 0,
        startup_overlap_trimmed_ms: 0,
        overlap_dropped_frames: 0,
        startup_overlap_drops: 0,
    });
    let path = fixture.metadata.project_path.join("mic.aac");
    let sample_count = 4 * 48_000_u32;
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(b"RIFF").unwrap();
    file.write_all(&(sample_count * 2 + 36).to_le_bytes())
        .unwrap();
    file.write_all(b"WAVEfmt ").unwrap();
    file.write_all(&16_u32.to_le_bytes()).unwrap();
    file.write_all(&1_u16.to_le_bytes()).unwrap();
    file.write_all(&1_u16.to_le_bytes()).unwrap();
    file.write_all(&48_000_u32.to_le_bytes()).unwrap();
    file.write_all(&96_000_u32.to_le_bytes()).unwrap();
    file.write_all(&2_u16.to_le_bytes()).unwrap();
    file.write_all(&16_u16.to_le_bytes()).unwrap();
    file.write_all(b"data").unwrap();
    file.write_all(&(sample_count * 2).to_le_bytes()).unwrap();
    for sample in 0..sample_count {
        let value = ((sample % 10_000) as i16 + 1_000).to_le_bytes();
        file.write_all(&value).unwrap();
    }
    drop(file);
    let expected = cap_audio::AudioData::from_file(&path).unwrap();
    let nonzero = Arc::new(AtomicUsize::new(0));
    let tapped = nonzero.clone();
    let output = Arc::new(crate::AudioOutput::new_headless(Box::new(
        move |samples, _| {
            tapped.fetch_add(
                samples.iter().filter(|sample| **sample != 0.0).count(),
                Ordering::Relaxed,
            );
        },
    )));
    let session = crate::PreparingPlaybackSession::spawn_with_expected_metadata(
        fixture.input(),
        vec![crate::PreparingAudioSegmentInput {
            mic: Some(
                cap_audio::ManagedAudioInput::new(fixture.source.clone(), PathBuf::from("mic.aac"))
                    .unwrap(),
            ),
            system_audio: None,
            timing_repair: Default::default(),
        }],
        crate::PreparingPlaybackOptions {
            preview: PreparingPreviewOptions::default(),
            fps: 30,
            resolution: XY::new(320, 240),
        },
        output,
        Box::new(|_, _, _| {}),
        expected_metadata.clone(),
    )
    .unwrap();
    let mut updates = session.updates();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let ready = {
                let state = updates.borrow_and_update();
                state.progress.preview_available && state.progress.playable_until == 3.25
            };
            if ready {
                break;
            }
            updates.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    session.controller().seek(1.5).await.unwrap();
    session.controller().set_playing(true).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if updates.borrow_and_update().playback.playhead_seconds > 1.6 {
                break;
            }
            updates.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(nonzero.load(Ordering::Relaxed) > 0);
    let stop = session.stop_handle();
    let metadata = expected_metadata;
    drop(fixture.source);
    let exit = stop.stop_and_wait().await;
    assert!(exit.error.is_none(), "{:?}", exit.error);
    let retained_exit = exit.clone();
    let cached = exit
        .take_completed_audio()
        .unwrap()
        .into_matching(&metadata, metadata.studio_meta().unwrap())
        .unwrap();
    assert!(retained_exit.take_completed_audio().is_none());
    let actual = cached[0].mic.as_ref().unwrap();
    assert_eq!(actual.sample_count(), expected.sample_count());
    assert_eq!(actual.channels(), expected.channels());
    assert!(
        actual
            .sample_slices()
            .flatten()
            .zip(expected.samples())
            .all(|(actual, expected)| actual.to_bits() == expected.to_bits())
    );
    assert!(actual.sample(expected.samples().len()).is_none());
    assert!(fixture.released.load(Ordering::Acquire));
    assert!(fixture.rename_succeeded.load(Ordering::Acquire));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_preparing_audio_decode_failure_never_admits_playback() {
    let fixture = fixture(false);
    std::fs::write(
        fixture.metadata.project_path.join("mic.aac"),
        b"invalid audio",
    )
    .unwrap();
    let session = crate::PreparingPlaybackSession::spawn(
        fixture.input(),
        vec![crate::PreparingAudioSegmentInput {
            mic: Some(
                cap_audio::ManagedAudioInput::new(fixture.source.clone(), PathBuf::from("mic.aac"))
                    .unwrap(),
            ),
            system_audio: None,
            timing_repair: Default::default(),
        }],
        crate::PreparingPlaybackOptions {
            preview: PreparingPreviewOptions::default(),
            fps: 30,
            resolution: XY::new(320, 240),
        },
        Arc::new(crate::AudioOutput::new_headless(Box::new(|_, _| {}))),
        Box::new(|_, _, _| {}),
    )
    .unwrap();
    let mut updates = session.updates();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let state = updates.borrow_and_update().clone();
            assert_eq!(state.progress.playable_until, 0.0);
            if state.progress.phase == crate::PreparingEditorPhase::Unavailable {
                break;
            }
            updates.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(session.controller().set_playing(true).await.is_err());
    drop(fixture.source);
    let exit = session.stop_handle().stop_and_wait().await;
    assert!(exit.error.is_some());
    assert!(!exit.cleanup_failed);
    assert_eq!(exit.snapshot.progress.playable_until, 0.0);
    assert!(fixture.released.load(Ordering::Acquire));
    assert!(fixture.rename_succeeded.load(Ordering::Acquire));
}

async fn composed_parity_with_reference(
    fixture: Fixture,
    frames: &[u32],
    force_ffmpeg: bool,
    frame_format: EditorFrameFormat,
) {
    let svg = fixture.project.cursor.use_svg;
    assert!(!fixture.metadata.project_path.join("cursor.png").exists());
    let expected = ordinary_composed_frames(&fixture, frames, force_ffmpeg).await;
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let mut preview = PreparingPreview::spawn(
        fixture.input(),
        PreparingPreviewOptions {
            use_hardware_decoding: true,
            frame_format,
        },
        Box::new(move |request, output, layout| {
            let frame = match output {
                EditorFrameOutput::Rgba(frame) => {
                    assert_eq!(frame_format, EditorFrameFormat::Rgba);
                    frame
                }
                #[cfg(target_os = "macos")]
                EditorFrameOutput::Surface(frame) => {
                    assert_eq!(frame_format, EditorFrameFormat::BgraSurface);
                    surface_rgba(frame)
                }
                EditorFrameOutput::Nv12(_) => panic!("Unexpected NV12 output"),
            };
            sender.send((request, frame, layout)).unwrap();
        }),
    )
    .unwrap();
    let stop = preview.stop_handle();
    let ready = tokio::time::timeout(Duration::from_secs(30), preview.wait_ready())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ready.screen_size, XY::new(160, 120));
    assert_eq!(ready.camera_size, Some(XY::new(80, 80)));
    for (index, (frame_number, (expected, expected_layout))) in
        frames.iter().copied().zip(expected).enumerate()
    {
        if index == 1 {
            fixture.relocate("retained");
        }
        if index == 2 {
            fixture.relocate("original");
        }
        let sequence = preview
            .request_frame(frame_number, 30, XY::new(320, 240))
            .unwrap();
        let (request, actual, layout) =
            tokio::time::timeout(Duration::from_secs(15), receiver.recv())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(request.sequence, sequence);
        assert_eq!(actual.frame_number, frame_number);
        assert_eq!(layout, expected_layout);
        assert_eq!(
            (actual.width, actual.height),
            (expected.width, expected.height)
        );
        assert_eq!(
            visible_rgba(&actual),
            visible_rgba(&expected),
            "Composed frame differs: svg={svg}, frame={frame_number}"
        );
        assert!(!fixture.released.load(Ordering::Acquire));
    }
    assert!(fixture.assets.first_error().is_none());
    drop(fixture.source);
    let second_stop = preview.stop_handle();
    let (first, second) = tokio::join!(stop.stop_and_wait(), second_stop.stop_and_wait());
    assert_eq!(first.reason, PreparingPreviewError::Cancelled);
    assert_eq!(second.reason, PreparingPreviewError::Cancelled);
    assert_eq!(first.workers.len(), fixture.project.clips.len().min(2));
    assert!(
        first
            .workers
            .iter()
            .all(|worker| worker.display.is_some() && worker.camera.is_some())
    );
    assert!(fixture.released.load(Ordering::Acquire));
    assert!(fixture.rename_succeeded.load(Ordering::Acquire));
    assert!(
        fixture
            .directory
            .path()
            .join("released-after-native-join")
            .is_dir()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_preparing_png_cursor_zoom_camera_and_relocation_match_finalized_render() {
    composed_parity(fixture(false), &[0, 45, 12, 90]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_preparing_svg_cursor_zoom_camera_and_relocation_match_finalized_render() {
    composed_parity(fixture(true), &[0, 45, 12, 90]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_recorded_keyboard_without_overlay_matches_finalized_render() {
    let mut fixture = fixture(false);
    let keyboard = cap_project::KeyboardEvents {
        presses: vec![cap_project::KeyPressEvent {
            key: "A".into(),
            key_code: "KeyA".into(),
            time_ms: 0.0,
            down: true,
        }],
    };
    for metadata in [&mut fixture.metadata, &mut fixture.reference_metadata] {
        let path = metadata.project_path.join("keyboard.bin");
        keyboard.write_to_file(&path).unwrap();
        let cap_project::RecordingMetaInner::Studio(studio) = &mut metadata.inner else {
            panic!("Studio metadata expected");
        };
        let cap_project::StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
            panic!("Indexed metadata expected");
        };
        inner.segments[0].keyboard = Some("keyboard.bin".into());
        let segment = inner.segments[0].clone();
        assert_eq!(segment.keyboard_events(metadata).presses, keyboard.presses);
    }
    let before = serde_json::to_value(&fixture.project).unwrap();
    cap_project::synchronize_legacy_keyboard(&fixture.reference_metadata, &mut fixture.project);
    assert_eq!(serde_json::to_value(&fixture.project).unwrap(), before);
    assert!(fixture.project.keyboard.is_none());
    assert!(
        fixture
            .project
            .timeline
            .as_ref()
            .unwrap()
            .keyboard_segments
            .is_empty()
    );
    composed_parity(fixture, &[0, 45, 12, 90]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_three_clip_eviction_reopen_and_boundaries_match_finalized_render() {
    let mut fixture = fixture(false);
    for metadata in [&mut fixture.metadata, &mut fixture.reference_metadata] {
        let cap_project::RecordingMetaInner::Studio(studio) = &mut metadata.inner else {
            panic!("Studio metadata expected");
        };
        let cap_project::StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
            panic!("Indexed metadata expected");
        };
        inner.segments.resize(3, inner.segments[0].clone());
    }
    fixture.project.timeline = Some(
        serde_json::from_value(serde_json::json!({
            "segments": (0..3).map(|index| serde_json::json!({
                "recordingSegment": index, "timescale": 1.0, "start": 0.0, "end": 3.0
            })).collect::<Vec<_>>(),
            "zoomSegments": (0..3).map(|index| serde_json::json!({
                "start": f64::from(index) * 3.0 + 0.3,
                "end": f64::from(index) * 3.0 + 2.7,
                "amount": 1.6, "mode": "auto"
            })).collect::<Vec<_>>()
        }))
        .unwrap(),
    );
    fixture.project.clips = (0..3)
        .map(|index| ClipConfiguration {
            index,
            offsets: ClipOffsets {
                camera: 0.25 + index as f32 * 0.125,
                mic: 0.03125,
                system_audio: 0.0,
            },
            offsets_auto_calculated: true,
        })
        .collect();
    composed_parity(fixture, &[0, 90, 180, 12, 89, 90, 179, 180, 269, 0]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_callback_panic_joins_workers_and_releases_source_owner() {
    let fixture = fixture(false);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let mut sender = Some(sender);
    let mut preview = PreparingPreview::spawn(
        fixture.input(),
        PreparingPreviewOptions {
            use_hardware_decoding: true,
            frame_format: EditorFrameFormat::Rgba,
        },
        Box::new(move |_, _, _| {
            sender.take().unwrap().send(()).unwrap();
            panic!("Native preparing callback failure");
        }),
    )
    .unwrap();
    let stop = preview.stop_handle();
    tokio::time::timeout(Duration::from_secs(30), preview.wait_ready())
        .await
        .unwrap()
        .unwrap();
    drop(fixture.source);
    assert!(!fixture.released.load(Ordering::Acquire));
    preview.request_frame(0, 30, XY::new(320, 240)).unwrap();
    tokio::time::timeout(Duration::from_secs(15), receiver)
        .await
        .unwrap()
        .unwrap();
    let exit = tokio::time::timeout(Duration::from_secs(15), stop.stop_and_wait())
        .await
        .unwrap();
    assert_eq!(exit.reason, PreparingPreviewError::Panicked);
    assert_eq!(exit.workers.len(), 1);
    assert!(exit.workers[0].display.is_some() && exit.workers[0].camera.is_some());
    assert!(fixture.released.load(Ordering::Acquire));
    assert!(fixture.rename_succeeded.load(Ordering::Acquire));
}

#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_preparing_matches_default_avasset_editor_decoder() {
    composed_parity_with_reference(
        fixture(false),
        &[0, 45, 12, 90],
        false,
        EditorFrameFormat::Rgba,
    )
    .await;
    composed_parity_with_reference(
        fixture(true),
        &[0, 45, 12, 90],
        false,
        EditorFrameFormat::Rgba,
    )
    .await;
}

#[cfg(target_os = "macos")]
fn surface_rgba(frame: cap_rendering::SurfaceFrame) -> RenderedFrame {
    use std::ffi::c_void;

    unsafe extern "C" {
        fn CVPixelBufferLockBaseAddress(buffer: *const c_void, flags: u64) -> i32;
        fn CVPixelBufferUnlockBaseAddress(buffer: *const c_void, flags: u64) -> i32;
        fn CVPixelBufferGetBaseAddress(buffer: *const c_void) -> *const u8;
        fn CVPixelBufferGetBytesPerRow(buffer: *const c_void) -> usize;
        fn CVPixelBufferGetDataSize(buffer: *const c_void) -> usize;
        fn CVPixelBufferGetWidth(buffer: *const c_void) -> usize;
        fn CVPixelBufferGetHeight(buffer: *const c_void) -> usize;
        fn CVPixelBufferGetPixelFormatType(buffer: *const c_void) -> u32;
    }

    struct LockedBuffer(*const c_void);

    impl Drop for LockedBuffer {
        fn drop(&mut self) {
            unsafe {
                CVPixelBufferUnlockBaseAddress(self.0, 1);
            }
        }
    }

    let buffer = std::ptr::from_ref(frame.pixel_buffer.as_ref()).cast::<c_void>();
    assert_eq!(unsafe { CVPixelBufferLockBaseAddress(buffer, 1) }, 0);
    let lock = LockedBuffer(buffer);
    let width = unsafe { CVPixelBufferGetWidth(buffer) };
    let height = unsafe { CVPixelBufferGetHeight(buffer) };
    let stride = unsafe { CVPixelBufferGetBytesPerRow(buffer) };
    let data_size = unsafe { CVPixelBufferGetDataSize(buffer) };
    assert_eq!(
        unsafe { CVPixelBufferGetPixelFormatType(buffer) },
        u32::from_be_bytes(*b"BGRA")
    );
    assert_eq!(width, frame.width as usize);
    assert_eq!(height, frame.height as usize);
    let row_bytes = width.checked_mul(4).unwrap();
    let buffer_bytes = stride.checked_mul(height).unwrap();
    assert!(row_bytes > 0 && height > 0 && stride >= row_bytes);
    assert!(data_size >= buffer_bytes);
    let address = unsafe { CVPixelBufferGetBaseAddress(buffer) };
    assert!(!address.is_null());
    let pixels = unsafe { std::slice::from_raw_parts(address, buffer_bytes) };
    let mut rgba = Vec::with_capacity(row_bytes.checked_mul(height).unwrap());
    for row in pixels.chunks_exact(stride) {
        for pixel in row[..row_bytes].chunks_exact(4) {
            rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }
    }
    drop(lock);
    RenderedFrame {
        data: Arc::new(rgba),
        width: frame.width,
        height: frame.height,
        padded_bytes_per_row: row_bytes.try_into().unwrap(),
        frame_number: frame.frame_number,
        target_time_ns: frame.target_time_ns,
    }
}

#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_preparing_bgra_surface_matches_default_avasset_editor_frame() {
    composed_parity_with_reference(
        fixture(false),
        &[0, 45, 12, 90],
        false,
        EditorFrameFormat::BgraSurface,
    )
    .await;
}

fn handoff_fixture() -> Fixture {
    use std::io::Write;

    let mut fixture = fixture(false);
    let root = fixture.metadata.project_path.clone();
    for track in ["display", "camera"] {
        std::fs::copy(
            fixture
                .reference_metadata
                .project_path
                .join(format!("{track}.mp4")),
            root.join(format!("{track}.mp4")),
        )
        .unwrap();
    }
    std::fs::copy(
        fixture.reference_metadata.project_path.join("cursor.png"),
        root.join("cursor.png"),
    )
    .unwrap();
    let cap_project::RecordingMetaInner::Studio(studio) = &mut fixture.metadata.inner else {
        panic!("Expected Studio metadata");
    };
    let cap_project::StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
        panic!("Expected indexed metadata");
    };
    inner.segments[0].display.path = "display.mp4".into();
    inner.segments[0].camera.as_mut().unwrap().path = "camera.mp4".into();
    inner.segments.resize(3, inner.segments[0].clone());
    fixture.metadata.save_for_project().unwrap();
    let segment = fixture.project.timeline.as_ref().unwrap().segments[0].clone();
    fixture.project.timeline.as_mut().unwrap().segments = (0..3)
        .map(|index| cap_project::TimelineSegment {
            recording_clip: index,
            end: 5.5,
            ..segment.clone()
        })
        .collect();
    let clip = fixture.project.clips[0].clone();
    fixture.project.clips = (0..3)
        .map(|index| ClipConfiguration {
            index,
            ..clip.clone()
        })
        .collect();
    fixture.project.write(&root).unwrap();
    let sample_count = 8 * 48_000_u32;
    let mut file = std::fs::File::create(root.join("mic.aac")).unwrap();
    file.write_all(b"RIFF").unwrap();
    file.write_all(&(sample_count * 2 + 36).to_le_bytes())
        .unwrap();
    file.write_all(b"WAVEfmt ").unwrap();
    file.write_all(&16_u32.to_le_bytes()).unwrap();
    file.write_all(&1_u16.to_le_bytes()).unwrap();
    file.write_all(&1_u16.to_le_bytes()).unwrap();
    file.write_all(&48_000_u32.to_le_bytes()).unwrap();
    file.write_all(&96_000_u32.to_le_bytes()).unwrap();
    file.write_all(&2_u16.to_le_bytes()).unwrap();
    file.write_all(&16_u16.to_le_bytes()).unwrap();
    file.write_all(b"data").unwrap();
    file.write_all(&(sample_count * 2).to_le_bytes()).unwrap();
    for sample in 0..sample_count {
        file.write_all(&((sample % 10_000) as i16 + 1_000).to_le_bytes())
            .unwrap();
    }
    drop(file);
    fixture
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_handoff_reuses_pcm_preserves_audio_across_candidate_disposal_and_joins_before_restart()
 {
    use std::sync::atomic::AtomicUsize;

    let fixture = handoff_fixture();
    let entry = fixture.metadata.project_path.join("editor-entry");
    std::fs::create_dir(&entry).unwrap();
    let root = entry.join("..");
    assert_ne!(root, fixture.metadata.project_path);
    let nonzero = Arc::new(AtomicUsize::new(0));
    let tapped = nonzero.clone();
    let output = Arc::new(crate::AudioOutput::new_headless(Box::new(
        move |samples, _| {
            tapped.fetch_add(
                samples.iter().filter(|sample| **sample != 0.0).count(),
                Ordering::Relaxed,
            );
        },
    )));
    let session = crate::PreparingPlaybackSession::spawn(
        fixture.input(),
        (0..3)
            .map(|_| crate::PreparingAudioSegmentInput {
                mic: Some(
                    cap_audio::ManagedAudioInput::new(
                        fixture.source.clone(),
                        PathBuf::from("mic.aac"),
                    )
                    .unwrap(),
                ),
                system_audio: None,
                timing_repair: Default::default(),
            })
            .collect(),
        crate::PreparingPlaybackOptions {
            preview: PreparingPreviewOptions::default(),
            fps: 30,
            resolution: XY::new(320, 240),
        },
        output.clone(),
        Box::new(|_, _, _| {}),
    )
    .unwrap();
    let handoff = session.handoff_handle();
    let cache = tokio::time::timeout(Duration::from_secs(30), handoff.take_completed_audio())
        .await
        .unwrap()
        .unwrap();
    let expected = cache
        .clone()
        .into_matching(&fixture.metadata, fixture.metadata.studio_meta().unwrap())
        .unwrap()[0]
        .mic
        .clone()
        .unwrap();
    let candidate = crate::EditorInstance::new_with_startup_inputs(
        root.clone(),
        |_| {},
        Box::new(|_, _| {}),
        None,
        crate::EditorFrameFormat::Rgba,
        output,
        crate::EditorStartupInputs {
            recordings: None,
            completed_audio: Some(cache),
        },
    )
    .await
    .unwrap();
    let actual = candidate.segment_medias[0]
        .audio
        .get()
        .await
        .unwrap()
        .unwrap();
    assert!(Arc::ptr_eq(&expected, &actual));
    let mut updates = session.updates();
    tokio::time::timeout(Duration::from_secs(30), async {
        while !updates.borrow_and_update().progress.preview_available {
            updates.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    session.controller().seek(0.5).await.unwrap();
    session.controller().set_playing(true).await.unwrap();
    candidate.install_preparing_handoff(&handoff).await.unwrap();
    let obsolete = candidate.preparing_adoption().unwrap();
    session.controller().seek(0.5).await.unwrap();
    assert!(obsolete.invalidated());
    candidate.dispose().await;
    candidate.dispose().await;
    let before = nonzero.load(Ordering::Relaxed);
    tokio::time::timeout(Duration::from_secs(5), async {
        while nonzero.load(Ordering::Relaxed) <= before {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let (frames, mut received) = tokio::sync::watch::channel(None);
    let next = candidate
        .recreate_preparing_candidate(
            |_| {},
            Box::new(move |output, _| {
                let frame = match output {
                    crate::EditorFrameOutput::Rgba(frame) => frame.frame_number,
                    crate::EditorFrameOutput::Nv12(frame) => frame.frame_number,
                    #[cfg(target_os = "macos")]
                    crate::EditorFrameOutput::Surface(frame) => frame.frame_number,
                };
                frames.send_replace(Some(frame));
            }),
            crate::EditorFrameFormat::Rgba,
        )
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&candidate.segment_medias, &next.segment_medias));
    candidate.dispose().await;
    assert!(!obsolete.try_commit(15, 30));
    assert!(
        next.start_preparing_handoff(30, XY::new(320, 240))
            .await
            .unwrap()
    );
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if received
                .borrow_and_update()
                .is_some_and(|frame| next.commit_preparing_frame(frame, 30))
            {
                break;
            }
            received.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(handoff.committed());
    assert_eq!(
        next.install_preparing_handoff(&handoff).await.unwrap_err(),
        "Editor already has a preparing candidate"
    );
    assert!(handoff.committed());
    let before = nonzero.load(Ordering::Relaxed);
    tokio::time::timeout(Duration::from_secs(5), async {
        while nonzero.load(Ordering::Relaxed) <= before {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let ordinary = next
        .start_playback_with_handle(30, XY::new(320, 240), Some(30))
        .await
        .unwrap();
    let exit = session.stop_handle().stop_and_wait().await;
    assert!(!exit.cleanup_failed, "{:?}", exit.error);
    assert!(next.preparing_adoption().is_none());
    assert!(Arc::ptr_eq(
        &expected,
        &next.segment_medias[0].audio.get().await.unwrap().unwrap()
    ));
    ordinary.stop();
    next.dispose().await;
    drop(ordinary);
    drop(next);
    drop(candidate);
    drop(obsolete);
    drop(handoff);
    drop(session);
    drop(fixture.source);
    assert!(fixture.released.load(Ordering::Acquire));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_silent_handoff_opens_and_renders_through_an_equivalent_editor_path() {
    for count in [1, 2] {
        let mut fixture = handoff_fixture();
        let segments = crate::completed_audio::tests::segments_mut(&mut fixture.metadata);
        segments.truncate(count);
        for segment in segments {
            segment.mic = None;
            segment.system_audio = None;
            segment.camera = None;
        }
        fixture.project.clips.truncate(count);
        fixture
            .project
            .timeline
            .as_mut()
            .unwrap()
            .segments
            .truncate(count);
        fixture.metadata.save_for_project().unwrap();
        fixture
            .project
            .write(&fixture.metadata.project_path)
            .unwrap();
        let metadata = fixture.metadata.studio_meta().unwrap();
        let input = PreparingPreviewInput {
            recording_meta: fixture.metadata.clone(),
            project: fixture.project.clone(),
            segments: (0..count)
                .map(|index| PreparingPreviewSegment {
                    video: ManagedSegmentVideoInput::new(
                        index,
                        metadata,
                        ManagedVideoTrackInput::new(
                            fixture.source.clone(),
                            fixture.display.clone(),
                        )
                        .unwrap(),
                        None,
                    )
                    .unwrap(),
                    cursor: fixture.cursor.clone(),
                })
                .collect(),
            cursor_assets: fixture.assets.clone(),
        };
        let output = Arc::new(crate::AudioOutput::new_headless(Box::new(|_, _| {})));
        let session = crate::PreparingPlaybackSession::spawn(
            input,
            (0..count)
                .map(|_| crate::PreparingAudioSegmentInput {
                    mic: None,
                    system_audio: None,
                    timing_repair: Default::default(),
                })
                .collect(),
            crate::PreparingPlaybackOptions {
                preview: PreparingPreviewOptions::default(),
                fps: 30,
                resolution: XY::new(320, 240),
            },
            output.clone(),
            Box::new(|_, _, _| {}),
        )
        .unwrap();
        let handoff = session.handoff_handle();
        let completed_audio =
            tokio::time::timeout(Duration::from_secs(30), handoff.take_completed_audio())
                .await
                .unwrap()
                .unwrap();
        let entry = fixture.metadata.project_path.join("editor-entry");
        std::fs::create_dir(&entry).unwrap();
        let (frames, mut received) = watch::channel(None);
        let candidate = crate::EditorInstance::new_with_startup_inputs(
            entry.join(".."),
            |_| {},
            Box::new(move |output, _| {
                let frame = match output {
                    crate::EditorFrameOutput::Rgba(frame) => frame.frame_number,
                    crate::EditorFrameOutput::Nv12(frame) => frame.frame_number,
                    #[cfg(target_os = "macos")]
                    crate::EditorFrameOutput::Surface(frame) => frame.frame_number,
                };
                frames.send_replace(Some(frame));
            }),
            None,
            crate::EditorFrameFormat::Rgba,
            output,
            crate::EditorStartupInputs {
                recordings: None,
                completed_audio: Some(completed_audio),
            },
        )
        .await
        .unwrap();
        assert_eq!(candidate.segment_medias.len(), count);
        let mut updates = session.updates();
        tokio::time::timeout(Duration::from_secs(30), async {
            while !updates.borrow_and_update().progress.preview_available {
                updates.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        candidate.install_preparing_handoff(&handoff).await.unwrap();
        candidate
            .preview_tx
            .send(Some((0, 30, XY::new(320, 240))))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if received
                    .borrow_and_update()
                    .is_some_and(|frame| candidate.commit_preparing_frame(frame, 30))
                {
                    break;
                }
                received.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert!(handoff.committed());
        candidate.dispose().await;
        let exit = handoff.stop_and_wait().await;
        assert!(!exit.cleanup_failed, "{:?}", exit.error);
        drop(candidate);
        drop(handoff);
        drop(session);
        drop(fixture.source);
        assert!(fixture.released.load(Ordering::Acquire));
    }
}

async fn failed_handoff_installation_retires_native_candidate(cancelled: bool) {
    use futures::FutureExt;

    let fixture = handoff_fixture();
    let output = Arc::new(crate::AudioOutput::new_headless(Box::new(|_, _| {})));
    let session = crate::PreparingPlaybackSession::spawn(
        fixture.input(),
        (0..3)
            .map(|_| crate::PreparingAudioSegmentInput {
                mic: Some(
                    cap_audio::ManagedAudioInput::new(
                        fixture.source.clone(),
                        PathBuf::from("mic.aac"),
                    )
                    .unwrap(),
                ),
                system_audio: None,
                timing_repair: Default::default(),
            })
            .collect(),
        crate::PreparingPlaybackOptions {
            preview: PreparingPreviewOptions::default(),
            fps: 30,
            resolution: XY::new(320, 240),
        },
        output.clone(),
        Box::new(|_, _, _| {}),
    )
    .unwrap();
    let handoff = session.handoff_handle();
    let cache = tokio::time::timeout(Duration::from_secs(30), handoff.take_completed_audio())
        .await
        .unwrap()
        .unwrap();
    let candidate = crate::EditorInstance::new_with_startup_inputs(
        fixture.metadata.project_path.clone(),
        |_| {},
        Box::new(|_, _| {}),
        None,
        crate::EditorFrameFormat::Rgba,
        output,
        crate::EditorStartupInputs {
            recordings: None,
            completed_audio: if cancelled { Some(cache) } else { None },
        },
    )
    .await
    .unwrap();
    let retained = Arc::downgrade(&candidate);
    assert!(candidate.state.lock().await.preview_task.is_some());
    if cancelled {
        handoff.cancel();
    }
    let error = tokio::time::timeout(
        Duration::from_secs(30),
        candidate.install_preparing_handoff(&handoff),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(
        error,
        if cancelled {
            "Preparing playback cannot retry adoption"
        } else {
            "Preparing audio does not match this editor's completed sources or output"
        }
    );
    assert!(candidate.state.lock().await.preview_task.is_none());
    let stop = session.stop_handle();
    let exit = stop
        .stop_and_wait()
        .now_or_never()
        .expect("Failed installation returned before managed workers joined");
    assert!(!exit.cleanup_failed, "{:?}", exit.error);
    drop(exit);
    drop(candidate);
    assert!(retained.upgrade().is_none());
    drop(stop);
    drop(handoff);
    drop(session);
    drop(fixture.source);
    assert!(fixture.released.load(Ordering::Acquire));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_cancelled_handoff_installation_joins_and_releases_the_candidate() {
    failed_handoff_installation_retires_native_candidate(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_rejected_audio_handoff_installation_joins_and_releases_the_candidate() {
    failed_handoff_installation_retires_native_candidate(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_studio_sound_releases_preparing_audio_and_preserves_transport() {
    for initially_enabled in [false, true] {
        let mut fixture = handoff_fixture();
        let cap_project::RecordingMetaInner::Studio(studio) = &mut fixture.metadata.inner else {
            panic!("Expected Studio metadata");
        };
        let cap_project::StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
            panic!("Expected indexed metadata");
        };
        for segment in &mut inner.segments {
            segment.display.path = "display".into();
            segment.camera.as_mut().unwrap().path = "camera".into();
        }
        fixture.metadata.save_for_project().unwrap();
        let output = Arc::new(crate::AudioOutput::new_headless(Box::new(|_, _| {})));
        let session = crate::PreparingPlaybackSession::spawn(
            fixture.input(),
            (0..3)
                .map(|_| crate::PreparingAudioSegmentInput {
                    mic: Some(
                        cap_audio::ManagedAudioInput::new(
                            fixture.source.clone(),
                            PathBuf::from("mic.aac"),
                        )
                        .unwrap(),
                    ),
                    system_audio: None,
                    timing_repair: Default::default(),
                })
                .collect(),
            crate::PreparingPlaybackOptions {
                preview: PreparingPreviewOptions::default(),
                fps: 30,
                resolution: XY::new(320, 240),
            },
            output.clone(),
            Box::new(|_, _, _| {}),
        )
        .unwrap();
        let handoff = session.handoff_handle();
        let cache = tokio::time::timeout(Duration::from_secs(30), handoff.take_completed_audio())
            .await
            .unwrap()
            .unwrap();
        let (frames, mut received) = tokio::sync::watch::channel(None);
        let candidate = crate::EditorInstance::new_with_startup_inputs(
            fixture.metadata.project_path.clone(),
            |_| {},
            Box::new(move |output, _| {
                let frame = match output {
                    crate::EditorFrameOutput::Rgba(frame) => frame.frame_number,
                    crate::EditorFrameOutput::Nv12(frame) => frame.frame_number,
                    #[cfg(target_os = "macos")]
                    crate::EditorFrameOutput::Surface(frame) => frame.frame_number,
                };
                frames.send_replace(Some(frame));
            }),
            None,
            crate::EditorFrameFormat::Rgba,
            output,
            crate::EditorStartupInputs {
                recordings: None,
                completed_audio: Some(cache),
            },
        )
        .await
        .unwrap();
        candidate
            .project_config
            .0
            .send_modify(|project| project.audio.improve = initially_enabled);
        let mut updates = session.updates();
        tokio::time::timeout(Duration::from_secs(30), async {
            while !updates.borrow_and_update().progress.preview_available {
                updates.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        candidate
            .preview_tx
            .send(Some((0, 30, XY::new(320, 240))))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(30), async {
            while received.borrow_and_update().is_none() {
                received.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        session.controller().seek(0.5).await.unwrap();
        session.controller().set_playing(true).await.unwrap();
        candidate.install_preparing_handoff(&handoff).await.unwrap();
        assert!(
            candidate
                .start_preparing_handoff(30, XY::new(320, 240))
                .await
                .unwrap()
        );
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if received
                    .borrow_and_update()
                    .is_some_and(|frame| candidate.commit_preparing_frame(frame, 30))
                {
                    break;
                }
                received.changed().await.unwrap();
            }
        })
        .await
        .expect("Prepared editor did not present a handoff frame");
        let external_handle = candidate.state.lock().await.playback_task.clone().unwrap();
        candidate
            .project_config
            .0
            .send_modify(|project| project.audio.improve = true);
        tokio::time::timeout(Duration::from_secs(10), async {
            while candidate.preparing_adoption().is_some() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            while !external_handle.seek(18) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            while candidate.state.lock().await.playhead_position < 18 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let mut active = candidate.playback_watch();
        assert!(*active.borrow_and_update());
        external_handle.stop();
        tokio::time::timeout(Duration::from_secs(5), async {
            while *active.borrow_and_update() {
                active.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        candidate.dispose().await;
    }
}
