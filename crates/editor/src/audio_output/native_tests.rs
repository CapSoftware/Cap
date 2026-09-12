use super::*;
use std::io::Write;

struct HeadlessControl {
    output: Arc<AudioOutput>,
    release: Option<std_mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
    blocks: flume::Receiver<bool>,
}

impl HeadlessControl {
    async fn blocked() -> Self {
        let (release, blocked) = std_mpsc::channel();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (blocks_tx, blocks) = flume::unbounded();
        let mut entered_tx = Some(entered_tx);
        let tap = Box::new(move |samples: &[f32], _: Instant| {
            if let Some(entered) = entered_tx.take() {
                let _ = entered.send(());
                let _ = blocked.recv();
            }
            let _ = blocks_tx.send(samples.iter().any(|sample| sample.abs() > 0.0001));
        });
        let (control_tx, control_rx) = std_mpsc::channel();
        let thread = std::thread::spawn(move || control_thread_headless(control_rx, tap));
        let control = Self {
            output: Arc::new(AudioOutput {
                control_tx,
                next_generation: AtomicU64::new(0),
            }),
            release: Some(release),
            thread: Some(thread),
            blocks,
        };
        tokio::time::timeout(Duration::from_secs(2), entered_rx)
            .await
            .unwrap()
            .unwrap();
        control
    }

    fn release(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
    }

    async fn block(&self) -> bool {
        tokio::time::timeout(Duration::from_secs(2), self.blocks.recv_async())
            .await
            .unwrap()
            .unwrap()
    }

    async fn join(mut self) {
        self.release();
        self.output.shutdown();
        let thread = self.thread.take().unwrap();
        tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || thread.join().unwrap()),
        )
        .await
        .unwrap()
        .unwrap();
    }
}

impl Drop for HeadlessControl {
    fn drop(&mut self) {
        self.release();
        self.output.shutdown();
    }
}

fn audible_spec() -> PlaySpec {
    ffmpeg::init().unwrap();
    let mut file = tempfile::Builder::new().suffix(".wav").tempfile().unwrap();
    let samples = vec![5000i16; 96_000];
    let bytes = (samples.len() * 2) as u32;
    file.write_all(b"RIFF").unwrap();
    file.write_all(&(36 + bytes).to_le_bytes()).unwrap();
    file.write_all(b"WAVEfmt ").unwrap();
    file.write_all(&16u32.to_le_bytes()).unwrap();
    file.write_all(&1u16.to_le_bytes()).unwrap();
    file.write_all(&1u16.to_le_bytes()).unwrap();
    file.write_all(&48_000u32.to_le_bytes()).unwrap();
    file.write_all(&96_000u32.to_le_bytes()).unwrap();
    file.write_all(&2u16.to_le_bytes()).unwrap();
    file.write_all(&16u16.to_le_bytes()).unwrap();
    file.write_all(b"data").unwrap();
    file.write_all(&bytes.to_le_bytes()).unwrap();
    for sample in samples {
        file.write_all(&sample.to_le_bytes()).unwrap();
    }
    file.flush().unwrap();
    let audio = Arc::new(cap_audio::DecodedAudio::from(Arc::new(
        AudioData::from_file(file.path()).unwrap(),
    )));
    let (_, playhead_rx) = watch::channel(0.0);
    PlaySpec {
        segments: vec![crate::audio_segment_from_decoded(
            Some(audio),
            None,
            crate::SegmentAudioTimingRepair::default(),
        )],
        music: MusicTracks::new(),
        project: ProjectConfiguration::default(),
        duration_secs: 2.0,
        start_playhead_secs: 0.0,
        playhead_rx,
    }
}

fn ticket_with_timeout(
    output: &AudioOutput,
    spec: PlaySpec,
    timeout: Duration,
) -> PreparingAudioPlayTicket {
    let generation = output.next_generation.fetch_add(1, Ordering::Relaxed);
    let request = Arc::new(PreparingAudioRequest::new(timeout));
    output
        .control_tx
        .send(ControlMsg::PreparePlayback {
            spec: Box::new(spec),
            generation,
            request: request.clone(),
        })
        .unwrap();
    PreparingAudioPlayTicket {
        generation,
        request,
        control_tx: output.control_tx.clone(),
    }
}

async fn installed(ticket: &PreparingAudioPlayTicket) {
    let mut status = ticket.request.status.subscribe();
    tokio::time::timeout(Duration::from_secs(2), async {
        while *status.borrow_and_update() == PreparingAudioStatus::Pending {
            status.changed().await.unwrap();
        }
        assert!(*status.borrow() == PreparingAudioStatus::AwaitingCallback);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn preparing_cancel_wakes_while_control_is_blocked_and_preserves_ordinary_playback() {
    let spec = audible_spec();
    let ordinary_spec = audible_spec();
    let mut control = HeadlessControl::blocked().await;
    let generation = control
        .output
        .next_generation
        .fetch_add(1, Ordering::Relaxed);
    let (result_tx, result_rx) = std_mpsc::channel();
    control
        .output
        .control_tx
        .send(ControlMsg::Play {
            spec: Box::new(ordinary_spec),
            generation,
            result_tx,
        })
        .unwrap();
    let ticket = control.output.prepare_playback(spec);
    let (started, ()) = tokio::time::timeout(Duration::from_millis(200), async {
        tokio::join!(ticket.wait_started(), async {
            tokio::task::yield_now().await;
            ticket.cancel();
        })
    })
    .await
    .unwrap();
    assert!(!started);
    assert!(ticket.request.is_cancelled());
    control.release();
    assert!(
        tokio::task::spawn_blocking(move || result_rx.recv_timeout(Duration::from_secs(2)))
            .await
            .unwrap()
            .unwrap()
    );
    assert!(!control.block().await);
    assert!(control.block().await);
    ticket.cancel();
    drop(ticket);
    assert!(control.block().await);
    control.join().await;
}

#[tokio::test]
async fn preparing_stale_ticket_does_not_stop_a_newer_ordinary_playback() {
    let spec = audible_spec();
    let successor_spec = audible_spec();
    let mut control = HeadlessControl::blocked().await;
    let ticket = control.output.prepare_playback(spec);
    installed(&ticket).await;
    let output = control.output.clone();
    let successor = tokio::task::spawn_blocking(move || output.play(successor_spec));
    control.release();
    let generation = tokio::time::timeout(Duration::from_secs(2), successor)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(generation > ticket.generation);
    ticket.cancel();
    drop(ticket);
    assert!(!control.block().await);
    for _ in 0..4 {
        assert!(control.block().await);
    }
    control.join().await;
}

#[tokio::test]
async fn preparing_timeout_cancels_late_callback_install() {
    let spec = audible_spec();
    let mut control = HeadlessControl::blocked().await;
    let ticket = ticket_with_timeout(&control.output, spec, Duration::from_millis(100));
    installed(&ticket).await;
    assert!(
        !tokio::time::timeout(Duration::from_secs(1), ticket.wait_started())
            .await
            .unwrap()
    );
    assert!(ticket.request.cancelled.load(Ordering::Acquire));
    control.release();
    for _ in 0..4 {
        assert!(!control.block().await);
    }
    assert!(!ticket.wait_started().await);
    control.join().await;
}

#[tokio::test]
async fn preparing_ticket_drop_rejects_already_queued_install() {
    let spec = audible_spec();
    let mut control = HeadlessControl::blocked().await;
    let ticket = control.output.prepare_playback(spec);
    installed(&ticket).await;
    let request = ticket.request.clone();
    drop(ticket);
    assert!(request.is_cancelled());
    control.release();
    for _ in 0..4 {
        assert!(!control.block().await);
    }
    control.join().await;
}

#[tokio::test]
async fn preparing_cancelled_wait_can_be_retried_while_ticket_is_owned() {
    let spec = audible_spec();
    let mut control = HeadlessControl::blocked().await;
    let ticket = control.output.prepare_playback(spec);
    installed(&ticket).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(10), ticket.wait_started())
            .await
            .is_err()
    );
    assert!(!ticket.request.is_cancelled());
    control.release();
    assert!(ticket.wait_started().await);
    assert!(!control.block().await);
    assert!(control.block().await);
    control.join().await;
}

#[tokio::test]
async fn preparing_failed_install_revokes_the_request() {
    let mut spec = audible_spec();
    spec.duration_secs = f64::NAN;
    let mut control = HeadlessControl::blocked().await;
    let ticket = control.output.prepare_playback(spec);
    assert!(!ticket.wait_started().await);
    assert!(ticket.request.cancelled.load(Ordering::Acquire));
    control.release();
    assert!(!control.block().await);
    assert!(!control.block().await);
    control.join().await;
}

#[tokio::test]
async fn preparing_dropped_acknowledgement_wakes_and_cancels_without_waiting_for_timeout() {
    let request = Arc::new(PreparingAudioRequest::new(PLAY_REQUEST_TIMEOUT));
    let (control_tx, control_rx) = std_mpsc::channel();
    let ticket = PreparingAudioPlayTicket {
        generation: 12,
        request: request.clone(),
        control_tx,
    };
    let (source_tx, source_rx) = std_mpsc::channel();
    install_source::<f32>(
        Box::new(audible_spec()),
        12,
        SourceAcknowledgement::Preparing(request.clone()),
        AudioInfo::new_raw(AudioData::SAMPLE_FORMAT, 48_000, 2),
        false,
        &source_tx,
    )
    .unwrap();
    drop(source_rx.recv().unwrap());
    assert!(
        !tokio::time::timeout(Duration::from_millis(200), ticket.wait_started())
            .await
            .unwrap()
    );
    assert!(request.cancelled.load(Ordering::Acquire));
    assert!(matches!(
        control_rx.recv().unwrap(),
        ControlMsg::StopPlayback { generation: 12 }
    ));
}

#[test]
fn preparing_callback_silences_active_cancelled_source_without_a_remove_command() {
    let spec = audible_spec();
    let request = Arc::new(PreparingAudioRequest::new(PLAY_REQUEST_TIMEOUT));
    let (source_tx, source_rx) = std_mpsc::channel();
    install_source(
        Box::new(spec),
        12,
        SourceAcknowledgement::Preparing(request.clone()),
        AudioInfo::new_raw(AudioData::SAMPLE_FORMAT, 48_000, 2),
        false,
        &source_tx,
    )
    .unwrap();
    let SourceCommand::Install(mut source) = source_rx.recv().unwrap() else {
        panic!("expected installed preparing source");
    };
    let mut block = [0.0f32; 1024];
    render_source_block(&mut source, &mut block, 0.0);
    assert!(block.iter().any(|sample| sample.abs() > 0.0001));
    assert!(*request.status.borrow() == PreparingAudioStatus::Started);
    request.cancel();
    let before = source.buffer.current_playhead_secs();
    render_source_block(&mut source, &mut block, 0.0);
    assert!(block.iter().all(|sample| *sample == 0.0));
    assert_eq!(source.buffer.current_playhead_secs(), before);
    request.complete(true);
    assert!(*request.status.borrow() == PreparingAudioStatus::Cancelled);
}

#[test]
fn preparing_expired_install_does_not_replace_an_active_ordinary_source() {
    let request = Arc::new(PreparingAudioRequest::new(PLAY_REQUEST_TIMEOUT));
    let (source_tx, source_rx) = std_mpsc::channel();
    install_source::<f32>(
        Box::new(audible_spec()),
        12,
        SourceAcknowledgement::Preparing(request.clone()),
        AudioInfo::new_raw(AudioData::SAMPLE_FORMAT, 48_000, 2),
        false,
        &source_tx,
    )
    .unwrap();
    request.cancel();
    let (mut ordinary, _) = super::tests::source(48_000);
    ordinary.generation = 13;
    let mut active = Some(ordinary);
    source_tx
        .send(SourceCommand::Remove {
            generation: Some(12),
        })
        .unwrap();
    drain_source_commands(&mut active, &source_rx);
    assert_eq!(active.unwrap().generation, 13);
}

struct RetainedSourceState {
    failed: AtomicBool,
    active: Option<ActiveSource<f32>>,
    commands: std_mpsc::Receiver<SourceCommand<f32>>,
    send_commands: std_mpsc::Sender<SourceCommand<f32>>,
    _ownership: Arc<()>,
}

struct PreparingOwnershipFixture {
    state: Option<RetainedSourceState>,
    output: PreparingAudioOutputHandle,
    producer: cap_audio::ProgressiveAudioTestProducer,
    project: std::sync::Weak<ProjectConfiguration>,
    owner: std::sync::Weak<()>,
}

fn preparing_test_sources(
    loader: cap_audio::ProgressiveAudio,
    duration: f64,
) -> PreparingAudioSources {
    let project = Arc::new(ProjectConfiguration {
        timeline: Some(cap_project::TimelineConfiguration {
            segments: vec![cap_project::TimelineSegment {
                recording_clip: 0,
                start: 0.0,
                end: duration,
                timescale: 1.0,
                ..Default::default()
            }],
            zoom_segments: Vec::new(),
            scene_segments: Vec::new(),
            mask_segments: Vec::new(),
            text_segments: Vec::new(),
            caption_segments: Vec::new(),
            keyboard_segments: Vec::new(),
            audio_segments: Vec::new(),
            style_segments: Vec::new(),
            image_segments: Vec::new(),
            camera3d_segments: Vec::new(),
            transitions: Vec::new(),
        }),
        clips: vec![cap_project::ClipConfiguration::default()],
        audio: cap_project::AudioConfiguration {
            mic_stereo_mode: cap_project::StereoMode::Stereo,
            ..Default::default()
        },
        ..Default::default()
    });
    PreparingAudioSources {
        project,
        tracks: vec![[Some(loader), None]],
        required: vec![[true, false]],
        repairs: vec![crate::SegmentAudioTimingRepair::default()],
    }
}

fn pending_preparing_owner(generation: u64) -> PreparingOwnershipFixture {
    let (loader, producer) = cap_audio::ProgressiveAudioTestProducer::new();
    let sources = preparing_test_sources(loader, 1.0);
    let project_weak = Arc::downgrade(&sources.project);
    let request = Arc::new(PreparingAudioRequest::new(PLAY_REQUEST_TIMEOUT));
    request.installed.send_replace(false);
    let installation = PreparingAudioInstallation {
        request: request.clone(),
        runtime: tokio::runtime::Handle::current(),
        playable_until: 0.0,
    };
    let (send_commands, commands) = std_mpsc::channel();
    install_progressive_source::<f32>(
        sources,
        0.0,
        generation,
        &installation,
        AudioInfo::new_raw(AudioData::SAMPLE_FORMAT, 48_000, 2),
        false,
        &send_commands,
    )
    .unwrap();
    drop(installation);
    assert!(*request.installed.borrow());
    let output = request.output.lock().unwrap().clone().unwrap();
    let ownership = Arc::new(());
    let owner = Arc::downgrade(&ownership);
    PreparingOwnershipFixture {
        state: Some(RetainedSourceState {
            failed: AtomicBool::new(false),
            active: None,
            commands,
            send_commands,
            _ownership: ownership,
        }),
        output,
        producer,
        project: project_weak,
        owner,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_stream_stop_retires_active_and_queued_preparing_owners_without_callbacks() {
    for active in [false, true] {
        let mut fixture = pending_preparing_owner(40);
        let state = fixture.state.as_mut().unwrap();
        if active {
            drain_source_commands(&mut state.active, &state.commands);
            assert_eq!(state.active.as_ref().unwrap().generation, 40);
        }
        state.failed.store(true, Ordering::Release);
        let mut waiting = Box::pin(fixture.output.stop_and_wait());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting)
                .await
                .is_err()
        );
        assert!(fixture.owner.upgrade().is_some());
        drop(waiting);

        stop_stream_state(
            &mut fixture.state,
            40,
            |stream| stream.failed.load(Ordering::Acquire),
            |_, _| panic!("A failed stream cannot acknowledge a removal command"),
        );

        assert!(fixture.state.is_none());
        assert!(fixture.owner.upgrade().is_none());
        tokio::time::timeout(Duration::from_secs(2), fixture.output.stop_and_wait())
            .await
            .unwrap()
            .unwrap();
        assert!(fixture.project.upgrade().is_none());
        drop(fixture.producer);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn healthy_stream_stale_stop_preserves_ordinary_replacement_after_preparing_join() {
    let mut fixture = pending_preparing_owner(50);
    let state = fixture.state.as_mut().unwrap();
    drain_source_commands(&mut state.active, &state.commands);
    assert_eq!(state.active.as_ref().unwrap().generation, 50);
    let (mut ordinary, _) = super::tests::source(48_000);
    ordinary.generation = 51;
    state
        .send_commands
        .send(SourceCommand::Install(Box::new(ordinary)))
        .unwrap();
    drain_source_commands(&mut state.active, &state.commands);
    tokio::time::timeout(Duration::from_secs(2), fixture.output.stop_and_wait())
        .await
        .unwrap()
        .unwrap();
    assert!(fixture.project.upgrade().is_none());

    stop_stream_state(
        &mut fixture.state,
        50,
        |stream| stream.failed.load(Ordering::Acquire),
        |stream, generation| {
            stream
                .send_commands
                .send(SourceCommand::Remove {
                    generation: Some(generation),
                })
                .unwrap();
        },
    );

    assert!(fixture.owner.upgrade().is_some());
    let state = fixture.state.as_mut().unwrap();
    drain_source_commands(&mut state.active, &state.commands);
    let active = state.active.as_mut().unwrap();
    assert_eq!(active.generation, 51);
    assert!(matches!(active.buffer, ActiveSourceBuffer::Ordinary(_)));
    let before = active.buffer.current_playhead_secs();
    render_source_block(active, &mut [0.0; 1024], 0.0);
    assert!(active.buffer.current_playhead_secs() > before);
    drop(fixture.state.take());
    assert!(fixture.owner.upgrade().is_none());
    drop(fixture.producer);
}

fn publish_audio_frames(
    producer: &cap_audio::ProgressiveAudioTestProducer,
    samples: &[f32],
    frames: std::ops::Range<usize>,
) {
    producer
        .append(cap_audio::AudioChunk {
            source_start_sample: frames.start as u64,
            channels: 2,
            samples: samples[frames.start * 2..frames.end * 2].to_vec(),
        })
        .unwrap();
}

async fn collect_gated_samples(
    blocks: &flume::Receiver<Vec<f32>>,
    actual: &mut Vec<f32>,
    expected: &[f32],
    limit_frames: usize,
) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while actual.len() < limit_frames * 2 {
            let block = blocks.recv_async().await.unwrap();
            for frame in block.chunks_exact(2) {
                if frame != [0.0, 0.0] {
                    assert!(frame.iter().all(|sample| *sample > 0.0));
                    actual.extend_from_slice(frame);
                }
            }
            assert!(actual.len() <= limit_frames * 2);
            assert_eq!(actual.as_slice(), &expected[..actual.len()]);
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn progressive_output_acknowledges_real_pcm_and_grows_the_same_gated_source() {
    let (blocks_tx, blocks) = flume::unbounded();
    let (control_tx, control_rx) = std_mpsc::channel();
    let control = std::thread::spawn(move || {
        control_thread_headless(
            control_rx,
            Box::new(move |samples, _| {
                let _ = blocks_tx.send(samples.to_vec());
            }),
        );
    });
    let output = AudioOutput {
        control_tx,
        next_generation: AtomicU64::new(0),
    };
    let (loader, producer) = cap_audio::ProgressiveAudioTestProducer::new();
    let sources = preparing_test_sources(loader.clone(), 70_000.0 / 48_000.0);
    let project = Arc::downgrade(&sources.project);
    let samples = (0..140_000)
        .map(|index| (index % 997 + 1) as f32 / 4096.0)
        .collect::<Vec<_>>();
    let ticket = output.prepare_progressive_playback(sources, 0.0, 0.1);
    let generation = ticket.generation;
    publish_audio_frames(&producer, &samples, 0..32_768);
    assert!(ticket.wait_started().await);
    assert!(!loader.progress().complete);
    let mut actual = Vec::new();
    collect_gated_samples(&blocks, &mut actual, &samples, 4800).await;
    for _ in 0..4 {
        let block = tokio::time::timeout(Duration::from_secs(2), blocks.recv_async())
            .await
            .unwrap()
            .unwrap();
        assert!(block.iter().all(|sample| *sample == 0.0));
    }
    let status = ticket.output_status(Instant::now()).unwrap();
    assert!(status.buffering);
    assert_eq!(status.playhead_seconds, 0.1);
    assert!(!status.ended);

    publish_audio_frames(&producer, &samples, 32_768..65_536);
    publish_audio_frames(&producer, &samples, 65_536..70_000);
    producer.finish().unwrap();
    ticket.set_playable_until(70_000.0 / 48_000.0).unwrap();
    collect_gated_samples(&blocks, &mut actual, &samples, 70_000).await;
    assert_eq!(actual, samples);
    assert_eq!(ticket.generation, generation);
    assert_eq!(
        output.next_generation.load(Ordering::Acquire),
        generation + 1
    );
    tokio::time::timeout(Duration::from_secs(2), ticket.stop_and_wait())
        .await
        .unwrap()
        .unwrap();
    assert!(project.upgrade().is_none());
    output.shutdown();
    tokio::time::timeout(
        Duration::from_secs(2),
        tokio::task::spawn_blocking(move || control.join().unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn progressive_output_without_a_prefix_never_acknowledges_and_cancels_cleanly() {
    let (blocks_tx, blocks) = flume::unbounded();
    let (control_tx, control_rx) = std_mpsc::channel();
    let control = std::thread::spawn(move || {
        control_thread_headless(
            control_rx,
            Box::new(move |samples, _| {
                let _ = blocks_tx.send(samples.iter().any(|sample| *sample != 0.0));
            }),
        );
    });
    let output = AudioOutput {
        control_tx,
        next_generation: AtomicU64::new(0),
    };
    let (loader, producer) = cap_audio::ProgressiveAudioTestProducer::new();
    let sources = preparing_test_sources(loader, 1.0);
    let project = Arc::downgrade(&sources.project);
    publish_audio_frames(&producer, &vec![0.25; 65_536], 0..32_768);
    let ticket = output.prepare_progressive_playback(sources, 0.0, 0.0);
    installed(&ticket).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(50), ticket.wait_started())
            .await
            .is_err()
    );
    for block in blocks.try_iter() {
        assert!(!block);
    }
    assert!(!ticket.request.started.load(Ordering::Acquire));
    assert_eq!(
        ticket
            .output_status(Instant::now())
            .unwrap()
            .playhead_seconds,
        0.0
    );
    tokio::time::timeout(Duration::from_secs(2), ticket.stop_and_wait())
        .await
        .unwrap()
        .unwrap();
    assert!(project.upgrade().is_none());
    drop(producer);
    output.shutdown();
    tokio::time::timeout(
        Duration::from_secs(2),
        tokio::task::spawn_blocking(move || control.join().unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
}

#[test]
fn studio_sound_refresh_changes_live_pcm_and_cannot_restart_stopped_audio() {
    let original = audible_spec();
    let mut enhanced = audible_spec();
    enhanced.project.audio.improve = true;
    let late_refresh = audible_spec();
    let (tx, rx) = std_mpsc::channel();
    let output = AudioOutput::new_headless(Box::new(move |samples, _| {
        let mean = samples.iter().map(|sample| sample.abs()).sum::<f32>() / samples.len() as f32;
        let _ = tx.send(mean);
    }));
    let generation = output.play(original).unwrap();
    let wait_for = |predicate: fn(f32) -> bool| {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let value = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if predicate(value) {
                break;
            }
        }
    };
    wait_for(|mean| mean > 0.1);
    output.refresh_playback(enhanced, generation);
    wait_for(|mean| mean > 0.005 && mean < 0.04);
    output.stop_playback(generation);
    wait_for(|mean| mean == 0.0);
    output.refresh_playback(late_refresh, generation);
    for _ in 0..30 {
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), 0.0);
    }
    output.shutdown();
}
