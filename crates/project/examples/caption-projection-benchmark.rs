use cap_project::{
    CaptionSegment, CaptionWord, CaptionsData, ProjectConfiguration, TimelineConfiguration,
    synchronize_captions,
};
use std::{
    collections::hash_map::DefaultHasher,
    error::Error,
    hash::{Hash, Hasher},
    hint::black_box,
    time::Instant,
};

fn fixture(seconds: usize, clips: usize, spacing: usize) -> ProjectConfiguration {
    let source_segments = (0..seconds / 4)
        .map(|index| {
            let start = 5.0 + (index * 4) as f32;
            CaptionSegment {
                id: format!("caption-{index}"),
                start,
                end: start + 4.0,
                text: "spoken words".into(),
                words: (0..10)
                    .map(|word| {
                        let start = start + word as f32 * 0.4;
                        CaptionWord {
                            text: "word".into(),
                            start,
                            end: start + 0.3,
                        }
                    })
                    .collect(),
            }
        })
        .collect();
    let segments: Vec<_> = (0..clips)
        .map(|index| {
            let start = index * spacing;
            let end = if clips == 1 { seconds } else { start + 4 };
            serde_json::json!({
                "start": start, "end": end, "timescale": 1.0, "recordingSegment": 1
            })
        })
        .collect();
    let timeline: TimelineConfiguration = serde_json::from_value(serde_json::json!({
        "segments": segments, "zoomSegments": []
    }))
    .unwrap();
    assert!(
        timeline
            .segments
            .iter()
            .all(|clip| clip.recording_clip == 1)
    );
    ProjectConfiguration {
        captions: Some(CaptionsData {
            source_timed: true,
            segments: source_segments,
            ..Default::default()
        }),
        timeline: Some(timeline),
        ..Default::default()
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = std::env::args().skip(1);
    let iterations: usize = arguments.next().unwrap_or_else(|| "20".into()).parse()?;
    if iterations == 0 {
        return Err("iterations must be positive".into());
    }
    let selected: Option<usize> = arguments.next().map(|value| value.parse()).transpose()?;
    let order = arguments.next().unwrap_or_else(|| "ordered".into());
    let cases = [
        (3600, 1, 0, false),
        (600, 20, 28, false),
        (3600, 60, 60, false),
        (3600, 1, 0, true),
        (3600, 500, 4, false),
    ];
    if selected.is_some_and(|case| case >= cases.len())
        || !matches!(order.as_str(), "ordered" | "reversed")
        || arguments.next().is_some()
    {
        return Err("expected case 0..=4 and order: ordered or reversed".into());
    }
    println!("case,order,clips,captions,words,sample,elapsed_ms,fingerprint");
    for (case, (seconds, clips, spacing, styled)) in cases.into_iter().enumerate() {
        if selected.is_some_and(|selected| selected != case) {
            continue;
        }
        let mut project = fixture(seconds, clips, spacing);
        if order == "reversed" {
            project.timeline.as_mut().unwrap().segments.reverse();
        }
        let durations = [5.0, seconds as f64];
        if styled {
            synchronize_captions(&mut project, &durations);
            for caption in &mut project.timeline.as_mut().unwrap().caption_segments {
                caption.position_override = Some("top".into());
                caption.color_override = Some("#abcdef".into());
                caption.background_color_override = Some("#123456".into());
                caption.font_size_override = Some(32);
            }
        }
        for _ in 0..3 {
            synchronize_captions(&mut project, &durations);
        }
        let track = &project.timeline.as_ref().unwrap().caption_segments;
        let expected_captions = if clips == 1 { seconds / 4 } else { clips };
        let words: usize = track.iter().map(|caption| caption.words.len()).sum();
        assert_eq!(track.len(), expected_captions);
        assert_eq!(words, expected_captions * 10);
        assert_eq!(track[0].start, 0.0);
        assert_eq!(track[0].words[0].start, 0.0);
        assert!(
            track
                .iter()
                .all(|caption| caption.words.iter().all(|word| word.text == "word"))
        );
        let mut hasher = DefaultHasher::new();
        serde_json::to_vec(track)?.hash(&mut hasher);
        let fingerprint = hasher.finish();
        for sample in 0..25 {
            let started = Instant::now();
            for _ in 0..iterations {
                synchronize_captions(black_box(&mut project), black_box(&durations));
                black_box(&project.timeline.as_ref().unwrap().caption_segments);
            }
            let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0 / iterations as f64;
            assert_eq!(
                project.timeline.as_ref().unwrap().caption_segments.len(),
                expected_captions
            );
            println!(
                "{case},{order},{clips},{expected_captions},{words},{sample},{elapsed_ms:.6},{fingerprint}"
            );
        }
        let mut hasher = DefaultHasher::new();
        serde_json::to_vec(&project.timeline.as_ref().unwrap().caption_segments)?.hash(&mut hasher);
        assert_eq!(hasher.finish(), fingerprint);
    }
    Ok(())
}
