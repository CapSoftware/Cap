//! The inline pieces a section shows for assets that are not on disk yet:
//! one row offering the rest of the section, and the overlay a tile wears
//! while its file downloads.

use gpui::{
    AnyElement, Hsla, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, div, px, relative, svg,
};

use super::{ItemStatus, Kind, Summary};
use crate::{i18n::tr, theme::Theme};

pub fn megabytes(bytes: u64) -> String {
    let mb = bytes as f64 / 1_000_000.;
    let size = if mb < 10. {
        format!("{:.1}", mb.max(0.1))
    } else {
        format!("{mb:.0}")
    };
    tr::assets::megabytes(&size)
}

fn alpha(color: impl Into<Hsla>, alpha: f32) -> Hsla {
    let mut color = color.into();
    color.a *= alpha;
    color
}

/// The row above a section's items. `None` when everything is on disk, or
/// while an existing user's files are being restored.
pub fn download_row(theme: &Theme, kind: Kind) -> Option<AnyElement> {
    if !super::offers_downloads() {
        return None;
    }
    let summary = super::summary(kind);
    if summary.missing == 0 && summary.bulk.is_none() {
        return None;
    }
    let palette = &theme.editor;
    let id = match kind {
        Kind::Wallpaper => "asset-download-backgrounds",
        Kind::Music => "asset-download-music",
    };
    let row = div()
        .id(id)
        .flex()
        .flex_col()
        .gap(px(7.))
        .w_full()
        .px(px(12.))
        .py(px(9.))
        .rounded(px(10.))
        .bg(Hsla::from(palette.ctl))
        .text_size(px(12.5));

    let line = |icon: &'static str, label: SharedString, detail: Option<SharedString>| {
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .child(
                svg()
                    .path(icon)
                    .size(px(14.))
                    .flex_none()
                    .text_color(Hsla::from(palette.text_2)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_color(Hsla::from(palette.text_1))
                    .child(label),
            )
            .children(detail.map(|detail| {
                div()
                    .flex_none()
                    .text_color(Hsla::from(palette.text_3))
                    .child(detail)
            }))
    };

    let element = match summary.bulk {
        Some(bulk) if bulk.running => {
            let fraction = if bulk.total == 0 {
                0.
            } else {
                (bulk.received as f32 / bulk.total as f32).clamp(0., 1.)
            };
            let label = match kind {
                Kind::Wallpaper => tr::assets::downloading_backgrounds(),
                Kind::Music => tr::assets::downloading_music(),
            };
            row.child(
                line(
                    "icons/download.svg",
                    label.into(),
                    Some(
                        tr::assets::progress(megabytes(bulk.received), megabytes(bulk.total))
                            .into(),
                    ),
                )
                .child(
                    div()
                        .id(SharedString::from(format!("{id}-cancel")))
                        .flex_none()
                        .size(px(18.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(9.))
                        .cursor_pointer()
                        .hover(|this| this.bg(Hsla::from(palette.ctl_hover)))
                        .tooltip({
                            let theme = *theme;
                            move |_, cx| {
                                crate::ui::Tooltip::new(&theme, tr::assets::cancel()).view(cx)
                            }
                        })
                        .child(
                            svg()
                                .path("icons/x.svg")
                                .size(px(11.))
                                .text_color(Hsla::from(palette.text_2)),
                        )
                        .on_click(move |_, _, cx| {
                            cx.stop_propagation();
                            super::cancel_all(kind);
                        }),
                ),
            )
            .child(progress_bar(theme, fraction))
            .into_any_element()
        }
        Some(bulk) => row
            .cursor_pointer()
            .hover(|this| this.bg(Hsla::from(palette.ctl_hover)))
            .child(line(
                "icons/triangle-alert.svg",
                tr::assets::some_failed(bulk.failed).into(),
                Some(tr::assets::retry().into()),
            ))
            .on_click(move |_, _, _| {
                super::dismiss_failures(kind);
                super::download_all(kind);
            })
            .into_any_element(),
        None => row
            .cursor_pointer()
            .hover(|this| this.bg(Hsla::from(palette.ctl_hover)))
            .child(line(
                "icons/download.svg",
                idle_label(kind, &summary),
                Some(megabytes(summary.missing_bytes).into()),
            ))
            .on_click(move |_, _, _| super::download_all(kind))
            .into_any_element(),
    };
    Some(element)
}

fn idle_label(kind: Kind, summary: &Summary) -> SharedString {
    match kind {
        Kind::Wallpaper if summary.new == summary.missing => {
            tr::assets::new_backgrounds(summary.new).into()
        }
        Kind::Music if summary.new == summary.missing => tr::assets::new_tracks(summary.new).into(),
        Kind::Wallpaper => tr::assets::download_all_backgrounds().into(),
        Kind::Music => tr::assets::download_all_music().into(),
    }
}

pub fn progress_bar(theme: &Theme, fraction: f32) -> impl IntoElement {
    div()
        .w_full()
        .h(px(3.))
        .rounded(px(1.5))
        .bg(Hsla::from(theme.editor.track))
        .child(
            div()
                .h_full()
                .w(relative(fraction.clamp(0.02, 1.)))
                .rounded(px(1.5))
                .bg(Hsla::from(theme.editor.accent_fill)),
        )
}

/// What a tile draws over its thumbnail: a progress bar while downloading, a
/// small badge when the file is not here yet or the last try failed.
pub fn tile_overlay(status: ItemStatus, radius: f32) -> Option<AnyElement> {
    let badge = |icon: &'static str| {
        div()
            .absolute()
            .right(px(4.))
            .bottom(px(4.))
            .size(px(18.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(9.))
            .bg(alpha(gpui::black(), 0.55))
            .child(svg().path(icon).size(px(10.)).text_color(gpui::white()))
    };
    match status {
        ItemStatus::Ready => None,
        ItemStatus::Missing if !super::offers_downloads() => None,
        ItemStatus::Missing => Some(badge("icons/download.svg").into_any_element()),
        ItemStatus::Failed => Some(badge("icons/refresh-cw.svg").into_any_element()),
        ItemStatus::Downloading(fraction) => Some(
            div()
                .absolute()
                .inset_0()
                .rounded(px(radius))
                .bg(alpha(gpui::black(), 0.35))
                .child(
                    div()
                        .absolute()
                        .left(px(6.))
                        .right(px(6.))
                        .bottom(px(6.))
                        .h(px(3.))
                        .rounded(px(1.5))
                        .bg(alpha(gpui::white(), 0.3))
                        .child(
                            div()
                                .h_full()
                                .w(relative(fraction.clamp(0.04, 1.)))
                                .rounded(px(1.5))
                                .bg(gpui::white()),
                        ),
                )
                .into_any_element(),
        ),
    }
}

/// The trailing part of a music row: a size and download glyph when the
/// track is not here yet, progress while it downloads.
pub fn track_trailing(theme: &Theme, status: ItemStatus, size: u64) -> Option<AnyElement> {
    let palette = &theme.editor;
    match status {
        ItemStatus::Ready => None,
        ItemStatus::Missing if !super::offers_downloads() => None,
        ItemStatus::Missing | ItemStatus::Failed => Some(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.))
                .text_size(px(11.))
                .text_color(Hsla::from(palette.text_3))
                .child(megabytes(size))
                .child(
                    svg()
                        .path(if status == ItemStatus::Failed {
                            "icons/refresh-cw.svg"
                        } else {
                            "icons/download.svg"
                        })
                        .size(px(15.))
                        .text_color(Hsla::from(theme.gray_11)),
                )
                .into_any_element(),
        ),
        ItemStatus::Downloading(fraction) => Some(
            div()
                .w(px(44.))
                .child(progress_bar(theme, fraction))
                .into_any_element(),
        ),
    }
}
