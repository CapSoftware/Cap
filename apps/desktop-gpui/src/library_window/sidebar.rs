//! The source list, as its own cached view: it only renders when its rows,
//! counts, selection or colours change, never on a scroll or search frame of
//! the main area.

use gpui::{
    Context, EventEmitter, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement,
    Render, SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder,
    px, svg,
};

use super::{Section, style, style::Palette};
use crate::i18n::tr;

#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    Nav {
        id: SharedString,
        icon: &'static str,
        label: SharedString,
        count: Option<usize>,
        section: Section,
    },
    /// The Folders title with its "new smart folder" button.
    FoldersLabel,
    Spacer,
    Notice(&'static str),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Model {
    pub rows: Vec<Row>,
    pub selected: Section,
    pub palette: Palette,
    pub background: Option<Hsla>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SidebarEvent {
    Show(Section),
    NewSmartFolder,
}

pub struct SidebarView {
    model: Model,
}

impl EventEmitter<SidebarEvent> for SidebarView {}

impl SidebarView {
    pub fn new(model: Model) -> Self {
        Self { model }
    }

    /// Takes the latest rows; redraws only when something visible changed.
    pub fn set_model(&mut self, model: Model, cx: &mut Context<Self>) {
        if self.model != model {
            self.model = model;
            cx.notify();
        }
    }

    fn label(&self, text: &'static str) -> gpui::Div {
        div()
            .mt(px(16.))
            .mb(px(2.))
            .h(px(24.))
            .px(px(20.))
            .flex()
            .items_center()
            .justify_between()
            .text_size(px(style::SECTION_TITLE_SIZE))
            .font_weight(FontWeight::MEDIUM)
            .text_color(self.model.palette.muted)
            .child(text)
    }
}

impl Render for SidebarView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = self.model.palette;
        let mut col = div()
            .id("library-sidebar")
            .size_full()
            .flex()
            .flex_col()
            .pt(px(style::TOOLBAR_HEIGHT))
            .pb(px(10.))
            .overflow_y_scroll()
            .when_some(self.model.background, |el, bg| el.bg(bg));
        for row in self.model.rows.clone() {
            col = match row {
                Row::Nav {
                    id,
                    icon,
                    label,
                    count,
                    section,
                } => {
                    let active = self.model.selected == section;
                    col.child(
                        div()
                            .id(id)
                            .mx(px(10.))
                            .h(px(style::ROW_HEIGHT))
                            .px(px(8.))
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .rounded(px(style::ROW_RADIUS))
                            .cursor_pointer()
                            .text_size(px(13.))
                            .text_color(p.text)
                            .role(gpui::Role::Button)
                            .aria_label(label.clone())
                            .aria_selected(active)
                            .when(active, |el| {
                                el.bg(p.selected).font_weight(FontWeight::MEDIUM)
                            })
                            .when(!active, |el| el.hover(move |s| s.bg(p.hover)))
                            .child(
                                svg()
                                    .path(icon)
                                    .size(px(15.))
                                    .flex_shrink_0()
                                    .text_color(p.muted),
                            )
                            .child(div().flex_1().min_w_0().truncate().child(label))
                            .children(count.filter(|c| *c > 0).map(|c| {
                                div()
                                    .flex_shrink_0()
                                    .text_size(px(11.5))
                                    .text_color(p.faint)
                                    .child(c.to_string())
                            }))
                            .on_click(cx.listener(move |_, _, _, cx| {
                                cx.emit(SidebarEvent::Show(section.clone()))
                            })),
                    )
                }
                Row::FoldersLabel => col.child(
                    self.label(tr::library::folders()).child(
                        div()
                            .id("new-smart-folder")
                            .size(px(20.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .role(gpui::Role::Button)
                            .aria_label(tr::library::new_smart_folder())
                            .hover(move |s| s.bg(p.hover))
                            .child(
                                svg()
                                    .path("icons/plus.svg")
                                    .size(px(13.))
                                    .text_color(p.muted),
                            )
                            .on_click(
                                cx.listener(|_, _, _, cx| cx.emit(SidebarEvent::NewSmartFolder)),
                            ),
                    ),
                ),
                Row::Spacer => col.child(div().flex_1().min_h(px(16.))),
                Row::Notice(text) => col.child(
                    div()
                        .mx(px(18.))
                        .mb(px(8.))
                        .text_size(px(11.5))
                        .line_height(px(16.))
                        .text_color(p.muted)
                        .child(text),
                ),
            };
        }
        col
    }
}
