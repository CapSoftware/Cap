use cap_project::{CaptionSegment, CaptionWord, CaptionsData, ProjectConfiguration, RecordingMeta};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    hint::black_box,
    time::Instant,
};

fn main() {
    for (name, count, timeline, sidecar) in [
        ("empty", 0, 0, false),
        ("30_no_timeline", 30, 0, false),
        ("150_no_timeline", 150, 0, false),
        ("900_no_timeline", 900, 0, false),
        ("900_sidecar_no_timeline", 900, 0, true),
        ("900_empty_timeline", 900, 1, false),
        ("900_existing_track", 900, 2, false),
    ] {
        let captions = CaptionsData {
            source_timed: true,
            segments: (0..count)
                .map(|index| CaptionSegment {
                    id: format!("source-{index}"),
                    start: index as f32 * 4.0,
                    end: index as f32 * 4.0 + 4.0,
                    text: "A caption with café and Unicode 字 to preserve".into(),
                    words: (0..10)
                        .map(|word| CaptionWord {
                            text: format!("word{word} café 字"),
                            start: index as f32 * 4.0 + word as f32 * 0.4,
                            end: index as f32 * 4.0 + (word + 1) as f32 * 0.4,
                        })
                        .collect(),
                })
                .collect(),
            ..Default::default()
        };
        let directory = tempfile::tempdir().unwrap();
        let mut meta: RecordingMeta = serde_json::from_value(serde_json::json!({
            "pretty_name": "Caption loading benchmark",
            "display": {"path": "unused.mp4", "fps": 30},
            "camera": null, "audio": null, "cursor": null,
        }))
        .unwrap();
        meta.project_path = directory.path().to_path_buf();
        let mut config = ProjectConfiguration {
            captions: (!sidecar).then(|| captions.clone()),
            ..Default::default()
        };
        if timeline > 0 {
            config.timeline = Some(serde_json::from_value(serde_json::json!({
                "segments": [{"start": 0.0, "end": 3600.0, "timescale": 1.0}], "zoomSegments": [],
                "captionSegments": if timeline == 2 { serde_json::json!([{"id": "saved", "start": 0.0, "end": 1.0, "text": "Saved override", "words": []}]) } else { serde_json::json!([]) },
            })).unwrap());
        }
        config.write(directory.path()).unwrap();
        if sidecar {
            std::fs::write(
                directory.path().join("captions.json"),
                serde_json::to_vec(&captions).unwrap(),
            )
            .unwrap();
        }
        for _ in 0..3 {
            black_box(meta.project_config());
        }
        let output = meta.project_config();
        assert_eq!(output.captions.as_ref().unwrap().segments.len(), count);
        if timeline == 0 {
            assert!(output.timeline.is_none());
        } else {
            assert_eq!(
                output.timeline.as_ref().unwrap().caption_segments.len(),
                if timeline == 2 { 1 } else { count }
            );
        }
        let mut hash = DefaultHasher::new();
        serde_json::to_vec(&output).unwrap().hash(&mut hash);
        let fingerprint = hash.finish();
        for sample in 0..15 {
            let start = Instant::now();
            for _ in 0..10 {
                black_box(black_box(&meta).project_config());
            }
            println!(
                "LOAD_BENCH {}",
                serde_json::json!({"case": name, "sample": sample,
                "ns_per_call": start.elapsed().as_nanos() as f64 / 10.0, "fingerprint": fingerprint})
            );
        }
    }
}
