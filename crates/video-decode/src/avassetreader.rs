use std::path::PathBuf;

use cidre::{
    arc::{self, R},
    av::{self},
    cm,
    cv::{self},
    ns,
};
use ffmpeg::{codec as avcodec, format as avformat};
use tokio::runtime::Handle as TokioHandle;

pub struct AVAssetReaderDecoder {
    path: PathBuf,
    pixel_format: cv::PixelFormat,
    tokio_handle: TokioHandle,
    track_output: R<av::AssetReaderTrackOutput>,
    reader: R<av::AssetReader>,
}

impl AVAssetReaderDecoder {
    pub fn new(path: PathBuf, tokio_handle: TokioHandle) -> Result<Self, String> {
        let pixel_format = {
            let input = ffmpeg::format::input(&path).unwrap();

            let input_stream = input
                .streams()
                .best(ffmpeg::media::Type::Video)
                .ok_or("Could not find a video stream")
                .unwrap();

            let decoder = avcodec::Context::from_parameters(input_stream.parameters())
                .map_err(|e| format!("decoder context / {e}"))?
                .decoder()
                .video()
                .map_err(|e| format!("video decoder / {e}"))?;

            pixel_to_pixel_format(decoder.format())
        };

        let (track_output, reader) =
            Self::get_reader_track_output(&path, 0.0, &tokio_handle, pixel_format)?;

        Ok(Self {
            path,
            pixel_format,
            tokio_handle,
            track_output,
            reader,
        })
    }

    pub fn reset(&mut self, requested_time: f32) -> Result<(), String> {
        self.reader.cancel_reading();
        (self.track_output, self.reader) = Self::get_reader_track_output(
            &self.path,
            requested_time,
            &self.tokio_handle,
            self.pixel_format,
        )?;

        Ok(())
    }

    fn get_reader_track_output(
        path: &PathBuf,
        time: f32,
        handle: &TokioHandle,
        pixel_format: cv::PixelFormat,
    ) -> Result<(R<av::AssetReaderTrackOutput>, R<av::AssetReader>), String> {
        let asset = av::UrlAsset::with_url(
            &ns::Url::with_fs_path_str(path.to_str().unwrap(), false),
            None,
        )
        .ok_or_else(|| format!("UrlAsset::with_url{{{path:?}}}"))?;

        let mut reader = av::AssetReader::with_asset(&asset)
            .map_err(|e| format!("AssetReader::with_asset: {e}"))?;

        let time_range = cm::TimeRange {
            start: cm::Time::with_secs(time as f64, 100),
            duration: cm::Time::infinity(),
        };

        reader.set_time_range(time_range);

        let tracks = handle
            .block_on(asset.load_tracks_with_media_type(av::MediaType::video()))
            .map_err(|e| format!("asset.load_tracks_with_media_type: {e}"))?;

        let track = tracks.get(0).map_err(|e| e.to_string())?;

        let mut reader_track_output = av::AssetReaderTrackOutput::with_track(
            &track,
            Some(&ns::Dictionary::with_keys_values(
                &[cv::pixel_buffer::keys::pixel_format().as_ns()],
                &[pixel_format.to_cf_number().as_ns().as_id_ref()],
            )),
        )
        .map_err(|e| format!("asset.reader_track_output{{{pixel_format:?}}}): {e}"))?;

        reader_track_output.set_always_copies_sample_data(false);

        reader
            .add_output(&reader_track_output)
            .map_err(|e| format!("reader.add_output: {e}"))?;

        reader
            .start_reading()
            .map_err(|e| format!("reader.start_reading: {e}"))?;

        Ok((reader_track_output, reader))
    }

    pub fn frames(&mut self) -> FramesIter {
        FramesIter {
            track_output: &mut self.track_output,
        }
    }
}

pub struct FramesIter<'a> {
    track_output: &'a mut av::AssetReaderTrackOutput,
}

impl<'a> Iterator for FramesIter<'a> {
    type Item = ns::ExResult<'static, arc::R<cm::SampleBuf>>;

    fn next(&mut self) -> Option<Self::Item> {
        self.track_output.next_sample_buf().transpose()
    }
}

pub fn pixel_to_pixel_format(pixel: avformat::Pixel) -> cv::PixelFormat {
    match pixel {
        avformat::Pixel::NV12 => cv::PixelFormat::_420V,
        // this is intentional, it works and is faster /shrug
        avformat::Pixel::YUV420P => cv::PixelFormat::_420V,
        avformat::Pixel::RGBA => cv::PixelFormat::_32_RGBA,
        _ => todo!(),
    }
}

pub fn pixel_format_to_pixel(format: cv::PixelFormat) -> avformat::Pixel {
    match format {
        cv::PixelFormat::_420V => avformat::Pixel::NV12,
        cv::PixelFormat::_32_RGBA => avformat::Pixel::RGBA,
        _ => todo!(),
    }
}
