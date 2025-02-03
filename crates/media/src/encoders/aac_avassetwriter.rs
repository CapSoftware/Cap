use std::path::PathBuf;

use crate::{
    data::{AudioInfo, VideoInfo},
    pipeline::task::PipelineSinkTask,
    MediaError,
};

use arc::Retained;
use cidre::{objc::Obj, *};
use tracing::{info, trace};

pub struct ACCAVAsetWriterEncoder {
    tag: &'static str,
    last_pts: Option<i64>,
    asset_writer: Retained<av::AssetWriter>,
    audio_input: Retained<av::AssetWriterInput>,
    first_timestamp: Option<cm::Time>,
    last_timestamp: Option<cm::Time>,
}

impl ACCAVAsetWriterEncoder {
    pub fn init(tag: &'static str, output: PathBuf) -> Result<Self, MediaError> {
        let mut asset_writer = av::AssetWriter::with_url_and_file_type(
            cf::Url::with_path(output.as_path(), false).unwrap().as_ns(),
            av::FileType::m4a(),
        )
        .map_err(|_| MediaError::Any("Failed to create AVAssetWriter"))?;

        let output_settings = ns::Dictionary::with_keys_values(
            &[
                av::audio::settings::all_formats_keys::id(),
                av::audio::settings::all_formats_keys::sample_rate(),
                av::audio::settings::all_formats_keys::number_of_channels(),
                av::audio::settings::encoder_propery_keys::bit_rate(),
            ],
            &[
                ns::Number::with_i32(1633772320).as_id_ref(),
                ns::Number::with_u32(48000).as_id_ref(),
                ns::Number::with_u32(2 as u32).as_id_ref(),
                ns::Number::with_i32(128000).as_id_ref(), // 128 kbps bitrate
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
            .map_err(|_| MediaError::Any("Failed to add asset writer input"))?;

        asset_writer.start_writing();

        Ok(Self {
            tag,
            last_pts: None,
            asset_writer,
            audio_input,
            first_timestamp: None,
            last_timestamp: None,
        })
    }

    pub fn queue_sample_buffer(&mut self, frame: screencapturekit::output::CMSampleBuffer) {
        if !self.audio_input.is_ready_for_more_media_data() {
            return;
        }

        let sample_buf = unsafe {
            use core_foundation::base::TCFType;
            let ptr = frame.as_concrete_TypeRef() as *const _ as *const cm::SampleBuf;
            &*ptr
        };

        let time = sample_buf.pts();

        if self.first_timestamp.is_none() {
            self.asset_writer.start_session_at_src_time(time);
            self.first_timestamp = Some(time);
        }

        self.last_timestamp = Some(time);

        self.audio_input.append_sample_buf(&sample_buf).ok();
    }

    fn process_frame(&mut self) {}

    fn finish(&mut self) {
        self.asset_writer
            .end_session_at_src_time(self.last_timestamp.take().unwrap_or(cm::Time::zero()));
        self.audio_input.mark_as_finished();
        self.asset_writer.finish_writing();
    }
}

impl PipelineSinkTask<screencapturekit::output::CMSampleBuffer> for ACCAVAsetWriterEncoder {
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: &flume::Receiver<screencapturekit::output::CMSampleBuffer>,
    ) {
        ready_signal.send(Ok(())).ok();

        while let Ok(frame) = input.recv() {
            self.queue_sample_buffer(frame);
            self.process_frame();
        }
    }

    fn finish(&mut self) {
        self.finish();
    }
}
