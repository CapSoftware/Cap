use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use tokio::runtime::Handle as TokioHandle;

use cap_video_decode::avassetreader::KeyframeIndex;

pub const BASE_DECODER_POOL_SIZE: usize = 5;
pub const MAX_DECODER_POOL_SIZE: usize = 8;
pub const BASE_REPOSITION_THRESHOLD_SECS: f32 = 5.0;
pub const LONG_VIDEO_THRESHOLD_SECS: f64 = 600.0;
pub const VERY_LONG_VIDEO_THRESHOLD_SECS: f64 = 1800.0;

pub fn calculate_optimal_pool_size(duration_secs: f64) -> usize {
    if duration_secs >= VERY_LONG_VIDEO_THRESHOLD_SECS {
        MAX_DECODER_POOL_SIZE
    } else if duration_secs >= LONG_VIDEO_THRESHOLD_SECS {
        BASE_DECODER_POOL_SIZE + 2
    } else {
        BASE_DECODER_POOL_SIZE
    }
}

pub fn calculate_reposition_threshold(duration_secs: f64) -> f32 {
    if duration_secs >= VERY_LONG_VIDEO_THRESHOLD_SECS {
        10.0
    } else if duration_secs >= LONG_VIDEO_THRESHOLD_SECS {
        7.0
    } else {
        BASE_REPOSITION_THRESHOLD_SECS
    }
}

pub struct DecoderPosition {
    pub id: usize,
    pub position_secs: f32,
    pub last_access_time: std::time::Instant,
    pub access_count: u64,
}

impl DecoderPosition {
    pub fn new(id: usize, position_secs: f32) -> Self {
        Self {
            id,
            position_secs,
            last_access_time: std::time::Instant::now(),
            access_count: 0,
        }
    }

    pub fn touch(&mut self) {
        self.last_access_time = std::time::Instant::now();
        self.access_count += 1;
    }
}

pub struct MultiPositionDecoderConfig {
    pub path: PathBuf,
    pub tokio_handle: TokioHandle,
    pub keyframe_index: Option<Arc<KeyframeIndex>>,
    pub fps: u32,
    pub duration_secs: f64,
}

pub struct DecoderPoolManager {
    config: MultiPositionDecoderConfig,
    positions: Vec<DecoderPosition>,
    access_history: BTreeMap<u32, u64>,
    total_accesses: u64,
    reposition_threshold: f32,
    optimal_pool_size: usize,
}

impl DecoderPoolManager {
    pub fn new(config: MultiPositionDecoderConfig) -> Self {
        let optimal_pool_size = calculate_optimal_pool_size(config.duration_secs);
        let reposition_threshold = calculate_reposition_threshold(config.duration_secs);
        let initial_positions = Self::calculate_initial_positions(&config, optimal_pool_size);

        let positions: Vec<DecoderPosition> = initial_positions
            .into_iter()
            .enumerate()
            .map(|(id, pos)| DecoderPosition::new(id, pos))
            .collect();

        tracing::info!(
            duration_secs = config.duration_secs,
            optimal_pool_size = optimal_pool_size,
            reposition_threshold = reposition_threshold,
            "Configured decoder pool for video duration"
        );

        Self {
            config,
            positions,
            access_history: BTreeMap::new(),
            total_accesses: 0,
            reposition_threshold,
            optimal_pool_size,
        }
    }

    fn calculate_initial_positions(
        config: &MultiPositionDecoderConfig,
        pool_size: usize,
    ) -> Vec<f32> {
        if let Some(ref kf_index) = config.keyframe_index {
            let strategic = kf_index.get_strategic_positions(pool_size);
            strategic.into_iter().map(|t| t as f32).collect()
        } else {
            let duration = config.duration_secs as f32;
            if duration <= 0.0 {
                vec![0.0]
            } else {
                (0..pool_size)
                    .map(|i| {
                        let frac = i as f32 / pool_size as f32;
                        (duration * frac).min(duration)
                    })
                    .collect()
            }
        }
    }

    pub fn optimal_pool_size(&self) -> usize {
        self.optimal_pool_size
    }

    pub fn reposition_threshold(&self) -> f32 {
        self.reposition_threshold
    }

    pub fn find_best_decoder_for_time(&mut self, requested_time: f32) -> (usize, f32, bool) {
        self.total_accesses += 1;

        let frame = (requested_time * self.config.fps as f32).floor() as u32;
        *self.access_history.entry(frame).or_insert(0) += 1;

        let mut best_decoder_id = 0;
        let mut best_distance = f32::MAX;
        let mut needs_reset = true;

        for position in &self.positions {
            let distance = (position.position_secs - requested_time).abs();
            let is_usable = position.position_secs <= requested_time
                && (requested_time - position.position_secs) < self.reposition_threshold;

            if is_usable && distance < best_distance {
                best_distance = distance;
                best_decoder_id = position.id;
                needs_reset = false;
            }
        }

        if needs_reset {
            for position in &self.positions {
                let distance = (position.position_secs - requested_time).abs();
                if distance < best_distance {
                    best_distance = distance;
                    best_decoder_id = position.id;
                }
            }
        }

        if let Some(pos) = self.positions.iter_mut().find(|p| p.id == best_decoder_id) {
            pos.touch();
        }

        (best_decoder_id, best_distance, needs_reset)
    }

    pub fn update_decoder_position(&mut self, decoder_id: usize, new_position: f32) {
        if let Some(pos) = self.positions.iter_mut().find(|p| p.id == decoder_id) {
            pos.position_secs = new_position;
        }
    }

    pub fn should_rebalance(&self) -> bool {
        self.total_accesses > 0 && self.total_accesses.is_multiple_of(100)
    }

    pub fn get_rebalance_positions(&self) -> Vec<f32> {
        if self.access_history.is_empty() {
            return self.positions.iter().map(|p| p.position_secs).collect();
        }

        let mut hotspots: Vec<(u32, u64)> = self
            .access_history
            .iter()
            .map(|(&frame, &count)| (frame, count))
            .collect();
        hotspots.sort_by(|a, b| b.1.cmp(&a.1));

        let top_hotspots: Vec<f32> = hotspots
            .into_iter()
            .take(self.optimal_pool_size)
            .map(|(frame, _)| frame as f32 / self.config.fps as f32)
            .collect();

        if top_hotspots.len() < self.optimal_pool_size {
            let mut result = top_hotspots;
            let remaining = self.optimal_pool_size - result.len();
            let duration = self.config.duration_secs as f32;
            for i in 0..remaining {
                let frac = (i + 1) as f32 / (remaining + 1) as f32;
                result.push(duration * frac);
            }
            result
        } else {
            top_hotspots
        }
    }

    pub fn positions(&self) -> &[DecoderPosition] {
        &self.positions
    }

    pub fn config(&self) -> &MultiPositionDecoderConfig {
        &self.config
    }
}

pub struct ScrubDetector {
    last_request_time: std::time::Instant,
    last_frame: u32,
    request_rate: f64,
    is_scrubbing: bool,
    scrub_start_time: Option<std::time::Instant>,
    last_frame_delta: u32,
}

impl ScrubDetector {
    const SCRUB_FRAME_JUMP_THRESHOLD: u32 = 5;
    const SCRUB_COOLDOWN_MS: u64 = 100;
    const SEQUENTIAL_PLAYBACK_THRESHOLD: u32 = 2;

    pub fn new() -> Self {
        Self {
            last_request_time: std::time::Instant::now(),
            last_frame: 0,
            request_rate: 0.0,
            is_scrubbing: false,
            scrub_start_time: None,
            last_frame_delta: 0,
        }
    }

    pub fn record_request(&mut self, frame: u32) -> bool {
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(self.last_request_time);
        let elapsed_secs = elapsed.as_secs_f64().max(0.001);

        let frame_delta = frame.abs_diff(self.last_frame);
        self.last_frame_delta = frame_delta;

        let instantaneous_rate = frame_delta as f64 / elapsed_secs;
        self.request_rate = self.request_rate * 0.7 + instantaneous_rate * 0.3;

        if frame_delta <= Self::SEQUENTIAL_PLAYBACK_THRESHOLD {
            self.is_scrubbing = false;
            self.scrub_start_time = None;
        } else if frame_delta >= Self::SCRUB_FRAME_JUMP_THRESHOLD {
            self.is_scrubbing = true;
            if self.scrub_start_time.is_none() {
                self.scrub_start_time = Some(now);
            }
        } else if elapsed.as_millis() as u64 > Self::SCRUB_COOLDOWN_MS {
            self.is_scrubbing = false;
            self.scrub_start_time = None;
        }

        self.last_request_time = now;
        self.last_frame = frame;

        self.is_scrubbing
    }

    pub fn is_scrubbing(&self) -> bool {
        self.is_scrubbing
    }

    pub fn request_rate(&self) -> f64 {
        self.request_rate
    }

    pub fn last_frame(&self) -> u32 {
        self.last_frame
    }

    pub fn last_frame_delta(&self) -> u32 {
        self.last_frame_delta
    }

    pub fn scrub_duration(&self) -> Option<std::time::Duration> {
        self.scrub_start_time.map(|start| start.elapsed())
    }
}

impl Default for ScrubDetector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_optimal_pool_size_short_video() {
        assert_eq!(calculate_optimal_pool_size(60.0), BASE_DECODER_POOL_SIZE);
        assert_eq!(calculate_optimal_pool_size(300.0), BASE_DECODER_POOL_SIZE);
        assert_eq!(calculate_optimal_pool_size(599.0), BASE_DECODER_POOL_SIZE);
    }

    #[test]
    fn test_calculate_optimal_pool_size_long_video() {
        assert_eq!(
            calculate_optimal_pool_size(600.0),
            BASE_DECODER_POOL_SIZE + 2
        );
        assert_eq!(
            calculate_optimal_pool_size(1200.0),
            BASE_DECODER_POOL_SIZE + 2
        );
        assert_eq!(
            calculate_optimal_pool_size(1799.0),
            BASE_DECODER_POOL_SIZE + 2
        );
    }

    #[test]
    fn test_calculate_optimal_pool_size_very_long_video() {
        assert_eq!(calculate_optimal_pool_size(1800.0), MAX_DECODER_POOL_SIZE);
        assert_eq!(calculate_optimal_pool_size(3600.0), MAX_DECODER_POOL_SIZE);
        assert_eq!(calculate_optimal_pool_size(7200.0), MAX_DECODER_POOL_SIZE);
    }

    #[test]
    fn test_calculate_reposition_threshold_short_video() {
        assert_eq!(
            calculate_reposition_threshold(60.0),
            BASE_REPOSITION_THRESHOLD_SECS
        );
        assert_eq!(
            calculate_reposition_threshold(300.0),
            BASE_REPOSITION_THRESHOLD_SECS
        );
    }

    #[test]
    fn test_calculate_reposition_threshold_long_video() {
        assert_eq!(calculate_reposition_threshold(600.0), 7.0);
        assert_eq!(calculate_reposition_threshold(1200.0), 7.0);
    }

    #[test]
    fn test_calculate_reposition_threshold_very_long_video() {
        assert_eq!(calculate_reposition_threshold(1800.0), 10.0);
        assert_eq!(calculate_reposition_threshold(3600.0), 10.0);
    }

    #[test]
    fn test_55_minute_video_gets_max_decoders() {
        let duration_55_min = 55.0 * 60.0;
        assert_eq!(
            calculate_optimal_pool_size(duration_55_min),
            MAX_DECODER_POOL_SIZE
        );
        assert_eq!(calculate_reposition_threshold(duration_55_min), 10.0);
    }
}
