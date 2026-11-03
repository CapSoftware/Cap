use cap_project::ProjectConfiguration;
use gpui::{
    AnyElement, Bounds, ClickEvent, Context, FontWeight, Hsla, InteractiveElement, IntoElement,
    MouseButton, ParentElement, Pixels, Point, SharedString, StatefulInteractiveElement as _,
    Styled, Window, div, point, prelude::FluentBuilder, px, svg,
};

use super::{EditorWindow, POPOVER_WINDOW_INSET, PresetDialog};
use crate::editor_panels::TextStyle;
use crate::i18n::tr;
use crate::style_presets::{
    CaptionStyle, MaskStyle, PresetKind, PresetLibrary, PresetTarget, StylePresets,
    StyleTrackStyle, apply_to_all, apply_to_items,
};
use crate::ui;

const MENU_MIN_WIDTH: f32 = 272.;
const SUBMENU_WIDTH: f32 = 208.;
const LIST_MAX_HEIGHT: f32 = 232.;
const ROW_HEIGHT: f32 = 32.;
const MENU_GAP: f32 = 6.;

macro_rules! with_kind {
    ($kind:expr, $S:ident => $body:expr) => {
        match $kind {
            PresetKind::Text => {
                type $S = TextStyle;
                $body
            }
            PresetKind::Mask => {
                type $S = MaskStyle;
                $body
            }
            PresetKind::Captions => {
                type $S = CaptionStyle;
                $body
            }
            PresetKind::Style => {
                type $S = StyleTrackStyle;
                $body
            }
        }
    };
}

#[derive(Default)]
pub(super) struct StylePresetsState {
    library: PresetLibrary,
    menu: Option<StylePresetsMenu>,
}

impl StylePresetsState {
    pub(super) fn load() -> Self {
        Self {
            library: PresetLibrary::load(),
            menu: None,
        }
    }

    pub(super) fn menu_open(&self) -> bool {
        self.menu.is_some()
    }

    pub(super) fn close_menu(&mut self) {
        self.menu = None;
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum MenuAnchor {
    Below(Pixels),
    Above(Pixels),
}

pub(super) struct StylePresetsMenu {
    kind: PresetKind,
    indices: Vec<usize>,
    left: Pixels,
    width: Pixels,
    anchor: MenuAnchor,
    submenu: Option<(String, Point<Pixels>)>,
    scroll: gpui::ScrollHandle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StyleDialog {
    Create {
        kind: PresetKind,
        index: usize,
        default: bool,
    },
    Rename {
        kind: PresetKind,
        preset: usize,
    },
    Delete {
        kind: PresetKind,
        preset: usize,
    },
}

struct KindCopy {
    use_for_new: &'static str,
    used_for_new: &'static str,
    default_name: &'static str,
    apply_all: Option<fn(usize) -> String>,
    applied_all: Option<fn(usize) -> String>,
}

fn kind_copy(kind: PresetKind) -> KindCopy {
    match kind {
        PresetKind::Text => KindCopy {
            use_for_new: tr::editor::panel::style_presets::text_segment::use_for_new(),
            used_for_new: tr::editor::panel::style_presets::text_segment::used_for_new(),
            default_name: tr::editor::panel::style_presets::text_segment::default_name(),
            apply_all: Some(tr::editor::panel::style_presets::text_segment::apply_all),
            applied_all: Some(tr::editor::panel::style_presets::text_segment::applied_all),
        },
        PresetKind::Mask => KindCopy {
            use_for_new: tr::editor::panel::style_presets::mask::use_for_new(),
            used_for_new: tr::editor::panel::style_presets::mask::used_for_new(),
            default_name: tr::editor::panel::style_presets::mask::default_name(),
            apply_all: Some(tr::editor::panel::style_presets::mask::apply_all),
            applied_all: Some(tr::editor::panel::style_presets::mask::applied_all),
        },
        PresetKind::Captions => KindCopy {
            use_for_new: tr::editor::panel::style_presets::captions::use_for_new(),
            used_for_new: tr::editor::panel::style_presets::captions::used_for_new(),
            default_name: tr::editor::panel::style_presets::captions::default_name(),
            apply_all: None,
            applied_all: None,
        },
        PresetKind::Style => KindCopy {
            use_for_new: tr::editor::panel::style_presets::style::use_for_new(),
            used_for_new: tr::editor::panel::style_presets::style::used_for_new(),
            default_name: tr::editor::panel::style_presets::style::default_name(),
            apply_all: Some(tr::editor::panel::style_presets::style::apply_all),
            applied_all: Some(tr::editor::panel::style_presets::style::applied_all),
        },
    }
}

fn menu_row(
    theme: &crate::theme::Theme,
    id: impl Into<SharedString>,
    icon: &'static str,
    label: impl Into<SharedString>,
    enabled: bool,
    danger: bool,
) -> gpui::Stateful<gpui::Div> {
    let red = Hsla::from(gpui::rgb(0xf87171));
    let red_wash = Hsla {
        a: 0.10,
        ..Hsla::from(gpui::rgb(0xef4444))
    };
    let (text, icon_color) = if !enabled {
        (
            Hsla::from(theme.editor.text_3),
            Hsla::from(theme.editor.text_3),
        )
    } else if danger {
        (red, red)
    } else {
        (
            Hsla::from(theme.editor.text_1),
            Hsla::from(theme.editor.text_2),
        )
    };
    let hover = if danger {
        red_wash
    } else {
        Hsla::from(theme.editor.ctl_hover)
    };
    let id: SharedString = id.into();
    let label: SharedString = label.into();
    div()
        .id(id)
        .h(px(ROW_HEIGHT))
        .w_full()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(10.))
        .rounded(px(8.))
        .px(px(8.))
        .text_size(px(12.5))
        .text_color(text)
        .when(enabled, |this| {
            this.cursor_pointer().hover(move |this| this.bg(hover))
        })
        .child(
            svg()
                .path(icon)
                .size(px(14.))
                .flex_none()
                .text_color(icon_color),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(label),
        )
}

fn default_badge(theme: &crate::theme::Theme) -> gpui::Div {
    div()
        .flex_none()
        .px(px(6.))
        .py(px(1.))
        .rounded_full()
        .text_size(px(10.5))
        .font_weight(FontWeight::MEDIUM)
        .bg(crate::editor_sidebar::with_alpha(theme.editor.accent, 0.16))
        .text_color(Hsla::from(theme.editor.accent))
        .child(tr::editor::panel::style_presets::default_badge())
}

impl EditorWindow {
    pub(crate) fn render_style_presets_bar(
        &self,
        kind: PresetKind,
        indices: &[usize],
        cx: &mut Context<Self>,
    ) -> AnyElement {
        with_kind!(kind, S => self.style_presets_bar::<S>(indices, cx))
    }

    fn current_style<S: PresetTarget>(&self, indices: &[usize]) -> Option<S> {
        let (first, rest) = indices.split_first()?;
        let style = S::read(&self.project, *first)?;
        rest.iter()
            .all(|index| S::read(&self.project, *index).as_ref() == Some(&style))
            .then_some(style)
    }

    fn style_presets_bar<S: PresetTarget>(
        &self,
        indices: &[usize],
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let kind = S::KIND;
        let presets = S::presets(&self.style_presets.library);
        let current = self.current_style::<S>(indices);
        let matched = current.as_ref().and_then(|style| presets.matching(style));
        let is_default = matched.is_some_and(|preset| presets.is_default(&preset.id));
        let label: SharedString = matched.map_or_else(
            || tr::editor::panel::style_presets::custom().into(),
            |preset| preset.name.clone().into(),
        );
        let open = self
            .style_presets
            .menu
            .as_ref()
            .is_some_and(|menu| menu.kind == kind);
        let indices = indices.to_vec();

        ui::Menu::trigger(
            div()
                .id(SharedString::from(format!("style-presets-{}", kind.key())))
                .h(px(32.))
                .w_full()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.))
                .px(px(10.))
                .rounded(px(8.))
                .cursor_pointer()
                .bg(Hsla::from(if open {
                    theme.editor.ctl_active
                } else {
                    theme.editor.ctl
                }))
                .hover(|this| this.bg(Hsla::from(theme.editor.ctl_hover)))
                .child(
                    svg()
                        .path("icons/presets.svg")
                        .size(px(14.))
                        .flex_none()
                        .text_color(Hsla::from(theme.editor.text_2)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_size(px(12.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(if matched.is_some() {
                            theme.editor.text_1
                        } else {
                            theme.editor.text_2
                        }))
                        .child(label),
                )
                .when(is_default, |this| this.child(default_badge(&theme)))
                .child(
                    svg()
                        .path("icons/chevron-down.svg")
                        .size(px(12.))
                        .flex_none()
                        .text_color(Hsla::from(theme.editor.text_3)),
                )
                .tooltip(move |_window, cx| {
                    ui::Tooltip::new(&theme, tr::editor::panel::style_presets::tooltip()).view(cx)
                }),
            cx.listener(move |this, bounds: &Bounds<Pixels>, window, cx| {
                this.open_style_presets_menu(kind, indices.clone(), *bounds, window, cx);
            }),
        )
        .into_any_element()
    }

    fn open_style_presets_menu(
        &mut self,
        kind: PresetKind,
        indices: Vec<usize>,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .style_presets
            .menu
            .as_ref()
            .is_some_and(|menu| menu.kind == kind)
        {
            self.style_presets.menu = None;
            cx.notify();
            return;
        }
        self.style_presets.library = PresetLibrary::load();
        let viewport = window.viewport_size();
        let width = f32::from(bounds.size.width).max(MENU_MIN_WIDTH);
        let left = f32::from(bounds.origin.x)
            .min(f32::from(viewport.width) - width - POPOVER_WINDOW_INSET)
            .max(POPOVER_WINDOW_INSET);
        let count = with_kind!(kind, S => S::presets(&self.style_presets.library).presets().len());
        let estimated =
            (count.max(1) as f32 * ROW_HEIGHT).min(LIST_MAX_HEIGHT) + 4. * ROW_HEIGHT + 40.;
        let below = f32::from(bounds.bottom()) + MENU_GAP;
        let anchor = if below + estimated + POPOVER_WINDOW_INSET <= f32::from(viewport.height)
            || f32::from(bounds.top()) < estimated
        {
            MenuAnchor::Below(px(below))
        } else {
            MenuAnchor::Above(px(
                f32::from(viewport.height) - f32::from(bounds.top()) + MENU_GAP
            ))
        };
        self.style_presets.menu = Some(StylePresetsMenu {
            kind,
            indices,
            left: px(left),
            width: px(width),
            anchor,
            submenu: None,
            scroll: gpui::ScrollHandle::new(),
        });
        cx.notify();
    }

    pub(super) fn render_style_presets_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.style_presets.menu.as_ref()?;
        let body = with_kind!(menu.kind, S => self.style_presets_menu::<S>(menu, cx));
        let submenu = menu.submenu.as_ref().and_then(|(id, at)| {
            with_kind!(menu.kind, S => self.style_preset_submenu::<S>(menu, id, *at, cx))
        });
        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("style-presets-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .occlude()
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.style_presets.menu = None;
                            cx.notify();
                        })),
                )
                .child(body)
                .children(submenu)
                .into_any_element(),
        )
    }

    fn style_presets_menu<S: PresetTarget>(
        &self,
        menu: &StylePresetsMenu,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let kind = S::KIND;
        let copy = kind_copy(kind);
        let presets = S::presets(&self.style_presets.library);
        let current = self.current_style::<S>(&menu.indices);
        let matched = current
            .as_ref()
            .and_then(|style| presets.matching(style))
            .map(|preset| preset.id.clone());
        let current_is_default = current
            .as_ref()
            .zip(presets.default_style())
            .is_some_and(|(current, default)| current == default);
        let total = S::count(&self.project);
        let can_save = current.is_some();

        let rows: Vec<AnyElement> = if presets.is_empty() {
            vec![
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .px(px(8.))
                    .py(px(10.))
                    .child(
                        div()
                            .text_size(px(12.5))
                            .text_color(Hsla::from(theme.editor.text_2))
                            .child(tr::editor::panel::style_presets::empty()),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(Hsla::from(theme.editor.text_3))
                            .child(tr::editor::panel::style_presets::empty_help()),
                    )
                    .into_any_element(),
            ]
        } else {
            presets
                .presets()
                .iter()
                .map(|preset| {
                    let id = preset.id.clone();
                    let gear_id = preset.id.clone();
                    let selected = matched.as_deref() == Some(preset.id.as_str());
                    let missing_font = preset.style.missing_font().map(str::to_string);
                    let submenu_open = menu
                        .submenu
                        .as_ref()
                        .is_some_and(|(open, _)| *open == preset.id);
                    div()
                        .id(SharedString::from(format!("style-preset-{}", preset.id)))
                        .h(px(ROW_HEIGHT))
                        .flex()
                        .flex_none()
                        .flex_row()
                        .items_center()
                        .gap(px(8.))
                        .pl(px(8.))
                        .pr(px(4.))
                        .rounded(px(8.))
                        .cursor_pointer()
                        .when(submenu_open, |this| {
                            this.bg(Hsla::from(theme.editor.ctl_hover))
                        })
                        .hover(|this| this.bg(Hsla::from(theme.editor.ctl_hover)))
                        .child(div().size(px(14.)).flex_none().when(selected, |this| {
                            this.child(
                                svg()
                                    .path("icons/check.svg")
                                    .size(px(14.))
                                    .text_color(Hsla::from(theme.editor.accent)),
                            )
                        }))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_size(px(12.5))
                                .text_color(Hsla::from(theme.editor.text_1))
                                .child(SharedString::from(preset.name.clone())),
                        )
                        .children(missing_font.map(|font| {
                            let message =
                                SharedString::from(tr::editor::panel::style_presets::font_missing(
                                    font,
                                    crate::editor_panels::font_family_label("sans-serif"),
                                ));
                            div()
                                .id(SharedString::from(format!(
                                    "style-preset-font-{}",
                                    preset.id
                                )))
                                .flex_none()
                                .child(
                                    svg()
                                        .path("icons/triangle-alert.svg")
                                        .size(px(13.))
                                        .text_color(Hsla::from(theme.editor.text_3)),
                                )
                                .tooltip(move |_window, cx| {
                                    ui::Tooltip::new(&theme, message.clone()).view(cx)
                                })
                        }))
                        .when(presets.is_default(&preset.id), |this| {
                            this.child(default_badge(&theme))
                        })
                        .child(
                            div()
                                .id(SharedString::from(format!(
                                    "style-preset-more-{}",
                                    preset.id
                                )))
                                .flex()
                                .flex_none()
                                .items_center()
                                .justify_center()
                                .size(px(24.))
                                .rounded(px(6.))
                                .cursor_pointer()
                                .hover(|this| this.bg(Hsla::from(theme.editor.ctl_active)))
                                .child(
                                    svg()
                                        .path("icons/more-horizontal.svg")
                                        .size(px(14.))
                                        .text_color(Hsla::from(theme.editor.text_2)),
                                )
                                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                .on_click(cx.listener(
                                    move |this, event: &ClickEvent, window, cx| {
                                        cx.stop_propagation();
                                        this.toggle_style_preset_submenu(
                                            gear_id.clone(),
                                            event.position(),
                                            window,
                                            cx,
                                        );
                                    },
                                )),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.apply_style_preset::<S>(&id, window, cx);
                        }))
                        .into_any_element()
                })
                .collect()
        };

        let apply_all = copy
            .apply_all
            .filter(|_| total > 1 && can_save)
            .map(|label| {
                menu_row(
                    &theme,
                    format!("style-presets-apply-all-{}", kind.key()),
                    "icons/layers.svg",
                    label(total),
                    true,
                    false,
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    this.apply_current_style_to_all::<S>(window, cx);
                }))
            });

        let footer = div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .p(px(6.))
            .border_t_1()
            .border_color(Hsla::from(theme.editor.line))
            .child(
                menu_row(
                    &theme,
                    format!("style-presets-save-{}", kind.key()),
                    "icons/save.svg",
                    tr::editor::panel::style_presets::save(),
                    can_save,
                    false,
                )
                .when(can_save, |this| {
                    this.on_click(cx.listener(|this, _, window, cx| {
                        this.open_style_preset_create::<S>(window, cx);
                    }))
                }),
            )
            .child(
                menu_row(
                    &theme,
                    format!("style-presets-default-{}", kind.key()),
                    if current_is_default {
                        "icons/check.svg"
                    } else {
                        "icons/circle-check.svg"
                    },
                    if current_is_default {
                        copy.used_for_new
                    } else {
                        copy.use_for_new
                    },
                    can_save && !current_is_default,
                    false,
                )
                .when(can_save && !current_is_default, |this| {
                    this.on_click(cx.listener(|this, _, window, cx| {
                        this.make_current_style_default::<S>(window, cx);
                    }))
                }),
            )
            .children(apply_all);

        let panel = div()
            .id("style-presets-menu")
            .absolute()
            .left(menu.left)
            .w(menu.width)
            .occlude()
            .flex()
            .flex_col()
            .rounded(px(12.))
            .border_1()
            .border_color(Hsla::from(theme.editor.line))
            .bg(Hsla::from(theme.editor.card))
            .shadow(theme.editor.pop_shadow())
            .overflow_hidden()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .id("style-presets-list")
                    .flex()
                    .flex_col()
                    .max_h(px(LIST_MAX_HEIGHT))
                    .min_h_0()
                    .p(px(6.))
                    .gap(px(2.))
                    .overflow_y_scroll()
                    .track_scroll(&menu.scroll)
                    .children(rows),
            )
            .child(footer);
        match menu.anchor {
            MenuAnchor::Below(top) => panel.top(top),
            MenuAnchor::Above(bottom) => panel.bottom(bottom),
        }
        .into_any_element()
    }

    fn toggle_style_preset_submenu(
        &mut self,
        id: String,
        at: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let viewport = window.viewport_size();
        let Some(menu) = self.style_presets.menu.as_mut() else {
            return;
        };
        if menu.submenu.as_ref().is_some_and(|(open, _)| *open == id) {
            menu.submenu = None;
            cx.notify();
            return;
        }
        let menu_left = f32::from(menu.left);
        let menu_right = menu_left + f32::from(menu.width);
        let x = if menu_left - SUBMENU_WIDTH - 4. >= POPOVER_WINDOW_INSET {
            menu_left - SUBMENU_WIDTH - 4.
        } else {
            (menu_right + 4.).min(f32::from(viewport.width) - SUBMENU_WIDTH - POPOVER_WINDOW_INSET)
        };
        let submenu_height = 7. * ROW_HEIGHT + 24.;
        let y = (f32::from(at.y) - 16.)
            .min(f32::from(viewport.height) - submenu_height - POPOVER_WINDOW_INSET)
            .max(POPOVER_WINDOW_INSET);
        menu.submenu = Some((id, point(px(x), px(y))));
        cx.notify();
    }

    fn style_preset_submenu<S: PresetTarget>(
        &self,
        menu: &StylePresetsMenu,
        id: &str,
        at: Point<Pixels>,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let theme = self.theme;
        let presets = S::presets(&self.style_presets.library);
        let index = presets.position(id)?;
        let last = presets.presets().len().saturating_sub(1);
        let is_default = presets.is_default(id);
        let can_update = self.current_style::<S>(&menu.indices).is_some();
        let key = S::KIND.key();
        let row = |name: &str, icon: &'static str, label: &'static str, enabled: bool, danger| {
            menu_row(
                &theme,
                format!("style-preset-{name}-{key}"),
                icon,
                label,
                enabled,
                danger,
            )
        };
        let apply_id = id.to_string();
        let update_id = id.to_string();
        let default_id = id.to_string();
        let up_id = id.to_string();
        let down_id = id.to_string();

        Some(
            div()
                .id("style-preset-submenu")
                .absolute()
                .left(at.x)
                .top(at.y)
                .w(px(SUBMENU_WIDTH))
                .occlude()
                .flex()
                .flex_col()
                .p(px(4.))
                .gap(px(2.))
                .rounded(px(12.))
                .border_1()
                .border_color(Hsla::from(theme.editor.line))
                .bg(Hsla::from(theme.editor.card))
                .shadow(theme.editor.pop_shadow())
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(
                    row(
                        "apply",
                        "icons/check.svg",
                        tr::editor::panel::style_presets::apply(),
                        true,
                        false,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.apply_style_preset::<S>(&apply_id, window, cx);
                    })),
                )
                .child(
                    row(
                        "update",
                        "icons/refresh-cw.svg",
                        tr::editor::panel::style_presets::update(),
                        can_update,
                        false,
                    )
                    .when(can_update, |this| {
                        this.on_click(cx.listener(move |this, _, window, cx| {
                            this.update_style_preset::<S>(&update_id, window, cx);
                        }))
                    }),
                )
                .child(
                    row(
                        "default",
                        "icons/circle-check.svg",
                        if is_default {
                            tr::editor::panel::style_presets::remove_default()
                        } else {
                            tr::editor::panel::style_presets::set_default()
                        },
                        true,
                        false,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        let id = default_id.clone();
                        this.mutate_style_presets::<S, _>(window, cx, move |presets| {
                            presets.set_default((!is_default).then_some(id.as_str()))
                        });
                    })),
                )
                .child(
                    row(
                        "up",
                        "icons/chevron-up.svg",
                        tr::editor::panel::style_presets::move_up(),
                        index > 0,
                        false,
                    )
                    .when(index > 0, |this| {
                        this.on_click(cx.listener(move |this, _, window, cx| {
                            let id = up_id.clone();
                            this.mutate_style_presets::<S, _>(window, cx, move |presets| {
                                presets.move_by(&id, -1)
                            });
                        }))
                    }),
                )
                .child(
                    row(
                        "down",
                        "icons/chevron-down.svg",
                        tr::editor::panel::style_presets::move_down(),
                        index < last,
                        false,
                    )
                    .when(index < last, |this| {
                        this.on_click(cx.listener(move |this, _, window, cx| {
                            let id = down_id.clone();
                            this.mutate_style_presets::<S, _>(window, cx, move |presets| {
                                presets.move_by(&id, 1)
                            });
                        }))
                    }),
                )
                .child(
                    row(
                        "rename",
                        "icons/pencil.svg",
                        tr::editor::panel::style_presets::rename(),
                        true,
                        false,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_style_dialog(
                            StyleDialog::Rename {
                                kind: S::KIND,
                                preset: index,
                            },
                            window,
                            cx,
                        );
                    })),
                )
                .child(
                    row(
                        "delete",
                        "icons/trash.svg",
                        tr::editor::panel::style_presets::delete(),
                        true,
                        true,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_style_dialog(
                            StyleDialog::Delete {
                                kind: S::KIND,
                                preset: index,
                            },
                            window,
                            cx,
                        );
                    })),
                )
                .into_any_element(),
        )
    }

    fn apply_style_with<S: PresetTarget>(
        &mut self,
        reason: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
        change: impl FnOnce(&mut ProjectConfiguration) -> bool,
    ) {
        if S::KIND == PresetKind::Captions {
            self.edit_project_without_timeline(reason, window, cx, change);
        } else {
            self.edit_project(reason, window, cx, change);
        }
    }

    fn apply_style_preset<S: PresetTarget>(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(menu) = self.style_presets.menu.take() else {
            return;
        };
        let Some(style) = S::presets(&self.style_presets.library)
            .get(id)
            .map(|preset| preset.style.clone())
        else {
            cx.notify();
            return;
        };
        let indices = menu.indices;
        self.apply_style_with::<S>("style-preset-apply", window, cx, move |project| {
            apply_to_items(project, &indices, &style)
        });
        cx.notify();
    }

    fn apply_current_style_to_all<S: PresetTarget>(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(menu) = self.style_presets.menu.take() else {
            return;
        };
        let Some(style) = self.current_style::<S>(&menu.indices) else {
            cx.notify();
            return;
        };
        let total = S::count(&self.project);
        let mut changed = false;
        self.apply_style_with::<S>("style-preset-apply-all", window, cx, |project| {
            changed = apply_to_all(project, &style);
            changed
        });
        if let Some(message) = kind_copy(S::KIND).applied_all.filter(|_| changed) {
            self.show_notice(message(total), window, cx);
        }
        cx.notify();
    }

    fn mutate_style_presets<S: PresetTarget, R>(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        mutate: impl FnOnce(&mut StylePresets<S>) -> R,
    ) -> Option<R> {
        if let Some(menu) = self.style_presets.menu.as_mut() {
            menu.submenu = None;
        }
        let outcome = StylePresets::<S>::update(mutate);
        cx.notify();
        match outcome {
            Some((presets, result)) => {
                *S::presets_mut(&mut self.style_presets.library) = presets;
                Some(result)
            }
            None => {
                self.show_notice(tr::editor::panel::style_presets::save_failed(), window, cx);
                None
            }
        }
    }

    fn update_style_preset<S: PresetTarget>(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(style) = self
            .style_presets
            .menu
            .as_ref()
            .and_then(|menu| self.current_style::<S>(&menu.indices))
        else {
            return;
        };
        let id = id.to_string();
        self.mutate_style_presets::<S, _>(window, cx, move |presets| presets.set_style(&id, style));
    }

    fn make_current_style_default<S: PresetTarget>(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(style) = self
            .style_presets
            .menu
            .as_ref()
            .and_then(|menu| self.current_style::<S>(&menu.indices))
        else {
            return;
        };
        let name = kind_copy(S::KIND).default_name;
        self.mutate_style_presets::<S, _>(window, cx, move |presets| {
            presets.make_default_from(style, name)
        });
    }

    fn open_style_preset_create<S: PresetTarget>(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(index) = self
            .style_presets
            .menu
            .as_ref()
            .and_then(|menu| menu.indices.first().copied())
        else {
            return;
        };
        self.open_style_dialog(
            StyleDialog::Create {
                kind: S::KIND,
                index,
                default: false,
            },
            window,
            cx,
        );
    }

    fn open_style_dialog(
        &mut self,
        dialog: StyleDialog,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let prefill = match dialog {
            StyleDialog::Create { kind, .. } => with_kind!(kind, S => {
                S::presets(&self.style_presets.library).unique_name(kind_copy(kind).default_name)
            }),
            StyleDialog::Rename { kind, preset } => with_kind!(kind, S => {
                S::presets(&self.style_presets.library)
                    .presets()
                    .get(preset)
                    .map(|preset| preset.name.clone())
                    .unwrap_or_default()
            }),
            StyleDialog::Delete { .. } => String::new(),
        };
        self.style_presets.menu = None;
        self.preset_dialog = Some(PresetDialog::Style(dialog));
        if !matches!(dialog, StyleDialog::Delete { .. }) {
            self.preset_name_input.update(cx, |input, cx| {
                input.set_text(prefill, cx);
                input.focus_and_select_all(window, cx);
            });
        }
        cx.notify();
    }

    pub(super) fn commit_style_dialog(
        &mut self,
        dialog: StyleDialog,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        match dialog {
            StyleDialog::Create {
                kind,
                index,
                default,
            } => with_kind!(kind, S => {
                if name.trim().is_empty() {
                    return false;
                }
                let Some(style) = S::read(&self.project, index) else {
                    return true;
                };
                let name = name.to_string();
                self.mutate_style_presets::<S, _>(window, cx, move |presets| {
                    let id = presets.add(&name, style);
                    if default && let Some(id) = id.as_deref() {
                        presets.set_default(Some(id));
                    }
                });
                true
            }),
            StyleDialog::Rename { kind, preset } => with_kind!(kind, S => {
                if name.trim().is_empty() {
                    return false;
                }
                let Some(id) = self.style_preset_id::<S>(preset) else {
                    return true;
                };
                let name = name.to_string();
                self.mutate_style_presets::<S, _>(window, cx, move |presets| {
                    presets.rename(&id, &name)
                });
                true
            }),
            StyleDialog::Delete { kind, preset } => with_kind!(kind, S => {
                if let Some(id) = self.style_preset_id::<S>(preset) {
                    self.mutate_style_presets::<S, _>(window, cx, move |presets| {
                        presets.remove(&id)
                    });
                }
                true
            }),
        }
    }

    fn style_preset_id<S: PresetTarget>(&self, index: usize) -> Option<String> {
        S::presets(&self.style_presets.library)
            .presets()
            .get(index)
            .map(|preset| preset.id.clone())
    }

    pub(super) fn style_dialog_parts(
        &self,
        dialog: StyleDialog,
        cx: &mut Context<Self>,
    ) -> (&'static str, &'static str, bool, AnyElement) {
        let theme = self.theme;
        let name_input = || {
            ui::TextInput::plain(&theme, "preset-name", &self.preset_name_input)
                .padding_x(px(12.))
                .height(px(36.))
                .radius(px(8.))
                .text_size(px(14.))
        };
        match dialog {
            StyleDialog::Create {
                kind,
                index,
                default,
            } => (
                tr::editor::panel::style_presets::create_title(),
                tr::editor::panel::style_presets::create(),
                false,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(16.))
                    .child(name_input())
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .gap(px(12.))
                            .child(
                                div()
                                    .text_size(px(14.))
                                    .text_color(Hsla::from(theme.editor.text_1))
                                    .child(kind_copy(kind).use_for_new),
                            )
                            .child(
                                ui::Toggle::plain(&theme, "style-preset-default", default)
                                    .on_click(cx.listener(move |this, _, _window, cx| {
                                        this.preset_dialog =
                                            Some(PresetDialog::Style(StyleDialog::Create {
                                                kind,
                                                index,
                                                default: !default,
                                            }));
                                        cx.notify();
                                    }))
                                    .into_any_element(),
                            ),
                    )
                    .into_any_element(),
            ),
            StyleDialog::Rename { .. } => (
                tr::editor::panel::style_presets::rename_title(),
                tr::editor::panel::style_presets::rename(),
                false,
                div().child(name_input()).into_any_element(),
            ),
            StyleDialog::Delete { kind, preset } => {
                let name = with_kind!(kind, S => {
                    S::presets(&self.style_presets.library)
                        .presets()
                        .get(preset)
                        .map(|preset| preset.name.clone())
                        .unwrap_or_default()
                });
                (
                    tr::editor::panel::style_presets::delete_title(),
                    tr::editor::panel::style_presets::delete(),
                    true,
                    div()
                        .text_size(px(14.))
                        .text_color(Hsla::from(theme.editor.text_2))
                        .child(SharedString::from(
                            tr::editor::panel::style_presets::delete_confirm(name),
                        ))
                        .into_any_element(),
                )
            }
        }
    }
}
