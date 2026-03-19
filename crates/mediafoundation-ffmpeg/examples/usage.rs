fn main() {
    #[cfg(windows)]
    win::main();
}

#[cfg(windows)]
mod win {
    use cap_mediafoundation_ffmpeg::{H264StreamMuxer, MuxerConfig};
    use ffmpeg::format;
    use std::path::PathBuf;

    struct MP4FileExample {
        output: format::context::Output,
        h264_muxer: Option<H264StreamMuxer>,
        is_finished: bool,
    }

    impl MP4FileExample {
        fn new(output_path: PathBuf, video_config: MuxerConfig) -> Result<Self, ffmpeg::Error> {
            let mut output = format::output(&output_path)?;

            let h264_muxer = H264StreamMuxer::new(&mut output, video_config)?;

            output.write_header()?;

            Ok(Self {
                output,
                h264_muxer: Some(h264_muxer),
                is_finished: false,
            })
        }

        #[allow(dead_code)]
        fn write_sample(
            &mut self,
            sample: &windows::Win32::Media::MediaFoundation::IMFSample,
        ) -> Result<(), Box<dyn std::error::Error>> {
            if let Some(muxer) = &mut self.h264_muxer {
                muxer.write_sample(sample, &mut self.output)?;
            }
            Ok(())
        }

        fn finish(&mut self) -> Result<(), ffmpeg::Error> {
            if self.is_finished {
                return Ok(());
            }
            self.is_finished = true;

            if let Some(muxer) = &mut self.h264_muxer {
                muxer.finish()?;
            }

            self.output.write_trailer()?;
            Ok(())
        }
    }

    pub fn main() {
        ffmpeg::init().unwrap();

        println!("Creating MP4FileExample...");
        let mut mp4_file = MP4FileExample::new(
            PathBuf::from("example_output.mp4"),
            MuxerConfig {
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate: 5_000_000,
                ..Default::default()
            },
        )
        .unwrap();

        mp4_file.finish().unwrap();
        println!("Done!");
    }
}
