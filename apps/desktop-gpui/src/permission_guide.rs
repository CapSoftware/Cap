//! The drag-to-grant helper: while System Settings is open on the Screen
//! Recording or Accessibility pane, a small panel floats under its window
//! with Cap's icon to drag into the list.
//!
//! Those two panes (macOS 13+, System Settings) add a `.app` dropped onto
//! their list, which rescues the case where Cap is missing from the list or
//! listed under a stale signature. Camera and Microphone lists accept no
//! drops; they only fill in through the request API, so they get no guide.
//!
//! The panel is a non-activating gpui popup; the drag itself is AppKit
//! ([`platform::begin_file_drag`]) and the Settings window is found by pid
//! through `CGWindowListCopyWindowInfo`, which needs no Screen Recording grant.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    App, AppContext, Bounds, Context, FontWeight, Global, InteractiveElement, IntoElement,
    MouseButton, ParentElement, Render, Styled, Task, Window, WindowBounds, WindowHandle,
    WindowKind, WindowOptions, div, img, point, px, size,
};

use crate::doodle;
use crate::onboarding_doodles as art;
use crate::permissions::OSPermission;
use crate::platform;
use crate::theme::LocaleFont as _;
use crate::theme::Theme;

const PANEL_W: f32 = 404.;
const PANEL_H: f32 = 132.;
const SHADOW_INSET: f32 = 12.;
const TICK: Duration = Duration::from_millis(120);
const GRANT_CHECK_EVERY: u32 = 4;
const GIVE_UP_UNSEEN: Duration = Duration::from_secs(20);
const GIVE_UP_AFTER_CLOSE: Duration = Duration::from_secs(8);
const LIFETIME: Duration = Duration::from_secs(5 * 60);
const SIDEBAR_W: f64 = 230.;

const APP_ICON: &[u8] = include_bytes!("../assets/dock-icon.png");

/// The `.app` to drag: the bundle this binary runs from. A bare dev binary
/// has none -- TCC attributes it to the launching terminal anyway -- so the
/// guide stays off unless a debug build is told to show it.
fn app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    if let Some(bundle) = exe
        .ancestors()
        .find(|path| path.extension().is_some_and(|ext| ext == "app"))
    {
        return Some(bundle.to_path_buf());
    }
    #[cfg(debug_assertions)]
    if std::env::var("CAP_GPUI_FORCE_PERMISSION_GUIDE").is_ok_and(|value| value == "1") {
        return Some(exe);
    }
    None
}

/// `CAP_GPUI_PERMISSION_GUIDE_PREVIEW=1` (debug builds): pretend a Settings
/// window is up and frontmost, so the panel can be photographed.
fn preview() -> bool {
    cfg!(debug_assertions)
        && std::env::var("CAP_GPUI_PERMISSION_GUIDE_PREVIEW").is_ok_and(|value| value == "1")
}

pub fn eligible(permission: OSPermission) -> bool {
    cfg!(target_os = "macos")
        && matches!(
            permission,
            OSPermission::ScreenRecording | OSPermission::Accessibility
        )
        && std::path::Path::new("/System/Applications/System Settings.app").exists()
        && app_bundle().is_some()
}

#[derive(Default)]
struct GuideGlobal {
    handle: Option<WindowHandle<PermissionGuide>>,
    tracker: Option<Task<()>>,
    permission: Option<OSPermission>,
}

impl Global for GuideGlobal {}

pub struct PermissionGuide {
    theme: Theme,
    permission: OSPermission,
    shown_at: Instant,
    hidden: bool,
    app: PathBuf,
    icon: Arc<gpui::Image>,
}

/// Show the guide for `permission` while the user is in System Settings.
/// Idempotent per permission; a different permission replaces the guide.
pub fn start(permission: OSPermission, cx: &mut App) {
    if !eligible(permission) {
        return;
    }
    let Some(app) = app_bundle() else {
        return;
    };
    if cx
        .try_global::<GuideGlobal>()
        .is_some_and(|guide| guide.permission == Some(permission) && guide.handle.is_some())
    {
        return;
    }
    stop(cx);

    let opened = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(0.), px(0.)),
                size: size(px(PANEL_W), px(PANEL_H)),
            })),
            titlebar: None,
            kind: WindowKind::PopUp,
            focus: false,
            show: false,
            is_resizable: false,
            is_minimizable: false,
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        move |window, cx| {
            cx.new(|cx| {
                crate::theme::bind_window(window, cx);
                PermissionGuide {
                    theme: Theme::for_window(window, cx, true),
                    permission,
                    shown_at: Instant::now(),
                    hidden: true,
                    app,
                    icon: Arc::new(gpui::Image::from_bytes(
                        gpui::ImageFormat::Png,
                        APP_ICON.to_vec(),
                    )),
                }
            })
        },
    );
    let handle = match opened {
        Ok(handle) => handle,
        Err(error) => {
            tracing::warn!("permission guide failed to open: {error:#}");
            return;
        }
    };
    let Some(native) = handle
        .update(cx, |_, window, _| platform::native_window(window))
        .ok()
        .flatten()
    else {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
        return;
    };

    let tracker = cx.spawn(async move |cx| {
        let started = Instant::now();
        let mut seen_at: Option<Instant> = None;
        let mut placed: Option<(f64, f64)> = None;
        let mut ticks = 0u32;
        loop {
            cx.background_executor().timer(TICK).await;
            ticks = ticks.wrapping_add(1);
            if ticks.is_multiple_of(GRANT_CHECK_EVERY) {
                let granted = cx
                    .background_executor()
                    .spawn(async move { granted(permission) })
                    .await;
                if granted {
                    tracing::info!(?permission, "permission guide: granted");
                    cx.update(stop);
                    return;
                }
            }
            if started.elapsed() > LIFETIME {
                cx.update(stop);
                return;
            }
            let (frame, front) = if preview() {
                (Some((300., 200., 900., 600.)), true)
            } else {
                (
                    platform::system_settings_frame(),
                    platform::system_settings_frontmost(),
                )
            };
            match frame.filter(|_| front) {
                Some(frame) => {
                    seen_at = Some(Instant::now());
                    let (x, y) = panel_origin(frame);
                    if placed != Some((x, y)) {
                        let fresh = placed.is_none();
                        placed = Some((x, y));
                        platform::place_overlay_panel(
                            &native,
                            x,
                            y,
                            PANEL_W as f64,
                            PANEL_H as f64,
                            FLOATING_LEVEL,
                        );
                        if fresh {
                            handle
                                .update(cx, |guide, _, cx| {
                                    guide.shown_at = Instant::now();
                                    guide.hidden = false;
                                    cx.notify();
                                })
                                .ok();
                        }
                    }
                }
                None => {
                    if placed.take().is_some() {
                        platform::hide_native(&native);
                        handle
                            .update(cx, |guide, _, cx| {
                                guide.hidden = true;
                                cx.notify();
                            })
                            .ok();
                    }
                    let gone = match seen_at {
                        Some(at) => frame.is_none() && at.elapsed() > GIVE_UP_AFTER_CLOSE,
                        None => started.elapsed() > GIVE_UP_UNSEEN,
                    };
                    if gone {
                        cx.update(stop);
                        return;
                    }
                }
            }
        }
    });

    cx.set_global(GuideGlobal {
        handle: Some(handle),
        tracker: Some(tracker),
        permission: Some(permission),
    });
}

#[cfg(debug_assertions)]
pub fn window_handle(cx: &App) -> Option<gpui::AnyWindowHandle> {
    cx.try_global::<GuideGlobal>()?.handle.map(Into::into)
}

/// `CAP_GPUI_PERMISSION_GUIDE_PREVIEW=1`: open the guide at launch.
#[cfg(debug_assertions)]
pub fn preview_from_env(cx: &mut App) {
    if preview() {
        start(OSPermission::ScreenRecording, cx);
    }
}

pub fn stop(cx: &mut App) {
    let Some(guide) = cx.try_global::<GuideGlobal>() else {
        return;
    };
    if guide.handle.is_none() && guide.tracker.is_none() {
        return;
    }
    let guide = std::mem::take(cx.global_mut::<GuideGlobal>());
    drop(guide.tracker);
    if let Some(handle) = guide.handle {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
}

/// `NSFloatingWindowLevel`: above System Settings, below its auth sheets.
const FLOATING_LEVEL: isize = 3;

fn granted(permission: OSPermission) -> bool {
    let Some(raw) = crate::permissions_ui::sweep_raw_preflight() else {
        return false;
    };
    match permission {
        OSPermission::ScreenRecording => raw.screen_granted,
        OSPermission::Accessibility => raw.accessibility_granted,
        OSPermission::Microphone | OSPermission::Camera => true,
    }
}

/// Under the Settings window, centred on its content pane (right of the
/// sidebar); tucked inside the bottom edge when the screen has no room below.
fn panel_origin((x, y, width, height): (f64, f64, f64, f64)) -> (f64, f64) {
    let sidebar = if width > 640. { SIDEBAR_W } else { 0. };
    let panel_w = PANEL_W as f64;
    let panel_h = PANEL_H as f64;
    let inset = SHADOW_INSET as f64;
    let left = (x + sidebar + (width - sidebar - panel_w) / 2.).round();
    let below = y + height - inset + 10.;
    let screen_bottom = scap_targets::Display::list()
        .into_iter()
        .filter_map(|display| display.raw_handle().logical_bounds())
        .find(|bounds| {
            let (bx, by) = (bounds.position().x(), bounds.position().y());
            let (bw, bh) = (bounds.size().width(), bounds.size().height());
            let (cx, cy) = (x + width / 2., y + height / 2.);
            cx >= bx && cx < bx + bw && cy >= by && cy < by + bh
        })
        .map(|bounds| bounds.position().y() + bounds.size().height());
    let top = match screen_bottom {
        Some(bottom) if below + panel_h > bottom - 4. => y + height - panel_h - 14.,
        _ => below,
    };
    (left, top.round())
}

impl Render for PermissionGuide {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.theme = Theme::for_window(window, cx, true);
        let paper = crate::onboarding_window::Paper::new(&self.theme);
        let palette = paper.palette();
        // The arrow bobs forever; a hidden panel must not keep drawing.
        let still = self.hidden;
        let pane = match self.permission {
            OSPermission::Accessibility => "Accessibility",
            _ => "Screen & System Audio Recording",
        };
        div()
            .size_full()
            .p(px(SHADOW_INSET))
            .font_family(crate::theme::UI_FONT)
            .locale_font()
            .child(
                div()
                    .size_full()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(14.))
                    .px(px(14.))
                    .rounded(px(20.))
                    .border(px(1.5))
                    .border_color(paper.track)
                    .bg(paper.bg)
                    .shadow_lg()
                    .child(
                        div()
                            .id("permission-guide-icon")
                            .relative()
                            .flex_none()
                            .size(px(80.))
                            .cursor_grab()
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|this, _, window, _| {
                                    if !platform::begin_file_drag(window, &this.app) {
                                        tracing::warn!("permission guide: drag did not start");
                                    }
                                }),
                            )
                            .child(
                                div().absolute().inset_0().child(doodle::doodle(
                                    &art::DRAG_FRAME,
                                    palette,
                                    self.shown_at,
                                    still,
                                    80.,
                                    80.,
                                )),
                            )
                            .child(
                                div()
                                    .absolute()
                                    .inset_0()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(img(self.icon.clone()).size(px(52.))),
                            ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(3.))
                            .child(
                                div()
                                    .text_size(px(15.))
                                    .line_height(px(19.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(paper.ink)
                                    .child("Drag Cap into the list"),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(17.))
                                    .font_weight(FontWeight::NORMAL)
                                    .text_color(paper.soft)
                                    .child(format!(
                                        "Drop it on the {pane} list above, then make sure its switch is on."
                                    )),
                            ),
                    )
                    .child(div().flex_none().child(doodle::doodle(
                        &art::UP_ARROW,
                        palette,
                        self.shown_at,
                        still,
                        34.,
                        44.,
                    ))),
            )
    }
}
