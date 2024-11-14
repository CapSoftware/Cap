use crate::{data::VideoInfo, pipeline::task::PipelineSinkTask, MediaError};

use super::Output;
use arc::Retained;
use cidre::{objc::Obj, *};

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
        let Output::File(destination) = output;

        // Check if file exists and has content
        let file_exists = destination.exists()
            && std::fs::metadata(&destination)
                .map_err(|e| MediaError::Any("Failed to read file metadata"))?
                .len()
                > 0;

        let mut asset_writer = if file_exists {
            // For existing files, we need to continue the session
            let mut writer = av::AssetWriter::with_url_and_file_type(
                cf::Url::with_path(destination.as_path(), false)
                    .unwrap()
                    .as_ns(),
                av::FileType::mp4(),
            )
            .unwrap();

            writer.set_should_optimize_for_network_use(true);
            writer
        } else {
            av::AssetWriter::with_url_and_file_type(
                cf::Url::with_path(destination.as_path(), false)
                    .unwrap()
                    .as_ns(),
                av::FileType::mp4(),
            )
            .unwrap()
        };

        let assistant =
            av::OutputSettingsAssistant::with_preset(av::OutputSettingsPreset::h264_3840x2160())
                .unwrap();

        let mut output_settings = assistant.video_settings().unwrap().copy_mut();

        output_settings.insert(
            av::video_settings_keys::width(),
            ns::Number::with_u32(config.width).as_id_ref(),
        );

        output_settings.insert(
            av::video_settings_keys::height(),
            ns::Number::with_u32(config.height).as_id_ref(),
        );

        output_settings.insert(
            av::video_settings_keys::compression_props(),
            ns::Dictionary::with_keys_values(
                &[unsafe { AVVideoAverageBitRateKey }],
                &[ns::Number::with_u32(10_000_000).as_id_ref()],
            )
            .as_id_ref(),
        );

        let mut video_input = av::AssetWriterInput::with_media_type_and_output_settings(
            av::MediaType::video(),
            Some(output_settings.as_ref()),
        )
        .unwrap();
        video_input.set_expects_media_data_in_real_time(true);

        asset_writer.add_input(&video_input).unwrap();

        if file_exists {
            let url = cf::Url::with_path(destination.as_path(), false).unwrap();
            let url = Retained::retained(&url);
            let asset = av::UrlAsset::with_url(url.as_ns(), None).unwrap();

            // Get the duration as a CMTime
            let last_timestamp = asset.duration();

            // Don't start writing yet - we'll do that when we get the first frame
            Ok(Self {
                tag,
                last_pts: None,
                config,
                asset_writer,
                video_input,
                first_timestamp: None,
                last_timestamp: Some(last_timestamp),
            })
        } else {
            // For new files, start writing immediately
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
    }

    fn queue_frame(&mut self, frame: screencapturekit::cm_sample_buffer::CMSampleBuffer) {
        let sample_buf = unsafe {
            let ptr = &*frame.sys_ref as *const _ as *const cm::SampleBuf;
            &*ptr
        };

        let time = sample_buf.pts();

        if self.first_timestamp.is_none() {
            self.first_timestamp = Some(time);

            // If we have a last timestamp (resuming), offset from there
            if let Some(last_time) = self.last_timestamp {
                // Start writing if we haven't yet
                if self.asset_writer.status() != av::AssetWriterStatus::Writing {
                    self.asset_writer.start_writing();
                }
                self.asset_writer.start_session_at_src_time(last_time);
            } else {
                // For first recording, start at beginning
                if self.asset_writer.status() != av::AssetWriterStatus::Writing {
                    self.asset_writer.start_writing();
                }
                self.asset_writer.start_session_at_src_time(time);
            }
        }

        // Calculate adjusted timestamp
        let adjusted_time = if let Some(last_time) = self.last_timestamp {
            // When resuming, calculate elapsed time since start of current segment
            let segment_start = self.first_timestamp.unwrap();
            let elapsed = time.value - segment_start.value;

            // Add elapsed time to the last timestamp of previous segment
            cm::Time::new(last_time.value + elapsed, time.scale)
        } else {
            // First recording - use original timestamp
            time
        };

        // Keep track of the latest timestamp for this segment
        self.last_timestamp = Some(adjusted_time);

        // Write the frame with adjusted timestamp
        let mut adjusted_sample_buf = sample_buf.clone();
        adjusted_sample_buf.set_output_pts(adjusted_time);

        if self.video_input.is_ready_for_more_media_data() {
            self.video_input
                .append_sample_buf(&adjusted_sample_buf)
                .unwrap();
        }
    }

    fn process_frame(&mut self) {}

    fn finish(&mut self) {
        if let Some(last_time) = self.last_timestamp {
            self.asset_writer.end_session_at_src_time(last_time);
        }
        self.video_input.mark_as_finished();
        self.asset_writer.finish_writing();
    }
}

impl PipelineSinkTask for H264AVAssetWriterEncoder {
    type Input = screencapturekit::cm_sample_buffer::CMSampleBuffer;

    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: flume::Receiver<Self::Input>,
    ) {
        println!("Starting {} video encoding thread", self.tag);
        ready_signal.send(Ok(())).unwrap();

        while let Ok(frame) = input.recv() {
            self.queue_frame(frame);
            self.process_frame();
        }

        println!("Received last {} frame. Finishing up encoding.", self.tag);
        self.finish();

        println!("Shutting down {} video encoding thread", self.tag);
    }
}

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {
    static AVVideoAverageBitRateKey: &'static cidre::ns::String;
}
