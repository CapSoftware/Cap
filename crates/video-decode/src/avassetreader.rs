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
    pixel_format: Option<cv::PixelFormat>,
    width: u32,
    height: u32,
}

fn ticks_to_secs(ticks: i64, time_base: ffmpeg::Rational) -> f64 {
    ticks as f64 * time_base.numerator() as f64 / time_base.denominator() as f64
}

// MP4/MOV demuxers load every sample's flags from the sample table when the
// file is opened, so keyframes are known without reading any media. The table
// stores decode timestamps, which only match presentation timestamps when the
// stream has no reordering delay, and fragmented files only index the
// fragments read so far; either case falls back to scanning packets.
fn container_keyframes(
    stream: &avformat::stream::Stream,
    fps: f64,
    duration_secs: f64,
) -> Option<Vec<(u32, f64)>> {
    let time_base = stream.time_base();
    let raw = unsafe { stream.as_ptr() };
    if unsafe { (*(*raw).codecpar).video_delay } > 0 {
        return None;
    }
    let count = unsafe { ffmpeg::ffi::avformat_index_get_entries_count(raw) };
    if count <= 0 {
        return None;
    }

    let mut keyframes = Vec::new();
    let mut last_secs = f64::MIN;
    for index in 0..count {
        let entry =
            unsafe { ffmpeg::ffi::avformat_index_get_entry(raw.cast_mut(), index).as_ref() }?;
        let secs = ticks_to_secs(entry.timestamp, time_base);
        last_secs = last_secs.max(secs);
        let flags = entry.flags();
        if flags & ffmpeg::ffi::AVINDEX_KEYFRAME != 0 {
            keyframes.push(((secs * fps).round() as u32, secs));
        }
    }

    let covers_stream =
        duration_secs > 0.0 && last_secs >= duration_secs - INDEX_COVERAGE_SLACK_SECS;
    (covers_stream && !keyframes.is_empty()).then_some(keyframes)
}

const INDEX_COVERAGE_SLACK_SECS: f64 = 1.0;

const MAX_MOOV_BYTES: u64 = 64 * 1024 * 1024;

fn box_header(data: &[u8]) -> Option<([u8; 4], usize, usize)> {
    let size = u32::from_be_bytes(data.get(0..4)?.try_into().ok()?) as u64;
    let kind: [u8; 4] = data.get(4..8)?.try_into().ok()?;
    let (size, header) = match size {
        0 => (data.len() as u64, 8),
        1 => (u64::from_be_bytes(data.get(8..16)?.try_into().ok()?), 16),
        size => (size, 8),
    };
    let size = usize::try_from(size).ok()?;
    (size >= header && size <= data.len()).then_some((kind, header, size))
}

fn child_boxes(mut data: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    std::iter::from_fn(move || {
        let (kind, header, size) = box_header(data)?;
        let payload = &data[header..size];
        data = &data[size..];
        Some((kind, payload))
    })
}

fn child_box<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    child_boxes(data)
        .find(|(child, _)| child == kind)
        .map(|(_, payload)| payload)
}

fn read_be_u32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

fn read_moov(path: &Path) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    let mut offset = 0u64;
    let mut moov = None;
    while offset + 8 <= file_len {
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut header = [0u8; 16];
        let available = (file_len - offset).min(16) as usize;
        file.read_exact(&mut header[..available]).ok()?;
        let kind: [u8; 4] = header[4..8].try_into().ok()?;
        let (size, header_len) = match u32::from_be_bytes(header[0..4].try_into().ok()?) {
            0 => (file_len - offset, 8),
            1 if available == 16 => (u64::from_be_bytes(header[8..16].try_into().ok()?), 16),
            1 => return None,
            size => (u64::from(size), 8),
        };
        if size < header_len || offset + size > file_len {
            return None;
        }
        match &kind {
            b"moof" => return None,
            b"moov" if moov.is_none() && size <= MAX_MOOV_BYTES => {
                let mut data = vec![0u8; size as usize];
                file.seek(SeekFrom::Start(offset)).ok()?;
                file.read_exact(&mut data).ok()?;
                moov = Some(data);
            }
            b"moov" => return None,
            _ => {}
        }
        offset += size;
    }
    moov
}

// The sample table stores decode times, so it only matches presentation times
// when every composition offset in the track is zero: the track has no `ctts`
// box, or all of its entries are zero. Fragmented files keep offsets per
// fragment instead and are never eligible.
fn track_has_no_composition_offsets(path: &Path, track_id: i32) -> bool {
    let check = || -> Option<bool> {
        let moov_box = read_moov(path)?;
        let (_, header, size) = box_header(&moov_box)?;
        let moov = &moov_box[header..size];
        if child_box(moov, b"mvex").is_some() {
            return None;
        }
        let track = child_boxes(moov)
            .filter(|(kind, _)| kind == b"trak")
            .map(|(_, trak)| trak)
            .find(|trak| {
                child_box(trak, b"tkhd").and_then(|tkhd| {
                    let id_at = if tkhd.first() == Some(&1) { 20 } else { 12 };
                    read_be_u32(tkhd, id_at)
                }) == Some(track_id as u32)
            })?;
        let stbl = child_box(child_box(child_box(track, b"mdia")?, b"minf")?, b"stbl")?;
        let Some(ctts) = child_box(stbl, b"ctts") else {
            return Some(true);
        };
        let entries = read_be_u32(ctts, 4)? as usize;
        (0..entries)
            .map(|entry| read_be_u32(ctts, 8 + entry * 8 + 4))
            .try_fold(true, |all_zero, offset| Some(all_zero && offset? == 0))
    };
    check().unwrap_or(false)
}

fn is_mp4_family(input: &avformat::context::Input) -> bool {
    input
        .format()
        .name()
        .split(',')
        .any(|name| name == "mov" || name == "mp4")
}

fn scan_keyframes(
    input: &mut avformat::context::Input,
    stream_index: usize,
    time_base: ffmpeg::Rational,
    fps: f64,
) -> Vec<(u32, f64)> {
    let mut keyframes = Vec::new();
    for (stream, packet) in input.packets() {
        if stream.index() != stream_index || !packet.is_key() {
            continue;
        }
        let time_secs = ticks_to_secs(packet.pts().unwrap_or(0), time_base);
        keyframes.push(((time_secs * fps).round() as u32, time_secs));
    }
    keyframes
}

impl KeyframeIndex {
    pub fn build(path: &Path) -> Result<Self, String> {
        let build_start = std::time::Instant::now();

        let mut input = avformat::input(path)
            .map_err(|e| format!("Failed to open video for keyframe scan: {e}"))?;

        let (stream_index, time_base, fps, duration_secs, pixel_format, width, height, indexed) = {
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

            let decoder = avcodec::Context::from_parameters(video_stream.parameters())
                .map_err(|e| format!("decoder context / {e}"))?
                .decoder()
                .video()
                .map_err(|e| format!("video decoder / {e}"))?;

            let pixel_format = pixel_to_pixel_format(decoder.format()).ok();
            let width = decoder.width();
            let height = decoder.height();
            let indexed = container_keyframes(&video_stream, fps, duration_secs).filter(|_| {
                is_mp4_family(&input) && track_has_no_composition_offsets(path, video_stream.id())
            });

            (
                stream_index,
                time_base,
                fps,
                duration_secs,
                pixel_format,
                width,
                height,
                indexed,
            )
        };

        let from_container = indexed.is_some();
        let keyframes = match indexed {
            Some(keyframes) => keyframes,
            None => scan_keyframes(&mut input, stream_index, time_base, fps),
        };

        let elapsed = build_start.elapsed();
        tracing::info!(
            path = %path.display(),
            keyframe_count = keyframes.len(),
            fps = fps,
            duration_secs = duration_secs,
            from_container,
            build_ms = elapsed.as_millis(),
            "Built keyframe index"
        );

        Ok(Self {
            keyframes,
            fps,
            duration_secs,
            pixel_format,
            width,
            height,
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

    pub fn cached_video_info(&self) -> Option<(cv::PixelFormat, u32, u32)> {
        self.pixel_format.map(|pf| (pf, self.width, self.height))
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
        let (pixel_format, width, height) = if let Some(info) = keyframe_index
            .as_ref()
            .and_then(|ki| ki.cached_video_info())
        {
            info
        } else {
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

impl Drop for AVAssetReaderDecoder {
    fn drop(&mut self) {
        self.reader.cancel_reading();
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    type Keyframes = Vec<(u32, f64)>;

    fn both_indexes(path: &Path) -> Option<(Option<Keyframes>, Keyframes)> {
        ffmpeg::init().unwrap();
        let mut input = avformat::input(path).ok()?;
        let (stream_index, time_base, fps, indexed) = {
            let stream = input.streams().best(ffmpeg::media::Type::Video)?;
            let rate = stream.avg_frame_rate();
            let fps = f64::from(rate.numerator()) / f64::from(rate.denominator().max(1));
            let duration_secs = ticks_to_secs(stream.duration(), stream.time_base());
            let indexed = container_keyframes(&stream, fps, duration_secs).filter(|_| {
                is_mp4_family(&input) && track_has_no_composition_offsets(path, stream.id())
            });
            (stream.index(), stream.time_base(), fps, indexed)
        };
        let scanned = scan_keyframes(&mut input, stream_index, time_base, fps);
        Some((indexed, scanned))
    }

    #[test]
    fn streams_without_reordering_read_keyframes_from_the_sample_table() {
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/h264-no-reordering.mp4");
        let (indexed, scanned) = both_indexes(&fixture).unwrap();
        let indexed = indexed.expect("a stream without reordering should use the sample table");
        assert_eq!(indexed, scanned);
        assert_eq!(
            indexed,
            vec![
                (0, 0.0),
                (15, 0.5),
                (30, 1.0),
                (45, 1.5),
                (60, 2.0),
                (75, 2.5)
            ]
        );
    }

    #[test]
    fn composition_offsets_later_in_the_track_fall_back_to_a_packet_scan() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/h264-varying-composition-offset.mp4");
        let (indexed, scanned) = both_indexes(&fixture).unwrap();
        assert!(indexed.is_none());
        let times: Vec<f64> = scanned.iter().map(|(_, secs)| *secs).collect();
        let expected = [0.0, 0.5, 1.5, 2.0, 2.483_333, 2.733_333];
        assert_eq!(times.len(), expected.len());
        for (time, expected) in times.iter().zip(expected) {
            assert!((time - expected).abs() < 1e-3, "{times:?}");
        }
    }

    #[test]
    fn streams_with_reordering_fall_back_to_a_packet_scan() {
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/h264-decoder-lifecycle.mp4");
        let (indexed, scanned) = both_indexes(&fixture).unwrap();
        assert!(!scanned.is_empty());
        assert!(indexed.is_none());
    }

    #[test]
    #[ignore = "compares real recordings listed in CAP_KEYFRAME_INDEX_FILES (colon separated)"]
    fn container_index_matches_real_recordings() {
        let Ok(files) = std::env::var("CAP_KEYFRAME_INDEX_FILES") else {
            return;
        };
        let mut mismatches = Vec::new();
        for file in files.split(':').filter(|file| !file.is_empty()) {
            let Some((indexed, scanned)) = both_indexes(Path::new(file)) else {
                println!("{file}: unreadable");
                continue;
            };
            let outcome = match &indexed {
                None => "scan",
                Some(indexed) if *indexed == scanned => "identical",
                Some(indexed) if indexed.iter().all(|keyframe| scanned.contains(keyframe)) => {
                    "subset"
                }
                Some(_) => {
                    mismatches.push(file.to_string());
                    "mismatch"
                }
            };
            println!(
                "{file}: outcome={outcome} container={:?} scan={}",
                indexed.as_ref().map(Vec::len),
                scanned.len()
            );
        }
        assert!(
            mismatches.is_empty(),
            "index differs from scan: {mismatches:#?}"
        );
    }
}
