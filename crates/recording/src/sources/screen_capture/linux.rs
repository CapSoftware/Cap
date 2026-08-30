use super::cadence::FrameCadenceGate;
use super::*;
use crate::feeds::microphone::{self, MicrophoneFeed, MicrophoneFeedLock};
use crate::ffmpeg::FFmpegVideoFrame;
use crate::output_pipeline::{
    self, AudioFrame, AudioSource, SetupCtx, StallSendOutcome, VideoSource as OutputVideoSource,
    send_with_stall_budget_futures,
};
use anyhow::{Context as _, anyhow, bail};
use ashpd::desktop::{
    PersistMode, Session,
    screencast::{CursorMode, Screencast, SourceType, Stream as PortalStream},
};
use cap_timestamp::Timestamp;
use futures::{Stream, StreamExt, channel::mpsc};
use kameo::{Actor as _, actor::ActorRef};
use pipewire as pw;
use pw::{properties::properties, spa};
use std::{
    os::fd::OwnedFd,
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use x11rb::connection::Connection as _;
use x11rb::protocol::Event;
use x11rb::protocol::composite::{ConnectionExt as _, Redirect};
use x11rb::protocol::xproto::{
    ChangeWindowAttributesAux, ConnectionExt as _, EventMask, ImageFormat, ImageOrder, MapState,
};
use x11rb::rust_connection::RustConnection;

#[derive(Debug)]
pub struct X11Capture;

impl ScreenCaptureFormat for X11Capture {
    type VideoFormat = ffmpeg::frame::Video;

    fn pixel_format() -> ffmpeg::format::Pixel {
        ffmpeg::format::Pixel::BGRZ
    }

    fn audio_info() -> AudioInfo {
        AudioInfo::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
            48_000,
            2,
        )
        .expect("static F32/48kHz/stereo audio config")
    }
}

pub struct VideoSourceConfig {
    video_info: VideoInfo,
    input: LinuxInputConfig,
}

impl VideoSourceConfig {
    pub(crate) fn video_info(&self) -> VideoInfo {
        self.video_info
    }
}

enum LinuxInputConfig {
    X11(X11InputConfig),
    Wayland(WaylandInputConfig),
}

pub(crate) struct X11InputConfig {
    pub display_name: String,
    pub window_id: Option<u32>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub show_cursor: bool,
}

struct WaylandInputConfig {
    fd: OwnedFd,
    node_id: u32,
    fps: u32,
    crop_bounds: Option<CropBounds>,
    portal_session: WaylandPortalSession,
}

struct WaylandPortalSession {
    _proxy: Screencast<'static>,
    _session: Session<'static, Screencast<'static>>,
}

pub struct VideoSource {
    info: VideoInfo,
    stop_token: CancellationToken,
}

impl ScreenCaptureConfig<X11Capture> {
    pub async fn to_sources(
        &self,
    ) -> anyhow::Result<(VideoSourceConfig, Option<SystemAudioSourceConfig>)> {
        let source = if prefers_wayland_portal() {
            let (video_info, input) = create_wayland_source_config(self).await?;
            VideoSourceConfig {
                video_info,
                input: LinuxInputConfig::Wayland(input),
            }
        } else {
            let display = Display::from_id(&self.config.display)
                .ok_or_else(|| anyhow!("Display not found"))?;
            let display_position = display
                .raw_handle()
                .physical_position()
                .ok_or_else(|| anyhow!("Display position unavailable"))?;
            let display_size = display
                .physical_size()
                .ok_or_else(|| anyhow!("Display size unavailable"))?;

            let crop = self.config.crop_bounds.map(|crop| {
                (
                    crop.position().x(),
                    crop.position().y(),
                    crop.size().width(),
                    crop.size().height(),
                )
            });
            let (x, y, width, height) = x11_capture_rect(
                display_position.x(),
                display_position.y(),
                display_size.width(),
                display_size.height(),
                crop,
            )?;
            let video_info =
                if matches!(&self.config.linux_source, LinuxCaptureSource::Window { .. }) {
                    self.video_info
                } else {
                    VideoInfo {
                        width,
                        height,
                        ..self.video_info
                    }
                };

            VideoSourceConfig {
                video_info,
                input: LinuxInputConfig::X11(X11InputConfig {
                    display_name: std::env::var("DISPLAY").unwrap_or_else(|_| ":0".to_string()),
                    window_id: match &self.config.linux_source {
                        LinuxCaptureSource::Window { id } => {
                            Some(id.to_string().parse().context("Invalid X11 window ID")?)
                        }
                        LinuxCaptureSource::Display | LinuxCaptureSource::Area => None,
                    },
                    x,
                    y,
                    width: video_info.width,
                    height: video_info.height,
                    fps: self.config.fps,
                    show_cursor: self.config.show_cursor,
                }),
            }
        };
        let system_audio = if self.system_audio {
            Some(create_system_audio_source_config().await?)
        } else {
            None
        };

        Ok((source, system_audio))
    }
}

pub fn x11_capture_rect(
    display_x: f64,
    display_y: f64,
    display_width: f64,
    display_height: f64,
    crop: Option<(f64, f64, f64, f64)>,
) -> anyhow::Result<(i32, i32, u32, u32)> {
    let display_left = floor_i32(display_x, "display x")?;
    let display_top = floor_i32(display_y, "display y")?;
    let display_right = ceil_i32(display_x + display_width.max(2.0), "display right")?;
    let display_bottom = ceil_i32(display_y + display_height.max(2.0), "display bottom")?;

    if display_right - display_left < 2 || display_bottom - display_top < 2 {
        bail!("X11 display bounds are too small for capture");
    }

    let (raw_left, raw_top, raw_right, raw_bottom) = match crop {
        Some((x, y, width, height)) => (
            floor_i32(display_x + x, "capture x")?,
            floor_i32(display_y + y, "capture y")?,
            ceil_i32(display_x + x + width.max(2.0), "capture right")?,
            ceil_i32(display_y + y + height.max(2.0), "capture bottom")?,
        ),
        None => (display_left, display_top, display_right, display_bottom),
    };

    let left = raw_left.clamp(display_left, display_right - 2);
    let top = raw_top.clamp(display_top, display_bottom - 2);
    let right = raw_right.clamp(left + 2, display_right);
    let bottom = raw_bottom.clamp(top + 2, display_bottom);

    Ok((
        left,
        top,
        ensure_even((right - left) as u32),
        ensure_even((bottom - top) as u32),
    ))
}

fn floor_i32(value: f64, label: &str) -> anyhow::Result<i32> {
    finite_i32(value, label)
        .map(f64::floor)
        .map(|value| value as i32)
}

fn ceil_i32(value: f64, label: &str) -> anyhow::Result<i32> {
    finite_i32(value, label)
        .map(f64::ceil)
        .map(|value| value as i32)
}

fn finite_i32(value: f64, label: &str) -> anyhow::Result<f64> {
    if !value.is_finite() || value < i32::MIN as f64 || value > i32::MAX as f64 {
        bail!("Invalid X11 {label}: {value}");
    }
    Ok(value)
}

impl OutputVideoSource for VideoSource {
    type Config = VideoSourceConfig;
    type Frame = FFmpegVideoFrame;

    async fn setup(
        config: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let stop_token = ctx.stop_token();
        let health_tx = ctx.health_tx().clone();
        let info = config.video_info;
        match config.input {
            LinuxInputConfig::X11(input) => {
                ctx.tasks().spawn_thread("x11-capture-thread", {
                    let stop_token = stop_token.clone();
                    move || capture_x11(info, input, video_tx, stop_token, health_tx)
                });
            }
            LinuxInputConfig::Wayland(input) => {
                ctx.tasks()
                    .spawn_thread("wayland-pipewire-capture-thread", {
                        let stop_token = stop_token.clone();
                        move || capture_wayland(info, input, video_tx, stop_token, health_tx)
                    });
            }
        }

        Ok(Self { info, stop_token })
    }

    fn video_info(&self) -> VideoInfo {
        self.info
    }

    fn stop(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
        self.stop_token.cancel();
        futures::FutureExt::boxed(async { Ok(()) })
    }
}

struct WaylandPortalCapture {
    stream: PortalStream,
    fd: OwnedFd,
    portal_session: WaylandPortalSession,
}

struct PipewireCaptureState {
    format: spa::param::video::VideoInfoRaw,
    scaler: Option<FrameScaler>,
    video_info: VideoInfo,
    crop_bounds: Option<CropBounds>,
    video_tx: mpsc::Sender<FFmpegVideoFrame>,
    health_tx: output_pipeline::HealthSender,
    stop_requested: Arc<AtomicBool>,
    fatal_error: Arc<parking_lot::Mutex<Option<String>>>,
    sent: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    rate_limited: Arc<AtomicU64>,
    capture_clock: Instant,
    cadence_gate: FrameCadenceGate,
}

impl PipewireCaptureState {
    fn set_fatal_error(&self, error: impl Into<String>) {
        let mut fatal_error = self.fatal_error.lock();
        if fatal_error.is_none() {
            *fatal_error = Some(error.into());
        }
    }
}

async fn create_wayland_source_config(
    config: &ScreenCaptureConfig<X11Capture>,
) -> anyhow::Result<(VideoInfo, WaylandInputConfig)> {
    let portal =
        open_wayland_portal(&config.config.linux_source, config.config.show_cursor).await?;
    let crop_bounds = match &config.config.linux_source {
        LinuxCaptureSource::Area => config.config.crop_bounds,
        LinuxCaptureSource::Display | LinuxCaptureSource::Window { .. } => None,
    };
    let video_info = wayland_video_info(&portal.stream, config.video_info, crop_bounds);

    Ok((
        video_info,
        WaylandInputConfig {
            fd: portal.fd,
            node_id: portal.stream.pipe_wire_node_id(),
            fps: config.config.fps,
            crop_bounds,
            portal_session: portal.portal_session,
        },
    ))
}

async fn open_wayland_portal(
    source: &LinuxCaptureSource,
    show_cursor: bool,
) -> anyhow::Result<WaylandPortalCapture> {
    let proxy: Screencast<'static> = Screencast::new()
        .await
        .context("connect to XDG Desktop Portal ScreenCast")?;
    let session = proxy
        .create_session()
        .await
        .context("create XDG Desktop Portal ScreenCast session")?;
    let cursor_mode = if show_cursor {
        CursorMode::Embedded
    } else {
        CursorMode::Hidden
    };

    proxy
        .select_sources(
            &session,
            cursor_mode,
            wayland_source_type(source),
            false,
            None,
            PersistMode::DoNot,
        )
        .await
        .context("select Wayland screen capture source")?;

    let response = proxy
        .start(&session, None)
        .await
        .context("start Wayland screen capture portal request")?
        .response()
        .context("Wayland screen capture portal request was cancelled")?;
    let stream = response
        .streams()
        .first()
        .cloned()
        .ok_or_else(|| anyhow!("Wayland screen capture portal did not return a stream"))?;
    let fd = proxy
        .open_pipe_wire_remote(&session)
        .await
        .context("open PipeWire remote for Wayland screen capture")?;

    Ok(WaylandPortalCapture {
        stream,
        fd,
        portal_session: WaylandPortalSession {
            _proxy: proxy,
            _session: session,
        },
    })
}

pub(crate) fn prefers_wayland_portal() -> bool {
    prefers_wayland_environment(
        std::env::var_os("WAYLAND_DISPLAY").is_some(),
        std::env::var_os("DISPLAY").is_some(),
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
    )
}

fn prefers_wayland_environment(wayland: bool, x11: bool, session: Option<&str>) -> bool {
    wayland && (!x11 || session.is_some_and(|session| session.eq_ignore_ascii_case("wayland")))
}

fn wayland_source_type(source: &LinuxCaptureSource) -> ashpd::enumflags2::BitFlags<SourceType> {
    match source {
        LinuxCaptureSource::Window { .. } => SourceType::Window.into(),
        LinuxCaptureSource::Display | LinuxCaptureSource::Area => SourceType::Monitor.into(),
    }
}

fn wayland_video_info(
    stream: &PortalStream,
    fallback: VideoInfo,
    crop_bounds: Option<CropBounds>,
) -> VideoInfo {
    if crop_bounds.is_some() {
        return fallback;
    }

    let Some((width, height)) = stream.size() else {
        return fallback;
    };
    if width <= 0 || height <= 0 {
        return fallback;
    }

    VideoInfo::from_raw_ffmpeg(
        fallback.pixel_format,
        ensure_even(width as u32),
        ensure_even(height as u32),
        fallback.fps(),
    )
}

fn capture_wayland(
    video_info: VideoInfo,
    input: WaylandInputConfig,
    video_tx: mpsc::Sender<FFmpegVideoFrame>,
    stop_token: CancellationToken,
    health_tx: output_pipeline::HealthSender,
) -> anyhow::Result<()> {
    let _portal_session = input.portal_session;
    let stop_requested = Arc::new(AtomicBool::new(false));
    let fatal_error = Arc::new(parking_lot::Mutex::new(None));
    let sent = Arc::new(AtomicU64::new(0));
    let dropped = Arc::new(AtomicU64::new(0));
    let rate_limited = Arc::new(AtomicU64::new(0));
    let started = Instant::now();

    let thread_loop = unsafe { pw::thread_loop::ThreadLoopBox::new(Some("cap-wayland"), None) }
        .context("create PipeWire thread loop")?;
    let context = pw::context::ContextBox::new(thread_loop.loop_(), None)
        .context("create PipeWire context")?;
    let core = context
        .connect_fd(input.fd, None)
        .context("connect to PipeWire remote")?;

    let state = PipewireCaptureState {
        format: Default::default(),
        scaler: None,
        video_info,
        crop_bounds: input.crop_bounds,
        video_tx,
        health_tx,
        stop_requested: stop_requested.clone(),
        fatal_error: fatal_error.clone(),
        sent: sent.clone(),
        dropped: dropped.clone(),
        rate_limited: rate_limited.clone(),
        capture_clock: started,
        cadence_gate: FrameCadenceGate::new(1_000_000_000 / i64::from(input.fps.max(1))),
    };

    let stream = pw::stream::StreamBox::new(
        &core,
        "cap-wayland-screen",
        properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )
    .context("create PipeWire screen capture stream")?;

    let _listener = stream
        .add_local_listener_with_user_data(state)
        .state_changed(|_, state, _, new| {
            if let pw::stream::StreamState::Error(error) = new {
                state.set_fatal_error(format!("PipeWire screen capture stream failed: {error}"));
            }
        })
        .param_changed(|_, state, id, param| {
            if let Err(error) = update_pipewire_format(state, id, param) {
                state.set_fatal_error(error.to_string());
            }
        })
        .process(|stream, state| {
            if state.stop_requested.load(Ordering::Relaxed) {
                return;
            }

            match process_pipewire_frame(stream, state) {
                Ok(Some(StallSendOutcome::Sent)) => {
                    state.sent.fetch_add(1, Ordering::Relaxed);
                }
                Ok(Some(StallSendOutcome::StalledAndDropped { .. })) => {
                    state.dropped.fetch_add(1, Ordering::Relaxed);
                }
                Ok(Some(StallSendOutcome::Disconnected)) => {
                    state.stop_requested.store(true, Ordering::Relaxed);
                }
                Ok(None) => {}
                Err(error) => state.set_fatal_error(error.to_string()),
            }
        })
        .register()
        .context("register PipeWire stream listener")?;

    let param_bytes = pipewire_format_param(input.fps)?;
    let mut params = [spa::pod::Pod::from_bytes(&param_bytes)
        .ok_or_else(|| anyhow!("create PipeWire format parameter"))?];

    stream
        .connect(
            spa::utils::Direction::Input,
            Some(input.node_id),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .context("connect PipeWire stream to portal node")?;

    thread_loop.start();

    while !stop_token.is_cancelled() && !stop_requested.load(Ordering::Relaxed) {
        if fatal_error.lock().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    stop_requested.store(true, Ordering::Relaxed);
    thread_loop.stop();

    let error = fatal_error.lock().take();
    tracing::info!(
        sent = sent.load(Ordering::Relaxed),
        dropped = dropped.load(Ordering::Relaxed),
        rate_limited = rate_limited.load(Ordering::Relaxed),
        elapsed_ms = started.elapsed().as_millis() as u64,
        "Linux Wayland PipeWire capture stopped"
    );

    if let Some(error) = error {
        Err(anyhow!(error))
    } else {
        Ok(())
    }
}

fn update_pipewire_format(
    state: &mut PipewireCaptureState,
    id: u32,
    param: Option<&spa::pod::Pod>,
) -> anyhow::Result<()> {
    let Some(param) = param else {
        return Ok(());
    };
    if id != spa::param::ParamType::Format.as_raw() {
        return Ok(());
    }

    let (media_type, media_subtype) =
        spa::param::format_utils::parse_format(param).context("parse PipeWire stream format")?;
    if media_type != spa::param::format::MediaType::Video
        || media_subtype != spa::param::format::MediaSubtype::Raw
    {
        return Ok(());
    }

    let mut format = spa::param::video::VideoInfoRaw::default();
    format
        .parse(param)
        .context("parse PipeWire raw video format")?;
    pipewire_pixel_format(format.format()).ok_or_else(|| {
        anyhow!(
            "Unsupported PipeWire screen capture pixel format: {:?}",
            format.format()
        )
    })?;
    state.format = format;

    Ok(())
}

fn process_pipewire_frame(
    stream: &pw::stream::Stream,
    state: &mut PipewireCaptureState,
) -> anyhow::Result<Option<StallSendOutcome>> {
    let Some(mut buffer) = stream.dequeue_buffer() else {
        return Ok(None);
    };
    let datas = buffer.datas_mut();
    if datas.is_empty() {
        return Ok(None);
    }

    let captured_at = Instant::now();
    let ticks = i64::try_from(
        captured_at
            .saturating_duration_since(state.capture_clock)
            .as_nanos(),
    )
    .unwrap_or(i64::MAX);
    if !state.cadence_gate.admit(ticks) {
        state.rate_limited.fetch_add(1, Ordering::Relaxed);
        return Ok(None);
    }

    let Some(raw_frame) = frame_from_pipewire_data(&mut datas[0], state.format, state.crop_bounds)?
    else {
        return Ok(Some(StallSendOutcome::StalledAndDropped { waited_ms: 0 }));
    };
    let frame = prepare_pipewire_frame(raw_frame, &mut state.scaler, state.video_info)?;
    let timestamp = Timestamp::Instant(captured_at);

    Ok(Some(send_with_stall_budget_futures(
        &mut state.video_tx,
        FFmpegVideoFrame {
            inner: frame,
            timestamp,
        },
        "linux-wayland-video",
        &state.health_tx,
    )))
}

fn prepare_pipewire_frame(
    frame: ffmpeg::frame::Video,
    scaler: &mut Option<FrameScaler>,
    output: VideoInfo,
) -> anyhow::Result<ffmpeg::frame::Video> {
    if frame.format() == output.pixel_format
        && frame.width() == output.width
        && frame.height() == output.height
    {
        return Ok(frame);
    }

    if scaler.is_none() {
        *scaler = Some(FrameScaler::new(
            frame.format(),
            frame.width(),
            frame.height(),
            output,
        )?);
    }

    scaler
        .as_mut()
        .expect("PipeWire frame scaler initialized")
        .scale(&frame, output)
}

fn frame_from_pipewire_data(
    data: &mut spa::buffer::Data,
    format: spa::param::video::VideoInfoRaw,
    crop_bounds: Option<CropBounds>,
) -> anyhow::Result<Option<ffmpeg::frame::Video>> {
    let (pixel_format, bytes_per_pixel) =
        pipewire_pixel_format(format.format()).ok_or_else(|| {
            anyhow!(
                "Unsupported PipeWire screen capture pixel format: {:?}",
                format.format()
            )
        })?;
    let size = format.size();
    let source_width = size.width as usize;
    let source_height = size.height as usize;
    if source_width == 0 || source_height == 0 {
        bail!("PipeWire screen capture stream did not provide frame dimensions");
    }

    let chunk_flags = data.chunk().flags();
    let chunk_stride = data.chunk().stride();
    let chunk_offset = data.chunk().offset();
    let chunk_size = data.chunk().size();
    if chunk_flags.contains(spa::buffer::ChunkFlags::CORRUPTED) {
        tracing::warn!("PipeWire screen capture frame was marked corrupted; skipping frame");
        return Ok(None);
    }
    if chunk_stride < 0 {
        bail!("PipeWire screen capture frame used a negative stride");
    }

    let source_stride = if chunk_stride > 0 {
        chunk_stride as usize
    } else {
        source_width * bytes_per_pixel
    };
    let (crop_x, crop_y, crop_width, crop_height) =
        pipewire_crop(source_width, source_height, crop_bounds)?;
    let source = data
        .data()
        .ok_or_else(|| anyhow!("PipeWire screen capture buffer was not memory-mapped"))?;
    let offset = chunk_offset as usize;
    let source_limit = if chunk_size > 0 {
        offset
            .checked_add(chunk_size as usize)
            .map(|limit| limit.min(source.len()))
            .ok_or_else(|| anyhow!("PipeWire screen capture frame size overflowed"))?
    } else {
        source.len()
    };
    let row_bytes = crop_width * bytes_per_pixel;

    let mut frame = ffmpeg::frame::Video::new(pixel_format, crop_width as u32, crop_height as u32);
    let target_stride = frame.stride(0);
    if target_stride < row_bytes {
        bail!(
            "PipeWire target frame stride was too small: {} for {}x{}",
            target_stride,
            crop_width,
            crop_height
        );
    }

    for y in 0..crop_height {
        let source_start = offset + (crop_y + y) * source_stride + crop_x * bytes_per_pixel;
        let source_end = source_start + row_bytes;
        if source_end > source_limit {
            bail!(
                "PipeWire screen capture frame was too small: {} bytes for {}x{}",
                source.len(),
                source_width,
                source_height
            );
        }

        let target_start = y * target_stride;
        frame.data_mut(0)[target_start..target_start + row_bytes]
            .copy_from_slice(&source[source_start..source_end]);
    }

    Ok(Some(frame))
}

fn pipewire_crop(
    source_width: usize,
    source_height: usize,
    crop_bounds: Option<CropBounds>,
) -> anyhow::Result<(usize, usize, usize, usize)> {
    let Some(crop_bounds) = crop_bounds else {
        return Ok((0, 0, source_width, source_height));
    };

    let crop_x = crop_bounds.position().x().max(0.0).floor() as usize;
    let crop_y = crop_bounds.position().y().max(0.0).floor() as usize;
    if crop_x >= source_width || crop_y >= source_height {
        bail!("Wayland capture crop is outside the PipeWire stream bounds");
    }

    let crop_width =
        (crop_bounds.size().width().max(1.0).floor() as usize).min(source_width - crop_x);
    let crop_height =
        (crop_bounds.size().height().max(1.0).floor() as usize).min(source_height - crop_y);

    Ok((crop_x, crop_y, crop_width, crop_height))
}

fn pipewire_pixel_format(
    format: spa::param::video::VideoFormat,
) -> Option<(ffmpeg::format::Pixel, usize)> {
    let pixel = if format == spa::param::video::VideoFormat::RGBx {
        ffmpeg::format::Pixel::RGBZ
    } else if format == spa::param::video::VideoFormat::BGRx {
        ffmpeg::format::Pixel::BGRZ
    } else if format == spa::param::video::VideoFormat::xRGB {
        ffmpeg::format::Pixel::ZRGB
    } else if format == spa::param::video::VideoFormat::xBGR {
        ffmpeg::format::Pixel::ZBGR
    } else if format == spa::param::video::VideoFormat::RGBA {
        ffmpeg::format::Pixel::RGBA
    } else if format == spa::param::video::VideoFormat::BGRA {
        ffmpeg::format::Pixel::BGRA
    } else if format == spa::param::video::VideoFormat::ARGB {
        ffmpeg::format::Pixel::ARGB
    } else if format == spa::param::video::VideoFormat::ABGR {
        ffmpeg::format::Pixel::ABGR
    } else if format == spa::param::video::VideoFormat::RGB {
        return Some((ffmpeg::format::Pixel::RGB24, 3));
    } else if format == spa::param::video::VideoFormat::BGR {
        return Some((ffmpeg::format::Pixel::BGR24, 3));
    } else {
        return None;
    };

    Some((pixel, 4))
}

fn pipewire_format_param(fps: u32) -> anyhow::Result<Vec<u8>> {
    let fps = fps.max(1);
    let obj = spa::pod::object!(
        spa::utils::SpaTypes::ObjectParamFormat,
        spa::param::ParamType::EnumFormat,
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaType,
            Id,
            spa::param::format::MediaType::Video
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaSubtype,
            Id,
            spa::param::format::MediaSubtype::Raw
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            spa::param::video::VideoFormat::BGRx,
            spa::param::video::VideoFormat::BGRx,
            spa::param::video::VideoFormat::BGRA,
            spa::param::video::VideoFormat::RGBx,
            spa::param::video::VideoFormat::RGBA,
            spa::param::video::VideoFormat::RGB,
            spa::param::video::VideoFormat::BGR
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            spa::utils::Rectangle {
                width: 1920,
                height: 1080
            },
            spa::utils::Rectangle {
                width: 1,
                height: 1
            },
            spa::utils::Rectangle {
                width: 8192,
                height: 8192
            }
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            spa::utils::Fraction { num: fps, denom: 1 },
            spa::utils::Fraction { num: 0, denom: 1 },
            spa::utils::Fraction {
                num: 1000,
                denom: 1
            }
        )
    );

    Ok(spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(obj),
    )
    .map_err(|error| anyhow!("serialize PipeWire format parameter: {error:?}"))?
    .0
    .into_inner())
}

pub struct SystemAudioSourceConfig {
    feed_lock: Arc<MicrophoneFeedLock>,
    device_name: String,
    monitor_route: Option<PactlMonitorRoute>,
    feed: OwnedSystemAudioFeed,
}

pub struct SystemAudioSource {
    inner: crate::sources::Microphone,
    monitor_route: Option<PactlMonitorRoute>,
    feed: OwnedSystemAudioFeed,
}

struct OwnedSystemAudioFeed {
    actor: ActorRef<MicrophoneFeed>,
    build_scope: Option<crate::output_pipeline::PipelineBuildScope>,
    stopped: bool,
}

impl Drop for OwnedSystemAudioFeed {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        self.actor.kill();
        if let Some(scope) = &self.build_scope
            && !scope.is_committed()
        {
            let feed = self.actor.clone();
            scope.spawn_cleanup(async move {
                feed.wait_for_stop().await;
                Ok(())
            });
        }
    }
}

impl Drop for SystemAudioSource {
    fn drop(&mut self) {
        drop(self.monitor_route.take());
    }
}

struct PactlMonitorRoute {
    monitor_source: String,
    monitor_source_index: u32,
    default_source: Option<String>,
    default_source_index: Option<u32>,
    source_output: u32,
    original_source: u32,
    previous_process_source_outputs: Vec<PactlSourceOutput>,
}

impl Drop for PactlMonitorRoute {
    fn drop(&mut self) {
        let restore = || -> anyhow::Result<()> {
            let outputs = current_process_source_outputs()?;
            let Some(output) = outputs
                .iter()
                .find(|output| output.id == self.source_output)
            else {
                return Ok(());
            };
            if output.source != self.monitor_source_index {
                return Ok(());
            }
            let destination = previous_source_destination(
                self.original_source,
                self.monitor_source_index,
                &self.monitor_source,
                self.default_source.as_deref(),
            );
            if destination != self.monitor_source_index.to_string() {
                move_pactl_source_output(self.source_output, &destination)?;
            }
            Ok(())
        };
        if let Err(error) = restore() {
            tracing::warn!(%error, "Could not restore the Linux system-audio input route");
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum PulseInputRole {
    #[default]
    Microphone,
    SystemAudio,
}

mod alsa_input_backend {
    use anyhow::{Context as _, anyhow, bail, ensure};
    use std::ffi::{CStr, CString, c_char, c_int, c_void};

    #[link(name = "asound")]
    unsafe extern "C" {
        fn snd_config_update_ref(config: *mut *mut c_void) -> c_int;
        fn snd_config_unref(config: *mut c_void);
        fn snd_config_delete(config: *mut c_void) -> c_int;
        fn snd_config_search_definition(
            config: *mut c_void,
            base: *const c_char,
            name: *const c_char,
            result: *mut *mut c_void,
        ) -> c_int;
        fn snd_config_search(
            config: *mut c_void,
            key: *const c_char,
            result: *mut *mut c_void,
        ) -> c_int;
        fn snd_config_get_string(config: *const c_void, result: *mut *const c_char) -> c_int;
        #[cfg(test)]
        fn snd_config_load_string(
            config: *mut *mut c_void,
            text: *const c_char,
            size: usize,
        ) -> c_int;
    }

    struct Config {
        raw: *mut c_void,
        shared: bool,
    }

    impl Drop for Config {
        fn drop(&mut self) {
            unsafe {
                if self.shared {
                    snd_config_unref(self.raw);
                } else {
                    let _ = snd_config_delete(self.raw);
                }
            }
        }
    }

    fn definition(root: *mut c_void, base: &CStr, name: &CStr) -> anyhow::Result<Config> {
        let mut raw = std::ptr::null_mut();
        let status =
            unsafe { snd_config_search_definition(root, base.as_ptr(), name.as_ptr(), &mut raw) };
        ensure!(
            status >= 0 && !raw.is_null(),
            "Could not resolve ALSA input configuration {name:?}: {status}"
        );
        Ok(Config { raw, shared: false })
    }

    fn child(config: *mut c_void, key: &CStr) -> Option<*mut c_void> {
        let mut raw = std::ptr::null_mut();
        let status = unsafe { snd_config_search(config, key.as_ptr(), &mut raw) };
        (status >= 0 && !raw.is_null()).then_some(raw)
    }

    fn string(config: *mut c_void) -> Option<CString> {
        let mut value = std::ptr::null();
        let status = unsafe { snd_config_get_string(config, &mut value) };
        if status < 0 || value.is_null() {
            return None;
        }
        Some(unsafe { CStr::from_ptr(value) }.to_owned())
    }

    fn nested_pcm(
        root: *mut c_void,
        node: *mut c_void,
        key: &CStr,
        depth: usize,
    ) -> anyhow::Result<bool> {
        let node = child(node, key).context("ALSA input slave is missing")?;
        let named = string(node)
            .map(|name| definition(root, c"pcm_slave", &name))
            .transpose()?;
        let slave = named.as_ref().map_or(node, |config| config.raw);
        let pcm = child(slave, c"pcm").context("ALSA input slave PCM is missing")?;
        node_uses_pulse(root, pcm, depth + 1)
    }

    fn node_uses_pulse(root: *mut c_void, node: *mut c_void, depth: usize) -> anyhow::Result<bool> {
        ensure!(
            depth < 32,
            "ALSA input configuration exceeds the alias depth limit"
        );
        if let Some(name) = string(node) {
            let resolved = definition(root, c"pcm", &name)?;
            return node_uses_pulse(root, resolved.raw, depth + 1);
        }
        let kind = child(node, c"type")
            .and_then(string)
            .context("ALSA input plugin type is missing")?;
        match kind.as_bytes() {
            b"pulse" => Ok(true),
            b"asym" => nested_pcm(root, node, c"capture", depth),
            b"file" if child(node, c"infile").is_some() => Ok(false),
            b"plug" | b"rate" | b"route" | b"linear" | b"lfloat" | b"copy" | b"softvol"
            | b"dsnoop" | b"mmap_emul" | b"file" => nested_pcm(root, node, c"slave", depth),
            _ if child(node, c"slave").is_some() => nested_pcm(root, node, c"slave", depth),
            b"multi" => {
                bail!("ALSA input has multiple backends; cannot identify a single Pulse route")
            }
            _ => Ok(false),
        }
    }

    pub(super) fn uses_pulse(device_name: &str) -> anyhow::Result<bool> {
        let name = CString::new(device_name).context("Invalid ALSA input name")?;
        let mut raw = std::ptr::null_mut();
        let status = unsafe { snd_config_update_ref(&mut raw) };
        if status < 0 || raw.is_null() {
            return Err(anyhow!("Could not read ALSA input configuration: {status}"));
        }
        let root = Config { raw, shared: true };
        let input = definition(root.raw, c"pcm", &name)?;
        node_uses_pulse(root.raw, input.raw, 0)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn configured_input_uses_pulse(text: &str) -> anyhow::Result<bool> {
            let text = CString::new(text)?;
            let mut raw = std::ptr::null_mut();
            let status =
                unsafe { snd_config_load_string(&mut raw, text.as_ptr(), text.as_bytes().len()) };
            ensure!(
                status >= 0 && !raw.is_null(),
                "ALSA test configuration failed: {status}"
            );
            let root = Config { raw, shared: false };
            let input = definition(root.raw, c"pcm", c"default")?;
            node_uses_pulse(root.raw, input.raw, 0)
        }

        #[test]
        fn direct_default_is_not_mistaken_for_pulse() {
            assert!(!configured_input_uses_pulse("pcm.default { type hw card 0 }").unwrap());
            assert!(!configured_input_uses_pulse("pcm.default { type custom_hardware }").unwrap());
        }

        #[test]
        fn pulse_default_aliases_and_plug_chains_are_detected() {
            assert!(
                configured_input_uses_pulse(
                    "pcm.default pulse_input\npcm.pulse_input { type pulse }"
                )
                .unwrap()
            );
            assert!(configured_input_uses_pulse("pcm.default { type plug slave.pcm inner }\npcm.inner { type rate slave.pcm { type pulse } }").unwrap());
        }

        #[test]
        fn asymmetric_default_checks_capture_instead_of_playback() {
            assert!(!configured_input_uses_pulse("pcm.default { type asym playback.pcm { type pulse } capture.pcm { type hw card 0 } }").unwrap());
            assert!(configured_input_uses_pulse("pcm.default { type asym playback.pcm { type hw card 0 } capture.pcm { type pulse } }").unwrap());
        }

        #[test]
        fn named_slaves_and_file_inputs_keep_their_capture_backend() {
            assert!(configured_input_uses_pulse("pcm.default { type plug slave captured }\npcm_slave.captured { pcm { type pulse } }").unwrap());
            assert!(!configured_input_uses_pulse("pcm.default { type plug slave.pcm { type file infile synthetic.raw slave.pcm { type null } } }").unwrap());
        }

        #[test]
        fn malformed_or_ambiguous_inputs_do_not_claim_a_pulse_route() {
            for wrapper in [
                "plug",
                "rate",
                "route",
                "linear",
                "lfloat",
                "copy",
                "softvol",
                "dsnoop",
                "mmap_emul",
                "file",
            ] {
                assert!(
                    configured_input_uses_pulse(&format!("pcm.default {{ type {wrapper} }}"))
                        .is_err()
                );
            }
            assert!(configured_input_uses_pulse("pcm.default { type multi }").is_err());
        }
    }
}

pub(crate) struct PulseInputRoute {
    source: String,
    source_index: u32,
    previous_outputs: Vec<PactlSourceOutput>,
}

impl PulseInputRoute {
    pub(crate) fn prepare(device_name: &str, role: PulseInputRole) -> anyhow::Result<Option<Self>> {
        if !uses_default_pulse_input(device_name) {
            return Ok(None);
        }
        let default_source = pactl_default_source();
        if default_source.is_none() && role == PulseInputRole::Microphone {
            return Ok(None);
        }
        if !alsa_input_backend::uses_pulse(device_name)? {
            anyhow::ensure!(
                role != PulseInputRole::SystemAudio,
                "The selected ALSA input is not a Pulse system-audio monitor"
            );
            return Ok(None);
        }
        let default_sink = pactl_default_sink();
        let sources = Command::new("pactl")
            .args(["list", "short", "sources"])
            .output()
            .context("inspect the default PulseAudio/PipeWire input")?;
        if !sources.status.success() {
            anyhow::ensure!(
                role != PulseInputRole::SystemAudio,
                "Could not inspect Linux system-audio monitor sources"
            );
            return Ok(None);
        }
        let Some((source_index, source)) = pulse_input_route_destination(
            &String::from_utf8_lossy(&sources.stdout),
            role,
            default_source.as_deref(),
            default_sink.as_deref(),
        ) else {
            anyhow::ensure!(
                role != PulseInputRole::SystemAudio,
                "No Linux system-audio monitor source is available"
            );
            return Ok(None);
        };
        Ok(Some(Self {
            source,
            source_index,
            previous_outputs: current_process_source_outputs()?,
        }))
    }

    pub(crate) fn apply(
        self,
        input_callback_observed: &AtomicBool,
        cancel: &CancellationToken,
    ) -> anyhow::Result<()> {
        let output = wait_for_started_source_output(
            &self.previous_outputs,
            input_callback_observed,
            cancel,
            current_process_source_outputs,
        )?;
        if output.source != self.source_index {
            // Pulse remembers the generic ALSA application's last route, including speaker capture.
            move_pactl_source_output(output.id, &self.source)?;
        }
        Ok(())
    }
}

fn pulse_input_route_destination(
    sources: &str,
    role: PulseInputRole,
    default_source: Option<&str>,
    default_sink: Option<&str>,
) -> Option<(u32, String)> {
    match role {
        PulseInputRole::Microphone => {
            let source = default_source?;
            Some((pactl_source_index(sources, source)?, source.to_string()))
        }
        PulseInputRole::SystemAudio => sources
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let index = fields.next()?.parse::<u32>().ok()?;
                let name = fields.next()?;
                let rank = pactl_monitor_preference(name, default_sink)?;
                Some((rank, name.to_ascii_lowercase(), index, name.to_string()))
            })
            .min()
            .map(|(_, _, index, name)| (index, name)),
    }
}

fn wait_for_started_source_output(
    previous_outputs: &[PactlSourceOutput],
    input_callback_observed: &AtomicBool,
    cancel: &CancellationToken,
    mut current_outputs: impl FnMut() -> anyhow::Result<Vec<PactlSourceOutput>>,
) -> anyhow::Result<PactlSourceOutput> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(3) {
        anyhow::ensure!(
            !cancel.is_cancelled(),
            "Linux input route confirmation cancelled"
        );
        let has_captured_audio = input_callback_observed.load(Ordering::Acquire);
        let outputs = current_outputs()?;
        if let Some(id) =
            started_input_source_output(previous_outputs, &outputs, has_captured_audio)?
        {
            return outputs
                .into_iter()
                .find(|output| output.id == id)
                .ok_or_else(|| anyhow!("The started PulseAudio/PipeWire input disappeared"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    bail!("The PulseAudio/PipeWire input did not start delivering audio within three seconds")
}

fn started_input_source_output(
    previous: &[PactlSourceOutput],
    current: &[PactlSourceOutput],
    input_callback_observed: bool,
) -> anyhow::Result<Option<u32>> {
    if !input_callback_observed
        || !current
            .iter()
            .any(|output| !previous.iter().any(|previous| previous.id == output.id))
    {
        return Ok(None);
    }
    newly_created_source_output(previous, current).map(Some)
}

fn uses_default_pulse_input(device_name: &str) -> bool {
    device_name.eq_ignore_ascii_case("default") || device_name.eq_ignore_ascii_case("pulse")
}

impl AudioSource for SystemAudioSource {
    type Config = SystemAudioSourceConfig;

    fn setup(
        config: Self::Config,
        tx: mpsc::Sender<AudioFrame>,
        ctx: &mut SetupCtx,
    ) -> impl std::future::Future<Output = anyhow::Result<Self>> + Send + 'static
    where
        Self: Sized,
    {
        let device_name = config.device_name.clone();
        let setup = <crate::sources::Microphone as AudioSource>::setup(config.feed_lock, tx, ctx);
        async move {
            let inner = setup
                .await
                .with_context(|| format!("set up Linux system audio source '{device_name}'"))?;

            if let Some(route) = config.monitor_route.as_ref() {
                apply_pactl_monitor_route(route)?;
            }

            Ok(Self {
                inner,
                monitor_route: config.monitor_route,
                feed: config.feed,
            })
        }
    }

    fn audio_info(&self) -> AudioInfo {
        self.inner.audio_info()
    }

    async fn stop(&mut self) -> anyhow::Result<()> {
        drop(self.monitor_route.take());
        self.inner.stop().await?;
        self.feed.actor.kill();
        self.feed.actor.wait_for_stop().await;
        self.feed.stopped = true;
        Ok(())
    }
}

async fn create_system_audio_source_config() -> anyhow::Result<SystemAudioSourceConfig> {
    let (error_tx, _error_rx) = flume::bounded(16);
    let feed = MicrophoneFeed::spawn(MicrophoneFeed::new_system_audio(error_tx));
    let owned_feed = OwnedSystemAudioFeed {
        actor: feed.clone(),
        build_scope: crate::output_pipeline::PipelineBuildScope::current(),
        stopped: false,
    };
    let (device_name, monitor_route) = retry_system_audio_connection(
        || async {
            let selected = select_system_audio_monitor()?;
            let device_name = selected.device_name.clone();
            feed.ask(microphone::SetInput {
                label: device_name.clone(),
                settings: None,
            })
            .await
            .map_err(|e| anyhow!("Failed to set Linux system audio input: {e}"))?
            .await
            .with_context(|| {
                format!("Linux system audio input '{device_name}' failed to connect")
            })?;

            tokio::time::sleep(Duration::from_millis(100)).await;

            let route = selected.into_monitor_route()?;
            if let Some(route) = route.as_ref() {
                apply_pactl_monitor_route(route)?;
            }
            let routed_at = cap_timestamp::Timestamps::now();
            let (sender, receiver) = flume::bounded(1);
            feed.ask(microphone::AddSender(sender.clone()))
                .await
                .map_err(|e| anyhow!("Failed to observe Linux system audio startup: {e}"))?;
            let ready = wait_for_audio_after_route(
                receiver.stream().map(|samples| samples.timestamp),
                routed_at,
            )
            .await;
            feed.ask(microphone::RemoveSender(sender))
                .await
                .map_err(|e| {
                    anyhow!("Failed to detach the Linux system audio startup observer: {e}")
                })?;
            ready?;
            Ok((device_name, route))
        },
        || async {
            feed.ask(microphone::RemoveInput)
                .await
                .map_err(|e| anyhow!("Failed to close the unrouted Linux system audio input: {e}"))
        },
    )
    .await?;

    let lock = feed
        .ask(microphone::Lock)
        .await
        .map_err(|e| anyhow!("Failed to lock Linux system audio input: {e}"))?;

    Ok(SystemAudioSourceConfig {
        feed_lock: Arc::new(lock),
        device_name,
        monitor_route,
        feed: owned_feed,
    })
}

async fn wait_for_audio_after_route(
    timestamps: impl Stream<Item = Timestamp>,
    routed_at: cap_timestamp::Timestamps,
) -> anyhow::Result<()> {
    futures::pin_mut!(timestamps);
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(timestamp) = timestamps.next().await {
            if timestamp.checked_duration_since(routed_at).is_some() {
                return Ok(());
            }
        }
        bail!("Linux system audio input closed before delivering routed audio")
    })
    .await
    .context("Linux system audio input did not resume after routing within three seconds")?
}

async fn retry_system_audio_connection<T, ConnectFuture, DisconnectFuture>(
    mut connect: impl FnMut() -> ConnectFuture,
    mut disconnect: impl FnMut() -> DisconnectFuture,
) -> anyhow::Result<T>
where
    ConnectFuture: std::future::Future<Output = anyhow::Result<T>>,
    DisconnectFuture: std::future::Future<Output = anyhow::Result<()>>,
{
    let mut remaining_retries = 2;
    loop {
        match connect().await {
            Ok(input) => return Ok(input),
            Err(error) => {
                disconnect().await?;
                if remaining_retries == 0 {
                    return Err(error)
                        .context("Linux system audio could not reach the output monitor");
                }
                remaining_retries -= 1;
                tracing::warn!(%error, remaining_retries, "Reconnecting the Linux system-audio input after routing failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

struct SelectedSystemAudioInput {
    device_name: String,
    monitor_source: Option<String>,
    monitor_source_index: Option<u32>,
    default_source: Option<String>,
    default_source_index: Option<u32>,
    previous_process_source_outputs: Vec<PactlSourceOutput>,
}

impl SelectedSystemAudioInput {
    fn into_monitor_route(self) -> anyhow::Result<Option<PactlMonitorRoute>> {
        let Some(monitor_source) = self.monitor_source else {
            return Ok(None);
        };
        let current_source_outputs = current_process_source_outputs()?;
        let source_output = newly_created_source_output(
            &self.previous_process_source_outputs,
            &current_source_outputs,
        )?;
        let original_source = current_source_outputs
            .iter()
            .find(|output| output.id == source_output)
            .ok_or_else(|| anyhow!("PulseAudio/PipeWire system-audio stream disappeared"))?
            .source;

        Ok(Some(PactlMonitorRoute {
            monitor_source,
            monitor_source_index: self.monitor_source_index.ok_or_else(|| {
                anyhow!("PulseAudio/PipeWire monitor source has no routing index")
            })?,
            default_source: self.default_source,
            default_source_index: self.default_source_index,
            source_output,
            original_source,
            previous_process_source_outputs: self.previous_process_source_outputs,
        }))
    }
}

#[derive(Debug, PartialEq, Eq)]
struct PactlSourceOutput {
    id: u32,
    source: u32,
}

fn apply_pactl_monitor_route(route: &PactlMonitorRoute) -> anyhow::Result<()> {
    let mut current_source_outputs = current_process_source_outputs()?;
    let current_system_source = current_source_outputs
        .iter()
        .find(|source_output| source_output.id == route.source_output)
        .ok_or_else(|| anyhow!("PulseAudio/PipeWire system-audio stream is no longer active"))?;

    if source_output_needs_move(
        current_system_source.source,
        Some(route.monitor_source_index),
    ) {
        move_pactl_source_output(route.source_output, &route.monitor_source)?;
        current_source_outputs = current_process_source_outputs()?;
    }

    for previous_output in &route.previous_process_source_outputs {
        if let Some(current_output) = current_source_outputs
            .iter()
            .find(|current_output| current_output.id == previous_output.id)
        {
            let destination = previous_source_destination(
                previous_output.source,
                route.monitor_source_index,
                &route.monitor_source,
                route.default_source.as_deref(),
            );
            let destination_index = if destination == previous_output.source.to_string() {
                Some(previous_output.source)
            } else {
                route.default_source_index
            };

            if source_output_needs_move(current_output.source, destination_index) {
                move_pactl_source_output(previous_output.id, &destination)?;
            }
        }
    }

    Ok(())
}

fn source_output_needs_move(current_source: u32, target_source: Option<u32>) -> bool {
    target_source != Some(current_source)
}

fn select_system_audio_monitor() -> anyhow::Result<SelectedSystemAudioInput> {
    let devices = MicrophoneFeed::list();
    let available = devices.keys().cloned().collect::<Vec<_>>();

    if let Some(name) = preferred_system_audio_device(&available, false) {
        return Ok(SelectedSystemAudioInput {
            device_name: name.to_string(),
            monitor_source: None,
            monitor_source_index: None,
            default_source: None,
            default_source_index: None,
            previous_process_source_outputs: Vec::new(),
        });
    }

    if let Some(selected) = select_pactl_monitor_source(&available)? {
        return Ok(selected);
    }

    if let Some(name) = preferred_system_audio_device(&available, true) {
        return Ok(SelectedSystemAudioInput {
            device_name: name.to_string(),
            monitor_source: None,
            monitor_source_index: None,
            default_source: None,
            default_source_index: None,
            previous_process_source_outputs: Vec::new(),
        });
    }

    Err(anyhow!(
        "No PulseAudio/PipeWire monitor input was found for Linux system audio. \
        Available input devices: {available:?}. Select a monitor source with --mic, or enable a monitor source in your audio server."
    ))
}

fn preferred_system_audio_device(
    available_devices: &[String],
    include_ambiguous: bool,
) -> Option<&str> {
    available_devices
        .iter()
        .filter_map(|name| {
            let rank = system_audio_device_rank(name)?;
            (include_ambiguous || rank < 2).then_some((rank, name.as_str()))
        })
        .min_by(|(left_rank, left_name), (right_rank, right_name)| {
            left_rank.cmp(right_rank).then_with(|| {
                left_name
                    .to_ascii_lowercase()
                    .cmp(&right_name.to_ascii_lowercase())
            })
        })
        .map(|(_, name)| name)
}

fn system_audio_device_rank(name: &str) -> Option<u8> {
    let name = name.to_ascii_lowercase();
    if name.contains("monitor") {
        Some(0)
    } else if name.contains("what u hear") || name.contains("stereo mix") {
        Some(1)
    } else if name.contains("loopback") || (name.contains("output") && name.contains("sink")) {
        Some(2)
    } else {
        None
    }
}

fn select_pactl_monitor_source(
    available_devices: &[String],
) -> anyhow::Result<Option<SelectedSystemAudioInput>> {
    let output = match Command::new("pactl")
        .args(["list", "short", "sources"])
        .output()
    {
        Ok(output) if output.status.success() => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(anyhow!(
                "Linux system audio capture needs `pactl` to discover monitor sources, \
                but it was not found on PATH. Install it with `apt install pulseaudio-utils`, \
                `dnf install pulseaudio-utils`, or `pacman -S libpulse`, then try again. \
                Available input devices: {available_devices:?}."
            ));
        }
        _ => return Ok(None),
    };

    let Some(device_name) = pulse_cpal_device_name(available_devices) else {
        return Ok(None);
    };

    let sources = String::from_utf8_lossy(&output.stdout);
    let default_sink = pactl_default_sink();
    let mut monitor_sources = sources
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let index = fields.next()?.parse::<u32>().ok()?;
            let name = fields.next()?;

            pactl_monitor_preference(name, default_sink.as_deref())
                .map(|rank| (rank, name.to_string(), index))
        })
        .collect::<Vec<_>>();
    monitor_sources.sort_by_key(|(rank, name, _)| (*rank, name.to_ascii_lowercase()));

    let Some((_, source, source_index)) = monitor_sources.into_iter().next() else {
        return Ok(None);
    };

    let previous_process_source_outputs = current_process_source_outputs()?;
    let default_source = pactl_default_source();
    let default_source_index = default_source
        .as_deref()
        .and_then(|source| pactl_source_index(&sources, source));

    Ok(Some(SelectedSystemAudioInput {
        device_name,
        monitor_source: Some(source),
        monitor_source_index: Some(source_index),
        default_source,
        default_source_index,
        previous_process_source_outputs,
    }))
}

fn pactl_source_index(sources: &str, name: &str) -> Option<u32> {
    sources.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let index = fields.next()?.parse::<u32>().ok()?;

        (fields.next()? == name).then_some(index)
    })
}

fn previous_source_destination(
    previous_source: u32,
    monitor_source: u32,
    monitor_name: &str,
    default_source: Option<&str>,
) -> String {
    if previous_source == monitor_source
        && let Some(default_source) = default_source
        && default_source != monitor_name
    {
        default_source.to_string()
    } else {
        previous_source.to_string()
    }
}

fn current_process_source_outputs() -> anyhow::Result<Vec<PactlSourceOutput>> {
    let output = Command::new("pactl")
        .args(["-f", "json", "list", "source-outputs"])
        .output()
        .context("list PulseAudio/PipeWire source outputs")?;

    if !output.status.success() {
        bail!("Could not inspect PulseAudio/PipeWire source outputs for isolated system audio");
    }

    let outputs: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout)
        .context("parse PulseAudio/PipeWire source outputs")?;
    process_source_output_ids(&outputs, &std::process::id().to_string())
}

fn process_source_output_ids(
    outputs: &[serde_json::Value],
    process_id: &str,
) -> anyhow::Result<Vec<PactlSourceOutput>> {
    outputs
        .iter()
        .filter(|output| {
            output["properties"]["application.process.id"]
                .as_str()
                .is_some_and(|id| id == process_id)
        })
        .map(|output| {
            let id = output["index"]
                .as_u64()
                .and_then(|index| u32::try_from(index).ok())
                .ok_or_else(|| anyhow!("PulseAudio/PipeWire source output has an invalid index"))?;
            let source = output["source"]
                .as_u64()
                .and_then(|source| u32::try_from(source).ok())
                .ok_or_else(|| {
                    anyhow!("PulseAudio/PipeWire source output has an invalid source")
                })?;

            Ok(PactlSourceOutput { id, source })
        })
        .collect()
}

fn newly_created_source_output(
    previous: &[PactlSourceOutput],
    current: &[PactlSourceOutput],
) -> anyhow::Result<u32> {
    let mut created = current
        .iter()
        .filter(|source_output| {
            !previous
                .iter()
                .any(|previous_output| previous_output.id == source_output.id)
        })
        .map(|source_output| source_output.id);

    match (created.next(), created.next()) {
        (Some(source_output), None) => Ok(source_output),
        (None, _) => bail!("Could not identify the PulseAudio/PipeWire system-audio stream"),
        (Some(_), Some(_)) => {
            bail!("Multiple PulseAudio/PipeWire system-audio streams started simultaneously")
        }
    }
}

fn move_pactl_source_output(source_output: u32, source: &str) -> anyhow::Result<()> {
    let source_index = match source.parse::<u32>() {
        Ok(index) => index,
        Err(_) => {
            let sources = Command::new("pactl")
                .args(["list", "short", "sources"])
                .output()
                .context("resolve PulseAudio/PipeWire routing destination")?;
            if !sources.status.success() {
                bail!("Could not inspect PulseAudio/PipeWire routing destinations");
            }
            pactl_source_index(&String::from_utf8_lossy(&sources.stdout), source).ok_or_else(
                || anyhow!("PulseAudio/PipeWire routing destination '{source}' disappeared"),
            )?
        }
    };
    let status = Command::new("pactl")
        .args(["move-source-output", &source_output.to_string(), source])
        .status()
        .context("move PulseAudio/PipeWire system-audio stream")?;

    if !status.success() {
        bail!(
            "Could not route PulseAudio/PipeWire system-audio stream {source_output} to '{source}'"
        );
    }

    for _ in 0..10 {
        if source_output_route_matches(
            &current_process_source_outputs()?,
            source_output,
            source_index,
        )? {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    bail!(
        "PulseAudio/PipeWire acknowledged routing stream {source_output} to '{source}', but the input did not change"
    )
}

fn source_output_route_matches(
    outputs: &[PactlSourceOutput],
    source_output: u32,
    source_index: u32,
) -> anyhow::Result<bool> {
    outputs
        .iter()
        .find(|output| output.id == source_output)
        .map(|output| output.source == source_index)
        .ok_or_else(|| {
            anyhow!("PulseAudio/PipeWire stream {source_output} disappeared while routing")
        })
}

fn pulse_cpal_device_name(available_devices: &[String]) -> Option<String> {
    available_devices
        .iter()
        .find(|name| name.eq_ignore_ascii_case("pulse"))
        .or_else(|| {
            available_devices
                .iter()
                .find(|name| name.to_ascii_lowercase().contains("pulse"))
        })
        .or_else(|| {
            available_devices
                .iter()
                .find(|name| name.eq_ignore_ascii_case("default"))
        })
        .cloned()
}

fn pactl_monitor_rank(name: &str) -> Option<u8> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".monitor") {
        Some(0)
    } else if lower.contains("monitor") {
        Some(1)
    } else {
        None
    }
}

fn pactl_monitor_preference(name: &str, default_sink: Option<&str>) -> Option<(u8, u8)> {
    let rank = pactl_monitor_rank(name)?;
    let is_default_sink = default_sink.is_some_and(|sink| {
        name.strip_suffix(".monitor")
            .is_some_and(|monitor_sink| monitor_sink == sink)
    });

    Some((u8::from(!is_default_sink), rank))
}

fn pactl_default_sink() -> Option<String> {
    pactl_default_device("get-default-sink")
}

fn pactl_default_source() -> Option<String> {
    pactl_default_device("get-default-source")
}

fn pactl_default_device(command: &str) -> Option<String> {
    let output = Command::new("pactl").arg(command).output().ok()?;

    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|sink| !sink.is_empty())
}

struct FrameScaler {
    context: ffmpeg::software::scaling::Context,
    source_format: ffmpeg::format::Pixel,
    source_width: u32,
    source_height: u32,
}

impl FrameScaler {
    fn new(
        source_format: ffmpeg::format::Pixel,
        source_width: u32,
        source_height: u32,
        output: VideoInfo,
    ) -> anyhow::Result<Self> {
        let context = ffmpeg::software::scaling::Context::get(
            source_format,
            source_width,
            source_height,
            output.pixel_format,
            output.width,
            output.height,
            ffmpeg::software::scaling::Flags::BILINEAR,
        )?;

        Ok(Self {
            context,
            source_format,
            source_width,
            source_height,
        })
    }

    fn matches(&self, frame: &ffmpeg::frame::Video) -> bool {
        self.source_format == frame.format()
            && self.source_width == frame.width()
            && self.source_height == frame.height()
    }

    fn scale(
        &mut self,
        frame: &ffmpeg::frame::Video,
        output: VideoInfo,
    ) -> anyhow::Result<ffmpeg::frame::Video> {
        if frame.format() == output.pixel_format
            && frame.width() == output.width
            && frame.height() == output.height
        {
            return Ok(frame.clone());
        }

        if !self.matches(frame) {
            *self = Self::new(frame.format(), frame.width(), frame.height(), output)?;
        }

        let mut scaled = ffmpeg::frame::Video::empty();
        self.context.run(frame, &mut scaled)?;
        scaled.set_pts(frame.pts());
        Ok(scaled)
    }
}

fn capture_x11(
    _video_info: VideoInfo,
    input_config: X11InputConfig,
    mut video_tx: mpsc::Sender<FFmpegVideoFrame>,
    stop_token: CancellationToken,
    health_tx: output_pipeline::HealthSender,
) -> anyhow::Result<()> {
    let mut grabber = X11Grabber::new(&input_config)?;
    let frame_interval = Duration::from_secs_f64(1.0 / f64::from(input_config.fps.max(1)));
    let started = Instant::now();
    let mut next_capture = Instant::now();
    let mut sent = 0u64;
    let mut dropped = 0u64;

    while !stop_token.is_cancelled() {
        let mut frame = match grabber.grab() {
            Ok(frame) => frame,
            Err(error) if input_config.window_id.is_some() => return Err(error),
            Err(error) => {
                // X11 servers can transiently fail GetImage (e.g. while the
                // root geometry changes). Log, back off one interval, retry.
                tracing::warn!(error = %error, "X11 frame capture failed");
                std::thread::sleep(frame_interval);
                continue;
            }
        };
        frame.set_pts(Some(started.elapsed().as_micros() as i64));

        let timestamp = Timestamp::Instant(Instant::now());
        match send_with_stall_budget_futures(
            &mut video_tx,
            FFmpegVideoFrame {
                inner: frame,
                timestamp,
            },
            "linux-screen-video",
            &health_tx,
        ) {
            StallSendOutcome::Sent => sent += 1,
            StallSendOutcome::StalledAndDropped { .. } => dropped += 1,
            StallSendOutcome::Disconnected => return Ok(()),
        }

        // Pace to the requested framerate without accumulating drift, while
        // staying responsive to stop requests (wake at most once per interval).
        next_capture += frame_interval;
        let now = Instant::now();
        if next_capture > now {
            std::thread::sleep((next_capture - now).min(frame_interval));
        } else {
            next_capture = now;
        }
    }

    tracing::info!(
        sent,
        dropped,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "Linux X11 capture stopped"
    );

    Ok(())
}

/// Native X11 screen capture via the (pure-Rust) `x11rb` protocol client.
///
/// This replaces FFmpeg's `x11grab` libavdevice input, which the bundled
/// FFmpeg (spacedrive native-deps) is built without. Capturing with `x11rb`
/// keeps us off any system FFmpeg/libavdevice and adds no new runtime
/// shared-library dependency (`x11rb` speaks the X11 protocol over a socket).
pub(crate) struct X11Grabber {
    conn: RustConnection,
    root: x11rb::protocol::xproto::Window,
    window: Option<X11WindowCapture>,
    x: i16,
    y: i16,
    width: u16,
    height: u16,
    source_pixel: ffmpeg::format::Pixel,
    output: VideoInfo,
    scaler: Option<FrameScaler>,
    show_cursor: bool,
}

struct X11WindowCapture {
    id: u32,
    pixmap: u32,
    border_width: u16,
}

impl X11Grabber {
    pub(crate) fn new(config: &X11InputConfig) -> anyhow::Result<Self> {
        ffmpeg::init().context("initialize FFmpeg")?;

        let (conn, screen_num) = x11rb::connect(Some(config.display_name.as_str()))
            .with_context(|| format!("connect to X11 display {}", config.display_name))?;

        let setup = conn.setup();
        let screen = setup
            .roots
            .get(screen_num)
            .ok_or_else(|| anyhow!("X11 screen {screen_num} not found"))?;
        let root = screen.root;
        let visual_id = match config.window_id {
            Some(id) => {
                if id == root || id == 0 {
                    bail!("X11 window capture requires a non-root window");
                }
                conn.get_window_attributes(id)
                    .context("request X11 window attributes")?
                    .reply()
                    .context("read X11 window attributes")?
                    .visual
            }
            None => screen.root_visual,
        };

        let (depth, visual) = screen
            .allowed_depths
            .iter()
            .find_map(|depth| {
                depth
                    .visuals
                    .iter()
                    .find(|visual| visual.visual_id == visual_id)
                    .map(|visual| (depth.depth, visual))
            })
            .ok_or_else(|| anyhow!("X11 visual {visual_id} not found"))?;

        let bits_per_pixel = setup
            .pixmap_formats
            .iter()
            .find(|format| format.depth == depth)
            .map(|format| format.bits_per_pixel)
            .ok_or_else(|| anyhow!("X11 pixmap format for depth {depth} not found"))?;

        let source_pixel = x11_source_pixel(
            setup.image_byte_order == ImageOrder::MSB_FIRST,
            bits_per_pixel,
            visual.red_mask,
            visual.green_mask,
            visual.blue_mask,
        )?;

        let x = i16::try_from(config.x)
            .map_err(|_| anyhow!("X11 capture x offset {} out of range", config.x))?;
        let y = i16::try_from(config.y)
            .map_err(|_| anyhow!("X11 capture y offset {} out of range", config.y))?;
        let width = u16::try_from(config.width)
            .map_err(|_| anyhow!("X11 capture width {} out of range", config.width))?;
        let height = u16::try_from(config.height)
            .map_err(|_| anyhow!("X11 capture height {} out of range", config.height))?;
        if width == 0 || height == 0 {
            bail!("X11 capture size must be non-zero");
        }

        // xfixes is needed to fetch the cursor image; only probe it when asked
        // to draw the cursor, and degrade gracefully if it is unavailable.
        let show_cursor = config.show_cursor && {
            use x11rb::protocol::xfixes::ConnectionExt as _;
            conn.xfixes_query_version(5, 0)
                .ok()
                .and_then(|cookie| cookie.reply().ok())
                .is_some()
        };

        let output = VideoInfo::from_raw_ffmpeg(
            ffmpeg::format::Pixel::BGRZ,
            u32::from(width),
            u32::from(height),
            config.fps.max(1),
        );

        let window = if let Some(id) = config.window_id {
            let version = conn
                .composite_query_version(0, 4)
                .context("XComposite is required for isolated window capture")?
                .reply()
                .context("query XComposite version")?;
            if version.major_version == 0 && version.minor_version < 2 {
                bail!("XComposite 0.2 or later is required for isolated window capture");
            }
            conn.change_window_attributes(
                id,
                &ChangeWindowAttributesAux::new().event_mask(EventMask::STRUCTURE_NOTIFY),
            )?
            .check()?;
            conn.composite_redirect_window(id, Redirect::AUTOMATIC)
                .context("redirect X11 window for isolated capture")?
                .check()
                .context("enable isolated X11 window capture")?;
            Some(X11WindowCapture {
                id,
                pixmap: 0,
                border_width: 0,
            })
        } else {
            None
        };

        let mut grabber = Self {
            conn,
            root,
            window,
            x,
            y,
            width,
            height,
            source_pixel,
            output,
            scaler: None,
            show_cursor,
        };
        grabber.refresh_window_pixmap()?;
        Ok(grabber)
    }

    fn refresh_window_pixmap(&mut self) -> anyhow::Result<()> {
        let Some(window) = self.window.as_mut() else {
            return Ok(());
        };
        let mut storage_changed = false;
        while let Some(event) = self.conn.poll_for_event()? {
            match event {
                Event::UnmapNotify(event) if event.window == window.id => {
                    bail!("Selected X11 window was unmapped");
                }
                Event::DestroyNotify(event) if event.window == window.id => {
                    bail!("Selected X11 window was closed");
                }
                Event::ConfigureNotify(event) if event.window == window.id => {
                    storage_changed = true
                }
                Event::ReparentNotify(event) if event.window == window.id => storage_changed = true,
                Event::MapNotify(event) if event.window == window.id => storage_changed = true,
                _ => {}
            }
        }
        let attributes = self
            .conn
            .get_window_attributes(window.id)?
            .reply()
            .context("selected X11 window is no longer available")?;
        if attributes.map_state != MapState::VIEWABLE {
            bail!("Selected X11 window is no longer viewable");
        }
        let geometry = self
            .conn
            .get_geometry(window.id)?
            .reply()
            .context("read selected X11 window geometry")?;
        if geometry.width == 0 || geometry.height == 0 {
            bail!("Selected X11 window has no content");
        }

        if storage_changed
            || window.pixmap == 0
            || self.width != geometry.width
            || self.height != geometry.height
            || window.border_width != geometry.border_width
        {
            let pixmap = self.conn.generate_id()?;
            self.conn
                .composite_name_window_pixmap(window.id, pixmap)?
                .check()
                .context("access isolated X11 window pixels")?;
            let previous = std::mem::replace(&mut window.pixmap, pixmap);
            if previous != 0 {
                self.conn.free_pixmap(previous)?.check()?;
            }
            self.width = geometry.width;
            self.height = geometry.height;
            window.border_width = geometry.border_width;
        }

        if self.show_cursor {
            let position = self
                .conn
                .translate_coordinates(window.id, self.root, 0, 0)?
                .reply()
                .context("locate selected X11 window cursor")?;
            self.x = position.dst_x;
            self.y = position.dst_y;
        }
        Ok(())
    }

    /// Capture one frame of the configured region as a BGRZ video frame.
    pub(crate) fn grab(&mut self) -> anyhow::Result<ffmpeg::frame::Video> {
        self.refresh_window_pixmap()?;
        let (drawable, x, y) = match &self.window {
            Some(window) => {
                let border = i16::try_from(window.border_width)
                    .context("X11 window border exceeds capture limits")?;
                (window.pixmap, border, border)
            }
            None => (self.root, self.x, self.y),
        };
        let reply = self
            .conn
            .get_image(
                ImageFormat::Z_PIXMAP,
                drawable,
                x,
                y,
                self.width,
                self.height,
                u32::MAX,
            )
            .context("request X11 image")?
            .reply()
            .context("read X11 image")?;

        let width = usize::from(self.width);
        let height = usize::from(self.height);
        let row_bytes = width * 4;
        let source_stride = reply
            .data
            .len()
            .checked_div(height)
            .filter(|stride| *stride >= row_bytes)
            .ok_or_else(|| {
                anyhow!(
                    "X11 image too small: {} bytes for {}x{}",
                    reply.data.len(),
                    width,
                    height
                )
            })?;

        let mut source = ffmpeg::frame::Video::new(
            self.source_pixel,
            u32::from(self.width),
            u32::from(self.height),
        );
        let dst_stride = source.stride(0);
        let copy = row_bytes.min(dst_stride);
        for row in 0..height {
            let src_start = row * source_stride;
            let dst_start = row * dst_stride;
            source.data_mut(0)[dst_start..dst_start + copy]
                .copy_from_slice(&reply.data[src_start..src_start + copy]);
        }

        let mut frame = prepare_pipewire_frame(source, &mut self.scaler, self.output)?;

        if self.show_cursor
            && let Err(error) = self.composite_cursor(&mut frame)
        {
            tracing::trace!(error = %error, "X11 cursor composite skipped");
        }

        Ok(frame)
    }

    /// Alpha-blend the X11 cursor onto a BGRZ frame (mirrors x11grab's
    /// `draw_mouse`). xfixes returns premultiplied ARGB, so we composite with
    /// straight `src + dst * (1 - a)`.
    fn composite_cursor(&self, frame: &mut ffmpeg::frame::Video) -> anyhow::Result<()> {
        use x11rb::protocol::xfixes::ConnectionExt as _;

        let cursor = self
            .conn
            .xfixes_get_cursor_image()
            .context("request X11 cursor image")?
            .reply()
            .context("read X11 cursor image")?;

        if cursor.width == 0 || cursor.height == 0 {
            return Ok(());
        }
        if cursor.cursor_image.len() != usize::from(cursor.width) * usize::from(cursor.height) {
            return Ok(());
        }

        let scale_x = f64::from(frame.width()) / f64::from(self.width);
        let scale_y = f64::from(frame.height()) / f64::from(self.height);
        let cursor_width = (f64::from(cursor.width) * scale_x).ceil() as i32;
        let cursor_height = (f64::from(cursor.height) * scale_y).ceil() as i32;
        let origin_x = ((f64::from(cursor.x) - f64::from(cursor.xhot) - f64::from(self.x))
            * scale_x)
            .floor() as i32;
        let origin_y = ((f64::from(cursor.y) - f64::from(cursor.yhot) - f64::from(self.y))
            * scale_y)
            .floor() as i32;

        let frame_width = frame.width() as i32;
        let frame_height = frame.height() as i32;
        let stride = frame.stride(0);
        let buf = frame.data_mut(0);

        for cy in 0..cursor_height {
            let fy = origin_y + cy;
            if fy < 0 || fy >= frame_height {
                continue;
            }
            for cx in 0..cursor_width {
                let fx = origin_x + cx;
                if fx < 0 || fx >= frame_width {
                    continue;
                }
                let source_x =
                    ((f64::from(cx) / scale_x) as usize).min(usize::from(cursor.width) - 1);
                let source_y =
                    ((f64::from(cy) / scale_y) as usize).min(usize::from(cursor.height) - 1);
                let pixel = cursor.cursor_image[source_y * usize::from(cursor.width) + source_x];
                let alpha = (pixel >> 24) & 0xff;
                if alpha == 0 {
                    continue;
                }
                let inv = 255 - alpha;
                let src_b = pixel & 0xff;
                let src_g = (pixel >> 8) & 0xff;
                let src_r = (pixel >> 16) & 0xff;
                let idx = fy as usize * stride + fx as usize * 4;
                buf[idx] = (src_b + buf[idx] as u32 * inv / 255).min(255) as u8;
                buf[idx + 1] = (src_g + buf[idx + 1] as u32 * inv / 255).min(255) as u8;
                buf[idx + 2] = (src_r + buf[idx + 2] as u32 * inv / 255).min(255) as u8;
            }
        }

        Ok(())
    }
}

/// Map an X11 32-bit TrueColor visual (byte order + RGB masks) to the matching
/// packed FFmpeg pixel format. The overwhelmingly common desktop case
/// (depth 24/32, little-endian, BGRX) resolves to BGRZ.
fn x11_source_pixel(
    msb_first: bool,
    bits_per_pixel: u8,
    red_mask: u32,
    green_mask: u32,
    blue_mask: u32,
) -> anyhow::Result<ffmpeg::format::Pixel> {
    if bits_per_pixel != 32 {
        bail!("Unsupported X11 visual: {bits_per_pixel}bpp (expected a 32-bit TrueColor visual)");
    }

    // Address index (0 = lowest byte) that a colour channel occupies in memory.
    let address_index = |mask: u32| -> Option<usize> {
        let position = match mask {
            0x0000_00ff => 0,
            0x0000_ff00 => 1,
            0x00ff_0000 => 2,
            0xff00_0000 => 3,
            _ => return None,
        };
        Some(if msb_first { 3 - position } else { position })
    };

    let (Some(red), Some(green), Some(blue)) = (
        address_index(red_mask),
        address_index(green_mask),
        address_index(blue_mask),
    ) else {
        bail!(
            "Unsupported X11 visual masks: r={red_mask:#010x} g={green_mask:#010x} b={blue_mask:#010x}"
        );
    };

    Ok(match (blue, green, red) {
        (0, 1, 2) => ffmpeg::format::Pixel::BGRZ,
        (2, 1, 0) => ffmpeg::format::Pixel::RGBZ,
        (1, 2, 3) => ffmpeg::format::Pixel::ZBGR,
        (3, 2, 1) => ffmpeg::format::Pixel::ZRGB,
        _ => bail!("Unsupported X11 channel order: b={blue} g={green} r={red}"),
    })
}

#[cfg(test)]
mod system_audio_tests {
    use super::{
        OwnedSystemAudioFeed, PactlSourceOutput, PulseInputRole, newly_created_source_output,
        pactl_monitor_preference, pactl_source_index, preferred_system_audio_device,
        previous_source_destination, process_source_output_ids, pulse_input_route_destination,
        retry_system_audio_connection, source_output_needs_move, source_output_route_matches,
        started_input_source_output, uses_default_pulse_input, wait_for_audio_after_route,
        wait_for_started_source_output,
    };
    use tokio_util::sync::CancellationToken;

    #[test]
    fn cancelled_system_route_does_not_probe_or_publish_a_stream() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let observed = std::sync::atomic::AtomicBool::new(true);
        let result = wait_for_started_source_output(&[], &observed, &cancel, || {
            panic!("cancelled route must not inspect Pulse")
        });
        assert!(result.is_err());
    }

    #[test]
    fn system_audio_reconnect_selects_output_monitor_instead_of_default_microphone() {
        let sources = "1\tmicrophone\n2\tother.monitor\n3\tspeakers.monitor\n";
        assert_eq!(
            pulse_input_route_destination(
                sources,
                PulseInputRole::SystemAudio,
                Some("microphone"),
                Some("speakers")
            ),
            Some((3, "speakers.monitor".to_string()))
        );
    }

    #[test]
    fn microphone_reconnect_retains_default_microphone_instead_of_output_monitor() {
        let sources = "1\tmicrophone\n2\tspeakers.monitor\n";
        assert_eq!(
            pulse_input_route_destination(
                sources,
                PulseInputRole::Microphone,
                Some("microphone"),
                Some("speakers")
            ),
            Some((1, "microphone".to_string()))
        );
    }

    #[test]
    fn system_audio_reconnect_does_not_fall_back_to_a_microphone() {
        assert_eq!(
            pulse_input_route_destination(
                "1\tmicrophone\n",
                PulseInputRole::SystemAudio,
                Some("microphone"),
                Some("speakers")
            ),
            None
        );
    }

    #[test]
    fn system_audio_reconnect_follows_the_current_default_output() {
        let sources = "1\tmicrophone\n2\told.monitor\n3\tnew.monitor\n";
        assert_eq!(
            pulse_input_route_destination(
                sources,
                PulseInputRole::SystemAudio,
                Some("microphone"),
                Some("new")
            ),
            Some((3, "new.monitor".to_string()))
        );
    }
    use crate::feeds::microphone::MicrophoneFeed;
    use cap_timestamp::{Timestamp, Timestamps};
    use kameo::Actor as _;
    use std::{
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
        time::{Duration, Instant},
    };

    #[test]
    fn ambiguous_loopback_waits_for_verified_pulse_monitor() {
        let devices = ["Loopback", "pulse", "default"].map(str::to_string);

        assert_eq!(preferred_system_audio_device(&devices, false), None);
        assert_eq!(
            preferred_system_audio_device(&devices, true),
            Some("Loopback")
        );
    }

    #[test]
    fn explicit_monitor_and_stereo_mix_remain_direct_inputs() {
        let devices = ["Loopback", "Stereo Mix", "Output Monitor"].map(str::to_string);

        assert_eq!(
            preferred_system_audio_device(&devices, false),
            Some("Output Monitor")
        );

        let devices = ["Loopback", "Stereo Mix"].map(str::to_string);

        assert_eq!(
            preferred_system_audio_device(&devices, false),
            Some("Stereo Mix")
        );
    }

    #[test]
    fn default_sink_monitor_precedes_other_monitor_sources() {
        let default =
            pactl_monitor_preference("cap_validation_sink.monitor", Some("cap_validation_sink"));
        let suspended = pactl_monitor_preference(
            "alsa_output.platform-snd_aloop.monitor",
            Some("cap_validation_sink"),
        );

        assert_eq!(default, Some((0, 0)));
        assert_eq!(suspended, Some((1, 0)));
        assert!(default < suspended);
        assert_eq!(
            pactl_monitor_preference("cap_validation_sink.monitor", None),
            Some((1, 0))
        );
    }

    #[test]
    fn source_outputs_only_include_the_current_process() {
        let outputs = serde_json::json!([
            { "index": 11, "source": 5, "properties": { "application.process.id": "41" } },
            { "index": 12, "source": 6, "properties": { "application.process.id": "42" } },
            { "index": 13, "source": 7, "properties": { "application.process.id": "42" } }
        ]);

        assert_eq!(
            process_source_output_ids(outputs.as_array().unwrap(), "42").unwrap(),
            vec![
                PactlSourceOutput { id: 12, source: 6 },
                PactlSourceOutput { id: 13, source: 7 }
            ]
        );
    }

    #[test]
    fn only_one_new_system_audio_stream_is_accepted() {
        let previous = [PactlSourceOutput { id: 11, source: 3 }];
        let current = [
            PactlSourceOutput { id: 11, source: 2 },
            PactlSourceOutput { id: 12, source: 2 },
        ];

        assert_eq!(
            newly_created_source_output(&previous, &current).unwrap(),
            12
        );
        assert!(newly_created_source_output(&previous, &previous).is_err());

        let ambiguous = [
            PactlSourceOutput { id: 11, source: 2 },
            PactlSourceOutput { id: 12, source: 2 },
            PactlSourceOutput { id: 13, source: 2 },
        ];

        assert!(newly_created_source_output(&previous, &ambiguous).is_err());
    }

    #[test]
    fn default_input_waits_for_capture_instead_of_selecting_a_probe_stream() {
        let previous = [PactlSourceOutput { id: 11, source: 3 }];
        let probing = [
            PactlSourceOutput { id: 11, source: 3 },
            PactlSourceOutput { id: 12, source: 3 },
        ];
        let capturing = [
            PactlSourceOutput { id: 11, source: 3 },
            PactlSourceOutput { id: 13, source: 2 },
        ];

        assert_eq!(
            started_input_source_output(&previous, &probing, false).unwrap(),
            None
        );
        assert_eq!(
            started_input_source_output(&previous, &capturing, true).unwrap(),
            Some(13)
        );
        assert_eq!(
            started_input_source_output(&previous, &previous, true).unwrap(),
            None
        );
    }

    #[test]
    fn pulse_input_accepts_a_buffered_first_callback() {
        let observed = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let callback = scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(650));
                observed.store(true, Ordering::Release);
            });
            let output =
                wait_for_started_source_output(&[], &observed, &CancellationToken::new(), || {
                    Ok(vec![PactlSourceOutput { id: 12, source: 3 }])
                });
            callback.join().unwrap();
            assert_eq!(output.unwrap(), PactlSourceOutput { id: 12, source: 3 });
        });
    }

    #[tokio::test]
    async fn system_audio_retries_initial_input_connection_failures() {
        let attempts = AtomicUsize::new(0);
        let closed = AtomicUsize::new(0);
        let input = retry_system_audio_connection(
            || {
                let attempt = attempts.fetch_add(1, Ordering::Relaxed);
                assert_eq!(closed.load(Ordering::Relaxed), attempt);
                std::future::ready(if attempt == 0 {
                    Err(anyhow::anyhow!("Default input route was not applied"))
                } else {
                    Ok(42)
                })
            },
            || {
                closed.fetch_add(1, Ordering::Relaxed);
                std::future::ready(Ok(()))
            },
        )
        .await
        .unwrap();

        assert_eq!(input, 42);
        assert_eq!(attempts.load(Ordering::Relaxed), 2);
        assert_eq!(closed.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn system_audio_connection_retries_are_bounded_and_close_the_final_input() {
        let attempts = AtomicUsize::new(0);
        let closed = AtomicUsize::new(0);
        let result = retry_system_audio_connection(
            || {
                attempts.fetch_add(1, Ordering::Relaxed);
                std::future::ready(Err::<(), _>(anyhow::anyhow!("Input route was not applied")))
            },
            || {
                closed.fetch_add(1, Ordering::Relaxed);
                std::future::ready(Ok(()))
            },
        )
        .await;

        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::Relaxed), 3);
        assert_eq!(closed.load(Ordering::Relaxed), 3);
    }

    #[tokio::test]
    async fn system_audio_does_not_reconnect_when_the_previous_input_cannot_close() {
        let attempts = AtomicUsize::new(0);
        let result = retry_system_audio_connection(
            || {
                attempts.fetch_add(1, Ordering::Relaxed);
                std::future::ready(Err::<(), _>(anyhow::anyhow!("Input route was not applied")))
            },
            || std::future::ready(Err(anyhow::anyhow!("Input is still locked"))),
        )
        .await;

        assert_eq!(result.unwrap_err().to_string(), "Input is still locked");
        assert_eq!(attempts.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn system_audio_waits_for_samples_captured_after_the_route_change() {
        let routed_at = Timestamps::now();
        let (sender, receiver) = flume::bounded(2);
        sender
            .send(Timestamp::Instant(
                routed_at
                    .instant()
                    .checked_sub(Duration::from_millis(100))
                    .unwrap(),
            ))
            .unwrap();
        let ready = wait_for_audio_after_route(receiver.stream(), routed_at);
        tokio::pin!(ready);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut ready)
                .await
                .is_err()
        );
        sender.send(Timestamp::Instant(Instant::now())).unwrap();
        ready.await.unwrap();
    }

    #[tokio::test]
    async fn system_audio_readiness_rejects_a_closed_input() {
        let result = wait_for_audio_after_route(futures::stream::empty(), Timestamps::now()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn system_audio_releases_its_feed_even_when_other_references_remain() {
        let (error_tx, _error_rx) = flume::bounded(1);
        let feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx));
        feed.wait_for_startup().await;
        assert!(feed.is_alive());

        let owned = OwnedSystemAudioFeed {
            actor: feed.clone(),
            build_scope: None,
            stopped: false,
        };
        drop(owned);

        tokio::time::timeout(Duration::from_secs(1), feed.wait_for_stop())
            .await
            .unwrap();
        assert!(!feed.is_alive());
    }

    #[tokio::test]
    async fn failed_resume_scope_joins_its_private_system_audio_actor_shutdown() {
        let (error_tx, _error_rx) = flume::bounded(1);
        let feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx));
        feed.wait_for_startup().await;
        let scope = crate::output_pipeline::PipelineBuildScope::new();
        let owned = scope
            .run(async {
                OwnedSystemAudioFeed {
                    actor: feed.clone(),
                    build_scope: crate::output_pipeline::PipelineBuildScope::current(),
                    stopped: false,
                }
            })
            .await;
        drop(owned);
        tokio::time::timeout(Duration::from_secs(1), scope.cancel_and_join())
            .await
            .unwrap()
            .unwrap();
        assert!(!feed.is_alive());
    }

    #[test]
    fn remembered_monitor_input_returns_to_selected_microphone() {
        assert_eq!(
            previous_source_destination(2, 2, "desktop.monitor", Some("microphone.monitor")),
            "microphone.monitor"
        );
        assert_eq!(
            previous_source_destination(7, 2, "desktop.monitor", Some("microphone.monitor")),
            "7"
        );
        assert_eq!(
            previous_source_destination(2, 2, "desktop.monitor", Some("desktop.monitor")),
            "2"
        );
        assert_eq!(
            previous_source_destination(2, 2, "desktop.monitor", None),
            "2"
        );
    }

    #[test]
    fn correctly_routed_streams_are_not_interrupted() {
        assert!(!source_output_needs_move(2, Some(2)));
        assert!(source_output_needs_move(2, Some(3)));
        assert!(source_output_needs_move(2, None));

        let sources = "2 desktop.monitor module-null-sink\n3 microphone.monitor module-null-sink";
        assert_eq!(pactl_source_index(sources, "microphone.monitor"), Some(3));
        assert_eq!(pactl_source_index(sources, "missing.monitor"), None);
    }

    #[test]
    fn routing_acknowledgement_requires_the_requested_source() {
        let unchanged = [PactlSourceOutput {
            id: 1128,
            source: 61,
        }];
        let routed = [PactlSourceOutput {
            id: 1128,
            source: 47,
        }];

        assert!(!source_output_route_matches(&unchanged, 1128, 47).unwrap());
        assert!(source_output_route_matches(&routed, 1128, 47).unwrap());
        assert!(source_output_route_matches(&[], 1128, 47).is_err());
        assert!(source_output_route_matches(&routed, 1129, 47).is_err());
    }

    #[test]
    fn only_generic_pulse_devices_follow_the_default_input() {
        assert!(uses_default_pulse_input("default"));
        assert!(uses_default_pulse_input("PULSE"));
        assert!(!uses_default_pulse_input("USB Microphone"));
        assert!(!uses_default_pulse_input("desktop.monitor"));
        assert!(!uses_default_pulse_input("hw:1,0"));
        assert!(!uses_default_pulse_input("pipewire"));
    }
}

#[cfg(test)]
mod pipewire_frame_tests {
    use super::{FrameScaler, VideoInfo, prefers_wayland_environment, prepare_pipewire_frame};

    #[test]
    fn active_wayland_sessions_use_the_portal_even_with_xwayland() {
        assert!(prefers_wayland_environment(true, false, None));
        assert!(prefers_wayland_environment(true, true, Some("wayland")));
        assert!(prefers_wayland_environment(true, true, Some("Wayland")));
        assert!(!prefers_wayland_environment(true, true, Some("x11")));
        assert!(!prefers_wayland_environment(true, true, None));
        assert!(!prefers_wayland_environment(false, true, Some("wayland")));
    }

    #[test]
    fn matching_pipewire_frames_reuse_owned_pixel_storage_without_a_scaler() {
        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRZ, 16, 12);
        frame.set_pts(Some(73));
        let source = frame.data(0).as_ptr();
        let output = VideoInfo::from_raw_ffmpeg(ffmpeg::format::Pixel::BGRZ, 16, 12, 60);
        let mut scaler: Option<FrameScaler> = None;

        let prepared = prepare_pipewire_frame(frame, &mut scaler, output).unwrap();

        assert_eq!(prepared.data(0).as_ptr(), source);
        assert_eq!(prepared.format(), ffmpeg::format::Pixel::BGRZ);
        assert_eq!(prepared.pts(), Some(73));
        assert!(scaler.is_none());
    }

    #[test]
    fn mismatched_pipewire_pixel_formats_are_converted() {
        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBZ, 16, 12);
        frame.set_pts(Some(31));
        let output = VideoInfo::from_raw_ffmpeg(ffmpeg::format::Pixel::BGRZ, 16, 12, 60);
        let mut scaler: Option<FrameScaler> = None;

        let prepared = prepare_pipewire_frame(frame, &mut scaler, output).unwrap();

        assert_eq!(prepared.format(), ffmpeg::format::Pixel::BGRZ);
        assert_eq!((prepared.width(), prepared.height()), (16, 12));
        assert_eq!(prepared.pts(), Some(31));
        assert!(scaler.is_some());
    }

    #[test]
    fn mismatched_pipewire_dimensions_are_scaled() {
        let frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRZ, 16, 12);
        let output = VideoInfo::from_raw_ffmpeg(ffmpeg::format::Pixel::BGRZ, 8, 6, 60);
        let mut scaler: Option<FrameScaler> = None;

        let prepared = prepare_pipewire_frame(frame, &mut scaler, output).unwrap();

        assert_eq!(prepared.format(), ffmpeg::format::Pixel::BGRZ);
        assert_eq!((prepared.width(), prepared.height()), (8, 6));
        assert!(scaler.is_some());
    }
}
