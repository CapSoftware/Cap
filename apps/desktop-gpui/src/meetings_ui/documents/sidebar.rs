use std::{cell::Cell, rc::Rc};

use gpui::{
    AnyElement, AppContext as _, Context, Entity, EventEmitter, FontWeight, InteractiveElement,
    IntoElement, MouseButton, MouseDownEvent, ParentElement, Pixels, Point, Render, ScrollHandle,
    SharedString, StatefulInteractiveElement, Styled, Subscription, Window, div,
    prelude::FluentBuilder, px, svg,
};

use super::{
    cap_ai::{ProRow, RowPlace, next_pro_row, render_pro_row},
    format, glass,
    menu::{self, Entry, OpenMenu},
    start::{StartButton, StartChoice, StartEvent, StartSize},
    store::{DocStore, Scope, StoreEvent},
    style::{Palette, TOOLBAR_HEIGHT},
};
use crate::{
    i18n::tr,
    meetings::Meetings,
    theme::Theme,
    ui::{TextInput, TextInputEvent, TextInputState},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SidebarEvent {
    Show(Scope),
    Open(String),
    Start(StartChoice),
    /// The Cap Pro row changed (the window shows it while the sidebar is
    /// hidden).
    ProChanged,
}

/// How many notes the sidebar keeps at hand.
pub const RECENT: usize = 8;

/// One row of the sidebar's Recent list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecentRow {
    pub id: String,
    pub title: String,
    pub when: String,
}

/// The newest notes, as home lists them. The library is already kept in that
/// order, so this reads the first few and never walks the rest.
pub fn recent_rows(
    docs: &[cap_meetings::library::DocMeta],
    today: chrono::NaiveDate,
) -> Vec<RecentRow> {
    docs.iter()
        .take(RECENT)
        .map(|meta| {
            let at = format::local(meta.sort_time());
            let when = if at.date() == today {
                format::clock(at)
            } else {
                format::short_date(at.date(), today)
            };
            let title = meta.title.trim();
            RecentRow {
                id: meta.id.clone(),
                title: if title.is_empty() {
                    tr::documents::untitled().to_string()
                } else {
                    title.to_string()
                },
                when,
            }
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
enum Action {
    RenameFolder(String),
    DeleteFolder(String),
}

enum Editing {
    NewFolder { move_ids: Vec<String> },
    Folder(String),
}

/// The window's navigation: home, pinned, folders and the trash. The notes
/// themselves are listed on the home page.
pub struct Sidebar {
    store: Entity<DocStore>,
    palette: Palette,
    scope: Option<Scope>,
    start: Entity<StartButton>,
    recent: Vec<RecentRow>,
    menu: Option<OpenMenu<Action>>,
    editing: Option<(Editing, Entity<TextInputState>)>,
    /// The Cap Pro row (see [`super::cap_ai::pro_row`]).
    pro: Option<ProRow>,
    /// The list's scroll, to know when it runs past the row and fades out
    /// above it (set at paint, read at the next render).
    nav_scroll: ScrollHandle,
    nav_overflows: Rc<Cell<bool>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<SidebarEvent> for Sidebar {}

impl Sidebar {
    pub fn new(store: Entity<DocStore>, theme: &Theme, cx: &mut Context<Self>) -> Self {
        let start = cx.new(|cx| StartButton::new("sidebar-start", StartSize::Sidebar, theme, cx));
        let subscriptions = vec![
            cx.subscribe(&store, |this, _, event: &StoreEvent, cx| match event {
                StoreEvent::Listed | StoreEvent::MetaChanged(_) | StoreEvent::Created(_) => {
                    this.refresh_recent(cx);
                    cx.notify();
                }
                StoreEvent::Opened(_) => cx.notify(),
            }),
            cx.subscribe(&start, |_, _, event: &StartEvent, cx| {
                let StartEvent::Start(choice) = *event;
                cx.emit(SidebarEvent::Start(choice));
            }),
        ];
        let mut subscriptions = subscriptions;
        let meetings = Meetings::try_global(cx);
        if let Some(meetings) = &meetings {
            subscriptions.push(cx.observe(meetings, |this, _, cx| this.refresh_pro(cx)));
        }
        let mut this = Self {
            store,
            palette: Palette::new(theme),
            scope: Some(Scope::All),
            start,
            recent: Vec::new(),
            menu: None,
            editing: None,
            pro: None,
            nav_scroll: ScrollHandle::new(),
            nav_overflows: Rc::new(Cell::new(false)),
            _subscriptions: subscriptions,
        };
        this.refresh_recent(cx);
        this.pro = meetings.and_then(|m| next_pro_row(None, m.read(cx).pro_offer()));
        // Home may be the first Notes screen: ask the server for the free
        // count now rather than when a note opens.
        if let Some(meetings) = Meetings::try_global(cx) {
            meetings.update(cx, |m, cx| m.ensure_access(cx));
        }
        this
    }

    pub fn pro(&self) -> Option<ProRow> {
        self.pro
    }

    pub(super) fn refresh_pro(&mut self, cx: &mut Context<Self>) {
        let Some(meetings) = Meetings::try_global(cx) else {
            return;
        };
        let pro = next_pro_row(self.pro, meetings.read(cx).pro_offer());
        if pro != self.pro {
            self.pro = pro;
            cx.emit(SidebarEvent::ProChanged);
            cx.notify();
        }
    }

    fn refresh_recent(&mut self, cx: &mut Context<Self>) {
        let today = chrono::Local::now().date_naive();
        self.recent = recent_rows(&self.store.read(cx).snapshot.docs, today);
    }

    pub fn set_theme(&mut self, theme: &Theme, cx: &mut Context<Self>) {
        self.palette = Palette::new(theme);
        self.start.update(cx, |b, cx| b.set_theme(theme, cx));
        cx.notify();
    }

    /// The highlighted item: the home page's scope, or nothing while a note
    /// is open.
    pub fn set_scope(&mut self, scope: Option<Scope>, cx: &mut Context<Self>) {
        if self.scope != scope {
            self.scope = scope;
            cx.notify();
        }
    }

    pub fn dismiss(&mut self, cx: &mut Context<Self>) -> bool {
        if self.menu.take().is_some() || self.editing.take().is_some() {
            cx.notify();
            return true;
        }
        self.start.update(cx, |b, cx| b.dismiss(cx))
    }

    fn open_folder_menu(&mut self, id: String, position: Point<Pixels>, cx: &mut Context<Self>) {
        self.menu = Some(OpenMenu {
            id: "documents-folder-menu",
            position,
            entries: vec![
                Entry::new(
                    tr::documents::menu::rename(),
                    Action::RenameFolder(id.clone()),
                ),
                Entry::new(
                    tr::documents::menu::delete_folder(),
                    Action::DeleteFolder(id),
                )
                .danger(),
            ],
        });
        cx.notify();
    }

    fn run(&mut self, action: Action, window: &mut Window, cx: &mut Context<Self>) {
        self.menu = None;
        match action {
            Action::RenameFolder(id) => {
                let name = self
                    .store
                    .read(cx)
                    .folder_name(&id)
                    .unwrap_or("")
                    .to_string();
                self.start_editing(Editing::Folder(id), &name, window, cx);
            }
            Action::DeleteFolder(id) => self.confirm_delete_folder(id, window, cx),
        }
        cx.notify();
    }

    fn confirm_delete_folder(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let name = self
            .store
            .read(cx)
            .folder_name(&id)
            .unwrap_or("")
            .to_string();
        let answer = window.prompt(
            gpui::PromptLevel::Warning,
            &tr::documents::confirm::delete_folder(name),
            Some(tr::documents::confirm::delete_folder_detail()),
            &[
                gpui::PromptButton::ok(tr::documents::confirm::delete()),
                gpui::PromptButton::cancel(tr::common::cancel()),
            ],
            cx,
        );
        let store = self.store.clone();
        cx.spawn(async move |_, cx| {
            if answer.await.ok() == Some(0) {
                store.update(cx, |store, cx| store.delete_folder(&id, cx));
            }
        })
        .detach();
    }

    pub fn start_new_folder(
        &mut self,
        move_ids: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.start_editing(Editing::NewFolder { move_ids }, "", window, cx);
    }

    fn start_editing(
        &mut self,
        editing: Editing,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let input = cx.new(|cx| {
            let mut input = TextInputState::single_line(window, cx);
            input.set_placeholder(tr::documents::sidebar::folder_name());
            input.set_text(text.to_string(), cx);
            input
        });
        cx.subscribe_in(
            &input,
            window,
            |this, input, event: &TextInputEvent, _, cx| match event {
                TextInputEvent::Confirmed | TextInputEvent::Blurred => {
                    let name = input.read(cx).text().trim().to_string();
                    this.commit_editing(name, cx)
                }
                TextInputEvent::Cancelled => {
                    this.editing = None;
                    cx.notify();
                }
                TextInputEvent::Changed => {}
            },
        )
        .detach();
        input.update(cx, |input, cx| input.focus_and_select_all(window, cx));
        self.editing = Some((editing, input));
        cx.notify();
    }

    fn commit_editing(&mut self, name: String, cx: &mut Context<Self>) {
        let Some((editing, _)) = self.editing.take() else {
            return;
        };
        if !name.is_empty() {
            match editing {
                Editing::NewFolder { move_ids } => self
                    .store
                    .update(cx, |store, cx| store.create_folder(name, move_ids, cx)),
                Editing::Folder(id) => self
                    .store
                    .update(cx, |store, cx| store.rename_folder(&id, &name, cx)),
            }
        }
        cx.notify();
    }

    fn item(
        &self,
        id: SharedString,
        icon: &'static str,
        label: SharedString,
        active: bool,
    ) -> gpui::Stateful<gpui::Div> {
        let palette = self.palette;
        // Quiet glyphs: the selection alone says where you are.
        div()
            .id(id)
            .mx(px(10.))
            .h(px(glass::ROW_HEIGHT))
            .px(px(9.))
            .flex()
            .items_center()
            .gap(px(8.))
            .rounded(px(glass::ROW_RADIUS))
            .cursor_pointer()
            .text_size(px(13.))
            .text_color(palette.text)
            .when(active, |el| el.bg(palette.selected))
            .when(!active, |el| el.hover(move |s| s.bg(palette.hover)))
            .child(
                svg()
                    .path(icon)
                    .size(px(15.))
                    .flex_shrink_0()
                    .text_color(if active { palette.text } else { palette.muted }),
            )
            .child(div().flex_1().min_w_0().truncate().child(label))
    }

    fn input_row(&self, id: &'static str, input: Entity<TextInputState>) -> AnyElement {
        let palette = self.palette;
        let theme = Theme::new(if palette.dark {
            crate::theme::Appearance::Dark
        } else {
            crate::theme::Appearance::Light
        });
        div()
            .mx(px(10.))
            .h(px(30.))
            .px(px(10.))
            .flex()
            .items_center()
            .gap(px(9.))
            .rounded(px(8.))
            .bg(palette.field)
            .child(
                svg()
                    .path("icons/folder.svg")
                    .size(px(15.))
                    .text_color(palette.muted),
            )
            .child(
                TextInput::bare(&theme, id, &input)
                    .text_size(px(13.5))
                    .text_color(palette.text)
                    .placeholder_color(palette.faint)
                    .height(px(22.)),
            )
            .into_any_element()
    }
}

impl Render for Sidebar {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = self.palette;
        let pro = self
            .pro
            .map(|row| render_pro_row(&palette, row, RowPlace::Sidebar));
        let weak = cx.weak_entity();
        let entity = cx.entity();
        let store = self.store.read(cx);
        let trashed = store.snapshot.trashed.len();
        let pinned = store.snapshot.docs.iter().any(|d| d.pinned);
        let folders = store.snapshot.folders.clone();
        let editing_folder = match &self.editing {
            Some((Editing::Folder(id), input)) => Some((id.clone(), input.clone())),
            _ => None,
        };
        let new_folder_input = match &self.editing {
            Some((Editing::NewFolder { .. }, input)) => Some(input.clone()),
            _ => None,
        };
        let scope = self.scope.clone();
        let is = |s: &Scope| scope.as_ref() == Some(s);
        let show = |scope: Scope| {
            cx.listener(move |_, _, _, cx| cx.emit(SidebarEvent::Show(scope.clone())))
        };

        let mut top = div().flex().flex_col().gap(px(2.)).child(
            self.item(
                "nav-home".into(),
                "icons/notebook.svg",
                tr::documents::home::title().into(),
                is(&Scope::All),
            )
            .on_click(show(Scope::All)),
        );
        if pinned || is(&Scope::Pinned) {
            top = top.child(
                self.item(
                    "nav-pinned".into(),
                    "icons/pin.svg",
                    tr::documents::sidebar::pinned().into(),
                    is(&Scope::Pinned),
                )
                .on_click(show(Scope::Pinned)),
            );
        }

        let open = store.open.clone();
        let header = |label: &'static str| {
            div()
                .mt(px(16.))
                .h(px(26.))
                .pl(px(19.))
                .pr(px(14.))
                .flex()
                .items_center()
                .justify_between()
                .text_size(px(glass::SECTION_TITLE_SIZE))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(palette.faint)
                .child(label)
        };
        let recent = (!self.recent.is_empty()).then(|| {
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(header(tr::documents::sidebar::recent()))
                .children(self.recent.iter().map(|row| {
                    let active = open.as_deref() == Some(row.id.as_str());
                    let id = row.id.clone();
                    div()
                        .id(SharedString::from(format!("recent-{}", row.id)))
                        .mx(px(10.))
                        .h(px(glass::ROW_HEIGHT))
                        .px(px(9.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .rounded(px(glass::ROW_RADIUS))
                        .cursor_pointer()
                        .text_size(px(13.))
                        .text_color(palette.text)
                        .when(active, |el| el.bg(palette.selected))
                        .when(!active, |el| el.hover(move |s| s.bg(palette.hover)))
                        .child(div().flex_1().min_w_0().truncate().child(row.title.clone()))
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(11.5))
                                .text_color(palette.faint)
                                .child(row.when.clone()),
                        )
                        .on_click(
                            cx.listener(move |_, _, _, cx| cx.emit(SidebarEvent::Open(id.clone()))),
                        )
                }))
        });
        let has_folders = !folders.is_empty() || new_folder_input.is_some();
        let mut folder_list = div().flex().flex_col().gap(px(2.));
        if has_folders {
            folder_list = folder_list.child(
                header(tr::documents::sidebar::folders()).child(
                    div()
                        .id("documents-add-folder")
                        .size(px(22.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.))
                        .cursor_pointer()
                        .hover(move |s| s.bg(palette.hover))
                        .child(
                            svg()
                                .path("icons/plus.svg")
                                .size(px(13.))
                                .text_color(palette.muted),
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.start_new_folder(Vec::new(), window, cx)
                        })),
                ),
            );
        }
        for folder in folders {
            if let Some((editing_id, input)) = editing_folder.as_ref()
                && *editing_id == folder.id
            {
                folder_list = folder_list.child(self.input_row("folder-rename", input.clone()));
                continue;
            }
            let target = Scope::Folder(folder.id.clone());
            let menu_id = folder.id.clone();
            folder_list = folder_list.child(
                self.item(
                    SharedString::from(format!("folder-{}", folder.id)),
                    "icons/folder.svg",
                    folder.name.clone().into(),
                    is(&target),
                )
                .on_click(show(target.clone()))
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                        this.open_folder_menu(menu_id.clone(), event.position, cx);
                        cx.stop_propagation();
                    }),
                ),
            );
        }
        if let Some(input) = new_folder_input {
            folder_list = folder_list.child(self.input_row("folder-new", input));
        } else if !has_folders {
            // No folders yet: a quiet way to make one, never an empty header.
            folder_list =
                folder_list.child(
                    self.item(
                        "nav-new-folder".into(),
                        "icons/plus.svg",
                        tr::documents::sidebar::new_folder().into(),
                        false,
                    )
                    .mt(px(14.))
                    .text_color(palette.muted)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.start_new_folder(Vec::new(), window, cx)
                    })),
                );
        }

        let menu = self.menu.as_ref().map(|open| {
            let pick = entity.clone();
            let dismiss = entity.clone();
            menu::float(
                open.position,
                menu::panel(
                    &palette,
                    open.id,
                    &open.entries,
                    180.,
                    Rc::new(move |action: &Action, window, cx| {
                        let action = action.clone();
                        pick.update(cx, |this, cx| this.run(action, window, cx));
                    }),
                    Rc::new(move |_, cx| {
                        dismiss.update(cx, |this, cx| {
                            this.menu = None;
                            cx.notify();
                        });
                    }),
                ),
            )
        });

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(palette.sidebar)
            .child(
                div()
                    .id("documents-sidebar-drag")
                    .h(px(TOOLBAR_HEIGHT))
                    .flex_shrink_0()
                    .w_full()
                    .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move()),
            )
            .child(
                div()
                    .px(px(12.))
                    .pb(px(10.))
                    .flex_shrink_0()
                    .child(self.start.clone()),
            )
            .child({
                let nav = div()
                    .id("documents-nav")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.nav_scroll)
                    .pt(px(4.))
                    .pb(px(8.))
                    .child(top)
                    .children(recent)
                    .child(folder_list);
                if pro.is_some() {
                    // With the row below it, a list that runs past the foot
                    // fades out above the row's line.
                    let handle = self.nav_scroll.clone();
                    let flag = self.nav_overflows.clone();
                    let probe = gpui::canvas(
                        move |_, _, cx| {
                            let over = f32::from(handle.max_offset().y) > 0.5;
                            if flag.replace(over) != over {
                                let weak = weak.clone();
                                cx.defer(move |cx| {
                                    weak.update(cx, |_, cx| cx.notify()).ok();
                                });
                            }
                        },
                        |_, _, _, _| {},
                    )
                    .absolute()
                    .size_full();
                    div()
                        .relative()
                        .flex_1()
                        .min_h_0()
                        .flex()
                        .flex_col()
                        .child(nav)
                        .child(probe)
                        .when(self.nav_overflows.get(), |el| {
                            el.child(super::style::list_fade(&palette, 24.))
                        })
                        .into_any_element()
                } else {
                    nav.into_any_element()
                }
            })
            .children(pro)
            .child(
                div().pt(px(6.)).pb(px(12.)).child(
                    self.item(
                        "nav-trash".into(),
                        "icons/trash.svg",
                        tr::documents::sidebar::trash().into(),
                        is(&Scope::Trash),
                    )
                    .when(trashed > 0, |el| {
                        el.child(
                            div()
                                .text_size(px(12.))
                                .text_color(palette.faint)
                                .child(trashed.to_string()),
                        )
                    })
                    .on_click(show(Scope::Trash)),
                ),
            )
            .children(menu)
    }
}

#[cfg(debug_assertions)]
impl Sidebar {
    pub fn debug_start_menu(&mut self, cx: &mut Context<Self>) {
        self.start.update(cx, |b, cx| {
            b.debug_open_menu(gpui::point(px(14.), px(96.)), cx)
        });
    }
}
