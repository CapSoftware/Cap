use cap_media_info::{AudioInfo, VideoInfo, ensure_even};
use cidre::{cm::SampleTimingInfo, objc::Obj, *};
use ffmpeg::{frame, software::resampling};
use std::{path::PathBuf, time::Duration};
use tracing::*;

const AAC_MAX_SAMPLE_RATE: u32 = 48000;
const MAX_AV_DRIFT_SECS: f64 = 2.0;

// before pausing at all, subtract 0.
// on pause, record last frame time.
// on resume, store last frame time and clear offset timestamp
// on next frame, set offset timestamp and subtract (offset timestamp - last frame time - previous offset)
// on next pause, store (offset timestamp - last frame time) into previous offset

struct PendingVideoFrame {
    raw_frame: arc::R<cm::SampleBuf>,
    pts: Duration,
    deferred_offset: Option<Duration>,
}

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
    pending_video_frame: Option<PendingVideoFrame>,
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
            pending_video_frame: None,
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

        if let (Some(audio_end_pts), Some(audio_ts)) =
            (self.last_audio_end_pts, self.last_audio_timescale)
        {
            let audio_secs = audio_end_pts as f64 / audio_ts as f64;
            let video_secs = timestamp
                .checked_sub(self.timestamp_offset)
                .unwrap_or(Duration::ZERO)
                .as_secs_f64();
            if video_secs > audio_secs + MAX_AV_DRIFT_SECS {
                return Err(QueueFrameError::NotReadyForMore);
            }
        }

        let mut pts_duration = timestamp
            .checked_sub(self.timestamp_offset)
            .unwrap_or(Duration::ZERO);

        let mut deferred_offset: Option<Duration> = None;

        let pending_pts = self.pending_video_frame.as_ref().map(|p| p.pts);
        let effective_last_pts = match (self.last_video_pts, pending_pts) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };

        if let Some(last_pts) = effective_last_pts
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

            deferred_offset = timestamp.checked_sub(adjusted_pts);

            pts_duration = adjusted_pts;
        }

        if let Some(pending) = self.pending_video_frame.take() {
            let forward_duration = pts_duration
                .saturating_sub(pending.pts)
                .min(self.video_frame_duration())
                .max(Duration::from_micros(1));

            self.write_pending_frame(pending, forward_duration)?;
        }

        self.pending_video_frame = Some(PendingVideoFrame {
            raw_frame: frame,
            pts: pts_duration,
            deferred_offset,
        });
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

        if let (Some(audio_end_pts), Some(audio_ts), Some(video_pts)) = (
            self.last_audio_end_pts,
            self.last_audio_timescale,
            self.last_video_pts,
        ) {
            let audio_secs = audio_end_pts as f64 / audio_ts as f64;
            let video_secs = video_pts.as_secs_f64();
            if audio_secs > video_secs + MAX_AV_DRIFT_SECS {
                return Err(QueueFrameError::NotReadyForMore);
            }
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
                error!(
                    video_frames = self.video_frames_appended,
                    audio_frames = self.audio_frames_appended,
                    audio_pts_value = pts_value,
                    audio_sample_rate = sample_rate,
                    audio_samples = frame.samples(),
                    last_video_pts_us = self.last_video_pts.map(|d| d.as_micros() as i64),
                    last_audio_end_pts = self.last_audio_end_pts,
                    timestamp_offset_us = self.timestamp_offset.as_micros() as i64,
                    pending_video = self.pending_video_frame.is_some(),
                    "Audio WriterFailed with timing state"
                );
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

    fn write_pending_frame(
        &mut self,
        pending: PendingVideoFrame,
        duration: Duration,
    ) -> Result<(), QueueFrameError> {
        let duration_us = duration.as_micros() as i64;
        let timing = SampleTimingInfo {
            duration: cm::Time::new(duration_us.max(1), 1_000_000),
            pts: cm::Time::new(pending.pts.as_micros() as i64, 1_000_000),
            dts: cm::Time::invalid(),
        };

        let timed_frame = match pending.raw_frame.copy_with_new_timing(&[timing]) {
            Ok(f) => f,
            Err(e) => {
                warn!(
                    ?e,
                    "Failed to copy pending sample buffer with new timing, skipping frame"
                );
                return Ok(());
            }
        };

        match append_sample_buf(&mut self.video_input, &self.asset_writer, &timed_frame) {
            Ok(()) => {
                if let Some(offset) = pending.deferred_offset {
                    self.timestamp_offset = offset;
                }
                self.last_video_pts = Some(pending.pts);
                self.video_frames_appended += 1;
                Ok(())
            }
            Err(QueueFrameError::WriterFailed(err)) => {
                error!(
                    video_frames = self.video_frames_appended,
                    audio_frames = self.audio_frames_appended,
                    pts_us = pending.pts.as_micros() as i64,
                    duration_us = duration_us,
                    last_video_pts_us = self.last_video_pts.map(|d| d.as_micros() as i64),
                    last_audio_end_pts = self.last_audio_end_pts,
                    last_audio_timescale = self.last_audio_timescale,
                    timestamp_offset_us = self.timestamp_offset.as_micros() as i64,
                    had_deferred_offset = pending.deferred_offset.is_some(),
                    "Video WriterFailed with timing state"
                );
                self.writer_failed = true;
                Err(QueueFrameError::WriterFailed(err))
            }
            Err(e) => Err(e),
        }
    }

    fn flush_pending_video(&mut self) {
        if let Some(pending) = self.pending_video_frame.take() {
            let duration = self.video_frame_duration();
            let _ = self.write_pending_frame(pending, duration);
        }
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

        self.flush_pending_video();

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

        self.flush_pending_video();

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

    fn test_output_path(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("cap_test_{name}.mp4"));
        let _ = std::fs::remove_file(&path);
        path
    }

    fn create_pixel_buffer_pool(width: usize, height: usize) -> arc::R<cidre::cv::PixelBufPool> {
        use cidre::{cf, cv};

        let min_count_num = cf::Number::from_usize(8);
        let width_num = cf::Number::from_usize(width);
        let height_num = cf::Number::from_usize(height);

        let pool_attr_keys: [&cf::Type; 1] =
            [cv::pixel_buffer_pool::keys::minimum_buffer_count().as_ref()];
        let pool_attr_values: [&cf::Type; 1] = [min_count_num.as_ref()];
        let pool_attrs =
            cf::Dictionary::with_keys_values(&pool_attr_keys, &pool_attr_values).unwrap();

        let pixel_buf_attr_keys: [&cf::Type; 3] = [
            cv::pixel_buffer::keys::pixel_format().as_ref(),
            cv::pixel_buffer::keys::width().as_ref(),
            cv::pixel_buffer::keys::height().as_ref(),
        ];
        let pixel_buf_attr_values: [&cf::Type; 3] = [
            cv::PixelFormat::_420V.to_cf_number().as_ref(),
            width_num.as_ref(),
            height_num.as_ref(),
        ];
        let pixel_buf_attrs =
            cf::Dictionary::with_keys_values(&pixel_buf_attr_keys, &pixel_buf_attr_values).unwrap();

        cv::PixelBufPool::new(Some(pool_attrs.as_ref()), Some(pixel_buf_attrs.as_ref())).unwrap()
    }

    fn create_test_video_frame(
        pool: &cidre::cv::PixelBufPool,
        pts_us: i64,
        duration_us: i64,
    ) -> arc::R<cidre::cm::SampleBuf> {
        let pixel_buf = pool.pixel_buf().unwrap();
        let format_desc = cidre::cm::VideoFormatDesc::with_image_buf(&pixel_buf).unwrap();
        let timing = SampleTimingInfo {
            duration: cidre::cm::Time::new(duration_us, 1_000_000),
            pts: cidre::cm::Time::new(pts_us, 1_000_000),
            dts: cidre::cm::Time::invalid(),
        };
        cidre::cm::SampleBuf::with_image_buf(
            &pixel_buf,
            true,
            None,
            std::ptr::null(),
            &format_desc,
            &timing,
        )
        .unwrap()
    }

    fn create_test_audio_frame(sample_rate: u32, samples: usize) -> ffmpeg::frame::Audio {
        let mut frame = ffmpeg::frame::Audio::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
            samples,
            ffmpeg::ChannelLayout::MONO,
        );
        frame.data_mut(0).fill(0);
        frame.set_rate(sample_rate);
        frame
    }

    fn wireless_audio_config() -> cap_media_info::AudioInfo {
        cap_media_info::AudioInfo {
            sample_rate: 48000,
            channels: 1,
            sample_format: ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
            time_base: ffmpeg::util::rational::Rational(1, 48000),
            buffer_size: 3840,
            is_wireless_transport: true,
        }
    }

    fn retina_video_config() -> VideoInfo {
        VideoInfo::from_raw(RawVideoFormat::Nv12, 2940, 1912, 30)
    }

    struct SendPool(arc::R<cidre::cv::PixelBufPool>);
    unsafe impl Send for SendPool {}

    impl Clone for SendPool {
        fn clone(&self) -> Self {
            Self(self.0.clone())
        }
    }

    impl std::ops::Deref for SendPool {
        type Target = cidre::cv::PixelBufPool;
        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    struct ThreadedEncoderHarness {
        encoder: std::sync::Arc<std::sync::Mutex<MP4Encoder>>,
        pool: SendPool,
    }

    impl ThreadedEncoderHarness {
        fn new(
            output: PathBuf,
            video_config: VideoInfo,
            audio_config: Option<cap_media_info::AudioInfo>,
            output_height: Option<u32>,
        ) -> Self {
            let encoder =
                MP4Encoder::init_instant_mode(output, video_config, audio_config, output_height)
                    .unwrap();

            let pool =
                create_pixel_buffer_pool(video_config.width as usize, video_config.height as usize);

            Self {
                encoder: std::sync::Arc::new(std::sync::Mutex::new(encoder)),
                pool: SendPool(pool),
            }
        }

        fn run_video_thread(
            encoder: std::sync::Arc<std::sync::Mutex<MP4Encoder>>,
            pool: SendPool,
            timestamps: Vec<Duration>,
            pace_ms: u64,
        ) -> std::thread::JoinHandle<(u64, u64, Vec<String>)> {
            std::thread::Builder::new()
                .name("test-video-encoder".into())
                .spawn(move || {
                    let mut appended = 0u64;
                    let mut dropped = 0u64;
                    let mut errors = Vec::new();

                    for ts in &timestamps {
                        let frame = create_test_video_frame(&pool, ts.as_micros() as i64, 33_333);

                        let mut retry_count = 0u32;
                        loop {
                            let result = {
                                let mut enc = encoder.lock().unwrap();
                                enc.queue_video_frame(frame.clone(), *ts)
                            };

                            match result {
                                Ok(()) => {
                                    appended += 1;
                                    break;
                                }
                                Err(QueueFrameError::NotReadyForMore) => {
                                    retry_count += 1;
                                    if retry_count >= 100 {
                                        dropped += 1;
                                        break;
                                    }
                                    std::thread::sleep(Duration::from_micros(500));
                                }
                                Err(QueueFrameError::WriterFailed(err)) => {
                                    errors.push(format!("WriterFailed at ts={:?}: {err}", ts));
                                    break;
                                }
                                Err(QueueFrameError::Failed) => {
                                    errors.push(format!("Failed at ts={:?}", ts));
                                    break;
                                }
                                Err(e) => {
                                    dropped += 1;
                                    let _ = e;
                                    break;
                                }
                            }
                        }

                        if !errors.is_empty() {
                            break;
                        }

                        if pace_ms > 0 {
                            std::thread::sleep(Duration::from_millis(pace_ms));
                        }
                    }

                    (appended, dropped, errors)
                })
                .unwrap()
        }

        fn run_audio_thread(
            encoder: std::sync::Arc<std::sync::Mutex<MP4Encoder>>,
            frame_count: u64,
            samples_per_frame: usize,
            pace_ms: u64,
            jitter_pattern: Vec<u64>,
        ) -> std::thread::JoinHandle<(u64, u64, Vec<String>)> {
            std::thread::Builder::new()
                .name("test-audio-encoder".into())
                .spawn(move || {
                    let mut appended = 0u64;
                    let mut dropped = 0u64;
                    let mut errors = Vec::new();
                    let mut sample_cursor: u64 = 0;

                    for i in 0..frame_count {
                        let ts = Duration::from_nanos(
                            (sample_cursor as u128 * 1_000_000_000 / 48000) as u64,
                        );

                        let audio_frame = create_test_audio_frame(48000, samples_per_frame);

                        let mut retry_count = 0u32;
                        loop {
                            let result = {
                                let mut enc = encoder.lock().unwrap();
                                enc.queue_audio_frame(&audio_frame, ts)
                            };

                            match result {
                                Ok(()) => {
                                    appended += 1;
                                    break;
                                }
                                Err(QueueFrameError::NotReadyForMore) => {
                                    retry_count += 1;
                                    if retry_count >= 50 {
                                        dropped += 1;
                                        break;
                                    }
                                    std::thread::sleep(Duration::from_micros(500));
                                }
                                Err(QueueFrameError::WriterFailed(err)) => {
                                    errors.push(format!("Audio WriterFailed at frame {i}: {err}"));
                                    break;
                                }
                                Err(QueueFrameError::Failed) => {
                                    errors.push(format!("Audio Failed at frame {i}"));
                                    break;
                                }
                                Err(e) => {
                                    dropped += 1;
                                    let _ = e;
                                    break;
                                }
                            }
                        }

                        if !errors.is_empty() {
                            break;
                        }

                        sample_cursor += samples_per_frame as u64;

                        let jitter = if !jitter_pattern.is_empty() {
                            jitter_pattern[i as usize % jitter_pattern.len()]
                        } else {
                            0
                        };
                        if pace_ms > 0 || jitter > 0 {
                            std::thread::sleep(Duration::from_millis(pace_ms + jitter));
                        }
                    }

                    (appended, dropped, errors)
                })
                .unwrap()
        }
    }

    #[test]
    fn realistic_retina_instant_mode_10s() {
        let output = test_output_path("realistic_retina_10s");
        let video = retina_video_config();
        let audio = wireless_audio_config();
        let output_height = Some(1248u32);

        let harness =
            ThreadedEncoderHarness::new(output.clone(), video, Some(audio), output_height);

        let recording_secs = 10u64;
        let fps = 30u64;
        let total_video_frames = recording_secs * fps;

        let mut video_timestamps = Vec::new();
        for i in 0..total_video_frames {
            let base_ms = i * 1000 / fps;
            let jitter_us = ((i * 7 + 13) % 3000) as i64 - 1500;
            let ts_us = (base_ms as i64 * 1000 + jitter_us).max(0) as u64;
            video_timestamps.push(Duration::from_micros(ts_us));
        }

        let audio_frames_per_sec = 48000u64 / 3840;
        let total_audio_frames = recording_secs * audio_frames_per_sec;

        let wireless_jitter: Vec<u64> = (0..total_audio_frames)
            .map(|i| {
                if i % 17 == 0 {
                    30
                } else if i % 7 == 0 {
                    15
                } else {
                    0
                }
            })
            .collect();

        let enc_v = harness.encoder.clone();
        let pool = harness.pool.clone();
        let video_handle =
            ThreadedEncoderHarness::run_video_thread(enc_v, pool, video_timestamps, 1000 / fps);

        let enc_a = harness.encoder.clone();
        let audio_pace = 1000 / audio_frames_per_sec;
        let audio_handle = ThreadedEncoderHarness::run_audio_thread(
            enc_a,
            total_audio_frames,
            3840,
            audio_pace,
            wireless_jitter,
        );

        let (v_appended, v_dropped, v_errors) = video_handle.join().unwrap();
        let (a_appended, a_dropped, a_errors) = audio_handle.join().unwrap();

        assert!(
            v_errors.is_empty(),
            "Video encoding errors: {:?} (appended={v_appended}, dropped={v_dropped})",
            v_errors
        );
        assert!(
            a_errors.is_empty(),
            "Audio encoding errors: {:?} (appended={a_appended}, dropped={a_dropped})",
            a_errors
        );

        assert!(
            v_appended >= total_video_frames / 2,
            "Expected at least {} video frames, got {v_appended}",
            total_video_frames / 2,
        );
        assert!(
            a_appended >= total_audio_frames / 2,
            "Expected at least {} audio frames, got {a_appended}",
            total_audio_frames / 2,
        );

        let finish_ts = Duration::from_secs(recording_secs + 1);
        let result = harness.encoder.lock().unwrap().finish(Some(finish_ts));
        assert!(result.is_ok(), "Finish failed: {result:?}");

        let meta = std::fs::metadata(&output).unwrap();
        assert!(
            meta.len() > 10_000,
            "Output file too small: {} bytes",
            meta.len()
        );

        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn realistic_clock_drift_6pct_with_wireless_mic() {
        let output = test_output_path("drift_6pct_wireless");
        let video = retina_video_config();
        let audio = wireless_audio_config();

        let harness = ThreadedEncoderHarness::new(output.clone(), video, Some(audio), Some(1248));

        let recording_secs = 8u64;
        let fps = 30u64;
        let total_video_frames = recording_secs * fps;

        let mut video_timestamps = Vec::new();
        for i in 0..total_video_frames {
            let camera_us = i * 1_000_000 / fps;
            let wall_us = (camera_us as f64 * 1.06) as u64;
            let drifted_us = wall_us.min(camera_us + 100_000);
            video_timestamps.push(Duration::from_micros(drifted_us));
        }

        let audio_frames_per_sec = 48000u64 / 3840;
        let total_audio_frames = recording_secs * audio_frames_per_sec;

        let enc_v = harness.encoder.clone();
        let pool = harness.pool.clone();
        let video_handle =
            ThreadedEncoderHarness::run_video_thread(enc_v, pool, video_timestamps, 1000 / fps);

        let enc_a = harness.encoder.clone();
        let audio_handle = ThreadedEncoderHarness::run_audio_thread(
            enc_a,
            total_audio_frames,
            3840,
            1000 / audio_frames_per_sec,
            vec![],
        );

        let (v_appended, _, v_errors) = video_handle.join().unwrap();
        let (a_appended, _, a_errors) = audio_handle.join().unwrap();

        assert!(
            v_errors.is_empty(),
            "Video errors during clock drift: {:?}",
            v_errors
        );
        assert!(
            a_errors.is_empty(),
            "Audio errors during clock drift: {:?}",
            a_errors
        );
        assert!(v_appended >= total_video_frames / 2);
        assert!(a_appended >= total_audio_frames / 2);

        let result = harness
            .encoder
            .lock()
            .unwrap()
            .finish(Some(Duration::from_secs(recording_secs + 1)));
        assert!(result.is_ok(), "Finish failed: {result:?}");

        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn realistic_heavy_frame_drops_under_load() {
        let output = test_output_path("heavy_drops_load");
        let video = retina_video_config();
        let audio = wireless_audio_config();

        let harness = ThreadedEncoderHarness::new(output.clone(), video, Some(audio), Some(1248));

        let recording_secs = 10u64;
        let fps = 30u64;

        let mut video_timestamps = Vec::new();
        let mut frame_idx = 0u64;
        for i in 0..(recording_secs * fps) {
            let is_drop = matches!(
                i,
                10 | 11
                    | 50..=52
                    | 90
                    | 100..=106
                    | 150..=155
                    | 200
                    | 210..=215
                    | 250..=252
            );
            if !is_drop {
                let base_us = i * 1_000_000 / fps;
                video_timestamps.push(Duration::from_micros(base_us));
            }
            frame_idx += 1;
        }
        let _ = frame_idx;

        let audio_frames_per_sec = 48000u64 / 3840;
        let total_audio_frames = recording_secs * audio_frames_per_sec;

        let wireless_jitter: Vec<u64> = (0..total_audio_frames)
            .map(|i| if i % 11 == 0 { 40 } else { 0 })
            .collect();

        let enc_v = harness.encoder.clone();
        let pool = harness.pool.clone();
        let video_handle = ThreadedEncoderHarness::run_video_thread(
            enc_v,
            pool,
            video_timestamps.clone(),
            1000 / fps,
        );

        let enc_a = harness.encoder.clone();
        let audio_handle = ThreadedEncoderHarness::run_audio_thread(
            enc_a,
            total_audio_frames,
            3840,
            1000 / audio_frames_per_sec,
            wireless_jitter,
        );

        let (v_appended, v_dropped, v_errors) = video_handle.join().unwrap();
        let (_a_appended, _, a_errors) = audio_handle.join().unwrap();

        assert!(
            v_errors.is_empty(),
            "Video errors with frame drops: {:?} (appended={v_appended}, dropped={v_dropped})",
            v_errors
        );
        assert!(
            a_errors.is_empty(),
            "Audio errors with frame drops: {:?}",
            a_errors
        );
        assert!(
            v_appended >= video_timestamps.len() as u64 / 2,
            "Expected at least {} video frames, got {v_appended}",
            video_timestamps.len() / 2,
        );

        let result = harness
            .encoder
            .lock()
            .unwrap()
            .finish(Some(Duration::from_secs(recording_secs + 1)));
        assert!(result.is_ok(), "Finish failed: {result:?}");

        let meta = std::fs::metadata(&output).unwrap();
        assert!(
            meta.len() > 10_000,
            "Output too small: {} bytes",
            meta.len()
        );

        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn realistic_backward_timestamps_with_audio() {
        let output = test_output_path("backward_ts_av");
        let video = retina_video_config();
        let audio = wireless_audio_config();

        let harness = ThreadedEncoderHarness::new(output.clone(), video, Some(audio), Some(1248));

        let mut video_timestamps = Vec::new();
        let mut t_us = 0i64;
        for i in 0..150u64 {
            if i == 40 {
                t_us -= 5000;
            } else if i == 80 {
                t_us -= 8000;
            } else if i == 120 {
                t_us -= 3000;
            }
            video_timestamps.push(Duration::from_micros(t_us.max(0) as u64));
            t_us += 33_333;
        }

        let total_audio_frames = 50u64;

        let enc_v = harness.encoder.clone();
        let pool = harness.pool.clone();
        let video_handle =
            ThreadedEncoderHarness::run_video_thread(enc_v, pool, video_timestamps, 33);

        let enc_a = harness.encoder.clone();
        let audio_handle = ThreadedEncoderHarness::run_audio_thread(
            enc_a,
            total_audio_frames,
            3840,
            80,
            vec![0, 0, 0, 0, 20, 0, 0, 50, 0, 0],
        );

        let (v_appended, _, v_errors) = video_handle.join().unwrap();
        let (a_appended, _, a_errors) = audio_handle.join().unwrap();

        assert!(
            v_errors.is_empty(),
            "Video errors with backward timestamps: {:?}",
            v_errors
        );
        assert!(a_errors.is_empty(), "Audio errors: {:?}", a_errors);
        assert!(v_appended >= 50);
        assert!(a_appended >= 20);

        let result = harness
            .encoder
            .lock()
            .unwrap()
            .finish(Some(Duration::from_secs(6)));
        assert!(result.is_ok(), "Finish failed: {result:?}");

        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn video_ahead_of_audio_throttled() {
        let output = test_output_path("video_ahead_audio");
        let video = valid_video_config();
        let audio = wireless_audio_config();

        let mut encoder =
            MP4Encoder::init_instant_mode(output.clone(), video, Some(audio), None).unwrap();

        let pool = create_pixel_buffer_pool(1920, 1080);

        let first_audio = create_test_audio_frame(48000, 1024);
        encoder
            .queue_audio_frame(&first_audio, Duration::ZERO)
            .unwrap();

        let mut throttled_count = 0u64;
        for i in 0..200u64 {
            let ts_ms = i * 33;
            let timestamp = Duration::from_millis(ts_ms);
            let frame = create_test_video_frame(&pool, (ts_ms as i64) * 1000, 33_333);

            match encoder.queue_video_frame(frame, timestamp) {
                Ok(()) => {}
                Err(QueueFrameError::NotReadyForMore) => {
                    throttled_count += 1;
                }
                Err(e) => panic!("Video encode failed at frame {i}: {e}"),
            }
        }

        assert!(
            throttled_count > 0,
            "Expected video frames to be throttled when ahead of audio"
        );

        let _ = encoder.finish(Some(Duration::from_secs(7)));
        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn realistic_burst_after_2s_gap() {
        let output = test_output_path("burst_after_2s_gap");
        let video = retina_video_config();
        let audio = wireless_audio_config();

        let harness = ThreadedEncoderHarness::new(output.clone(), video, Some(audio), Some(1248));

        let mut video_timestamps = Vec::new();
        for i in 0..30u64 {
            video_timestamps.push(Duration::from_micros(i * 33_333));
        }
        for i in 0..60u64 {
            video_timestamps.push(Duration::from_micros(2_000_000 + i * 16_667));
        }

        let total_audio_frames = 40u64;

        let enc_v = harness.encoder.clone();
        let pool = harness.pool.clone();
        let video_handle =
            ThreadedEncoderHarness::run_video_thread(enc_v, pool, video_timestamps, 20);

        let enc_a = harness.encoder.clone();
        let audio_handle =
            ThreadedEncoderHarness::run_audio_thread(enc_a, total_audio_frames, 3840, 80, vec![]);

        let (v_appended, _, v_errors) = video_handle.join().unwrap();
        let (_a_appended, _, a_errors) = audio_handle.join().unwrap();

        assert!(
            v_errors.is_empty(),
            "Video errors after gap: {:?}",
            v_errors
        );
        assert!(
            a_errors.is_empty(),
            "Audio errors after gap: {:?}",
            a_errors
        );
        assert!(v_appended >= 30);

        let result = harness
            .encoder
            .lock()
            .unwrap()
            .finish(Some(Duration::from_secs(4)));
        assert!(result.is_ok(), "Finish failed: {result:?}");

        let _ = std::fs::remove_file(&output);
    }

    fn run_raw_writer_with_duration_strategy(
        output: &std::path::Path,
        use_dynamic_duration: bool,
    ) -> Result<(), String> {
        use cidre::{av, cf};

        let video_config = valid_video_config();
        let output_height = cap_media_info::ensure_even(video_config.height);
        let output_width = cap_media_info::ensure_even(video_config.width);
        let fps = 30.0f32;

        let _ = std::fs::remove_file(output);

        let mut asset_writer = av::AssetWriter::with_url_and_file_type(
            cf::Url::with_path(output, false).unwrap().as_ns(),
            av::FileType::mp4(),
        )
        .map_err(|e| format!("Writer create: {e}"))?;

        let assistant =
            av::OutputSettingsAssistant::with_preset(av::OutputSettingsPreset::h264_3840x2160())
                .ok_or("No settings assistant")?;

        let mut output_settings = assistant
            .video_settings()
            .ok_or("No video settings")?
            .copy_mut();

        output_settings.insert(
            av::video_settings_keys::width(),
            cidre::ns::Number::with_u32(output_width).as_id_ref(),
        );
        output_settings.insert(
            av::video_settings_keys::height(),
            cidre::ns::Number::with_u32(output_height).as_id_ref(),
        );

        let bitrate = get_instant_mode_bitrate(output_width as f32, output_height as f32, fps);
        unsafe {
            output_settings.insert(
                av::video_settings_keys::compression_props(),
                cidre::ns::Dictionary::with_keys_values(
                    &[
                        AVVideoAverageBitRateKey,
                        AVVideoAllowFrameReorderingKey,
                        AVVideoExpectedSourceFrameRateKey,
                        AVVideoMaxKeyFrameIntervalKey,
                    ],
                    &[
                        cidre::ns::Number::with_f32(bitrate).as_id_ref(),
                        cidre::ns::Number::with_bool(false).as_id_ref(),
                        cidre::ns::Number::with_f32(fps).as_id_ref(),
                        cidre::ns::Number::with_i32(fps as i32).as_id_ref(),
                    ],
                )
                .as_id_ref(),
            );
        }

        let mut video_input = av::AssetWriterInput::with_media_type_and_output_settings(
            av::MediaType::video(),
            Some(output_settings.as_ref()),
        )
        .map_err(|e| format!("Input create: {e}"))?;
        video_input.set_expects_media_data_in_real_time(true);

        asset_writer
            .add_input(&video_input)
            .map_err(|e| format!("Add input: {e}"))?;

        if !asset_writer.start_writing() {
            return Err("start_writing failed".into());
        }
        asset_writer.start_session_at_src_time(cidre::cm::Time::zero());

        let pool =
            create_pixel_buffer_pool(video_config.width as usize, video_config.height as usize);

        let const_dur_us = 33_333i64;

        let frame_pts_us: Vec<i64> = {
            let mut pts = Vec::new();
            let mut t = 0i64;
            for i in 0..200u64 {
                let skip = matches!(i, 15 | 16 | 45 | 46 | 47 | 90 | 91 | 130..=134);
                if !skip {
                    pts.push(t);
                }
                t += const_dur_us;
            }
            pts
        };

        let mut last_pts_us: Option<i64> = None;
        let mut appended = 0u64;

        for &pts_us in &frame_pts_us {
            let duration_us = if use_dynamic_duration {
                match last_pts_us {
                    Some(prev) => (pts_us - prev).max(1),
                    None => const_dur_us,
                }
            } else {
                const_dur_us
            };

            let frame = create_test_video_frame(&pool, pts_us, duration_us);

            let mut retry = 0;
            loop {
                if !video_input.is_ready_for_more_media_data() {
                    retry += 1;
                    if retry >= 200 {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                }

                let result = append_sample_buf(&mut video_input, &asset_writer, &frame);
                match result {
                    Ok(()) => {
                        appended += 1;
                        last_pts_us = Some(pts_us);
                        break;
                    }
                    Err(QueueFrameError::NotReadyForMore) => {
                        retry += 1;
                        if retry >= 200 {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(QueueFrameError::WriterFailed(err)) => {
                        return Err(format!(
                            "WriterFailed after {appended} frames at pts={pts_us}us: {err}"
                        ));
                    }
                    Err(QueueFrameError::Failed) => {
                        return Err(format!(
                            "Failed after {appended} frames at pts={pts_us}us \
                             (writer status: {})",
                            writer_status_name(&asset_writer)
                        ));
                    }
                    Err(e) => {
                        return Err(format!("Error after {appended} frames: {e}"));
                    }
                }
            }

            std::thread::sleep(Duration::from_millis(1));
        }

        video_input.mark_as_finished();
        let end_us = frame_pts_us.last().copied().unwrap_or(0) + const_dur_us;
        asset_writer.end_session_at_src_time(cidre::cm::Time::new(end_us, 1_000_000));
        asset_writer.finish_writing();

        match wait_for_writer_finished(&asset_writer) {
            Ok(()) => Ok(()),
            Err(e) => Err(format!("Finish failed: {e}")),
        }
    }

    #[test]
    fn regression_drift_corrected_timestamps_overlap_with_constant_duration() {
        let const_dur_us = 33_333i64;

        let frame_pts_us: Vec<i64> = vec![
            0, 33_333, 66_666, 100_000, 133_333, 155_000, 175_000, 195_000, 228_333, 261_666,
            295_000, 310_000, 343_333, 376_666, 395_000, 410_000, 443_333, 476_666,
        ];

        let mut overlap_count = 0;
        let mut dynamic_overlap_count = 0;
        for window in frame_pts_us.windows(2) {
            let prev = window[0];
            let curr = window[1];
            let gap = curr - prev;

            if curr < prev + const_dur_us {
                overlap_count += 1;
            }

            let dynamic = gap.max(1);
            if curr < prev + dynamic {
                dynamic_overlap_count += 1;
            }
        }

        assert!(
            overlap_count > 0,
            "Drift-corrected timestamps should produce overlaps with constant {const_dur_us}us duration"
        );
        assert_eq!(
            dynamic_overlap_count, 0,
            "Dynamic duration must never produce overlaps"
        );
    }

    #[test]
    fn regression_offset_leak_after_failed_append() {
        let frame_dur = Duration::from_micros(33_333);

        let timestamps_us: Vec<u64> = vec![
            50_000, 83_000, 116_000, 149_000, 183_000, 167_000, 200_000, 233_000, 266_000, 300_000,
        ];
        let initial_offset = Duration::from_millis(50);
        let fail_at_index = 5;

        let simulate = |defer_offset: bool| -> Vec<(i64, bool)> {
            let mut lv: Option<Duration> = None;
            let mut off = initial_offset;
            let mut results = Vec::new();

            for (i, &ts_us) in timestamps_us.iter().enumerate() {
                let timestamp = Duration::from_micros(ts_us);
                let mut pts_duration = timestamp.checked_sub(off).unwrap_or(Duration::ZERO);

                let mut deferred: Option<Duration> = None;
                if let Some(last_pts) = lv {
                    if pts_duration <= last_pts {
                        let adjusted = last_pts + frame_dur;
                        let new_off = timestamp.checked_sub(adjusted);
                        if defer_offset {
                            deferred = new_off;
                        } else if let Some(o) = new_off {
                            off = o;
                        }
                        pts_duration = adjusted;
                    }
                }

                let pts_us = pts_duration.as_micros() as i64;
                let appended = i != fail_at_index;

                if appended {
                    if defer_offset {
                        if let Some(o) = deferred {
                            off = o;
                        }
                    }
                    lv = Some(pts_duration);
                }

                results.push((pts_us, appended));
            }
            results
        };

        let old_results = simulate(false);
        let new_results = simulate(true);

        let old_appended: Vec<i64> = old_results
            .iter()
            .filter(|(_pts, appended)| *appended)
            .map(|(pts, _)| *pts)
            .collect();
        let new_appended: Vec<i64> = new_results
            .iter()
            .filter(|(_pts, appended)| *appended)
            .map(|(pts, _)| *pts)
            .collect();

        for w in new_appended.windows(2) {
            assert!(
                w[1] > w[0],
                "NEW behavior must produce monotonic PTS: {:?}",
                new_appended
            );
        }

        assert!(
            old_appended != new_appended,
            "Old and new should produce different PTS after failed append with offset. \
             Old: {:?}, New: {:?}",
            old_appended,
            new_appended
        );

        let old_jump = old_appended[5] - old_appended[4];
        let new_jump = new_appended[5] - new_appended[4];
        assert!(
            old_jump > new_jump,
            "Old behavior should produce a larger PTS jump due to leaked offset: \
             old_jump={old_jump}us, new_jump={new_jump}us"
        );
    }

    #[test]
    fn regression_dynamic_duration_survives_drop_pattern() {
        let output = test_output_path("regression_dynamic_dur");

        let result = run_raw_writer_with_duration_strategy(&output, true);

        let _ = std::fs::remove_file(&output);

        assert!(
            result.is_ok(),
            "Dynamic duration should survive frame drops: {}",
            result.unwrap_err()
        );
    }

    fn setup_raw_writer(
        output: &std::path::Path,
        width: u32,
        height: u32,
        fps: f32,
        instant_mode: bool,
    ) -> Result<(arc::R<av::AssetWriter>, arc::R<av::AssetWriterInput>), String> {
        use cidre::{av, cf};

        let _ = std::fs::remove_file(output);

        let output_width = cap_media_info::ensure_even(width);
        let output_height = cap_media_info::ensure_even(height);

        let mut asset_writer = av::AssetWriter::with_url_and_file_type(
            cf::Url::with_path(output, false).unwrap().as_ns(),
            av::FileType::mp4(),
        )
        .map_err(|e| format!("Writer create: {e}"))?;

        let assistant =
            av::OutputSettingsAssistant::with_preset(av::OutputSettingsPreset::h264_3840x2160())
                .ok_or("No settings assistant")?;

        let mut output_settings = assistant
            .video_settings()
            .ok_or("No video settings")?
            .copy_mut();

        output_settings.insert(
            av::video_settings_keys::width(),
            cidre::ns::Number::with_u32(output_width).as_id_ref(),
        );
        output_settings.insert(
            av::video_settings_keys::height(),
            cidre::ns::Number::with_u32(output_height).as_id_ref(),
        );

        let bitrate = if instant_mode {
            get_instant_mode_bitrate(output_width as f32, output_height as f32, fps)
        } else {
            get_average_bitrate(output_width as f32, output_height as f32, fps)
        };

        unsafe {
            output_settings.insert(
                av::video_settings_keys::compression_props(),
                cidre::ns::Dictionary::with_keys_values(
                    &[
                        AVVideoAverageBitRateKey,
                        AVVideoAllowFrameReorderingKey,
                        AVVideoExpectedSourceFrameRateKey,
                        AVVideoMaxKeyFrameIntervalKey,
                    ],
                    &[
                        cidre::ns::Number::with_f32(bitrate).as_id_ref(),
                        cidre::ns::Number::with_bool(false).as_id_ref(),
                        cidre::ns::Number::with_f32(fps).as_id_ref(),
                        cidre::ns::Number::with_i32(fps as i32).as_id_ref(),
                    ],
                )
                .as_id_ref(),
            );
        }

        let mut video_input = av::AssetWriterInput::with_media_type_and_output_settings(
            av::MediaType::video(),
            Some(output_settings.as_ref()),
        )
        .map_err(|e| format!("Input create: {e}"))?;
        video_input.set_expects_media_data_in_real_time(true);

        asset_writer
            .add_input(&video_input)
            .map_err(|e| format!("Add input: {e}"))?;

        if !asset_writer.start_writing() {
            return Err("start_writing failed".into());
        }
        asset_writer.start_session_at_src_time(cidre::cm::Time::zero());

        Ok((asset_writer, video_input))
    }

    fn feed_frames_to_writer(
        video_input: &mut av::AssetWriterInput,
        asset_writer: &av::AssetWriter,
        pool: &cidre::cv::PixelBufPool,
        frame_timings: &[(i64, i64)],
        pace_us: u64,
    ) -> Result<u64, (u64, String)> {
        let mut appended = 0u64;

        for &(pts_us, duration_us) in frame_timings {
            let frame = create_test_video_frame(pool, pts_us, duration_us);

            let mut retry = 0;
            loop {
                if !video_input.is_ready_for_more_media_data() {
                    retry += 1;
                    if retry >= 500 {
                        break;
                    }
                    std::thread::sleep(Duration::from_micros(200));
                    continue;
                }

                let result = append_sample_buf(video_input, asset_writer, &frame);
                match result {
                    Ok(()) => {
                        appended += 1;
                        break;
                    }
                    Err(QueueFrameError::NotReadyForMore) => {
                        retry += 1;
                        if retry >= 500 {
                            break;
                        }
                        std::thread::sleep(Duration::from_micros(200));
                    }
                    Err(QueueFrameError::WriterFailed(err)) => {
                        return Err((
                            appended,
                            format!(
                                "WriterFailed at pts={pts_us}us after {appended} frames: {err}"
                            ),
                        ));
                    }
                    Err(QueueFrameError::Failed) => {
                        return Err((
                            appended,
                            format!(
                                "Failed at pts={pts_us}us after {appended} frames (status: {})",
                                writer_status_name(asset_writer)
                            ),
                        ));
                    }
                    Err(e) => {
                        return Err((appended, format!("Error at pts={pts_us}us: {e}")));
                    }
                }
            }

            if pace_us > 0 {
                std::thread::sleep(Duration::from_micros(pace_us));
            }
        }

        Ok(appended)
    }

    fn finish_raw_writer(
        video_input: &mut av::AssetWriterInput,
        asset_writer: &mut av::AssetWriter,
        end_pts_us: i64,
    ) -> Result<(), String> {
        video_input.mark_as_finished();
        asset_writer.end_session_at_src_time(cidre::cm::Time::new(end_pts_us, 1_000_000));
        asset_writer.finish_writing();
        wait_for_writer_finished(asset_writer).map_err(|e| format!("Finish failed: {e}"))
    }

    #[test]
    fn reproduce_duplicate_pts_triggers_16364() {
        let output = test_output_path("dup_pts_trigger");

        let (mut asset_writer, mut video_input) =
            setup_raw_writer(&output, 1920, 1080, 30.0, true).unwrap();

        let pool = create_pixel_buffer_pool(1920, 1080);

        let mut timings: Vec<(i64, i64)> = Vec::new();
        for i in 0..50i64 {
            timings.push((i * 33_333, 33_333));
        }
        timings.push((50 * 33_333, 33_333));
        timings.push((50 * 33_333, 33_333));
        for i in 51..120i64 {
            timings.push((i * 33_333, 33_333));
        }
        timings.push((120 * 33_333, 33_333));
        timings.push((120 * 33_333, 33_333));
        for i in 121..200i64 {
            timings.push((i * 33_333, 33_333));
        }
        timings.push((200 * 33_333, 33_333));
        timings.push((200 * 33_333, 33_333));
        for i in 201..300i64 {
            timings.push((i * 33_333, 33_333));
        }

        let result = feed_frames_to_writer(&mut video_input, &asset_writer, &pool, &timings, 500);

        let writer_failed = match &result {
            Err((_, msg)) => msg.contains("WriterFailed") || msg.contains("Failed"),
            Ok(_) => {
                let finish = finish_raw_writer(&mut video_input, &mut asset_writer, 300 * 33_333);
                finish.is_err()
            }
        };

        let _ = std::fs::remove_file(&output);

        assert!(
            writer_failed,
            "Duplicate PTS should cause AVAssetWriter to fail with -16364. \
             Result: {result:?}"
        );
    }

    fn generate_drift_timings(
        frame_count: usize,
        base_interval_us: i64,
        drift_ratio: f64,
        use_constant_duration: bool,
        backward_indices: &[usize],
        backward_amount_us: i64,
    ) -> Vec<(i64, i64)> {
        let drifted_interval_us = (base_interval_us as f64 / drift_ratio.max(0.01)) as i64;

        let mut raw_pts: Vec<i64> = Vec::with_capacity(frame_count);
        let mut t = 0i64;
        for i in 0..frame_count {
            if backward_indices.contains(&i) {
                t = (t - backward_amount_us).max(0);
            }
            raw_pts.push(t);
            t += drifted_interval_us;
        }

        let mut last_pts = -1i64;
        let mut monotonic_pts: Vec<i64> = Vec::with_capacity(frame_count);
        for &pts in &raw_pts {
            let final_pts = if pts <= last_pts {
                last_pts + base_interval_us
            } else {
                pts
            };
            monotonic_pts.push(final_pts);
            last_pts = final_pts;
        }

        let mut timings: Vec<(i64, i64)> = Vec::with_capacity(frame_count);
        for (i, &pts) in monotonic_pts.iter().enumerate() {
            let duration = if use_constant_duration {
                base_interval_us
            } else if i + 1 < frame_count {
                let forward_gap = monotonic_pts[i + 1] - pts;
                forward_gap.min(base_interval_us).max(1)
            } else {
                base_interval_us
            };
            timings.push((pts, duration));
        }

        timings
    }

    fn count_overlapping_extents(timings: &[(i64, i64)]) -> usize {
        let mut count = 0;
        for window in timings.windows(2) {
            let (pts_a, dur_a) = window[0];
            let (pts_b, _) = window[1];
            if pts_b < pts_a + dur_a {
                count += 1;
            }
        }
        count
    }

    #[test]
    fn reproduce_overlapping_extents_constant_duration_retina() {
        let base_interval_us = 33_333i64;

        let backward_positions: Vec<usize> =
            (0..800).filter(|i| i % 50 == 25 || i % 120 == 60).collect();

        let const_timings = generate_drift_timings(
            800,
            base_interval_us,
            1.06,
            true,
            &backward_positions,
            5_000,
        );

        let dynamic_timings = generate_drift_timings(
            800,
            base_interval_us,
            1.06,
            false,
            &backward_positions,
            5_000,
        );

        let const_overlaps = count_overlapping_extents(&const_timings);
        let dynamic_overlaps = count_overlapping_extents(&dynamic_timings);

        assert!(
            const_overlaps > dynamic_overlaps,
            "Constant duration ({const_overlaps} overlaps) should produce more overlaps \
             than dynamic duration ({dynamic_overlaps} overlaps)"
        );

        let output_const = test_output_path("overlap_const_retina");
        let output_dyn = test_output_path("overlap_dyn_retina");

        let (mut writer_c, mut input_c) =
            setup_raw_writer(&output_const, 2940, 1912, 30.0, true).unwrap();
        let pool_c = create_pixel_buffer_pool(2940, 1912);

        let result_const =
            feed_frames_to_writer(&mut input_c, &writer_c, &pool_c, &const_timings, 0);

        let const_failed = match &result_const {
            Err((frames, msg)) => {
                eprintln!(
                    "CONSTANT DURATION WRITER FAILED after {frames} frames \
                     ({const_overlaps} overlaps): {msg}"
                );
                true
            }
            Ok(appended) => {
                let end_pts = const_timings.last().map(|(p, d)| p + d).unwrap_or(0);
                let finish = finish_raw_writer(&mut input_c, &mut writer_c, end_pts);
                if let Err(e) = &finish {
                    eprintln!("CONSTANT DURATION FINISH FAILED after {appended} frames: {e}");
                    true
                } else {
                    false
                }
            }
        };

        let (mut writer_d, mut input_d) =
            setup_raw_writer(&output_dyn, 2940, 1912, 30.0, true).unwrap();
        let pool_d = create_pixel_buffer_pool(2940, 1912);

        let result_dyn =
            feed_frames_to_writer(&mut input_d, &writer_d, &pool_d, &dynamic_timings, 0);

        let dyn_ok = match &result_dyn {
            Ok(appended) => {
                let end_pts = dynamic_timings.last().map(|(p, d)| p + d).unwrap_or(0);
                let finish = finish_raw_writer(&mut input_d, &mut writer_d, end_pts);
                if let Err(e) = &finish {
                    eprintln!("DYNAMIC DURATION FINISH FAILED after {appended} frames: {e}");
                    false
                } else {
                    true
                }
            }
            Err((frames, msg)) => {
                eprintln!("DYNAMIC DURATION WRITER FAILED after {frames} frames: {msg}");
                false
            }
        };

        let _ = std::fs::remove_file(&output_const);
        let _ = std::fs::remove_file(&output_dyn);

        assert!(
            dyn_ok,
            "Dynamic duration must always succeed: {result_dyn:?}"
        );

        eprintln!(
            "Overlap comparison: constant={const_overlaps}, dynamic={dynamic_overlaps}, \
             const_writer_failed={const_failed}"
        );
    }

    #[test]
    fn reproduce_extreme_overlap_stress() {
        let output = test_output_path("extreme_overlap_stress");
        let base_interval_us = 33_333i64;

        let mut timings: Vec<(i64, i64)> = Vec::new();
        let mut pts = 0i64;
        for i in 0..1000u64 {
            let interval = match i % 20 {
                0..=4 => 20_000i64,
                5..=9 => 25_000,
                10..=14 => 28_000,
                _ => 31_000,
            };
            timings.push((pts, base_interval_us));
            pts += interval;
        }

        let overlaps = count_overlapping_extents(&timings);
        assert!(
            overlaps > 100,
            "Should have many overlapping extents, got {overlaps}"
        );

        let (mut writer, mut input) = setup_raw_writer(&output, 2940, 1912, 30.0, true).unwrap();
        let pool = create_pixel_buffer_pool(2940, 1912);

        let result = feed_frames_to_writer(&mut input, &writer, &pool, &timings, 0);

        let failed = match &result {
            Err((frames, msg)) => {
                eprintln!(
                    "EXTREME OVERLAP: Writer failed after {frames} frames \
                     ({overlaps} overlapping extents): {msg}"
                );
                true
            }
            Ok(appended) => {
                let end_pts = timings.last().map(|(p, d)| p + d).unwrap_or(0);
                let finish = finish_raw_writer(&mut input, &mut writer, end_pts);
                if let Err(e) = &finish {
                    eprintln!("EXTREME OVERLAP: Finish failed after {appended} frames: {e}");
                    true
                } else {
                    eprintln!(
                        "EXTREME OVERLAP: Writer survived {appended} frames with \
                         {overlaps} overlapping extents on this machine"
                    );
                    false
                }
            }
        };

        let _ = std::fs::remove_file(&output);

        if failed {
            let mut dyn_timings: Vec<(i64, i64)> = Vec::new();
            for (i, &(pts, _)) in timings.iter().enumerate() {
                let dur = if i > 0 {
                    (pts - timings[i - 1].0).max(1)
                } else {
                    base_interval_us
                };
                dyn_timings.push((pts, dur));
            }

            let output_dyn = test_output_path("extreme_overlap_dyn");
            let (mut writer_d, mut input_d) =
                setup_raw_writer(&output_dyn, 2940, 1912, 30.0, true).unwrap();
            let pool_d = create_pixel_buffer_pool(2940, 1912);

            let result_dyn =
                feed_frames_to_writer(&mut input_d, &writer_d, &pool_d, &dyn_timings, 0);

            let dyn_ok = match &result_dyn {
                Ok(appended) => {
                    let end_pts = dyn_timings.last().map(|(p, d)| p + d).unwrap_or(0);
                    finish_raw_writer(&mut input_d, &mut writer_d, end_pts).is_ok() && *appended > 0
                }
                Err(_) => false,
            };

            let _ = std::fs::remove_file(&output_dyn);

            assert!(
                dyn_ok,
                "Dynamic duration MUST survive when constant duration fails: {result_dyn:?}"
            );

            eprintln!("CONFIRMED: Constant duration fails with -16364, dynamic duration survives.");
        }
    }

    #[test]
    fn reproduce_pts_discontinuity_with_audio() {
        let output = test_output_path("pts_discontinuity_av");
        let video = retina_video_config();
        let audio = wireless_audio_config();

        let mut encoder =
            MP4Encoder::init_instant_mode(output.clone(), video, Some(audio), Some(1248)).unwrap();

        let pool = create_pixel_buffer_pool(2940, 1912);

        for i in 0..30u64 {
            let ts = Duration::from_micros(i * 33_333);
            let frame = create_test_video_frame(&pool, (i * 33_333) as i64, 33_333);
            let _ = encoder.queue_video_frame(frame, ts);

            if i % 4 == 0 {
                let audio_frame = create_test_audio_frame(48000, 3840);
                let _ = encoder.queue_audio_frame(&audio_frame, ts);
            }
        }

        let jump_ts = Duration::from_millis(5000);
        let jump_frame = create_test_video_frame(&pool, 5_000_000, 33_333);
        let jump_result = encoder.queue_video_frame(jump_frame, jump_ts);

        let mut post_jump_errors = Vec::new();
        for i in 0..100u64 {
            let ts = Duration::from_micros(5_000_000 + i * 33_333);
            let frame = create_test_video_frame(&pool, (5_000_000 + i * 33_333) as i64, 33_333);
            match encoder.queue_video_frame(frame, ts) {
                Ok(()) => {}
                Err(QueueFrameError::WriterFailed(e)) => {
                    post_jump_errors.push(format!("WriterFailed at frame {i}: {e}"));
                    break;
                }
                Err(QueueFrameError::Failed) => {
                    post_jump_errors.push(format!("Failed at frame {i}"));
                    break;
                }
                Err(QueueFrameError::NotReadyForMore) => {}
                Err(e) => {
                    post_jump_errors.push(format!("Error at frame {i}: {e}"));
                }
            }
        }

        eprintln!(
            "PTS discontinuity test: jump_result={jump_result:?}, \
             post_jump_errors={post_jump_errors:?}"
        );

        let _ = encoder.finish(Some(Duration::from_secs(6)));
        let _ = std::fs::remove_file(&output);

        assert!(
            post_jump_errors.is_empty(),
            "Post-jump video frames should succeed (drift guard or recovery): {:?}",
            post_jump_errors
        );
    }

    #[test]
    fn reproduce_max_throughput_retina_av() {
        let output = test_output_path("max_throughput_retina");
        let video = retina_video_config();
        let audio = wireless_audio_config();

        let harness = ThreadedEncoderHarness::new(output.clone(), video, Some(audio), Some(1248));

        let total_video_frames = 1000u64;

        let mut video_timestamps = Vec::new();
        let mut ts_us = 0i64;
        for i in 0..total_video_frames {
            if i % 80 == 40 {
                ts_us -= 4_000;
            }
            if i % 200 == 100 {
                ts_us -= 10_000;
            }
            video_timestamps.push(Duration::from_micros(ts_us.max(0) as u64));
            ts_us += 33_333;
        }

        let total_audio_frames = 350u64;

        let enc_v = harness.encoder.clone();
        let pool = harness.pool.clone();
        let video_handle =
            ThreadedEncoderHarness::run_video_thread(enc_v, pool, video_timestamps, 0);

        let enc_a = harness.encoder.clone();
        let audio_handle =
            ThreadedEncoderHarness::run_audio_thread(enc_a, total_audio_frames, 3840, 0, vec![]);

        let (v_appended, v_dropped, v_errors) = video_handle.join().unwrap();
        let (a_appended, a_dropped, a_errors) = audio_handle.join().unwrap();

        eprintln!(
            "Max throughput retina: video appended={v_appended} dropped={v_dropped}, \
             audio appended={a_appended} dropped={a_dropped}"
        );

        assert!(
            v_errors.is_empty(),
            "Video errors in max throughput: {:?}",
            v_errors
        );
        assert!(
            a_errors.is_empty(),
            "Audio errors in max throughput: {:?}",
            a_errors
        );

        let result = harness
            .encoder
            .lock()
            .unwrap()
            .finish(Some(Duration::from_secs(35)));
        assert!(result.is_ok(), "Finish failed: {result:?}");

        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn reproduce_av_interleave_stress_retina() {
        let output = test_output_path("av_interleave_stress");
        let video = retina_video_config();
        let audio = wireless_audio_config();

        let harness = ThreadedEncoderHarness::new(output.clone(), video, Some(audio), Some(1248));

        let recording_secs = 15u64;
        let fps = 30u64;
        let total_video_frames = recording_secs * fps;

        let mut video_timestamps = Vec::new();
        let mut ts_us = 0i64;
        for i in 0..total_video_frames {
            if i == 60 || i == 180 || i == 300 {
                ts_us -= 8_000;
            }
            if i == 120 || i == 240 || i == 360 {
                ts_us -= 3_000;
            }

            let jitter = ((i * 13 + 7) % 5000) as i64 - 2500;
            let frame_ts = (ts_us + jitter).max(0) as u64;
            video_timestamps.push(Duration::from_micros(frame_ts));
            ts_us += 33_333;
        }

        let audio_frames_per_sec = 48000u64 / 3840;
        let total_audio_frames = recording_secs * audio_frames_per_sec;

        let wireless_jitter: Vec<u64> = (0..total_audio_frames)
            .map(|i| {
                if i % 13 == 0 {
                    50
                } else if i % 7 == 0 {
                    25
                } else {
                    0
                }
            })
            .collect();

        let enc_v = harness.encoder.clone();
        let pool = harness.pool.clone();
        let video_handle =
            ThreadedEncoderHarness::run_video_thread(enc_v, pool, video_timestamps, 1000 / fps);

        let enc_a = harness.encoder.clone();
        let audio_handle = ThreadedEncoderHarness::run_audio_thread(
            enc_a,
            total_audio_frames,
            3840,
            1000 / audio_frames_per_sec,
            wireless_jitter,
        );

        let (v_appended, v_dropped, v_errors) = video_handle.join().unwrap();
        let (a_appended, a_dropped, a_errors) = audio_handle.join().unwrap();

        eprintln!(
            "AV interleave stress: video appended={v_appended} dropped={v_dropped}, \
             audio appended={a_appended} dropped={a_dropped}"
        );

        assert!(
            v_errors.is_empty(),
            "Video errors in AV interleave stress: {:?}",
            v_errors
        );
        assert!(
            a_errors.is_empty(),
            "Audio errors in AV interleave stress: {:?}",
            a_errors
        );

        assert!(v_appended >= total_video_frames / 3);
        assert!(a_appended >= total_audio_frames / 3);

        let result = harness
            .encoder
            .lock()
            .unwrap()
            .finish(Some(Duration::from_secs(recording_secs + 1)));
        assert!(result.is_ok(), "Finish failed: {result:?}");

        let meta = std::fs::metadata(&output).unwrap();
        assert!(
            meta.len() > 10_000,
            "Output too small: {} bytes",
            meta.len()
        );

        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn realistic_retina_instant_mode_65s() {
        let output = test_output_path("realistic_retina_65s");
        let video = retina_video_config();
        let audio = wireless_audio_config();
        let output_height = Some(1248u32);

        let harness =
            ThreadedEncoderHarness::new(output.clone(), video, Some(audio), output_height);

        let recording_secs = 65u64;
        let fps = 30u64;
        let total_video_frames = recording_secs * fps;

        let mut video_timestamps = Vec::new();
        let mut drop_count = 0u64;
        for i in 0..total_video_frames {
            let is_drop = i % 9 == 7 || i % 31 == 15 || (i > 1500 && i % 20 == 0);
            if is_drop {
                drop_count += 1;
                continue;
            }
            let base_us = i * 1_000_000 / fps;
            let jitter_us = ((i * 11 + 17) % 4000) as i64 - 2000;
            let ts_us = (base_us as i64 + jitter_us).max(0) as u64;
            video_timestamps.push(Duration::from_micros(ts_us));
        }

        let audio_frames_per_sec = 48000u64 / 3840;
        let total_audio_frames = recording_secs * audio_frames_per_sec;

        let wireless_jitter: Vec<u64> = (0..total_audio_frames)
            .map(|i| {
                if i % 23 == 0 {
                    40
                } else if i % 11 == 0 {
                    20
                } else if i % 5 == 0 {
                    5
                } else {
                    0
                }
            })
            .collect();

        let enc_v = harness.encoder.clone();
        let pool = harness.pool.clone();
        let video_handle = ThreadedEncoderHarness::run_video_thread(
            enc_v,
            pool,
            video_timestamps.clone(),
            1000 / fps,
        );

        let enc_a = harness.encoder.clone();
        let audio_pace = 1000 / audio_frames_per_sec;
        let audio_handle = ThreadedEncoderHarness::run_audio_thread(
            enc_a,
            total_audio_frames,
            3840,
            audio_pace,
            wireless_jitter,
        );

        let (v_appended, v_dropped, v_errors) = video_handle.join().unwrap();
        let (a_appended, a_dropped, a_errors) = audio_handle.join().unwrap();

        eprintln!(
            "65s retina test: video appended={v_appended} dropped={v_dropped} \
             source_drops={drop_count}, audio appended={a_appended} dropped={a_dropped}"
        );

        assert!(
            v_errors.is_empty(),
            "Video encoding errors in 65s test: {:?} (appended={v_appended}, dropped={v_dropped})",
            v_errors
        );
        assert!(
            a_errors.is_empty(),
            "Audio encoding errors in 65s test: {:?} (appended={a_appended}, dropped={a_dropped})",
            a_errors
        );

        assert!(
            v_appended >= video_timestamps.len() as u64 / 2,
            "Expected at least {} video frames, got {v_appended}",
            video_timestamps.len() / 2,
        );
        assert!(
            a_appended >= total_audio_frames / 2,
            "Expected at least {} audio frames, got {a_appended}",
            total_audio_frames / 2,
        );

        let finish_ts = Duration::from_secs(recording_secs + 1);
        let result = harness.encoder.lock().unwrap().finish(Some(finish_ts));
        assert!(result.is_ok(), "Finish failed: {result:?}");

        let meta = std::fs::metadata(&output).unwrap();
        assert!(
            meta.len() > 100_000,
            "Output file too small for 65s recording: {} bytes",
            meta.len()
        );

        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn reproduce_user_16364_retina_65s_variable_intervals() {
        let output = test_output_path("user_16364_variable");
        let video = retina_video_config();
        let audio = wireless_audio_config();
        let output_height = Some(1248u32);

        let harness =
            ThreadedEncoderHarness::new(output.clone(), video, Some(audio), output_height);

        let recording_secs = 68u64;
        let fps = 30u64;

        let mut video_timestamps = Vec::new();
        let mut ts_us = 0u64;
        let nominal_us = 1_000_000u64 / fps;
        for i in 0..(recording_secs * fps) {
            let is_drop = i % 11 == 7 || (i > 1500 && i % 17 == 0);
            if is_drop {
                ts_us += nominal_us;
                continue;
            }

            let interval = match i % 6 {
                0 => nominal_us,
                1 => 16_500,
                2 => nominal_us + 16_833,
                3 => nominal_us,
                4 => 17_000,
                5 => nominal_us + 16_333,
                _ => nominal_us,
            };

            video_timestamps.push(Duration::from_micros(ts_us));
            ts_us += interval;
        }

        let audio_frames_per_sec = 48000u64 / 3840;
        let total_audio_frames = recording_secs * audio_frames_per_sec;

        let wireless_jitter: Vec<u64> = (0..total_audio_frames)
            .map(|i| {
                let audio_time_ms = i * 80;
                if (52_000..52_168).contains(&audio_time_ms) {
                    200
                } else if i % 23 == 0 {
                    50
                } else if i % 11 == 0 {
                    25
                } else {
                    0
                }
            })
            .collect();

        let enc_v = harness.encoder.clone();
        let pool = harness.pool.clone();
        let video_handle = ThreadedEncoderHarness::run_video_thread(
            enc_v,
            pool,
            video_timestamps.clone(),
            1000 / fps,
        );

        let enc_a = harness.encoder.clone();
        let audio_pace = 1000 / audio_frames_per_sec;
        let audio_handle = ThreadedEncoderHarness::run_audio_thread(
            enc_a,
            total_audio_frames,
            3840,
            audio_pace,
            wireless_jitter,
        );

        let (v_appended, v_dropped, v_errors) = video_handle.join().unwrap();
        let (a_appended, a_dropped, a_errors) = audio_handle.join().unwrap();

        eprintln!(
            "User-scenario 65s variable intervals: video appended={v_appended} dropped={v_dropped}, \
             audio appended={a_appended} dropped={a_dropped}"
        );

        assert!(
            v_errors.is_empty(),
            "Video errors in user-scenario test: {:?} (appended={v_appended}, dropped={v_dropped})",
            v_errors
        );
        assert!(
            a_errors.is_empty(),
            "Audio errors in user-scenario test: {:?} (appended={a_appended}, dropped={a_dropped})",
            a_errors
        );

        assert!(
            v_appended >= video_timestamps.len() as u64 / 2,
            "Expected at least {} video frames, got {v_appended}",
            video_timestamps.len() / 2,
        );

        let finish_ts = Duration::from_secs(recording_secs + 1);
        let result = harness.encoder.lock().unwrap().finish(Some(finish_ts));
        assert!(result.is_ok(), "Finish failed: {result:?}");

        let meta = std::fs::metadata(&output).unwrap();
        assert!(
            meta.len() > 100_000,
            "Output file too small: {} bytes",
            meta.len()
        );

        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn regression_pts_between_written_and_pending_causes_overlap() {
        let output = test_output_path("pts_sandwich_regression");
        let video = retina_video_config();
        let audio = wireless_audio_config();

        let mut encoder =
            MP4Encoder::init_instant_mode(output.clone(), video, Some(audio), Some(1248)).unwrap();

        let pool = create_pixel_buffer_pool(2940, 1912);

        let sandwich_indices: Vec<u64> = vec![30, 60, 90, 120, 150, 180, 210, 240, 270, 300];
        let total_frames = 400u64;

        let mut errors = Vec::new();
        let mut frame_idx = 0u64;

        while frame_idx < total_frames {
            if sandwich_indices.contains(&frame_idx) && frame_idx > 0 {
                let sandwich_us = frame_idx * 33_333 - 35_000;
                let ts = Duration::from_micros(sandwich_us);
                let frame = create_test_video_frame(&pool, sandwich_us as i64, 33_333);
                match encoder.queue_video_frame(frame, ts) {
                    Ok(()) => {}
                    Err(QueueFrameError::WriterFailed(e)) => {
                        errors.push(format!("WriterFailed at sandwich frame {frame_idx}: {e}"));
                        break;
                    }
                    Err(QueueFrameError::Failed) => {
                        errors.push(format!("Failed at sandwich frame {frame_idx}"));
                        break;
                    }
                    Err(_) => {}
                }
            }

            let ts_us = frame_idx * 33_333;
            let ts = Duration::from_micros(ts_us);
            let frame = create_test_video_frame(&pool, ts_us as i64, 33_333);
            match encoder.queue_video_frame(frame, ts) {
                Ok(()) => {}
                Err(QueueFrameError::WriterFailed(e)) => {
                    errors.push(format!("WriterFailed at frame {frame_idx}: {e}"));
                    break;
                }
                Err(QueueFrameError::Failed) => {
                    errors.push(format!("Failed at frame {frame_idx}"));
                    break;
                }
                Err(_) => {}
            }

            if frame_idx % 4 == 0 {
                let audio_frame = create_test_audio_frame(48000, 3840);
                let _ = encoder.queue_audio_frame(&audio_frame, ts);
            }

            frame_idx += 1;
        }

        assert!(
            errors.is_empty(),
            "Sandwich PTS frames should not trigger -16364: {:?}",
            errors
        );

        let _ = encoder.finish(Some(Duration::from_secs(15)));
        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn regression_repeated_sandwich_pts_across_65s() {
        let output = test_output_path("repeated_sandwich_65s");
        let video = retina_video_config();
        let audio = wireless_audio_config();

        let harness = ThreadedEncoderHarness::new(output.clone(), video, Some(audio), Some(1248));

        let recording_secs = 65u64;
        let fps = 30u64;
        let total_video_frames = recording_secs * fps;

        let mut video_timestamps = Vec::new();
        for i in 0..total_video_frames {
            let base_us = i * 1_000_000 / fps;
            let backward = match i {
                60 | 180 | 350 | 520 | 700 | 900 | 1100 | 1300 | 1500 | 1700 => 35_000i64,
                120 | 300 | 450 | 650 | 850 | 1050 | 1250 | 1450 | 1650 | 1850 => 34_500,
                _ => 0,
            };
            let jitter_us = ((i * 11 + 17) % 3000) as i64 - 1500;
            let ts_us = (base_us as i64 - backward + jitter_us).max(0) as u64;
            video_timestamps.push(Duration::from_micros(ts_us));
        }

        let audio_frames_per_sec = 48000u64 / 3840;
        let total_audio_frames = recording_secs * audio_frames_per_sec;

        let wireless_jitter: Vec<u64> = (0..total_audio_frames)
            .map(|i| {
                if i % 23 == 0 {
                    50
                } else if i % 11 == 0 {
                    25
                } else if i % 5 == 0 {
                    5
                } else {
                    0
                }
            })
            .collect();

        let enc_v = harness.encoder.clone();
        let pool = harness.pool.clone();
        let video_handle = ThreadedEncoderHarness::run_video_thread(
            enc_v,
            pool,
            video_timestamps.clone(),
            1000 / fps,
        );

        let enc_a = harness.encoder.clone();
        let audio_pace = 1000 / audio_frames_per_sec;
        let audio_handle = ThreadedEncoderHarness::run_audio_thread(
            enc_a,
            total_audio_frames,
            3840,
            audio_pace,
            wireless_jitter,
        );

        let (v_appended, v_dropped, v_errors) = video_handle.join().unwrap();
        let (a_appended, a_dropped, a_errors) = audio_handle.join().unwrap();

        eprintln!(
            "Repeated sandwich 65s: video appended={v_appended} dropped={v_dropped}, \
             audio appended={a_appended} dropped={a_dropped}"
        );

        assert!(
            v_errors.is_empty(),
            "Video errors in repeated sandwich 65s test: {:?} \
             (appended={v_appended}, dropped={v_dropped})",
            v_errors
        );
        assert!(
            a_errors.is_empty(),
            "Audio errors in repeated sandwich 65s test: {:?} \
             (appended={a_appended}, dropped={a_dropped})",
            a_errors
        );

        assert!(
            v_appended >= video_timestamps.len() as u64 / 2,
            "Expected at least {} video frames, got {v_appended}",
            video_timestamps.len() / 2,
        );
        assert!(
            a_appended >= total_audio_frames / 2,
            "Expected at least {} audio frames, got {a_appended}",
            total_audio_frames / 2,
        );

        let finish_ts = Duration::from_secs(recording_secs + 1);
        let result = harness.encoder.lock().unwrap().finish(Some(finish_ts));
        assert!(result.is_ok(), "Finish failed: {result:?}");

        let meta = std::fs::metadata(&output).unwrap();
        assert!(
            meta.len() > 100_000,
            "Output file too small for 65s recording: {} bytes",
            meta.len()
        );

        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn writer_failure_field_prevents_further_encoding() {
        let output = test_output_path("writer_failure_field");
        let video = valid_video_config();

        let mut encoder = MP4Encoder::init_instant_mode(output.clone(), video, None, None).unwrap();

        let pool = create_pixel_buffer_pool(1920, 1080);

        for i in 0..30u64 {
            let ts = Duration::from_micros(i * 33_333);
            let frame = create_test_video_frame(&pool, (i * 33_333) as i64, 33_333);
            let result = encoder.queue_video_frame(frame, ts);
            assert!(
                !matches!(
                    result,
                    Err(QueueFrameError::WriterFailed(_)) | Err(QueueFrameError::Failed)
                ),
                "Should not fail during normal encoding at frame {i}: {result:?}"
            );
        }

        encoder.writer_failed = true;

        let frame = create_test_video_frame(&pool, 30 * 33_333, 33_333);
        let ts = Duration::from_micros(30 * 33_333);
        let result = encoder.queue_video_frame(frame, ts);

        assert!(
            matches!(result, Err(QueueFrameError::Failed)),
            "Should return Failed when writer_failed is set, got: {result:?}"
        );

        let _ = encoder.finish(Some(Duration::from_secs(2)));
        let _ = std::fs::remove_file(&output);
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

fn writer_status_name(writer: &av::AssetWriter) -> &'static str {
    use av::asset::writer::Status;
    match writer.status() {
        Status::Unknown => "Unknown",
        Status::Writing => "Writing",
        Status::Completed => "Completed",
        Status::Failed => "Failed",
        Status::Cancelled => "Cancelled",
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
            None => {
                error!(
                    writer_status = writer_status_name(writer),
                    "Writer in Failed state with no error object"
                );
                QueueFrameError::Failed
            }
        });
    }
    if status != av::asset::writer::Status::Writing {
        error!(
            writer_status = writer_status_name(writer),
            "Writer in unexpected state, expected Writing"
        );
        return Err(QueueFrameError::Failed);
    }

    match input.append_sample_buf(frame) {
        Ok(true) => {}
        Ok(false) => {
            let status = writer.status();
            if status == av::asset::writer::Status::Failed {
                return Err(match writer.error() {
                    Some(err) => QueueFrameError::WriterFailed(err),
                    None => {
                        error!(
                            writer_status = writer_status_name(writer),
                            "Writer failed during append with no error object"
                        );
                        QueueFrameError::Failed
                    }
                });
            }
            if status == av::asset::writer::Status::Writing {
                return Err(QueueFrameError::NotReadyForMore);
            }
            error!(
                writer_status = writer_status_name(writer),
                "Writer in unexpected state after append returned false"
            );
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
