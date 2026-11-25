use std::{
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable, FontWeight,
    InteractiveElement, IntoElement, MouseButton, ParentElement, Pixels, Point, Render,
    SharedString, StatefulInteractiveElement, StyleRefinement, Styled, Subscription, Task,
    WeakEntity, Window, WindowBackgroundAppearance, WindowBounds, WindowKind, WindowOptions, div,
    point, prelude::FluentBuilder, px, size,
};
use serde_json::{Value, json};

use super::start::StartChoice;
use super::{
    CloseDocuments, Dismiss, FocusSearch, GoHome, KEY_CONTEXT, NewMeetingNotes, NewNote,
    ShowGeneratedNotes, ShowMyNotes, ShowTranscript, ToggleAsk, ToggleRecording, ToggleSidebar,
    WriteNotes, glass,
    home::{Home, HomeEvent},
    pane::Pane,
    sidebar::{Sidebar, SidebarEvent},
    store::{DocStore, Scope, StoreEvent},
    style::{self, Palette},
    writer,
};
use crate::{
    i18n::tr,
    meetings_ui::MeetingWindows,
    platform,
    theme::{LocaleFont as _, Theme},
};

pub const DEFAULT_WIDTH: f32 = 1120.;
pub const DEFAULT_HEIGHT: f32 = 760.;
pub const MIN_WIDTH: f32 = 640.;
pub const MIN_HEIGHT: f32 = 480.;
pub const TITLE: &str = "Cap Notes";
const FRAME_SECTION: &str = "documentsWindow";
const FRAME_KEY: &str = "frame";
/// The person's own sidebar choice. Absent until they toggle it: until then
/// the sidebar is shown (see [`sidebar_default`]).
const SIDEBAR_KEY: &str = "sidebarChoice";
const TOAST_FOR: Duration = Duration::from_secs(6);
pub const TRAFFIC_LIGHTS: Point<Pixels> = Point {
    x: px(18.),
    y: px(19.),
};
const LEADING_INSET: f32 = 84.;
const NARROW_WIDTH: f32 = 740.;

pub type ToastAction = Rc<dyn Fn(&mut Window, &mut App)>;
pub type ToastExpire = Rc<dyn Fn(&mut App)>;

pub struct Toast {
    serial: u64,
    message: SharedString,
    action: Option<(SharedString, ToastAction)>,
    on_expire: Option<ToastExpire>,
}

/// Something that went wrong while the window was not in front, such as an
/// automatic start that failed. It stays, in its own space under the page's
/// toolbar, until the person dismisses it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub message: SharedString,
    /// A second, quieter line: why, when Cap can tell.
    pub detail: Option<SharedString>,
}

pub struct DocumentsWindow {
    focus: FocusHandle,
    pub theme: Theme,
    pub palette: Palette,
    pub store: Entity<DocStore>,
    pub sidebar: Entity<Sidebar>,
    pub home: Entity<Home>,
    pub pane: Entity<Pane>,
    sidebar_open: bool,
    sidebar_choice: Option<bool>,
    narrow: bool,
    toast: Option<Toast>,
    notice: Option<Notice>,
    toast_serial: u64,
    toast_task: Option<Task<()>>,
    frame_task: Option<Task<()>>,
    opened_at: Instant,
    first_paint: bool,
    closing: bool,
    _subscriptions: Vec<Subscription>,
}

fn saved_frame() -> Option<Bounds<Pixels>> {
    let section = crate::store::store_section(FRAME_SECTION);
    let frame = section.get(FRAME_KEY)?;
    let get = |key: &str| frame.get(key).and_then(Value::as_f64).map(|v| v as f32);
    let bounds = Bounds {
        origin: point(px(get("x")?), px(get("y")?)),
        size: size(px(get("width")?), px(get("height")?)),
    };
    (bounds.size.width >= px(MIN_WIDTH) && bounds.size.height >= px(MIN_HEIGHT)).then_some(bounds)
}

fn saved_sidebar_choice() -> Option<bool> {
    crate::store::store_section(FRAME_SECTION)
        .get(SIDEBAR_KEY)
        .and_then(Value::as_bool)
}

/// The sidebar is shown until the person hides it, and then their choice
/// sticks. A window too narrow for it still hides it (see `sidebar_open`).
pub fn sidebar_default(saved: Option<bool>) -> bool {
    saved.unwrap_or(true)
}

fn on_screen(bounds: Bounds<Pixels>, cx: &App) -> bool {
    cx.displays().iter().any(|display| {
        let area = display.bounds();
        let overlap_w = bounds.right().min(area.right()) - bounds.left().max(area.left());
        let overlap_h = bounds.bottom().min(area.bottom()) - bounds.top().max(area.top());
        overlap_w >= px(160.) && overlap_h >= px(120.)
    })
}

fn placement(cx: &App) -> Bounds<Pixels> {
    if let Some(saved) = saved_frame().filter(|b| on_screen(*b, cx)) {
        return saved;
    }
    let preferred = size(px(DEFAULT_WIDTH), px(DEFAULT_HEIGHT));
    let target = scap_targets::Display::get_containing_cursor();
    match crate::app_windows::display_work_area(target.as_ref(), cx) {
        Some(available) => {
            let inset = px(16.);
            let width = preferred.width.min(available.size.width - inset * 2.);
            let height = preferred.height.min(available.size.height - inset * 2.);
            let size = size(width.max(px(MIN_WIDTH)), height.max(px(MIN_HEIGHT)));
            Bounds::centered_at(available.center(), size)
        }
        None => Bounds::centered(None, preferred, cx),
    }
}

pub fn open(doc_id: Option<String>, cx: &mut App) {
    open_with(doc_id, false, true, cx);
}

/// `open` for a meeting just started: the cursor lands in its notes.
pub fn open_to_type(doc_id: String, cx: &mut App) {
    open_with(Some(doc_id), true, true, cx);
}

/// `open` for a meeting that needs the person while they may be typing in
/// the call (it started on its own, or is about to stop): the window comes
/// up in front without taking the keyboard from the app in use.
pub fn open_quietly(cx: &mut App) {
    open_with(None, false, false, cx);
}

fn open_with(doc_id: Option<String>, type_into: bool, activate: bool, cx: &mut App) {
    crate::app_windows::hide_main_for_meeting_window(cx);
    if let Some(handle) = MeetingWindows::get(cx).documents {
        let revealed = handle.update(cx, |root, window, cx| {
            if let Ok(root) = root.downcast::<DocumentsWindow>() {
                root.update(cx, |root, cx| {
                    if type_into && let Some(id) = &doc_id {
                        root.pane
                            .update(cx, |pane, cx| pane.focus_body_when_open(id, window, cx));
                    }
                    root.reveal(doc_id.clone(), cx);
                });
            }
            if activate {
                window.activate_window();
            }
            platform::native_window(window)
        });
        match revealed {
            Ok(Some(native)) if activate => cx
                .spawn(async move |_| platform::show_native(&native))
                .detach(),
            Ok(Some(native)) => cx
                .spawn(async move |_| platform::show_native_quietly(&native))
                .detach(),
            // Off macOS there is no native handle to raise: the open window
            // is already revealed and activated, and is the only one.
            Ok(None) => {}
            Err(_) => {
                MeetingWindows::get(cx).documents = None;
                open_new(doc_id, type_into, activate, cx);
            }
        }
        return;
    }
    open_new(doc_id, type_into, activate, cx);
}

/// Open the notes window and say `message` there, for something that went
/// wrong where no window was showing (a start from the tray or a hotkey).
/// Open the notes window to say something went wrong elsewhere. The window
/// may open while the person looks at something else, so the message stays
/// (see [`Notice`]) instead of fading after a few seconds.
pub fn open_with_message(
    message: impl Into<SharedString>,
    detail: Option<SharedString>,
    cx: &mut App,
) {
    open(None, cx);
    let Some(handle) = MeetingWindows::get(cx).documents else {
        return;
    };
    let notice = Notice {
        message: message.into(),
        detail: detail.filter(|detail| !detail.is_empty()),
    };
    handle
        .update(cx, |root, _, cx| {
            if let Ok(root) = root.downcast::<DocumentsWindow>() {
                root.update(cx, |root, cx| root.show_notice(notice, cx));
            }
        })
        .ok();
}

/// The window's [`Notice`], laid out in the page under its toolbar so it
/// never covers what is on the page. `None` when there is nothing to say.
pub(super) fn notice_bar(
    root: &WeakEntity<DocumentsWindow>,
    palette: &Palette,
    cx: &App,
) -> Option<AnyElement> {
    let notice = root.upgrade()?.read(cx).notice.clone()?;
    let root = root.clone();
    let palette = *palette;
    let dismiss = tr::common::dismiss();
    Some(
        div()
            .w_full()
            .flex_shrink_0()
            .px(px(16.))
            .pb(px(8.))
            .flex()
            .justify_center()
            .child(
                div()
                    .id("documents-notice")
                    .w_full()
                    .max_w(px(style::COLUMN_WIDTH))
                    .flex()
                    .items_start()
                    .gap(px(10.))
                    .py(px(8.))
                    .pl(px(14.))
                    .pr(px(8.))
                    .rounded(px(12.))
                    .bg(palette.capsule)
                    .border_1()
                    .border_color(palette.capsule_border)
                    .text_size(px(13.))
                    .line_height(px(18.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .py(px(3.))
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(
                                div()
                                    .text_color(palette.text)
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(notice.message),
                            )
                            .children(
                                notice
                                    .detail
                                    .map(|detail| div().text_color(palette.muted).child(detail)),
                            ),
                    )
                    .child(
                        crate::ui::keyboard_nav::stop(style::icon_button(
                            &palette,
                            "documents-notice-dismiss",
                            "icons/x.svg",
                            24.,
                        ))
                        .aria_label(dismiss)
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(move |_, _, cx| {
                            root.update(cx, |root, cx| root.dismiss_notice(cx)).ok();
                        }),
                    ),
            )
            .into_any_element(),
    )
}

/// Open the notes window on a new, plain note: no recording, no setup.
pub fn new_note(cx: &mut App) {
    open(None, cx);
    let Some(handle) = MeetingWindows::get(cx).documents else {
        return;
    };
    handle
        .update(cx, |root, _, cx| {
            if let Ok(root) = root.downcast::<DocumentsWindow>() {
                let home = root.read(cx).home.clone();
                home.update(cx, |home, cx| home.new_plain_note(cx));
            }
        })
        .ok();
}

fn open_new(doc_id: Option<String>, type_into: bool, activate: bool, cx: &mut App) {
    let typed_doc = doc_id.clone().filter(|_| type_into);
    let opened_at = Instant::now();
    let bounds = placement(cx);
    let handle = cx.open_window(
        WindowOptions {
            #[cfg(target_os = "linux")]
            app_id: Some(crate::app_windows::app_id().into()),
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(gpui::TitlebarOptions {
                title: Some(TITLE.into()),
                appears_transparent: true,
                traffic_light_position: Some(TRAFFIC_LIGHTS),
            }),
            kind: WindowKind::Normal,
            focus: activate,
            show: true,
            is_resizable: true,
            is_minimizable: true,
            window_min_size: Some(size(px(MIN_WIDTH), px(MIN_HEIGHT))),
            window_background: WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        move |window, cx| cx.new(|cx| DocumentsWindow::new(doc_id, opened_at, window, cx)),
    );
    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("documents window failed to open: {error:#}");
            return;
        }
    };
    MeetingWindows::get(cx).documents = Some(handle.into());
    let native = handle
        .update(cx, |root, window, cx| {
            platform::kick_display_link(window);
            root.focus_initial(window, cx);
            if let Some(id) = &typed_doc {
                root.pane
                    .update(cx, |pane, cx| pane.focus_body_when_open(id, window, cx));
            }
            platform::native_window(window)
        })
        .ok()
        .flatten();
    if !activate && let Some(native) = &native {
        platform::show_native_quietly(native);
    }
    cx.spawn(async move |cx| {
        if let Some(native) = &native {
            let kind = platform::install_window_material(native, style::MATERIAL_RADIUS);
            cx.update(|cx| {
                if platform::active_material(cx).is_none() {
                    cx.set_global(platform::WindowMaterial(kind));
                }
            });
        }
        handle
            .update(cx, |root, window, cx| {
                platform::kick_display_link(window);
                root.sync_theme(window, cx);
                cx.notify();
                window.refresh();
            })
            .ok();
    })
    .detach();
}

impl DocumentsWindow {
    fn new(
        doc_id: Option<String>,
        opened_at: Instant,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        crate::theme::bind_window(window, cx);
        let theme = Theme::for_window(window, cx, true);
        let palette = Palette::new(&theme);
        let store = cx.new(DocStore::new);
        if let Some(id) = doc_id {
            store.update(cx, |store, cx| store.open_when_listed(id, cx));
        }
        let root = cx.weak_entity();
        let sidebar = cx.new(|cx| Sidebar::new(store.clone(), &theme, cx));
        let home = cx.new(|cx| Home::new(store.clone(), root.clone(), &theme, window, cx));
        let pane = cx.new(|cx| Pane::new(store.clone(), root.clone(), &theme, window, cx));
        let sidebar_choice = saved_sidebar_choice();
        let sidebar_open = sidebar_default(sidebar_choice);
        pane.update(cx, |pane, cx| pane.set_leading_inset(!sidebar_open, cx));
        let subscriptions = vec![
            cx.subscribe_in(&sidebar, window, Self::on_sidebar_event),
            cx.subscribe_in(&home, window, Self::on_home_event),
            cx.subscribe_in(&store, window, |this, _, event: &StoreEvent, window, cx| {
                match event {
                    StoreEvent::Listed => cx.notify(),
                    StoreEvent::Opened(id) => {
                        let scope = if id.is_some() {
                            None
                        } else {
                            Some(this.home.read(cx).scope.clone())
                        };
                        this.sidebar
                            .update(cx, |sidebar, cx| sidebar.set_scope(scope, cx));
                        if id.is_none() {
                            let handle = this.home.read(cx).focus_handle();
                            window.focus(&handle, cx);
                        }
                        cx.notify();
                    }
                    _ => {}
                }
            }),
            cx.observe_window_bounds(window, |this, window, cx| {
                this.schedule_frame_save(window, cx)
            }),
            cx.on_app_quit(|this, cx| {
                this.flush(cx);
                async {}
            }),
            cx.on_release({
                let this_window = window.window_handle();
                move |_, cx| {
                    // Only this window's own slot: a newer notes window
                    // stays the one every open() reveals.
                    let windows = MeetingWindows::get(cx);
                    if windows.documents == Some(this_window) {
                        windows.documents = None;
                    }
                }
            }),
            cx.observe_window_activation(window, |_, window, cx| {
                if window.is_window_active()
                    && let Some(cap_ai) = crate::meetings_ui::cap_ai::CapAi::global(cx)
                {
                    cap_ai.update(cx, |c, cx| c.activated(cx));
                }
            }),
        ];
        let mut subscriptions = subscriptions;
        if let Some(cap_ai) = crate::meetings_ui::cap_ai::CapAi::global(cx) {
            subscriptions.push(cx.observe(&cap_ai, |_, _, cx| cx.notify()));
        }
        let weak = cx.weak_entity();
        window.on_window_should_close(cx, move |window, cx| {
            weak.update(cx, |this, cx| this.prepare_close(window, cx))
                .ok();
            true
        });
        Self {
            focus: cx.focus_handle(),
            theme,
            palette,
            store,
            sidebar,
            home,
            pane,
            sidebar_open,
            sidebar_choice,
            narrow: false,
            toast: None,
            notice: None,
            toast_serial: 0,
            toast_task: None,
            frame_task: None,
            opened_at,
            first_paint: false,
            closing: false,
            _subscriptions: subscriptions,
        }
    }

    fn focus_initial(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    pub fn reveal(&mut self, doc_id: Option<String>, cx: &mut Context<Self>) {
        if let Some(id) = doc_id {
            self.store
                .update(cx, |store, cx| store.open_when_listed(id, cx));
        }
    }

    pub fn sync_theme(&mut self, window: &Window, cx: &mut Context<Self>) {
        if self.theme.refresh(window, cx, true) {
            self.palette = Palette::new(&self.theme);
            let theme = self.theme;
            self.sidebar
                .update(cx, |sidebar, cx| sidebar.set_theme(&theme, cx));
            self.home.update(cx, |home, cx| home.set_theme(&theme, cx));
            self.pane.update(cx, |pane, cx| pane.set_theme(&theme, cx));
        }
    }

    /// Whether the navigation column is on screen: the person's choice, and
    /// never in a window too narrow to give the page room beside it.
    pub fn sidebar_open(&self) -> bool {
        self.sidebar_open && !self.narrow
    }

    fn on_sidebar_event(
        &mut self,
        _: &Entity<Sidebar>,
        event: &SidebarEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            SidebarEvent::Show(scope) => self.show_home(Some(scope.clone()), window, cx),
            SidebarEvent::Open(id) => {
                let id = id.clone();
                self.store.update(cx, |store, cx| store.open(Some(id), cx));
            }
            SidebarEvent::Start(choice) => self.start(*choice, window, cx),
        }
    }

    fn on_home_event(
        &mut self,
        _: &Entity<Home>,
        event: &HomeEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            HomeEvent::FocusTitle => {
                self.pane
                    .update(cx, |pane, cx| pane.focus_title(window, cx));
            }
            HomeEvent::FocusDocument => {
                self.pane.update(cx, |pane, cx| pane.focus_body(window, cx));
            }
            HomeEvent::StartEvent(event_id) => {
                let event_id = event_id.clone();
                self.pane.update(cx, |pane, cx| {
                    pane.start_recording(crate::meetings::StartSource::Event(event_id), cx)
                });
            }
            HomeEvent::NewFolderWith(ids) => {
                if !self.sidebar_open() {
                    self.toggle_sidebar(&ToggleSidebar, window, cx);
                }
                let ids = ids.clone();
                self.sidebar
                    .update(cx, |sidebar, cx| sidebar.start_new_folder(ids, window, cx));
            }
            HomeEvent::Start(choice) => self.start(*choice, window, cx),
        }
    }

    pub fn show_home(&mut self, scope: Option<Scope>, window: &mut Window, cx: &mut Context<Self>) {
        self.store.update(cx, |store, cx| store.open(None, cx));
        let scope = scope.unwrap_or_else(|| self.home.read(cx).scope.clone());
        self.home
            .update(cx, |home, cx| home.set_scope(scope.clone(), window, cx));
        self.sidebar
            .update(cx, |sidebar, cx| sidebar.set_scope(Some(scope), cx));
        cx.notify();
    }

    pub fn show_toast(
        &mut self,
        message: impl Into<SharedString>,
        action: Option<(SharedString, ToastAction)>,
        on_expire: Option<ToastExpire>,
        cx: &mut Context<Self>,
    ) {
        if let Some(previous) = self.toast.take()
            && let Some(expire) = previous.on_expire
        {
            cx.defer(move |cx| expire(cx));
        }
        self.toast_serial += 1;
        let serial = self.toast_serial;
        self.toast = Some(Toast {
            serial,
            message: message.into(),
            action,
            on_expire,
        });
        self.toast_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(TOAST_FOR).await;
            this.update(cx, |this, cx| this.expire_toast(serial, cx))
                .ok();
        }));
        cx.notify();
    }

    fn expire_toast(&mut self, serial: u64, cx: &mut Context<Self>) {
        if self.toast.as_ref().is_some_and(|t| t.serial == serial)
            && let Some(toast) = self.toast.take()
        {
            if let Some(expire) = toast.on_expire {
                cx.defer(move |cx| expire(cx));
            }
            cx.notify();
        }
    }

    fn take_toast_action(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(toast) = self.toast.take() {
            if let Some((_, action)) = toast.action {
                action(window, cx);
            }
            cx.notify();
        }
    }

    /// Shows `notice` under the page's toolbar until it is dismissed or
    /// replaced.
    pub fn show_notice(&mut self, notice: Notice, cx: &mut Context<Self>) {
        self.notice = Some(notice);
        self.refresh_pages(cx);
    }

    pub fn dismiss_notice(&mut self, cx: &mut Context<Self>) {
        if self.notice.take().is_some() {
            self.refresh_pages(cx);
        }
    }

    /// The page views are cached, so a change to the notice they draw has to
    /// reach them.
    fn refresh_pages(&mut self, cx: &mut Context<Self>) {
        self.home.update(cx, |_, cx| cx.notify());
        self.pane.update(cx, |_, cx| cx.notify());
        cx.notify();
    }

    pub fn dismiss_toast(&mut self, cx: &mut Context<Self>) {
        if let Some(toast) = self.toast.take() {
            if let Some(expire) = toast.on_expire {
                cx.defer(move |cx| expire(cx));
            }
            cx.notify();
        }
    }

    fn schedule_frame_save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.closing {
            return;
        }
        let bounds = window.bounds();
        self.frame_task = Some(cx.spawn(async move |_, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(400))
                .await;
            save_frame(bounds);
        }));
    }

    fn save_layout(&self, window: &Window) {
        if !window.is_maximized() && !window.is_fullscreen() {
            save_frame(window.bounds());
        }
        if let Some(choice) = self.sidebar_choice {
            crate::store::set_store_setting(FRAME_SECTION, SIDEBAR_KEY, json!(choice));
        }
    }

    pub fn flush(&mut self, cx: &mut Context<Self>) {
        self.pane.update(cx, |pane, cx| pane.flush_saves(cx));
        if !writer::flush_blocking(Duration::from_secs(3)) {
            tracing::warn!("documents writer did not finish before the deadline");
        }
    }

    fn prepare_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.closing {
            return;
        }
        self.closing = true;
        self.frame_task = None;
        self.save_layout(window);
        self.flush(cx);
        self.pane.update(cx, |pane, cx| pane.closing(cx));
        cx.defer(crate::app_windows::notes_closed);
    }

    fn close(&mut self, _: &CloseDocuments, window: &mut Window, cx: &mut Context<Self>) {
        self.prepare_close(window, cx);
        window.defer(cx, |window, _| window.remove_window());
    }

    /// Settings from the notes (the gear, Cmd+, or Ctrl+, and the app
    /// menu's Settings while the notes have focus) opens on Notes. The
    /// app-wide shortcut has no context, so GPUI ranks it above any binding
    /// scoped to this window; handling its action here is what wins.
    fn open_settings(&mut self, cx: &mut Context<Self>) {
        cx.defer(crate::meetings_ui::settings::open);
    }

    fn toggle_sidebar(&mut self, _: &ToggleSidebar, _: &mut Window, cx: &mut Context<Self>) {
        if self.narrow {
            self.sidebar_open = true;
            self.narrow = false;
        } else {
            self.sidebar_open = !self.sidebar_open;
        }
        self.sidebar_choice = Some(self.sidebar_open);
        crate::store::set_store_setting(FRAME_SECTION, SIDEBAR_KEY, json!(self.sidebar_open));
        let visible = self.sidebar_open();
        self.pane
            .update(cx, |pane, cx| pane.set_leading_inset(!visible, cx));
        self.home.update(cx, |_, cx| cx.notify());
        cx.notify();
    }

    fn focus_search(&mut self, _: &FocusSearch, window: &mut Window, cx: &mut Context<Self>) {
        if self.store.read(cx).open.is_some() {
            self.store.update(cx, |store, cx| store.open(None, cx));
        }
        self.home
            .update(cx, |home, cx| home.focus_search(window, cx));
        cx.notify();
    }

    fn go_home(&mut self, _: &GoHome, window: &mut Window, cx: &mut Context<Self>) {
        self.show_home(None, window, cx);
    }

    /// The start button, from home or the sidebar: do what was picked and
    /// make it the button's one-click choice from now on.
    fn start(&mut self, choice: StartChoice, window: &mut Window, cx: &mut Context<Self>) {
        super::start::remember(choice, cx);
        match choice {
            StartChoice::Record => {
                cx.defer(|cx| super::start_listening(crate::meetings::StartSource::Manual, cx))
            }
            StartChoice::Blank => self.new_note(&NewNote, window, cx),
        }
    }

    /// "New note" is a plain note. Recording into it is the note's own
    /// Record control.
    fn new_note(&mut self, _: &NewNote, _: &mut Window, cx: &mut Context<Self>) {
        self.home.update(cx, |home, cx| home.new_plain_note(cx));
    }

    fn new_meeting_notes(&mut self, _: &NewMeetingNotes, _: &mut Window, cx: &mut Context<Self>) {
        cx.defer(|cx| super::start_listening(crate::meetings::StartSource::Manual, cx));
    }

    fn dismiss(&mut self, _: &Dismiss, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(cap_ai) = crate::meetings_ui::cap_ai::CapAi::global(cx)
            && cap_ai
                .read(cx)
                .is_open_in(crate::meetings_ui::cap_ai::Host::Documents)
        {
            cap_ai.update(cx, |c, cx| c.close(cx));
            return;
        }
        let handled = self.pane.update(cx, |pane, cx| pane.dismiss(window, cx));
        if handled {
            return;
        }
        let handled = self.sidebar.update(cx, |sidebar, cx| sidebar.dismiss(cx))
            || self.home.update(cx, |home, cx| home.dismiss(window, cx));
        if !handled && self.toast.is_some() {
            self.dismiss_toast(cx);
        } else if !handled && self.notice.is_some() {
            self.dismiss_notice(cx);
        }
    }

    fn render_toast(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let toast = self.toast.as_ref()?;
        let palette = self.palette;
        let action = toast.action.as_ref().map(|(label, _)| label.clone());
        Some(
            div()
                .absolute()
                .top(px(14.))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(
                    div()
                        .id(("documents-toast", toast.serial))
                        .occlude()
                        .flex()
                        .items_center()
                        .gap(px(12.))
                        .h(px(36.))
                        .pl(px(14.))
                        .pr(px(if action.is_some() { 6. } else { 14. }))
                        .rounded_full()
                        .bg(palette.capsule)
                        .border_1()
                        .border_color(palette.capsule_border)
                        .shadow(palette.shadow())
                        .text_size(px(13.))
                        .text_color(palette.text)
                        .child(toast.message.clone())
                        .children(action.map(|label| {
                            div()
                                .id("documents-toast-action")
                                .h(px(26.))
                                .px(px(10.))
                                .flex()
                                .items_center()
                                .rounded_full()
                                .text_color(palette.accent)
                                .font_weight(FontWeight::MEDIUM)
                                .cursor_pointer()
                                .hover(move |s| s.bg(palette.accent_soft))
                                .child(label)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.take_toast_action(window, cx)
                                }))
                        })),
                )
                .into_any_element(),
        )
    }

    fn render_upgrade(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        use crate::meetings_ui::cap_ai::{CapAi, Host};
        let cap_ai = CapAi::global(cx)?;
        let cap_ai = cap_ai.read(cx);
        if !cap_ai.is_open_in(Host::Documents) {
            return None;
        }
        Some(super::upgrade::overlay(
            &self.palette,
            cap_ai,
            cx.reduce_motion() || style::reduce_motion(),
        ))
    }

    fn render_leading_controls(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = self.palette;
        let in_note = self.store.read(cx).open.is_some();
        let tooltip = |label: &'static str| {
            move |_: &mut Window, cx: &mut App| {
                crate::ui::Tooltip::new(&Theme::new(crate::theme::Appearance::Dark), label).view(cx)
            }
        };
        let left = if cfg!(target_os = "macos") {
            LEADING_INSET
        } else {
            12.
        };
        let top = (style::TOOLBAR_HEIGHT - glass::CAPSULE_HEIGHT) / 2.;
        let stop = |el: gpui::Stateful<gpui::Div>| {
            el.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        };
        div()
            .absolute()
            .top(px(top))
            .left(px(left))
            .flex()
            .items_center()
            .gap(px(8.))
            .child(
                glass::toolbar_group(&palette)
                    .child(
                        stop(glass::toolbar_button(
                            &palette,
                            "documents-toggle-sidebar",
                            "icons/panel-left.svg",
                        ))
                        .tooltip(tooltip(tr::documents::toolbar::toggle_sidebar()))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.toggle_sidebar(&ToggleSidebar, window, cx)
                        })),
                    )
                    .child(
                        stop(glass::toolbar_button(
                            &palette,
                            "documents-settings",
                            "icons/settings.svg",
                        ))
                        .tooltip(tooltip(tr::documents::toolbar::settings()))
                        .on_click(cx.listener(|this, _, _, cx| this.open_settings(cx))),
                    ),
            )
            .when(in_note, |el| {
                el.child(
                    glass::toolbar_group(&palette).child(
                        stop(glass::toolbar_button(
                            &palette,
                            "documents-back-home",
                            "icons/chevron-left.svg",
                        ))
                        .tooltip(tooltip(tr::documents::home::back()))
                        .on_click(
                            cx.listener(|this, _, window, cx| this.go_home(&GoHome, window, cx)),
                        ),
                    ),
                )
            })
            .into_any_element()
    }
}

fn save_frame(bounds: Bounds<Pixels>) {
    crate::store::set_store_setting(
        FRAME_SECTION,
        FRAME_KEY,
        json!({
            "x": f32::from(bounds.origin.x),
            "y": f32::from(bounds.origin.y),
            "width": f32::from(bounds.size.width),
            "height": f32::from(bounds.size.height),
        }),
    );
}

impl Focusable for DocumentsWindow {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for DocumentsWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::keylat::frame_started();
        self.sync_theme(window, cx);
        style::set_reduce_motion(cx.reduce_motion());
        if !self.first_paint {
            self.first_paint = true;
            let opened_at = self.opened_at;
            window.on_next_frame(move |_, _| {
                tracing::info!(
                    ms = opened_at.elapsed().as_secs_f64() * 1000.,
                    "documents window first paint"
                );
            });
        }
        let palette = self.palette;
        let radius = self
            .theme
            .settings_window_radius()
            .min(style::MATERIAL_RADIUS as f32);
        let narrow = f32::from(window.viewport_size().width) < NARROW_WIDTH;
        if narrow != self.narrow {
            self.narrow = narrow;
            let visible = self.sidebar_open();
            self.pane
                .update(cx, |pane, cx| pane.set_leading_inset(!visible, cx));
            self.home.update(cx, |_, cx| cx.notify());
        }
        let sidebar_open = self.sidebar_open();
        let in_note = self.store.read(cx).open.is_some();
        let main = if in_note && self.pane.read(cx).page_mode() {
            // The page caches its own lines. A cached pane would repaint
            // everything inside it on every key typed in the summary.
            div()
                .flex_1()
                .min_w_0()
                .h_full()
                .child(self.pane.clone())
                .into_any_element()
        } else if in_note {
            self.pane
                .clone()
                .cached(StyleRefinement::default().flex_1().min_w_0().h_full())
                .into_any_element()
        } else {
            self.home
                .clone()
                .cached(StyleRefinement::default().flex_1().min_w_0().h_full())
                .into_any_element()
        };

        let body = div()
            .flex()
            .flex_row()
            .flex_1()
            .min_h_0()
            .w_full()
            .when(sidebar_open, |el| {
                el.child(
                    self.sidebar.clone().cached(
                        StyleRefinement::default()
                            .w(px(style::SIDEBAR_WIDTH))
                            .h_full()
                            .flex_shrink_0(),
                    ),
                )
                .child(div().w(px(1.)).h_full().bg(palette.hairline))
            })
            .child(main);

        let shell = div()
            .id("documents-window")
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::close))
            .on_action(
                cx.listener(|this, _: &crate::menus::OpenSettings, _, cx| this.open_settings(cx)),
            )
            .on_action(cx.listener(Self::toggle_sidebar))
            .on_action(cx.listener(Self::focus_search))
            .on_action(cx.listener(Self::new_note))
            .on_action(cx.listener(Self::new_meeting_notes))
            .on_action(cx.listener(Self::go_home))
            .on_action(cx.listener(Self::dismiss))
            .on_action(cx.listener(|this, _: &ShowMyNotes, window, cx| {
                this.pane.update(cx, |pane, cx| {
                    pane.show_view(super::pane::View::Mine, window, cx)
                })
            }))
            .on_action(cx.listener(|this, _: &ShowGeneratedNotes, window, cx| {
                this.pane.update(cx, |pane, cx| {
                    pane.show_view(super::pane::View::Generated, window, cx)
                })
            }))
            .on_action(cx.listener(|this, _: &ShowTranscript, window, cx| {
                this.pane
                    .update(cx, |pane, cx| pane.toggle_transcript(window, cx))
            }))
            .on_action(cx.listener(|this, _: &ToggleRecording, _, cx| {
                this.pane.update(cx, |pane, cx| pane.toggle_recording(cx))
            }))
            .on_action(cx.listener(|this, _: &WriteNotes, _, cx| {
                this.pane.update(cx, |pane, cx| pane.write_notes(None, cx))
            }))
            .on_action(cx.listener(|this, _: &ToggleAsk, window, cx| {
                this.pane
                    .update(cx, |pane, cx| pane.toggle_ask_sheet(window, cx))
            }))
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(radius))
            // Over the native glass the shell paints nothing: the sidebar is
            // the window's glass and the page paints its own paper.
            .when(!palette.glass, |el| el.bg(palette.content))
            .font_family(crate::theme::UI_FONT)
            .locale_font()
            .text_color(palette.text);

        #[cfg(target_os = "windows")]
        let shell = shell.child(
            div()
                .h(px(32.))
                .w_full()
                .flex_shrink_0()
                .flex()
                .justify_end()
                .window_control_area(gpui::WindowControlArea::Drag)
                .child(crate::ui::windows_caption_controls(
                    self.theme,
                    window.is_window_active(),
                    window.is_maximized(),
                    true,
                    true,
                )),
        );
        shell
            .child(body)
            .child(self.render_leading_controls(cx))
            .children(self.render_toast(cx))
            .children(self.render_upgrade(cx))
            .children(crate::keylat::probe())
    }
}

#[cfg(debug_assertions)]
impl DocumentsWindow {
    pub fn debug_toggle_sidebar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.toggle_sidebar(&ToggleSidebar, window, cx);
    }
}

#[cfg(test)]
mod tests {
    use gpui::TestAppContext;

    use crate::meetings_ui::MeetingWindows;

    fn notes_windows(cx: &mut TestAppContext) -> usize {
        cx.update(|cx| {
            cx.windows()
                .into_iter()
                .filter(|w| w.downcast::<super::DocumentsWindow>().is_some())
                .count()
        })
    }

    /// Opening the notes window while it is open raises that window. It
    /// never stacks a second one, on any platform (off macOS there is no
    /// native window handle, which used to read as "the window is gone").
    #[gpui::test]
    fn opening_the_notes_window_again_raises_the_one_open(cx: &mut TestAppContext) {
        cx.update(|cx| super::open(None, cx));
        cx.run_until_parked();
        let first = cx.update(|cx| MeetingWindows::get(cx).documents);
        assert!(first.is_some());
        for _ in 0..3 {
            cx.update(|cx| super::open(None, cx));
            cx.run_until_parked();
        }
        assert_eq!(notes_windows(cx), 1);
        assert_eq!(cx.update(|cx| MeetingWindows::get(cx).documents), first);
    }

    /// A start that fails from the tray, a hotkey or by itself, with no
    /// window showing, opens the notes window and says so and why. The
    /// window may open while the person looks elsewhere, so the message
    /// stays until they dismiss it.
    #[gpui::test]
    fn a_failed_start_from_outside_the_window_says_so(cx: &mut TestAppContext) {
        assert_eq!(notes_windows(cx), 0);
        cx.update(|cx| {
            super::open_with_message(
                "Recording couldn't start.",
                Some("Check the free space on your disk and try again.".into()),
                cx,
            )
        });
        cx.run_until_parked();
        assert_eq!(notes_windows(cx), 1);
        let handle = cx.update(|cx| MeetingWindows::get(cx).documents).unwrap();
        let shown = |cx: &mut TestAppContext| {
            handle
                .update(cx, |root, _, cx| {
                    root.downcast::<super::DocumentsWindow>()
                        .ok()
                        .and_then(|root| root.read(cx).notice.clone())
                })
                .unwrap()
        };
        let expected = Some(super::Notice {
            message: "Recording couldn't start.".into(),
            detail: Some("Check the free space on your disk and try again.".into()),
        });
        assert_eq!(shown(cx), expected);
        cx.executor().advance_clock(super::TOAST_FOR * 10);
        cx.run_until_parked();
        assert_eq!(shown(cx), expected);
        // An everyday message does not replace it, and fades on its own.
        handle
            .update(cx, |root, _, cx| {
                if let Ok(root) = root.downcast::<super::DocumentsWindow>() {
                    root.update(cx, |root, cx| root.show_toast("Copied", None, None, cx));
                }
            })
            .unwrap();
        cx.executor().advance_clock(super::TOAST_FOR * 2);
        cx.run_until_parked();
        assert_eq!(shown(cx), expected);
        let toast = handle
            .update(cx, |root, _, cx| {
                root.downcast::<super::DocumentsWindow>()
                    .is_ok_and(|root| root.read(cx).toast.is_some())
            })
            .unwrap();
        assert!(!toast);
        // Escape dismisses it.
        cx.update(|cx| {
            handle
                .update(cx, |root, window, cx| {
                    let focus = root
                        .downcast::<super::DocumentsWindow>()
                        .unwrap()
                        .read(cx)
                        .focus
                        .clone();
                    window.focus(&focus, cx);
                    window.dispatch_action(Box::new(super::super::Dismiss), cx)
                })
                .unwrap()
        });
        cx.run_until_parked();
        assert_eq!(shown(cx), None);
    }

    /// A notes window that goes away clears only its own slot, so a newer
    /// window stays the one the next open() raises.
    #[gpui::test]
    fn a_closed_notes_window_does_not_forget_a_newer_one(cx: &mut TestAppContext) {
        cx.update(|cx| super::open(None, cx));
        cx.run_until_parked();
        let old = cx.update(|cx| MeetingWindows::get(cx).documents).unwrap();
        let newer = cx
            .add_empty_window()
            .update(|window, _| window.window_handle());
        cx.update(|cx| MeetingWindows::get(cx).documents = Some(newer));
        old.update(cx, |_, window, _| window.remove_window())
            .unwrap();
        cx.run_until_parked();
        assert_eq!(
            cx.update(|cx| MeetingWindows::get(cx).documents),
            Some(newer)
        );

        cx.update(|cx| MeetingWindows::get(cx).documents = None);
        cx.update(|cx| super::open(None, cx));
        cx.run_until_parked();
        let reopened = cx.update(|cx| MeetingWindows::get(cx).documents).unwrap();
        reopened
            .update(cx, |_, window, _| window.remove_window())
            .unwrap();
        cx.run_until_parked();
        assert_eq!(cx.update(|cx| MeetingWindows::get(cx).documents), None);
    }
}
