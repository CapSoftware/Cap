use std::path::{Path, PathBuf};
use std::sync::Arc;

use cidre::{
    arc::{self, R},
    av::{self},
    cm,
    cv::{self},
    ns,
};
use ffmpeg::{codec as avcodec, format as avformat};
use tokio::runtime::Handle as TokioHandle;

#[derive(Clone)]
pub struct KeyframeIndex {
    keyframes: Vec<(u32, f64)>,
    fps: f64,
    duration_secs: f64,
}

impl KeyframeIndex {
    pub fn build(path: &Path) -> Result<Self, String> {
        let build_start = std::time::Instant::now();

        let input = avformat::input(path)
            .map_err(|e| format!("Failed to open video for keyframe scan: {e}"))?;

        let video_stream = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or("No video stream found")?;

        let stream_index = video_stream.index();
        let time_base = video_stream.time_base();
        let fps = {
            let rate = video_stream.avg_frame_rate();
            if rate.denominator() == 0 {
                30.0
            } else {
                rate.numerator() as f64 / rate.denominator() as f64
            }
        };

        let duration_secs = {
            let duration = video_stream.duration();
            if duration > 0 {
                duration as f64 * time_base.numerator() as f64 / time_base.denominator() as f64
            } else {
                0.0
            }
        };

        let mut keyframes = Vec::new();

        let mut input =
            avformat::input(path).map_err(|e| format!("Failed to reopen video for scan: {e}"))?;

        for (stream, packet) in input.packets() {
            if stream.index() != stream_index {
                continue;
            }

            if packet.is_key() {
                let pts = packet.pts().unwrap_or(0);
                let time_secs =
                    pts as f64 * time_base.numerator() as f64 / time_base.denominator() as f64;
                let frame_number = (time_secs * fps).round() as u32;
                keyframes.push((frame_number, time_secs));
            }
        }

        let elapsed = build_start.elapsed();
        tracing::info!(
            path = %path.display(),
            keyframe_count = keyframes.len(),
            fps = fps,
            duration_secs = duration_secs,
            build_ms = elapsed.as_millis(),
            "Built keyframe index"
        );

        Ok(Self {
            keyframes,
            fps,
            duration_secs,
        })
    }

    pub fn nearest_keyframe_before(&self, target_frame: u32) -> Option<(u32, f64)> {
        if self.keyframes.is_empty() {
            return None;
        }

        let pos = self
            .keyframes
            .binary_search_by_key(&target_frame, |(frame, _)| *frame);

        match pos {
            Ok(i) => Some(self.keyframes[i]),
            Err(0) => None,
            Err(i) => Some(self.keyframes[i - 1]),
        }
    }

    pub fn nearest_keyframe_after(&self, target_frame: u32) -> Option<(u32, f64)> {
        if self.keyframes.is_empty() {
            return None;
        }

        let pos = self
            .keyframes
            .binary_search_by_key(&target_frame, |(frame, _)| *frame);

        let idx = match pos {
            Ok(i) => {
                if i + 1 < self.keyframes.len() {
                    i + 1
                } else {
                    i
                }
            }
            Err(i) => {
                if i < self.keyframes.len() {
                    i
                } else {
                    return None;
                }
            }
        };

        Some(self.keyframes[idx])
    }

    pub fn get_strategic_positions(&self, num_positions: usize) -> Vec<f64> {
        if self.keyframes.is_empty() || num_positions == 0 {
            return vec![0.0];
        }

        let total_keyframes = self.keyframes.len();
        if total_keyframes <= num_positions {
            return self.keyframes.iter().map(|(_, time)| *time).collect();
        }

        let mut positions: Vec<f64> = Vec::with_capacity(num_positions);

        positions.push(self.keyframes[0].1);

        if num_positions > 2 {
            let inner_count = num_positions - 2;
            let step = (total_keyframes - 1) as f64 / (inner_count + 1) as f64;
            for i in 1..=inner_count {
                let idx = (step * i as f64).round() as usize;
                let idx = idx.min(total_keyframes - 2);
                positions.push(self.keyframes[idx].1);
            }
        }

        if num_positions > 1 {
            positions.push(self.keyframes[total_keyframes - 1].1);
        }

        positions
    }

    pub fn fps(&self) -> f64 {
        self.fps
    }

    pub fn duration_secs(&self) -> f64 {
        self.duration_secs
    }

    pub fn keyframe_count(&self) -> usize {
        self.keyframes.len()
    }

    pub fn keyframes(&self) -> &[(u32, f64)] {
        &self.keyframes
    }
}

fn compute_seek_time(keyframe_index: Option<&Arc<KeyframeIndex>>, requested_time: f32) -> f32 {
    if let Some(kf_index) = keyframe_index {
        let fps = kf_index.fps();
        let target_frame = (requested_time as f64 * fps).round() as u32;
        if let Some((_, keyframe_time)) = kf_index.nearest_keyframe_before(target_frame) {
            return keyframe_time as f32;
        }
        if let Some((_, first_keyframe_time)) = kf_index.keyframes().first() {
            return *first_keyframe_time as f32;
        }
    }
    requested_time
}

pub struct AVAssetReaderDecoder {
    path: PathBuf,
    pixel_format: cv::PixelFormat,
    tokio_handle: TokioHandle,
    track_output: R<av::AssetReaderTrackOutput>,
    reader: R<av::AssetReader>,
    width: u32,
    height: u32,
    keyframe_index: Option<Arc<KeyframeIndex>>,
    current_position_secs: f32,
}

impl AVAssetReaderDecoder {
    pub fn new(path: PathBuf, tokio_handle: TokioHandle) -> Result<Self, String> {
        Self::new_at_position(path, tokio_handle, 0.0)
    }

    pub fn new_at_position(
        path: PathBuf,
        tokio_handle: TokioHandle,
        start_time: f32,
    ) -> Result<Self, String> {
        let keyframe_index = match KeyframeIndex::build(&path) {
            Ok(index) => Some(Arc::new(index)),
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "Failed to build keyframe index, seeking may be slower"
                );
                None
            }
        };

        Self::new_with_keyframe_index(path, tokio_handle, start_time, keyframe_index)
    }

    pub fn new_with_keyframe_index(
        path: PathBuf,
        tokio_handle: TokioHandle,
        start_time: f32,
        keyframe_index: Option<Arc<KeyframeIndex>>,
    ) -> Result<Self, String> {
        let (pixel_format, width, height) = {
            let input = ffmpeg::format::input(&path)
                .map_err(|e| format!("Failed to open video input '{}': {e}", path.display()))?;

            let input_stream = input
                .streams()
                .best(ffmpeg::media::Type::Video)
                .ok_or_else(|| format!("No video stream in '{}'", path.display()))?;

            let decoder = avcodec::Context::from_parameters(input_stream.parameters())
                .map_err(|e| format!("decoder context / {e}"))?
                .decoder()
                .video()
                .map_err(|e| format!("video decoder / {e}"))?;

            (
                pixel_to_pixel_format(decoder.format())?,
                decoder.width(),
                decoder.height(),
            )
        };

        let seek_time = compute_seek_time(keyframe_index.as_ref(), start_time);

        let (track_output, reader) = Self::get_reader_track_output(
            &path,
            seek_time,
            &tokio_handle,
            pixel_format,
            width,
            height,
        )?;

        Ok(Self {
            path,
            pixel_format,
            tokio_handle,
            track_output,
            reader,
            width,
            height,
            keyframe_index,
            current_position_secs: seek_time,
        })
    }

    pub fn reset(&mut self, requested_time: f32) -> Result<(), String> {
        self.reader.cancel_reading();

        let seek_time = compute_seek_time(self.keyframe_index.as_ref(), requested_time);

        (self.track_output, self.reader) = Self::get_reader_track_output(
            &self.path,
            seek_time,
            &self.tokio_handle,
            self.pixel_format,
            self.width,
            self.height,
        )?;

        self.current_position_secs = seek_time;

        Ok(())
    }

    pub fn current_position_secs(&self) -> f32 {
        self.current_position_secs
    }

    pub fn update_position(&mut self, position_secs: f32) {
        self.current_position_secs = position_secs;
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub fn pixel_format(&self) -> cv::PixelFormat {
        self.pixel_format
    }

    pub fn take_keyframe_index(&mut self) -> Option<Arc<KeyframeIndex>> {
        self.keyframe_index.take()
    }

    pub fn keyframe_index(&self) -> Option<&Arc<KeyframeIndex>> {
        self.keyframe_index.as_ref()
    }

    pub fn keyframe_index_arc(&self) -> Option<Arc<KeyframeIndex>> {
        self.keyframe_index.clone()
    }

    fn get_reader_track_output(
        path: &Path,
        time: f32,
        handle: &TokioHandle,
        pixel_format: cv::PixelFormat,
        width: u32,
        height: u32,
    ) -> Result<(R<av::AssetReaderTrackOutput>, R<av::AssetReader>), String> {
        let asset = av::UrlAsset::with_url(
            &ns::Url::with_fs_path_str(
                path.to_str()
                    .ok_or_else(|| format!("Invalid UTF-8 in path: {path:?}"))?,
                false,
            ),
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
                &[
                    cv::pixel_buffer::keys::pixel_format().as_ns(),
                    cv::pixel_buffer::keys::width().as_ns(),
                    cv::pixel_buffer::keys::height().as_ns(),
                ],
                &[
                    pixel_format.to_cf_number().as_ns().as_id_ref(),
                    ns::Number::with_u32(width).as_id_ref(),
                    ns::Number::with_u32(height).as_id_ref(),
                ],
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

    pub fn frames(&mut self) -> FramesIter<'_> {
        FramesIter {
            track_output: &mut self.track_output,
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
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

pub fn pixel_to_pixel_format(pixel: avformat::Pixel) -> Result<cv::PixelFormat, String> {
    match pixel {
        avformat::Pixel::NV12 => Ok(cv::PixelFormat::_420V),
        avformat::Pixel::YUV420P => Ok(cv::PixelFormat::_420V),
        avformat::Pixel::RGBA => Ok(cv::PixelFormat::_32_RGBA),
        avformat::Pixel::BGRA => Ok(cv::PixelFormat::_32_BGRA),
        other => {
            tracing::error!(
                pixel_format = ?other,
                "Unhandled pixel format encountered - no mapping to cv::PixelFormat available"
            );
            Err(format!(
                "Unsupported pixel format: {other:?}. Supported formats: NV12, YUV420P, RGBA, BGRA"
            ))
        }
    }
}

pub fn pixel_format_to_pixel(format: cv::PixelFormat) -> avformat::Pixel {
    match format {
        cv::PixelFormat::_420V => avformat::Pixel::NV12,
        cv::PixelFormat::_32_RGBA => avformat::Pixel::RGBA,
        cv::PixelFormat::_32_BGRA => avformat::Pixel::BGRA,
        _ => avformat::Pixel::RGBA,
    }
}
