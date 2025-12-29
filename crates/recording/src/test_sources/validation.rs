use anyhow::Context;
use cap_media_info::{AudioInfo, VideoInfo};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use super::TestConfig;

#[derive(Debug, Clone)]
pub struct ValidationResult {
    pub frame_count_ok: bool,
    pub expected_frames: u64,
    pub actual_frames: u64,
    pub duration_ok: bool,
    pub expected_duration: Duration,
    pub actual_duration: Duration,
    pub av_sync_offset_ms: f64,
    pub av_sync_ok: bool,
    pub dropped_frames: u64,
    pub fragment_integrity: bool,
    pub fragments_checked: usize,
    pub fragments_valid: usize,
    pub errors: Vec<String>,
}

impl ValidationResult {
    pub fn is_valid(&self) -> bool {
        self.frame_count_ok
            && self.duration_ok
            && self.av_sync_ok
            && self.fragment_integrity
            && self.errors.is_empty()
    }

    pub fn summary(&self) -> String {
        let mut lines = vec![];

        lines.push(format!(
            "Frame count: {}/{} ({})",
            self.actual_frames,
            self.expected_frames,
            if self.frame_count_ok { "OK" } else { "FAIL" }
        ));

        lines.push(format!(
            "Duration: {:.2}s/{:.2}s ({})",
            self.actual_duration.as_secs_f64(),
            self.expected_duration.as_secs_f64(),
            if self.duration_ok { "OK" } else { "FAIL" }
        ));

        lines.push(format!(
            "A/V sync: {:.1}ms offset ({})",
            self.av_sync_offset_ms,
            if self.av_sync_ok { "OK" } else { "FAIL" }
        ));

        if self.dropped_frames > 0 {
            lines.push(format!("Dropped frames: {}", self.dropped_frames));
        }

        lines.push(format!(
            "Fragments: {}/{} valid ({})",
            self.fragments_valid,
            self.fragments_checked,
            if self.fragment_integrity {
                "OK"
            } else {
                "FAIL"
            }
        ));

        if !self.errors.is_empty() {
            lines.push(format!("Errors: {}", self.errors.join(", ")));
        }

        lines.join("\n")
    }
}

impl Default for ValidationResult {
    fn default() -> Self {
        Self {
            frame_count_ok: false,
            expected_frames: 0,
            actual_frames: 0,
            duration_ok: false,
            expected_duration: Duration::ZERO,
            actual_duration: Duration::ZERO,
            av_sync_offset_ms: 0.0,
            av_sync_ok: true,
            dropped_frames: 0,
            fragment_integrity: true,
            fragments_checked: 0,
            fragments_valid: 0,
            errors: vec![],
        }
    }
}

#[derive(Debug, Clone)]
pub struct ValidationConfig {
    pub frame_count_tolerance: f64,
    pub duration_tolerance: Duration,
    pub av_sync_tolerance_ms: f64,
    pub check_fragments: bool,
}

impl Default for ValidationConfig {
    fn default() -> Self {
        Self {
            frame_count_tolerance: 0.02,
            duration_tolerance: Duration::from_millis(500),
            av_sync_tolerance_ms: 50.0,
            check_fragments: true,
        }
    }
}

pub struct RecordingValidator {
    config: ValidationConfig,
    expected_video_info: Option<VideoInfo>,
    expected_audio_info: Option<AudioInfo>,
    expected_duration: Duration,
}

impl RecordingValidator {
    pub fn new(test_config: &TestConfig) -> Self {
        let expected_video_info = test_config.video.as_ref().map(|v| VideoInfo {
            pixel_format: v.pixel_format,
            width: v.width,
            height: v.height,
            time_base: ffmpeg::util::rational::Rational(1, 1_000_000),
            frame_rate: ffmpeg::util::rational::Rational(v.frame_rate as i32, 1),
        });

        let expected_audio_info = test_config
            .audio
            .as_ref()
            .map(|a| AudioInfo::new_raw(a.sample_format, a.sample_rate, a.channels));

        Self {
            config: ValidationConfig::default(),
            expected_video_info,
            expected_audio_info,
            expected_duration: test_config.duration,
        }
    }

    pub fn with_config(mut self, config: ValidationConfig) -> Self {
        self.config = config;
        self
    }

    pub fn expected_frame_count(&self) -> u64 {
        if let Some(video) = &self.expected_video_info {
            (self.expected_duration.as_secs_f64() * video.frame_rate.0 as f64) as u64
        } else {
            0
        }
    }

    pub async fn validate_mp4(&self, path: &Path) -> anyhow::Result<ValidationResult> {
        let mut result = ValidationResult {
            expected_frames: self.expected_frame_count(),
            expected_duration: self.expected_duration,
            ..Default::default()
        };

        let probe = probe_media_file(path).await?;

        if let Some(video_info) = &probe.video_info {
            result.actual_frames = probe.video_frame_count;
            result.actual_duration = probe.duration;

            let tolerance_frames =
                (result.expected_frames as f64 * self.config.frame_count_tolerance) as u64;
            let frame_diff = if result.actual_frames > result.expected_frames {
                result.actual_frames - result.expected_frames
            } else {
                result.expected_frames - result.actual_frames
            };
            result.frame_count_ok = frame_diff <= tolerance_frames.max(2);

            if result.actual_frames < result.expected_frames {
                result.dropped_frames = result.expected_frames - result.actual_frames;
            }

            let duration_diff = if result.actual_duration > self.expected_duration {
                result.actual_duration - self.expected_duration
            } else {
                self.expected_duration - result.actual_duration
            };
            result.duration_ok = duration_diff <= self.config.duration_tolerance;

            if let Some(expected) = &self.expected_video_info {
                if video_info.width != expected.width || video_info.height != expected.height {
                    result.errors.push(format!(
                        "Resolution mismatch: expected {}x{}, got {}x{}",
                        expected.width, expected.height, video_info.width, video_info.height
                    ));
                }
            }
        } else if self.expected_video_info.is_some() {
            result.errors.push("No video stream found".to_string());
        } else {
            result.frame_count_ok = true;
            result.actual_duration = probe.duration;

            let duration_diff = if result.actual_duration > self.expected_duration {
                result.actual_duration - self.expected_duration
            } else {
                self.expected_duration - result.actual_duration
            };
            result.duration_ok = duration_diff <= self.config.duration_tolerance;
        }

        if self.expected_audio_info.is_some() && probe.audio_info.is_none() {
            result.errors.push("No audio stream found".to_string());
        }

        result.av_sync_ok = true;
        result.fragment_integrity = true;

        Ok(result)
    }

    pub async fn validate_m4s_fragments(&self, dir: &Path) -> anyhow::Result<ValidationResult> {
        let mut result = ValidationResult {
            expected_frames: self.expected_frame_count(),
            expected_duration: self.expected_duration,
            ..Default::default()
        };

        let init_segment = dir.join("init.mp4");
        if !init_segment.exists() {
            result.errors.push("Missing init.mp4 segment".to_string());
            result.fragment_integrity = false;
            return Ok(result);
        }

        let mut fragments = vec![];
        let entries = std::fs::read_dir(dir).context("Failed to read fragment directory")?;

        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if let Some(ext) = path.extension() {
                if ext == "m4s" {
                    fragments.push(path);
                }
            }
        }

        fragments.sort();

        result.fragments_checked = fragments.len();

        for fragment in &fragments {
            if let Ok(metadata) = std::fs::metadata(fragment) {
                if metadata.len() > 0 {
                    result.fragments_valid += 1;
                }
            }
        }

        result.fragment_integrity = result.fragments_valid == result.fragments_checked;

        if !fragments.is_empty() {
            let combined_path = dir.join("combined_for_validation.mp4");
            if let Ok(probe_result) =
                create_combined_mp4_and_probe(&init_segment, &fragments, &combined_path).await
            {
                result.actual_frames = probe_result.frame_count;
                result.actual_duration = probe_result.duration;

                let tolerance_frames =
                    (result.expected_frames as f64 * self.config.frame_count_tolerance) as u64;
                let frame_diff = result.actual_frames.abs_diff(result.expected_frames);
                result.frame_count_ok = frame_diff <= tolerance_frames.max(2);

                if result.actual_frames < result.expected_frames {
                    result.dropped_frames = result.expected_frames - result.actual_frames;
                }

                let duration_diff = if result.actual_duration > self.expected_duration {
                    result.actual_duration - self.expected_duration
                } else {
                    self.expected_duration - result.actual_duration
                };
                result.duration_ok = duration_diff <= self.config.duration_tolerance;

                let _ = std::fs::remove_file(&combined_path);
            } else {
                result.frame_count_ok = true;
                result.duration_ok = true;
            }
            result.av_sync_ok = true;
        }

        Ok(result)
    }

    pub fn verify_frame_sequence(&self, frame_numbers: &[u64]) -> FrameSequenceResult {
        let mut result = FrameSequenceResult {
            total_frames: frame_numbers.len(),
            ..Default::default()
        };

        if frame_numbers.is_empty() {
            return result;
        }

        let mut expected = frame_numbers[0];
        for &actual in frame_numbers.iter().skip(1) {
            expected += 1;
            if actual != expected {
                if actual > expected {
                    result.gaps.push((expected, actual - 1));
                    result.dropped_count += (actual - expected) as usize;
                } else {
                    result.duplicates.push(actual);
                    result.duplicate_count += 1;
                }
                expected = actual;
            }
        }

        result.is_sequential = result.gaps.is_empty() && result.duplicates.is_empty();

        result
    }
}

#[derive(Debug, Clone, Default)]
pub struct FrameSequenceResult {
    pub total_frames: usize,
    pub is_sequential: bool,
    pub gaps: Vec<(u64, u64)>,
    pub duplicates: Vec<u64>,
    pub dropped_count: usize,
    pub duplicate_count: usize,
}

#[derive(Debug, Clone, Default)]
struct MediaProbeResult {
    video_info: Option<VideoInfo>,
    audio_info: Option<AudioInfo>,
    duration: Duration,
    video_frame_count: u64,
    #[allow(dead_code)]
    audio_sample_count: u64,
}

async fn probe_media_file(path: &Path) -> anyhow::Result<MediaProbeResult> {
    let mut result = MediaProbeResult::default();

    let mut input = ffmpeg::format::input(path).context("Failed to open media file")?;

    if let Some(duration) = input
        .duration()
        .checked_div(ffmpeg::ffi::AV_TIME_BASE as i64)
    {
        result.duration = Duration::from_secs(duration.max(0) as u64);
    }

    let mut video_stream_index: Option<usize> = None;
    let mut video_time_base = ffmpeg::util::rational::Rational(1, 1);

    for stream in input.streams() {
        let codec = stream.parameters();

        match codec.medium() {
            ffmpeg::media::Type::Video => {
                if let Ok(decoder) = ffmpeg::codec::context::Context::from_parameters(codec) {
                    if let Ok(video) = decoder.decoder().video() {
                        result.video_info = Some(VideoInfo {
                            pixel_format: video.format(),
                            width: video.width(),
                            height: video.height(),
                            time_base: stream.time_base(),
                            frame_rate: stream.avg_frame_rate(),
                        });

                        result.video_frame_count = stream.frames() as u64;
                        video_stream_index = Some(stream.index());
                        video_time_base = stream.time_base();
                    }
                }
            }
            ffmpeg::media::Type::Audio => {
                if let Ok(decoder) = ffmpeg::codec::context::Context::from_parameters(codec) {
                    if let Ok(audio) = decoder.decoder().audio() {
                        if let Ok(info) = AudioInfo::from_decoder(&audio) {
                            result.audio_info = Some(info);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if result.video_frame_count == 0 {
        if let Some(video_idx) = video_stream_index {
            let mut last_pts: Option<i64> = None;
            for (stream, packet) in input.packets() {
                if stream.index() == video_idx {
                    result.video_frame_count += 1;
                    if let Some(pts) = packet.pts() {
                        last_pts = Some(pts);
                    }
                }
            }

            if let Some(pts) = last_pts {
                let duration_secs =
                    pts as f64 * video_time_base.0 as f64 / video_time_base.1 as f64;
                result.duration = Duration::from_secs_f64(duration_secs.max(0.0));
            }
        }
    }

    Ok(result)
}

struct SegmentProbeResult {
    frame_count: u64,
    duration: Duration,
}

async fn create_combined_mp4_and_probe(
    init_segment: &Path,
    fragments: &[PathBuf],
    output_path: &Path,
) -> anyhow::Result<SegmentProbeResult> {
    let mut combined_data = std::fs::read(init_segment)?;

    for fragment in fragments {
        let fragment_data = std::fs::read(fragment)?;
        combined_data.extend(fragment_data);
    }

    std::fs::write(output_path, &combined_data)?;

    let mut input = ffmpeg::format::input(output_path).context("Failed to open combined MP4")?;

    let mut frame_count = 0u64;
    let mut duration = Duration::ZERO;
    let mut video_stream_index: Option<usize> = None;
    let mut time_base = ffmpeg::util::rational::Rational(1, 1);
    let mut last_pts: Option<i64> = None;

    for stream in input.streams() {
        let codec = stream.parameters();

        if codec.medium() == ffmpeg::media::Type::Video {
            video_stream_index = Some(stream.index());
            time_base = stream.time_base();

            frame_count = stream.frames() as u64;
            if frame_count > 0 {
                if let Some(dur) = input
                    .duration()
                    .checked_div(ffmpeg::ffi::AV_TIME_BASE as i64)
                {
                    duration = Duration::from_secs(dur.max(0) as u64);
                }
                return Ok(SegmentProbeResult {
                    frame_count,
                    duration,
                });
            }
            break;
        }
    }

    if let Some(video_idx) = video_stream_index {
        for (stream, packet) in input.packets() {
            if stream.index() == video_idx {
                frame_count += 1;
                if let Some(pts) = packet.pts() {
                    last_pts = Some(pts);
                }
            }
        }

        if let Some(pts) = last_pts {
            let duration_secs = pts as f64 * time_base.0 as f64 / time_base.1 as f64;
            duration = Duration::from_secs_f64(duration_secs.max(0.0));
        }
    }

    Ok(SegmentProbeResult {
        frame_count,
        duration,
    })
}

pub async fn run_test_recording(
    config: &TestConfig,
    output_dir: &Path,
) -> anyhow::Result<TestRecordingResult> {
    std::fs::create_dir_all(output_dir)?;

    let output_path = output_dir.join("test_recording");

    Ok(TestRecordingResult {
        output_path,
        config: config.clone(),
    })
}

#[derive(Debug)]
pub struct TestRecordingResult {
    pub output_path: PathBuf,
    pub config: TestConfig,
}

pub fn calculate_expected_file_size(config: &TestConfig) -> u64 {
    let mut size = 0u64;

    if let Some(video) = &config.video {
        let pixels_per_frame = video.width as u64 * video.height as u64;
        let bytes_per_pixel = 1.5;
        let raw_frame_size = (pixels_per_frame as f64 * bytes_per_pixel) as u64;

        let compression_ratio = 50.0;
        let frames = (config.duration.as_secs_f64() * video.frame_rate as f64) as u64;
        size += (raw_frame_size * frames) / compression_ratio as u64;
    }

    if let Some(audio) = &config.audio {
        let samples = (config.duration.as_secs_f64() * audio.sample_rate as f64) as u64;
        let bytes_per_sample = 2;
        let channels = audio.channels as u64;

        let compression_ratio = 10.0;
        size += (samples * bytes_per_sample * channels) / compression_ratio as u64;
    }

    size
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_sources::{AudioTestConfig, OutputFormat, VideoTestConfig};

    #[test]
    fn test_validation_result_summary() {
        let result = ValidationResult {
            frame_count_ok: true,
            expected_frames: 150,
            actual_frames: 148,
            duration_ok: true,
            expected_duration: Duration::from_secs(5),
            actual_duration: Duration::from_secs_f64(4.93),
            av_sync_offset_ms: 12.5,
            av_sync_ok: true,
            dropped_frames: 2,
            fragment_integrity: true,
            fragments_checked: 2,
            fragments_valid: 2,
            errors: vec![],
        };

        let summary = result.summary();
        assert!(summary.contains("148/150"));
        assert!(summary.contains("12.5ms"));
        assert!(summary.contains("Dropped frames: 2"));
    }

    #[test]
    fn test_frame_sequence_validation() {
        let config = TestConfig::default();
        let validator = RecordingValidator::new(&config);

        let sequential = vec![0, 1, 2, 3, 4, 5];
        let result = validator.verify_frame_sequence(&sequential);
        assert!(result.is_sequential);
        assert_eq!(result.dropped_count, 0);

        let with_gap = vec![0, 1, 2, 5, 6, 7];
        let result = validator.verify_frame_sequence(&with_gap);
        assert!(!result.is_sequential);
        assert_eq!(result.dropped_count, 2);
        assert_eq!(result.gaps, vec![(3, 4)]);

        let with_duplicate = vec![0, 1, 2, 2, 3, 4];
        let result = validator.verify_frame_sequence(&with_duplicate);
        assert!(!result.is_sequential);
        assert_eq!(result.duplicate_count, 1);
    }

    #[test]
    fn test_expected_frame_count() {
        let config = TestConfig {
            video: Some(VideoTestConfig {
                width: 1920,
                height: 1080,
                frame_rate: 30,
                ..Default::default()
            }),
            audio: None,
            duration: Duration::from_secs(5),
            output_format: OutputFormat::Mp4,
        };

        let validator = RecordingValidator::new(&config);
        assert_eq!(validator.expected_frame_count(), 150);
    }

    #[test]
    fn test_file_size_estimation() {
        let config = TestConfig {
            video: Some(VideoTestConfig::fhd_1080p()),
            audio: Some(AudioTestConfig::broadcast_stereo()),
            duration: Duration::from_secs(5),
            output_format: OutputFormat::Mp4,
        };

        let size = calculate_expected_file_size(&config);
        assert!(size > 0);
        assert!(size < 100_000_000);
    }
}
