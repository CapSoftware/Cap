use cap_project::{
    CursorClickEvent, CursorEvents, GlideDirection, RecordingMeta, RecordingMetaInner,
    StudioRecordingMeta, TimelineConfiguration, ZoomMode, ZoomSegment,
    cursor::SHORT_CURSOR_SHAPE_DEBOUNCE_MS,
};

fn zoom_segments_from_clicks(
    mut clicks: Vec<CursorClickEvent>,
    max_duration: f64,
    zoom_amount: f64,
) -> Vec<ZoomSegment> {
    const MS_PER_SECOND: f64 = 1000.0;
    const START_MIN_MS: f64 = 1.0;
    const CLICK_PRE_PADDING_MS: f64 = 300.0;
    const CLICK_POST_PADDING_MS: f64 = 2500.0;
    const CLICK_END_CLAMP_PADDING_MS: f64 = 800.0;
    const TRAILING_CLICK_IGNORE_MS: f64 = 1000.0;
    const MERGE_GAP_MS: f64 = 2500.0;

    if max_duration <= 0.0 {
        return Vec::new();
    }

    let duration_ms = max_duration * MS_PER_SECOND;
    let click_cutoff_ms = duration_ms - TRAILING_CLICK_IGNORE_MS;
    let end_limit_ms = duration_ms - CLICK_END_CLAMP_PADDING_MS;
    if click_cutoff_ms <= 0.0 || end_limit_ms <= START_MIN_MS {
        return Vec::new();
    }

    clicks.sort_by(|a, b| {
        a.time_ms
            .partial_cmp(&b.time_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut intervals: Vec<(f64, f64)> = Vec::new();
    for click in clicks {
        let time_ms = click.time_ms.floor();
        if time_ms >= click_cutoff_ms {
            continue;
        }

        let start = (time_ms - CLICK_PRE_PADDING_MS).max(START_MIN_MS);
        let end = (time_ms + CLICK_POST_PADDING_MS).min(end_limit_ms);

        if end > start {
            intervals.push((start, end));
        }
    }

    if intervals.is_empty() {
        return Vec::new();
    }

    intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut merged: Vec<(f64, f64)> = Vec::new();
    for interval in intervals {
        if let Some(last) = merged.last_mut()
            && interval.0 <= last.1 + MERGE_GAP_MS
        {
            last.1 = last.1.max(interval.1);
            continue;
        }
        merged.push(interval);
    }

    merged
        .into_iter()
        .map(|(start, end)| ZoomSegment {
            start: start.round() / MS_PER_SECOND,
            end: end.round() / MS_PER_SECOND,
            amount: zoom_amount,
            mode: ZoomMode::Auto,
            glide_direction: GlideDirection::None,
            glide_speed: 0.5,
            instant_animation: false,
            edge_snap_ratio: 0.25,
        })
        .collect()
}

pub fn generate_project_auto_zoom_segments(
    recording_meta: &RecordingMeta,
    timeline: Option<&TimelineConfiguration>,
    max_duration: f64,
    zoom_amount: f64,
) -> Vec<ZoomSegment> {
    let RecordingMetaInner::Studio(studio_meta) = &recording_meta.inner else {
        return Vec::new();
    };

    let mut clips = Vec::new();
    match &**studio_meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            if let Some(cursor_path) = &segment.cursor {
                let mut events = CursorEvents::load_from_file(&recording_meta.path(cursor_path))
                    .unwrap_or_default();
                let pointer_ids = studio_meta.pointer_cursor_ids();
                let pointer_ids_ref = (!pointer_ids.is_empty()).then_some(&pointer_ids);
                events.stabilize_short_lived_cursor_shapes(
                    pointer_ids_ref,
                    SHORT_CURSOR_SHAPE_DEBOUNCE_MS,
                );
                clips.push((events.clicks, segment.display.start_time.unwrap_or(0.0)));
            }
        }
        StudioRecordingMeta::MultipleSegments { inner } => {
            for segment in &inner.segments {
                clips.push((
                    segment.cursor_events(recording_meta).clicks,
                    segment.latest_start_time().unwrap_or(0.0),
                ));
            }
        }
    }

    let (clicks, duration) =
        if let Some(timeline) = timeline.filter(|timeline| !timeline.segments.is_empty()) {
            (
                map_clicks_to_timeline(&clips, timeline),
                timeline.duration(),
            )
        } else {
            (
                clips.into_iter().flat_map(|(clicks, _)| clicks).collect(),
                max_duration,
            )
        };

    zoom_segments_from_clicks(clicks, duration, zoom_amount)
}

fn map_clicks_to_timeline(
    clips: &[(Vec<CursorClickEvent>, f64)],
    timeline: &TimelineConfiguration,
) -> Vec<CursorClickEvent> {
    let holds = timeline.hold_windows();
    let mut offset = 0.0;
    let mut mapped = Vec::new();
    for (index, segment) in timeline.segments.iter().enumerate() {
        offset -= timeline
            .effective_transition(index)
            .map_or(0.0, |transition| transition.duration);
        let Some((clicks, capture_offset)) = clips.get(segment.recording_clip as usize) else {
            offset += segment.duration();
            continue;
        };
        if !segment.timescale.is_finite() || segment.timescale <= 0.0 {
            offset += segment.duration();
            continue;
        }
        let source_start = segment.start + capture_offset;
        let source_end = segment.end + capture_offset;
        for click in clicks {
            let source_time = click.time_ms / 1000.0;
            if !source_time.is_finite() || source_time < source_start || source_time >= source_end {
                continue;
            }
            let mut output_time = offset + (source_time - source_start) / segment.timescale;
            for (hold_start, hold_end) in &holds {
                if output_time >= *hold_start {
                    output_time += hold_end - hold_start;
                } else {
                    break;
                }
            }
            if output_time.is_finite() {
                let mut translated = click.clone();
                translated.time_ms = output_time * 1000.0;
                mapped.push(translated);
            }
        }
        offset += segment.duration();
    }
    mapped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click(time_ms: f64) -> CursorClickEvent {
        CursorClickEvent {
            active_modifiers: Vec::new(),
            cursor_num: 0,
            cursor_id: String::new(),
            time_ms,
            down: true,
        }
    }

    #[test]
    fn matches_desktop_click_group_merging() {
        let segments = zoom_segments_from_clicks(vec![click(1200.0), click(4200.0)], 20.0, 2.0);
        assert_eq!(segments.len(), 1);
        assert_eq!((segments[0].start, segments[0].end), (0.9, 6.7));
    }

    #[test]
    fn matches_desktop_stop_click_and_end_clamp() {
        assert!(zoom_segments_from_clicks(vec![click(11_900.0)], 12.0, 2.0).is_empty());
        let segments = zoom_segments_from_clicks(vec![click(8999.0), click(9000.0)], 10.0, 2.0);
        assert_eq!(segments.len(), 1);
        assert_eq!((segments[0].start, segments[0].end), (8.699, 9.2));
    }

    #[test]
    fn imported_clip_clicks_follow_trim_speed_and_capture_offset() {
        let timeline: TimelineConfiguration = serde_json::from_value(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "start": 0.0, "end": 2.0, "timescale": 1.0 },
                { "recordingSegment": 1, "start": 0.2, "end": 5.2, "timescale": 2.0 }
            ],
            "zoomSegments": []
        }))
        .unwrap();
        let clicks = vec![(vec![], 0.0), (vec![click(800.0)], 0.1)];
        let mapped = map_clicks_to_timeline(&clicks, &timeline);
        assert_eq!(mapped.len(), 1);
        assert!((mapped[0].time_ms - 2250.0).abs() < 1e-9);
        let segments = zoom_segments_from_clicks(mapped, timeline.duration(), 1.8);
        assert_eq!((segments[0].start, segments[0].amount), (1.95, 1.8));
    }
}
