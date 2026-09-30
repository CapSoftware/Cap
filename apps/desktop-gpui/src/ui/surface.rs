//! Surfaces: the card, the liquid-glass panel, the popover, and the two
//! label-plus-control row families the Solid app keeps deliberately distinct
//! (`Setting.tsx`'s bordered card list and `editor/ui.tsx`'s stacked fields).

use gpui::{
    AnyElement, Div, FontWeight, Hsla, IntoElement, ParentElement, Pixels, RenderOnce,
    SharedString, Styled, Window, div, prelude::FluentBuilder, px,
};

use crate::theme::Theme;

/// `<SectionCard>` / `<SectionRows>` -- `rounded-xl border border-gray-3
/// bg-gray-2`, carrying the `.cap-settings-card` hook the material layer reads.
pub struct Card;

impl Card {
    /// The settings card: radius 10 and no border under the settings material,
    /// filled with `--macos-settings-card`.
    pub fn settings(theme: &Theme, padded: bool) -> Div {
        div()
            .rounded(px(10.))
            .overflow_hidden()
            .bg(theme.settings_card_bg())
            .when(padded, |this| this.px(px(16.)).py(px(16.)))
    }

    /// The same card with `divide-y divide-gray-3` between its rows.
    pub fn settings_rows(theme: &Theme, children: Vec<AnyElement>) -> Div {
        let border = theme.settings_border();
        let last = children.len().saturating_sub(1);
        Card::settings(theme, false).flex().flex_col().children(
            children.into_iter().enumerate().map(|(index, child)| {
                div()
                    .when(index != last, |this| this.border_b_1().border_color(border))
                    .child(child)
            }),
        )
    }

    /// `LIQUID_GLASS_SURFACE_CLASS`: `rounded-2xl border border-gray-12/10
    /// bg-gray-1/82 shadow-xl shadow-black/20 dark:border-white/10
    /// dark:bg-gray-2/82`. The `backdrop-blur-xl` is dropped -- this gpui rev
    /// has no per-element backdrop blur.
    pub fn liquid_glass(theme: &Theme) -> Div {
        div()
            .rounded(px(16.))
            .border_1()
            .border_color(if theme.is_dark() {
                gpui::hsla(0., 0., 1., 0.1)
            } else {
                Theme::with_alpha(theme.gray_12, 0.1)
            })
            .bg(if theme.is_dark() {
                Theme::with_alpha(theme.gray_2, 0.82)
            } else {
                Theme::with_alpha(theme.gray_1, 0.82)
            })
            .shadow(vec![gpui::BoxShadow {
                color: gpui::hsla(0., 0., 0., 0.2),
                offset: gpui::point(px(0.), px(8.)),
                blur_radius: px(10.),
                spread_radius: px(-6.),
                inset: false,
            }])
    }

    /// The teleprompter footer's pill: `h-8 rounded-full border border-gray-12/6
    /// bg-gray-12/5 px-2`.
    pub fn glass_pill(theme: &Theme) -> Div {
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.))
            .h(px(32.))
            .rounded_full()
            .border_1()
            .border_color(Theme::with_alpha(theme.gray_12, 0.06))
            .bg(Theme::with_alpha(theme.gray_12, 0.05))
            .px(px(8.))
    }
}

/// An anchored floating panel: `KPopover`'s content, not a modal.
///
/// Positioning stays with the caller -- every popover in this app is placed
/// against a known edge of its own window (`absolute bottom-12 right-2` for the
/// teleprompter's), not flipped against a viewport.
pub struct Popover;

impl Popover {
    /// The teleprompter's settings popover: `w-48 rounded-2xl border
    /// border-gray-12/8 bg-gray-1/80 p-2 shadow-xl`. The `backdrop-blur-2xl` is
    /// the wash only -- no blur hook in this gpui rev.
    pub fn glass(theme: &Theme, width: Pixels) -> Div {
        div()
            .absolute()
            .w(width)
            .p(px(8.))
            .rounded(px(16.))
            .border_1()
            .border_color(Theme::with_alpha(theme.gray_12, 0.08))
            .bg(Theme::with_alpha(theme.gray_1, 0.8))
            .shadow_lg()
    }

    /// `PopperContent` on the plain palette: `rounded-xl border border-gray-3
    /// bg-gray-1 shadow-s`.
    pub fn plain(theme: &Theme) -> Div {
        div()
            .absolute()
            .flex()
            .flex_col()
            .rounded(px(12.))
            .border_1()
            .border_color(theme.gray(3))
            .bg(theme.gray(1))
            .shadow_lg()
    }
}

/// `<SettingItem>` / `.cap-setting-row { min-height: 46px; padding: 12px }` over
/// `flex flex-row gap-4 justify-between items-center`.
#[derive(IntoElement)]
pub struct SettingRow {
    label: SharedString,
    description: Option<SharedString>,
    control: AnyElement,
    muted: Hsla,
}

impl SettingRow {
    pub fn settings(
        theme: &Theme,
        label: impl Into<SharedString>,
        description: Option<&'static str>,
        control: AnyElement,
    ) -> Self {
        Self {
            label: label.into(),
            description: description.map(SharedString::from),
            control,
            muted: theme.settings_muted(),
        }
    }
}

impl RenderOnce for SettingRow {
    fn render(self, _window: &mut Window, _cx: &mut gpui::App) -> impl IntoElement {
        let SettingRow {
            label,
            description,
            control,
            muted,
        } = self;

        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(16.))
            .min_h(px(46.))
            .p(px(12.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(div().text_size(px(13.)).child(label))
                    .children(description.map(|description| {
                        div()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(muted)
                            .child(description)
                    })),
            )
            .child(div().flex().items_center().flex_shrink_0().child(control))
    }
}

/// `<Section>`: a title (with an optional `Pro` pill), an optional description
/// and an optional right-aligned slot, above the section's children.
#[derive(IntoElement)]
pub struct Section {
    title: SharedString,
    description: Option<SharedString>,
    right: Option<AnyElement>,
    children: Vec<AnyElement>,
    pro: bool,
    muted: Hsla,
    accent: Hsla,
}

impl Section {
    pub fn settings(
        theme: &Theme,
        title: impl Into<SharedString>,
        description: Option<&'static str>,
        right: Option<AnyElement>,
        children: Vec<AnyElement>,
    ) -> Self {
        Self {
            title: title.into(),
            description: description.map(SharedString::from),
            right,
            children,
            pro: false,
            muted: theme.settings_muted(),
            accent: Hsla::from(theme.blue_9),
        }
    }

    /// The `Pro` badge: `bg-blue-9 text-white uppercase`.
    pub fn pro(mut self) -> Self {
        self.pro = true;
        self
    }
}

impl RenderOnce for Section {
    fn render(self, _window: &mut Window, _cx: &mut gpui::App) -> impl IntoElement {
        let Section {
            title,
            description,
            right,
            children,
            pro,
            muted,
            accent,
        } = self;

        div()
            .flex()
            .flex_col()
            // `space-y-2.5`
            .gap(px(10.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .items_end()
                    .gap(px(12.))
                    .px(px(4.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .min_w_0()
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .text_size(px(14.))
                                            // `text-sm font-semibold
                                            //  tracking-tight`
                                            // (`settings/Setting.tsx:27`).
                                            // `font-semibold` renders 700: no
                                            // 600 face is loaded over there
                                            // (`ui-solid/vite.js:31-33`).
                                            .font_weight(FontWeight::BOLD)
                                            .child(title),
                                    )
                                    .when(pro, |this| {
                                        // `text-[10px] font-medium uppercase
                                        //  tracking-wide px-1.5 py-0.5
                                        //  rounded-md bg-blue-9 text-white`
                                        this.child(
                                            div()
                                                .px(px(6.))
                                                .py(px(2.))
                                                .rounded(px(6.))
                                                .bg(accent)
                                                .text_size(px(10.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(gpui::white())
                                                .child("PRO"),
                                        )
                                    }),
                            )
                            .children(description.map(|description| {
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(18.))
                                    .text_color(muted)
                                    .child(description)
                            })),
                    )
                    .children(right),
            )
            .children(children)
    }
}
