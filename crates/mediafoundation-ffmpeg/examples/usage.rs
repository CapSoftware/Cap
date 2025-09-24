fn main() {
    #[cfg(windows)]
    win::main();
}

#[cfg(windows)]
mod win {
    use cap_mediafoundation_ffmpeg::{H264StreamMuxer, MuxerConfig};
    use ffmpeg::format;
    use std::path::PathBuf;

    /// Example of using H264StreamMuxer with an existing FFmpeg output context
    /// This demonstrates how to integrate with MP4File or similar structures
    fn example_with_shared_output() -> Result<(), Box<dyn std::error::Error>> {
        // Initialize FFmpeg
        ffmpeg::init()?;

        // Create an output context (this would normally be owned by MP4File)
        let output_path = PathBuf::from("output.mp4");
        let mut output = format::output(&output_path)?;

        // Configure the H264 muxer
        let config = MuxerConfig {
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate: 5_000_000, // 5 Mbps
        };

        // Add the H264 stream and create the muxer
        // Note: We need to add the stream before writing the header
        let mut h264_muxer = H264StreamMuxer::new(&mut output, config)?;

        // You might also have other streams (like audio) added to the same output
        // ... add audio stream here if needed ...

        // Write the header after all streams are added
        output.write_header()?;

        // Now you can write H264 samples from MediaFoundation
        #[cfg(windows)]
        {
            // Example: Write samples from MediaFoundation
            // let sample: IMFSample = get_sample_from_media_foundation();
            // h264_muxer.write_sample(&sample)?;
        }

        // Or write raw H264 data
        let example_h264_data = vec![0, 0, 0, 1, 0x65]; // Example keyframe NAL
        h264_muxer.write_h264_data(
            &example_h264_data,
            0,     // pts in microseconds
            0,     // dts in microseconds
            33333, // duration in microseconds (1/30 fps)
            true,  // is_keyframe
            &mut output,
        )?;

        // Finish the muxer (doesn't write trailer)
        h264_muxer.finish()?;

        // Write the trailer (this would be done by MP4File::finish())
        output.write_trailer()?;

        Ok(())
    }

    /// Example showing how this would integrate with an MP4File-like structure
    struct MP4FileExample {
        output: format::context::Output,
        h264_muxer: Option<H264StreamMuxer>,
        is_finished: bool,
    }

    impl MP4FileExample {
        fn new(output_path: PathBuf, video_config: MuxerConfig) -> Result<Self, ffmpeg::Error> {
            let mut output = format::output(&output_path)?;

            // Add H264 stream and create muxer
            let h264_muxer = H264StreamMuxer::new(&mut output, video_config)?;

            // You could add audio streams here too
            // ...

            // Write header after all streams are added
            output.write_header()?;

            Ok(Self {
                output,
                h264_muxer: Some(h264_muxer),
                is_finished: false,
            })
        }

        #[cfg(windows)]
        fn write_sample(
            &mut self,
            sample: &windows::Win32::Media::MediaFoundation::IMFSample,
        ) -> Result<(), Box<dyn std::error::Error>> {
            if let Some(muxer) = &mut self.h264_muxer {
                muxer.write_sample(sample, &mut self.output)?;
            }
            Ok(())
        }

        fn write_h264_data(
            &mut self,
            data: &[u8],
            pts: i64,
            dts: i64,
            duration: i64,
            is_keyframe: bool,
        ) -> Result<(), ffmpeg::Error> {
            if let Some(muxer) = &mut self.h264_muxer {
                muxer.write_h264_data(data, pts, dts, duration, is_keyframe, &mut self.output)?;
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

            // Write trailer
            self.output.write_trailer()?;
            Ok(())
        }
    }

    /// Alternative approach using the owned version for standalone use
    fn example_with_owned_muxer() -> Result<(), Box<dyn std::error::Error>> {
        use mediafoundation_ffmpeg::H264SampleMuxerOwned;

        // Initialize FFmpeg
        ffmpeg::init()?;

        let config = MuxerConfig {
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate: 5_000_000,
        };

        // Create a standalone muxer that owns its output
        let mut muxer =
            H264SampleMuxerOwned::new_mp4(PathBuf::from("standalone_output.mp4"), config)?;

        // Write some H264 data
        let example_h264_data = vec![0, 0, 0, 1, 0x65]; // Example keyframe NAL
        muxer.write_h264_data(
            &example_h264_data,
            0,     // pts
            0,     // dts
            33333, // duration
            true,  // is_keyframe
        )?;

        // The muxer automatically finishes and writes trailer when dropped
        muxer.finish()?;

        Ok(())
    }

    fn main() -> Result<(), Box<dyn std::error::Error>> {
        println!("Example 1: Using H264StreamMuxer with shared output");
        example_with_shared_output()?;

        println!("\nExample 2: Using H264SampleMuxerOwned for standalone use");
        example_with_owned_muxer()?;

        println!("\nExample 3: Using MP4FileExample with integrated muxer");
        let mut mp4_file = MP4FileExample::new(
            PathBuf::from("integrated_output.mp4"),
            MuxerConfig {
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate: 5_000_000,
            },
        )?;

        // Write some test data
        let example_h264_data = vec![0, 0, 0, 1, 0x65];
        mp4_file.write_h264_data(&example_h264_data, 0, 0, 33333, true)?;

        // Finish writing
        mp4_file.finish()?;

        Ok(())
    }
}
