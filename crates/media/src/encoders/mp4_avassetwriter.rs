use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use crate::{
    data::{AudioInfo, FFAudio, PlanarData, VideoInfo},
    pipeline::task::PipelineSinkTask,
    MediaError,
};

use arc::Retained;
use cidre::{cm::SampleTimingInfo, objc::Obj, *};

pub struct MP4AVAssetWriterEncoder {
    tag: &'static str,
    last_pts: Option<i64>,
    config: VideoInfo,
    asset_writer: Retained<av::AssetWriter>,
    video_input: Retained<av::AssetWriterInput>,
    audio_input: Option<Retained<av::AssetWriterInput>>,
    first_timestamp: Option<cm::Time>,
    last_timestamp: Option<cm::Time>,
    is_writing: bool,
}

impl MP4AVAssetWriterEncoder {
    pub fn init(
        tag: &'static str,
        video_config: VideoInfo,
        audio_config: Option<AudioInfo>,
        output: PathBuf,
        output_height: Option<u32>,
    ) -> Result<Self, MediaError> {
        debug!("{video_config:#?}");
        debug!("{audio_config:#?}");

        let fps = video_config.frame_rate.0 as f32 / video_config.frame_rate.1 as f32;

        let mut asset_writer = av::AssetWriter::with_url_and_file_type(
            cf::Url::with_path(output.as_path(), false).unwrap().as_ns(),
            av::FileType::mp4(),
        )
        .map_err(|_| MediaError::Any("Failed to create AVAssetWriter"))?;

        let video_input = {
            let assistant = av::OutputSettingsAssistant::with_preset(
                av::OutputSettingsPreset::h264_3840x2160(),
            )
            .ok_or(MediaError::Any(
                "Failed to create output settings assistant",
            ))?;

            let mut output_settings = assistant
                .video_settings()
                .ok_or(MediaError::Any("No assistant video settings"))?
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

            output_settings.insert(
                av::video_settings_keys::compression_props(),
                ns::Dictionary::with_keys_values(
                    &[unsafe { AVVideoAverageBitRateKey }],
                    &[ns::Number::with_f32(bitrate).as_id_ref()],
                )
                .as_id_ref(),
            );

            let mut video_input = av::AssetWriterInput::with_media_type_and_output_settings(
                av::MediaType::video(),
                Some(output_settings.as_ref()),
            )
            .map_err(|_| MediaError::Any("Failed to create AVAssetWriterInput"))?;
            video_input.set_expects_media_data_in_real_time(true);

            asset_writer
                .add_input(&video_input)
                .map_err(|_| MediaError::Any("Failed to add asset writer video input"))?;

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
                .map_err(|_| MediaError::Any("Failed to create AVAssetWriterInput"))?;

                audio_input.set_expects_media_data_in_real_time(true);

                asset_writer
                    .add_input(&audio_input)
                    .map_err(|_| MediaError::Any("Failed to add asset writer audio input"))?;

                Ok::<_, MediaError>(audio_input)
            })
            .transpose()?;

        asset_writer.start_writing();

        Ok(Self {
            tag,
            last_pts: None,
            config: video_config,
            audio_input,
            asset_writer,
            video_input,
            first_timestamp: None,
            last_timestamp: None,
            is_writing: true,
        })
    }

    pub fn queue_video_frame(&mut self, frame: screencapturekit::output::CMSampleBuffer) {
        if !self.video_input.is_ready_for_more_media_data() {
            return;
        }

        let sample_buf = unsafe {
            use core_foundation::base::TCFType;
            let ptr = &*frame.as_concrete_TypeRef() as *const _ as *const cm::SampleBuf;
            &*ptr
        };

        let time = sample_buf.pts();

        if self.first_timestamp.is_none() {
            self.asset_writer.start_session_at_src_time(time);
            self.first_timestamp = Some(time);
        }

        self.last_timestamp = Some(time);

        self.video_input.append_sample_buf(sample_buf).ok();
    }

    pub fn queue_audio_frame(&mut self, frame: FFAudio) -> Result<(), MediaError> {
        let Some(audio_input) = &mut self.audio_input else {
            return Err(MediaError::Any("No audio input"));
        };

        if !audio_input.is_ready_for_more_media_data() {
            return Err(MediaError::Any("Not ready for more media data"));
        }

        let Some(first_timestamp) = self.first_timestamp else {
            return Ok(());
        };

        let audio_desc = cat::audio::StreamBasicDesc::common_f32(
            frame.rate() as f64,
            frame.channels() as u32,
            frame.is_packed(),
        );

        let total_data = frame.samples() * frame.channels() as usize * frame.format().bytes();

        let mut block_buf = cm::BlockBuf::with_mem_block(total_data, None)
            .map_err(|_| MediaError::Any("Failed to allocate block buffer"))?;

        let block_buf_slice = block_buf
            .as_mut_slice()
            .map_err(|_| MediaError::Any("Failed to map block buffer"))?;

        if frame.is_planar() {
            let mut offset = 0;
            for plane_i in 0..frame.planes() {
                let data = frame.plane_data(plane_i);
                block_buf_slice[offset..offset + data.len()]
                    .copy_from_slice(&data[0..frame.samples() * frame.format().bytes()]);
                offset += data.len();
            }
        } else {
            block_buf_slice.copy_from_slice(&frame.data(0)[0..total_data]);
        }

        let format_desc = cm::AudioFormatDesc::with_asbd(&audio_desc)
            .map_err(|_| MediaError::Any("Failed to create audio format desc"))?;

        let buffer = unsafe {
            result_unchecked(|res| {
                cm::SampleBuf::create_in(
                    None,
                    Some(&block_buf),
                    true,
                    None,
                    std::ptr::null(),
                    Some(format_desc.as_ref()),
                    frame.samples() as isize,
                    1,
                    &SampleTimingInfo {
                        duration: cm::Time::new(1, frame.rate() as i32),
                        pts: cm::Time::new(frame.pts().unwrap_or(0), 1_000_000)
                            .add(first_timestamp),
                        dts: cm::Time::invalid(),
                    },
                    0,
                    std::ptr::null(),
                    res,
                )
            })
        }
        .map_err(|_| MediaError::Any("Failed to create sample buffer"))?;

        audio_input.append_sample_buf(&buffer).map_err(|_| {
            MediaError::Any("Failed to append audio sample buffer to asset writer input")
        })?;

        Ok(())
    }

    fn process_frame(&mut self) {}

    fn finish(&mut self) {
        if !self.is_writing {
            return;
        }

        self.is_writing = false;

        self.asset_writer
            .end_session_at_src_time(self.last_timestamp.take().unwrap_or(cm::Time::zero()));
        self.video_input.mark_as_finished();
        self.audio_input.as_mut().map(|i| i.mark_as_finished());

        self.asset_writer.finish_writing();

        info!("Finished writing");
    }
}

use flume::Receiver;
use screencapturekit::output::CMSampleBuffer;
use tracing::{debug, info};

impl PipelineSinkTask<CMSampleBuffer> for MP4AVAssetWriterEncoder {
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: &flume::Receiver<CMSampleBuffer>,
    ) {
        ready_signal.send(Ok(())).ok();

        while let Ok(frame) = input.recv() {
            self.queue_video_frame(frame);
            self.process_frame();
        }
    }

    fn finish(&mut self) {
        self.finish();
    }
}

impl PipelineSinkTask<FFAudio> for Arc<Mutex<MP4AVAssetWriterEncoder>> {
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: &flume::Receiver<FFAudio>,
    ) {
        ready_signal.send(Ok(())).ok();

        while let Ok(frame) = input.recv() {
            let mut this = self.lock().unwrap();
            this.queue_audio_frame(frame);
            this.process_frame();
        }
    }

    fn finish(&mut self) {
        self.lock().unwrap().finish();
    }
}

impl PipelineSinkTask<CMSampleBuffer> for Arc<Mutex<MP4AVAssetWriterEncoder>> {
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: &flume::Receiver<CMSampleBuffer>,
    ) {
        ready_signal.send(Ok(())).ok();

        while let Ok(frame) = input.recv() {
            let mut this = self.lock().unwrap();
            this.queue_video_frame(frame);
            this.process_frame();
        }
    }

    fn finish(&mut self) {
        self.lock().unwrap().finish();
    }
}

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {
    static AVVideoAverageBitRateKey: &'static cidre::ns::String;
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
