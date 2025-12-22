use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use tokio::runtime::Handle as TokioHandle;

use cap_video_decode::avassetreader::KeyframeIndex;

pub const MAX_DECODER_POOL_SIZE: usize = 3;
pub const REPOSITION_THRESHOLD_SECS: f32 = 5.0;

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
}

impl DecoderPoolManager {
    pub fn new(config: MultiPositionDecoderConfig) -> Self {
        let initial_positions = Self::calculate_initial_positions(&config);

        let positions: Vec<DecoderPosition> = initial_positions
            .into_iter()
            .enumerate()
            .map(|(id, pos)| DecoderPosition::new(id, pos))
            .collect();

        Self {
            config,
            positions,
            access_history: BTreeMap::new(),
            total_accesses: 0,
        }
    }

    fn calculate_initial_positions(config: &MultiPositionDecoderConfig) -> Vec<f32> {
        if let Some(ref kf_index) = config.keyframe_index {
            let strategic = kf_index.get_strategic_positions(MAX_DECODER_POOL_SIZE);
            strategic.into_iter().map(|t| t as f32).collect()
        } else {
            let duration = config.duration_secs as f32;
            if duration <= 0.0 {
                vec![0.0]
            } else {
                (0..MAX_DECODER_POOL_SIZE)
                    .map(|i| {
                        let frac = i as f32 / MAX_DECODER_POOL_SIZE as f32;
                        (duration * frac).min(duration)
                    })
                    .collect()
            }
        }
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
                && (requested_time - position.position_secs) < REPOSITION_THRESHOLD_SECS;

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
        self.total_accesses > 0 && self.total_accesses % 100 == 0
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
            .take(MAX_DECODER_POOL_SIZE)
            .map(|(frame, _)| frame as f32 / self.config.fps as f32)
            .collect();

        if top_hotspots.len() < MAX_DECODER_POOL_SIZE {
            let mut result = top_hotspots;
            let remaining = MAX_DECODER_POOL_SIZE - result.len();
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
}

impl ScrubDetector {
    const SCRUB_THRESHOLD_RATE: f64 = 5.0;
    const SCRUB_COOLDOWN_MS: u64 = 150;

    pub fn new() -> Self {
        Self {
            last_request_time: std::time::Instant::now(),
            last_frame: 0,
            request_rate: 0.0,
            is_scrubbing: false,
            scrub_start_time: None,
        }
    }

    pub fn record_request(&mut self, frame: u32) -> bool {
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(self.last_request_time);
        let elapsed_secs = elapsed.as_secs_f64().max(0.001);

        let frame_delta = frame.abs_diff(self.last_frame);

        let instantaneous_rate = frame_delta as f64 / elapsed_secs;
        self.request_rate = self.request_rate * 0.7 + instantaneous_rate * 0.3;

        let was_scrubbing = self.is_scrubbing;

        if self.request_rate > Self::SCRUB_THRESHOLD_RATE && frame_delta > 1 {
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

    pub fn scrub_duration(&self) -> Option<std::time::Duration> {
        self.scrub_start_time.map(|start| start.elapsed())
    }
}

impl Default for ScrubDetector {
    fn default() -> Self {
        Self::new()
    }
}
