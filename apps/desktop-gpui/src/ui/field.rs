//! `Field` and `Subfield` -- the config sidebar's two labelled setting
//! containers (`routes/editor/ui.tsx:25-69`).
//!
//! They are layout-only in the source and layout-only here. `Field` has four
//! shapes:
//!
//! | shape | used for | header |
//! |---|---|---|
//! | `plain` | the export flow and the screenshot editor | 13px/600 with an icon |
//! | `section` | a sidebar group title, with an optional trailing ghost action | 12px/500 `text_2` |
//! | `stacked` | a complex control that cannot sit on one row | 13px/400 `text_1` |
//! | `inline` | one control on a 34px row: label, control, value | 13px/400 `text_1` |
//!
//! `Subfield` is the inline row for controls whose label is a sentence rather
//! than a column heading.
//!
//! `ui.tsx` is imported by the settings pages and the main window too, which is
//! why these live in the shared library rather than next to the editor window.

use std::sync::Arc;

use gpui::{
    AnyElement, FontFeatures, FontWeight, Hsla, IntoElement, ParentElement, Pixels, RenderOnce,
    SharedString, Styled, Window, div, prelude::FluentBuilder, px, svg,
};

use crate::theme::Theme;

/// The label column every inline row shares, so a column of sliders starts at
/// the same x.
const INLINE_LABEL_WIDTH: f32 = 96.;
const INLINE_ROW_HEIGHT: f32 = 34.;
const INLINE_VALUE_WIDTH: f32 = 36.;

fn tabular_numerals() -> FontFeatures {
    FontFeatures(Arc::new(vec![("tnum".to_string(), 1)]))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldStyle {
    Plain,
    Section,
    Stacked,
    Inline,
}

/// `<Field>`: a header row above the children, or -- inline -- one row.
#[derive(IntoElement)]
pub struct Field {
    name: SharedString,
    icon: Option<SharedString>,
    icon_size: Pixels,
    /// The `badge` pill (`text-[10px] px-1.5 py-0.5 bg-gray-3 rounded-full
    /// text-gray-11 font-medium`).
    badge: Option<SharedString>,
    /// The `ml-auto` slot. Every header toggle in the sidebar lives here.
    value: Option<AnyElement>,
    /// The inline row's right-hand readout.
    value_text: Option<SharedString>,
    children: Vec<AnyElement>,
    gap: Pixels,
    style: FieldStyle,
    text: Hsla,
    muted: Hsla,
    value_color: Hsla,
    disabled_text: Hsla,
    badge_bg: Hsla,
    badge_text: Hsla,
    disabled: bool,
}

impl Field {
    fn new(theme: &Theme, name: impl Into<SharedString>, style: FieldStyle, gap: Pixels) -> Self {
        Self {
            name: name.into(),
            icon: None,
            icon_size: px(16.),
            badge: None,
            value: None,
            value_text: None,
            children: Vec::new(),
            gap,
            style,
            text: Hsla::from(theme.editor.text_1),
            muted: Hsla::from(theme.editor.text_2),
            value_color: Hsla::from(theme.editor.text_3),
            disabled_text: Hsla::from(theme.editor.text_3),
            badge_bg: Hsla::from(theme.editor.ctl),
            badge_text: Hsla::from(theme.editor.text_2),
            disabled: false,
        }
    }

    /// The editor surface: Radix, no material.
    pub fn plain(theme: &Theme, name: impl Into<SharedString>) -> Self {
        Self::new(theme, name, FieldStyle::Plain, px(16.))
    }

    /// A sidebar group title: 12px/500 `text_2`, no icon, with the group's
    /// action (`None`, `Save`, `Reset`) in the `value` slot.
    pub fn section(theme: &Theme, name: impl Into<SharedString>) -> Self {
        Self::new(theme, name, FieldStyle::Section, px(10.))
    }

    /// A control that needs its own block under the label.
    pub fn stacked(theme: &Theme, name: impl Into<SharedString>) -> Self {
        Self::new(theme, name, FieldStyle::Stacked, px(8.))
    }

    /// One control on one row: label, control, readout.
    pub fn inline(theme: &Theme, name: impl Into<SharedString>) -> Self {
        Self::new(theme, name, FieldStyle::Inline, px(0.))
    }

    /// `<IconCapImage class="size-4" />` and friends. Some call sites pass no
    /// class at all, which is `text-lg`'s 18px; those pass their own size.
    pub fn icon(mut self, icon: impl Into<SharedString>) -> Self {
        self.icon = Some(icon.into());
        self
    }

    pub fn icon_size(mut self, size: Pixels) -> Self {
        self.icon_size = size;
        self
    }

    pub fn badge(mut self, badge: impl Into<SharedString>) -> Self {
        self.badge = Some(badge.into());
        self
    }

    pub fn value(mut self, value: AnyElement) -> Self {
        self.value = Some(value);
        self
    }

    pub fn value_text(mut self, value: impl Into<SharedString>) -> Self {
        self.value_text = Some(value.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The `class` prop -- `GradientEditor`'s angle row overrides the gap.
    pub fn gap(mut self, gap: Pixels) -> Self {
        self.gap = gap;
        self
    }

    pub fn child(mut self, child: impl IntoElement) -> Self {
        self.children.push(child.into_any_element());
        self
    }

    pub fn children(mut self, children: impl IntoIterator<Item = AnyElement>) -> Self {
        self.children.extend(children);
        self
    }
}

impl RenderOnce for Field {
    fn render(self, _window: &mut Window, _cx: &mut gpui::App) -> impl IntoElement {
        let Field {
            name,
            icon,
            icon_size,
            badge,
            value,
            value_text,
            children,
            gap,
            style,
            text,
            muted,
            value_color,
            disabled_text,
            badge_bg,
            badge_text,
            disabled,
        } = self;
        let label_color = match (disabled, style) {
            (true, _) => disabled_text,
            (false, FieldStyle::Section) => muted,
            (false, _) => text,
        };

        if style == FieldStyle::Inline {
            return div()
                .flex()
                .flex_row()
                .items_center()
                .h(px(INLINE_ROW_HEIGHT))
                .gap(px(10.))
                .child(
                    div()
                        .flex_none()
                        .min_w(px(INLINE_LABEL_WIDTH))
                        .text_size(px(13.))
                        .font_weight(FontWeight::NORMAL)
                        .text_color(label_color)
                        .child(name),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_end()
                        .gap(px(8.))
                        .children(children),
                )
                .when_some(value_text, |this, value_text| {
                    this.child(
                        div()
                            .flex_none()
                            .min_w(px(INLINE_VALUE_WIDTH))
                            .text_right()
                            .text_size(px(11.))
                            .font_features(tabular_numerals())
                            .text_color(value_color)
                            .child(value_text),
                    )
                })
                .when_some(value, |this, value| {
                    this.child(div().flex_none().flex().items_center().child(value))
                });
        }

        let (label_size, label_weight) = match style {
            FieldStyle::Section => (px(12.), FontWeight::MEDIUM),
            FieldStyle::Stacked => (px(13.), FontWeight::NORMAL),
            _ => (px(13.), FontWeight::SEMIBOLD),
        };
        let show_icon = style == FieldStyle::Plain;

        div()
            .flex()
            .flex_col()
            .gap(gap)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .when(style == FieldStyle::Section, |this| this.min_h(px(22.)))
                    .text_size(label_size)
                    .font_weight(label_weight)
                    .text_color(label_color)
                    .children(
                        icon.filter(|_| show_icon)
                            .map(|icon| svg().path(icon).size(icon_size).text_color(label_color)),
                    )
                    .child(name)
                    .children(badge.map(|badge| {
                        div()
                            .px(px(6.))
                            .py(px(2.))
                            .rounded_full()
                            .bg(badge_bg)
                            .text_size(px(10.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(badge_text)
                            .child(badge)
                    }))
                    .when_some(value, |this, value| {
                        this.child(div().ml_auto().flex().items_center().child(value))
                    }),
            )
            .children(children)
    }
}

/// `<Subfield>`: one 34px row of label and control, the control at the end.
#[derive(IntoElement)]
pub struct Subfield {
    name: SharedString,
    /// `required` draws a `text-blue-500` asterisk after the name.
    required: bool,
    children: Vec<AnyElement>,
    gap: Option<Pixels>,
    text: Hsla,
    accent: Hsla,
}

impl Subfield {
    pub fn plain(theme: &Theme, name: impl Into<SharedString>) -> Self {
        Self {
            name: name.into(),
            required: false,
            children: Vec::new(),
            gap: None,
            text: Hsla::from(theme.editor.text_1),
            accent: Hsla::from(theme.editor.accent),
        }
    }

    pub fn required(mut self, required: bool) -> Self {
        self.required = required;
        self
    }

    /// The `class` prop: `GradientEditor`'s angle row is `gap-4 items-center`.
    pub fn gap(mut self, gap: Pixels) -> Self {
        self.gap = Some(gap);
        self
    }

    pub fn child(mut self, child: impl IntoElement) -> Self {
        self.children.push(child.into_any_element());
        self
    }
}

impl RenderOnce for Subfield {
    fn render(self, _window: &mut Window, _cx: &mut gpui::App) -> impl IntoElement {
        let Subfield {
            name,
            required,
            children,
            gap,
            text,
            accent,
        } = self;

        div()
            .flex()
            .flex_row()
            .justify_between()
            .items_center()
            .min_h(px(INLINE_ROW_HEIGHT))
            .when_some(gap, |this, gap| this.gap(gap))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .flex_none()
                    .text_size(px(13.))
                    .font_weight(FontWeight::NORMAL)
                    .text_color(text)
                    .child(name)
                    .when(required, |this| {
                        this.child(
                            div()
                                .ml(px(2.))
                                .text_size(px(12.))
                                .text_color(accent)
                                .child("*"),
                        )
                    }),
            )
            .children(children)
    }
}
