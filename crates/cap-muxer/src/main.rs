use anyhow::{Context, Result, anyhow};
use cap_muxer_protocol::{
    Frame, InitAudio, InitVideo, PACKET_FLAG_KEYFRAME, Packet, ProtocolError, STREAM_INDEX_AUDIO,
    STREAM_INDEX_VIDEO, StartParams, read_frame,
};
use ffmpeg::{codec, format};
use std::collections::VecDeque;
use std::ffi::CString;
use std::io::{self, BufReader, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Condvar, Mutex};

const EXIT_OK: u8 = 0;
const EXIT_PROTOCOL_ERROR: u8 = 10;
const EXIT_FFMPEG_ERROR: u8 = 20;
const EXIT_INIT_ERROR: u8 = 30;
const EXIT_ABORT: u8 = 40;
const EXIT_BAD_STATE: u8 = 50;
pub const EXIT_DISK_FULL: u8 = 60;

fn main() -> ExitCode {
    init_tracing();

    match run() {
        Ok(()) => ExitCode::from(EXIT_OK),
        Err(MuxerError::Protocol(err)) => {
            eprintln!("cap-muxer protocol error: {err}");
            ExitCode::from(EXIT_PROTOCOL_ERROR)
        }
        Err(MuxerError::DiskFull(err)) => {
            eprintln!("cap-muxer disk full: {err:#}");
            ExitCode::from(EXIT_DISK_FULL)
        }
        Err(MuxerError::FFmpeg(err)) => {
            eprintln!("cap-muxer ffmpeg error: {err:#}");
            ExitCode::from(EXIT_FFMPEG_ERROR)
        }
        Err(MuxerError::Init(err)) => {
            eprintln!("cap-muxer init error: {err:#}");
            ExitCode::from(EXIT_INIT_ERROR)
        }
        Err(MuxerError::Abort(reason)) => {
            eprintln!("cap-muxer parent abort: {reason}");
            ExitCode::from(EXIT_ABORT)
        }
        Err(MuxerError::BadState(reason)) => {
            eprintln!("cap-muxer bad state: {reason}");
            ExitCode::from(EXIT_BAD_STATE)
        }
    }
}

fn init_tracing() {
    let filter = std::env::var("CAP_MUXER_LOG").unwrap_or_else(|_| "info".to_string());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}

#[derive(thiserror::Error, Debug)]
enum MuxerError {
    #[error("{0}")]
    Protocol(#[from] ProtocolError),
    #[error("{0:#}")]
    FFmpeg(anyhow::Error),
    #[error("{0:#}")]
    Init(anyhow::Error),
    #[error("{0}")]
    Abort(String),
    #[error("{0}")]
    BadState(String),
    #[error("{0:#}")]
    DiskFull(anyhow::Error),
}

fn classify_io_error(err: &ffmpeg::Error) -> bool {
    let ffmpeg::Error::Other { errno } = err else {
        return false;
    };
    if *errno == libc::ENOSPC {
        return true;
    }
    #[cfg(windows)]
    if *errno == 112 {
        return true;
    }
    false
}

const DEFAULT_FRAME_QUEUE_BYTES: usize = 64 * 1024 * 1024;

fn resolve_queue_capacity() -> usize {
    std::env::var("CAP_MUXER_IO_BUF_MB")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&mb| mb > 0 && mb <= 1024)
        .map(|mb| mb * 1024 * 1024)
        .unwrap_or(DEFAULT_FRAME_QUEUE_BYTES)
}

struct FrameQueueInner {
    frames: VecDeque<Frame>,
    bytes: usize,
    reader_done: bool,
    reader_err: Option<ProtocolError>,
    capacity_bytes: usize,
}

struct FrameQueue {
    state: Mutex<FrameQueueInner>,
    data_cv: Condvar,
    space_cv: Condvar,
}

impl FrameQueue {
    fn new(capacity_bytes: usize) -> Self {
        Self {
            state: Mutex::new(FrameQueueInner {
                frames: VecDeque::with_capacity(256),
                bytes: 0,
                reader_done: false,
                reader_err: None,
                capacity_bytes,
            }),
            data_cv: Condvar::new(),
            space_cv: Condvar::new(),
        }
    }

    fn push(&self, frame: Frame) {
        let frame_bytes = frame_size_hint(&frame);
        let mut guard = self.state.lock().expect("cap-muxer frame queue poisoned");
        while guard.bytes + frame_bytes > guard.capacity_bytes && !guard.frames.is_empty() {
            guard = self
                .space_cv
                .wait(guard)
                .expect("cap-muxer frame queue poisoned");
        }
        guard.bytes = guard.bytes.saturating_add(frame_bytes);
        guard.frames.push_back(frame);
        drop(guard);
        self.data_cv.notify_one();
    }

    fn mark_reader_done(&self, err: Option<ProtocolError>) {
        let mut guard = self.state.lock().expect("cap-muxer frame queue poisoned");
        guard.reader_done = true;
        if err.is_some() {
            guard.reader_err = err;
        }
        drop(guard);
        self.data_cv.notify_all();
        self.space_cv.notify_all();
    }

    fn pop(&self) -> PopResult {
        let mut guard = self.state.lock().expect("cap-muxer frame queue poisoned");
        loop {
            if let Some(frame) = guard.frames.pop_front() {
                let size = frame_size_hint(&frame);
                guard.bytes = guard.bytes.saturating_sub(size);
                drop(guard);
                self.space_cv.notify_one();
                return PopResult::Frame(frame);
            }
            if guard.reader_done {
                let err = guard.reader_err.take();
                return match err {
                    Some(err) => PopResult::Error(err),
                    None => PopResult::Drained,
                };
            }
            guard = self
                .data_cv
                .wait(guard)
                .expect("cap-muxer frame queue poisoned");
        }
    }
}

enum PopResult {
    Frame(Frame),
    Drained,
    Error(ProtocolError),
}

fn frame_size_hint(frame: &Frame) -> usize {
    const HEADER_OVERHEAD: usize = 64;
    match frame {
        Frame::InitVideo(v) => HEADER_OVERHEAD + v.extradata.len() + v.codec.len(),
        Frame::InitAudio(a) => HEADER_OVERHEAD + a.extradata.len() + a.codec.len(),
        Frame::Start(p) => {
            HEADER_OVERHEAD
                + p.output_directory.len()
                + p.init_segment_name.len()
                + p.media_segment_pattern.len()
        }
        Frame::Packet(p) => HEADER_OVERHEAD + p.data.len(),
        Frame::Finish => HEADER_OVERHEAD,
        Frame::Abort(reason) => HEADER_OVERHEAD + reason.len(),
    }
}

fn run() -> Result<(), MuxerError> {
    ffmpeg::init().map_err(|e| MuxerError::Init(anyhow::Error::from(e)))?;

    let capacity_bytes = resolve_queue_capacity();
    let queue = Arc::new(FrameQueue::new(capacity_bytes));
    tracing::info!(
        capacity_mb = capacity_bytes / 1024 / 1024,
        "cap-muxer async frame queue initialized"
    );

    let reader_handle = {
        let queue = Arc::clone(&queue);
        std::thread::Builder::new()
            .name("cap-muxer-stdin-reader".to_string())
            .spawn(move || {
                let stdin = io::stdin();
                let mut reader = BufReader::with_capacity(1024 * 1024, stdin.lock());
                loop {
                    match read_frame(&mut reader) {
                        Ok(frame) => queue.push(frame),
                        Err(ProtocolError::Io(ref ioe))
                            if ioe.kind() == io::ErrorKind::UnexpectedEof =>
                        {
                            queue.mark_reader_done(None);
                            return;
                        }
                        Err(e) => {
                            queue.mark_reader_done(Some(e));
                            return;
                        }
                    }
                }
            })
            .map_err(|e| MuxerError::Init(anyhow!("spawn stdin reader thread: {e}")))?
    };

    let mut state = State::default();
    let mut result = Ok(());

    loop {
        match queue.pop() {
            PopResult::Frame(frame) => match handle_frame(&mut state, frame) {
                Ok(Control::Continue) => {}
                Ok(Control::Finish) => {
                    break;
                }
                Err(e) => {
                    result = Err(e);
                    break;
                }
            },
            PopResult::Drained => {
                tracing::warn!("cap-muxer stdin closed without Finish; attempting graceful finish");
                break;
            }
            PopResult::Error(e) => {
                result = Err(MuxerError::Protocol(e));
                break;
            }
        }
    }

    let finish_result = state.finish();

    let _ = reader_handle.join();

    result?;
    finish_result?;

    writeln!(io::stderr(), "cap-muxer finished cleanly").ok();
    Ok(())
}

enum Control {
    Continue,
    Finish,
}

#[derive(Default)]
struct State {
    init_video: Option<InitVideo>,
    init_audio: Option<InitAudio>,
    started: bool,
    output: Option<OpenOutput>,
}

struct OpenOutput {
    ctx: format::context::Output,
    video_stream_index: Option<usize>,
    audio_stream_index: Option<usize>,
    video_time_base: Option<ffmpeg::Rational>,
    audio_time_base: Option<ffmpeg::Rational>,
    packets_written_video: u64,
    packets_written_audio: u64,
    video_keyframe_seen: bool,
    video_packets_dropped_pre_keyframe: u64,
    audio_packets_dropped_pre_video: u64,
    pending_video_packet: Option<Packet>,
    pending_audio_packet: Option<Packet>,
    last_video_duration_input_tb: Option<i64>,
    last_audio_duration_input_tb: Option<i64>,
    start_ts: Option<std::time::Instant>,
    _base_path: PathBuf,
}

impl State {
    fn finish(&mut self) -> Result<(), MuxerError> {
        if let Some(out) = self.output.as_mut() {
            flush_pending_packets(out, self.init_video.as_ref(), self.init_audio.as_ref())?;
        }
        if let Some(mut out) = self.output.take() {
            out.ctx.write_trailer().map_err(|e| {
                let err = anyhow!("write_trailer: {e}");
                if classify_io_error(&e) {
                    MuxerError::DiskFull(err)
                } else {
                    MuxerError::FFmpeg(err)
                }
            })?;
            let elapsed = out
                .start_ts
                .map(|t| t.elapsed().as_secs_f64())
                .unwrap_or(0.0);
            writeln!(
                io::stderr(),
                "cap-muxer trailer written; video_packets={} audio_packets={} duration_secs={:.2}",
                out.packets_written_video,
                out.packets_written_audio,
                elapsed
            )
            .ok();
        }
        Ok(())
    }
}

fn handle_frame(state: &mut State, frame: Frame) -> Result<Control, MuxerError> {
    match frame {
        Frame::InitVideo(init) => {
            if state.started {
                return Err(MuxerError::BadState("init_video after start".to_string()));
            }
            state.init_video = Some(init);
            Ok(Control::Continue)
        }
        Frame::InitAudio(init) => {
            if state.started {
                return Err(MuxerError::BadState("init_audio after start".to_string()));
            }
            state.init_audio = Some(init);
            Ok(Control::Continue)
        }
        Frame::Start(params) => {
            if state.started {
                return Err(MuxerError::BadState("duplicate start".to_string()));
            }
            let output = open_output(state, &params)?;
            state.output = Some(output);
            state.started = true;
            Ok(Control::Continue)
        }
        Frame::Packet(packet) => {
            if !state.started {
                return Err(MuxerError::BadState("packet before start".to_string()));
            }
            write_packet(state, packet)?;
            Ok(Control::Continue)
        }
        Frame::Finish => Ok(Control::Finish),
        Frame::Abort(reason) => Err(MuxerError::Abort(reason)),
    }
}

fn open_output(state: &mut State, params: &StartParams) -> Result<OpenOutput, MuxerError> {
    let base_path = PathBuf::from(&params.output_directory);
    std::fs::create_dir_all(&base_path)
        .with_context(|| format!("create_dir_all({})", base_path.display()))
        .map_err(MuxerError::Init)?;

    let manifest_path = base_path.join("dash_manifest.mpd");

    #[cfg(target_os = "windows")]
    let manifest_path_str = manifest_path.to_string_lossy().replace('\\', "/");
    #[cfg(not(target_os = "windows"))]
    let manifest_path_str = manifest_path.to_string_lossy().to_string();

    let mut output = format::output_as(&manifest_path_str, "dash")
        .map_err(|e| MuxerError::FFmpeg(anyhow!("format::output_as: {e}")))?;

    unsafe {
        let opts = output.as_mut_ptr();
        let set_opt = |key: &str, value: &str| {
            let k = CString::new(key).unwrap();
            let v = CString::new(value).unwrap();
            ffmpeg::ffi::av_opt_set((*opts).priv_data, k.as_ptr(), v.as_ptr(), 0);
        };
        set_opt("init_seg_name", &params.init_segment_name);
        set_opt("media_seg_name", &params.media_segment_pattern);
        let segment_duration_secs = state
            .init_video
            .as_ref()
            .map(|v| v.segment_duration_ms as f64 / 1000.0)
            .unwrap_or(2.0);
        set_opt("seg_duration", &segment_duration_secs.to_string());
        set_opt("use_timeline", "1");
        set_opt("use_template", "1");
        set_opt("single_file", "0");
        set_opt("hls_playlist", "1");
        set_opt(
            "format_options",
            "movflags=+negative_cts_offsets+skip_trailer",
        );
    }

    let mut video_stream_index = None;
    let mut audio_stream_index = None;
    let mut video_time_base = None;
    let mut audio_time_base = None;

    if let Some(init) = &state.init_video {
        let codec = codec::encoder::find_by_name(&init.codec)
            .ok_or_else(|| MuxerError::Init(anyhow!("video codec not found: {}", init.codec)))?;

        let mut stream = output
            .add_stream(codec)
            .map_err(|e| MuxerError::FFmpeg(anyhow!("add_stream video: {e}")))?;

        unsafe {
            let st = stream.as_mut_ptr();
            let cp = (*st).codecpar;
            (*cp).codec_type = ffmpeg::ffi::AVMediaType::AVMEDIA_TYPE_VIDEO;
            (*cp).codec_id = codec.id().into();
            (*cp).width = init.width as i32;
            (*cp).height = init.height as i32;
            (*cp).format = ffmpeg::ffi::AVPixelFormat::AV_PIX_FMT_YUV420P as i32;
            (*cp).bit_rate = 0;

            if !init.extradata.is_empty() {
                let size = init.extradata.len() as i32;
                let ptr = ffmpeg::ffi::av_mallocz(
                    size as usize + ffmpeg::ffi::AV_INPUT_BUFFER_PADDING_SIZE as usize,
                ) as *mut u8;
                if ptr.is_null() {
                    return Err(MuxerError::Init(anyhow!(
                        "failed to allocate extradata buffer"
                    )));
                }
                std::ptr::copy_nonoverlapping(init.extradata.as_ptr(), ptr, init.extradata.len());
                (*cp).extradata = ptr;
                (*cp).extradata_size = size;
            }
        }

        let tb = ffmpeg::Rational::new(init.time_base_num, init.time_base_den);
        stream.set_time_base(tb);
        video_stream_index = Some(stream.index());
        video_time_base = Some(tb);
    }

    if let Some(init) = &state.init_audio {
        let codec = codec::encoder::find_by_name(&init.codec)
            .ok_or_else(|| MuxerError::Init(anyhow!("audio codec not found: {}", init.codec)))?;

        let mut stream = output
            .add_stream(codec)
            .map_err(|e| MuxerError::FFmpeg(anyhow!("add_stream audio: {e}")))?;

        unsafe {
            let st = stream.as_mut_ptr();
            let cp = (*st).codecpar;
            (*cp).codec_type = ffmpeg::ffi::AVMediaType::AVMEDIA_TYPE_AUDIO;
            (*cp).codec_id = codec.id().into();
            (*cp).sample_rate = init.sample_rate as i32;
            (*cp).ch_layout.nb_channels = init.channels as i32;
            (*cp).ch_layout.order = ffmpeg::ffi::AVChannelOrder::AV_CHANNEL_ORDER_NATIVE;
            (*cp).ch_layout.u.mask = match init.channels {
                1 => ffmpeg::ffi::AV_CH_LAYOUT_MONO,
                2 => ffmpeg::ffi::AV_CH_LAYOUT_STEREO,
                _ => ffmpeg::ffi::AV_CH_LAYOUT_STEREO,
            };

            if !init.extradata.is_empty() {
                let size = init.extradata.len() as i32;
                let ptr = ffmpeg::ffi::av_mallocz(
                    size as usize + ffmpeg::ffi::AV_INPUT_BUFFER_PADDING_SIZE as usize,
                ) as *mut u8;
                if ptr.is_null() {
                    return Err(MuxerError::Init(anyhow!(
                        "failed to allocate audio extradata buffer"
                    )));
                }
                std::ptr::copy_nonoverlapping(init.extradata.as_ptr(), ptr, init.extradata.len());
                (*cp).extradata = ptr;
                (*cp).extradata_size = size;
            }
        }

        let tb = ffmpeg::Rational::new(init.time_base_num, init.time_base_den);
        stream.set_time_base(tb);
        audio_stream_index = Some(stream.index());
        audio_time_base = Some(tb);
    }

    output.write_header().map_err(|e| {
        let err = anyhow!("write_header: {e}");
        if classify_io_error(&e) {
            MuxerError::DiskFull(err)
        } else {
            MuxerError::FFmpeg(err)
        }
    })?;

    Ok(OpenOutput {
        ctx: output,
        video_stream_index,
        audio_stream_index,
        video_time_base,
        audio_time_base,
        packets_written_video: 0,
        packets_written_audio: 0,
        video_keyframe_seen: video_stream_index.is_none(),
        video_packets_dropped_pre_keyframe: 0,
        audio_packets_dropped_pre_video: 0,
        pending_video_packet: None,
        pending_audio_packet: None,
        last_video_duration_input_tb: None,
        last_audio_duration_input_tb: None,
        start_ts: Some(std::time::Instant::now()),
        _base_path: base_path,
    })
}

fn write_packet(state: &mut State, packet: Packet) -> Result<(), MuxerError> {
    let Some(out) = state.output.as_mut() else {
        return Err(MuxerError::BadState("no output".to_string()));
    };

    if packet.stream_index == STREAM_INDEX_VIDEO {
        let is_keyframe = packet.flags & PACKET_FLAG_KEYFRAME != 0;
        if !out.video_keyframe_seen {
            if !is_keyframe {
                out.video_packets_dropped_pre_keyframe += 1;
                if out.video_packets_dropped_pre_keyframe == 1
                    || out.video_packets_dropped_pre_keyframe.is_multiple_of(30)
                {
                    tracing::warn!(
                        dropped = out.video_packets_dropped_pre_keyframe,
                        "cap-muxer discarding non-keyframe video packets before first keyframe"
                    );
                }
                return Ok(());
            }
            out.video_keyframe_seen = true;
            if out.video_packets_dropped_pre_keyframe > 0 {
                tracing::info!(
                    dropped = out.video_packets_dropped_pre_keyframe,
                    "cap-muxer first video keyframe received"
                );
            }
        }
    } else if packet.stream_index == STREAM_INDEX_AUDIO
        && out.video_stream_index.is_some()
        && !out.video_keyframe_seen
    {
        out.audio_packets_dropped_pre_video += 1;
        if out.audio_packets_dropped_pre_video == 1
            || out.audio_packets_dropped_pre_video.is_multiple_of(100)
        {
            tracing::debug!(
                dropped = out.audio_packets_dropped_pre_video,
                "cap-muxer holding audio until first video keyframe"
            );
        }
        return Ok(());
    }

    let ready_packet = match packet.stream_index {
        STREAM_INDEX_VIDEO => queue_packet_for_stream(
            &mut out.pending_video_packet,
            &mut out.last_video_duration_input_tb,
            packet,
        ),
        STREAM_INDEX_AUDIO => queue_packet_for_stream(
            &mut out.pending_audio_packet,
            &mut out.last_audio_duration_input_tb,
            packet,
        ),
        other => {
            return Err(MuxerError::BadState(format!(
                "unknown stream index {other}"
            )));
        }
    };

    if let Some((ready_packet, duration_input_tb)) = ready_packet {
        write_ready_packet(out, ready_packet, duration_input_tb)?;
    }

    Ok(())
}

fn queue_packet_for_stream(
    pending: &mut Option<Packet>,
    last_duration_input_tb: &mut Option<i64>,
    packet: Packet,
) -> Option<(Packet, i64)> {
    let derived_duration = pending.as_ref().map(|previous| {
        derive_duration_from_adjacent_dts(previous, &packet, *last_duration_input_tb)
    });

    let previous = pending.replace(packet);

    match (previous, derived_duration) {
        (Some(previous), Some(duration)) => {
            if duration > 0 {
                *last_duration_input_tb = Some(duration);
            }
            Some((previous, duration))
        }
        _ => None,
    }
}

fn derive_duration_from_adjacent_dts(
    current: &Packet,
    next: &Packet,
    last_duration_input_tb: Option<i64>,
) -> i64 {
    let dts_delta = next.dts.saturating_sub(current.dts);
    if dts_delta > 0 {
        return dts_delta;
    }

    resolve_packet_duration(current.duration, last_duration_input_tb, None)
}

fn resolve_packet_duration(
    packet_duration: u64,
    last_duration_input_tb: Option<i64>,
    fallback_duration_input_tb: Option<i64>,
) -> i64 {
    i64::try_from(packet_duration)
        .ok()
        .filter(|duration| *duration > 0)
        .or(last_duration_input_tb.filter(|duration| *duration > 0))
        .or(fallback_duration_input_tb.filter(|duration| *duration > 0))
        .unwrap_or(1)
}

fn flush_pending_packets(
    out: &mut OpenOutput,
    video_init: Option<&InitVideo>,
    audio_init: Option<&InitAudio>,
) -> Result<(), MuxerError> {
    let pending_video = out.pending_video_packet.take().map(|packet| {
        let fallback_duration = video_init.and_then(nominal_video_duration_input_tb);
        let duration = resolve_packet_duration(
            packet.duration,
            out.last_video_duration_input_tb,
            fallback_duration,
        );
        if duration > 0 {
            out.last_video_duration_input_tb = Some(duration);
        }
        (packet, duration)
    });

    let pending_audio = out.pending_audio_packet.take().map(|packet| {
        let fallback_duration = audio_init.and_then(nominal_audio_duration_input_tb);
        let duration = resolve_packet_duration(
            packet.duration,
            out.last_audio_duration_input_tb,
            fallback_duration,
        );
        if duration > 0 {
            out.last_audio_duration_input_tb = Some(duration);
        }
        (packet, duration)
    });

    if let Some((packet, duration)) = pending_video {
        write_ready_packet(out, packet, duration)?;
    }

    if let Some((packet, duration)) = pending_audio {
        write_ready_packet(out, packet, duration)?;
    }

    Ok(())
}

fn nominal_video_duration_input_tb(init: &InitVideo) -> Option<i64> {
    if init.frame_rate_num <= 0
        || init.frame_rate_den <= 0
        || init.time_base_num <= 0
        || init.time_base_den <= 0
    {
        return None;
    }

    let numerator = i128::from(init.time_base_den) * i128::from(init.frame_rate_den);
    let denominator = i128::from(init.time_base_num) * i128::from(init.frame_rate_num);
    if denominator <= 0 {
        return None;
    }

    let duration = (numerator + denominator / 2) / denominator;
    i64::try_from(duration)
        .ok()
        .filter(|duration| *duration > 0)
}

fn nominal_audio_duration_input_tb(init: &InitAudio) -> Option<i64> {
    if init.time_base_num <= 0 || init.time_base_den <= 0 {
        return None;
    }

    let sample_rate = i64::from(init.sample_rate);
    if sample_rate <= 0 {
        return None;
    }

    let numerator = i128::from(1024i64) * i128::from(init.time_base_den);
    let denominator = i128::from(sample_rate) * i128::from(init.time_base_num);
    if denominator <= 0 {
        return None;
    }

    let duration = (numerator + denominator / 2) / denominator;
    i64::try_from(duration)
        .ok()
        .filter(|duration| *duration > 0)
}

fn write_ready_packet(
    out: &mut OpenOutput,
    packet: Packet,
    duration_input_tb: i64,
) -> Result<(), MuxerError> {
    let (stream_index, time_base) = match packet.stream_index {
        STREAM_INDEX_VIDEO => (
            out.video_stream_index
                .ok_or_else(|| MuxerError::BadState("video not initialized".to_string()))?,
            out.video_time_base
                .ok_or_else(|| MuxerError::BadState("no video time base".to_string()))?,
        ),
        STREAM_INDEX_AUDIO => (
            out.audio_stream_index
                .ok_or_else(|| MuxerError::BadState("audio not initialized".to_string()))?,
            out.audio_time_base
                .ok_or_else(|| MuxerError::BadState("no audio time base".to_string()))?,
        ),
        other => {
            return Err(MuxerError::BadState(format!(
                "unknown stream index {other}"
            )));
        }
    };

    let mut ff_packet = ffmpeg::Packet::copy(&packet.data);
    ff_packet.set_stream(stream_index);
    ff_packet.set_pts(Some(packet.pts));
    ff_packet.set_dts(Some(packet.dts));
    ff_packet.set_duration(duration_input_tb.max(0));
    if packet.flags & PACKET_FLAG_KEYFRAME != 0 {
        ff_packet.set_flags(ffmpeg::packet::Flags::KEY);
    }

    let stream_tb = out.ctx.stream(stream_index).unwrap().time_base();
    ff_packet.rescale_ts(time_base, stream_tb);

    ff_packet.write_interleaved(&mut out.ctx).map_err(|e| {
        let err = anyhow!("write_interleaved: {e}");
        if classify_io_error(&e) {
            MuxerError::DiskFull(err)
        } else {
            MuxerError::FFmpeg(err)
        }
    })?;

    match packet.stream_index {
        STREAM_INDEX_VIDEO => out.packets_written_video += 1,
        STREAM_INDEX_AUDIO => out.packets_written_audio += 1,
        _ => {}
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(stream_index: u8, pts: i64, dts: i64, duration: u64) -> Packet {
        Packet {
            stream_index,
            pts,
            dts,
            duration,
            flags: 0,
            data: Vec::new(),
        }
    }

    #[test]
    fn derives_duration_from_next_packet_dts() {
        let current = packet(STREAM_INDEX_VIDEO, 100, 90, 0);
        let next = packet(STREAM_INDEX_VIDEO, 133, 123, 0);

        assert_eq!(derive_duration_from_adjacent_dts(&current, &next, None), 33);
    }

    #[test]
    fn falls_back_to_packet_duration_when_dts_does_not_advance() {
        let current = packet(STREAM_INDEX_VIDEO, 100, 90, 41);
        let next = packet(STREAM_INDEX_VIDEO, 133, 90, 0);

        assert_eq!(
            derive_duration_from_adjacent_dts(&current, &next, Some(33)),
            41
        );
    }

    #[test]
    fn falls_back_to_last_duration_when_packet_duration_is_zero() {
        assert_eq!(resolve_packet_duration(0, Some(33), Some(41)), 33);
    }

    #[test]
    fn computes_nominal_video_duration_from_time_base_and_frame_rate() {
        let init = InitVideo {
            codec: "h264".to_string(),
            width: 1920,
            height: 1080,
            frame_rate_num: 60,
            frame_rate_den: 1,
            time_base_num: 1,
            time_base_den: 1_000_000,
            extradata: Vec::new(),
            segment_duration_ms: 2_000,
        };

        assert_eq!(nominal_video_duration_input_tb(&init), Some(16_667));
    }

    #[test]
    fn computes_nominal_audio_duration_from_aac_frame_size() {
        let init = InitAudio {
            codec: "aac".to_string(),
            sample_rate: 48_000,
            channels: 2,
            sample_format: "fltp".to_string(),
            time_base_num: 1,
            time_base_den: 48_000,
            extradata: Vec::new(),
        };

        assert_eq!(nominal_audio_duration_input_tb(&init), Some(1_024));
    }
}
