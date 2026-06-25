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
use ffmpeg::codec::packet::Packet;
use futures::channel::mpsc;
use kameo::Actor as _;
use pipewire as pw;
use pw::{properties::properties, spa};
use std::{
    ffi::CString,
    os::fd::OwnedFd,
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

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

enum LinuxInputConfig {
    X11(X11InputConfig),
    Wayland(WaylandInputConfig),
}

pub(crate) struct X11InputConfig {
    pub display_name: String,
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
        let system_audio = if self.system_audio {
            Some(create_system_audio_source_config().await?)
        } else {
            None
        };

        if prefers_wayland_portal() {
            match create_wayland_source_config(self).await {
                Ok((video_info, input)) => {
                    return Ok((
                        VideoSourceConfig {
                            video_info,
                            input: LinuxInputConfig::Wayland(input),
                        },
                        system_audio,
                    ));
                }
                Err(error) if std::env::var_os("DISPLAY").is_some() => {
                    tracing::warn!(
                        error = %error,
                        "Wayland portal capture failed; falling back to X11 capture"
                    );
                }
                Err(error) => return Err(error),
            }
        }

        let display =
            Display::from_id(&self.config.display).ok_or_else(|| anyhow!("Display not found"))?;
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
        let video_info = VideoInfo {
            width,
            height,
            ..self.video_info
        };

        Ok((
            VideoSourceConfig {
                video_info,
                input: LinuxInputConfig::X11(X11InputConfig {
                    display_name: std::env::var("DISPLAY").unwrap_or_else(|_| ":0".to_string()),
                    x,
                    y,
                    width,
                    height,
                    fps: self.config.fps,
                    show_cursor: self.config.show_cursor,
                }),
            },
            system_audio,
        ))
    }
}

pub(crate) fn x11_capture_rect(
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
                ctx.tasks().spawn_thread("x11grab-capture-thread", {
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
    let portal = open_wayland_portal(config.config.linux_source, config.config.show_cursor).await?;
    let crop_bounds = match config.config.linux_source {
        LinuxCaptureSource::Area => config.config.crop_bounds,
        LinuxCaptureSource::Display | LinuxCaptureSource::Window => None,
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
    source: LinuxCaptureSource,
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

fn prefers_wayland_portal() -> bool {
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return false;
    }

    std::env::var_os("DISPLAY").is_none()
        || std::env::var("XDG_SESSION_TYPE")
            .is_ok_and(|session| session.eq_ignore_ascii_case("wayland"))
}

fn wayland_source_type(source: LinuxCaptureSource) -> ashpd::enumflags2::BitFlags<SourceType> {
    match source {
        LinuxCaptureSource::Window => SourceType::Window.into(),
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

    let raw_frame = frame_from_pipewire_data(&mut datas[0], state.format, state.crop_bounds)?;
    if state.scaler.is_none() {
        state.scaler = Some(FrameScaler::new(
            raw_frame.format(),
            raw_frame.width(),
            raw_frame.height(),
            state.video_info,
        )?);
    }
    let frame = state
        .scaler
        .as_mut()
        .expect("PipeWire frame scaler initialized")
        .scale(&raw_frame, state.video_info)?;
    let timestamp = Timestamp::Instant(Instant::now());

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

fn frame_from_pipewire_data(
    data: &mut spa::buffer::Data,
    format: spa::param::video::VideoInfoRaw,
    crop_bounds: Option<CropBounds>,
) -> anyhow::Result<ffmpeg::frame::Video> {
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
        bail!("PipeWire screen capture frame was marked corrupted");
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

    Ok(frame)
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
    restore_source: Option<String>,
}

pub struct SystemAudioSource {
    inner: crate::sources::Microphone,
    restore_source: Option<String>,
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
        let restore_source = config.restore_source;
        let setup = <crate::sources::Microphone as AudioSource>::setup(config.feed_lock, tx, ctx);
        async move {
            let inner = setup
                .await
                .with_context(|| format!("set up Linux system audio source '{device_name}'"))?;

            Ok(Self {
                inner,
                restore_source,
            })
        }
    }

    fn audio_info(&self) -> AudioInfo {
        self.inner.audio_info()
    }

    fn stop(&mut self) -> impl std::future::Future<Output = anyhow::Result<()>> + Send {
        let restore_source = self.restore_source.take();
        let stop = self.inner.stop();
        async move {
            let result = stop.await;
            if let Some(source) = restore_source {
                restore_pactl_default_source(&source);
            }
            result
        }
    }
}

async fn create_system_audio_source_config() -> anyhow::Result<SystemAudioSourceConfig> {
    let selected = select_system_audio_monitor()?;

    let (error_tx, _error_rx) = flume::bounded(16);
    let feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx));
    feed.ask(microphone::SetInput {
        label: selected.device_name.clone(),
        settings: None,
    })
    .await
    .map_err(|e| anyhow!("Failed to set Linux system audio input: {e}"))?
    .await
    .with_context(|| {
        format!(
            "Linux system audio input '{}' failed to connect",
            selected.device_name
        )
    })?;

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let lock = feed
        .ask(microphone::Lock)
        .await
        .map_err(|e| anyhow!("Failed to lock Linux system audio input: {e}"))?;

    Ok(SystemAudioSourceConfig {
        feed_lock: Arc::new(lock),
        device_name: selected.device_name,
        restore_source: selected.restore_source,
    })
}

impl Drop for SystemAudioSource {
    fn drop(&mut self) {
        if let Some(source) = self.restore_source.take() {
            restore_pactl_default_source(&source);
        }
    }
}

struct SelectedSystemAudioInput {
    device_name: String,
    restore_source: Option<String>,
}

fn select_system_audio_monitor() -> anyhow::Result<SelectedSystemAudioInput> {
    let devices = MicrophoneFeed::list();
    let available = devices.keys().cloned().collect::<Vec<_>>();

    let mut candidates = devices
        .iter()
        .filter_map(|(name, device)| {
            system_audio_device_rank(&name).map(|rank| (rank, name, device))
        })
        .collect::<Vec<_>>();

    candidates.sort_by_key(|(rank, name, _)| (*rank, name.to_ascii_lowercase()));

    if let Some((_, name, _)) = candidates.into_iter().next() {
        return Ok(SelectedSystemAudioInput {
            device_name: name.to_string(),
            restore_source: None,
        });
    }

    if let Some(selected) = select_pactl_monitor_source(&available)? {
        return Ok(selected);
    }

    Err(anyhow!(
        "No PulseAudio/PipeWire monitor input was found for Linux system audio. \
        Available input devices: {available:?}. Select a monitor source with --mic, or enable a monitor source in your audio server."
    ))
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
    let Some(device_name) = pulse_cpal_device_name(available_devices) else {
        return Ok(None);
    };

    let output = match Command::new("pactl")
        .args(["list", "short", "sources"])
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return Ok(None),
    };

    let sources = String::from_utf8_lossy(&output.stdout);
    let mut monitor_sources = sources
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .filter_map(|name| pactl_monitor_rank(name).map(|rank| (rank, name.to_string())))
        .collect::<Vec<_>>();
    monitor_sources.sort_by_key(|(rank, name)| (*rank, name.to_ascii_lowercase()));

    let Some((_, source)) = monitor_sources.into_iter().next() else {
        return Ok(None);
    };

    let previous_source = pactl_default_source();
    let restore_source = if previous_source.as_deref() == Some(source.as_str()) {
        None
    } else {
        set_pactl_default_source(&source)?;
        previous_source
    };

    Ok(Some(SelectedSystemAudioInput {
        device_name,
        restore_source,
    }))
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

fn pactl_default_source() -> Option<String> {
    let output = Command::new("pactl")
        .arg("get-default-source")
        .output()
        .ok()?;

    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|source| !source.is_empty())
}

fn set_pactl_default_source(source: &str) -> anyhow::Result<()> {
    let status = Command::new("pactl")
        .args(["set-default-source", source])
        .status()
        .context("run pactl set-default-source")?;

    status
        .success()
        .then_some(())
        .ok_or_else(|| anyhow!("pactl set-default-source '{source}' failed"))
}

fn restore_pactl_default_source(source: &str) {
    if let Err(error) = set_pactl_default_source(source) {
        tracing::warn!(
            source,
            error = %error,
            "Failed to restore PulseAudio/PipeWire default source after Linux system audio capture"
        );
    }
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
    video_info: VideoInfo,
    input_config: X11InputConfig,
    mut video_tx: mpsc::Sender<FFmpegVideoFrame>,
    stop_token: CancellationToken,
    health_tx: output_pipeline::HealthSender,
) -> anyhow::Result<()> {
    let mut input = open_x11_input(&input_config)?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| anyhow!("x11grab did not expose a video stream"))?;
    let stream_index = stream.index();
    let mut scaler = FrameScaler::new(
        video_info.pixel_format,
        video_info.width,
        video_info.height,
        video_info,
    )?;
    let started = Instant::now();
    let mut sent = 0u64;
    let mut dropped = 0u64;

    for (stream, packet) in input.packets() {
        if stop_token.is_cancelled() {
            break;
        }
        if stream.index() != stream_index {
            continue;
        }

        let raw_frame = frame_from_x11_packet(&packet, input_config.width, input_config.height)?;
        let frame = scaler.scale(&raw_frame, video_info)?;
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
    }

    tracing::info!(
        sent,
        dropped,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "Linux X11 capture stopped"
    );

    Ok(())
}

pub(crate) fn frame_from_x11_packet(
    packet: &Packet,
    width: u32,
    height: u32,
) -> anyhow::Result<ffmpeg::frame::Video> {
    let data = packet
        .data()
        .ok_or_else(|| anyhow!("x11grab packet did not contain frame data"))?;
    let source_stride = width as usize * 4;
    let expected_len = source_stride * height as usize;
    if data.len() < expected_len {
        bail!(
            "x11grab packet was too small: {} bytes for {}x{}",
            data.len(),
            width,
            height
        );
    }

    let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRZ, width, height);
    let target_stride = frame.stride(0);
    if target_stride < source_stride {
        bail!(
            "x11grab frame stride was too small: {} for {}x{}",
            target_stride,
            width,
            height
        );
    }

    for y in 0..height as usize {
        let source_start = y * source_stride;
        let target_start = y * target_stride;
        let target_end = target_start + source_stride;
        frame.data_mut(0)[target_start..target_end]
            .copy_from_slice(&data[source_start..source_start + source_stride]);
    }

    frame.set_pts(packet.pts());
    Ok(frame)
}

pub(crate) fn open_x11_input(
    config: &X11InputConfig,
) -> anyhow::Result<ffmpeg::format::context::Input> {
    ffmpeg::init().context("initialize FFmpeg")?;

    let format_name = CString::new("x11grab")?;
    let input_format = unsafe {
        let ptr = ffmpeg::ffi::av_find_input_format(format_name.as_ptr());
        if ptr.is_null() {
            bail!("FFmpeg was built without x11grab input support");
        }
        ffmpeg::format::Input::wrap(ptr as *mut _)
    };

    let source = format!("{}+{},{}", config.display_name, config.x, config.y);
    let mut options = ffmpeg::Dictionary::new();
    options.set("framerate", &config.fps.to_string());
    options.set("video_size", &format!("{}x{}", config.width, config.height));
    options.set("draw_mouse", if config.show_cursor { "1" } else { "0" });

    Ok(
        ffmpeg::format::open_with(&source, &ffmpeg::Format::Input(input_format), options)
            .with_context(|| {
                format!(
                    "open x11grab source {source} at {}x{}",
                    config.width, config.height
                )
            })?
            .input(),
    )
}
