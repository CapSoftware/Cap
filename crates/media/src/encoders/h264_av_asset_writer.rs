use screencapturekit::cm_sample_buffer::CMSampleBuffer;
use std::path::PathBuf;

impl H264AVAssetWriterEncoder {
    pub fn init(tag: &'static str, config: VideoInfo, output: Output) -> Result<Self, MediaError> {
        let Output::File(destination) = output;

        // Check if file exists and has content
        let file_exists = destination.exists() && std::fs::metadata(&destination)?.len() > 0;

        // Initialize AVAssetWriter with append mode if file exists
        let asset_writer = if file_exists {
            // For existing files, we need to create a temporary writer to append
            let temp_path = destination.with_extension("temp.mp4");
            let writer = AVAssetWriter::create(&temp_path)?;

            // After writing is done, we'll concatenate this with the original
            writer.set_finish_callback(Box::new(move || {
                // Use AVFoundation to combine the files
                let session = AVFoundation::shared_session();
                session.concatenate_videos(&[&destination, &temp_path], &destination)?;
                std::fs::remove_file(&temp_path)?;
                Ok(())
            }));

            writer
        } else {
            // Create new file
            AVAssetWriter::create(&destination)?
        };

        Ok(Self {
            tag,
            asset_writer,
            // ... other fields
        })
    }
}
