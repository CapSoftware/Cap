use cap_media_info::{AudioInfo, VideoInfo, ensure_even};
use cidre::{cm::SampleTimingInfo, objc::Obj, *};
use ffmpeg::{frame, software::resampling};
use std::{path::PathBuf, time::Duration};
use tracing::*;

const AAC_MAX_SAMPLE_RATE: u32 = 48000;

// before pausing at all, subtract 0.
// on pause, record last frame time.
// on resume, store last frame time and clear offset timestamp
// on next frame, set offset timestamp and subtract (offset timestamp - last frame time - previous offset)
// on next pause, store (offset timestamp - last frame time) into previous offset

pub struct MP4Encoder {
    #[allow(unused)]
    config: VideoInfo,
    asset_writer: arc::R<av::AssetWriter>,
    video_input: arc::R<av::AssetWriterInput>,
    audio_input: Option<arc::R<av::AssetWriterInput>>,
    audio_resampler: Option<resampling::Context>,
    audio_output_rate: u32,
    expected_width: usize,
    expected_height: usize,
    dimension_mismatch_count: u64,
    last_frame_timestamp: Option<Duration>,
    pause_timestamp: Option<Duration>,
    timestamp_offset: Duration,
    is_writing: bool,
    is_paused: bool,
    writer_failed: bool,
    video_frames_appended: usize,
    audio_frames_appended: usize,
    last_timestamp: Option<Duration>,
    last_video_pts: Option<Duration>,
    last_audio_end_pts: Option<i64>,
    last_audio_timescale: Option<i32>,
}

#[derive(thiserror::Error, Debug)]
pub enum InitError {
    #[error("AssetWriterCreate/{0}")]
    AssetWriterCreate(&'static cidre::ns::Error),
    #[error("No settings assistant")]
    NoSettingsAssistant,
    #[error("No video settings assistant")]
    NoVideoSettingsAssistant,
    #[error("VideoAssetWriterInputCreate/{0}")]
    VideoAssetWriterInputCreate(&'static cidre::ns::Exception),
    #[error("AddVideoInput/{0}")]
    AddVideoInput(&'static cidre::ns::Exception),
    #[error("AudioAssetWriterInputCreate/{0}")]
    AudioAssetWriterInputCreate(&'static cidre::ns::Exception),
    #[error("AddAudioInput/{0}")]
    AddAudioInput(&'static cidre::ns::Exception),
    #[error("AudioResampler/{0}")]
    AudioResampler(ffmpeg::Error),
    #[error("InvalidConfig: {0}")]
    InvalidConfig(String),
    #[error("OutputPath: {0}")]
    OutputPath(String),
    #[error("StartWritingFailed: {0}")]
    StartWritingFailed(String),
}

#[derive(thiserror::Error, Debug)]
pub enum QueueFrameError {
    #[error("AppendError/{0}")]
    AppendError(arc::R<ns::Exception>),
    #[error("Failed")]
    Failed,
    #[error("WriterFailed/{0}")]
    WriterFailed(arc::R<ns::Error>),
    #[error("Construct/{0}")]
    Construct(cidre::os::Error),
    #[error("NotReadyForMore")]
    NotReadyForMore,
    #[error("NoEncoder")]
    NoEncoder,
    #[error("ResamplingFailed/{0}")]
    ResamplingFailed(ffmpeg::Error),
}

#[derive(thiserror::Error, Debug)]
pub enum FinishError {
    #[error("NotWriting")]
    NotWriting,
    #[error("NoFrames")]
    NoFrames,
    #[error("Failed")]
    Failed,
}

impl MP4Encoder {
    pub fn init(
        output: PathBuf,
        video_config: VideoInfo,
        audio_config: Option<AudioInfo>,
        output_height: Option<u32>,
    ) -> Result<Self, InitError> {
        Self::init_with_options(output, video_config, audio_config, output_height, false)
    }

    pub fn init_instant_mode(
        output: PathBuf,
        video_config: VideoInfo,
        audio_config: Option<AudioInfo>,
        output_height: Option<u32>,
    ) -> Result<Self, InitError> {
        Self::init_with_options(output, video_config, audio_config, output_height, true)
    }

    fn init_with_options(
        output: PathBuf,
        video_config: VideoInfo,
        audio_config: Option<AudioInfo>,
        output_height: Option<u32>,
        instant_mode: bool,
    ) -> Result<Self, InitError> {
        info!(
            width = video_config.width,
            height = video_config.height,
            pixel_format = ?video_config.pixel_format,
            frame_rate = ?video_config.frame_rate,
            output_height = ?output_height,
            has_audio = audio_config.is_some(),
            instant_mode,
            "Initializing AVFoundation MP4 encoder (VideoToolbox hardware encoding)"
        );
        debug!("{video_config:#?}");
        debug!("{audio_config:#?}");

        if video_config.width == 0 || video_config.height == 0 {
            return Err(InitError::InvalidConfig(format!(
                "Video dimensions must be non-zero, got {}x{}",
                video_config.width, video_config.height
            )));
        }

        if video_config.frame_rate.0 <= 0 || video_config.frame_rate.1 <= 0 {
            return Err(InitError::InvalidConfig(format!(
                "Frame rate components must be positive, got {}/{}",
                video_config.frame_rate.0, video_config.frame_rate.1
            )));
        }

        if let Some(parent) = output.parent()
            && !parent.exists()
        {
            std::fs::create_dir_all(parent).map_err(|e| {
                InitError::OutputPath(format!(
                    "Failed to create parent directory {}: {e}",
                    parent.display()
                ))
            })?;
        }

        if output.exists() {
            warn!(path = %output.display(), "Output file already exists, removing before creating AVAssetWriter");
            std::fs::remove_file(&output).map_err(|e| {
                InitError::OutputPath(format!(
                    "Failed to remove existing output file {}: {e}",
                    output.display()
                ))
            })?;
        }

        let fps = video_config.frame_rate.0 as f32 / video_config.frame_rate.1 as f32;

        let mut asset_writer = av::AssetWriter::with_url_and_file_type(
            cf::Url::with_path(output.as_path(), false).unwrap().as_ns(),
            av::FileType::mp4(),
        )
        .map_err(InitError::AssetWriterCreate)?;

        let video_input = {
            let assistant = av::OutputSettingsAssistant::with_preset(
                av::OutputSettingsPreset::h264_3840x2160(),
            )
            .ok_or(InitError::NoSettingsAssistant)?;

            let mut output_settings = assistant
                .video_settings()
                .ok_or(InitError::NoVideoSettingsAssistant)?
                .copy_mut();

            let output_height = ensure_even(output_height.unwrap_or(video_config.height));
            let output_width = if video_config.height == 0 {
                ensure_even(video_config.width)
            } else {
                ensure_even(
                    ((video_config.width as u64 * output_height as u64)
                        / video_config.height as u64) as u32,
                )
            };

            output_settings.insert(
                av::video_settings_keys::width(),
                ns::Number::with_u32(output_width).as_id_ref(),
            );

            output_settings.insert(
                av::video_settings_keys::height(),
                ns::Number::with_u32(output_height).as_id_ref(),
            );

            let bitrate = if instant_mode {
                get_instant_mode_bitrate(output_width as f32, output_height as f32, fps)
            } else {
                get_average_bitrate(output_width as f32, output_height as f32, fps)
            };

            debug!(instant_mode, "recording bitrate: {bitrate}");

            let keyframe_interval = if instant_mode {
                fps as i32
            } else {
                (fps * 2.0) as i32
            };

            output_settings.insert(
                av::video_settings_keys::compression_props(),
                ns::Dictionary::with_keys_values(
                    &[
                        unsafe { AVVideoAverageBitRateKey },
                        unsafe { AVVideoAllowFrameReorderingKey },
                        unsafe { AVVideoExpectedSourceFrameRateKey },
                        unsafe { AVVideoMaxKeyFrameIntervalKey },
                    ],
                    &[
                        ns::Number::with_f32(bitrate).as_id_ref(),
                        ns::Number::with_bool(false).as_id_ref(),
                        ns::Number::with_f32(fps).as_id_ref(),
                        ns::Number::with_i32(keyframe_interval).as_id_ref(),
                    ],
                )
                .as_id_ref(),
            );

            output_settings.insert(
                av::video_settings_keys::color_props(),
                ns::Dictionary::with_keys_values(
                    &[
                        unsafe { AVVideoTransferFunctionKey },
                        unsafe { AVVideoColorPrimariesKey },
                        unsafe { AVVideoYCbCrMatrixKey },
                    ],
                    &[
                        unsafe { AVVideoTransferFunction_ITU_R_709_2 },
                        unsafe { AVVideoColorPrimaries_ITU_R_709_2 },
                        unsafe { AVVideoYCbCrMatrix_ITU_R_709_2 },
                    ],
                )
                .as_id_ref(),
            );

            let mut video_input = av::AssetWriterInput::with_media_type_and_output_settings(
                av::MediaType::video(),
                Some(output_settings.as_ref()),
            )
            .map_err(InitError::VideoAssetWriterInputCreate)?;
            video_input.set_expects_media_data_in_real_time(true);

            asset_writer
                .add_input(&video_input)
                .map_err(InitError::AddVideoInput)?;

            video_input
        };

        let (audio_input, audio_resampler, audio_output_rate) = match audio_config.as_ref() {
            Some(config) => {
                debug!("{config:?}");

                let output_rate = config.sample_rate.min(AAC_MAX_SAMPLE_RATE);

                let resampler = if config.sample_rate > AAC_MAX_SAMPLE_RATE {
                    info!(
                        input_rate = config.sample_rate,
                        output_rate,
                        "Audio sample rate {} exceeds AAC max {}, resampling",
                        config.sample_rate,
                        AAC_MAX_SAMPLE_RATE
                    );

                    let mut output_config = *config;
                    output_config.sample_rate = output_rate;

                    Some(
                        ffmpeg::software::resampler(
                            (
                                config.sample_format,
                                config.channel_layout(),
                                config.sample_rate,
                            ),
                            (
                                output_config.sample_format,
                                output_config.channel_layout(),
                                output_config.sample_rate,
                            ),
                        )
                        .map_err(InitError::AudioResampler)?,
                    )
                } else {
                    None
                };

                let output_settings = cidre::ns::Dictionary::with_keys_values(
                    &[
                        av::audio::all_formats_keys::id(),
                        av::audio::all_formats_keys::number_of_channels(),
                        av::audio::all_formats_keys::sample_rate(),
                    ],
                    &[
                        cat::AudioFormat::MPEG4_AAC.as_ref(),
                        (config.channels as u32).as_ref(),
                        output_rate.as_ref(),
                    ],
                );

                let mut audio_input = av::AssetWriterInput::with_media_type_and_output_settings(
                    av::MediaType::audio(),
                    Some(output_settings.as_ref()),
                )
                .map_err(InitError::AudioAssetWriterInputCreate)?;

                audio_input.set_expects_media_data_in_real_time(true);

                asset_writer
                    .add_input(&audio_input)
                    .map_err(InitError::AddAudioInput)?;

                (Some(audio_input), resampler, output_rate)
            }
            None => (None, None, 0),
        };

        if !asset_writer.start_writing() {
            let error_desc = asset_writer
                .error()
                .map(|e| format!("{e}"))
                .unwrap_or_else(|| "unknown error".to_string());
            return Err(InitError::StartWritingFailed(error_desc));
        }

        Ok(Self {
            expected_width: video_config.width as usize,
            expected_height: video_config.height as usize,
            dimension_mismatch_count: 0,
            config: video_config,
            audio_input,
            audio_resampler,
            audio_output_rate,
            asset_writer,
            video_input,
            last_frame_timestamp: None,
            pause_timestamp: None,
            timestamp_offset: Duration::ZERO,
            is_writing: false,
            is_paused: false,
            writer_failed: false,
            video_frames_appended: 0,
            audio_frames_appended: 0,
            last_timestamp: None,
            last_video_pts: None,
            last_audio_end_pts: None,
            last_audio_timescale: None,
        })
    }

    pub fn queue_video_frame(
        &mut self,
        frame: arc::R<cm::SampleBuf>,
        timestamp: Duration,
    ) -> Result<(), QueueFrameError> {
        if self.writer_failed {
            return Err(QueueFrameError::Failed);
        }

        if self.is_paused {
            return Ok(());
        };

        if !self.video_input.is_ready_for_more_media_data() {
            return Err(QueueFrameError::NotReadyForMore);
        }

        if let Some(image_buf) = frame.image_buf() {
            let frame_width = image_buf.width();
            let frame_height = image_buf.height();
            if frame_width != self.expected_width || frame_height != self.expected_height {
                self.dimension_mismatch_count += 1;
                if self.dimension_mismatch_count <= 5
                    || self.dimension_mismatch_count.is_multiple_of(100)
                {
                    warn!(
                        expected_width = self.expected_width,
                        expected_height = self.expected_height,
                        frame_width,
                        frame_height,
                        mismatch_count = self.dimension_mismatch_count,
                        "Frame dimension mismatch, dropping frame to protect writer"
                    );
                }
                return Ok(());
            }
        }

        if !self.is_writing {
            self.is_writing = true;
            self.asset_writer
                .start_session_at_src_time(cm::Time::zero());
        }

        self.last_frame_timestamp = Some(timestamp);

        if let Some(pause_timestamp) = self.pause_timestamp
            && let Some(gap) = timestamp.checked_sub(pause_timestamp)
        {
            self.timestamp_offset += gap;
            self.pause_timestamp = None;
        }

        let mut pts_duration = timestamp
            .checked_sub(self.timestamp_offset)
            .unwrap_or(Duration::ZERO);

        if let Some(last_pts) = self.last_video_pts
            && pts_duration <= last_pts
        {
            let frame_duration = self.video_frame_duration();
            let adjusted_pts = last_pts + frame_duration;

            trace!(
                ?timestamp,
                ?last_pts,
                adjusted_pts = ?adjusted_pts,
                frame_duration_ns = frame_duration.as_nanos(),
                "Monotonic video pts correction",
            );

            if let Some(new_offset) = timestamp.checked_sub(adjusted_pts) {
                self.timestamp_offset = new_offset;
            }

            pts_duration = adjusted_pts;
        }

        let frame_duration_us = self.video_frame_duration().as_micros() as i64;
        let timing = SampleTimingInfo {
            duration: cm::Time::new(frame_duration_us.max(1), 1_000_000),
            pts: cm::Time::new(pts_duration.as_micros() as i64, 1_000_000),
            dts: cm::Time::invalid(),
        };
        let new_frame = match frame.copy_with_new_timing(&[timing]) {
            Ok(f) => f,
            Err(e) => {
                warn!(
                    ?e,
                    "Failed to copy sample buffer with new timing, skipping frame"
                );
                return Ok(());
            }
        };
        drop(frame);

        match append_sample_buf(&mut self.video_input, &self.asset_writer, &new_frame) {
            Ok(()) => {}
            Err(QueueFrameError::WriterFailed(err)) => {
                self.writer_failed = true;
                return Err(QueueFrameError::WriterFailed(err));
            }
            Err(e) => return Err(e),
        }

        self.last_video_pts = Some(pts_duration);
        self.video_frames_appended += 1;
        self.last_timestamp = Some(timestamp);

        Ok(())
    }

    pub fn queue_audio_frame(
        &mut self,
        frame: &frame::Audio,
        timestamp: Duration,
    ) -> Result<(), QueueFrameError> {
        if self.writer_failed {
            return Err(QueueFrameError::Failed);
        }

        if self.is_paused {
            return Ok(());
        }

        let Some(audio_input) = &mut self.audio_input else {
            return Err(QueueFrameError::NoEncoder);
        };

        if let Some(pause_timestamp) = self.pause_timestamp
            && let Some(gap) = timestamp.checked_sub(pause_timestamp)
        {
            self.timestamp_offset += gap;
            self.pause_timestamp = None;
        }

        if !self.is_writing {
            self.is_writing = true;
            self.asset_writer
                .start_session_at_src_time(cm::Time::zero());
        }

        if !audio_input.is_ready_for_more_media_data() {
            return Err(QueueFrameError::NotReadyForMore);
        }

        let processed_frame: std::borrow::Cow<'_, frame::Audio> =
            if let Some(resampler) = &mut self.audio_resampler {
                let mut resampled = frame::Audio::empty();
                match resampler.run(frame, &mut resampled) {
                    Ok(_) => {
                        resampled.set_rate(self.audio_output_rate);
                        if resampled.samples() == 0 {
                            warn!(
                                input_samples = frame.samples(),
                                input_rate = frame.rate(),
                                output_rate = self.audio_output_rate,
                                "Audio resampling produced 0 samples"
                            );
                            return Ok(());
                        }
                        std::borrow::Cow::Owned(resampled)
                    }
                    Err(e) => {
                        error!(
                            error = %e,
                            input_samples = frame.samples(),
                            input_rate = frame.rate(),
                            output_rate = self.audio_output_rate,
                            "Audio resampling failed"
                        );
                        return Err(QueueFrameError::ResamplingFailed(e));
                    }
                }
            } else {
                std::borrow::Cow::Borrowed(frame)
            };

        let frame = processed_frame.as_ref();

        if frame.samples() == 0 {
            warn!(
                rate = frame.rate(),
                channels = frame.channels(),
                "Received audio frame with 0 samples, skipping"
            );
            return Ok(());
        }

        let audio_desc = cat::audio::StreamBasicDesc::common_f32(
            frame.rate() as f64,
            frame.channels() as u32,
            frame.is_packed(),
        );

        let total_data = frame.samples() * frame.channels() as usize * frame.format().bytes();

        let mut block_buf =
            cm::BlockBuf::with_mem_block(total_data, None).map_err(QueueFrameError::Construct)?;

        let block_buf_slice = block_buf
            .as_mut_slice()
            .map_err(QueueFrameError::Construct)?;

        if frame.is_planar() {
            let mut offset = 0;
            for plane_i in 0..frame.planes() {
                let data = frame.data(plane_i);
                let channel_data_len = frame.samples() * frame.format().bytes();
                block_buf_slice[offset..offset + channel_data_len]
                    .copy_from_slice(&data[0..channel_data_len]);
                offset += channel_data_len;
            }
        } else {
            block_buf_slice.copy_from_slice(&frame.data(0)[0..total_data]);
        }

        let format_desc =
            cm::AudioFormatDesc::with_asbd(&audio_desc).map_err(QueueFrameError::Construct)?;

        let sample_rate = frame.rate().max(1) as i32;
        let mut pts_value = match (self.last_audio_end_pts, self.last_audio_timescale) {
            (Some(end), Some(scale)) if scale == sample_rate => end,
            (Some(end), Some(scale)) => {
                let converted = duration_to_timescale_value(
                    timescale_value_to_duration(end, scale),
                    sample_rate,
                );
                converted.max(end.max(0) + 1)
            }
            _ => 0,
        };

        if let Some(last_end) = self.last_audio_end_pts
            && self.last_audio_timescale == Some(sample_rate)
            && pts_value < last_end
        {
            warn!(
                pts_value,
                last_end,
                sample_rate,
                "Audio PTS went backwards, correcting to maintain monotonicity"
            );
            pts_value = last_end;
        }

        let new_end = pts_value.saturating_add(frame.samples() as i64);

        let pts = cm::Time::new(pts_value, sample_rate);

        let buffer = cm::SampleBuf::create(
            Some(&block_buf),
            true,
            Some(format_desc.as_ref()),
            frame.samples() as isize,
            &[SampleTimingInfo {
                duration: cm::Time::new(1, sample_rate),
                pts,
                dts: cm::Time::invalid(),
            }],
            &[],
        )
        .map_err(QueueFrameError::Construct)?;

        match append_sample_buf(audio_input, &self.asset_writer, &buffer) {
            Ok(()) => {}
            Err(QueueFrameError::WriterFailed(err)) => {
                self.writer_failed = true;
                return Err(QueueFrameError::WriterFailed(err));
            }
            Err(e) => return Err(e),
        }

        self.last_audio_end_pts = Some(new_end);
        self.last_audio_timescale = Some(sample_rate);
        self.audio_frames_appended += 1;
        self.last_timestamp = Some(timestamp);

        Ok(())
    }

    fn video_frame_duration(&self) -> Duration {
        let fps_num = self.config.frame_rate.0;
        let fps_den = self.config.frame_rate.1;

        if fps_num <= 0 {
            return Duration::from_millis(1);
        }

        let numerator = fps_den.unsigned_abs() as u128 * 1_000_000_000u128;
        let denominator = fps_num as u128;
        let nanos = (numerator / denominator).max(1);

        Duration::from_nanos(nanos as u64)
    }

    pub fn pause(&mut self) {
        if self.is_paused || !self.is_writing {
            return;
        }

        let Some(timestamp) = self.last_timestamp else {
            return;
        };

        self.pause_timestamp = Some(timestamp);
        self.is_paused = true;
    }

    pub fn resume(&mut self) {
        if !self.is_paused {
            return;
        }

        self.is_paused = false;
    }

    pub fn finish(&mut self, timestamp: Option<Duration>) -> Result<(), FinishError> {
        let writer = self.finish_start(timestamp)?;
        wait_for_writer_finished(&writer)?;
        info!("Finished writing");
        Ok(())
    }

    pub fn finish_nowait(
        &mut self,
        timestamp: Option<Duration>,
    ) -> Result<arc::R<av::AssetWriter>, FinishError> {
        self.finish_start(timestamp)
    }

    fn finish_start(
        &mut self,
        timestamp: Option<Duration>,
    ) -> Result<arc::R<av::AssetWriter>, FinishError> {
        if !self.is_writing {
            return Err(FinishError::NotWriting);
        }

        let mut finish_timestamp = timestamp;

        if let Some(pause_timestamp) = self.pause_timestamp {
            finish_timestamp = Some(match finish_timestamp {
                Some(ts) => ts.min(pause_timestamp),
                None => pause_timestamp,
            });
        }

        let Some(last_frame_ts) = self.last_frame_timestamp.take() else {
            warn!("Encoder attempted to finish with no frame");
            return Err(FinishError::NoFrames);
        };

        self.is_paused = false;
        self.pause_timestamp = None;

        let end_timestamp = finish_timestamp.unwrap_or(last_frame_ts);

        self.is_writing = false;

        let mut end_session_time = end_timestamp.saturating_sub(self.timestamp_offset);

        if let Some(last_video_pts) = self.last_video_pts {
            let min_video_end = last_video_pts.saturating_add(self.video_frame_duration());
            end_session_time = end_session_time.max(min_video_end);
        }

        if let Some(audio_end_pts) = self.last_audio_end_pts
            && let Some(timescale) = self.last_audio_timescale
            && timescale > 0
        {
            let audio_end_time = timescale_value_to_duration(audio_end_pts, timescale);
            end_session_time = end_session_time.max(audio_end_time);
        }

        self.asset_writer.end_session_at_src_time(cm::Time::new(
            end_session_time.as_micros() as i64,
            1_000_000,
        ));
        self.video_input.mark_as_finished();
        if let Some(i) = self.audio_input.as_mut() {
            i.mark_as_finished()
        }

        self.asset_writer.finish_writing();

        debug!("Appended {} video frames", self.video_frames_appended);
        debug!("Appended {} audio frames", self.audio_frames_appended);

        Ok(self.asset_writer.clone())
    }
}

impl Drop for MP4Encoder {
    fn drop(&mut self) {
        let _ = self.finish(None);
    }
}

#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {
    static AVVideoAverageBitRateKey: &'static ns::String;
    static AVVideoAllowFrameReorderingKey: &'static ns::String;
    static AVVideoExpectedSourceFrameRateKey: &'static ns::String;
    static AVVideoMaxKeyFrameIntervalKey: &'static ns::String;
    static AVVideoTransferFunctionKey: &'static ns::String;
    static AVVideoColorPrimariesKey: &'static ns::String;
    static AVVideoYCbCrMatrixKey: &'static ns::String;

    static AVVideoTransferFunction_ITU_R_709_2: &'static cidre::ns::String;
    static AVVideoColorPrimaries_ITU_R_709_2: &'static cidre::ns::String;
    static AVVideoYCbCrMatrix_ITU_R_709_2: &'static cidre::ns::String;
}

unsafe fn result_unchecked<T, R>(op: impl FnOnce(&mut Option<T>) -> R) -> cidre::os::Result<T>
where
    R: Into<cidre::os::Result>,
{
    let mut option = None;
    op(&mut option).into()?;
    Ok(unsafe { option.unwrap_unchecked() })
}

fn duration_to_timescale_value(duration: Duration, timescale: i32) -> i64 {
    let nanos = duration.as_nanos();
    let scale = timescale.max(1) as u128;
    let value = (nanos.saturating_mul(scale).saturating_add(500_000_000)) / 1_000_000_000;
    value.min(i64::MAX as u128) as i64
}

fn timescale_value_to_duration(value: i64, timescale: i32) -> Duration {
    let scale = timescale.max(1) as u128;
    let v = u128::from(value.max(0) as u64);
    let nanos = (v.saturating_mul(1_000_000_000u128) / scale).min(u64::MAX as u128) as u64;
    Duration::from_nanos(nanos)
}

fn get_average_bitrate(width: f32, height: f32, fps: f32) -> f32 {
    5_000_000.0
        + width * height / (1920.0 * 1080.0) * 2_000_000.0
        + fps.min(60.0) / 30.0 * 5_000_000.0
}

fn get_instant_mode_bitrate(width: f32, height: f32, fps: f32) -> f32 {
    let pixel_ratio = width * height / (1920.0 * 1080.0);
    let fps_ratio = fps.min(60.0) / 30.0;
    1_500_000.0 + pixel_ratio * 1_500_000.0 + fps_ratio * 500_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_media_info::RawVideoFormat;

    fn valid_video_config() -> VideoInfo {
        VideoInfo::from_raw(RawVideoFormat::Bgra, 1920, 1080, 30)
    }

    #[test]
    fn rejects_zero_width() {
        let mut config = valid_video_config();
        config.width = 0;

        let result = MP4Encoder::init(
            std::env::temp_dir().join("test_zero_width.mp4"),
            config,
            None,
            None,
        );

        match result {
            Err(InitError::InvalidConfig(msg)) => {
                assert!(
                    msg.contains("non-zero"),
                    "Error should mention non-zero: {msg}"
                );
            }
            Err(e) => panic!("Expected InvalidConfig, got: {e}"),
            Ok(_) => panic!("Expected error for zero width"),
        }
    }

    #[test]
    fn rejects_zero_height() {
        let mut config = valid_video_config();
        config.height = 0;

        let result = MP4Encoder::init(
            std::env::temp_dir().join("test_zero_height.mp4"),
            config,
            None,
            None,
        );

        match result {
            Err(InitError::InvalidConfig(msg)) => {
                assert!(
                    msg.contains("non-zero"),
                    "Error should mention non-zero: {msg}"
                );
            }
            Err(e) => panic!("Expected InvalidConfig, got: {e}"),
            Ok(_) => panic!("Expected error for zero height"),
        }
    }

    #[test]
    fn rejects_zero_fps_numerator() {
        let mut config = valid_video_config();
        config.frame_rate = ffmpeg::util::rational::Rational(0, 1);

        let result = MP4Encoder::init(
            std::env::temp_dir().join("test_zero_fps.mp4"),
            config,
            None,
            None,
        );

        match result {
            Err(InitError::InvalidConfig(msg)) => {
                assert!(
                    msg.contains("positive"),
                    "Error should mention positive: {msg}"
                );
            }
            Err(e) => panic!("Expected InvalidConfig, got: {e}"),
            Ok(_) => panic!("Expected error for zero fps numerator"),
        }
    }

    #[test]
    fn rejects_zero_fps_denominator() {
        let mut config = valid_video_config();
        config.frame_rate = ffmpeg::util::rational::Rational(30, 0);

        let result = MP4Encoder::init(
            std::env::temp_dir().join("test_zero_fps_denom.mp4"),
            config,
            None,
            None,
        );

        match result {
            Err(InitError::InvalidConfig(msg)) => {
                assert!(
                    msg.contains("positive"),
                    "Error should mention positive: {msg}"
                );
            }
            Err(e) => panic!("Expected InvalidConfig, got: {e}"),
            Ok(_) => panic!("Expected error for zero fps denominator"),
        }
    }

    #[test]
    fn rejects_negative_fps() {
        let mut config = valid_video_config();
        config.frame_rate = ffmpeg::util::rational::Rational(-30, 1);

        let result = MP4Encoder::init(
            std::env::temp_dir().join("test_neg_fps.mp4"),
            config,
            None,
            None,
        );

        match result {
            Err(InitError::InvalidConfig(msg)) => {
                assert!(
                    msg.contains("positive"),
                    "Error should mention positive: {msg}"
                );
            }
            Err(e) => panic!("Expected InvalidConfig, got: {e}"),
            Ok(_) => panic!("Expected error for negative fps"),
        }
    }

    #[test]
    fn creates_parent_directory() {
        let dir = std::env::temp_dir()
            .join("cap_test_encoder_parent")
            .join("nested")
            .join("dir");

        let _ = std::fs::remove_dir_all(dir.parent().unwrap().parent().unwrap());

        let output = dir.join("test_output.mp4");
        let config = valid_video_config();

        let result = MP4Encoder::init(output.clone(), config, None, None);
        assert!(result.is_ok(), "Should succeed: {}", result.err().unwrap());

        assert!(dir.exists(), "Parent directory should have been created");

        let _ = std::fs::remove_dir_all(std::env::temp_dir().join("cap_test_encoder_parent"));
    }

    #[test]
    fn removes_existing_output_file() {
        let output = std::env::temp_dir().join("cap_test_existing_output.mp4");
        std::fs::write(&output, b"stale data").unwrap();
        assert!(output.exists());

        let config = valid_video_config();
        let result = MP4Encoder::init(output.clone(), config, None, None);
        assert!(
            result.is_ok(),
            "Should succeed even with pre-existing file: {}",
            result.err().unwrap()
        );

        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn succeeds_with_valid_config() {
        let output = std::env::temp_dir().join("cap_test_valid_encoder.mp4");
        let _ = std::fs::remove_file(&output);

        let config = valid_video_config();
        let result = MP4Encoder::init(output.clone(), config, None, None);

        assert!(
            result.is_ok(),
            "Valid config should succeed: {}",
            result.err().unwrap()
        );

        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn instant_mode_succeeds_with_valid_config() {
        let output = std::env::temp_dir().join("cap_test_instant_encoder.mp4");
        let _ = std::fs::remove_file(&output);

        let config = valid_video_config();
        let result = MP4Encoder::init_instant_mode(output.clone(), config, None, None);

        assert!(
            result.is_ok(),
            "Instant mode valid config should succeed: {}",
            result.err().unwrap()
        );

        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn bitrate_calculations() {
        let hd_30 = get_average_bitrate(1920.0, 1080.0, 30.0);
        assert!(hd_30 < 15_000_000.0);
        assert!(hd_30 > 5_000_000.0);

        let hd_60 = get_average_bitrate(1920.0, 1080.0, 60.0);
        assert!(hd_60 > hd_30);

        let instant_hd_30 = get_instant_mode_bitrate(1920.0, 1080.0, 30.0);
        assert!(
            instant_hd_30 < hd_30,
            "Instant mode bitrate should be lower"
        );
    }
}

trait SampleBufExt {
    fn create(
        data_buffer: Option<&cm::BlockBuf>,
        data_ready: bool,
        format_description: Option<&cm::FormatDesc>,
        num_samples: cm::ItemCount,
        sample_timings: &[cm::SampleTimingInfo],
        sample_sizes: &[usize],
    ) -> os::Result<arc::R<cm::SampleBuf>>;

    fn copy_with_new_timing(
        &self,
        sample_timings: &[cm::SampleTimingInfo],
    ) -> os::Result<arc::R<cm::SampleBuf>>;
}

impl SampleBufExt for cm::SampleBuf {
    fn create(
        data_buffer: Option<&cm::BlockBuf>,
        data_ready: bool,
        format_description: Option<&cm::FormatDesc>,
        num_samples: cm::ItemCount,
        sample_timings: &[cm::SampleTimingInfo],
        sample_sizes: &[usize],
    ) -> os::Result<arc::R<cm::SampleBuf>> {
        unsafe {
            result_unchecked(|res| {
                Self::create_in(
                    None,
                    data_buffer,
                    data_ready,
                    None,
                    std::ptr::null(),
                    format_description,
                    num_samples,
                    sample_timings.len() as isize,
                    sample_timings.as_ptr(),
                    sample_sizes.len() as isize,
                    sample_sizes.as_ptr(),
                    res,
                )
            })
        }
    }

    fn copy_with_new_timing(
        &self,
        sample_timings: &[cm::SampleTimingInfo],
    ) -> os::Result<arc::R<cm::SampleBuf>> {
        unsafe {
            unsafe extern "C-unwind" {
                fn CMSampleBufferCreateCopyWithNewTiming(
                    allocator: Option<&cf::Allocator>,
                    original_buf: &cm::SampleBuf,
                    num_sample_timing_entries: cm::ItemCount,
                    sample_timing_array: *const cm::SampleTimingInfo,
                    sample_buffer_out: *mut Option<arc::R<cm::SampleBuf>>,
                ) -> os::Status;
            }

            result_unchecked(|res| {
                CMSampleBufferCreateCopyWithNewTiming(
                    None,
                    self,
                    sample_timings.len() as isize,
                    sample_timings.as_ptr(),
                    res,
                )
            })
        }
    }
}

fn append_sample_buf(
    input: &mut av::AssetWriterInput,
    writer: &av::AssetWriter,
    frame: &cm::SampleBuf,
) -> Result<(), QueueFrameError> {
    let status = writer.status();
    if status == av::asset::writer::Status::Failed {
        return Err(match writer.error() {
            Some(err) => QueueFrameError::WriterFailed(err),
            None => QueueFrameError::Failed,
        });
    }
    if status != av::asset::writer::Status::Writing {
        return Err(QueueFrameError::Failed);
    }

    match input.append_sample_buf(frame) {
        Ok(true) => {}
        Ok(false) => {
            let status = writer.status();
            if status == av::asset::writer::Status::Failed {
                return Err(match writer.error() {
                    Some(err) => QueueFrameError::WriterFailed(err),
                    None => QueueFrameError::Failed,
                });
            }
            if status == av::asset::writer::Status::Writing {
                return Err(QueueFrameError::NotReadyForMore);
            }
            return Err(QueueFrameError::Failed);
        }
        Err(e) => return Err(QueueFrameError::AppendError(e.retained())),
    }

    Ok(())
}

const WRITER_FINISH_TIMEOUT: Duration = Duration::from_secs(10);
const WRITER_POLL_INTERVAL: Duration = Duration::from_millis(10);
const WRITER_LOG_INTERVAL: Duration = Duration::from_secs(2);

pub fn wait_for_writer_finished(writer: &av::AssetWriter) -> Result<(), FinishError> {
    use av::asset::writer::Status;
    use std::time::Instant;

    let start = Instant::now();
    let mut last_log = start;

    loop {
        let status = writer.status();
        let elapsed = start.elapsed();

        match status {
            Status::Completed | Status::Cancelled => {
                if elapsed > Duration::from_millis(100) {
                    info!("Writer finished after {:?}", elapsed);
                }
                return Ok(());
            }
            Status::Failed | Status::Unknown => {
                if let Some(err) = writer.error() {
                    error!("Writer failed with error: {:?}", err);
                }
                return Err(FinishError::Failed);
            }
            Status::Writing => {
                if elapsed >= WRITER_FINISH_TIMEOUT {
                    error!(
                        "Writer timeout after {:?} - still in Writing state",
                        elapsed
                    );
                    return Err(FinishError::Failed);
                }

                if last_log.elapsed() >= WRITER_LOG_INTERVAL {
                    warn!("Writer still finalizing after {:?}...", elapsed);
                    last_log = Instant::now();
                }

                std::thread::sleep(WRITER_POLL_INTERVAL);
            }
        }
    }
}
