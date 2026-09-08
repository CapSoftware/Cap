//! `Field` and `Subfield` -- the config sidebar's two labelled setting
//! containers (`routes/editor/ui.tsx:25-69`).
//!
//! They are layout-only in the source and layout-only here: a `Field` is a
//! header row (icon, name, optional badge pill, optional right-aligned slot)
//! stacked `gap-4` above whatever control it wraps, and a `Subfield` is a
//! single `justify-between` row of label and control. Between them they carry
//! every section header in the sidebar, so their spacing is load-bearing -- the
//! background tab's rhythm is `gap-6` between fields and `gap-4` inside one.
//!
//! `ui.tsx` is imported by the settings pages and the main window too, which is
//! why these live in the shared library rather than next to the editor window.

use gpui::{
    AnyElement, FontWeight, Hsla, IntoElement, ParentElement, Pixels, RenderOnce, SharedString,
    Styled, Window, div, prelude::FluentBuilder, px, svg,
};

use crate::theme::Theme;

/// `<Field>`: `flex flex-col gap-4` with a header row above the children.
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
    children: Vec<AnyElement>,
    gap: Pixels,
    text: Hsla,
    disabled_text: Hsla,
    badge_bg: Hsla,
    badge_text: Hsla,
    disabled: bool,
}

impl Field {
    /// The editor surface: Radix, no material.
    pub fn plain(theme: &Theme, name: impl Into<SharedString>) -> Self {
        Self {
            name: name.into(),
            icon: None,
            icon_size: px(16.),
            badge: None,
            value: None,
            children: Vec::new(),
            // `gap-4`
            gap: px(16.),
            text: Hsla::from(theme.gray_12),
            // `data-[disabled='true']:text-gray-10`
            disabled_text: Hsla::from(theme.gray_10),
            badge_bg: Hsla::from(theme.gray_3),
            badge_text: Hsla::from(theme.gray_11),
            disabled: false,
        }
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
            children,
            gap,
            text,
            disabled_text,
            badge_bg,
            badge_text,
            disabled,
        } = self;
        let label_color = if disabled { disabled_text } else { text };

        div()
            .flex()
            .flex_col()
            .gap(gap)
            .child(
                // `flex flex-row items-center gap-1.5 text-gray-12 font-medium
                //  text-sm`
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .text_size(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(label_color)
                    .children(
                        icon.map(|icon| svg().path(icon).size(icon_size).text_color(label_color)),
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

/// `<Subfield>`: `flex flex-row justify-between items-center`, label
/// `font-medium text-gray-12`, control on the right.
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
            text: Hsla::from(theme.gray_12),
            accent: Hsla::from(theme.blue_500),
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
            .when_some(gap, |this, gap| this.gap(gap))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .font_weight(FontWeight::MEDIUM)
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
