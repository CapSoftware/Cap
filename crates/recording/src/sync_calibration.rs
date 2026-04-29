use cap_audio::{
    CalibrationStore, DeviceSyncCalibration, SyncAnalyzer, calculate_frame_motion_score,
};
use std::path::{Path, PathBuf};
use tracing::{debug, info, warn};

pub struct PostRecordingSyncAnalysis {
    analyzer: SyncAnalyzer,
    camera_device_id: Option<String>,
    mic_device_id: Option<String>,
    calibration_dir: PathBuf,
    previous_frame: Option<Vec<u8>>,
    frame_width: u32,
    frame_height: u32,
}

impl PostRecordingSyncAnalysis {
    pub fn new(
        sample_rate: u32,
        fps: f64,
        camera_device_id: Option<String>,
        mic_device_id: Option<String>,
        calibration_dir: PathBuf,
        frame_width: u32,
        frame_height: u32,
    ) -> Self {
        Self {
            analyzer: SyncAnalyzer::new(sample_rate, fps),
            camera_device_id,
            mic_device_id,
            calibration_dir,
            previous_frame: None,
            frame_width,
            frame_height,
        }
    }

    pub fn process_video_frame(&mut self, frame_data: &[u8], time_secs: f64) {
        if let Some(prev) = &self.previous_frame {
            let motion =
                calculate_frame_motion_score(frame_data, prev, self.frame_width, self.frame_height);
            self.analyzer.add_video_frame_motion(time_secs, motion);
        }
        self.previous_frame = Some(frame_data.to_vec());
    }

    pub fn process_audio_samples(&mut self, samples: &[f32], start_time_secs: f64) {
        self.analyzer.add_audio_samples(samples, start_time_secs);
    }

    pub fn finalize_and_save(&mut self) -> Option<f64> {
        let (camera_id, mic_id) = match (&self.camera_device_id, &self.mic_device_id) {
            (Some(cam), Some(mic)) => (cam.clone(), mic.clone()),
            _ => {
                debug!("Skipping sync calibration: missing device IDs");
                return None;
            }
        };

        let result = self.analyzer.calculate_sync_offset()?;

        if result.confidence < 0.5 {
            debug!(
                "Sync analysis confidence too low: {:.0}%",
                result.confidence * 100.0
            );
            return None;
        }

        info!(
            "Sync analysis complete: offset={:.1}ms, confidence={:.0}%, events={}",
            result.offset_secs * 1000.0,
            result.confidence * 100.0,
            result.detected_events.len()
        );

        let mut store = CalibrationStore::load(&self.calibration_dir);

        let mut calibration = DeviceSyncCalibration::new(camera_id, mic_id);
        calibration.update_with_measurement(result.offset_secs, result.confidence);

        if let Some(existing) =
            store.get_calibration(&calibration.camera_id, &calibration.microphone_id)
        {
            calibration.measured_offset_secs = existing.offset_secs;
            calibration.confidence = existing.confidence;
            calibration.measurement_count = existing.measurement_count;
            calibration.update_with_measurement(result.offset_secs, result.confidence);
        }

        store.update_calibration(&calibration);

        if let Err(e) = store.save(&self.calibration_dir) {
            warn!("Failed to save calibration store: {}", e);
        } else {
            info!(
                "Saved calibration: offset={:.1}ms after {} measurements",
                calibration.measured_offset_secs * 1000.0,
                calibration.measurement_count
            );
        }

        Some(calibration.measured_offset_secs)
    }
}

pub fn analyze_recording_for_sync(
    audio_path: &Path,
    video_path: &Path,
    camera_device_id: Option<&str>,
    mic_device_id: Option<&str>,
    calibration_dir: &Path,
) -> Option<f64> {
    use cap_audio::AudioData;
    use cap_rendering::Video;

    let audio = match AudioData::from_file(audio_path) {
        Ok(a) => a,
        Err(e) => {
            warn!("Failed to load audio for sync analysis: {}", e);
            return None;
        }
    };

    let video = match Video::new(video_path, 0.0) {
        Ok(v) => v,
        Err(e) => {
            warn!("Failed to load video for sync analysis: {}", e);
            return None;
        }
    };

    let sample_rate = AudioData::SAMPLE_RATE;
    let fps = video.fps as f64;

    let mut analyzer = PostRecordingSyncAnalysis::new(
        sample_rate,
        fps,
        camera_device_id.map(String::from),
        mic_device_id.map(String::from),
        calibration_dir.to_path_buf(),
        video.width,
        video.height,
    );

    let samples = audio.samples();
    let chunk_size = (sample_rate as usize) / 10;
    for (i, chunk) in samples.chunks(chunk_size).enumerate() {
        let time = i as f64 * (chunk_size as f64 / sample_rate as f64);
        analyzer.process_audio_samples(chunk, time);
    }

    analyzer.finalize_and_save()
}
