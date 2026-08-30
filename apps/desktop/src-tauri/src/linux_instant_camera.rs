use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use specta::Type;
#[cfg(target_os = "linux")]
use std::time::Instant;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_specta::Event;

use crate::{camera::CameraPreviewState, windows::CapWindowId};

#[cfg(target_os = "linux")]
use crate::camera::CameraPreviewShape;

#[derive(Clone)]
struct SelectionGuard {
    inputs: Arc<Mutex<crate::RequestedInputs>>,
    revision: u64,
    selected: cap_recording::feeds::camera::DeviceOrModelID,
}

impl SelectionGuard {
    fn current(&self) -> bool {
        let inputs = self.inputs.lock().unwrap();
        inputs.camera.revision == self.revision
            && inputs.camera.value.as_ref() == Some(&self.selected)
            && !inputs.camera.pending
            && inputs.camera.error.is_none()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CameraPresentationInput {
    pub viewport_width: f64,
    pub viewport_height: f64,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub radius: f64,
    pub layout_revision: u32,
    pub state: CameraPreviewState,
}

#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct CameraPresentationRequested {
    pub nonce: String,
    pub generation: u32,
    pub camera_revision: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PhysicalRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NativeSnapshot {
    id: u64,
    rect: PhysicalRect,
}

impl NativeSnapshot {
    #[cfg(target_os = "linux")]
    fn read(window: &WebviewWindow) -> Result<Self, String> {
        use wgpu::rwh::{HasWindowHandle, RawWindowHandle};
        let id = match window
            .window_handle()
            .map_err(|error| error.to_string())?
            .as_raw()
        {
            RawWindowHandle::Xlib(handle) => handle.window,
            RawWindowHandle::Xcb(handle) => u64::from(handle.window.get()),
            _ => return Err("Camera presentation requires a native X11 window".into()),
        };
        let position = window.inner_position().map_err(|error| error.to_string())?;
        let size = window.inner_size().map_err(|error| error.to_string())?;
        Ok(Self {
            id,
            rect: PhysicalRect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            },
        })
    }

    #[cfg(not(target_os = "linux"))]
    fn read(_window: &WebviewWindow) -> Result<Self, String> {
        Err("Processed camera presentation is only available on Linux X11".into())
    }
}

async fn native_snapshot(window: WebviewWindow) -> Result<NativeSnapshot, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(NativeSnapshot::read(&handle));
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(2), rx)
        .await
        .map_err(|_| "Camera window geometry timed out".to_string())?
        .map_err(|_| "Camera window geometry was cancelled".to_string())?
}

#[derive(Clone)]
struct PresentationOwner {
    nonce: String,
    generation: u32,
    native: NativeSnapshot,
    selection: SelectionGuard,
    state: tokio::sync::watch::Receiver<CameraPreviewState>,
}

impl PresentationOwner {
    fn validate(
        &self,
        app: &AppHandle,
        native: NativeSnapshot,
        input: &CameraPresentationInput,
    ) -> Result<(), String> {
        if !crate::clean_capture::is_current(app, self.generation)
            || !self.selection.current()
            || self.native != native
            || *self.state.borrow() != input.state
        {
            return Err(
                "Camera selection, appearance, or window changed. Start again to confirm it."
                    .into(),
            );
        }
        Ok(())
    }
}

struct PendingPresentation {
    owner: PresentationOwner,
    reply: tokio::sync::oneshot::Sender<Result<CameraPresentationInput, String>>,
}

#[derive(Default)]
pub struct PresentationBroker {
    pending: Arc<Mutex<Option<PendingPresentation>>>,
}

struct PendingGuard {
    pending: Arc<Mutex<Option<PendingPresentation>>>,
    nonce: String,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        let mut pending = self.pending.lock().unwrap();
        if pending
            .as_ref()
            .is_some_and(|pending| pending.owner.nonce == self.nonce)
        {
            *pending = None;
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn submit_camera_presentation(
    window: WebviewWindow,
    nonce: String,
    input: Option<CameraPresentationInput>,
    error: Option<String>,
) -> Result<(), String> {
    if !cfg!(target_os = "linux")
        || !matches!(
            window.label().parse::<CapWindowId>(),
            Ok(CapWindowId::Camera)
        )
    {
        return Err(
            "Only the current Linux camera window may answer a presentation request".into(),
        );
    }
    let app = window.app_handle();
    let broker = app.state::<PresentationBroker>();
    let owner = broker
        .pending
        .lock()
        .unwrap()
        .as_ref()
        .filter(|pending| pending.owner.nonce == nonce)
        .map(|pending| pending.owner.clone())
        .ok_or("Camera presentation request expired")?;
    let native = native_snapshot(window.clone()).await?;
    if native.id != owner.native.id
        || !crate::clean_capture::is_current(app, owner.generation)
        || !owner.selection.current()
    {
        return Err("Camera presentation owner changed".into());
    }
    let result = match (input, error) {
        (Some(input), None) => owner.validate(app, native, &input).map(|()| input),
        (None, Some(error)) => Err(error),
        _ => return Err("Camera presentation requires either pixels geometry or an error".into()),
    };
    let mut pending = broker.pending.lock().unwrap();
    if pending
        .as_ref()
        .is_none_or(|pending| pending.owner.nonce != nonce)
    {
        return Err("Camera presentation request was superseded".into());
    }
    let _ = pending.take().unwrap().reply.send(result);
    Ok(())
}

#[cfg(target_os = "linux")]
pub struct PreparedPresentation {
    owner: PresentationOwner,
    actor: kameo::actor::ActorRef<cap_recording::feeds::camera::CameraFeed>,
    input: CameraPresentationInput,
    pub presentation: cap_recording::instant_recording::LinuxCameraPresentation,
    pub reference_size: (u32, u32),
    pub processing: cap_recording::instant_recording::LinuxCameraProcessing,
}

#[cfg(target_os = "linux")]
impl PreparedPresentation {
    pub fn validate_before_hide(&self, window: &WebviewWindow) -> Result<(), String> {
        if !matches!(
            window.label().parse::<CapWindowId>(),
            Ok(CapWindowId::Camera)
        ) {
            return Err("Camera presentation window changed".into());
        }
        self.owner.validate(
            window.app_handle(),
            NativeSnapshot::read(window)?,
            &self.input,
        )
    }
}

#[cfg(target_os = "linux")]
pub async fn request_presentation(
    app: &AppHandle,
    generation: u32,
    capture: PhysicalRect,
) -> Result<PreparedPresentation, String> {
    let requested = app.state::<crate::RequestedInputsState>();
    let snapshot = requested.ready_snapshot()?;
    let selected = snapshot
        .camera
        .value
        .clone()
        .ok_or("Select a camera before requesting its presentation")?;
    let selection = SelectionGuard {
        inputs: requested.inner.clone(),
        revision: snapshot.camera.revision,
        selected,
    };
    let window = CapWindowId::Camera
        .get(app)
        .ok_or("Open the selected camera preview before recording")?;
    if !window.is_visible().map_err(|error| error.to_string())? {
        return Err("Open the selected camera preview before recording".into());
    }
    let native = native_snapshot(window.clone()).await?;
    let (actor, state) = {
        let state = app.state::<crate::ArcLock<crate::App>>();
        let state = state.read().await;
        (
            state.camera_feed.clone(),
            state.camera_preview_state_tx.subscribe(),
        )
    };
    if !selection.current() || !crate::clean_capture::is_current(app, generation) {
        return Err("Recording or camera selection changed".into());
    }
    let nonce = uuid::Uuid::new_v4().to_string();
    let owner = PresentationOwner {
        nonce: nonce.clone(),
        generation,
        native,
        selection,
        state,
    };
    let broker = app.state::<PresentationBroker>();
    let (reply, rx) = tokio::sync::oneshot::channel();
    {
        let mut pending = broker.pending.lock().unwrap();
        if pending.is_some() {
            return Err("Camera presentation is already being measured".into());
        }
        *pending = Some(PendingPresentation {
            owner: owner.clone(),
            reply,
        });
    }
    let _guard = PendingGuard {
        pending: broker.pending.clone(),
        nonce: nonce.clone(),
    };
    CameraPresentationRequested {
        nonce,
        generation,
        camera_revision: snapshot.camera.revision.to_string(),
    }
    .emit_to(app, window.label())
    .map_err(|error| error.to_string())?;
    let input = tokio::time::timeout(Duration::from_secs(2), rx)
        .await
        .map_err(|_| "Camera preview did not answer before the presentation deadline".to_string())?
        .map_err(|_| "Camera presentation was cancelled".to_string())??;
    owner.validate(app, native_snapshot(window).await?, &input)?;
    let (presentation, processing) = presentation_from_input(&input, native.rect, capture)?;
    Ok(PreparedPresentation {
        owner,
        actor,
        input,
        presentation,
        reference_size: (capture.width, capture.height),
        processing,
    })
}

#[cfg(target_os = "linux")]
fn processing(
    state: &CameraPreviewState,
) -> cap_recording::instant_recording::LinuxCameraProcessing {
    use cap_recording::instant_recording::{LinuxCameraBlur, LinuxCameraProcessing};
    LinuxCameraProcessing {
        mirrored: state.mirrored,
        blur: match state.background_blur {
            cap_project::BackgroundBlurMode::Off => LinuxCameraBlur::Off,
            cap_project::BackgroundBlurMode::Light => LinuxCameraBlur::Light,
            cap_project::BackgroundBlurMode::Heavy => LinuxCameraBlur::Heavy,
        },
    }
}

#[cfg(target_os = "linux")]
fn presentation_from_input(
    input: &CameraPresentationInput,
    window: PhysicalRect,
    capture: PhysicalRect,
) -> Result<
    (
        cap_recording::instant_recording::LinuxCameraPresentation,
        cap_recording::instant_recording::LinuxCameraProcessing,
    ),
    String,
> {
    use cap_recording::instant_recording::{
        LinuxCameraEffect, LinuxCameraPresentation, LinuxCameraRect, LinuxCameraShape,
    };
    if ![
        input.viewport_width,
        input.viewport_height,
        input.left,
        input.top,
        input.width,
        input.height,
        input.radius,
    ]
    .iter()
    .all(|value| value.is_finite())
        || input.viewport_width <= 0.0
        || input.viewport_height <= 0.0
        || input.width <= 0.0
        || input.height <= 0.0
        || input.left < 0.0
        || input.top < 0.0
        || input.radius < 0.0
        || input.left + input.width > input.viewport_width + 1.0
        || input.top + input.height > input.viewport_height + 1.0
        || window.width == 0
        || window.height == 0
        || !input.state.size.is_finite()
        || !(crate::camera::MIN_CAMERA_SIZE..=crate::camera::MAX_CAMERA_SIZE)
            .contains(&input.state.size)
    {
        return Err("Camera preview has invalid content bounds".into());
    }
    let sx = f64::from(window.width) / input.viewport_width;
    let sy = f64::from(window.height) / input.viewport_height;
    if (sx - sy).abs() > sx.min(sy) * 0.01 {
        return Err("Camera preview has an unsupported physical scale".into());
    }
    let left = f64::from(window.x) + (input.left * sx).round();
    let top = f64::from(window.y) + (input.top * sy).round();
    let right = f64::from(window.x) + ((input.left + input.width) * sx).round();
    let bottom = f64::from(window.y) + ((input.top + input.height) * sy).round();
    let x = left - f64::from(capture.x);
    let y = top - f64::from(capture.y);
    let width = right - left;
    let height = bottom - top;
    if x < 0.0
        || y < 0.0
        || width < 1.0
        || height < 1.0
        || x + width > f64::from(capture.width)
        || y + height > f64::from(capture.height)
    {
        return Err(
            "Move the whole camera preview inside the capture area before recording".into(),
        );
    }
    let width = width as u32;
    let height = height as u32;
    let shape = match input.state.shape {
        CameraPreviewShape::Round if width == height => LinuxCameraShape::Round,
        CameraPreviewShape::Round if width.abs_diff(height) <= 1 => {
            LinuxCameraShape::RoundedRectangle {
                radius_pixels: width.min(height) / 2,
            }
        }
        CameraPreviewShape::Round => return Err("Round camera preview is not square".into()),
        CameraPreviewShape::Square | CameraPreviewShape::Full => {
            LinuxCameraShape::RoundedRectangle {
                radius_pixels: ((input.radius * sx.min(sy)).round() as u32)
                    .min(width.min(height) / 2),
            }
        }
    };
    let mut presentation = LinuxCameraPresentation {
        rect: LinuxCameraRect {
            x: x as u32,
            y: y as u32,
            width,
            height,
        },
        shape,
        mirrored: input.state.mirrored,
        effect: LinuxCameraEffect::None,
    };
    presentation
        .validate(capture.width, capture.height)
        .map_err(|error| error.to_string())?;
    if input.state.background_blur != cap_project::BackgroundBlurMode::Off {
        presentation.effect = LinuxCameraEffect::BackgroundBlur;
    }
    Ok((presentation, processing(&input.state)))
}

#[cfg(target_os = "linux")]
mod producer {
    use super::*;
    use cap_recording::{
        FFmpegVideoFrame,
        feeds::camera::{self, CameraFeed, CameraFeedLock},
        instant_recording::{
            LINUX_CAMERA_MAX_MASK_AGE, LinuxCameraBlur, LinuxCameraMaskReceipt,
            LinuxCameraProcessing, LinuxCameraPublisher, LinuxProcessedCameraFrame,
            LinuxProcessedCameraSource,
        },
    };
    use cap_timestamp::Timestamp;
    use kameo::actor::ActorRef;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    pub struct Reservation(Arc<AtomicBool>);

    impl Reservation {
        pub(super) fn acquire(active: &Arc<AtomicBool>) -> Option<Self> {
            active
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .ok()
                .map(|_| Self(active.clone()))
        }
    }

    impl Drop for Reservation {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }

    struct Attachment {
        actor: ActorRef<CameraFeed>,
        sender: flume::Sender<FFmpegVideoFrame>,
        runtime: tokio::runtime::Handle,
        _reservation: Reservation,
    }

    impl Drop for Attachment {
        fn drop(&mut self) {
            let actor = self.actor.clone();
            let sender = self.sender.clone();
            drop(self.runtime.spawn(async move {
                let _ = actor.ask(camera::RemoveSender(sender)).await;
            }));
        }
    }

    #[derive(Clone)]
    pub struct ProcessingFactory {
        commands: flume::Sender<Box<RecordingWork>>,
        reserved: Arc<AtomicBool>,
        generation: Arc<AtomicU64>,
    }

    pub(crate) fn channel() -> (ProcessingFactory, flume::Receiver<Box<RecordingWork>>) {
        let (commands, receiver) = flume::bounded(1);
        (
            ProcessingFactory {
                commands,
                reserved: Arc::new(AtomicBool::new(false)),
                generation: Arc::new(AtomicU64::new(0)),
            },
            receiver,
        )
    }

    impl ProcessingFactory {
        pub async fn subscribe(
            &self,
            feed: Arc<CameraFeedLock>,
            prepared: &PreparedPresentation,
        ) -> anyhow::Result<LinuxProcessedCameraSource> {
            let info = feed.camera_info();
            let matches = match &prepared.owner.selection.selected {
                camera::DeviceOrModelID::DeviceID(id) => info.device_id() == id,
                camera::DeviceOrModelID::ModelID(id) => info.model_id() == Some(id),
            };
            anyhow::ensure!(
                matches && feed.id() == prepared.actor.id(),
                "Processed camera does not match the requested camera lock"
            );
            anyhow::ensure!(
                prepared.owner.selection.current()
                    && *prepared.owner.state.borrow() == prepared.input.state,
                "Camera request or appearance changed before recording"
            );
            let reservation = tokio::time::timeout(Duration::from_millis(1500), async {
                loop {
                    if let Some(reservation) = Reservation::acquire(&self.reserved) {
                        break reservation;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .map_err(|_| {
                anyhow::anyhow!("Previous camera processing has not released its lease")
            })?;
            let (sender, frames) = flume::bounded(2);
            let attachment = Attachment {
                actor: prepared.actor.clone(),
                sender: sender.clone(),
                runtime: tokio::runtime::Handle::current(),
                _reservation: reservation,
            };
            anyhow::ensure!(
                prepared.owner.selection.current(),
                "Camera selection changed while waiting for processing"
            );
            let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
            let not_before = Instant::now();
            let (publisher, mut source) = LinuxProcessedCameraSource::channel(
                feed.clone(),
                prepared.processing,
                generation,
                not_before,
            );
            tokio::time::timeout(
                Duration::from_millis(1500),
                feed.ask(camera::AddSender(sender)),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Camera processing attachment timed out"))?
            .map_err(|error| anyhow::anyhow!("Camera processing attachment failed: {error}"))?;
            let work = RecordingWork {
                frames,
                publisher,
                state: prepared.input.state.clone(),
                selection: prepared.owner.selection.clone(),
                current_state: prepared.owner.state.clone(),
                generation,
                not_before,
                published: AtomicBool::new(false),
                _attachment: attachment,
            };
            tokio::time::timeout(
                Duration::from_millis(1500),
                self.commands.send_async(Box::new(work)),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Camera processing command timed out"))?
            .map_err(|_| anyhow::anyhow!("Camera processing worker disconnected"))?;
            source.wait_ready(Duration::from_secs(10)).await?;
            anyhow::ensure!(
                prepared.owner.selection.current()
                    && *prepared.owner.state.borrow() == prepared.input.state,
                "Camera request or appearance changed while processing warmed up"
            );
            Ok(source)
        }
    }

    #[derive(Clone, Debug)]
    pub(crate) struct FrameReceipt {
        pub timestamp: Timestamp,
        pub generation: u64,
        pub processing: LinuxCameraProcessing,
        pub dimensions: (u32, u32),
        pub blur: Option<cap_camera_effects::BlurOutputStatus>,
    }

    pub(crate) struct RecordingWork {
        pub frames: flume::Receiver<FFmpegVideoFrame>,
        publisher: LinuxCameraPublisher,
        pub state: CameraPreviewState,
        selection: SelectionGuard,
        current_state: tokio::sync::watch::Receiver<CameraPreviewState>,
        generation: u64,
        not_before: Instant,
        published: AtomicBool,
        _attachment: Attachment,
    }

    impl RecordingWork {
        pub fn cancelled(&self) -> bool {
            self.publisher.is_cancelled()
        }
        pub fn fail(&self, error: impl Into<String>) {
            self.publisher.fail(error.into());
        }
        pub fn accepts(&self, timestamp: Timestamp) -> Result<bool, String> {
            if !self.selection.current() || *self.current_state.borrow() != self.state {
                return Err("Requested camera or appearance changed during recording".into());
            }
            let Timestamp::Instant(captured) = timestamp else {
                return Err("Camera requires an original monotonic timestamp".into());
            };
            Ok(captured >= self.not_before)
        }
        pub fn receipt(&self, timestamp: Timestamp, dimensions: (u32, u32)) -> FrameReceipt {
            FrameReceipt {
                timestamp,
                generation: self.generation,
                processing: processing(&self.state),
                dimensions,
                blur: None,
            }
        }
        pub fn publish(&self, rgba: &[u8], receipt: FrameReceipt) {
            if self.cancelled() {
                return;
            }
            match self.accepts(receipt.timestamp) {
                Ok(true) => {}
                Ok(false) => return,
                Err(error) => {
                    self.fail(error);
                    return;
                }
            }
            let now = Instant::now();
            if !self.published.load(Ordering::Acquire)
                && matches!(receipt.timestamp, Timestamp::Instant(captured) if now.saturating_duration_since(captured)>Duration::from_secs(1))
            {
                return;
            }
            let result = make_processed_frame(
                rgba,
                receipt,
                self.generation,
                self.not_before,
                processing(&self.state),
                now,
            );
            match result {
                Ok(Some(frame)) => {
                    self.publisher.publish(frame);
                    self.published.store(true, Ordering::Release);
                }
                Ok(None) => {}
                Err(error) => self.fail(error),
            }
        }
    }

    pub(crate) fn make_processed_frame(
        rgba: &[u8],
        receipt: FrameReceipt,
        generation: u64,
        not_before: Instant,
        expected: LinuxCameraProcessing,
        now: Instant,
    ) -> Result<Option<LinuxProcessedCameraFrame>, String> {
        if receipt.generation != generation || receipt.processing != expected {
            return Err("Processed camera receipt belongs to another request".into());
        }
        let Timestamp::Instant(captured) = receipt.timestamp else {
            return Err("Processed camera timestamp is not monotonic".into());
        };
        if captured < not_before
            || captured > now
            || now.saturating_duration_since(captured) > Duration::from_secs(1)
        {
            return Err("Processed camera capture timestamp is stale or invalid".into());
        }
        let mask = match (expected.blur, receipt.blur) {
            (LinuxCameraBlur::Off, None) => None,
            (LinuxCameraBlur::Light | LinuxCameraBlur::Heavy, Some(status)) => {
                let mode = if expected.blur == LinuxCameraBlur::Light {
                    cap_camera_effects::BlurMode::Light
                } else {
                    cap_camera_effects::BlurMode::Heavy
                };
                match status.applied_at(now, LINUX_CAMERA_MAX_MASK_AGE) {
                    Ok(applied)
                        if applied.mode == mode
                            && applied.output_dimensions == receipt.dimensions
                            && applied.mask.input_submitted_at >= not_before
                            && applied.mask.generation > 0 =>
                    {
                        Some(LinuxCameraMaskReceipt {
                            generation: applied.mask.generation,
                            submitted_at: applied.mask.input_submitted_at,
                            completed_at: applied.mask.inference_completed_at,
                        })
                    }
                    Err(cap_camera_effects::BlurOutputUnavailable::Pending) => return Ok(None),
                    other => {
                        return Err(format!("Requested camera blur was not applied: {other:?}"));
                    }
                }
            }
            _ => return Err("Requested camera blur has no matching output receipt".into()),
        };
        let (width, height) = receipt.dimensions;
        let row = (width as usize)
            .checked_mul(4)
            .ok_or("Camera row overflow")?;
        let size = row
            .checked_mul(height as usize)
            .ok_or("Camera image overflow")?;
        if width == 0 || height == 0 || rgba.len() != size {
            return Err("Camera pixels do not match their receipt".into());
        }
        let mut bgra = vec![0; size];
        for (source, destination) in rgba.chunks_exact(row).zip(bgra.chunks_exact_mut(row)) {
            for (x, pixel) in destination.chunks_exact_mut(4).enumerate() {
                let source_x = if expected.mirrored {
                    width as usize - 1 - x
                } else {
                    x
                };
                let source = &source[source_x * 4..source_x * 4 + 4];
                pixel.copy_from_slice(&[source[2], source[1], source[0], source[3]]);
            }
        }
        Ok(Some(LinuxProcessedCameraFrame {
            bgra: Arc::from(bgra),
            dimensions: receipt.dimensions,
            stride: row,
            timestamp: receipt.timestamp,
            generation,
            processing: expected,
            mask,
        }))
    }
}

#[cfg(target_os = "linux")]
pub use producer::ProcessingFactory;
#[cfg(target_os = "linux")]
pub(crate) use producer::{FrameReceipt, RecordingWork, channel as processing_channel};

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use cap_recording::instant_recording::{LinuxCameraBlur, LinuxCameraProcessing};
    use cap_timestamp::Timestamp;

    fn input() -> CameraPresentationInput {
        CameraPresentationInput {
            viewport_width: 230.0,
            viewport_height: 286.0,
            left: 0.0,
            top: 56.0,
            width: 230.0,
            height: 230.0,
            radius: 115.0,
            layout_revision: 1,
            state: CameraPreviewState::default(),
        }
    }

    #[test]
    fn camera_content_excludes_toolbar_and_preserves_physical_position() {
        let window = PhysicalRect {
            x: -1200,
            y: 100,
            width: 460,
            height: 572,
        };
        let capture = PhysicalRect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let (presentation, _) = presentation_from_input(&input(), window, capture).unwrap();
        assert_eq!(presentation.rect.x, 720);
        assert_eq!(presentation.rect.y, 212);
        assert_eq!(
            (presentation.rect.width, presentation.rect.height),
            (460, 460)
        );
    }

    #[test]
    fn presentation_rejects_outside_capture_ambiguous_scale_and_invalid_geometry() {
        let capture = PhysicalRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        assert!(
            presentation_from_input(
                &input(),
                PhysicalRect {
                    x: 1800,
                    y: 0,
                    width: 230,
                    height: 286
                },
                capture
            )
            .is_err()
        );
        assert!(
            presentation_from_input(
                &input(),
                PhysicalRect {
                    x: 0,
                    y: 0,
                    width: 460,
                    height: 286
                },
                capture
            )
            .is_err()
        );
        let mut invalid = input();
        invalid.width = f64::NAN;
        assert!(
            presentation_from_input(
                &invalid,
                PhysicalRect {
                    x: 0,
                    y: 0,
                    width: 230,
                    height: 286
                },
                capture
            )
            .is_err()
        );
    }

    #[test]
    fn full_shape_and_exact_effects_are_not_replaced_by_defaults() {
        let mut input = input();
        input.width = 460.0;
        input.viewport_width = 460.0;
        input.radius = 24.0;
        input.state.shape = CameraPreviewShape::Full;
        input.state.mirrored = true;
        input.state.background_blur = cap_project::BackgroundBlurMode::Heavy;
        let (presentation, processing) = presentation_from_input(
            &input,
            PhysicalRect {
                x: 20,
                y: 30,
                width: 460,
                height: 286,
            },
            PhysicalRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        )
        .unwrap();
        assert_eq!(
            presentation.shape,
            cap_recording::instant_recording::LinuxCameraShape::RoundedRectangle {
                radius_pixels: 24
            }
        );
        assert_eq!(presentation.rect.width, 460);
        assert_eq!(
            processing,
            LinuxCameraProcessing {
                mirrored: true,
                blur: LinuxCameraBlur::Heavy
            }
        );
    }

    fn receipt(now: Instant) -> FrameReceipt {
        FrameReceipt {
            timestamp: Timestamp::Instant(now),
            generation: 3,
            processing: LinuxCameraProcessing {
                mirrored: true,
                blur: LinuxCameraBlur::Off,
            },
            dimensions: (2, 1),
            blur: None,
        }
    }

    #[test]
    fn recording_packs_rgba_to_bgra_and_mirrors_already_processed_pixels_once() {
        let now = Instant::now();
        let receipt = receipt(now);
        let expected = receipt.processing;
        let frame = producer::make_processed_frame(
            &[1, 2, 3, 255, 4, 5, 6, 128],
            receipt,
            3,
            now,
            expected,
            now,
        )
        .unwrap()
        .unwrap();
        assert_eq!(&*frame.bgra, &[6, 5, 4, 128, 3, 2, 1, 255]);
        assert_eq!(frame.generation, 3);
        assert_eq!(frame.dimensions, (2, 1));
    }

    #[test]
    fn recording_rejects_old_generation_old_capture_and_missing_requested_blur() {
        let now = Instant::now();
        let original = receipt(now);
        assert!(
            producer::make_processed_frame(
                &[0; 8],
                original.clone(),
                4,
                now,
                original.processing,
                now
            )
            .is_err()
        );
        assert!(
            producer::make_processed_frame(
                &[0; 8],
                original.clone(),
                3,
                now + Duration::from_millis(1),
                original.processing,
                now
            )
            .is_err()
        );
        assert!(
            producer::make_processed_frame(
                &[0; 8],
                original.clone(),
                3,
                now,
                original.processing,
                now + Duration::from_secs(2)
            )
            .is_err()
        );
        let mut blurred = original;
        blurred.processing.blur = LinuxCameraBlur::Light;
        let expected = blurred.processing;
        assert!(producer::make_processed_frame(&[0; 8], blurred, 3, now, expected, now).is_err());
    }

    #[test]
    fn pending_failed_wrong_mode_and_stale_masks_never_become_recorded_raw_frames() {
        use cap_camera_effects::{
            BlurFailure, BlurMaskReceipt, BlurMaskStatus, BlurMode, BlurOutputStatus,
        };
        let now = Instant::now();
        let mut receipt = receipt(now);
        receipt.processing.blur = LinuxCameraBlur::Heavy;
        let expected = receipt.processing;
        let mut status = BlurOutputStatus {
            mode: BlurMode::Heavy,
            output_sequence: 1,
            output_dimensions: (2, 1),
            mask: BlurMaskStatus::Pending,
        };
        receipt.blur = Some(status.clone());
        assert!(
            producer::make_processed_frame(&[0; 8], receipt.clone(), 3, now, expected, now)
                .unwrap()
                .is_none()
        );
        status.mask = BlurMaskStatus::Failed(BlurFailure::Inference("failed".into()));
        receipt.blur = Some(status.clone());
        assert!(
            producer::make_processed_frame(&[0; 8], receipt.clone(), 3, now, expected, now)
                .is_err()
        );
        status.mask = BlurMaskStatus::Ready(BlurMaskReceipt {
            generation: 1,
            input_submitted_at: now,
            inference_completed_at: now,
            input_dimensions: (2, 1),
        });
        status.mode = BlurMode::Light;
        receipt.blur = Some(status.clone());
        assert!(
            producer::make_processed_frame(&[0; 8], receipt.clone(), 3, now, expected, now)
                .is_err()
        );
        status.mode = BlurMode::Heavy;
        receipt.blur = Some(status);
        assert!(
            producer::make_processed_frame(&[0; 8], receipt.clone(), 3, now, expected, now)
                .unwrap()
                .is_some()
        );
        assert!(
            producer::make_processed_frame(
                &[0; 8],
                receipt,
                3,
                now,
                expected,
                now + Duration::from_millis(751)
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn presentation_request_cancellation_only_releases_owned_nonce() {
        let pending = Arc::new(Mutex::new(None));
        let inputs = Arc::new(Mutex::new(crate::RequestedInputs {
            microphone: crate::RequestedInput::new(None),
            camera: crate::RequestedInput::new(Some(
                cap_recording::feeds::camera::DeviceOrModelID::DeviceID("camera-a".into()),
            )),
        }));
        let (_, state) = tokio::sync::watch::channel(CameraPreviewState::default());
        let owner = PresentationOwner {
            nonce: "new".into(),
            generation: 2,
            native: NativeSnapshot {
                id: 1,
                rect: PhysicalRect {
                    x: 0,
                    y: 0,
                    width: 230,
                    height: 286,
                },
            },
            selection: SelectionGuard {
                inputs,
                revision: 0,
                selected: cap_recording::feeds::camera::DeviceOrModelID::DeviceID(
                    "camera-a".into(),
                ),
            },
            state,
        };
        let (reply, received) = tokio::sync::oneshot::channel();
        *pending.lock().unwrap() = Some(PendingPresentation { owner, reply });
        drop(PendingGuard {
            pending: pending.clone(),
            nonce: "old".into(),
        });
        assert!(pending.lock().unwrap().is_some());
        drop(PendingGuard {
            pending: pending.clone(),
            nonce: "new".into(),
        });
        assert!(received.await.is_err());
        assert!(pending.lock().unwrap().is_none());
    }

    #[test]
    fn camera_request_revision_guard_does_not_rewrite_input_intent() {
        let state = crate::RequestedInputsState::new(
            None,
            Some(cap_recording::feeds::camera::DeviceOrModelID::DeviceID(
                "camera-a".into(),
            )),
        );
        let guard = SelectionGuard {
            inputs: state.inner.clone(),
            revision: 0,
            selected: cap_recording::feeds::camera::DeviceOrModelID::DeviceID("camera-a".into()),
        };
        assert!(guard.current());
        let revision = state.inner.lock().unwrap().camera.begin(None);
        assert!(!guard.current());
        state.inner.lock().unwrap().camera.finish(revision, &Ok(()));
        assert!(!guard.current());
        assert!(state.snapshot().camera.value.is_none());
    }

    #[tokio::test]
    async fn recording_reservation_excludes_another_attempt_until_owned_drop() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let active = Arc::new(AtomicBool::new(false));
        let first = producer::Reservation::acquire(&active).unwrap();
        let next_active = active.clone();
        let (blocked, seen) = tokio::sync::oneshot::channel();
        let (release, ready) = tokio::sync::oneshot::channel();
        let next = tokio::spawn(async move {
            assert!(producer::Reservation::acquire(&next_active).is_none());
            blocked.send(()).unwrap();
            ready.await.unwrap();
            producer::Reservation::acquire(&next_active).unwrap()
        });
        seen.await.unwrap();
        assert!(active.load(Ordering::Acquire));
        drop(first);
        release.send(()).unwrap();
        let next = next.await.unwrap();
        assert!(active.load(Ordering::Acquire));
        drop(next);
        assert!(!active.load(Ordering::Acquire));
    }
}
