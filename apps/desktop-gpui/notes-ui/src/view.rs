use std::time::Duration;

use cap_notes::Mark;
use gpui::{
    Animation, AnimationExt, AnyElement, BoxShadow, Context, Div, ElementId, FontWeight, Hsla,
    IntoElement, MouseButton, Render, Role, SharedString, Window, div, ease_out_quint, point,
    prelude::*, px, size,
};

use crate::actions::*;
use crate::commands::MenuItem;
use crate::editor::NotesEditor;
use crate::element::{Anchor, NotesElement, Popover};
use crate::glyphs::{Glyph, glyph};
use crate::menu::{Builtin, SlashAction};
use crate::theme::NotesTheme;

const POPOVER_IN: Duration = Duration::from_millis(120);

fn shadows(theme: &NotesTheme) -> Vec<BoxShadow> {
    let soft = Hsla {
        a: theme.popover_shadow.a * 0.6,
        ..theme.popover_shadow
    };
    vec![
        BoxShadow {
            color: theme.popover_shadow,
            offset: point(px(0.), px(8.)),
            blur_radius: px(24.),
            spread_radius: px(0.),
            inset: false,
        },
        BoxShadow {
            color: soft,
            offset: point(px(0.), px(1.)),
            blur_radius: px(3.),
            spread_radius: px(0.),
            inset: false,
        },
    ]
}

fn surface(theme: &NotesTheme, radius: gpui::Pixels) -> Div {
    div()
        .occlude()
        .bg(theme.popover_fill)
        .border_1()
        .border_color(theme.popover_border)
        .rounded(radius)
        .shadow(shadows(theme))
        .text_size(theme.ui_size)
        .text_color(theme.popover_text)
        .font_family(theme.body_font.clone())
}

fn animate(
    element: impl IntoElement + 'static,
    id: &'static str,
    serial: u64,
    instant: bool,
) -> AnyElement {
    let duration = if instant {
        Duration::from_millis(1)
    } else {
        POPOVER_IN
    };
    div()
        .child(element)
        .with_animation(
            ElementId::NamedInteger(id.into(), serial),
            Animation::new(duration).with_easing(ease_out_quint()),
            |el, t| el.opacity(t).mt(px((1. - t) * 3.)),
        )
        .into_any_element()
}

fn slash_glyph(action: SlashAction) -> Glyph {
    match action {
        SlashAction::Builtin(builtin) => match builtin {
            Builtin::Text => Glyph::Text,
            Builtin::Heading1 => Glyph::Heading(1),
            Builtin::Heading2 => Glyph::Heading(2),
            Builtin::Heading3 => Glyph::Heading(3),
            Builtin::Bullet => Glyph::Bullet,
            Builtin::Numbered => Glyph::Numbered,
            Builtin::Checkbox => Glyph::Checkbox,
            Builtin::Quote => Glyph::Quote,
            Builtin::Code => Glyph::Code,
            Builtin::Divider => Glyph::Divider,
        },
        SlashAction::Host(_) => Glyph::Template,
    }
}

macro_rules! guarded_actions {
    ($element:expr, $cx:expr, $( $action:ty => $method:ident ),* $(,)?) => {{
        let element = $element;
        $(
            let element = element.on_action($cx.listener(
                |this: &mut NotesEditor, action: &$action, window: &mut Window, cx: &mut Context<NotesEditor>| {
                    if !this.focus.is_focused(window) {
                        cx.propagate();
                        return;
                    }
                    this.$method(action, window, cx);
                },
            ));
        )*
        element
    }};
}

impl NotesEditor {
    fn slash_popover(&self, window: &Window, cx: &mut Context<Self>) -> Option<Popover> {
        let slash = self.slash.as_ref()?;
        if !self.focus.is_focused(window) {
            return None;
        }
        let entries = self.slash_entries();
        if entries.is_empty() {
            return None;
        }
        let theme = &self.theme;
        let visible = entries.len().min(10);
        let pad = f32::from(theme.popover_padding);
        let row = f32::from(theme.popover_row_height);
        let height = visible as f32 * row + pad * 2. + 2.;
        let width = 232.;
        let selected = slash.selected.min(entries.len() - 1);
        let rows = entries.into_iter().enumerate().map(|(index, entry)| {
            let active = index == selected;
            let color = if active {
                theme.accent
            } else {
                theme.ink_secondary
            };
            div()
                .id(("slash-item", index))
                .h(theme.popover_row_height)
                .flex_shrink_0()
                .px(px(8.))
                .rounded(px(7.))
                .flex()
                .items_center()
                .gap(px(10.))
                .when(active, |el| el.bg(theme.popover_highlight))
                .child(glyph(slash_glyph(entry.action), 16., color))
                .child(div().flex_1().truncate().child(entry.label))
                .on_mouse_move(cx.listener(move |this, _, _, cx| {
                    if let Some(slash) = this.slash.as_mut()
                        && slash.selected != index
                    {
                        slash.selected = index;
                        cx.notify();
                    }
                }))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, _, cx| {
                        this.apply_slash(index, cx);
                    }),
                )
        });
        let element = surface(theme, theme.popover_radius)
            .id("slash-menu")
            .w(px(width))
            .h(px(height))
            .p(theme.popover_padding)
            .flex()
            .flex_col()
            .overflow_y_scroll()
            .children(rows);
        Some(Popover {
            element: animate(element, "slash-in", slash.serial, false),
            size: size(px(width), px(height)),
            anchor: Anchor::Below(cap_notes::Pos::new(slash.block, slash.start)),
        })
    }

    fn toolbar_popover(&self, window: &Window, cx: &mut Context<Self>) -> Option<Popover> {
        if !self.toolbar_visible
            || self.read_only
            || self.editor.selection().is_collapsed()
            || self.drag.is_some()
            || !self.focus.is_focused(window)
            || self.slash.is_some()
            || self.menu.is_some()
        {
            return None;
        }
        let theme = &self.theme;
        let marks = self.editor.marks_at_selection();
        let has_link = marks.link().is_some();
        let button = |id: &'static str, active: bool| {
            div()
                .id(id)
                .size(px(28.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(7.))
                .text_color(if active {
                    theme.accent
                } else {
                    theme.popover_text
                })
                .when(active, |el| el.bg(theme.popover_highlight))
                .hover(|el| el.bg(theme.ink_alpha(0.06)))
        };
        let letter = |text: &'static str| div().text_size(px(14.)).child(text);
        let toggle = |mark: Mark| {
            cx.listener(move |this: &mut Self, _: &gpui::MouseDownEvent, _, cx| {
                this.edit(cx, |editor| editor.toggle_mark(mark.clone()));
                this.show_toolbar(cx);
            })
        };
        let buttons = vec![
            button("tb-bold", marks.contains(&Mark::Bold))
                .aria_label(self.labels.bold.clone())
                .child(letter("B").font_weight(FontWeight::BOLD))
                .on_mouse_down(MouseButton::Left, toggle(Mark::Bold))
                .into_any_element(),
            button("tb-italic", marks.contains(&Mark::Italic))
                .aria_label(self.labels.italic.clone())
                .child(letter("I").italic())
                .on_mouse_down(MouseButton::Left, toggle(Mark::Italic))
                .into_any_element(),
            button("tb-underline", marks.contains(&Mark::Underline))
                .aria_label(self.labels.underline.clone())
                .child(letter("U").text_decoration_1().underline())
                .on_mouse_down(MouseButton::Left, toggle(Mark::Underline))
                .into_any_element(),
            button("tb-strike", marks.contains(&Mark::Strike))
                .aria_label(self.labels.strikethrough.clone())
                .child(letter("S").line_through())
                .on_mouse_down(MouseButton::Left, toggle(Mark::Strike))
                .into_any_element(),
            button("tb-code", marks.contains(&Mark::Code))
                .aria_label(self.labels.code.clone())
                .child(glyph(
                    Glyph::Code,
                    15.,
                    if marks.contains(&Mark::Code) {
                        theme.accent
                    } else {
                        theme.popover_text
                    },
                ))
                .on_mouse_down(MouseButton::Left, toggle(Mark::Code))
                .into_any_element(),
            button("tb-highlight", marks.contains(&Mark::Highlight))
                .aria_label(self.labels.highlight.clone())
                .child(
                    div()
                        .px(px(3.))
                        .rounded(px(3.))
                        .bg(theme.highlight)
                        .child(letter("A")),
                )
                .on_mouse_down(MouseButton::Left, toggle(Mark::Highlight))
                .into_any_element(),
            button("tb-link", has_link)
                .aria_label(self.labels.link.clone())
                .child(glyph(
                    Glyph::Link,
                    15.,
                    if has_link {
                        theme.accent
                    } else {
                        theme.popover_text
                    },
                ))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _, window, cx| this.open_link_editor(window, cx)),
                )
                .into_any_element(),
        ];
        let count = buttons.len() as f32;
        let width = count * 28. + (count - 1.) * 2. + 10.;
        let height = 38.;
        let element = surface(theme, theme.toolbar_radius)
            .flex()
            .items_center()
            .gap(px(2.))
            .p(px(4.))
            .w(px(width))
            .h(px(height))
            .children(buttons);
        Some(Popover {
            element: animate(element, "toolbar-in", self.toolbar_serial, false),
            size: size(px(width), px(height)),
            anchor: Anchor::SelectionTop,
        })
    }

    fn link_popover(&self) -> Option<Popover> {
        let edit = self.link_edit.as_ref()?;
        let theme = &self.theme;
        let width = 300.;
        let height = 40.;
        let element = surface(theme, theme.popover_radius)
            .w(px(width))
            .h(px(height))
            .px(px(10.))
            .flex()
            .items_center()
            .gap(px(8.))
            .child(glyph(Glyph::Link, 14., theme.ink_secondary))
            .child(edit.field.clone());
        Some(Popover {
            element: animate(element, "link-in", edit.serial, false),
            size: size(px(width), px(height)),
            anchor: Anchor::SelectionBelow,
        })
    }

    fn context_popover(&self, cx: &mut Context<Self>) -> Option<Popover> {
        let menu = self.menu.as_ref()?;
        let theme = &self.theme;
        let items = self.menu_items();
        let labels = &self.labels;
        let row = f32::from(theme.popover_row_height);
        let pad = f32::from(theme.popover_padding);
        let mut height = pad * 2. + 2.;
        let mut children: Vec<AnyElement> = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let (label, enabled) = match item {
                MenuItem::Cut { enabled } => (labels.cut.clone(), *enabled),
                MenuItem::Copy { enabled } => (labels.copy.clone(), *enabled),
                MenuItem::Paste => (labels.paste.clone(), true),
                MenuItem::SelectAll => (labels.select_all.clone(), true),
                MenuItem::OpenLink => (labels.open_link.clone(), true),
                MenuItem::CopyLink => (labels.copy_link.clone(), true),
                MenuItem::RemoveLink => (labels.remove_link.clone(), true),
            };
            if *item == MenuItem::OpenLink {
                children.push(
                    div()
                        .h(px(9.))
                        .flex()
                        .items_center()
                        .px(px(8.))
                        .child(div().h(px(1.)).w_full().bg(theme.separator))
                        .into_any_element(),
                );
                height += 9.;
            }
            height += row;
            let active = menu.selected == Some(index) && enabled;
            children.push(
                div()
                    .id(("menu-item", index))
                    .h(theme.popover_row_height)
                    .px(px(10.))
                    .rounded(px(7.))
                    .flex()
                    .items_center()
                    .when(!enabled, |el| el.text_color(theme.ink_tertiary))
                    .when(active, |el| el.bg(theme.popover_highlight))
                    .child(label)
                    .on_mouse_move(cx.listener(move |this, _, _, cx| {
                        if let Some(menu) = this.menu.as_mut()
                            && menu.selected != Some(index)
                        {
                            menu.selected = Some(index);
                            cx.notify();
                        }
                    }))
                    .when(enabled, |el| {
                        el.on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, _, window, cx| {
                                this.run_menu_item(index, window, cx);
                            }),
                        )
                    })
                    .into_any_element(),
            );
        }
        let width = 208.;
        let element = surface(theme, theme.popover_radius)
            .w(px(width))
            .p(theme.popover_padding)
            .flex()
            .flex_col()
            .children(children);
        Some(Popover {
            element: animate(element, "menu-in", menu.serial, false),
            size: size(px(width), px(height)),
            anchor: Anchor::Point(menu.position),
        })
    }

    fn tooltip_popover(&self) -> Option<Popover> {
        if !self.hover.tooltip || self.drag.is_some() || self.menu.is_some() {
            return None;
        }
        let link = self.hover.link.as_ref()?;
        let theme = &self.theme;
        let width = (link.url.chars().count() as f32 * 6.1 + 20.).clamp(60., 360.);
        let height = 26.;
        let element = surface(theme, px(8.))
            .w(px(width))
            .h(px(height))
            .px(px(9.))
            .flex()
            .items_center()
            .text_size(px(12.))
            .text_color(theme.popover_muted)
            .child(div().truncate().child(SharedString::from(link.url.clone())));
        Some(Popover {
            element: animate(element, "tooltip-in", link.range.start as u64, false),
            size: size(px(width), px(height)),
            anchor: Anchor::Below(cap_notes::Pos::new(link.block, link.range.start)),
        })
    }

    fn find_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let find = self.find.as_ref()?;
        let theme = &self.theme;
        let count: SharedString = match (find.current, find.matches.len()) {
            (_, 0) if !find.query.is_empty() => self.labels.find_no_results.clone(),
            (_, 0) => SharedString::default(),
            (Some(current), total) => format!("{}/{}", current + 1, total).into(),
            (None, total) => format!("{total}").into(),
        };
        let icon_button = |id: &'static str, kind: Glyph, label: SharedString| {
            div()
                .id(id)
                .size(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .hover(|el| el.bg(theme.ink_alpha(0.06)))
                .aria_label(label)
                .child(glyph(kind, 14., theme.ink_secondary))
        };
        Some(
            surface(theme, theme.toolbar_radius)
                .id("find-bar")
                .absolute()
                .top(px(10.))
                .right(px(16.))
                .w(px(340.))
                .h(px(38.))
                .pl(px(10.))
                .pr(px(4.))
                .flex()
                .items_center()
                .gap(px(6.))
                .child(glyph(Glyph::Search, 14., theme.ink_tertiary))
                .child(find.field.clone())
                .child(
                    div()
                        .flex_shrink_0()
                        .text_size(px(12.))
                        .text_color(theme.popover_muted)
                        .child(count),
                )
                .child(
                    icon_button(
                        "find-prev",
                        Glyph::ChevronUp,
                        self.labels.find_previous.clone(),
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.find_step(false, cx))),
                )
                .child(
                    icon_button(
                        "find-next",
                        Glyph::ChevronDown,
                        self.labels.find_next.clone(),
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.find_step(true, cx))),
                )
                .child(
                    icon_button("find-close", Glyph::Close, self.labels.find_close.clone())
                        .on_click(cx.listener(|this, _, window, cx| this.close_find(window, cx))),
                )
                .into_any_element(),
        )
    }
}

impl Render for NotesEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.debug_mark_render_start();
        let mut popovers = Vec::new();
        popovers.extend(self.slash_popover(window, cx));
        popovers.extend(self.toolbar_popover(window, cx));
        popovers.extend(self.link_popover());
        popovers.extend(self.context_popover(cx));
        popovers.extend(self.tooltip_popover());
        let theme = &self.theme;
        let root = div()
            .id("cap-notes-editor")
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .role(Role::MultilineTextInput)
            .aria_label(self.labels.editor.clone())
            .aria_placeholder(self.placeholder.clone())
            .w_full()
            // A page laid out at its full height is clipped by the host that
            // scrolls it; clipping it here too would hide that viewport from
            // the editor (which blocks are visible, where the caret must go).
            .when(!self.fit, |root| root.h_full().overflow_hidden())
            .relative()
            .bg(theme.background)
            .font_family(theme.body_font.clone())
            .on_action(
                cx.listener(|this, action: &Find, window, cx| this.on_find(action, window, cx)),
            );
        let root = guarded_actions!(root, cx,
            Backspace => on_backspace,
            DeleteForward => on_delete,
            DeleteWordLeft => on_delete_word_left,
            DeleteWordRight => on_delete_word_right,
            DeleteToLineStart => on_delete_to_line_start,
            DeleteToLineEnd => on_delete_to_line_end,
            Newline => on_newline,
            Indent => on_indent,
            Outdent => on_outdent,
            ToggleCheckbox => on_toggle_checkbox,
            MoveBlockUp => on_move_block_up,
            MoveBlockDown => on_move_block_down,
            Undo => on_undo,
            Redo => on_redo,
            Cut => on_cut,
            Copy => on_copy,
            Paste => on_paste,
            PastePlain => on_paste_plain,
            SelectAll => on_select_all,
            ToggleBold => on_toggle_bold,
            ToggleItalic => on_toggle_italic,
            ToggleUnderline => on_toggle_underline,
            ToggleStrikethrough => on_toggle_strike,
            ToggleCode => on_toggle_code,
            ToggleHighlight => on_toggle_highlight,
            Heading1 => on_heading_1,
            Heading2 => on_heading_2,
            Heading3 => on_heading_3,
            Paragraph => on_paragraph,
            OrderedList => on_ordered,
            BulletList => on_bullet,
            TaskList => on_task,
            Quote => on_quote,
            CodeBlock => on_code_block,
            EditLink => on_edit_link,
            MoveLeft => on_move_left,
            MoveRight => on_move_right,
            MoveUp => on_move_up,
            MoveDown => on_move_down,
            MoveWordLeft => on_move_word_left,
            MoveWordRight => on_move_word_right,
            MoveToLineStart => on_move_to_line_start,
            MoveToLineEnd => on_move_to_line_end,
            MoveToStart => on_move_to_start,
            MoveToEnd => on_move_to_end,
            PageUp => on_page_up,
            PageDown => on_page_down,
            SelectLeft => on_select_left,
            SelectRight => on_select_right,
            SelectUp => on_select_up,
            SelectDown => on_select_down,
            SelectWordLeft => on_select_word_left,
            SelectWordRight => on_select_word_right,
            SelectToLineStart => on_select_to_line_start,
            SelectToLineEnd => on_select_to_line_end,
            SelectToStart => on_select_to_start,
            SelectToEnd => on_select_to_end,
            SelectPageUp => on_select_page_up,
            SelectPageDown => on_select_page_down,
            ScrollToStart => on_scroll_to_start,
            ScrollToEnd => on_scroll_to_end,
            FindNext => on_find_next,
            FindPrevious => on_find_previous,
            Cancel => on_cancel,
            ShowCharacterPalette => on_character_palette,
        );
        let find_bar = self.find_bar(cx);
        root.child(NotesElement {
            view: cx.entity(),
            store: self.store.clone(),
            popovers,
        })
        .children(find_bar)
    }
}
