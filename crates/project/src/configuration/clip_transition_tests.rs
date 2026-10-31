use super::*;

fn two_clips(first: f64, second: f64) -> TimelineConfiguration {
    serde_json::from_value(serde_json::json!({
        "segments": [
            { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": first },
            { "recordingSegment": 0, "timescale": 1.0, "start": first, "end": first + second }
        ],
        "zoomSegments": []
    }))
    .unwrap()
}

#[derive(Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ShippedKind {
    CrossFade,
    FadeThroughBlack,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShippedTransition {
    segment_index: u32,
    #[serde(rename = "type")]
    kind: ShippedKind,
    duration: f64,
}

#[test]
fn shipped_projects_read_and_write_unchanged() {
    let stored = serde_json::json!([
        { "segmentIndex": 1, "type": "cross-fade", "duration": 0.5 },
        { "segmentIndex": 2, "type": "fade-through-black", "duration": 1.25 }
    ]);
    let transitions: Vec<ClipTransition> = serde_json::from_value(stored.clone()).unwrap();
    assert_eq!(
        transitions,
        vec![
            ClipTransition {
                segment_index: 1,
                kind: ClipTransitionType::CrossFade,
                duration: 0.5,
            },
            ClipTransition {
                segment_index: 2,
                kind: ClipTransitionType::FadeThroughBlack,
                duration: 1.25,
            },
        ]
    );
    assert_eq!(serde_json::to_value(&transitions).unwrap(), stored);
}

#[test]
fn every_kind_round_trips() {
    for kind in ClipTransitionType::ALL {
        let transition = ClipTransition {
            segment_index: 3,
            kind,
            duration: 0.75,
        };
        let json = serde_json::to_value(transition).unwrap();
        let back: ClipTransition = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(back, transition, "{json}");
        assert_eq!(
            ClipTransitionType::from_wire_name(kind.wire_name()),
            Some(kind)
        );
    }
}

#[test]
fn new_kinds_stay_loadable_by_the_shipped_reader() {
    for kind in ClipTransitionType::ALL {
        let json = serde_json::to_value(ClipTransition {
            segment_index: 1,
            kind,
            duration: 0.5,
        })
        .unwrap();
        let shipped: ShippedTransition = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(shipped.segment_index, 1);
        assert_eq!(shipped.duration, 0.5);
        let expected = if kind.dips() {
            ShippedKind::FadeThroughBlack
        } else {
            ShippedKind::CrossFade
        };
        assert_eq!(shipped.kind, expected, "{json}");
        let has_effect = json.get("effect").is_some();
        assert_eq!(
            has_effect,
            !matches!(
                kind,
                ClipTransitionType::CrossFade | ClipTransitionType::FadeThroughBlack
            ),
            "{json}"
        );
    }
}

#[test]
fn unknown_kinds_from_a_later_version_fall_back_instead_of_failing() {
    let transitions: Vec<ClipTransition> = serde_json::from_value(serde_json::json!([
        { "segmentIndex": 1, "type": "fade-through-black", "effect": "spin", "duration": 0.5 },
        { "segmentIndex": 2, "type": "iris", "duration": 0.5 },
        { "segmentIndex": 3, "duration": 0.5 },
        { "segmentIndex": 4, "type": "cross-fade", "effect": "wipe-up", "duration": 0.5 }
    ]))
    .unwrap();
    let kinds: Vec<_> = transitions
        .iter()
        .map(|transition| transition.kind)
        .collect();
    assert_eq!(
        kinds,
        vec![
            ClipTransitionType::FadeThroughBlack,
            ClipTransitionType::CrossFade,
            ClipTransitionType::CrossFade,
            ClipTransitionType::WipeUp,
        ]
    );
}

#[test]
fn a_whole_timeline_with_every_kind_reopens_identically() {
    let mut timeline: TimelineConfiguration = serde_json::from_value(serde_json::json!({
        "segments": (0..13).map(|index| serde_json::json!({
            "recordingSegment": 0,
            "timescale": 1.0,
            "start": index as f64 * 4.0,
            "end": index as f64 * 4.0 + 4.0
        })).collect::<Vec<_>>(),
        "zoomSegments": []
    }))
    .unwrap();
    timeline.transitions = ClipTransitionType::ALL
        .into_iter()
        .enumerate()
        .map(|(index, kind)| ClipTransition {
            segment_index: index as u32 + 1,
            kind,
            duration: 0.5,
        })
        .collect();
    let reopened: TimelineConfiguration =
        serde_json::from_str(&serde_json::to_string(&timeline).unwrap()).unwrap();
    assert_eq!(reopened.transitions, timeline.transitions);
    assert_eq!(reopened.duration(), timeline.duration());
    for (index, kind) in ClipTransitionType::ALL.into_iter().enumerate() {
        assert_eq!(reopened.effective_transition(index + 1).unwrap().kind, kind);
    }
}

#[test]
fn every_kind_maps_the_same_overlap() {
    for kind in ClipTransitionType::ALL {
        let mut timeline = two_clips(4.0, 4.0);
        timeline.transitions = vec![ClipTransition {
            segment_index: 1,
            kind,
            duration: 1.0,
        }];
        assert_eq!(timeline.duration(), 7.0);
        match timeline.get_frame_mapping(3.5) {
            Some(TimelineFrameMapping::Transition {
                outgoing,
                incoming,
                kind: mapped,
                progress,
                ..
            }) => {
                assert_eq!(mapped, kind);
                assert_eq!(outgoing.source_time, 3.5);
                assert_eq!(incoming.source_time, 4.5);
                assert!((progress - 0.5).abs() < 1e-12);
            }
            other => panic!("{kind:?}: {other:?}"),
        }
    }
}

#[test]
fn transitions_hold_their_timing_two_hours_in() {
    let mut timeline = two_clips(7_200.0, 3_600.0);
    timeline.transitions = vec![ClipTransition {
        segment_index: 1,
        kind: ClipTransitionType::PushLeft,
        duration: 0.5,
    }];
    let start = 7_199.5;
    for step in 0..=30 {
        let time = start + step as f64 / 60.0;
        match timeline.get_frame_mapping(time) {
            Some(TimelineFrameMapping::Transition {
                progress,
                outgoing,
                incoming,
                ..
            }) => {
                let expected = step as f64 / 30.0;
                assert!((progress - expected).abs() < 1e-9, "{time}: {progress}");
                assert!((outgoing.source_time - time).abs() < 1e-9);
                assert!((incoming.source_time - (7_200.0 + (time - start))).abs() < 1e-9);
            }
            Some(TimelineFrameMapping::Single { source, .. }) if step == 30 => {
                assert_eq!(source.segment_index, 1);
            }
            other => panic!("{time}: {other:?}"),
        }
    }
}
