use std::time::Duration;

#[derive(Debug, Clone)]
pub struct SyncEvent {
    pub frame_number: u64,
    pub audio_sample: u64,
    pub expected_time_ms: f64,
}

#[derive(Debug, Clone)]
pub struct SyncTestConfig {
    pub video_fps: u32,
    pub audio_sample_rate: u32,
    pub sync_interval_ms: u32,
    pub duration: Duration,
}

impl Default for SyncTestConfig {
    fn default() -> Self {
        Self {
            video_fps: 30,
            audio_sample_rate: 48000,
            sync_interval_ms: 1000,
            duration: Duration::from_secs(5),
        }
    }
}

impl SyncTestConfig {
    pub fn generate_sync_events(&self) -> Vec<SyncEvent> {
        let mut events = vec![];

        let total_ms = self.duration.as_millis() as u32;
        let mut time_ms = 0u32;

        while time_ms < total_ms {
            let frame_number = (time_ms as f64 * self.video_fps as f64 / 1000.0) as u64;
            let audio_sample = (time_ms as f64 * self.audio_sample_rate as f64 / 1000.0) as u64;

            events.push(SyncEvent {
                frame_number,
                audio_sample,
                expected_time_ms: time_ms as f64,
            });

            time_ms += self.sync_interval_ms;
        }

        events
    }

    pub fn frames_per_sync_interval(&self) -> u32 {
        self.video_fps * self.sync_interval_ms / 1000
    }

    pub fn samples_per_sync_interval(&self) -> u32 {
        self.audio_sample_rate * self.sync_interval_ms / 1000
    }
}

#[derive(Debug, Clone, Default)]
pub struct SyncAnalysisResult {
    pub events: Vec<DetectedSyncEvent>,
    pub average_offset_ms: f64,
    pub max_offset_ms: f64,
    pub min_offset_ms: f64,
    pub std_deviation_ms: f64,
    pub sync_ok: bool,
}

#[derive(Debug, Clone)]
pub struct DetectedSyncEvent {
    pub expected_time_ms: f64,
    pub video_detected_ms: Option<f64>,
    pub audio_detected_ms: Option<f64>,
    pub offset_ms: f64,
}

impl SyncAnalysisResult {
    pub fn new(events: Vec<DetectedSyncEvent>, tolerance_ms: f64) -> Self {
        if events.is_empty() {
            return Self::default();
        }

        let offsets: Vec<f64> = events.iter().map(|e| e.offset_ms).collect();

        let sum: f64 = offsets.iter().sum();
        let count = offsets.len() as f64;
        let average_offset_ms = sum / count;

        let max_offset_ms = offsets
            .iter()
            .map(|o| o.abs())
            .fold(f64::NEG_INFINITY, f64::max);
        let min_offset_ms = offsets
            .iter()
            .map(|o| o.abs())
            .fold(f64::INFINITY, f64::min);

        let variance: f64 = offsets
            .iter()
            .map(|o| (o - average_offset_ms).powi(2))
            .sum::<f64>()
            / count;
        let std_deviation_ms = variance.sqrt();

        let sync_ok = max_offset_ms <= tolerance_ms;

        Self {
            events,
            average_offset_ms,
            max_offset_ms,
            min_offset_ms,
            std_deviation_ms,
            sync_ok,
        }
    }

    pub fn is_within_tolerance(&self, tolerance_ms: f64) -> bool {
        self.max_offset_ms <= tolerance_ms
    }
}

pub fn frame_number_to_time_ms(frame_number: u64, fps: u32) -> f64 {
    frame_number as f64 * 1000.0 / fps as f64
}

pub fn sample_number_to_time_ms(sample_number: u64, sample_rate: u32) -> f64 {
    sample_number as f64 * 1000.0 / sample_rate as f64
}

pub fn time_ms_to_frame_number(time_ms: f64, fps: u32) -> u64 {
    (time_ms * fps as f64 / 1000.0).round() as u64
}

pub fn time_ms_to_sample_number(time_ms: f64, sample_rate: u32) -> u64 {
    (time_ms * sample_rate as f64 / 1000.0).round() as u64
}

#[derive(Debug, Clone)]
pub struct SyncMarker {
    pub marker_type: SyncMarkerType,
    pub time_ms: f64,
    pub frame_number: Option<u64>,
    pub sample_number: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMarkerType {
    VideoFlash,
    AudioBeep,
    Combined,
}

pub struct SyncDetector {
    _video_fps: u32,
    _audio_sample_rate: u32,
    flash_threshold: u8,
    beep_threshold: f32,
    beep_frequency: f32,
}

impl SyncDetector {
    pub fn new(video_fps: u32, audio_sample_rate: u32) -> Self {
        Self {
            _video_fps: video_fps,
            _audio_sample_rate: audio_sample_rate,
            flash_threshold: 200,
            beep_threshold: 0.3,
            beep_frequency: 1000.0,
        }
    }

    pub fn with_flash_threshold(mut self, threshold: u8) -> Self {
        self.flash_threshold = threshold;
        self
    }

    pub fn with_beep_threshold(mut self, threshold: f32) -> Self {
        self.beep_threshold = threshold;
        self
    }

    pub fn detect_flash_in_frame(&self, y_plane: &[u8], width: usize, height: usize) -> bool {
        if y_plane.is_empty() {
            return false;
        }

        let sample_region_width = (width / 4).max(1);
        let sample_region_height = (height / 4).max(1);
        let start_x = width / 2 - sample_region_width / 2;
        let start_y = height / 2 - sample_region_height / 2;

        let mut sum = 0u64;
        let mut count = 0u64;

        for y in start_y..(start_y + sample_region_height) {
            for x in start_x..(start_x + sample_region_width) {
                let idx = y * width + x;
                if idx < y_plane.len() {
                    sum += y_plane[idx] as u64;
                    count += 1;
                }
            }
        }

        if count == 0 {
            return false;
        }

        let average = (sum / count) as u8;
        average >= self.flash_threshold
    }

    pub fn detect_beep_in_audio(&self, samples: &[f32], sample_rate: u32) -> Option<usize> {
        if samples.is_empty() {
            return None;
        }

        let window_size = (sample_rate as f32 / self.beep_frequency * 2.0) as usize;
        let window_size = window_size.max(64).min(samples.len());

        for (start_idx, window) in samples.windows(window_size).enumerate() {
            let energy: f32 = window.iter().map(|s| s.abs()).sum::<f32>() / window.len() as f32;

            if energy >= self.beep_threshold {
                return Some(start_idx);
            }
        }

        None
    }

    pub fn analyze_sync(
        &self,
        video_markers: &[SyncMarker],
        audio_markers: &[SyncMarker],
        tolerance_ms: f64,
    ) -> SyncAnalysisResult {
        let mut events = vec![];

        for video_marker in video_markers {
            let closest_audio = audio_markers.iter().min_by(|a, b| {
                let diff_a = (a.time_ms - video_marker.time_ms).abs();
                let diff_b = (b.time_ms - video_marker.time_ms).abs();
                diff_a.partial_cmp(&diff_b).unwrap()
            });

            let (audio_time, offset) = if let Some(audio) = closest_audio {
                let offset = audio.time_ms - video_marker.time_ms;
                (Some(audio.time_ms), offset)
            } else {
                (None, 0.0)
            };

            events.push(DetectedSyncEvent {
                expected_time_ms: video_marker.time_ms,
                video_detected_ms: Some(video_marker.time_ms),
                audio_detected_ms: audio_time,
                offset_ms: offset,
            });
        }

        SyncAnalysisResult::new(events, tolerance_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_event_generation() {
        let config = SyncTestConfig {
            video_fps: 30,
            audio_sample_rate: 48000,
            sync_interval_ms: 1000,
            duration: Duration::from_secs(5),
        };

        let events = config.generate_sync_events();

        assert_eq!(events.len(), 5);
        assert_eq!(events[0].expected_time_ms, 0.0);
        assert_eq!(events[1].expected_time_ms, 1000.0);
        assert_eq!(events[0].frame_number, 0);
        assert_eq!(events[1].frame_number, 30);
        assert_eq!(events[0].audio_sample, 0);
        assert_eq!(events[1].audio_sample, 48000);
    }

    #[test]
    fn test_time_conversions() {
        assert_eq!(frame_number_to_time_ms(30, 30), 1000.0);
        assert_eq!(frame_number_to_time_ms(60, 60), 1000.0);

        assert_eq!(sample_number_to_time_ms(48000, 48000), 1000.0);
        assert_eq!(sample_number_to_time_ms(44100, 44100), 1000.0);

        assert_eq!(time_ms_to_frame_number(1000.0, 30), 30);
        assert_eq!(time_ms_to_sample_number(1000.0, 48000), 48000);
    }

    #[test]
    fn test_sync_analysis() {
        let events = vec![
            DetectedSyncEvent {
                expected_time_ms: 0.0,
                video_detected_ms: Some(0.0),
                audio_detected_ms: Some(5.0),
                offset_ms: 5.0,
            },
            DetectedSyncEvent {
                expected_time_ms: 1000.0,
                video_detected_ms: Some(1000.0),
                audio_detected_ms: Some(1010.0),
                offset_ms: 10.0,
            },
            DetectedSyncEvent {
                expected_time_ms: 2000.0,
                video_detected_ms: Some(2000.0),
                audio_detected_ms: Some(2015.0),
                offset_ms: 15.0,
            },
        ];

        let result = SyncAnalysisResult::new(events, 50.0);

        assert_eq!(result.average_offset_ms, 10.0);
        assert_eq!(result.max_offset_ms, 15.0);
        assert_eq!(result.min_offset_ms, 5.0);
        assert!(result.sync_ok);
        assert!(result.is_within_tolerance(50.0));
        assert!(!result.is_within_tolerance(10.0));
    }

    #[test]
    fn test_flash_detection() {
        let detector = SyncDetector::new(30, 48000);

        let bright_frame: Vec<u8> = vec![255; 1920 * 1080];
        assert!(detector.detect_flash_in_frame(&bright_frame, 1920, 1080));

        let dark_frame: Vec<u8> = vec![16; 1920 * 1080];
        assert!(!detector.detect_flash_in_frame(&dark_frame, 1920, 1080));
    }

    #[test]
    fn test_beep_detection() {
        let detector = SyncDetector::new(30, 48000);

        let loud_samples: Vec<f32> = vec![0.5; 4800];
        assert!(
            detector
                .detect_beep_in_audio(&loud_samples, 48000)
                .is_some()
        );

        let silent_samples: Vec<f32> = vec![0.0; 4800];
        assert!(
            detector
                .detect_beep_in_audio(&silent_samples, 48000)
                .is_none()
        );
    }
}
