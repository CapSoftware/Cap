use super::*;
use serde_json::{Value, json};

const DURATIONS: [f64; 3] = [10.0, 6.0, 8.0];

fn probe(duration: f64) -> SegmentProbe {
    SegmentProbe {
        duration,
        display: (1920, 1080),
        camera: None,
        mic_channels: Some(1),
    }
}

fn probes() -> Vec<SegmentProbe> {
    DURATIONS.iter().copied().map(probe).collect()
}

fn segment_json(index: usize) -> Value {
    let dir = format!("content/segments/segment-{index}");
    json!({
        "display": { "path": format!("{dir}/display.mp4"), "fps": 30, "start_time": 0.0 },
        "mic": { "path": format!("{dir}/audio-input.ogg"), "start_time": 0.0 },
        "system_audio": { "path": format!("{dir}/system_audio.ogg"), "start_time": 0.0 },
        "cursor": format!("{dir}/cursor.json"),
    })
}

fn meta_json(segments: usize) -> Value {
    json!({
        "platform": "MacOS",
        "pretty_name": "Demo recording",
        "sharing": null,
        "segments": (0..segments).map(segment_json).collect::<Vec<_>>(),
        "cursors": {},
        "status": { "status": "Complete" },
    })
}

fn clip(recording: u32, start: f64, end: f64) -> Value {
    json!({ "recordingSegment": recording, "start": start, "end": end, "timescale": 1.0 })
}

/// Clip 1 deleted: the timeline plays segments 0 and 2. Captions run on the
/// source clock: segment 0 is 0..10, segment 1 is 10..16, segment 2 16..24.
fn config_json() -> Value {
    json!({
        "clipAlignmentVersion": cap_project::CLIP_ALIGNMENT_VERSION,
        "timeline": {
            "segments": [clip(0, 1.0, 9.0), clip(2, 0.5, 7.5)],
            "zoomSegments": [],
        },
        "clips": [
            { "index": 0, "offsets": { "camera": 0.0, "mic": 0.1, "system_audio": 0.0 } },
            { "index": 1, "offsets": { "camera": 0.0, "mic": 0.2, "system_audio": 0.0 } },
            { "index": 2, "offsets": { "camera": 0.0, "mic": 0.3, "system_audio": 0.05 } },
        ],
        "markers": [
            { "id": "a", "recordingSegment": 0, "time": 2.0, "label": "intro" },
            { "id": "b", "recordingSegment": 1, "time": 3.0 },
            { "id": "c", "recordingSegment": 2, "time": 4.0, "color": "#ff0000" },
        ],
        "captions": {
            "segments": [
                { "id": "c0", "start": 2.0, "end": 3.0, "text": "hello there", "words": [
                    { "text": "hello", "start": 2.0, "end": 2.4 },
                    { "text": "there", "start": 2.5, "end": 3.0 },
                ]},
                { "id": "c1", "start": 12.0, "end": 13.0, "text": "deleted words", "words": [] },
                { "id": "c2", "start": 15.5, "end": 17.0, "text": "straddles cut", "words": [
                    { "text": "straddles", "start": 15.5, "end": 15.9 },
                    { "text": "cut", "start": 16.5, "end": 17.0 },
                ]},
                { "id": "c3", "start": 18.0, "end": 19.0, "text": "kept later", "words": [] },
            ],
            "settings": {},
            "sourceTimed": true,
        },
    })
}

struct Fixture {
    root: tempfile::TempDir,
}

impl Fixture {
    fn with(meta: Value, config: Value) -> Self {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("Demo.cap");
        std::fs::create_dir(&project).unwrap();
        for (index, segment) in meta["segments"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            for key in ["display", "mic", "system_audio"] {
                if let Some(path) = segment[key]["path"].as_str() {
                    write_media(&project, path, index);
                }
            }
            if let Some(path) = segment["cursor"].as_str() {
                write_media(&project, path, index);
            }
        }
        std::fs::write(
            project.join(META),
            serde_json::to_vec_pretty(&meta).unwrap(),
        )
        .unwrap();
        std::fs::write(
            project.join(CONFIG),
            serde_json::to_vec_pretty(&config).unwrap(),
        )
        .unwrap();
        let fixture = Self { root };
        // Normalize the config the way the app saves it, so "unchanged" means
        // byte-identical to what the editor wrote.
        let loaded = ProjectConfiguration::load(fixture.project()).unwrap();
        loaded.write(fixture.project()).unwrap();
        fixture
    }

    fn new() -> Self {
        Self::with(meta_json(3), config_json())
    }

    fn project(&self) -> PathBuf {
        self.root.path().join("Demo.cap")
    }

    fn files(&self) -> (Vec<u8>, Vec<u8>) {
        (
            std::fs::read(self.project().join(META)).unwrap(),
            std::fs::read(self.project().join(CONFIG)).unwrap(),
        )
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot::read(&self.project()).unwrap()
    }

    fn plan(&self) -> Result<Plan, Skip> {
        plan(&self.snapshot(), &probes())
    }

    fn tree(&self) -> Vec<String> {
        let mut out = Vec::new();
        list(&self.project(), &self.project(), &mut out);
        out.sort();
        out
    }
}

fn list(root: &Path, dir: &Path, out: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            list(root, &path, out);
        } else {
            out.push(
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
}

fn write_media(project: &Path, relative: &str, index: usize) {
    let path = project.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, format!("media {index} {relative}").repeat(64)).unwrap();
}

fn assert_opens(project: &Path) {
    let meta = RecordingMeta::load_for_project(project).unwrap();
    let config = ProjectConfiguration::load(project).unwrap();
    let Some(StudioRecordingMeta::MultipleSegments { inner }) = meta.studio_meta() else {
        panic!("not multi-segment");
    };
    for segment in &inner.segments {
        for path in segment_paths(segment) {
            assert!(project.join(&path).is_file(), "{path} is missing");
        }
    }
    let count = inner.segments.len() as u32;
    for clip in &config.timeline.as_ref().unwrap().segments {
        assert!(clip.recording_clip < count);
    }
    for clip in &config.clips {
        assert!(clip.index < count);
    }
    for marker in &config.markers {
        assert!(marker.recording_clip < count);
    }
}

fn no_trash(_: &Path) -> Result<(), String> {
    Err("no trash in this test".into())
}

fn trash_into(dir: &Path) -> impl Fn(&Path) -> Result<(), String> + '_ {
    move |path: &Path| {
        std::fs::rename(path, dir.join(path.file_name().unwrap()))
            .map_err(|error| error.to_string())
    }
}

#[test]
fn remaps_every_reference_to_a_later_segment() {
    let fixture = Fixture::new();
    let plan = fixture.plan().unwrap();
    assert_eq!(plan.removed, vec![1]);
    assert_eq!(plan.folders, vec!["content/segments/segment-1"]);

    let Some(StudioRecordingMeta::MultipleSegments { inner }) = plan.meta.studio_meta() else {
        panic!("not multi-segment");
    };
    let displays: Vec<_> = inner
        .segments
        .iter()
        .map(|segment| segment.display.path.as_str().to_string())
        .collect();
    assert_eq!(
        displays,
        [
            "content/segments/segment-0/display.mp4",
            "content/segments/segment-2/display.mp4"
        ]
    );

    let timeline = plan.config.timeline.as_ref().unwrap();
    let clips: Vec<_> = timeline
        .segments
        .iter()
        .map(|clip| (clip.recording_clip, clip.start, clip.end))
        .collect();
    assert_eq!(clips, [(0, 1.0, 9.0), (1, 0.5, 7.5)]);

    let offsets: Vec<_> = plan
        .config
        .clips
        .iter()
        .map(|clip| (clip.index, clip.offsets.mic, clip.offsets.system_audio))
        .collect();
    assert_eq!(offsets, [(0, 0.1, 0.0), (1, 0.3, 0.05)]);

    let markers: Vec<_> = plan
        .config
        .markers
        .iter()
        .map(|marker| (marker.id.as_str(), marker.recording_clip, marker.time))
        .collect();
    assert_eq!(markers, [("a", 0, 2.0), ("c", 1, 4.0)]);
    assert_eq!(plan.config.markers[0].label, "intro");
    assert_eq!(plan.config.markers[1].color.as_deref(), Some("#ff0000"));

    let captions = &plan.config.captions.as_ref().unwrap().segments;
    let shown: Vec<_> = captions
        .iter()
        .map(|caption| {
            (
                caption.id.as_str(),
                caption.start,
                caption.end,
                caption.text.as_str(),
            )
        })
        .collect();
    assert_eq!(
        shown,
        [
            ("c0", 2.0, 3.0, "hello there"),
            ("c2", 10.0, 11.0, "cut"),
            ("c3", 12.0, 13.0, "kept later"),
        ]
    );
    assert_eq!(captions[0].words.len(), 2);
    let straddling: Vec<_> = captions[1]
        .words
        .iter()
        .map(|word| (word.text.as_str(), word.start, word.end))
        .collect();
    assert_eq!(straddling, [("cut", 10.5, 11.0)]);
}

#[test]
fn the_edit_renders_the_same_before_and_after() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let plan = fixture.plan().unwrap();
    let new_durations = [DURATIONS[0], DURATIONS[2]];
    assert!(same_result(
        &snapshot.config,
        &DURATIONS,
        &plan.config,
        &new_durations
    ));
    let mut old = snapshot.config.clone();
    cap_project::synchronize_captions(&mut old, &DURATIONS);
    let mut new = plan.config.clone();
    cap_project::synchronize_captions(&mut new, &new_durations);
    let ids = |config: &ProjectConfiguration| {
        config
            .timeline
            .as_ref()
            .unwrap()
            .caption_segments
            .iter()
            .map(|caption| (caption.id.clone(), caption.start, caption.end))
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&old), ids(&new));
    assert!(!ids(&old).is_empty());
}

#[test]
fn removing_several_segments_shifts_by_each_one() {
    let mut config = config_json();
    config["timeline"]["segments"] = json!([clip(1, 0.0, 6.0)]);
    config["captions"]["segments"] = json!([
        { "id": "x", "start": 11.0, "end": 12.0, "text": "middle", "words": [] },
    ]);
    config["markers"] = json!([{ "id": "m", "recordingSegment": 1, "time": 1.0 }]);
    let fixture = Fixture::with(meta_json(3), config);
    let plan = fixture.plan().unwrap();
    assert_eq!(plan.removed, vec![0, 2]);
    let timeline = plan.config.timeline.as_ref().unwrap();
    assert_eq!(timeline.segments[0].recording_clip, 0);
    assert_eq!(plan.config.markers[0].recording_clip, 0);
    assert_eq!(plan.config.clips.len(), 1);
    assert_eq!(plan.config.clips[0].offsets.mic, 0.2);
    let caption = &plan.config.captions.as_ref().unwrap().segments[0];
    assert_eq!((caption.start, caption.end), (1.0, 2.0));
}

#[test]
fn clip_offsets_are_not_rebuilt_when_only_removed_clips_had_them() {
    let mut config = config_json();
    config["clips"] = json!([
        { "index": 1, "offsets": { "camera": 0.0, "mic": 0.4, "system_audio": 0.0 } },
    ]);
    let fixture = Fixture::with(meta_json(3), config);
    let plan = fixture.plan().unwrap();
    assert_eq!(plan.config.clips.len(), 1);
    assert_eq!(plan.config.clips[0].index, 0);
    assert_eq!(plan.config.clips[0].offsets.mic, 0.0);
    assert!(!plan.config.clips[0].offsets_auto_calculated);
}

#[test]
fn cuts_merge_adjacent_segments() {
    assert_eq!(
        cuts(&[1.0, 2.0, 3.0, 4.0], &[1, 2]),
        vec![Cut {
            start: 1.0,
            end: 6.0
        }]
    );
    assert_eq!(collapse(7.0, &cuts(&[1.0, 2.0, 3.0, 4.0], &[1, 2])), 2.0);
    assert_eq!(remap_index(3, &[1, 2]), Some(1));
    assert_eq!(remap_index(2, &[1, 2]), None);
    assert_eq!(remap_index(0, &[1, 2]), Some(0));
}

#[test]
fn an_older_project_with_late_audio_still_to_migrate_is_left_alone() {
    let mut meta = meta_json(3);
    meta["segments"][2]["mic"]["start_time"] = json!(3.0);
    let mut config = config_json();
    config["clipAlignmentVersion"] = json!(0);
    assert_eq!(skip_for(meta, config), Skip::ClipAlignment);
}

#[test]
fn an_older_project_with_nothing_to_migrate_is_cleaned_at_the_current_version() {
    let mut config = config_json();
    config["clipAlignmentVersion"] = json!(0);
    let fixture = Fixture::with(meta_json(3), config);
    assert_eq!(fixture.snapshot().config.clip_alignment_version, 0);
    let plan = fixture.plan().unwrap();
    assert_eq!(plan.removed, vec![1]);
    assert_eq!(
        plan.config.clip_alignment_version,
        cap_project::CLIP_ALIGNMENT_VERSION
    );
    run(&fixture.project(), &Request::from_probes(probes())).unwrap();
    assert_eq!(
        ProjectConfiguration::load(fixture.project())
            .unwrap()
            .clip_alignment_version,
        cap_project::CLIP_ALIGNMENT_VERSION
    );
    assert_opens(&fixture.project());
}

#[test]
fn captions_tied_to_a_clip_move_with_it() {
    let mut config = config_json();
    config["captions"]["segments"] = json!([
        { "id": "tail0", "start": 10.2, "end": 10.8, "text": "held tail", "words": [], "recordingSegment": 0 },
        { "id": "gone", "start": 11.0, "end": 12.0, "text": "removed clip", "words": [], "recordingSegment": 1 },
        { "id": "tied2", "start": 17.0, "end": 18.0, "text": "kept later", "recordingSegment": 2, "words": [
            { "text": "kept", "start": 17.0, "end": 17.4 },
            { "text": "later", "start": 17.5, "end": 18.0 },
        ]},
        { "id": "free", "start": 18.5, "end": 19.0, "text": "untied", "words": [] },
    ]);
    let fixture = Fixture::with(meta_json(3), config);
    let plan = fixture.plan().unwrap();
    let captions = &plan.config.captions.as_ref().unwrap().segments;
    let shown: Vec<_> = captions
        .iter()
        .map(|caption| {
            (
                caption.id.as_str(),
                caption.start,
                caption.end,
                caption.recording_clip,
            )
        })
        .collect();
    assert_eq!(
        shown,
        [
            ("tail0", 10.2, 10.8, Some(0)),
            ("tied2", 11.0, 12.0, Some(1)),
            ("free", 12.5, 13.0, None),
        ]
    );
    let words: Vec<_> = captions[1]
        .words
        .iter()
        .map(|word| (word.start, word.end))
        .collect();
    assert_eq!(words, [(11.0, 11.4), (11.5, 12.0)]);
}

#[test]
fn edit_time_captions_are_left_as_they_are() {
    let mut config = config_json();
    config["captions"]["sourceTimed"] = json!(false);
    let fixture = Fixture::with(meta_json(3), config);
    let snapshot = fixture.snapshot();
    let plan = plan(&snapshot, &probes()).unwrap();
    let before = &snapshot.config.captions.as_ref().unwrap().segments;
    let after = &plan.config.captions.as_ref().unwrap().segments;
    assert_eq!(before.len(), after.len());
}

#[test]
fn a_project_with_nothing_unused_stays_byte_identical() {
    let mut config = config_json();
    config["timeline"]["segments"] =
        json!([clip(0, 0.0, 10.0), clip(1, 0.0, 6.0), clip(2, 0.0, 8.0)]);
    let fixture = Fixture::with(meta_json(3), config);
    let before = fixture.files();
    let tree = fixture.tree();
    assert_eq!(fixture.plan().unwrap_err(), Skip::NothingUnused);
    assert_eq!(
        run(&fixture.project(), &Request::from_probes(probes())).unwrap(),
        Outcome::Skipped(Skip::NothingUnused)
    );
    assert_eq!(fixture.files(), before);
    assert_eq!(fixture.tree(), tree);
}

#[test]
fn the_close_check_skips_projects_with_every_segment_used() {
    let segment = |duration: f64| cap_rendering::SegmentRecordings {
        display: cap_rendering::Video {
            duration,
            width: 1920,
            height: 1080,
            fps: 30,
            start_time: 0.0,
        },
        camera: None,
        mic: None,
        system_audio: None,
    };
    let recordings = ProjectRecordingsMeta {
        segments: vec![segment(10.0), segment(6.0), segment(8.0)],
    };
    let mut config: ProjectConfiguration = serde_json::from_value(config_json()).unwrap();
    assert!(Request::new(&config, &recordings).is_some());
    config.timeline.as_mut().unwrap().segments[1].recording_clip = 1;
    config
        .timeline
        .as_mut()
        .unwrap()
        .segments
        .push(serde_json::from_value(clip(2, 0.0, 1.0)).unwrap());
    assert!(Request::new(&config, &recordings).is_none());
    let single = ProjectRecordingsMeta {
        segments: vec![segment(10.0)],
    };
    assert!(Request::new(&config, &single).is_none());
}

fn skip_for(meta: Value, config: Value) -> Skip {
    let fixture = Fixture::with(meta, config);
    let before = fixture.files();
    let tree = fixture.tree();
    let outcome = run(&fixture.project(), &Request::from_probes(probes())).unwrap();
    assert!(trash_staged(&fixture.project(), &no_trash));
    assert_eq!(fixture.files(), before, "skipped project changed");
    assert_eq!(fixture.tree(), tree, "skipped project changed");
    match outcome {
        Outcome::Skipped(skip) => skip,
        other => panic!("cleaned: {other:?}"),
    }
}

#[test]
fn every_skip_condition_leaves_the_project_untouched() {
    let instant = json!({
        "platform": "MacOS", "pretty_name": "Instant", "sharing": null,
        "fps": 30, "sample_rate": null,
    });
    let fixture = Fixture::with(meta_json(3), config_json());
    std::fs::write(
        fixture.project().join(META),
        serde_json::to_vec(&instant).unwrap(),
    )
    .unwrap();
    assert_eq!(
        plan(&fixture.snapshot(), &probes()).unwrap_err(),
        Skip::NotStudio
    );

    let single = json!({
        "platform": "MacOS", "pretty_name": "Single", "sharing": null,
        "display": { "path": "content/display.mp4", "fps": 30 },
    });
    let fixture = Fixture::with(meta_json(3), config_json());
    std::fs::write(
        fixture.project().join(META),
        serde_json::to_vec(&single).unwrap(),
    )
    .unwrap();
    assert_eq!(
        plan(&fixture.snapshot(), &probes()).unwrap_err(),
        Skip::SingleSegment
    );

    for status in ["InProgress", "NeedsRemux"] {
        let mut meta = meta_json(3);
        meta["status"] = json!({ "status": status });
        assert_eq!(skip_for(meta, config_json()), Skip::Unfinished, "{status}");
    }
    let mut meta = meta_json(3);
    meta["status"] = json!({ "status": "Failed", "error": "boom" });
    assert_eq!(skip_for(meta, config_json()), Skip::Unfinished);

    let mut meta = meta_json(3);
    meta["upload"] = json!({
        "state": "SinglePartUpload", "video_id": "v", "recording_dir": "/r",
        "file_path": "/f", "screenshot_path": "/s",
    });
    assert_eq!(skip_for(meta, config_json()), Skip::UploadPending);

    let mut config = config_json();
    config["timeline"]["segments"] = json!([clip(0, 0.0, 1.0), clip(3, 0.0, 1.0)]);
    assert_eq!(skip_for(meta_json(3), config), Skip::ClipOutOfRange);

    let mut config = config_json();
    config["timeline"] = Value::Null;
    assert_eq!(skip_for(meta_json(3), config), Skip::NoTimeline);

    let mut config = config_json();
    config["timeline"]["keyboardSegments"] = json!([
        { "id": "kb-0", "start": 0.0, "end": 1.0, "displayText": "A", "keys": [] },
    ]);
    assert_eq!(skip_for(meta_json(3), config), Skip::LegacyKeyboard);

    let mut config = config_json();
    config["captions"] = Value::Null;
    let fixture = Fixture::with(meta_json(3), config);
    std::fs::write(fixture.project().join("captions.json"), b"{}").unwrap();
    assert_eq!(
        plan(&fixture.snapshot(), &probes()).unwrap_err(),
        Skip::LegacyCaptions
    );

    let mut config = config_json();
    config["clipAlignmentVersion"] = json!(cap_project::CLIP_ALIGNMENT_VERSION + 1);
    assert_eq!(skip_for(meta_json(3), config), Skip::ClipAlignment);

    let fixture = Fixture::new();
    let mut short = probes();
    short.pop();
    assert_eq!(
        plan(&fixture.snapshot(), &short).unwrap_err(),
        Skip::ProbeMismatch
    );
}

#[test]
fn track_failures_keep_the_media() {
    let fixture = Fixture::new();
    std::fs::write(
        fixture.project().join(DIAGNOSTICS),
        br#"{"version":1,"segments":[{"segmentIndex":1,"trackFailures":[{"track":"camera","stage":"runtime","error":"x"}]}]}"#,
    )
    .unwrap();
    assert_eq!(fixture.plan().unwrap_err(), Skip::TrackFailures);

    std::fs::write(
        fixture.project().join(DIAGNOSTICS),
        br#"{"version":1,"segments":[{"segmentIndex":0,"trackFailures":[]},{"segmentIndex":1,"trackFailures":[]}]}"#,
    )
    .unwrap();
    assert!(fixture.plan().is_ok());
}

#[test]
fn media_another_segment_still_uses_is_kept() {
    let mut meta = meta_json(3);
    meta["segments"][2]["cursor"] = json!("content/segments/segment-1/cursor.json");
    assert_eq!(skip_for(meta, config_json()), Skip::NothingRemovable);

    let mut meta = meta_json(3);
    meta["segments"][1]["display"]["path"] = json!("content/display.mp4");
    assert_eq!(skip_for(meta, config_json()), Skip::NothingRemovable);

    let mut config = config_json();
    config["timeline"]["audioSegments"] = json!([{
        "start": 0.0, "end": 1.0, "track": 0,
        "path": "content/segments/segment-1/audio-input.ogg",
    }]);
    assert_eq!(skip_for(meta_json(3), config), Skip::NothingRemovable);
}

#[test]
fn the_first_segment_stays_when_it_sets_the_canvas() {
    let mut config = config_json();
    config["timeline"]["segments"] = json!([clip(1, 0.0, 6.0), clip(2, 0.0, 8.0)]);
    let fixture = Fixture::with(meta_json(3), config);
    let mut different = probes();
    different[0].display = (2560, 1440);
    assert_eq!(
        plan(&fixture.snapshot(), &different).unwrap_err(),
        Skip::NothingRemovable
    );

    let plan = fixture.plan().unwrap();
    assert_eq!(plan.removed, vec![0]);
    assert_eq!(
        plan.config.timeline.as_ref().unwrap().segments[0].recording_clip,
        0
    );
}

#[test]
fn every_crash_point_leaves_a_project_that_opens() {
    for step in Step::ALL {
        let fixture = Fixture::new();
        let original = fixture.files();
        let snapshot = fixture.snapshot();
        let plan = fixture.plan().unwrap();
        commit(
            &fixture.project(),
            &snapshot,
            &plan,
            "2026-11-17 10.00.00",
            "Demo (removed clips)",
            step,
        )
        .unwrap();

        settle(&fixture.project()).unwrap();
        assert!(!fixture.project().join(JOURNAL).exists(), "{step:?}");
        assert_opens(&fixture.project());
        let backup = fixture.project().join("backups/2026-11-17 10.00.00");
        assert_eq!(
            std::fs::read(backup.join(META)).unwrap(),
            original.0,
            "{step:?}"
        );
        assert_eq!(
            std::fs::read(backup.join(CONFIG)).unwrap(),
            original.1,
            "{step:?}"
        );
        if step == Step::Done {
            assert_ne!(fixture.files(), original);
            assert!(
                !fixture
                    .project()
                    .join("content/segments/segment-1")
                    .exists()
            );
            assert!(
                fixture
                    .project()
                    .join("content/removed-media/2026-11-17 10.00.00/Demo (removed clips)/segment-1/display.mp4")
                    .is_file()
            );
        } else {
            assert_eq!(fixture.files(), original, "{step:?}");
            assert!(
                fixture
                    .project()
                    .join("content/segments/segment-1/display.mp4")
                    .is_file(),
                "{step:?}"
            );
            assert!(!fixture.project().join(STAGING).exists(), "{step:?}");
        }
    }
}

#[test]
fn a_failed_step_rolls_back_at_once() {
    let fixture = Fixture::new();
    let original = fixture.files();
    let snapshot = fixture.snapshot();
    let mut plan = fixture.plan().unwrap();
    write_media(
        &fixture.project(),
        "content/segments/x/segment-1/clash.bin",
        9,
    );
    plan.folders.push("content/segments/x/segment-1".into());
    let error = commit(
        &fixture.project(),
        &snapshot,
        &plan,
        "stamp",
        "label",
        Step::Done,
    )
    .unwrap_err();
    assert!(!error.to_string().contains("missing"), "{error}");
    assert_eq!(fixture.files(), original);
    assert!(!fixture.project().join(JOURNAL).exists());
    assert!(
        fixture
            .project()
            .join("content/segments/x/segment-1/clash.bin")
            .is_file()
    );
    assert_opens(&fixture.project());
}

#[test]
fn a_missing_segment_folder_stops_the_cleanup_before_any_write() {
    let fixture = Fixture::new();
    let original = fixture.files();
    let snapshot = fixture.snapshot();
    let mut plan = fixture.plan().unwrap();
    plan.folders.push("content/segments/segment-9".into());
    assert!(
        commit(
            &fixture.project(),
            &snapshot,
            &plan,
            "stamp",
            "label",
            Step::Done
        )
        .is_err()
    );
    assert_eq!(fixture.files(), original);
    assert!(!fixture.project().join(BACKUPS).exists());
    assert!(!fixture.project().join(JOURNAL).exists());
}

fn segment_count(project: &Path) -> usize {
    match RecordingMeta::load_for_project(project)
        .unwrap()
        .studio_meta()
        .unwrap()
    {
        StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
        StudioRecordingMeta::SingleSegment { .. } => 1,
    }
}

#[test]
fn lost_staged_media_rolls_forward_instead_of_stranding_the_project() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let plan = fixture.plan().unwrap();
    let staged = commit(
        &fixture.project(),
        &snapshot,
        &plan,
        "stamp",
        "label",
        Step::Stage,
    )
    .unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    std::fs::rename(staged.join("label"), elsewhere.path().join("label")).unwrap();

    settle(&fixture.project()).unwrap();
    assert!(!fixture.project().join(JOURNAL).exists());
    assert_eq!(segment_count(&fixture.project()), 2);
    assert_opens(&fixture.project());
}

#[test]
fn a_crash_between_the_two_files_with_the_media_gone_rolls_forward() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let plan = fixture.plan().unwrap();
    commit(
        &fixture.project(),
        &snapshot,
        &plan,
        "stamp",
        "label",
        Step::Config,
    )
    .unwrap();
    std::fs::remove_dir_all(fixture.project().join("content/segments/segment-1")).unwrap();

    settle(&fixture.project()).unwrap();
    assert!(!fixture.project().join(JOURNAL).exists());
    assert_eq!(segment_count(&fixture.project()), 2);
    assert_opens(&fixture.project());
}

#[cfg(unix)]
#[test]
fn an_unreadable_cleanup_keeps_its_journal_until_it_can_be_read() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let original = fixture.files();
    let snapshot = fixture.snapshot();
    let plan = fixture.plan().unwrap();
    let staged = commit(
        &fixture.project(),
        &snapshot,
        &plan,
        "stamp",
        "label",
        Step::Stage,
    )
    .unwrap();
    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o000)).unwrap();
    let blocked = std::fs::read_dir(&staged).is_err();
    let result = settle(&fixture.project());
    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).unwrap();
    if blocked {
        assert!(result.is_err());
        assert!(fixture.project().join(JOURNAL).exists());
        assert!(staged.join("label/segment-1/display.mp4").is_file());
        settle(&fixture.project()).unwrap();
    }
    assert!(!fixture.project().join(JOURNAL).exists());
    assert_eq!(fixture.files(), original);
    assert_opens(&fixture.project());
}

#[cfg(unix)]
#[test]
fn recovery_never_moves_media_out_through_a_linked_parent() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let plan = fixture.plan().unwrap();
    commit(
        &fixture.project(),
        &snapshot,
        &plan,
        "stamp",
        "label",
        Step::Stage,
    )
    .unwrap();
    let outside = tempfile::tempdir().unwrap();
    let segments = fixture.project().join("content/segments");
    std::fs::rename(&segments, outside.path().join("real-segments")).unwrap();
    std::fs::create_dir(outside.path().join("elsewhere")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("elsewhere"), &segments).unwrap();

    assert!(settle(&fixture.project()).is_err());
    assert!(!outside.path().join("elsewhere/segment-1").exists());
    assert!(
        fixture
            .project()
            .join("content/removed-media/stamp/label/segment-1/display.mp4")
            .is_file()
    );
    assert!(fixture.project().join(JOURNAL).exists());
}

#[cfg(unix)]
#[test]
fn recovery_never_pulls_outside_folders_in_through_a_linked_parent() {
    let fixture = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    let foreign = outside.path().join("stamp/label/segment-1");
    std::fs::create_dir_all(&foreign).unwrap();
    std::fs::write(foreign.join("keep.txt"), b"not the project's").unwrap();
    std::os::unix::fs::symlink(outside.path(), fixture.project().join(STAGING)).unwrap();
    std::fs::remove_dir_all(fixture.project().join("content/segments/segment-1")).unwrap();
    std::fs::create_dir_all(fixture.project().join("backups/b")).unwrap();
    std::fs::write(
        fixture.project().join(JOURNAL),
        br#"{"backup":"backups/b","staging":"content/removed-media/stamp","folders":["content/segments/segment-1"]}"#,
    )
    .unwrap();

    assert!(settle(&fixture.project()).is_err());
    assert!(foreign.join("keep.txt").is_file());
    assert!(
        !fixture
            .project()
            .join("content/segments/segment-1")
            .exists()
    );
}

#[cfg(unix)]
#[test]
fn the_trash_never_follows_links_out_of_the_project() {
    let fixture = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir(outside.path().join("precious")).unwrap();
    std::fs::write(outside.path().join("precious/file.txt"), b"keep").unwrap();
    std::fs::create_dir_all(fixture.project().join(STAGING)).unwrap();
    std::os::unix::fs::symlink(
        outside.path(),
        fixture.project().join(STAGING).join("stamp"),
    )
    .unwrap();
    std::fs::create_dir(fixture.project().join(STAGING).join("real")).unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("precious"),
        fixture.project().join(STAGING).join("real/label"),
    )
    .unwrap();

    let called = std::sync::Mutex::new(Vec::new());
    let trash = |path: &Path| -> Result<(), String> {
        called.lock().unwrap().push(path.to_path_buf());
        Ok(())
    };
    assert!(!trash_staged(&fixture.project(), &trash));
    assert!(called.lock().unwrap().is_empty());
    assert!(outside.path().join("precious/file.txt").is_file());

    std::fs::remove_dir_all(fixture.project().join(STAGING)).unwrap();
    let linked = tempfile::tempdir().unwrap();
    std::fs::create_dir(linked.path().join("stamp")).unwrap();
    std::fs::create_dir(linked.path().join("stamp/label")).unwrap();
    std::os::unix::fs::symlink(linked.path(), fixture.project().join(STAGING)).unwrap();
    assert!(!trash_staged(&fixture.project(), &trash));
    assert!(called.lock().unwrap().is_empty());
    assert!(linked.path().join("stamp/label").is_dir());
}

#[test]
fn a_project_changed_since_the_snapshot_is_left_alone() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let plan = fixture.plan().unwrap();
    let mut config = snapshot.config.clone();
    config.background.padding = 12.0;
    config.write(fixture.project()).unwrap();
    let changed = fixture.files();
    assert!(
        commit(
            &fixture.project(),
            &snapshot,
            &plan,
            "stamp",
            "label",
            Step::Done
        )
        .is_err()
    );
    assert_eq!(fixture.files(), changed);
    assert!(!fixture.project().join(BACKUPS).exists());
}

#[test]
fn a_journal_pointing_outside_the_project_is_refused() {
    let fixture = Fixture::new();
    std::fs::write(
        fixture.project().join(JOURNAL),
        br#"{"backup":"backups/x","staging":"content/removed-media/x","folders":["content/segments/../../elsewhere"]}"#,
    )
    .unwrap();
    assert!(roll_back(&fixture.project()).is_err());
    assert!(fixture.project().join(JOURNAL).exists());
}

#[test]
fn cleaning_moves_the_media_to_the_trash_and_keeps_a_backup() {
    let fixture = Fixture::new();
    let original = fixture.files();
    let trash_dir = tempfile::tempdir().unwrap();
    let trashed = std::sync::Mutex::new(Vec::new());
    let trash = |path: &Path| -> Result<(), String> {
        let target = trash_dir.path().join(path.file_name().unwrap());
        std::fs::rename(path, &target).map_err(|error| error.to_string())?;
        trashed.lock().unwrap().push(target);
        Ok(())
    };
    let outcome = run(&fixture.project(), &Request::from_probes(probes())).unwrap();
    let Outcome::Cleaned { removed, bytes } = outcome else {
        panic!("{outcome:?}");
    };
    assert_eq!(removed, vec![1]);
    assert!(bytes > 0);
    assert!(trash_staged(&fixture.project(), &trash));
    let trashed = trashed.lock().unwrap().clone();
    assert_eq!(trashed.len(), 1);
    assert_eq!(
        trashed[0].file_name().unwrap().to_string_lossy(),
        "Demo recording (removed clips)"
    );
    assert!(trashed[0].join("segment-1/display.mp4").is_file());
    assert!(trashed[0].join("segment-1/audio-input.ogg").is_file());
    assert!(trashed[0].join("segment-1/system_audio.ogg").is_file());
    assert!(trashed[0].join("segment-1/cursor.json").is_file());
    assert!(!fixture.project().join(STAGING).exists());
    assert!(!fixture.project().join(JOURNAL).exists());
    assert_opens(&fixture.project());

    let backups: Vec<_> = std::fs::read_dir(fixture.project().join(BACKUPS))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(
        std::fs::read(backups[0].path().join(META)).unwrap(),
        original.0
    );

    let again = run(&fixture.project(), &Request::from_probes(probes()));
    assert!(matches!(again, Ok(Outcome::Skipped(_))), "{again:?}");
}

#[test]
fn media_the_trash_refused_is_trashed_on_a_later_close() {
    let fixture = Fixture::new();
    let outcome = run(&fixture.project(), &Request::from_probes(probes())).unwrap();
    assert!(matches!(outcome, Outcome::Cleaned { .. }));
    assert!(!trash_staged(&fixture.project(), &no_trash));
    assert!(fixture.project().join(STAGING).exists());
    assert_opens(&fixture.project());

    let trash_dir = tempfile::tempdir().unwrap();
    assert!(trash_staged(
        &fixture.project(),
        &trash_into(trash_dir.path())
    ));
    assert!(!fixture.project().join(STAGING).exists());
    assert!(
        trash_dir
            .path()
            .join("Demo recording (removed clips)/segment-1/display.mp4")
            .is_file()
    );
}

#[test]
fn settle_waits_for_a_cleanup_in_this_process() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let fixture = Fixture::new();
    let key = fixture.project().canonicalize().unwrap();
    let claim = Claim::take(&key).unwrap();
    assert!(Claim::take(&key).is_none());
    let released = std::sync::Arc::new(AtomicBool::new(false));
    let flag = released.clone();
    let project = fixture.project();
    let settling = std::thread::spawn(move || {
        let result = settle(&project);
        (result, flag.load(Ordering::SeqCst))
    });
    let mut waiting = SETTLE_WAITING
        .projects
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    while !waiting.contains(&key) {
        waiting = SETTLE_WAITING
            .released
            .wait(waiting)
            .unwrap_or_else(PoisonError::into_inner);
    }
    waiting.retain(|held| held != &key);
    drop(waiting);
    released.store(true, Ordering::SeqCst);
    drop(claim);
    let (result, released_first) = settling.join().unwrap();
    result.unwrap();
    assert!(released_first);
}

#[test]
fn trashing_one_project_never_waits_on_another() {
    let busy = Fixture::new();
    let idle = Fixture::new();
    run(&idle.project(), &Request::from_probes(probes())).unwrap();
    let held = staging_lock(&busy.project());
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let project = idle.project();
    let worker = std::thread::spawn(move || {
        let trash_dir = tempfile::tempdir().unwrap();
        done_tx
            .send(trash_staged(&project, &trash_into(trash_dir.path())))
            .unwrap();
    });
    assert_eq!(done_rx.recv_timeout(Duration::from_secs(10)), Ok(true));
    drop(held);
    worker.join().unwrap();
}

#[test]
fn a_cleanup_never_waits_on_its_own_project_trash() {
    let fixture = Fixture::new();
    let before = fixture.files();
    let held = staging_lock(&fixture.project());
    assert_eq!(
        run(&fixture.project(), &Request::from_probes(probes())).unwrap(),
        Outcome::Skipped(Skip::TrashInProgress)
    );
    drop(held);
    assert_eq!(fixture.files(), before);
}

/// FFmpeg opens media without `FILE_SHARE_DELETE`, and the closing editor's
/// decoders let go of it a few seconds after the window closes, which keeps
/// Windows from moving the folder until then.
#[cfg(windows)]
#[test]
fn media_still_open_when_the_editor_closes_is_cleaned_once_released() {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 1;
    let fixture = Fixture::new();
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(
            fixture
                .project()
                .join("content/segments/segment-1/display.mp4"),
        )
        .unwrap();
    let (busy_tx, busy_rx) = std::sync::mpsc::channel();
    let release = std::thread::spawn(move || {
        busy_rx.recv().unwrap();
        drop(held);
    });
    let in_use = |folder: &Path| {
        let busy = folder_in_use(folder)?;
        if busy {
            busy_tx.send(()).ok();
        }
        Ok(busy)
    };
    let outcome = run_waiting(
        &fixture.project(),
        &Request::from_probes(probes()),
        COMMIT_RELEASE_WAIT,
        &in_use,
    )
    .unwrap();
    release.join().unwrap();
    assert!(matches!(outcome, Outcome::Cleaned { .. }), "{outcome:?}");
    assert!(
        !fixture
            .project()
            .join("content/segments/segment-1")
            .exists()
    );
    assert_opens(&fixture.project());
}

#[test]
fn removed_media_still_in_use_is_waited_for() {
    let fixture = Fixture::new();
    let checks = std::sync::atomic::AtomicUsize::new(0);
    let in_use = |_: &Path| -> io::Result<bool> {
        Ok(checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 3)
    };
    let outcome = run_waiting(
        &fixture.project(),
        &Request::from_probes(probes()),
        Duration::from_secs(5),
        &in_use,
    )
    .unwrap();
    assert!(matches!(outcome, Outcome::Cleaned { .. }), "{outcome:?}");
    assert!(checks.load(std::sync::atomic::Ordering::SeqCst) >= 4);
    assert_opens(&fixture.project());
}

#[test]
fn waiting_for_free_media_writes_nothing() {
    let fixture = Fixture::new();
    let before = fixture.files();
    let tree = fixture.tree();
    let started = std::time::Instant::now();
    assert!(wait_until_free(
        &fixture.project(),
        &Request::from_probes(probes())
    ));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(fixture.files(), before);
    assert_eq!(fixture.tree(), tree);
}

#[test]
fn removed_media_that_stays_in_use_leaves_the_project_untouched() {
    let fixture = Fixture::new();
    let before = fixture.files();
    let tree = fixture.tree();
    let outcome = run_waiting(
        &fixture.project(),
        &Request::from_probes(probes()),
        Duration::from_millis(300),
        &|_: &Path| Ok(true),
    )
    .unwrap();
    assert_eq!(outcome, Outcome::Skipped(Skip::MediaInUse));
    assert_eq!(fixture.files(), before);
    assert_eq!(fixture.tree(), tree);
}

#[cfg(windows)]
#[test]
fn media_held_open_for_good_leaves_the_project_untouched() {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 1;
    let fixture = Fixture::new();
    let before = fixture.files();
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(
            fixture
                .project()
                .join("content/segments/segment-1/display.mp4"),
        )
        .unwrap();
    let outcome = run_waiting(
        &fixture.project(),
        &Request::from_probes(probes()),
        Duration::from_millis(500),
        &folder_in_use,
    )
    .unwrap();
    drop(held);
    assert_eq!(outcome, Outcome::Skipped(Skip::MediaInUse));
    assert_eq!(fixture.files(), before);
    assert!(!fixture.project().join(BACKUPS).exists());
}

#[cfg(windows)]
#[test]
fn only_fixed_local_drives_have_a_recycle_bin() {
    let temp = std::env::temp_dir();
    assert!(has_recycle_bin(&temp), "{}", temp.display());
    let verbatim = temp.canonicalize().unwrap();
    assert!(has_recycle_bin(&verbatim), "{}", verbatim.display());
    for remote in [
        r"\\server\share\Project.cap\content\removed-media",
        r"\\?\UNC\server\share\Project.cap",
        r"\\.\pipe\Project.cap",
        r"relative\Project.cap",
    ] {
        assert!(!has_recycle_bin(Path::new(remote)), "{remote}");
        assert!(move_to_trash(Path::new(remote)).is_err(), "{remote}");
    }
}

/// Windows has no Recycle Bin for a network path, so a trash there deletes
/// for good. Reached through the administrative share when the test machine
/// has one.
#[cfg(windows)]
#[test]
fn media_on_a_network_path_is_never_deleted_by_the_trash() {
    let fixture = Fixture::new();
    let local = fixture.project().canonicalize().unwrap();
    let local_text = local.to_string_lossy().to_string();
    let plain = local_text.trim_start_matches(r"\\?\");
    let (drive, rest) = plain.split_at(2);
    let remote = PathBuf::from(format!(r"\\localhost\{}${}", &drive[..1], rest));
    if !remote.join("recording-meta.json").is_file() {
        eprintln!("no administrative share at {}; skipping", remote.display());
        return;
    }
    let outcome = run(&remote, &Request::from_probes(probes())).unwrap();
    assert!(matches!(outcome, Outcome::Cleaned { .. }), "{outcome:?}");
    assert!(!trash_staged(&remote, &move_to_trash));
    let staged: Vec<_> = std::fs::read_dir(local.join(STAGING))
        .unwrap()
        .flatten()
        .flat_map(|stamp| std::fs::read_dir(stamp.path()).unwrap().flatten())
        .map(|label| label.path().join("segment-1/display.mp4"))
        .collect();
    assert_eq!(staged.len(), 1);
    assert!(staged[0].is_file(), "{staged:?}");
}

#[test]
fn busy_projects_are_never_touched() {
    assert_eq!(Busy::default().reason(), None);
    for busy in [
        Busy {
            open_in_editor: true,
            ..Busy::default()
        },
        Busy {
            deleting: true,
            ..Busy::default()
        },
        Busy {
            recording: true,
            ..Busy::default()
        },
        Busy {
            exporting_or_uploading: true,
            ..Busy::default()
        },
        Busy {
            automation: true,
            ..Busy::default()
        },
    ] {
        assert!(busy.reason().is_some(), "{busy:?}");
    }
}

#[test]
fn trash_labels_are_safe_file_names() {
    assert_eq!(trash_label("My/Recording"), "MyRecording (removed clips)");
    assert_eq!(trash_label("   "), "Cap (removed clips)");
}
