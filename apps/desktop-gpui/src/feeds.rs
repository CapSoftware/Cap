//! App-scoped device feeds -- the gpui counterpart of the Tauri `App` state's
//! `camera_feed` / `mic_feed`.
//!
//! Selecting a camera spins the feed up and opens the preview window
//! immediately, before any recording exists; selecting a microphone keeps a
//! meter running so the pickers and the recording bar can show a live level.
//! A recording then locks the *already running* feeds (`feeds::camera::Lock` /
//! `feeds::microphone::Lock`), exactly like `src-tauri/src/recording.rs`.
//!
//! Threading: kameo actors live on the tokio runtime, so every actor message
//! goes through `gpui_tokio::Tokio::spawn`. Frame and sample pumps await their
//! flume channels on the foreground executor -- each frame has to land on the
//! main thread anyway to repaint, so draining there avoids a second hop.

use std::time::{Duration, Instant};

#[cfg(any(not(target_os = "macos"), test))]
use std::sync::Arc;
#[cfg(not(target_os = "macos"))]
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use cap_recording::feeds::{
    camera::{self, CameraFeed},
    microphone::{self, MicrophoneFeed, MicrophoneSamples},
};
use gpui::{App, AppContext as _, Context, Entity, Global};
use kameo::{Actor as _, actor::ActorRef};

pub use cap_recording::feeds::camera::DeviceOrModelID;

use crate::app_windows;

/// How the pickers map dB to a 0..1 bar: `DeviceListPanel` in `index.tsx`
/// (`DB_SCALE = 40`, inverted, square-rooted). 1 = silence, 0 = full scale --
/// the overlay's `right` offset, kept in the same orientation as the web app.
pub fn picker_level(db: f64) -> f64 {
    (1.0 - ((db + 40.0).max(0.0) / 40.0)).max(0.0).sqrt()
}

/// How the recording bar maps dB to its little track: `createAudioInputLevel`
/// in `in-progress-recording.tsx` (-60..0 dB, linear, 0 = silence).
pub fn bar_level(db: f64) -> f64 {
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}

pub struct Feeds {
    camera_actor: Option<ActorRef<CameraFeed>>,
    mic_actor: Option<ActorRef<MicrophoneFeed>>,
    /// Selected camera; `Some` while the preview window should exist.
    pub camera: Option<SelectedCamera>,
    /// Selected microphone name.
    pub microphone: Option<String>,
    /// Rolling 200ms max of the mic level, in dB FS. `-96` when silent/absent.
    pub mic_level_db: f64,
    pub camera_error: Option<String>,
    camera_preview_parked: bool,
    /// Bumped on every camera/mic selection change; async completions from a
    /// previous selection see a stale epoch and drop their result.
    camera_epoch: u64,
    mic_epoch: u64,
    #[cfg(not(target_os = "macos"))]
    camera_preview_mirrored: Arc<AtomicBool>,
    #[cfg(not(target_os = "macos"))]
    camera_preview_active: Arc<AtomicBool>,
    #[cfg(not(target_os = "macos"))]
    camera_preview_blur: Arc<AtomicU8>,
    #[cfg(not(target_os = "macos"))]
    camera_preview_reset: Option<flume::Sender<()>>,
    // Channel-holding tasks; dropping them ends the pumps.
    _frame_pump: Option<gpui::Task<()>>,
    _meter_pump: Option<gpui::Task<()>>,
    // The mic error channel must outlive the stream (see recording.rs).
    _mic_errors: Option<flume::Receiver<cpal::StreamError>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SelectedCamera {
    pub id: DeviceOrModelID,
    pub label: String,
}

struct FeedsGlobal(Entity<Feeds>);
impl Global for FeedsGlobal {}

impl Feeds {
    pub fn init(cx: &mut App) -> Entity<Self> {
        let feeds = cx.new(|_| Self {
            camera_actor: None,
            mic_actor: None,
            camera: None,
            microphone: None,
            mic_level_db: -96.0,
            camera_error: None,
            camera_preview_parked: false,
            camera_epoch: 0,
            mic_epoch: 0,
            #[cfg(not(target_os = "macos"))]
            camera_preview_mirrored: Arc::new(AtomicBool::new(false)),
            #[cfg(not(target_os = "macos"))]
            camera_preview_active: Arc::new(AtomicBool::new(true)),
            #[cfg(not(target_os = "macos"))]
            camera_preview_blur: Arc::new(AtomicU8::new(0)),
            #[cfg(not(target_os = "macos"))]
            camera_preview_reset: None,
            _frame_pump: None,
            _meter_pump: None,
            _mic_errors: None,
        });
        cx.set_global(FeedsGlobal(feeds.clone()));
        feeds
    }

    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<FeedsGlobal>().0.clone()
    }

    /// The live actors, for a recording to lock. `None` when nothing is
    /// selected (or the actor died -- `recording::start` falls back to a
    /// per-recording feed in that case).
    pub fn camera_actor(&self) -> Option<ActorRef<CameraFeed>> {
        if self.camera_preview_parked {
            return None;
        }
        self.camera.as_ref()?;
        self.camera_actor.clone().filter(|actor| actor.is_alive())
    }

    pub fn mic_actor(&self) -> Option<ActorRef<MicrophoneFeed>> {
        self.microphone.as_ref()?;
        self.mic_actor.clone().filter(|actor| actor.is_alive())
    }

    #[cfg(not(target_os = "macos"))]
    pub fn set_camera_preview_state(&self, mirrored: bool, blur: crate::store::BlurMode) {
        self.camera_preview_mirrored
            .store(mirrored, Ordering::Relaxed);
        self.camera_preview_blur.store(
            match blur {
                crate::store::BlurMode::Off => 0,
                crate::store::BlurMode::Light => 1,
                crate::store::BlurMode::Heavy => 2,
            },
            Ordering::Relaxed,
        );
    }

    /// Select (or deselect) the camera. Opens/closes the preview window and
    /// points the app-scoped feed at the device.
    pub fn set_camera(&mut self, selection: Option<SelectedCamera>, cx: &mut Context<Self>) {
        if self.camera == selection {
            return;
        }
        self.camera_epoch += 1;
        self.camera = selection.clone();
        self.camera_error = None;
        cx.notify();

        match selection {
            Some(selection) if !self.camera_preview_parked => {
                self.start_camera_preview(selection, cx);
            }
            Some(_) => {}
            None => {
                if let Some(actor) = self.camera_actor.clone() {
                    gpui_tokio::Tokio::spawn(cx, async move {
                        let _ = actor.ask(camera::RemoveInput).await;
                    })
                    .detach();
                }
                cx.defer(app_windows::close_camera_window);
            }
        }
    }

    pub fn park_camera_preview(&mut self, cx: &mut Context<Self>) {
        if self.camera_preview_parked {
            return;
        }

        self.camera_preview_parked = true;
        self.camera_epoch += 1;

        #[cfg(not(target_os = "macos"))]
        {
            self.camera_preview_active.store(false, Ordering::Release);
            if let Some(reset) = &self.camera_preview_reset {
                let _ = reset.try_send(());
            }
        }

        if let Some(actor) = self.camera_actor.clone() {
            gpui_tokio::Tokio::spawn(cx, async move {
                if let Err(error) = actor.ask(camera::RemoveInput).await {
                    tracing::warn!("parking the camera preview: {error}");
                }
            })
            .detach();
        }

        tracing::info!("camera preview parked");
    }

    pub fn resume_camera_preview(&mut self, cx: &mut Context<Self>) {
        if !self.camera_preview_parked {
            return;
        }

        self.camera_preview_parked = false;
        #[cfg(not(target_os = "macos"))]
        self.camera_preview_active.store(true, Ordering::Release);
        if let Some(selection) = self.camera.clone() {
            self.camera_epoch += 1;
            self.start_camera_preview(selection, cx);
            tracing::info!("camera preview resumed");
        }
    }

    fn start_camera_preview(&mut self, selection: SelectedCamera, cx: &mut Context<Self>) {
        let epoch = self.camera_epoch;
        let actor = self.ensure_camera_actor(cx);
        let set = gpui_tokio::Tokio::spawn(cx, async move {
            let ready = actor
                .ask(camera::SetInput {
                    id: selection.id,
                    settings: None,
                })
                .await
                .map_err(|error| error.to_string())?;
            ready.await.map_err(|error| error.to_string())
        });
        cx.spawn(async move |this, cx| {
            let result = match set.await {
                Ok(result) => result.map(|_| ()),
                Err(error) => Err(error.to_string()),
            };
            this.update(cx, |this, cx| {
                if this.camera_epoch != epoch {
                    return;
                }
                if let Err(error) = result {
                    tracing::error!("camera input failed: {error}");
                    this.camera_error = Some(error);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.defer(app_windows::open_camera_window);
    }

    /// Select (or deselect) the microphone. The feed keeps running between
    /// recordings so the pickers and bar have a live level.
    pub fn set_microphone(&mut self, label: Option<String>, cx: &mut Context<Self>) {
        if self.microphone == label {
            return;
        }
        self.mic_epoch += 1;
        self.microphone = label.clone();
        self.mic_level_db = -96.0;
        cx.notify();

        let actor = self.ensure_mic_actor(cx);
        match label {
            Some(label) => {
                gpui_tokio::Tokio::spawn(cx, async move {
                    match actor
                        .ask(microphone::SetInput {
                            label: label.clone(),
                            settings: None,
                        })
                        .await
                    {
                        Ok(ready) => {
                            if let Err(error) = ready.await {
                                tracing::warn!("microphone '{label}' failed to open: {error}");
                            }
                        }
                        Err(error) => {
                            tracing::warn!("microphone '{label}' set-input failed: {error}")
                        }
                    }
                })
                .detach();
            }
            None => {
                gpui_tokio::Tokio::spawn(cx, async move {
                    let _ = actor.ask(microphone::RemoveInput).await;
                })
                .detach();
            }
        }
    }

    /// Drop the live camera and microphone inputs without forgetting what was
    /// selected.
    ///
    /// `CapWindowId::Main`'s `CloseRequested` arm (`lib.rs:5666-5697`): when
    /// nothing is recording, hiding the main window pauses the camera preview
    /// and `ask`s both feeds for `RemoveInput`. It does *not* clear the
    /// frontend's `rawOptions` -- the pickers still show the device that was
    /// chosen -- so neither does this: only the hardware is released.
    pub fn release_inputs(&mut self, cx: &mut Context<Self>) {
        if let Some(actor) = self.camera_actor.clone() {
            gpui_tokio::Tokio::spawn(cx, async move {
                if let Err(error) = actor.ask(camera::RemoveInput).await {
                    tracing::warn!("releasing the camera feed: {error}");
                }
            })
            .detach();
        }
        if let Some(actor) = self.mic_actor.clone() {
            gpui_tokio::Tokio::spawn(cx, async move {
                if let Err(error) = actor.ask(microphone::RemoveInput).await {
                    tracing::warn!("releasing the microphone feed: {error}");
                }
            })
            .detach();
        }
        self.mic_level_db = -96.0;
        cx.notify();
    }

    fn ensure_camera_actor(&mut self, cx: &mut Context<Self>) -> ActorRef<CameraFeed> {
        if let Some(actor) = self.camera_actor.clone()
            && actor.is_alive()
        {
            return actor;
        }

        // kameo spawns onto the ambient tokio runtime; this method runs on
        // gpui's main thread, so enter the gpui_tokio runtime first or the
        // spawn panics (unwind across the objc frame aborts the process).
        let actor = {
            let _runtime = gpui_tokio::Tokio::handle(cx).enter();
            CameraFeed::spawn(CameraFeed::default())
        };

        // The preview channel: bounded(4) so a stalled UI drops frames instead
        // of ballooning; the pump drains on the main thread and hands each
        // frame straight to the camera window.
        #[cfg(target_os = "macos")]
        let pump = {
            let (frame_tx, frame_rx) = flume::bounded::<cap_recording::NativeCameraFrame>(4);
            {
                let actor = actor.clone();
                gpui_tokio::Tokio::spawn(cx, async move {
                    if let Err(error) = actor.ask(camera::AddNativeSender(frame_tx)).await {
                        tracing::error!("attaching camera preview sender: {error}");
                    }
                })
                .detach();
            }

            cx.spawn(async move |_this, cx| {
                while let Ok(frame) = frame_rx.recv_async().await {
                    cx.update(|cx| app_windows::deliver_camera_frame(frame, cx));
                }
            })
        };

        #[cfg(not(target_os = "macos"))]
        let pump = {
            let (frame_tx, frame_rx) = flume::bounded::<cap_recording::FFmpegVideoFrame>(4);
            let (preview_tx, preview_rx) = flume::bounded(2);
            let (reset_tx, reset_rx) = flume::bounded(1);
            self.camera_preview_reset = Some(reset_tx);
            let mirrored = self.camera_preview_mirrored.clone();
            let active = self.camera_preview_active.clone();
            let blur = self.camera_preview_blur.clone();
            if let Err(error) = std::thread::Builder::new()
                .name("camera-preview".into())
                .spawn(move || {
                    let mut scaler = None;
                    let mut processor = None;
                    let mut previous_blur = 0;
                    let mut blur_failed = false;
                    loop {
                        let received = flume::Selector::new()
                            .recv(&frame_rx, |result| result.map(Some))
                            .recv(&reset_rx, |result| result.map(|()| None))
                            .wait();
                        let mut frame = match received {
                            Ok(Some(frame)) => frame,
                            Ok(None) => {
                                scaler = None;
                                processor = None;
                                previous_blur = 0;
                                blur_failed = false;
                                continue;
                            }
                            Err(_) => break,
                        };
                        if !active.load(Ordering::Acquire) {
                            continue;
                        }
                        while let Ok(newer) = frame_rx.try_recv() {
                            frame = newer;
                        }
                        let requested_blur = blur.load(Ordering::Relaxed);
                        if requested_blur != previous_blur {
                            processor = None;
                            blur_failed = false;
                            previous_blur = requested_blur;
                        }
                        let blur_mode = match requested_blur {
                            1 => Some(cap_camera_effects::BlurMode::Light),
                            2 => Some(cap_camera_effects::BlurMode::Heavy),
                            _ => None,
                        }
                        .filter(|_| !blur_failed && crate::camera_blur_portable::blur_allowed());
                        let max_dims = blur_mode.map(|_| crate::camera_blur_portable::MAX_DIMS);
                        let Some((mut image, dims)) = camera_preview_image(
                            &frame.inner,
                            &mut scaler,
                            mirrored.load(Ordering::Relaxed),
                            max_dims,
                        ) else {
                            continue;
                        };
                        if let Some(mode) = blur_mode
                            && !blur_failed
                        {
                            if processor.is_none() {
                                match crate::camera_blur_portable::PortableCameraBlur::new() {
                                    Ok(worker) => {
                                        tracing::info!("camera blur preview initialized");
                                        processor = Some(worker);
                                    }
                                    Err(error) => {
                                        tracing::warn!(
                                            "camera blur preview unavailable: {error:#}"
                                        );
                                        blur_failed = true;
                                    }
                                }
                            }
                            if let Some(worker) = processor.as_mut() {
                                match worker.process(&image, dims, mode) {
                                    Ok(blurred) => image = blurred,
                                    Err(error) => {
                                        tracing::warn!("camera blur preview stopped: {error:#}");
                                        processor = None;
                                        blur_failed = true;
                                    }
                                }
                            }
                        }
                        match preview_tx
                            .try_send(crate::camera_window::CameraPreviewFrame { image, dims })
                        {
                            Ok(()) | Err(flume::TrySendError::Full(_)) => {}
                            Err(flume::TrySendError::Disconnected(_)) => break,
                        }
                    }
                })
            {
                tracing::error!("starting camera preview worker: {error}");
            }

            {
                let actor = actor.clone();
                gpui_tokio::Tokio::spawn(cx, async move {
                    if let Err(error) = actor.ask(camera::AddSender(frame_tx)).await {
                        tracing::error!("attaching camera preview sender: {error}");
                    }
                })
                .detach();
            }

            cx.spawn(async move |_this, cx| {
                while let Ok(frame) = preview_rx.recv_async().await {
                    cx.update(|cx| app_windows::deliver_camera_frame(frame, cx));
                }
            })
        };

        self._frame_pump = Some(pump);
        self.camera_actor = Some(actor.clone());
        actor
    }

    fn ensure_mic_actor(&mut self, cx: &mut Context<Self>) -> ActorRef<MicrophoneFeed> {
        if let Some(actor) = self.mic_actor.clone()
            && actor.is_alive()
        {
            return actor;
        }

        let (error_tx, error_rx) = flume::unbounded();
        self._mic_errors = Some(error_rx);
        // Same runtime-entry requirement as the camera actor above.
        let actor = {
            let _runtime = gpui_tokio::Tokio::handle(cx).enter();
            MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx))
        };

        // Meter channel, attached once for the actor's lifetime -- the same
        // shape as the Tauri `mic_meter_sender`.
        let (meter_tx, meter_rx) = flume::bounded::<MicrophoneSamples>(16);
        {
            let actor = actor.clone();
            gpui_tokio::Tokio::spawn(cx, async move {
                if let Err(error) = actor.ask(microphone::AddSender(meter_tx)).await {
                    tracing::error!("attaching mic meter sender: {error}");
                }
            })
            .detach();
        }

        let pump = cx.spawn(async move |this, cx| {
            // Port of `audio_meter.rs`: a 200ms max-hold window, coalesced to
            // ~20 updates/s so the meter does not repaint the window per audio
            // callback.
            let mut window_entries: Vec<(Instant, f64)> = Vec::new();
            let mut last_push = Instant::now() - Duration::from_secs(1);
            while let Ok(samples) = meter_rx.recv_async().await {
                let now = Instant::now();
                let db = db_fs(&samples);
                window_entries.push((now, db));
                window_entries
                    .retain(|(at, _)| now.duration_since(*at) <= Duration::from_millis(200));
                if now.duration_since(last_push) < Duration::from_millis(50) {
                    continue;
                }
                last_push = now;
                let max = window_entries
                    .iter()
                    .map(|(_, db)| *db)
                    .fold(f64::MIN, f64::max);
                // Quantized to 0.5dB -- under a pixel on both level mappings --
                // so an unchanged level (a silent or absent signal pins at
                // -96.0) stops waking every `Feeds` observer and the controls
                // bar at 20Hz for a bar that would not visibly move.
                let quantized = (max * 2.0).round() / 2.0;
                let changed = this.update(cx, |this: &mut Feeds, cx| {
                    if this.mic_level_db == quantized {
                        return false;
                    }
                    this.mic_level_db = quantized;
                    cx.notify();
                    true
                });
                match changed {
                    Err(_) => return,
                    Ok(true) => {
                        cx.update(app_windows::refresh_controls_window);
                    }
                    Ok(false) => {}
                }
            }
        });
        self._meter_pump = Some(pump);
        self.mic_actor = Some(actor.clone());
        actor
    }
}

#[cfg(any(not(target_os = "macos"), test))]
pub(crate) fn camera_preview_image(
    frame: &ffmpeg::frame::Video,
    scaler: &mut Option<ffmpeg::software::scaling::Context>,
    mirrored: bool,
    max_dims: Option<(u32, u32)>,
) -> Option<(Arc<gpui::RenderImage>, (usize, usize))> {
    let source_width = frame.width();
    let source_height = frame.height();
    let (width, height) = match max_dims {
        Some(max) => {
            crate::camera_blur_portable::fitted_dimensions(source_width, source_height, max)?
        }
        None if source_width > 0 && source_height > 0 => (source_width, source_height),
        None => return None,
    };

    let mut converted = ffmpeg::frame::Video::empty();
    let source = if frame.format() == ffmpeg::format::Pixel::BGRA
        && width == source_width
        && height == source_height
    {
        frame
    } else {
        let definition = scaler.as_ref().map(|context| context.input());
        let output = scaler.as_ref().map(|context| context.output());
        if definition.is_none_or(|input| {
            input.format != frame.format()
                || input.width != source_width
                || input.height != source_height
        }) || output.is_none_or(|output| output.width != width || output.height != height)
        {
            *scaler = Some(
                ffmpeg::software::scaling::Context::get(
                    frame.format(),
                    source_width,
                    source_height,
                    ffmpeg::format::Pixel::BGRA,
                    width,
                    height,
                    ffmpeg::software::scaling::Flags::BILINEAR,
                )
                .ok()?,
            );
        }
        scaler.as_mut()?.run(frame, &mut converted).ok()?;
        &converted
    };

    let width = width as usize;
    let height = height as usize;
    let row_bytes = width.checked_mul(4)?;
    let stride = source.stride(0);
    if stride < row_bytes {
        return None;
    }
    let input = source.data(0);
    if input.len() < height.checked_mul(stride)? {
        return None;
    }
    let mut pixels = vec![0; height.checked_mul(row_bytes)?];
    for (row, output) in pixels.chunks_exact_mut(row_bytes).enumerate() {
        let input = &input[row * stride..row * stride + row_bytes];
        if mirrored {
            for (destination, source) in output.chunks_exact_mut(4).zip(input.chunks_exact(4).rev())
            {
                destination.copy_from_slice(source);
            }
        } else {
            output.copy_from_slice(input);
        }
    }
    let image = image::RgbaImage::from_raw(width as u32, height as u32, pixels)?;
    let image = Arc::new(gpui::RenderImage::new(smallvec::smallvec![
        image::Frame::new(image)
    ]));
    Some((image, (width, height)))
}

/// `db_fs` from `src-tauri/src/audio_meter.rs`: peak of the batch as dB FS,
/// clamped to [-96, 0].
fn db_fs(samples: &MicrophoneSamples) -> f64 {
    use cpal::SampleFormat;

    let sample_size = samples.format.sample_size();
    if sample_size == 0 || samples.data.len() < sample_size {
        return -96.0;
    }
    let peak = samples
        .data
        .chunks_exact(sample_size)
        .map(|data| {
            let value: f64 = match samples.format {
                SampleFormat::I8 => i8::from_ne_bytes([data[0]]) as f64 / i8::MAX as f64,
                SampleFormat::U8 => u8::from_ne_bytes([data[0]]) as f64 / u8::MAX as f64 - 0.5,
                SampleFormat::I16 => {
                    i16::from_ne_bytes([data[0], data[1]]) as f64 / i16::MAX as f64
                }
                SampleFormat::U16 => {
                    u16::from_ne_bytes([data[0], data[1]]) as f64 / u16::MAX as f64 - 0.5
                }
                SampleFormat::I32 => {
                    i32::from_ne_bytes([data[0], data[1], data[2], data[3]]) as f64
                        / i32::MAX as f64
                }
                SampleFormat::U32 => {
                    u32::from_ne_bytes([data[0], data[1], data[2], data[3]]) as f64
                        / u32::MAX as f64
                        - 0.5
                }
                SampleFormat::F32 => {
                    f32::from_ne_bytes([data[0], data[1], data[2], data[3]]) as f64
                }
                SampleFormat::F64 => f64::from_ne_bytes([
                    data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
                ]),
                _ => 0.0,
            };
            value.abs()
        })
        .fold(0.0f64, f64::max);

    (20.0 * peak.log10()).clamp(-96.0, 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both level mappings keep the web app's orientation: `picker_level` is 1
    /// at silence (it is the overlay's *right* offset), `bar_level` is 0 at
    /// silence (it is the track's fill fraction).
    #[test]
    fn level_mappings_match_the_web_formulas() {
        assert_eq!(picker_level(-96.0), 1.0);
        assert_eq!(picker_level(0.0), 0.0);
        assert!((picker_level(-20.0) - 0.5f64.sqrt()).abs() < 1e-9);

        assert_eq!(bar_level(-96.0), 0.0);
        assert_eq!(bar_level(-60.0), 0.0);
        assert_eq!(bar_level(0.0), 1.0);
        assert!((bar_level(-30.0) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn camera_preview_preserves_bgra_pixels_and_mirrors_each_row() {
        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, 2, 2);
        let stride = frame.stride(0);
        let pixels = frame.data_mut(0);
        pixels[..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        pixels[stride..stride + 8].copy_from_slice(&[9, 10, 11, 12, 13, 14, 15, 16]);

        let mut scaler = None;
        let (image, dims) = camera_preview_image(&frame, &mut scaler, false, None).unwrap();
        assert_eq!(dims, (2, 2));
        assert_eq!(
            image.as_bytes(0).unwrap(),
            &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
        );
        assert!(scaler.is_none());

        let (mirrored, dims) = camera_preview_image(&frame, &mut scaler, true, None).unwrap();
        assert_eq!(dims, (2, 2));
        assert_eq!(
            mirrored.as_bytes(0).unwrap(),
            &[5, 6, 7, 8, 1, 2, 3, 4, 13, 14, 15, 16, 9, 10, 11, 12]
        );
    }

    #[test]
    fn camera_preview_converts_rgba_to_bgra() {
        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBA, 2, 1);
        frame.data_mut(0)[..8].copy_from_slice(&[10, 20, 30, 255, 40, 50, 60, 128]);

        let mut scaler = None;
        let (image, dims) = camera_preview_image(&frame, &mut scaler, false, None).unwrap();
        assert_eq!(dims, (2, 1));
        assert_eq!(
            image.as_bytes(0).unwrap(),
            &[30, 20, 10, 255, 60, 50, 40, 128]
        );
        assert!(scaler.is_some());
    }

    #[test]
    fn camera_preview_downscales_only_when_blur_requires_it() {
        let frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, 64, 32);
        let mut scaler = None;

        let (_, full_size) = camera_preview_image(&frame, &mut scaler, false, None).unwrap();
        assert_eq!(full_size, (64, 32));
        assert!(scaler.is_none());

        let (_, capped) = camera_preview_image(&frame, &mut scaler, false, Some((32, 32))).unwrap();
        assert_eq!(capped, (32, 16));
        assert!(scaler.is_some());

        let (_, recapped) =
            camera_preview_image(&frame, &mut scaler, false, Some((16, 16))).unwrap();
        assert_eq!(recapped, (16, 8));
    }
}
