//! The floating stack of finished captures that "After a Studio recording:
//! Show in overlay" opens, `recordings-overlay.tsx` in the Tauri app.
//!
//! Each card offers what the Tauri card did: Close, Edit (recordings) or Open
//! (screenshots), Copy to Clipboard, Copy Shareable Link and Export. Cards stay
//! until they are closed or opened in the editor, as they did there. A
//! screenshot taken while the stack is up joins it, the way the Tauri overlay
//! listened for `NewScreenshotAdded`. The stack hides while a recording or a
//! screenshot capture runs, so it never ends up in the capture, and comes back
//! when the capture ends; actions already running keep going meanwhile.

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use cap_project::{RecordingMeta, SharingMeta, StudioRecordingMeta};
use gpui::{
    AnyElement, App, AppContext as _, AsyncApp, Bounds, Context, Entity, FontWeight, Global, Hsla,
    InteractiveElement as _, IntoElement, ObjectFit, ParentElement as _, Pixels, Render,
    SharedString, StatefulInteractiveElement as _, Styled, StyledImage as _, Subscription, Task,
    WeakEntity, Window, WindowBounds, WindowHandle, WindowKind, WindowOptions, div, img, point,
    prelude::FluentBuilder as _, px, size, svg,
};

use crate::{
    i18n::tr,
    platform,
    theme::{LocaleFont as _, Theme},
    ui,
};

#[cfg(test)]
mod tests;

const CARD_WIDTH: f32 = 260.;
const CARD_HEIGHT: f32 = 150.;
const CARD_GAP: f32 = 16.;
const WINDOW_PADDING: f32 = 12.;
const EDGE_OFFSET: f32 = 24.;
const DONE_VISIBLE: Duration = Duration::from_secs(2);
const FAILURE_VISIBLE: Duration = Duration::from_secs(6);
const PROGRESS_POLL: Duration = Duration::from_millis(50);
const OVERLAY_EXPORT_FPS: u32 = 60;
const OVERLAY_EXPORT_SIZE: (u32, u32) = (1920, 1080);
const FREE_SHARE_LIMIT_SECS: f64 = 300.;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Recording,
    Screenshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionKind {
    Copy,
    Save,
    Share,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Stage {
    ChoosingLocation,
    Rendering { rendered: u32, total: u32 },
    Copying,
    Saving,
    Uploading(f32),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ActionState {
    Idle,
    Busy(ActionKind, Stage),
    Done(ActionKind),
    Failed(ActionKind, String),
}

impl ActionState {
    pub fn is_busy(&self) -> bool {
        matches!(self, Self::Busy(..))
    }

    /// `actionProgressPercentage`, as a fraction.
    pub fn progress(&self) -> f32 {
        match self {
            Self::Idle | Self::Failed(..) => 0.,
            Self::Done(_) => 1.,
            Self::Busy(_, Stage::Rendering { rendered, total }) => {
                if *total == 0 {
                    0.
                } else {
                    (*rendered as f32 / *total as f32).clamp(0., 1.)
                }
            }
            Self::Busy(_, Stage::ChoosingLocation) => 0.,
            Self::Busy(_, Stage::Copying | Stage::Saving) => 0.5,
            Self::Busy(_, Stage::Uploading(progress)) => progress.clamp(0., 1.),
        }
    }

    pub fn title(&self, kind: MediaKind) -> Option<&'static str> {
        let video = kind == MediaKind::Recording;
        Some(match self {
            Self::Idle => return None,
            Self::Busy(_, Stage::Rendering { .. }) => {
                tr::recordings_overlay::progress::rendering_video()
            }
            Self::Busy(_, Stage::ChoosingLocation) => tr::recordings_overlay::progress::preparing(),
            Self::Busy(ActionKind::Copy, _) => tr::recordings_overlay::progress::copying(),
            Self::Busy(ActionKind::Save, _) if video => {
                tr::recordings_overlay::progress::saving_video()
            }
            Self::Busy(ActionKind::Save, _) => tr::recordings_overlay::progress::saving_image(),
            Self::Busy(ActionKind::Share, _) => tr::recordings_overlay::progress::creating_link(),
            Self::Done(ActionKind::Copy) => tr::recordings_overlay::progress::copied(),
            Self::Done(ActionKind::Save) if video => {
                tr::recordings_overlay::progress::saved_video()
            }
            Self::Done(ActionKind::Save) => tr::recordings_overlay::progress::saved_image(),
            Self::Done(ActionKind::Share) => tr::recordings_overlay::progress::link_copied(),
            Self::Failed(ActionKind::Copy, _) => tr::recordings_overlay::progress::copy_failed(),
            Self::Failed(ActionKind::Save, _) => tr::recordings_overlay::progress::save_failed(),
            Self::Failed(ActionKind::Share, _) => tr::recordings_overlay::progress::share_failed(),
        })
    }

    /// The line under the bar: the save prompt while the panel is up, the
    /// error after a failure, the percentage otherwise.
    pub fn message(&self, kind: MediaKind) -> Option<String> {
        match self {
            Self::Idle => None,
            Self::Busy(_, Stage::ChoosingLocation) => Some(
                match kind {
                    MediaKind::Recording => tr::recordings_overlay::progress::choose_video(),
                    MediaKind::Screenshot => tr::recordings_overlay::progress::choose_image(),
                }
                .to_string(),
            ),
            Self::Failed(_, message) => Some(crate::i18n::messages::localize(message)),
            _ => Some(format!("{}%", (self.progress() * 100.).floor() as u32)),
        }
    }
}

/// What a cleanly stopped Studio recording does next, after any automation
/// rule has resolved `postStudioRecordingBehaviour`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StudioCompletion {
    OpenEditor,
    ShowOverlay,
    StayOutOfTheWay,
}

pub fn studio_completion(behaviour: crate::store::PostStudioBehaviour) -> StudioCompletion {
    match behaviour {
        crate::store::PostStudioBehaviour::OpenEditor => StudioCompletion::OpenEditor,
        crate::store::PostStudioBehaviour::ShowOverlay => StudioCompletion::ShowOverlay,
        crate::store::PostStudioBehaviour::DoNothing => StudioCompletion::StayOutOfTheWay,
    }
}

/// The organization a share uploads to: the one picked in the editor's export
/// dialog while the account still belongs to it, else the first one, the
/// editor's `pick_default_organization`.
pub fn share_organization(saved: Option<&str>, organizations: &[String]) -> Option<String> {
    saved
        .filter(|id| organizations.iter().any(|org| org == id))
        .map(str::to_string)
        .or_else(|| organizations.first().cloned())
}

pub fn stack_height(cards: usize) -> f32 {
    if cards == 0 {
        return 0.;
    }
    cards as f32 * CARD_HEIGHT + (cards - 1) as f32 * CARD_GAP + WINDOW_PADDING * 2.
}

/// How many cards fit in a work area this tall. Always at least one.
pub fn max_cards(available_height: f32) -> usize {
    let room = available_height - EDGE_OFFSET * 2. - WINDOW_PADDING * 2. + CARD_GAP;
    ((room / (CARD_HEIGHT + CARD_GAP)).floor() as usize).max(1)
}

/// The window for `cards` cards, the lowest one `EDGE_OFFSET` in from the
/// bottom-left corner of the work area (the Tauri stack sat in that corner).
pub fn stack_bounds(work_area: Bounds<Pixels>, cards: usize) -> Bounds<Pixels> {
    let width = px(CARD_WIDTH + WINDOW_PADDING * 2.);
    let height = px(stack_height(cards.max(1))).min(work_area.size.height);
    let left = work_area.origin.x + px(EDGE_OFFSET - WINDOW_PADDING);
    let bottom = work_area.origin.y + work_area.size.height - px(EDGE_OFFSET - WINDOW_PADDING);
    Bounds {
        origin: point(left, (bottom - height).max(work_area.origin.y)),
        size: size(width, height),
    }
}

/// Which entries to drop so `limit` remain: the oldest ones that are not in
/// the middle of an action. Entries are newest first.
pub fn overflow(states: &[bool], limit: usize) -> Vec<usize> {
    let mut excess = states.len().saturating_sub(limit);
    let mut dropped = Vec::new();
    for (index, busy) in states.iter().enumerate().rev() {
        if excess == 0 {
            break;
        }
        if !busy {
            dropped.push(index);
            excess -= 1;
        }
    }
    dropped
}

pub fn format_duration(seconds: f64) -> String {
    let total = seconds.max(0.).round() as u64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let secs = total % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes}:{secs:02}")
    }
}

pub fn format_size(bytes: u64) -> String {
    crate::i18n::decimal(format!("{:.2} MB", bytes as f64 / (1024. * 1024.)))
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Details {
    duration_secs: Option<f64>,
    size_bytes: u64,
}

struct Entry {
    id: u64,
    path: PathBuf,
    kind: MediaKind,
    thumbnail: Option<PathBuf>,
    details: Option<Details>,
    shared: bool,
    state: ActionState,
    cancel: Arc<AtomicBool>,
    task: Option<Task<()>>,
    settle: Option<Task<()>>,
}

impl Entry {
    fn bundle(&self) -> PathBuf {
        match self.kind {
            MediaKind::Recording => self.path.clone(),
            MediaKind::Screenshot => self
                .path
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| self.path.clone()),
        }
    }
}

#[derive(Default)]
pub struct Overlay {
    entries: Vec<Entry>,
    next_id: u64,
    hidden_for_capture: bool,
    window: Option<WindowHandle<OverlayView>>,
    shown_cards: usize,
    card_limit: Option<usize>,
}

struct OverlayGlobal(Entity<Overlay>);

impl Global for OverlayGlobal {}

fn model(cx: &mut App) -> Entity<Overlay> {
    if let Some(global) = cx.try_global::<OverlayGlobal>() {
        return global.0.clone();
    }
    let model = cx.new(|_| Overlay::default());
    cx.observe(&model, |model, cx| {
        cx.defer(move |cx| sync_window(&model, cx));
    })
    .detach();
    cx.set_global(OverlayGlobal(model.clone()));
    model
}

fn existing_model(cx: &App) -> Option<Entity<Overlay>> {
    cx.try_global::<OverlayGlobal>()
        .map(|global| global.0.clone())
}

/// A cleanly stopped Studio recording, for the "Show in overlay" behaviour.
pub fn show_studio_recording(project_dir: PathBuf, cx: &mut App) {
    model(cx).update(cx, |overlay, cx| {
        overlay.add(project_dir, MediaKind::Recording, cx)
    });
}

/// A screenshot finished (or failed): the stack comes back, and a new
/// screenshot joins it when it is already showing cards.
pub fn screenshot_captured(png: Option<&Path>, cx: &mut App) {
    let Some(model) = existing_model(cx) else {
        return;
    };
    model.update(cx, |overlay, cx| overlay.screenshot_captured(png, cx));
}

/// Hides the stack for a capture. Returns whether it was on screen, so the
/// caller can give the compositor a beat before grabbing pixels.
pub fn hide_for_capture(cx: &mut App) -> bool {
    let Some(model) = existing_model(cx) else {
        return false;
    };
    let visible = model.read(cx).window.is_some();
    if let Some(handle) = model.update(cx, |overlay, cx| {
        overlay.set_hidden_for_capture(true, cx);
        overlay.window.take()
    }) {
        close_window(handle, cx);
    }
    visible
}

pub fn show_after_capture(cx: &mut App) {
    if let Some(model) = existing_model(cx) {
        model.update(cx, |overlay, cx| overlay.set_hidden_for_capture(false, cx));
    }
}

fn close_window(handle: WindowHandle<OverlayView>, cx: &mut App) {
    handle
        .update(cx, |_, window, _| window.remove_window())
        .ok();
}

fn sync_window(model: &Entity<Overlay>, cx: &mut App) {
    let (wanted, cards, window, shown) = {
        let overlay = model.read(cx);
        (
            !overlay.entries.is_empty() && !overlay.hidden_for_capture,
            overlay.entries.len(),
            overlay.window,
            overlay.shown_cards,
        )
    };
    match (wanted, window) {
        (false, Some(handle)) => {
            model.update(cx, |overlay, _| overlay.window = None);
            close_window(handle, cx);
        }
        (true, None) => open_window(model, cards, cx),
        (true, Some(handle)) if cards != shown => {
            model.update(cx, |overlay, _| overlay.shown_cards = cards);
            resize_window(model, handle, cards, cx);
        }
        _ => {}
    }
}

fn overlay_level() -> isize {
    if cfg!(target_os = "macos") {
        platform::target_overlay_level() - 1
    } else {
        platform::target_overlay_level()
    }
}

fn open_window(model: &Entity<Overlay>, cards: usize, cx: &mut App) {
    #[cfg(target_os = "linux")]
    if crate::app_windows::clean_capture_active(cx) {
        return;
    }
    let display = scap_targets::Display::get_containing_cursor()
        .or_else(|| Some(scap_targets::Display::primary()));
    let Some(work_area) = crate::app_windows::display_work_area(display.as_ref(), cx) else {
        tracing::warn!("recordings overlay has no display to open on");
        return;
    };
    let limit = max_cards(f32::from(work_area.size.height));
    model.update(cx, |overlay, cx| overlay.set_card_limit(limit, cx));
    let cards = model.read(cx).entries.len().min(cards.max(1));
    let bounds = stack_bounds(work_area, cards);
    let display_id = crate::app_windows::gpui_display_id(display.as_ref(), cx);
    let view_model = model.clone();
    let handle = cx.open_window(
        WindowOptions {
            #[cfg(target_os = "linux")]
            app_id: Some(crate::app_windows::app_id().into()),
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            display_id,
            titlebar: None,
            kind: WindowKind::PopUp,
            focus: false,
            show: true,
            is_resizable: false,
            is_minimizable: false,
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        |window, cx| cx.new(|cx| OverlayView::new(view_model, window, cx)),
    );
    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("recordings overlay window failed to open: {error:#}");
            return;
        }
    };
    model.update(cx, |overlay, _| {
        overlay.window = Some(handle);
        overlay.shown_cards = cards;
    });
    let native = handle
        .update(cx, |_, window, _| {
            platform::apply_panel_behavior(
                window,
                platform::PanelBehavior {
                    level: overlay_level(),
                    join_all_spaces: true,
                    shadow: false,
                },
            );
            platform::show_window_without_focus(window);
            platform::native_window(window)
        })
        .ok()
        .flatten();
    crate::app_windows::remove_popup_window_chrome(native, cx);
}

fn resize_window(
    model: &Entity<Overlay>,
    handle: WindowHandle<OverlayView>,
    cards: usize,
    cx: &mut App,
) {
    #[cfg(any(target_os = "macos", windows))]
    {
        let _ = model;
        let height = f64::from(stack_height(cards));
        if let Ok((Some(native), scale)) = handle.update(cx, |_, window, _| {
            (platform::native_window(window), window.scale_factor())
        }) {
            cx.spawn(async move |_| fit_window_height(&native, height, scale))
                .detach();
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = cards;
        model.update(cx, |overlay, _| overlay.window = None);
        close_window(handle, cx);
        let model = model.clone();
        cx.defer(move |cx| sync_window(&model, cx));
    }
}

/// Grows or shrinks the stack's window keeping its bottom edge where it is,
/// `fit_controls_to_issue`'s frame arithmetic.
#[cfg(any(target_os = "macos", windows))]
fn fit_window_height(native: &platform::NativeWindow, height: f64, scale: f32) {
    let (x, y, width, current) = platform::window_frame(native);
    if width <= 0. {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (current, scale);
        platform::set_window_frame(native, x, y, width, height);
    }
    #[cfg(windows)]
    {
        let height = height * f64::from(scale);
        platform::set_window_frame(native, x, y + current - height, width, height);
    }
}

impl Overlay {
    fn set_hidden_for_capture(&mut self, hidden: bool, cx: &mut Context<Self>) {
        if self.hidden_for_capture == hidden {
            return;
        }
        self.hidden_for_capture = hidden;
        if !hidden {
            self.prune_missing();
        }
        cx.notify();
    }

    fn screenshot_captured(&mut self, png: Option<&Path>, cx: &mut Context<Self>) {
        if let Some(png) = png
            && !self.entries.is_empty()
        {
            self.add(png.to_path_buf(), MediaKind::Screenshot, cx);
        }
        self.set_hidden_for_capture(false, cx);
    }

    fn set_card_limit(&mut self, limit: usize, cx: &mut Context<Self>) {
        self.card_limit = Some(limit);
        self.enforce_limit(cx);
    }

    fn enforce_limit(&mut self, _cx: &mut Context<Self>) {
        let Some(limit) = self.card_limit else {
            return;
        };
        let busy: Vec<bool> = self
            .entries
            .iter()
            .map(|entry| entry.state.is_busy())
            .collect();
        let mut dropped = overflow(&busy, limit);
        dropped.sort_unstable_by(|a, b| b.cmp(a));
        for index in dropped {
            self.entries.remove(index);
        }
    }

    fn prune_missing(&mut self) {
        self.entries
            .retain(|entry| entry.state.is_busy() || entry.path.exists());
    }

    fn add(&mut self, path: PathBuf, kind: MediaKind, cx: &mut Context<Self>) {
        if self.entries.iter().any(|entry| entry.path == path) {
            return;
        }
        let id = self.next_id;
        self.next_id += 1;
        let thumbnail = match kind {
            MediaKind::Recording => {
                Some(path.join("screenshots").join("display.jpg")).filter(|path| path.exists())
            }
            MediaKind::Screenshot => Some(path.clone()),
        };
        let bundle = match kind {
            MediaKind::Recording => path.clone(),
            MediaKind::Screenshot => path.parent().map(Path::to_path_buf).unwrap_or_default(),
        };
        let shared = RecordingMeta::load_for_project(&bundle)
            .ok()
            .is_some_and(|meta| meta.sharing.is_some());
        self.entries.insert(
            0,
            Entry {
                id,
                path: path.clone(),
                kind,
                thumbnail,
                details: None,
                shared,
                state: ActionState::Idle,
                cancel: Arc::new(AtomicBool::new(false)),
                task: None,
                settle: None,
            },
        );
        self.enforce_limit(cx);
        if kind == MediaKind::Recording {
            let task = cx
                .background_executor()
                .spawn(async move { load_details(&path) });
            cx.spawn(async move |this, cx| {
                let details = task.await;
                this.update(cx, |overlay, cx| {
                    if let Some(entry) = overlay.entry_mut(id) {
                        entry.details = Some(details);
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        }
        cx.notify();
    }

    fn entry(&self, id: u64) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.id == id)
    }

    fn entry_mut(&mut self, id: u64) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|entry| entry.id == id)
    }

    fn remove(&mut self, id: u64, cx: &mut Context<Self>) {
        if let Some(index) = self.entries.iter().position(|entry| entry.id == id) {
            let entry = self.entries.remove(index);
            entry.cancel.store(true, Ordering::Release);
            cx.notify();
        }
    }

    fn set_state(&mut self, id: u64, state: ActionState, cx: &mut Context<Self>) {
        let Some(entry) = self.entry_mut(id) else {
            return;
        };
        let settle_after = match &state {
            ActionState::Done(_) => Some(DONE_VISIBLE),
            ActionState::Failed(..) => Some(FAILURE_VISIBLE),
            _ => None,
        };
        entry.state = state;
        entry.settle = settle_after.map(|delay| {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(delay).await;
                this.update(cx, |overlay, cx| {
                    if let Some(entry) = overlay.entry_mut(id)
                        && matches!(entry.state, ActionState::Done(_) | ActionState::Failed(..))
                    {
                        entry.state = ActionState::Idle;
                        entry.settle = None;
                        cx.notify();
                    }
                })
                .ok();
            })
        });
        cx.notify();
    }

    fn begin(&mut self, id: u64, kind: ActionKind, stage: Stage, cx: &mut Context<Self>) -> bool {
        let Some(entry) = self.entry_mut(id) else {
            return false;
        };
        if entry.state.is_busy() {
            return false;
        }
        if !entry.path.exists() {
            self.remove(id, cx);
            return false;
        }
        entry.cancel = Arc::new(AtomicBool::new(false));
        self.set_state(id, ActionState::Busy(kind, stage), cx);
        true
    }

    fn cancel_flag(&self, id: u64) -> Arc<AtomicBool> {
        self.entry(id)
            .map(|entry| entry.cancel.clone())
            .unwrap_or_else(|| Arc::new(AtomicBool::new(true)))
    }

    fn store_task(&mut self, id: u64, task: Task<()>) {
        if let Some(entry) = self.entry_mut(id) {
            entry.task = Some(task);
        }
    }

    fn reset(&mut self, id: u64, cx: &mut Context<Self>) {
        self.set_state(id, ActionState::Idle, cx);
    }

    fn copy(&mut self, id: u64, cx: &mut Context<Self>) {
        let Some(kind) = self.entry(id).map(|entry| entry.kind) else {
            return;
        };
        let first = match kind {
            MediaKind::Recording => Stage::Rendering {
                rendered: 0,
                total: 0,
            },
            MediaKind::Screenshot => Stage::Copying,
        };
        if !self.begin(id, ActionKind::Copy, first, cx) {
            return;
        }
        let Some(entry) = self.entry(id) else {
            return;
        };
        let path = entry.path.clone();
        let cancel = entry.cancel.clone();
        let task = cx.spawn(async move |this, cx| {
            let result = match kind {
                MediaKind::Recording => {
                    match render_for_project(&this, id, ActionKind::Copy, &path, None, &cancel, cx)
                        .await
                    {
                        Ok(output) => {
                            update_stage(&this, id, ActionKind::Copy, Stage::Copying, cx);
                            cx.update(|cx| platform::copy_file_to_clipboard(&output, cx))
                        }
                        Err(error) => Err(error),
                    }
                }
                MediaKind::Screenshot => {
                    let copied = cx.update(|cx| platform::copy_image_to_clipboard(path, cx));
                    copied.await
                }
            };
            finish(&this, id, ActionKind::Copy, result.map(|_| ()), &cancel, cx);
        });
        self.store_task(id, task);
    }

    fn save_to(&mut self, id: u64, destination: PathBuf, cx: &mut Context<Self>) {
        let Some(entry) = self.entry(id) else {
            return;
        };
        let kind = entry.kind;
        let path = entry.path.clone();
        let cancel = entry.cancel.clone();
        let stage = match kind {
            MediaKind::Recording => Stage::Rendering {
                rendered: 0,
                total: 0,
            },
            MediaKind::Screenshot => Stage::Saving,
        };
        self.set_state(id, ActionState::Busy(ActionKind::Save, stage), cx);
        let task = cx.spawn(async move |this, cx| {
            let result = match kind {
                MediaKind::Recording => render_for_project(
                    &this,
                    id,
                    ActionKind::Save,
                    &path,
                    Some(destination),
                    &cancel,
                    cx,
                )
                .await
                .map(|_| ()),
                MediaKind::Screenshot => {
                    cx.background_executor()
                        .spawn(async move {
                            std::fs::copy(&path, &destination)
                                .map(|_| ())
                                .map_err(|error| error.to_string())
                        })
                        .await
                }
            };
            finish(&this, id, ActionKind::Save, result, &cancel, cx);
        });
        self.store_task(id, task);
    }

    fn share(&mut self, id: u64, cx: &mut Context<Self>) {
        let Some(entry) = self.entry(id) else {
            return;
        };
        let kind = entry.kind;
        let path = entry.path.clone();
        let bundle = entry.bundle();
        let duration = entry.details.and_then(|details| details.duration_secs);

        let existing = RecordingMeta::load_for_project(&bundle)
            .ok()
            .and_then(|meta| meta.sharing)
            .map(|sharing| sharing.link);
        if let Some(link) = existing {
            if !self.begin(id, ActionKind::Share, Stage::Uploading(1.), cx) {
                return;
            }
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(link));
            crate::app_sounds::play_notification();
            self.set_state(id, ActionState::Done(ActionKind::Share), cx);
            return;
        }

        let auth = crate::store::auth_snapshot();
        if !auth.signed_in() {
            if self.entry(id).is_some_and(|entry| !entry.state.is_busy()) {
                self.set_state(
                    id,
                    ActionState::Failed(
                        ActionKind::Share,
                        tr::editor::export::sign_in_required().to_string(),
                    ),
                    cx,
                );
                crate::sign_in::SignIn::global(cx).update(cx, |sign_in, cx| {
                    sign_in.start(crate::sign_in::SignInOrigin::Settings, cx)
                });
            }
            return;
        }
        let needs_upgrade = match kind {
            MediaKind::Recording => {
                !auth.is_upgraded() && duration.is_some_and(|secs| secs >= FREE_SHARE_LIMIT_SECS)
            }
            MediaKind::Screenshot => !auth.is_upgraded(),
        };
        if needs_upgrade {
            if self.entry(id).is_some_and(|entry| !entry.state.is_busy()) {
                cx.open_url(crate::auth::PRICING_URL);
                self.set_state(
                    id,
                    ActionState::Failed(
                        ActionKind::Share,
                        tr::editor::export::upgrade_message().to_string(),
                    ),
                    cx,
                );
            }
            return;
        }

        let first = match kind {
            MediaKind::Recording => Stage::Rendering {
                rendered: 0,
                total: 0,
            },
            MediaKind::Screenshot => Stage::Uploading(0.),
        };
        if !self.begin(id, ActionKind::Share, first, cx) {
            return;
        }
        let organizations: Vec<String> = auth
            .organizations
            .iter()
            .map(|org| org.id.clone())
            .collect();
        let saved = crate::store::load()
            .export
            .and_then(|prefs| prefs.organization_id);
        let organization_id = share_organization(saved.as_deref(), &organizations);
        let cancel = self.cancel_flag(id);
        let task = cx.spawn(async move |this, cx| {
            let result = match kind {
                MediaKind::Recording => {
                    share_recording(&this, id, path, organization_id, &cancel, cx).await
                }
                MediaKind::Screenshot => share_screenshot(path, bundle, cx).await,
            };
            let result = match result {
                Ok(ShareOutcome::Link(link)) => {
                    cx.update(|cx| {
                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(link));
                    });
                    Ok(())
                }
                Ok(ShareOutcome::SignIn) => {
                    cx.update(|cx| {
                        crate::sign_in::SignIn::global(cx).update(cx, |sign_in, cx| {
                            sign_in.start(crate::sign_in::SignInOrigin::Settings, cx)
                        });
                    });
                    Err(tr::editor::export::sign_in_required().to_string())
                }
                Ok(ShareOutcome::Upgrade) => {
                    cx.update(|cx| cx.open_url(crate::auth::PRICING_URL));
                    Err(tr::editor::export::upgrade_message().to_string())
                }
                Err(error) => Err(error),
            };
            finish(&this, id, ActionKind::Share, result, &cancel, cx);
        });
        self.store_task(id, task);
    }
}

enum ShareOutcome {
    Link(String),
    SignIn,
    Upgrade,
}

fn update_stage(
    this: &WeakEntity<Overlay>,
    id: u64,
    kind: ActionKind,
    stage: Stage,
    cx: &mut AsyncApp,
) {
    this.update(cx, |overlay, cx| {
        if let Some(entry) = overlay.entry_mut(id)
            && matches!(entry.state, ActionState::Busy(current, _) if current == kind)
        {
            entry.state = ActionState::Busy(kind, stage);
            cx.notify();
        }
    })
    .ok();
}

fn finish(
    this: &WeakEntity<Overlay>,
    id: u64,
    kind: ActionKind,
    result: Result<(), String>,
    cancel: &AtomicBool,
    cx: &mut AsyncApp,
) {
    let cancelled = cancel.load(Ordering::Acquire);
    match &result {
        Ok(()) => crate::app_sounds::play_notification(),
        Err(error) if !cancelled => {
            tracing::error!(?kind, error, "recordings overlay action failed")
        }
        Err(_) => {}
    }
    this.update(cx, |overlay, cx| {
        if let Some(entry) = overlay.entry_mut(id) {
            entry.task = None;
        }
        let state = match result {
            Ok(()) => ActionState::Done(kind),
            Err(_) if cancelled => ActionState::Idle,
            Err(error) => ActionState::Failed(kind, error),
        };
        if state == ActionState::Done(ActionKind::Share)
            && let Some(entry) = overlay.entry_mut(id)
        {
            entry.shared = true;
        }
        overlay.set_state(id, state, cx);
    })
    .ok();
}

/// Renders the recording with the Tauri overlay's settings (MP4, 60 fps,
/// 1080p, Web compression) into `destination`, or into the project's own
/// output file that `upload_exported_video` reads.
async fn render_for_project(
    this: &WeakEntity<Overlay>,
    id: u64,
    kind: ActionKind,
    project_path: &Path,
    destination: Option<PathBuf>,
    cancel: &Arc<AtomicBool>,
    cx: &mut AsyncApp,
) -> Result<PathBuf, String> {
    let meta = RecordingMeta::load_for_project(project_path)
        .map_err(|error| format!("Failed to load recording metadata: {error}"))?;
    let save_path = destination.unwrap_or_else(|| meta.output_path());
    if let Some(parent) = save_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create the export folder: {error}"))?;
    }
    let project = cap_project::ProjectConfiguration::load(project_path).unwrap_or_default();
    let (progress_tx, progress_rx) = flume::unbounded::<(u32, u32)>();
    let (width, height) = OVERLAY_EXPORT_SIZE;
    let export = gpui_tokio::Tokio::spawn(
        cx,
        crate::editor_export::run_export(
            project_path.to_path_buf(),
            project,
            crate::editor_export::ExportFormatKind::Mp4,
            false,
            OVERLAY_EXPORT_FPS,
            width,
            height,
            cap_export::mp4::ExportCompression::Web,
            None,
            None,
            false,
            false,
            false,
            Some(save_path),
            progress_tx,
            cancel.clone(),
        ),
    );
    loop {
        let mut latest = None;
        while let Ok(progress) = progress_rx.try_recv() {
            latest = Some(progress);
        }
        if let Some((rendered, total)) = latest {
            update_stage(this, id, kind, Stage::Rendering { rendered, total }, cx);
        }
        if progress_rx.is_disconnected() {
            break;
        }
        cx.background_executor().timer(PROGRESS_POLL).await;
    }
    match export.await {
        Ok(result) => result,
        Err(error) => Err(format!("Export task failed: {error}")),
    }
}

async fn share_recording(
    this: &WeakEntity<Overlay>,
    id: u64,
    project_path: PathBuf,
    organization_id: Option<String>,
    cancel: &Arc<AtomicBool>,
    cx: &mut AsyncApp,
) -> Result<ShareOutcome, String> {
    render_for_project(this, id, ActionKind::Share, &project_path, None, cancel, cx).await?;
    update_stage(this, id, ActionKind::Share, Stage::Uploading(0.), cx);
    let (progress_tx, progress_rx) = flume::unbounded::<f64>();
    let upload_cancel = cancel.clone();
    let upload = gpui_tokio::Tokio::spawn(cx, async move {
        crate::upload::upload_exported_video(
            project_path,
            organization_id,
            move |progress| {
                let _ = progress_tx.send(progress);
            },
            upload_cancel,
        )
        .await
    });
    loop {
        let mut latest = None;
        while let Ok(progress) = progress_rx.try_recv() {
            latest = Some(progress);
        }
        if let Some(progress) = latest {
            update_stage(
                this,
                id,
                ActionKind::Share,
                Stage::Uploading(progress as f32),
                cx,
            );
        }
        if progress_rx.is_disconnected() {
            break;
        }
        cx.background_executor().timer(PROGRESS_POLL).await;
    }
    match upload.await {
        Ok(Ok(crate::upload::UploadResult::Success(link))) => Ok(ShareOutcome::Link(link)),
        Ok(Ok(crate::upload::UploadResult::NotAuthenticated)) => Ok(ShareOutcome::SignIn),
        Ok(Ok(crate::upload::UploadResult::UpgradeRequired)) => Ok(ShareOutcome::Upgrade),
        Ok(Err(error)) => Err(error),
        Err(error) => Err(format!("Upload task failed: {error}")),
    }
}

/// The screenshot as captured, the Tauri overlay's `upload_screenshot` of the
/// file itself. The link is saved on the bundle without a content hash, so a
/// later share from the screenshot editor re-uploads its render under the
/// same record and link.
async fn share_screenshot(
    png: PathBuf,
    bundle: PathBuf,
    cx: &mut AsyncApp,
) -> Result<ShareOutcome, String> {
    let bytes = cx
        .background_executor()
        .spawn(async move { std::fs::read(&png) })
        .await
        .map_err(|error| format!("Could not read the screenshot: {error}"))?;
    let upload = gpui_tokio::Tokio::spawn(cx, async move {
        crate::upload::upload_rendered_screenshot(bytes, "image/png", None).await
    });
    let item = match upload.await {
        Ok(Ok(crate::upload::ScreenshotShareOutcome::Uploaded(item))) => item,
        Ok(Ok(crate::upload::ScreenshotShareOutcome::NotAuthenticated)) => {
            return Ok(ShareOutcome::SignIn);
        }
        Ok(Ok(crate::upload::ScreenshotShareOutcome::UpgradeRequired)) => {
            return Ok(ShareOutcome::Upgrade);
        }
        Ok(Err(error)) => return Err(error),
        Err(error) => return Err(format!("Upload task failed: {error}")),
    };
    match RecordingMeta::load_for_project(&bundle) {
        Ok(mut meta) => {
            meta.sharing = Some(SharingMeta {
                id: item.id,
                link: item.link.clone(),
                content_hash: None,
            });
            if let Err(error) = meta.save_for_project() {
                tracing::warn!(?error, "saving the screenshot share link failed");
            }
        }
        Err(error) => tracing::warn!(%error, "screenshot meta unavailable for its share link"),
    }
    Ok(ShareOutcome::Link(item.link))
}

fn load_details(project: &Path) -> Details {
    let duration_secs = RecordingMeta::load_for_project(project)
        .ok()
        .and_then(|meta| {
            let displays: Vec<PathBuf> = match meta.studio_meta()? {
                StudioRecordingMeta::SingleSegment { segment } => {
                    vec![meta.path(&segment.display.path)]
                }
                StudioRecordingMeta::MultipleSegments { inner } => inner
                    .segments
                    .iter()
                    .map(|segment| meta.path(&segment.display.path))
                    .collect(),
            };
            let mut total = 0.;
            for display in displays {
                let input = ffmpeg::format::input(&display).ok()?;
                let duration = input.duration();
                if duration > 0 {
                    total += duration as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE);
                }
            }
            (total > 0.).then_some(total)
        });
    Details {
        duration_secs,
        size_bytes: directory_size(project),
    }
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => directory_size(&entry.path()),
            Ok(kind) if kind.is_file() => entry.metadata().map(|meta| meta.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

pub struct OverlayView {
    model: Entity<Overlay>,
    theme: Theme,
    _observe: Subscription,
}

impl OverlayView {
    fn new(model: Entity<Overlay>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::theme::bind_window(window, cx);
        let theme = Theme::for_window(window, cx, false);
        let observe = cx.observe(&model, |_, _, cx| cx.notify());
        Self {
            model,
            theme,
            _observe: observe,
        }
    }

    fn close(&mut self, id: u64, cx: &mut Context<Self>) {
        self.model.update(cx, |overlay, cx| overlay.remove(id, cx));
    }

    fn edit(&mut self, id: u64, cx: &mut Context<Self>) {
        let Some(path) = self
            .model
            .read(cx)
            .entry(id)
            .map(|entry| entry.path.clone())
        else {
            return;
        };
        if !path.exists() {
            self.close(id, cx);
            return;
        }
        self.model.update(cx, |overlay, cx| overlay.remove(id, cx));
        cx.defer(move |cx| crate::app_windows::open_editor(path, cx));
    }

    fn open(&mut self, id: u64, cx: &mut Context<Self>) {
        let Some(path) = self
            .model
            .read(cx)
            .entry(id)
            .map(|entry| entry.path.clone())
        else {
            return;
        };
        if !path.exists() {
            self.close(id, cx);
            return;
        }
        cx.open_with_system(&path);
    }

    fn copy(&mut self, id: u64, cx: &mut Context<Self>) {
        self.model.update(cx, |overlay, cx| overlay.copy(id, cx));
    }

    fn share(&mut self, id: u64, cx: &mut Context<Self>) {
        self.model.update(cx, |overlay, cx| overlay.share(id, cx));
    }

    fn save(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some((kind, path)) = self
            .model
            .read(cx)
            .entry(id)
            .map(|entry| (entry.kind, entry.bundle()))
        else {
            return;
        };
        let started = self.model.update(cx, |overlay, cx| {
            overlay.begin(id, ActionKind::Save, Stage::ChoosingLocation, cx)
        });
        if !started {
            return;
        }
        let pretty_name = RecordingMeta::load_for_project(&path)
            .map(|meta| meta.pretty_name)
            .unwrap_or_default();
        let extension = match kind {
            MediaKind::Recording => "mp4",
            MediaKind::Screenshot => "png",
        };
        let suggested = crate::editor_export::export_file_name(&pretty_name, extension);
        let model = self.model.clone();
        cx.spawn_in(window, async move |_, cx| {
            let chosen = match std::env::var_os("CAP_GPUI_AUTO_EXPORT") {
                Some(path) => Some(PathBuf::from(path)),
                None => choose_save_path(&suggested, extension, cx).await,
            };
            model.update(cx, |overlay, cx| match chosen {
                Some(destination) => overlay.save_to(id, destination, cx),
                None => overlay.reset(id, cx),
            });
        })
        .detach();
    }

    fn render_card(&self, entry: &Entry, cx: &Context<Self>) -> AnyElement {
        let theme = self.theme;
        let id = entry.id;
        let group: SharedString = format!("recordings-overlay-card-{id}").into();
        let busy = entry.state.is_busy();
        let status = entry.state.title(entry.kind).map(|title| {
            (
                title,
                entry.state.message(entry.kind),
                entry.state.progress(),
                entry.state.clone(),
            )
        });
        let recording = entry.kind == MediaKind::Recording;
        let has_link = entry.shared;

        let thumbnail = match &entry.thumbnail {
            Some(path) => img(path.clone())
                .absolute()
                .inset_0()
                .size_full()
                .object_fit(ObjectFit::Cover)
                .into_any_element(),
            None => div()
                .absolute()
                .inset_0()
                .bg(theme.gray_5)
                .into_any_element(),
        };

        let actions = div()
            .absolute()
            .inset_0()
            .bg(gpui::black().opacity(0.45))
            .opacity(0.)
            .when(!busy && status.is_none(), |this| {
                this.group_hover(group.clone(), |style| style.opacity(1.))
            })
            .child(
                div()
                    .absolute()
                    .top(px(10.))
                    .left(px(10.))
                    .child(self.action_button(
                        ("overlay-close", id),
                        "icons/x.svg",
                        tr::recordings_overlay::close(),
                        cx.listener(move |this, _, _, cx| this.close(id, cx)),
                    )),
            )
            .child(
                div()
                    .absolute()
                    .top(px(10.))
                    .right(px(10.))
                    .child(self.action_button(
                        ("overlay-copy", id),
                        "icons/copy.svg",
                        tr::recordings_overlay::copy(),
                        cx.listener(move |this, _, _, cx| this.copy(id, cx)),
                    )),
            )
            .child(
                div()
                    .absolute()
                    .bottom(px(10.))
                    .left(px(10.))
                    .child(if recording {
                        self.action_button(
                            ("overlay-edit", id),
                            "icons/edit.svg",
                            tr::recordings_overlay::edit(),
                            cx.listener(move |this, _, _, cx| this.edit(id, cx)),
                        )
                    } else {
                        self.action_button(
                            ("overlay-open", id),
                            "icons/arrow-up-right.svg",
                            tr::recordings_overlay::open(),
                            cx.listener(move |this, _, _, cx| this.open(id, cx)),
                        )
                    }),
            )
            .child(
                div()
                    .absolute()
                    .bottom(px(10.))
                    .right(px(10.))
                    .child(self.action_button(
                        ("overlay-share", id),
                        "icons/upload-arrow.svg",
                        if has_link {
                            tr::recordings_overlay::copy_link()
                        } else {
                            tr::recordings_overlay::create_link()
                        },
                        cx.listener(move |this, _, _, cx| this.share(id, cx)),
                    )),
            )
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        ui::Button::plain(
                            &theme,
                            ("overlay-export", id),
                            ui::ButtonVariant::White,
                            ui::ButtonSize::Sm,
                        )
                        .label(tr::recordings_overlay::export())
                        .on_click(
                            cx.listener(move |this, _, window, cx| this.save(id, window, cx)),
                        ),
                    ),
            );

        let details = entry
            .details
            .filter(|_| status.is_none())
            .map(|details| self.details_strip(details, group.clone()));

        div()
            .id(("recordings-overlay-card", id))
            .group(group)
            .relative()
            .flex_shrink_0()
            .w(px(CARD_WIDTH))
            .h(px(CARD_HEIGHT))
            .rounded(px(12.))
            .overflow_hidden()
            .border_1()
            .border_color(gpui::white().opacity(0.1))
            .bg(theme.gray_12)
            .shadow_md()
            .child(thumbnail)
            .when_some(details, |this, details| this.child(details))
            .child(actions)
            .when_some(status, |this, (title, message, progress, state)| {
                this.child(self.status_panel(id, title, message, progress, &state, cx))
            })
            .into_any_element()
    }

    fn action_button(
        &self,
        id: impl Into<gpui::ElementId>,
        icon: &'static str,
        label: &'static str,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    ) -> AnyElement {
        let theme = self.theme;
        div()
            .id(id.into())
            .size(px(28.))
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .bg(theme.gray_1)
            .text_color(theme.gray_12)
            .shadow_sm()
            .cursor_pointer()
            .hover(|style| style.bg(theme.gray_3))
            .active(|style| style.bg(theme.gray_4))
            .child(svg().path(icon).size(px(14.)).text_color(theme.gray_12))
            .tooltip(move |_, cx| ui::Tooltip::new(&theme, label).view(cx))
            .on_click(on_click)
            .into_any_element()
    }

    fn details_strip(&self, details: Details, group: SharedString) -> AnyElement {
        let item = |icon: &'static str, text: String| {
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(
                    svg()
                        .path(icon)
                        .size(px(14.))
                        .text_color(gpui::white().opacity(0.75)),
                )
                .child(text)
        };
        div()
            .absolute()
            .left_0()
            .right_0()
            .bottom_0()
            .px(px(12.))
            .py(px(8.))
            .flex()
            .items_center()
            .justify_between()
            .bg(gpui::black().opacity(0.5))
            .text_size(px(12.))
            .text_color(gpui::white().opacity(0.9))
            .group_hover(group, |style| style.opacity(0.))
            .when_some(details.duration_secs, |this, secs| {
                this.child(item("icons/clock.svg", format_duration(secs)))
            })
            .child(item("icons/database.svg", format_size(details.size_bytes)))
            .into_any_element()
    }

    fn status_panel(
        &self,
        id: u64,
        title: &'static str,
        message: Option<String>,
        progress: f32,
        state: &ActionState,
        cx: &Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let failed = matches!(state, ActionState::Failed(..));
        let retry = match state {
            ActionState::Failed(kind, _) => Some(*kind),
            _ => None,
        };
        let white = gpui::white();
        div()
            .id(("recordings-overlay-status", id))
            .absolute()
            .inset_0()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .px(px(26.))
            .bg(gpui::black().opacity(0.85))
            .text_color(white)
            .child(
                div()
                    .text_size(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_center()
                    .child(title),
            )
            .when(!failed, |this| {
                this.child(
                    div()
                        .mt(px(12.))
                        .w_full()
                        .h(px(6.))
                        .rounded_full()
                        .bg(white.opacity(0.2))
                        .child(
                            div()
                                .h_full()
                                .rounded_full()
                                .bg(theme.blue_9)
                                .w(gpui::relative(progress)),
                        ),
                )
            })
            .when_some(message, |this, message| {
                this.child(
                    div()
                        .mt(px(8.))
                        .w_full()
                        .text_size(px(12.))
                        .text_center()
                        .text_color(white.opacity(0.8))
                        .line_clamp(2)
                        .child(message),
                )
            })
            .when_some(retry, |this, kind| {
                this.child(
                    div().mt(px(10.)).child(
                        ui::Button::plain(
                            &theme,
                            ("overlay-retry", id),
                            ui::ButtonVariant::White,
                            ui::ButtonSize::Sm,
                        )
                        .label(tr::recordings_overlay::retry())
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.model.update(cx, |overlay, cx| overlay.reset(id, cx));
                                match kind {
                                    ActionKind::Copy => this.copy(id, cx),
                                    ActionKind::Save => this.save(id, window, cx),
                                    ActionKind::Share => this.share(id, cx),
                                }
                            },
                        )),
                    ),
                )
            })
            .into_any_element()
    }
}

async fn choose_save_path(
    suggested: &str,
    extension: &str,
    cx: &mut gpui::AsyncWindowContext,
) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let _ = cx;
        match platform::try_save_file_panel(suggested, &[extension]) {
            Ok(path) => path,
            Err(error) => {
                tracing::warn!(error, "save panel unavailable");
                None
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        platform::save_file_panel_async(suggested, &[extension], cx).await
    }
}

impl Render for OverlayView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.theme.refresh(window, cx, false);
        let cx: &Context<Self> = cx;
        let cards: Vec<AnyElement> = self
            .model
            .read(cx)
            .entries
            .iter()
            .map(|entry| self.render_card(entry, cx))
            .collect();
        div()
            .size_full()
            .flex()
            .flex_col()
            .justify_end()
            .gap(px(CARD_GAP))
            .p(px(WINDOW_PADDING))
            .font_family(crate::theme::UI_FONT)
            .locale_font()
            .font_weight(FontWeight::MEDIUM)
            .children(cards)
    }
}
