use cap_media_info::{AudioInfo, VideoInfo};
use cidre::{cm::SampleTimingInfo, objc::Obj, *};
use ffmpeg::frame;
use std::{path::PathBuf, time::Duration};
use tracing::*;

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
    last_frame_timestamp: Option<Duration>,
    pause_timestamp: Option<Duration>,
    timestamp_offset: Duration,
    is_writing: bool,
    is_paused: bool,
    video_frames_appended: usize,
    audio_frames_appended: usize,
    last_timestamp: Option<Duration>,
    last_video_pts: Option<Duration>,
    last_audio_pts: Option<Duration>,
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
        info!(
            width = video_config.width,
            height = video_config.height,
            pixel_format = ?video_config.pixel_format,
            frame_rate = ?video_config.frame_rate,
            output_height = ?output_height,
            has_audio = audio_config.is_some(),
            "Initializing AVFoundation MP4 encoder (VideoToolbox hardware encoding)"
        );
        debug!("{video_config:#?}");
        debug!("{audio_config:#?}");

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

            let downscale = output_height
                .map(|h| h as f32 / video_config.height as f32)
                .unwrap_or(1.0);

            let output_width = (video_config.width as f32 * downscale) as u32;
            let output_height = output_height.unwrap_or(video_config.height);

            output_settings.insert(
                av::video_settings_keys::width(),
                ns::Number::with_u32(output_width).as_id_ref(),
            );

            output_settings.insert(
                av::video_settings_keys::height(),
                ns::Number::with_u32(output_height).as_id_ref(),
            );

            let bitrate = get_average_bitrate(output_width as f32, output_height as f32, fps);

            debug!("recording bitrate: {bitrate}");

            let keyframe_interval = (fps * 2.0) as i32;

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

        let audio_input = audio_config
            .as_ref()
            .map(|config| {
                debug!("{config:?}");

                let output_settings = cidre::ns::Dictionary::with_keys_values(
                    &[
                        av::audio::all_formats_keys::id(),
                        av::audio::all_formats_keys::number_of_channels(),
                        av::audio::all_formats_keys::sample_rate(),
                    ],
                    &[
                        cat::AudioFormat::MPEG4_AAC.as_ref(),
                        (config.channels as u32).as_ref(),
                        (config.sample_rate).as_ref(),
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

                Ok::<_, InitError>(audio_input)
            })
            .transpose()?;

        asset_writer.start_writing();

        Ok(Self {
            config: video_config,
            audio_input,
            asset_writer,
            video_input,
            last_frame_timestamp: None,
            pause_timestamp: None,
            timestamp_offset: Duration::ZERO,
            is_writing: false,
            is_paused: false,
            video_frames_appended: 0,
            audio_frames_appended: 0,
            last_timestamp: None,
            last_video_pts: None,
            last_audio_pts: None,
        })
    }

    /// Expects frames with whatever pts values you like
    /// They will be made relative when encoding
    pub fn queue_video_frame(
        &mut self,
        frame: arc::R<cm::SampleBuf>,
        timestamp: Duration,
    ) -> Result<(), QueueFrameError> {
        if self.is_paused {
            return Ok(());
        };

        if !self.video_input.is_ready_for_more_media_data() {
            return Err(QueueFrameError::NotReadyForMore);
        }

        if !self.is_writing {
            self.is_writing = true;
            self.asset_writer
                .start_session_at_src_time(cm::Time::new(timestamp.as_millis() as i64, 1_000));
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

        self.last_video_pts = Some(pts_duration);

        let mut timing = frame.timing_info(0).unwrap();
        timing.pts = cm::Time::new(pts_duration.as_millis() as i64, 1_000);
        let new_frame = frame.copy_with_new_timing(&[timing]).unwrap();
        drop(frame);

        append_sample_buf(&mut self.video_input, &self.asset_writer, &new_frame)?;

        self.video_frames_appended += 1;
        self.last_timestamp = Some(timestamp);

        Ok(())
    }

    /// Expects frames with pts values relative to the first frame's pts
    /// in the timebase of 1 / sample rate
    pub fn queue_audio_frame(
        &mut self,
        frame: &frame::Audio,
        timestamp: Duration,
    ) -> Result<(), QueueFrameError> {
        if self.is_paused || !self.is_writing {
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

        if !audio_input.is_ready_for_more_media_data() {
            return Err(QueueFrameError::NotReadyForMore);
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

        let mut pts_duration = timestamp
            .checked_sub(self.timestamp_offset)
            .unwrap_or(Duration::ZERO);

        if let Some(last_pts) = self.last_audio_pts
            && pts_duration <= last_pts
        {
            let frame_duration = Self::audio_frame_duration(frame);
            let adjusted_pts = last_pts + frame_duration;

            trace!(
                ?timestamp,
                ?last_pts,
                adjusted_pts = ?adjusted_pts,
                frame_duration_ns = frame_duration.as_nanos(),
                samples = frame.samples(),
                sample_rate = frame.rate(),
                "Monotonic audio pts correction",
            );

            if let Some(new_offset) = timestamp.checked_sub(adjusted_pts) {
                self.timestamp_offset = new_offset;
            }

            pts_duration = adjusted_pts;
        }

        self.last_audio_pts = Some(pts_duration);

        let pts = cm::Time::new(
            (pts_duration.as_secs_f64() * frame.rate() as f64) as i64,
            frame.rate() as i32,
        );

        let buffer = cm::SampleBuf::create(
            Some(&block_buf),
            true,
            Some(format_desc.as_ref()),
            frame.samples() as isize,
            &[SampleTimingInfo {
                duration: cm::Time::new(1, frame.rate() as i32),
                pts,
                dts: cm::Time::invalid(),
            }],
            &[],
        )
        .map_err(QueueFrameError::Construct)?;

        append_sample_buf(audio_input, &self.asset_writer, &buffer)?;

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

    fn audio_frame_duration(frame: &frame::Audio) -> Duration {
        let rate = frame.rate();

        if rate == 0 {
            return Duration::from_millis(1);
        }

        let samples = frame.samples() as u128;
        if samples == 0 {
            return Duration::from_nanos(1);
        }

        let nanos = (samples * 1_000_000_000u128) / rate as u128;

        Duration::from_nanos(nanos.max(1) as u64)
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

        self.asset_writer.end_session_at_src_time(cm::Time::new(
            end_timestamp
                .saturating_sub(self.timestamp_offset)
                .as_millis() as i64,
            1000,
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

fn get_average_bitrate(width: f32, height: f32, fps: f32) -> f32 {
    5_000_000.0
        + width * height / (1920.0 * 1080.0) * 2_000_000.0
        + fps.min(60.0) / 30.0 * 5_000_000.0
}

// #[cfg(test)]
// mod test {
//     use super::*;

//     #[test]
//     fn bitrate() {
//         let hd_30 = get_average_bitrate(1920.0, 1080.0, 30.0);
//         assert!(hd_30 < 10_000_000.0);

//         let hd_60 = get_average_bitrate(1920.0, 1080.0, 60.0);
//         assert!(hd_60 < 13_000_000.0);

//         let fk_30 = get_average_bitrate(1280.0, 720.0, 30.0);
//         assert!(fk_30 < 20_000_000.0);

//         let fk_60 = get_average_bitrate(1280.0, 720.0, 60.0);
//         assert!(fk_60 < 24_000_000.0);
//     }
// }

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
    match input.append_sample_buf(frame) {
        Ok(true) => {}
        Ok(false) => {
            if writer.status() == av::asset::writer::Status::Failed {
                return Err(match writer.error() {
                    Some(err) => QueueFrameError::WriterFailed(err),
                    None => QueueFrameError::Failed,
                });
            }
            if writer.status() == av::asset::writer::Status::Writing {
                return Err(QueueFrameError::NotReadyForMore);
            }
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
