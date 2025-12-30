use std::collections::VecDeque;

#[derive(Debug, Clone)]
pub struct SyncAnalysisResult {
    pub offset_secs: f64,
    pub confidence: f64,
    pub detected_events: Vec<SyncEvent>,
}

#[derive(Debug, Clone)]
pub struct SyncEvent {
    pub audio_time_secs: f64,
    pub video_time_secs: f64,
    pub offset_secs: f64,
    pub confidence: f64,
}

pub struct SyncAnalyzer {
    sample_rate: u32,
    fps: f64,
    audio_buffer: Vec<f32>,
    video_motion_scores: Vec<(f64, f64)>,
    detected_events: Vec<SyncEvent>,
}

impl SyncAnalyzer {
    pub fn new(sample_rate: u32, fps: f64) -> Self {
        Self {
            sample_rate,
            fps,
            audio_buffer: Vec::new(),
            video_motion_scores: Vec::new(),
            detected_events: Vec::new(),
        }
    }

    pub fn add_audio_samples(&mut self, samples: &[f32], start_time_secs: f64) {
        self.audio_buffer.extend_from_slice(samples);
    }

    pub fn add_video_frame_motion(&mut self, time_secs: f64, motion_score: f64) {
        self.video_motion_scores.push((time_secs, motion_score));
    }

    pub fn detect_audio_transients(&self) -> Vec<(f64, f64)> {
        let mut transients = Vec::new();

        if self.audio_buffer.len() < 1024 {
            return transients;
        }

        let window_size = (self.sample_rate as usize) / 100;
        let hop_size = window_size / 4;

        let mut prev_energy = 0.0f64;
        let mut energies: VecDeque<f64> = VecDeque::with_capacity(10);

        for (i, chunk) in self.audio_buffer.chunks(hop_size).enumerate() {
            let energy: f64 =
                chunk.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / chunk.len() as f64;
            let energy_db = if energy > 1e-10 {
                10.0 * energy.log10()
            } else {
                -100.0
            };

            energies.push_back(energy_db);
            if energies.len() > 10 {
                energies.pop_front();
            }

            if energies.len() >= 5 {
                let avg: f64 = energies.iter().take(energies.len() - 1).sum::<f64>()
                    / (energies.len() - 1) as f64;
                let current = *energies.back().unwrap();

                let onset_threshold = 15.0;
                if current - avg > onset_threshold && current > -30.0 {
                    let time_secs = (i * hop_size) as f64 / self.sample_rate as f64;
                    let strength = (current - avg) / onset_threshold;
                    transients.push((time_secs, strength.min(3.0)));
                }
            }

            prev_energy = energy_db;
        }

        transients
    }

    pub fn detect_video_motion_peaks(&self) -> Vec<(f64, f64)> {
        let mut peaks = Vec::new();

        if self.video_motion_scores.len() < 3 {
            return peaks;
        }

        let motion_threshold = 0.3;

        for i in 1..self.video_motion_scores.len() - 1 {
            let (time, score) = self.video_motion_scores[i];
            let prev_score = self.video_motion_scores[i - 1].1;
            let next_score = self.video_motion_scores[i + 1].1;

            if score > prev_score && score > next_score && score > motion_threshold {
                peaks.push((time, score));
            }
        }

        peaks
    }

    pub fn correlate_events(&mut self) -> Vec<SyncEvent> {
        let audio_transients = self.detect_audio_transients();
        let video_peaks = self.detect_video_motion_peaks();

        let max_offset_secs = 0.5;
        let mut events = Vec::new();

        for (audio_time, audio_strength) in &audio_transients {
            let mut best_match: Option<(f64, f64, f64)> = None;

            for (video_time, video_strength) in &video_peaks {
                let offset = audio_time - video_time;

                if offset.abs() <= max_offset_secs {
                    let combined_strength = audio_strength * video_strength;

                    if best_match.is_none() || combined_strength > best_match.unwrap().2 {
                        best_match = Some((*video_time, offset, combined_strength));
                    }
                }
            }

            if let Some((video_time, offset, strength)) = best_match {
                events.push(SyncEvent {
                    audio_time_secs: *audio_time,
                    video_time_secs: video_time,
                    offset_secs: offset,
                    confidence: (strength / 3.0).min(1.0),
                });
            }
        }

        self.detected_events = events.clone();
        events
    }

    pub fn calculate_sync_offset(&mut self) -> Option<SyncAnalysisResult> {
        let events = self.correlate_events();

        if events.is_empty() {
            return None;
        }

        let high_confidence_events: Vec<_> = events.iter().filter(|e| e.confidence > 0.5).collect();

        if high_confidence_events.is_empty() {
            return None;
        }

        let total_weight: f64 = high_confidence_events.iter().map(|e| e.confidence).sum();
        let weighted_offset: f64 = high_confidence_events
            .iter()
            .map(|e| e.offset_secs * e.confidence)
            .sum::<f64>()
            / total_weight;

        let variance: f64 = high_confidence_events
            .iter()
            .map(|e| (e.offset_secs - weighted_offset).powi(2) * e.confidence)
            .sum::<f64>()
            / total_weight;

        let std_dev = variance.sqrt();
        let consistency = 1.0 / (1.0 + std_dev * 10.0);

        let avg_confidence: f64 = high_confidence_events
            .iter()
            .map(|e| e.confidence)
            .sum::<f64>()
            / high_confidence_events.len() as f64;

        let overall_confidence = (avg_confidence * consistency).min(1.0);

        Some(SyncAnalysisResult {
            offset_secs: weighted_offset,
            confidence: overall_confidence,
            detected_events: events,
        })
    }

    pub fn reset(&mut self) {
        self.audio_buffer.clear();
        self.video_motion_scores.clear();
        self.detected_events.clear();
    }
}

pub fn calculate_frame_motion_score(
    current_frame: &[u8],
    previous_frame: &[u8],
    width: u32,
    height: u32,
) -> f64 {
    if current_frame.len() != previous_frame.len() || current_frame.is_empty() {
        return 0.0;
    }

    let sample_step = 16;
    let mut diff_sum = 0u64;
    let mut sample_count = 0u64;

    let stride = (width * 4) as usize;

    for y in (0..height as usize).step_by(sample_step) {
        for x in (0..width as usize).step_by(sample_step) {
            let idx = y * stride + x * 4;
            if idx + 2 < current_frame.len() {
                let curr_luma = (current_frame[idx] as u32 * 299
                    + current_frame[idx + 1] as u32 * 587
                    + current_frame[idx + 2] as u32 * 114)
                    / 1000;
                let prev_luma = (previous_frame[idx] as u32 * 299
                    + previous_frame[idx + 1] as u32 * 587
                    + previous_frame[idx + 2] as u32 * 114)
                    / 1000;

                diff_sum += (curr_luma as i32 - prev_luma as i32).unsigned_abs() as u64;
                sample_count += 1;
            }
        }
    }

    if sample_count == 0 {
        return 0.0;
    }

    (diff_sum as f64 / sample_count as f64) / 255.0
}

#[derive(Debug, Clone, Default)]
pub struct DeviceSyncCalibration {
    pub camera_id: String,
    pub microphone_id: String,
    pub measured_offset_secs: f64,
    pub confidence: f64,
    pub measurement_count: u32,
}

impl DeviceSyncCalibration {
    pub fn new(camera_id: String, microphone_id: String) -> Self {
        Self {
            camera_id,
            microphone_id,
            measured_offset_secs: 0.0,
            confidence: 0.0,
            measurement_count: 0,
        }
    }

    pub fn update_with_measurement(&mut self, offset_secs: f64, confidence: f64) {
        if confidence < 0.3 {
            return;
        }

        let decay = 0.7f64.powi(self.measurement_count as i32);
        let new_weight = confidence * (1.0 - decay) + decay;

        if self.measurement_count == 0 {
            self.measured_offset_secs = offset_secs;
            self.confidence = confidence;
        } else {
            let total_weight = self.confidence + new_weight;
            self.measured_offset_secs = (self.measured_offset_secs * self.confidence
                + offset_secs * new_weight)
                / total_weight;
            self.confidence = (self.confidence + confidence) / 2.0;
        }

        self.measurement_count += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_analyzer_creation() {
        let analyzer = SyncAnalyzer::new(48000, 30.0);
        assert_eq!(analyzer.sample_rate, 48000);
    }

    #[test]
    fn test_motion_score_identical_frames() {
        let frame = vec![128u8; 1920 * 1080 * 4];
        let score = calculate_frame_motion_score(&frame, &frame, 1920, 1080);
        assert_eq!(score, 0.0);
    }

    #[test]
    fn test_motion_score_different_frames() {
        let frame1 = vec![0u8; 1920 * 1080 * 4];
        let frame2 = vec![255u8; 1920 * 1080 * 4];
        let score = calculate_frame_motion_score(&frame1, &frame2, 1920, 1080);
        assert!(score > 0.9);
    }

    #[test]
    fn test_calibration_update() {
        let mut cal = DeviceSyncCalibration::new("cam1".into(), "mic1".into());
        cal.update_with_measurement(0.05, 0.8);
        assert!((cal.measured_offset_secs - 0.05).abs() < 0.001);

        cal.update_with_measurement(0.06, 0.9);
        assert!(cal.measured_offset_secs > 0.05);
        assert!(cal.measured_offset_secs < 0.06);
    }
}
