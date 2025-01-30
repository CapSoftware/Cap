use crate::{data::VideoInfo, pipeline::task::PipelineSinkTask, MediaError};

use super::Output;
use arc::Retained;
use cidre::{objc::Obj, *};
use tracing::{info, trace};

pub struct H264AVAssetWriterEncoder {
    tag: &'static str,
    last_pts: Option<i64>,
    config: VideoInfo,
    asset_writer: Retained<av::AssetWriter>,
    video_input: Retained<av::AssetWriterInput>,
    first_timestamp: Option<cm::Time>,
    last_timestamp: Option<cm::Time>,
}

impl H264AVAssetWriterEncoder {
    pub fn init(tag: &'static str, config: VideoInfo, output: Output) -> Result<Self, MediaError> {
        let fps = config.frame_rate.0 as f32 / config.frame_rate.1 as f32;
        let Output::File(destination) = output;

        let mut asset_writer = av::AssetWriter::with_url_and_file_type(
            cf::Url::with_path(destination.as_path(), false)
                .unwrap()
                .as_ns(),
            av::FileType::mp4(),
        )
        .map_err(|_| MediaError::Any("Failed to create AVAssetWriter"))?;

        let assistant =
            av::OutputSettingsAssistant::with_preset(av::OutputSettingsPreset::h264_3840x2160())
                .ok_or(MediaError::Any(
                    "Failed to create output settings assistant",
                ))?;

        let mut output_settings = assistant
            .video_settings()
            .ok_or(MediaError::Any("No assistant video settings"))?
            .copy_mut();

        output_settings.insert(
            av::video_settings_keys::width(),
            ns::Number::with_u32(config.width).as_id_ref(),
        );

        output_settings.insert(
            av::video_settings_keys::height(),
            ns::Number::with_u32(config.height).as_id_ref(),
        );

        let bitrate = config.width as f32 * config.height as f32 / (1920.0 * 1080.0) * 14_000_000.0
            + fps / 30.0 * 6_000_000.0;

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
            .map_err(|_| MediaError::Any("Failed to add asset writer input"))?;

        asset_writer.start_writing();

        Ok(Self {
            tag,
            last_pts: None,
            config,
            asset_writer,
            video_input,
            first_timestamp: None,
            last_timestamp: None,
        })
    }

    fn queue_frame(&mut self, frame: screencapturekit::cm_sample_buffer::CMSampleBuffer) {
        if !self.video_input.is_ready_for_more_media_data() {
            return;
        }

        let sample_buf = unsafe {
            let ptr = &*frame.sys_ref as *const _ as *const cm::SampleBuf;
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

    fn process_frame(&mut self) {}

    fn finish(&mut self) {
        self.asset_writer
            .end_session_at_src_time(self.last_timestamp.take().unwrap_or(cm::Time::zero()));
        self.video_input.mark_as_finished();
        self.asset_writer.finish_writing();
    }
}

impl PipelineSinkTask for H264AVAssetWriterEncoder {
    type Input = screencapturekit::cm_sample_buffer::CMSampleBuffer;

    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: &flume::Receiver<Self::Input>,
    ) {
        ready_signal.send(Ok(())).ok();

        while let Ok(frame) = input.recv() {
            self.queue_frame(frame);
            self.process_frame();
        }
    }

    fn finish(&mut self) {
        self.finish();
    }
}

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {
    static AVVideoAverageBitRateKey: &'static cidre::ns::String;
}
