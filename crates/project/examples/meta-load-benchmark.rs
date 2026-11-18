use cap_project::{
    AudioMeta, CursorMeta, Cursors, MultipleSegment, MultipleSegments, RecordingMeta,
    RecordingMetaInner, StudioRecordingMeta, StudioRecordingStatus, VideoMeta, XY,
};
use std::{
    collections::{HashMap, hash_map::DefaultHasher},
    error::Error,
    hash::{Hash, Hasher},
    hint::black_box,
    time::Instant,
};

const LEGACY_PREFIX: &str = "/Users/cap/Library/Application Support/so.cap.desktop/recordings/Cap 2026-11-03 at 12.00.00.cap";

fn display_path(style: &str, index: usize) -> String {
    let relative = format!("content/segments/segment-{index}/display.mp4");
    match style {
        "absolute" => format!("{LEGACY_PREFIX}/{relative}"),
        "windows" => format!(
            "C:\\Users\\cap\\recordings\\recording.cap\\{}",
            relative.replace('/', "\\")
        ),
        _ => relative,
    }
}

fn video(style: &str, index: usize) -> VideoMeta {
    VideoMeta {
        path: display_path(style, index).into(),
        fps: 30,
        start_time: Some(0.0),
        device_id: None,
    }
}

fn audio(style: &str, index: usize, track: &str) -> AudioMeta {
    let relative = format!("content/segments/segment-{index}/{track}.m4a");
    let path = match style {
        "absolute" => format!("{LEGACY_PREFIX}/{relative}"),
        "windows" => format!(
            "C:\\Users\\cap\\recordings\\recording.cap\\{}",
            relative.replace('/', "\\")
        ),
        _ => relative,
    };
    AudioMeta {
        path: path.into(),
        start_time: Some(0.0),
        device_id: None,
        gap_summary: None,
        digital_silence_ms: None,
    }
}

fn cursor_path(style: &str, index: usize) -> String {
    let relative = format!("content/cursors/shape-{index}.png");
    match style {
        "absolute" => format!("{LEGACY_PREFIX}/{relative}"),
        "windows" => format!(
            "C:\\Users\\cap\\recordings\\recording.cap\\{}",
            relative.replace('/', "\\")
        ),
        _ => relative,
    }
}

fn meta(style: &str, segments: usize, cursors: usize) -> RecordingMeta {
    let segments = (0..segments)
        .map(|index| MultipleSegment {
            display: video(style, index),
            camera: Some(video(style, index)),
            mic: Some(audio(style, index, "mic")),
            system_audio: Some(audio(style, index, "system")),
            cursor: Some(
                display_path(style, index)
                    .replace("display.mp4", "cursor.json")
                    .into(),
            ),
            keyboard: Some(
                display_path(style, index)
                    .replace("display.mp4", "keyboard.json")
                    .into(),
            ),
            display_notch: None,
        })
        .collect();

    let cursors = (0..cursors)
        .map(|index| {
            (
                format!("cursor-{index}"),
                CursorMeta {
                    image_path: cursor_path(style, index).into(),
                    hotspot: XY::new(12.0, 12.0),
                    shape: None,
                },
            )
        })
        .collect::<HashMap<_, _>>();

    RecordingMeta {
        platform: None,
        project_path: Default::default(),
        pretty_name: "Cap 2026-11-03 at 12.00.00".into(),
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments,
                cursors: Cursors::Correct(cursors),
                status: Some(StudioRecordingStatus::Complete),
            },
        })),
        upload: None,
    }
}

fn fingerprint(meta: &RecordingMeta) -> u64 {
    let mut hasher = DefaultHasher::new();
    meta.pretty_name.hash(&mut hasher);
    if let RecordingMetaInner::Studio(studio) = &meta.inner
        && let StudioRecordingMeta::MultipleSegments { inner } = studio.as_ref()
    {
        for segment in &inner.segments {
            segment.display.path.as_str().hash(&mut hasher);
            segment
                .camera
                .as_ref()
                .map(|camera| camera.path.as_str())
                .hash(&mut hasher);
            segment
                .mic
                .as_ref()
                .map(|mic| mic.path.as_str())
                .hash(&mut hasher);
            segment
                .system_audio
                .as_ref()
                .map(|audio| audio.path.as_str())
                .hash(&mut hasher);
            segment
                .cursor
                .as_ref()
                .map(|path| path.as_str())
                .hash(&mut hasher);
            segment
                .keyboard
                .as_ref()
                .map(|path| path.as_str())
                .hash(&mut hasher);
        }
        if let Cursors::Correct(cursors) = &inner.cursors {
            let mut entries = cursors.iter().collect::<Vec<_>>();
            entries.sort_by_key(|(id, _)| id.as_str());
            for (id, cursor) in entries {
                id.hash(&mut hasher);
                cursor.image_path.as_str().hash(&mut hasher);
            }
        }
    }
    hasher.finish()
}

fn main() -> Result<(), Box<dyn Error>> {
    let directory = tempfile::tempdir()?;
    println!("scenario,path_style,bytes,sample,elapsed_ns,fingerprint");

    for (label, segments, cursors) in [
        ("1-segment", 1, 3),
        ("5-segments", 5, 12),
        ("20-segments-64-cursors", 20, 64),
        ("60-segments-256-cursors", 60, 256),
    ] {
        for style in ["canonical", "absolute", "windows"] {
            let project = directory.path().join(format!("{label}-{style}"));
            std::fs::create_dir_all(&project)?;
            let mut value = meta(style, segments, cursors);
            value.project_path = project.clone();
            let json = serde_json::to_string_pretty(&value)?;
            let meta_path = project.join("recording-meta.json");
            std::fs::write(&meta_path, &json)?;
            let bytes = json.len();

            for _ in 0..3 {
                black_box(RecordingMeta::load_for_project(black_box(&project))?);
            }

            let mut expected = None;
            for sample in 0..25 {
                let start = Instant::now();
                let loaded = black_box(RecordingMeta::load_for_project(black_box(&project))?);
                let elapsed = start.elapsed().as_nanos();
                let hash = fingerprint(&loaded);
                match expected {
                    Some(expected) => assert_eq!(expected, hash, "{label} {style} changed"),
                    None => expected = Some(hash),
                }
                println!("{label},{style},{bytes},{sample},{elapsed},{hash}");
            }
        }
    }

    Ok(())
}
