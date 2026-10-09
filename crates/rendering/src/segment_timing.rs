use cap_project::{ClipOffsets, StudioRecordingMeta};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct SegmentVideoTiming {
    pub(super) latest_start_time: Option<f64>,
    pub(super) screen_fps: u32,
    pub(super) camera_fps: Option<u32>,
    pub(super) screen_offset: f64,
    pub(super) camera_offset: f64,
}

pub(super) fn segment_video_timing(
    meta: &StudioRecordingMeta,
    segment_i: usize,
) -> SegmentVideoTiming {
    let latest_start_time = match &meta {
        StudioRecordingMeta::SingleSegment { .. } => None,
        StudioRecordingMeta::MultipleSegments { inner, .. } => {
            inner.segments[segment_i].latest_start_time()
        }
    };

    let screen_fps = match &meta {
        StudioRecordingMeta::SingleSegment { segment } => segment.display.fps,
        StudioRecordingMeta::MultipleSegments { inner, .. } => {
            inner.segments[segment_i].display.fps
        }
    };

    let camera_fps = match &meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            segment.camera.as_ref().map(|camera| camera.fps)
        }
        StudioRecordingMeta::MultipleSegments { inner, .. } => inner.segments[segment_i]
            .camera
            .as_ref()
            .map(|camera| camera.fps),
    };

    let screen_offset = match &meta {
        StudioRecordingMeta::SingleSegment { .. } => 0.0,
        StudioRecordingMeta::MultipleSegments { inner, .. } => {
            let segment = &inner.segments[segment_i];

            latest_start_time
                .zip(segment.display.start_time)
                .map(|(latest_start_time, display_time)| latest_start_time - display_time)
                .unwrap_or(0.0)
        }
    };

    let camera_offset = match &meta {
        StudioRecordingMeta::SingleSegment { .. } => 0.0,
        StudioRecordingMeta::MultipleSegments { inner, .. } => {
            let segment = &inner.segments[segment_i];

            latest_start_time
                .zip(segment.camera.as_ref().and_then(|camera| camera.start_time))
                .map(|(latest_start_time, start_time)| latest_start_time - start_time)
                .unwrap_or(0.0)
        }
    };

    SegmentVideoTiming {
        latest_start_time,
        screen_fps,
        camera_fps,
        screen_offset,
        camera_offset,
    }
}

pub(super) fn segment_frame_times(
    segment_time: f32,
    segment_offset: f64,
    offsets: ClipOffsets,
) -> (f32, f32) {
    (
        segment_time + offsets.camera,
        segment_time + segment_offset as f32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_start_includes_both_audio_tracks_and_preserves_missing_start_behavior() {
        let mut metadata: StudioRecordingMeta = serde_json::from_value(serde_json::json!({
            "segments": [{
                "display": { "path": "display", "fps": 60, "start_time": 10.25 },
                "camera": { "path": "camera", "fps": 24, "start_time": 10.5 },
                "mic": { "path": "mic.aac", "start_time": 10.75 },
                "system_audio": { "path": "system.ogg", "start_time": 11.0 }
            }]
        }))
        .unwrap();
        let timing = segment_video_timing(&metadata, 0);
        assert_eq!(timing.latest_start_time, Some(11.0));
        assert_eq!(timing.screen_offset, 0.75);
        assert_eq!(timing.camera_offset, 0.5);
        assert_eq!((timing.screen_fps, timing.camera_fps), (60, Some(24)));
        let StudioRecordingMeta::MultipleSegments { inner } = &mut metadata else {
            panic!("Expected multi-segment metadata");
        };
        inner.segments[0].mic.as_mut().unwrap().start_time = None;
        let timing = segment_video_timing(&metadata, 0);
        assert_eq!(timing.latest_start_time, None);
        assert_eq!((timing.screen_offset, timing.camera_offset), (0.0, 0.0));
    }

    #[test]
    fn frame_times_retain_cast_before_add_and_camera_offset_order() {
        let segment_time = 1.0_f32;
        let offset = 16_777_216.75_f64;
        let clip = ClipOffsets {
            camera: -0.25,
            ..Default::default()
        };
        let (camera, recording) = segment_frame_times(segment_time, offset, clip);
        assert_eq!(camera.to_bits(), 0.75_f32.to_bits());
        assert_eq!(
            recording.to_bits(),
            (segment_time + offset as f32).to_bits()
        );
        assert_ne!(
            recording.to_bits(),
            ((segment_time as f64 + offset) as f32).to_bits()
        );
    }
}
