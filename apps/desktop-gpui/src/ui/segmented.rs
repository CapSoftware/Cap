//! `SegmentedControl` -- one component for the four idioms the Solid app grew
//! independently (digest section 7, item 13).
//!
//! | idiom | where | shape |
//! |---|---|---|
//! | sliding pill | `packages/ui-solid/src/SwitchTab.tsx` | bordered strip, `KTabs.Indicator` slides a `bg-gray-1` pill |
//! | tab rail | `ConfigSidebar.tsx`, `FrameButton.tsx` | icon triggers, `size-9` indicator box |
//! | flat pills | `ExportPage.tsx` | loose `gap-1.5` buttons, selected `bg-gray-3 border-gray-5` |
//! | icon grid | `ConfigSidebar.tsx` text-align | `grid-cols-3` cells in a bordered box, selected `bg-gray-5` |
//!
//! The superset is: a container (padding, radius, border, fill, gap) holding
//! items (padding, radius, text size/weight, per-state fill and colour), each
//! either a label, an icon, or both. The tab-rail idiom keeps its own component
//! ([`crate::ui::TabRail`]) because its items are `flex-1` icon boxes with a
//! separate indicator layer, not padded pills.
//!
//! The selected pill glides between items. Stretched controls without gaps
//! place it by fraction so it tracks a resizing row exactly; the rest place
//! it from item rects measured on the previous frame, so until those exist
//! the selected item paints its own fill.

use std::time::Duration;

use gpui::{
    Animation, AnimationExt, App, Bounds, ElementId, FontWeight, Hsla, InteractiveElement,
    IntoElement, ParentElement, Pixels, Point, RenderOnce, SharedString,
    StatefulInteractiveElement, Styled, Window, canvas, div, prelude::FluentBuilder, px, relative,
    svg,
};

use crate::theme::Theme;

/// One segment. `selected` is computed by the caller so the control never has
/// to know what the value type is.
#[derive(Debug, Clone)]
pub struct SegmentOption {
    pub label: Option<SharedString>,
    pub icon: Option<SharedString>,
    pub selected: bool,
    pub disabled: bool,
}

impl SegmentOption {
    pub fn new(label: impl Into<SharedString>, selected: bool) -> Self {
        Self {
            label: Some(label.into()),
            icon: None,
            selected,
            disabled: false,
        }
    }

    pub fn icon(icon: impl Into<SharedString>, selected: bool) -> Self {
        Self {
            label: None,
            icon: Some(icon.into()),
            selected,
            disabled: false,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

/// Maps a click on segment `index` back onto a value from a fixed list, which
/// is the one piece of the old per-window `segmented::<T>` helper worth
/// keeping: every call site had the same `T::ALL.get(index)` guard.
pub fn option_at<T: Copy>(values: &[T], index: usize) -> Option<T> {
    values.get(index).copied()
}

/// The index arrives by reference so `cx.listener(|this, index: &usize, ..)`
/// builds one of these directly -- gpui's listeners take exactly one event
/// argument, and the index *is* the event here.
type SegmentHandler = Box<dyn Fn(&usize, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct SegmentedControl {
    id: ElementId,
    options: Vec<SegmentOption>,
    container_padding: Pixels,
    container_radius: Pixels,
    container_gap: Pixels,
    container_bg: Option<Hsla>,
    container_border: Option<Hsla>,
    item_padding_x: Pixels,
    item_padding_y: Pixels,
    item_height: Option<Pixels>,
    item_radius: Pixels,
    item_gap: Pixels,
    text_size: Pixels,
    font_weight: Option<FontWeight>,
    icon_size: Pixels,
    selected_bg: Option<Hsla>,
    selected_text: Hsla,
    idle_text: Hsla,
    idle_bg: Option<Hsla>,
    hover_bg: Option<Hsla>,
    selected_shadow: Vec<gpui::BoxShadow>,
    container_shadow: Vec<gpui::BoxShadow>,
    stretch: bool,
    tab_stops: bool,
    on_select: Option<SegmentHandler>,
}

impl SegmentedControl {
    fn base(theme: &Theme, id: impl Into<ElementId>, options: Vec<SegmentOption>) -> Self {
        Self {
            id: id.into(),
            options,
            container_padding: px(2.),
            container_radius: px(8.),
            container_gap: px(0.),
            container_bg: None,
            container_border: None,
            item_padding_x: px(12.),
            item_padding_y: px(4.),
            item_height: None,
            item_radius: px(6.),
            item_gap: px(6.),
            text_size: px(12.),
            font_weight: Some(FontWeight::MEDIUM),
            icon_size: px(14.),
            selected_bg: None,
            selected_text: theme.gray(12),
            idle_text: theme.gray(11),
            idle_bg: None,
            hover_bg: None,
            selected_shadow: Vec::new(),
            container_shadow: Vec::new(),
            stretch: false,
            tab_stops: false,
            on_select: None,
        }
    }

    pub fn settings(theme: &Theme, id: impl Into<ElementId>, options: Vec<SegmentOption>) -> Self {
        Self {
            container_bg: Some(theme.settings_fill()),
            container_border: None,
            container_radius: px(8.),
            item_padding_x: px(10.),
            item_padding_y: px(0.),
            item_height: Some(px(24.)),
            item_gap: px(4.),
            icon_size: px(11.),
            selected_bg: Some(if theme.is_dark() {
                gpui::hsla(0., 0., 1., 0.16)
            } else {
                gpui::white()
            }),
            selected_text: theme.settings_text(),
            idle_text: theme.settings_muted(),
            hover_bg: Some(theme.settings_hover()),
            selected_shadow: if theme.is_dark() {
                Vec::new()
            } else {
                crate::theme::raised_pill_shadow()
            },
            ..Self::base(theme, id, options)
        }
    }

    /// `ExportPage`'s loose pills: no container chrome, `flex gap-1.5`,
    /// selected `bg-gray-3 border-gray-5 text-gray-12`, idle transparent with
    /// `hover:bg-gray-3`.
    pub fn pills(theme: &Theme, id: impl Into<ElementId>, options: Vec<SegmentOption>) -> Self {
        Self {
            container_padding: px(0.),
            container_gap: px(6.),
            container_bg: None,
            container_border: None,
            item_radius: px(8.),
            selected_bg: Some(theme.gray(3)),
            hover_bg: Some(theme.gray(3)),
            idle_text: theme.gray(11),
            ..Self::base(theme, id, options)
        }
    }

    pub fn editor(theme: &Theme, id: impl Into<ElementId>, options: Vec<SegmentOption>) -> Self {
        let editor = theme.editor;
        Self {
            container_bg: Some(Hsla::from(editor.ctl)),
            container_radius: px(9.),
            container_shadow: editor.trough_ring(),
            item_radius: px(7.),
            item_padding_x: px(10.),
            item_padding_y: px(0.),
            item_height: Some(px(24.)),
            selected_bg: Some(editor.pill_fill()),
            selected_text: Hsla::from(editor.text_1),
            idle_text: Hsla::from(editor.text_2),
            hover_bg: Some(Hsla::from(editor.ctl_hover)),
            selected_shadow: editor.pill_shadow(),
            ..Self::base(theme, id, options)
        }
    }

    /// The text-align icon grid: `grid grid-cols-N gap-1 rounded-lg border
    /// border-gray-3 bg-gray-2 p-1`, selected `bg-gray-5 text-gray-12`.
    pub fn icons(theme: &Theme, id: impl Into<ElementId>, options: Vec<SegmentOption>) -> Self {
        Self {
            container_padding: px(4.),
            container_gap: px(4.),
            container_bg: Some(theme.gray(2)),
            container_border: Some(theme.gray(3)),
            item_padding_x: px(6.),
            item_padding_y: px(6.),
            selected_bg: Some(theme.gray(5)),
            stretch: true,
            ..Self::base(theme, id, options)
        }
    }

    pub fn stretch(mut self) -> Self {
        self.stretch = true;
        self
    }

    /// Makes every enabled segment a Tab stop that Enter and Space activate,
    /// for a control that is the only way to reach what it switches to.
    pub fn tab_stops(mut self) -> Self {
        self.tab_stops = true;
        self
    }

    pub fn text_size(mut self, size: Pixels) -> Self {
        self.text_size = size;
        self
    }

    pub fn item_height(mut self, height: Pixels) -> Self {
        self.item_height = Some(height);
        self
    }

    pub fn item_padding(mut self, x: Pixels, y: Pixels) -> Self {
        self.item_padding_x = x;
        self.item_padding_y = y;
        self
    }

    pub fn idle_bg(mut self, bg: Hsla) -> Self {
        self.idle_bg = Some(bg);
        self
    }

    pub fn on_select(mut self, handler: impl Fn(&usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for SegmentedControl {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let SegmentedControl {
            id,
            options,
            container_padding,
            container_radius,
            container_gap,
            container_bg,
            container_border,
            item_padding_x,
            item_padding_y,
            item_height,
            item_radius,
            item_gap,
            text_size,
            font_weight,
            icon_size,
            selected_bg,
            selected_text,
            idle_text,
            idle_bg,
            hover_bg,
            selected_shadow,
            container_shadow,
            stretch,
            tab_stops,
            on_select,
        } = self;

        let handler: Option<std::rc::Rc<SegmentHandler>> = on_select.map(std::rc::Rc::new);
        let prefix: SharedString = match &id {
            ElementId::Name(name) => name.clone(),
            other => SharedString::from(format!("{other:?}")),
        };

        let count = options.len();
        let selected_index = options.iter().position(|option| option.selected);
        let glide_state = (selected_bg.is_some() && count > 1).then(|| {
            let state = window.use_keyed_state(
                SharedString::from(format!("{prefix}-glide")),
                cx,
                |_, _| Glide::new(selected_index, count),
            );
            state.update(cx, |glide, _| glide.select(selected_index, count));
            state
        });
        let fractional = stretch && f32::from(container_gap) == 0.;
        let indicator = glide_state.as_ref().and_then(|state| {
            let glide = state.read(cx);
            let to = glide.current?;
            let from = glide.from.unwrap_or(to);
            let place = if fractional {
                let width = 1. / count as f32;
                Placement::Fraction {
                    from: from as f32 * width,
                    to: to as f32 * width,
                    width,
                }
            } else {
                let origin = glide.origin?;
                let start = glide.rects.get(from).copied().flatten()?;
                let end = glide.rects.get(to).copied().flatten()?;
                Placement::Measured {
                    from: (
                        f32::from(start.origin.x - origin.x),
                        f32::from(start.size.width),
                    ),
                    to: (
                        f32::from(end.origin.x - origin.x),
                        f32::from(end.size.width),
                    ),
                }
            };
            Some((place, glide.generation))
        });
        let glides = indicator.is_some();

        div()
            .id(id)
            .relative()
            .flex()
            .flex_row()
            .p(container_padding)
            .gap(container_gap)
            .rounded(container_radius)
            .when_some(container_bg, |this, bg| this.bg(bg))
            .when_some(container_border, |this, border| {
                this.border_1().border_color(border)
            })
            .when(!container_shadow.is_empty(), |this| {
                this.shadow(container_shadow)
            })
            .when_some(
                glide_state.clone().filter(|_| !fractional),
                |this, state| {
                    this.child(
                        canvas(
                            move |bounds, _, cx| {
                                state.update(cx, |glide, _| glide.origin = Some(bounds.origin));
                            },
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .inset_0(),
                    )
                },
            )
            .when_some(indicator, |this, (place, generation)| {
                let pill = div()
                    .absolute()
                    .top(container_padding)
                    .bottom(container_padding)
                    .rounded(item_radius)
                    .when_some(selected_bg, |pill, bg| pill.bg(bg))
                    .when(!selected_shadow.is_empty(), |pill| {
                        pill.shadow(selected_shadow.clone())
                    });
                let animation = Animation::new(Duration::from_millis(GLIDE_MS))
                    .with_easing(gpui::ease_out_quint());
                let id = SharedString::from(format!("{prefix}-glide-{generation}"));
                match place {
                    Placement::Fraction { from, to, width } => this.child(
                        div()
                            .absolute()
                            .top_0()
                            .bottom_0()
                            .left(container_padding)
                            .right(container_padding)
                            .child(pill.w(relative(width)).left(relative(to)).with_animation(
                                id,
                                animation,
                                move |pill, delta| pill.left(relative(from + (to - from) * delta)),
                            )),
                    ),
                    Placement::Measured { from, to } => {
                        this.child(pill.left(px(to.0)).w(px(to.1)).with_animation(
                            id,
                            animation,
                            move |pill, delta| {
                                pill.left(px(from.0 + (to.0 - from.0) * delta))
                                    .w(px(from.1 + (to.1 - from.1) * delta))
                            },
                        ))
                    }
                }
            })
            .children(options.into_iter().enumerate().map(|(index, option)| {
                let handler = handler.clone();
                let selected = option.selected;
                let disabled = option.disabled;
                let measure = glide_state.clone().filter(|_| !fractional);

                div()
                    .id(SharedString::from(format!("{prefix}-{index}")))
                    .relative()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .gap(item_gap)
                    .px(item_padding_x)
                    .when(f32::from(item_padding_y) > 0., |this| {
                        this.py(item_padding_y)
                    })
                    .when_some(item_height, |this, height| this.h(height))
                    .rounded(item_radius)
                    .text_size(text_size)
                    .when(stretch, |this| this.flex_1().min_w_0())
                    .when(tab_stops && !disabled, |this| {
                        crate::ui::keyboard_nav::ring(this.tab_index(0))
                    })
                    .when_some(font_weight, |this, weight| this.font_weight(weight))
                    .when(disabled, |this| this.opacity(0.5))
                    .when_some(measure, |this, state| {
                        this.child(
                            canvas(
                                move |bounds, _, cx| {
                                    state.update(cx, |glide, _| glide.measure(index, bounds));
                                },
                                |_, _, _, _| {},
                            )
                            .absolute()
                            .inset_0(),
                        )
                    })
                    .map(|this| {
                        if selected && glides {
                            this.text_color(selected_text)
                        } else if selected {
                            let this = this
                                .text_color(selected_text)
                                .when(!selected_shadow.is_empty(), |this| {
                                    this.shadow(selected_shadow.clone())
                                });
                            match selected_bg {
                                Some(bg) => this.bg(bg),
                                None => this,
                            }
                        } else {
                            let this = this.text_color(idle_text);
                            let this = match idle_bg {
                                Some(bg) => this.bg(bg),
                                None => this,
                            };
                            match hover_bg {
                                Some(bg) if !disabled => this.hover(move |style| style.bg(bg)),
                                _ => this,
                            }
                        }
                    })
                    .children(option.icon.map(|icon| {
                        svg()
                            .path(icon)
                            .size(icon_size)
                            .flex_shrink_0()
                            .text_color(if selected { selected_text } else { idle_text })
                    }))
                    .children(option.label.map(|label| {
                        if stretch {
                            div().min_w_0().truncate().child(label).into_any_element()
                        } else {
                            label.into_any_element()
                        }
                    }))
                    .when_some(handler.filter(|_| !disabled), |this, handler| {
                        this.on_click(move |_, window, cx| handler(&index, window, cx))
                    })
            }))
    }
}

const GLIDE_MS: u64 = 200;

#[derive(Clone, Copy)]
enum Placement {
    Fraction { from: f32, to: f32, width: f32 },
    Measured { from: (f32, f32), to: (f32, f32) },
}

struct Glide {
    current: Option<usize>,
    from: Option<usize>,
    generation: u64,
    origin: Option<Point<Pixels>>,
    rects: Vec<Option<Bounds<Pixels>>>,
}

impl Glide {
    fn new(selected: Option<usize>, count: usize) -> Self {
        Self {
            current: selected,
            from: selected,
            generation: 0,
            origin: None,
            rects: vec![None; count],
        }
    }

    fn select(&mut self, selected: Option<usize>, count: usize) {
        if self.rects.len() != count {
            self.rects = vec![None; count];
        }
        if self.current != selected {
            self.from = self.current.or(selected);
            self.current = selected;
            self.generation = self.generation.wrapping_add(1);
        }
    }

    fn measure(&mut self, index: usize, bounds: Bounds<Pixels>) {
        if let Some(slot) = self.rects.get_mut(index) {
            *slot = Some(bounds);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_pick_glides_from_the_old_one() {
        let mut glide = Glide::new(Some(0), 3);
        glide.select(Some(2), 3);
        assert_eq!(
            (glide.from, glide.current, glide.generation),
            (Some(0), Some(2), 1)
        );
        glide.select(Some(2), 3);
        assert_eq!(glide.generation, 1);
    }

    #[test]
    fn a_first_pick_appears_in_place() {
        let mut glide = Glide::new(None, 3);
        glide.select(Some(1), 3);
        assert_eq!((glide.from, glide.current), (Some(1), Some(1)));
    }

    #[test]
    fn a_changed_item_count_forgets_stale_rects() {
        let mut glide = Glide::new(Some(0), 2);
        glide.measure(1, Bounds::default());
        glide.select(Some(0), 4);
        assert_eq!(glide.rects, vec![None; 4]);
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Quality {
        Low,
        Medium,
        High,
    }

    #[test]
    fn a_click_index_maps_back_onto_its_value() {
        let all = [Quality::Low, Quality::Medium, Quality::High];
        assert_eq!(option_at(&all, 0), Some(Quality::Low));
        assert_eq!(option_at(&all, 2), Some(Quality::High));
    }

    /// The old per-window helper guarded this with `if let Some(value) =
    /// T::ALL.get(index)`; a stale index from a re-rendered control must be a
    /// no-op, never a panic.
    #[test]
    fn an_index_past_the_end_selects_nothing() {
        let all = [Quality::Low, Quality::Medium, Quality::High];
        assert_eq!(option_at(&all, 3), None);
        assert_eq!(option_at::<Quality>(&[], 0), None);
    }

    #[test]
    fn exactly_one_option_is_marked_selected_for_a_value() {
        let all = [Quality::Low, Quality::Medium, Quality::High];
        let current = Quality::Medium;
        let options: Vec<SegmentOption> = all
            .iter()
            .map(|value| SegmentOption::new(format!("{value:?}"), *value == current))
            .collect();
        assert_eq!(options.iter().filter(|option| option.selected).count(), 1);
        assert!(options[1].selected);
    }
}
