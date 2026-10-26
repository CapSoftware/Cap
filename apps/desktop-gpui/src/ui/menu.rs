//! The dropdown/select menu, with the Kobalte behaviour contract the Solid
//! app gets for free from `KSelect` / `KDropdownMenu`:
//!
//! - opens at an anchor, dismisses on click-away **and** on Escape,
//! - Arrow Down / Arrow Up move a highlight, wrapping at both ends,
//! - Home / End jump to the ends,
//! - Enter (or Space) commits the highlighted item,
//! - the currently-selected item carries a check mark.
//!
//! The state machine is a plain struct so it can be tested without a window;
//! [`Menu`] is the element that draws it.

use std::{cell::Cell, rc::Rc};

use gpui::{
    Anchor, App, Bounds, ClickEvent, ElementId, Hsla, InteractiveElement, IntoElement, MouseButton,
    MouseUpEvent, ParentElement, Pixels, Point, RenderOnce, ScrollHandle, SharedString, Size,
    StatefulInteractiveElement, Styled, TextStyle, WhiteSpace, Window, div, point,
    prelude::FluentBuilder, px, svg,
};

use crate::theme::Theme;

const MENU_ROW_HEIGHT: f32 = 24.;
const MENU_PADDING: f32 = 4.;
const MENU_BORDER: f32 = 1.;
const MENU_CHROME_HEIGHT: f32 = 2. * (MENU_PADDING + MENU_BORDER);

pub(crate) type OpenHandler = Box<dyn Fn(&Bounds<Pixels>, &mut Window, &mut App) + 'static>;

/// One row: a label and whether it is the value currently in force.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuItem {
    pub label: SharedString,
    pub checked: bool,
}

impl MenuItem {
    pub fn new(label: impl Into<SharedString>, checked: bool) -> Self {
        Self {
            label: label.into(),
            checked,
        }
    }
}

/// What a keystroke did to an open menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuKey {
    /// The highlight moved; repaint.
    Moved,
    /// Commit this index and close.
    Commit(usize),
    /// Close without committing.
    Dismiss,
    /// Not ours -- let it through.
    Ignored,
}

/// An open menu: where it is anchored, how many rows it has, and which one the
/// keyboard is on.
#[derive(Debug, Clone, PartialEq)]
pub struct MenuState {
    pub origin: Point<Pixels>,
    pub trigger_bounds: Option<Bounds<Pixels>>,
    pub len: usize,
    pub highlighted: Option<usize>,
    /// Whether the highlight is *drawn*. A menu opened by pointer shows the
    /// check mark and follows the mouse, exactly as a real `NSMenu` does; the
    /// keyboard highlight appears the moment an arrow key is used. Enter
    /// straight after opening still commits the current value, because
    /// `highlighted` is seeded either way.
    pub highlight_visible: bool,
}

impl MenuState {
    /// Kobalte opens a `Select` with the *selected* item highlighted, so the
    /// first Arrow Down steps off the current value rather than jumping to the
    /// top of the list.
    pub fn new(origin: Point<Pixels>, items: &[MenuItem]) -> Self {
        Self {
            origin,
            trigger_bounds: None,
            len: items.len(),
            highlighted: items.iter().position(|item| item.checked),
            highlight_visible: false,
        }
    }

    pub fn anchored(trigger_bounds: Bounds<Pixels>, items: &[MenuItem]) -> Self {
        Self {
            trigger_bounds: Some(trigger_bounds),
            ..Self::new(trigger_bounds.bottom_left(), items)
        }
    }

    /// The index to paint highlighted, if any.
    pub fn visible_highlight(&self) -> Option<usize> {
        self.highlighted.filter(|_| self.highlight_visible)
    }

    pub fn on_key(&mut self, key: &str) -> MenuKey {
        if self.len == 0 {
            return match key {
                "escape" => MenuKey::Dismiss,
                _ => MenuKey::Ignored,
            };
        }
        match key {
            "down" | "up" | "home" | "end" => {
                self.highlight_visible = true;
                self.move_highlight(key)
            }
            "enter" | "space" => match self.highlighted {
                Some(index) => MenuKey::Commit(index),
                None => MenuKey::Ignored,
            },
            "escape" => MenuKey::Dismiss,
            _ => MenuKey::Ignored,
        }
    }

    fn move_highlight(&mut self, key: &str) -> MenuKey {
        match key {
            "down" => {
                self.highlighted = Some(match self.highlighted {
                    Some(index) if index + 1 < self.len => index + 1,
                    Some(_) => 0,
                    None => 0,
                });
                MenuKey::Moved
            }
            "up" => {
                self.highlighted = Some(match self.highlighted {
                    Some(0) | None => self.len - 1,
                    Some(index) => index - 1,
                });
                MenuKey::Moved
            }
            "home" => {
                self.highlighted = Some(0);
                MenuKey::Moved
            }
            _ => {
                self.highlighted = Some(self.len - 1);
                MenuKey::Moved
            }
        }
    }
}

/// As with [`crate::ui::SegmentedControl`], the index arrives by reference so
/// `cx.listener` can build the handler directly.
type SelectHandler = Box<dyn Fn(&usize, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct Menu {
    id: ElementId,
    items: Vec<MenuItem>,
    origin: Point<Pixels>,
    trigger_bounds: Option<Bounds<Pixels>>,
    highlighted: Option<usize>,
    min_width: Pixels,
    max_height: Pixels,
    radius: Pixels,
    shadow: Vec<gpui::BoxShadow>,
    bg: Hsla,
    border: Hsla,
    hover: Hsla,
    text: Hsla,
    on_select: Option<SelectHandler>,
    on_dismiss: Option<crate::ui::button::ClickHandler>,
}

impl Menu {
    /// The settings window's stand-in for `Menu.popup()`: a menu-shaped panel
    /// at the pointer -- which is where `popup()` with no argument puts a real
    /// `NSMenu` -- with the same check marks and the same click-away dismiss.
    pub fn settings(
        theme: &Theme,
        id: impl Into<ElementId>,
        items: Vec<MenuItem>,
        state: &MenuState,
    ) -> Self {
        let bg = if theme.is_dark() {
            Hsla::from(gpui::rgb(0x2a2a2c))
        } else {
            gpui::white()
        };
        Self {
            id: id.into(),
            items,
            origin: state.origin,
            trigger_bounds: state.trigger_bounds,
            highlighted: state.visible_highlight(),
            min_width: px(180.),
            max_height: px(320.),
            radius: px(10.),
            shadow: vec![gpui::BoxShadow {
                color: gpui::hsla(0., 0., 0., 0.18),
                offset: gpui::point(px(0.), px(6.)),
                blur_radius: px(18.),
                spread_radius: px(0.),
                inset: false,
            }],
            bg,
            border: theme.settings_border(),
            hover: theme.settings_hover(),
            text: theme.settings_text(),
            on_select: None,
            on_dismiss: None,
        }
    }

    /// `PopperContent` on the plain palette: `rounded-xl border border-gray-3
    /// bg-gray-1 shadow-s`.
    pub fn plain(
        theme: &Theme,
        id: impl Into<ElementId>,
        items: Vec<MenuItem>,
        state: &MenuState,
    ) -> Self {
        Self {
            bg: theme.gray(1),
            border: theme.gray(3),
            hover: theme.gray(3),
            text: theme.gray(12),
            ..Self::settings(theme, id, items, state)
        }
    }

    /// The editor's popovers: an `ed-card` panel behind an `ed-line` hairline.
    pub fn editor(
        theme: &Theme,
        id: impl Into<ElementId>,
        items: Vec<MenuItem>,
        state: &MenuState,
    ) -> Self {
        Self {
            radius: px(12.),
            shadow: theme.editor.pop_shadow(),
            bg: Hsla::from(theme.editor.card),
            border: Hsla::from(theme.editor.line),
            hover: Hsla::from(theme.editor.ctl_hover),
            text: Hsla::from(theme.editor.text_1),
            ..Self::settings(theme, id, items, state)
        }
    }

    pub fn min_width(mut self, width: Pixels) -> Self {
        self.min_width = width;
        self
    }

    pub fn trigger(
        element: gpui::Stateful<gpui::Div>,
        handler: impl Fn(&Bounds<Pixels>, &mut Window, &mut App) + 'static,
    ) -> gpui::Stateful<gpui::Div> {
        let bounds = Rc::new(Cell::new(None));
        let measured_bounds = bounds.clone();
        element
            .tab_index(0)
            .relative()
            .on_click(move |_, window, cx| {
                if let Some(bounds) = bounds.get() {
                    handler(&bounds, window, cx);
                }
            })
            .child(
                gpui::canvas(
                    move |bounds, _, _| measured_bounds.set(Some(bounds)),
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
    }

    pub fn on_select(mut self, handler: impl Fn(&usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Box::new(handler));
        self
    }

    pub fn on_dismiss(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_dismiss = Some(Box::new(handler));
        self
    }
}

fn anchored_placement(
    trigger: Bounds<Pixels>,
    item_count: usize,
    max_height: Pixels,
    viewport: Size<Pixels>,
) -> (Point<Pixels>, Anchor, Pixels) {
    let gap = px(4.);
    let margin = px(12.);
    let below = (viewport.height - margin - trigger.bottom() - gap).max(px(0.));
    let above = (trigger.top() - gap - margin).max(px(0.));
    let height = px(item_count as f32 * MENU_ROW_HEIGHT + MENU_CHROME_HEIGHT).min(max_height);
    if height <= below || below >= above {
        (
            trigger.bottom_left() + point(px(0.), gap),
            Anchor::TopLeft,
            max_height.min(below),
        )
    } else {
        (
            trigger.origin - point(px(0.), gap),
            Anchor::BottomLeft,
            max_height.min(above),
        )
    }
}

// Offscreen labels still determine the menu's intrinsic width.
#[derive(Default)]
struct MenuLayoutState {
    scroll: ScrollHandle,
    pressed: Rc<Cell<bool>>,
    labels: Vec<SharedString>,
    style: Option<TextStyle>,
    widest: usize,
}

impl MenuLayoutState {
    fn widest(&mut self, items: &[MenuItem], style: TextStyle, window: &Window) -> usize {
        if self.style.as_ref() != Some(&style)
            || self.labels.len() != items.len()
            || self
                .labels
                .iter()
                .zip(items)
                .any(|(label, item)| label != &item.label)
        {
            let mut widest = 0;
            let mut width = px(0.);
            for (index, item) in items.iter().enumerate() {
                let runs = [style.to_run(item.label.len())];
                if let Ok(lines) = window.text_system().shape_text(
                    item.label.clone(),
                    px(12.),
                    &runs,
                    None,
                    style.line_clamp,
                ) {
                    for line in lines {
                        let line_width = line.size(px(MENU_ROW_HEIGHT)).width.ceil();
                        if line_width > width {
                            width = line_width;
                            widest = index;
                        }
                    }
                }
            }
            self.labels = items.iter().map(|item| item.label.clone()).collect();
            self.style = Some(style);
            self.widest = widest;
        }
        self.widest
    }
}

impl RenderOnce for Menu {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let Menu {
            id,
            items,
            origin,
            trigger_bounds,
            highlighted,
            min_width,
            max_height,
            radius,
            shadow,
            bg,
            border,
            hover,
            text,
            on_select,
            on_dismiss,
        } = self;

        let prefix: SharedString = match &id {
            ElementId::Name(name) => name.clone(),
            other => SharedString::from(format!("{other:?}")),
        };
        let handler: Option<std::rc::Rc<SelectHandler>> = on_select.map(std::rc::Rc::new);
        let viewport = window.viewport_size();
        let max_width = (viewport.width - px(24.)).max(px(0.));
        let max_height = max_height.min((viewport.height - px(24.)).max(px(0.)));
        let min_width = trigger_bounds.map_or(min_width, |bounds| min_width.max(bounds.size.width));
        let (origin, anchor, max_height) = trigger_bounds
            .map_or((origin, Anchor::TopLeft, max_height), |bounds| {
                anchored_placement(bounds, items.len(), max_height, viewport)
            });
        let mut style = window.text_style();
        style.font_size = px(12.).into();
        style.color = text;
        style.white_space = WhiteSpace::Nowrap;
        let line_height = window.pixel_snap(
            style
                .line_height
                .to_pixels(px(12.).into(), window.rem_size()),
        );
        // Tall labels can overlap adjacent rows, so row-box culling would hide visible text.
        let virtualized = !items.is_empty()
            && max_height > px(MENU_CHROME_HEIGHT)
            && px(items.len() as f32 * MENU_ROW_HEIGHT + MENU_CHROME_HEIGHT) > max_height
            && line_height > px(0.)
            && line_height <= px(MENU_ROW_HEIGHT)
            && items.iter().all(|item| !item.label.contains('\n'));
        let (widest, scroll, pressed) = window.with_element_namespace(id.clone(), |window| {
            window.with_global_id("menu-layout".into(), |global_id, window| {
                window.with_element_state(global_id, |state: Option<MenuLayoutState>, window| {
                    let mut state = state.unwrap_or_default();
                    // Keep GPUI's pending click state alive if a pressed row scrolls offscreen.
                    let widest = (virtualized && !state.pressed.get())
                        .then(|| state.widest(&items, style, window));
                    ((widest, state.scroll.clone(), state.pressed.clone()), state)
                })
            })
        });
        let row = move |row_prefix: &SharedString, index: usize, item: MenuItem| {
            let handler = handler.clone();
            div()
                .id(SharedString::from(format!("{row_prefix}-item-{index}")))
                .flex()
                .flex_row()
                .flex_shrink_0()
                .items_center()
                .gap(px(6.))
                .h(px(MENU_ROW_HEIGHT))
                .px(px(6.))
                .rounded(px(4.))
                .when(highlighted == Some(index), |this| this.bg(hover))
                .hover(move |style| style.bg(hover))
                .child(
                    div().w(px(12.)).flex_shrink_0().children(
                        item.checked
                            .then(|| svg().path("icons/check.svg").size(px(12.)).text_color(text)),
                    ),
                )
                .child(div().flex_1().min_w_0().truncate().child(item.label))
                .when_some(handler, |this, handler| {
                    this.on_click(move |_, window, cx| handler(&index, window, cx))
                })
        };
        let pressed_on_down = pressed.clone();
        let end_press = move |_: &MouseUpEvent, window: &mut Window, _: &mut App| {
            if pressed.replace(false) {
                window.refresh();
            }
        };
        let panel = div()
            .id(id.clone())
            .occlude()
            .flex()
            .flex_col()
            .min_w(min_width.min(max_width))
            .max_w(max_width)
            .max_h(max_height)
            .overflow_y_scroll()
            .track_scroll(&scroll)
            .on_mouse_down(MouseButton::Left, move |_, window, _| {
                pressed_on_down.set(true);
                window.refresh();
            })
            .on_mouse_up(MouseButton::Left, end_press.clone())
            .on_mouse_up_out(MouseButton::Left, end_press)
            .p(px(MENU_PADDING))
            .rounded(radius)
            .shadow(shadow)
            .border(px(MENU_BORDER))
            .border_color(border)
            .bg(bg)
            .text_color(text)
            .text_size(px(12.));
        let panel = if let Some(widest) = widest {
            let scroll_top = (-scroll.offset().y).clamp(
                px(0.),
                (px(items.len() as f32 * MENU_ROW_HEIGHT) - (max_height - px(MENU_CHROME_HEIGHT)))
                    .max(px(0.)),
            );
            let start =
                ((f32::from(scroll_top) / MENU_ROW_HEIGHT).floor() as usize).saturating_sub(1);
            let end = ((f32::from(scroll_top + max_height) / MENU_ROW_HEIGHT).ceil() as usize)
                .saturating_add(1)
                .min(items.len());
            let width_prefix: SharedString = format!("{prefix}-width-row").into();
            panel
                .child(
                    div()
                        .id(SharedString::from(format!("{prefix}-intrinsic")))
                        .h(px(0.))
                        .flex_shrink_0()
                        .overflow_hidden()
                        .child(row(&width_prefix, widest, items[widest].clone())),
                )
                .child(div().h(px(start as f32 * MENU_ROW_HEIGHT)).flex_shrink_0())
                .children((start..end).map(|index| row(&prefix, index, items[index].clone())))
                .child(
                    div()
                        .h(px((items.len() - end) as f32 * MENU_ROW_HEIGHT))
                        .flex_shrink_0(),
                )
        } else {
            panel.children(
                items
                    .into_iter()
                    .enumerate()
                    .map(|(index, item)| row(&prefix, index, item)),
            )
        };

        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .child(
                div()
                    .id(SharedString::from(format!("{prefix}-backdrop")))
                    .occlude()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .when_some(on_dismiss, |this, handler| {
                        this.on_click(move |event, window, cx| handler(event, window, cx))
                    }),
            )
            .child(
                gpui::anchored()
                    .position(origin)
                    .anchor(anchor)
                    .snap_to_window_with_margin(px(12.))
                    .child(panel),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::point;

    fn items(checked: Option<usize>) -> Vec<MenuItem> {
        (0..4)
            .map(|index| MenuItem::new(format!("item {index}"), checked == Some(index)))
            .collect()
    }

    fn state(checked: Option<usize>) -> MenuState {
        MenuState::new(point(px(0.), px(0.)), &items(checked))
    }

    #[test]
    fn a_select_menu_uses_the_trigger_bounds_and_current_value() {
        let bounds = Bounds::new(point(px(100.), px(80.)), gpui::size(px(160.), px(36.)));
        let menu = MenuState::anchored(bounds, &items(Some(2)));
        assert_eq!(menu.trigger_bounds, Some(bounds));
        assert_eq!(menu.origin, bounds.bottom_left());
        assert_eq!(menu.highlighted, Some(2));
    }

    #[test]
    fn a_select_menu_opens_below_the_button_when_it_fits() {
        let bounds = Bounds::new(point(px(100.), px(80.)), gpui::size(px(160.), px(36.)));
        let (origin, anchor, height) =
            anchored_placement(bounds, 4, px(320.), gpui::size(px(800.), px(600.)));
        assert_eq!(origin, point(px(100.), px(120.)));
        assert_eq!(anchor, Anchor::TopLeft);
        assert_eq!(height, px(320.));
    }

    #[test]
    fn a_select_menu_flips_above_a_button_near_the_bottom() {
        let bounds = Bounds::new(point(px(100.), px(540.)), gpui::size(px(160.), px(36.)));
        let (origin, anchor, height) =
            anchored_placement(bounds, 4, px(320.), gpui::size(px(800.), px(600.)));
        assert_eq!(origin, point(px(100.), px(536.)));
        assert_eq!(anchor, Anchor::BottomLeft);
        assert_eq!(height, px(320.));
    }

    #[test]
    fn a_long_select_menu_is_limited_to_the_larger_side_of_the_button() {
        let bounds = Bounds::new(point(px(100.), px(220.)), gpui::size(px(160.), px(36.)));
        let (origin, anchor, height) =
            anchored_placement(bounds, 40, px(320.), gpui::size(px(800.), px(420.)));
        assert_eq!(origin, point(px(100.), px(216.)));
        assert_eq!(anchor, Anchor::BottomLeft);
        assert_eq!(height, px(204.));
    }

    #[test]
    fn a_menu_opens_on_the_value_it_currently_holds() {
        assert_eq!(state(Some(2)).highlighted, Some(2));
        assert_eq!(state(None).highlighted, None);
    }

    /// A menu opened by pointer paints no highlight -- the check mark is what
    /// marks the current value, as in a real `NSMenu`. The first arrow key
    /// turns the highlight on.
    #[test]
    fn the_highlight_is_not_painted_until_the_keyboard_is_used() {
        let mut menu = state(Some(2));
        assert_eq!(menu.visible_highlight(), None);
        menu.on_key("down");
        assert_eq!(menu.visible_highlight(), Some(3));
    }

    /// ...but Enter straight after opening still commits the current value,
    /// because the seed is there whether or not it is drawn.
    #[test]
    fn enter_before_any_arrow_commits_the_current_value() {
        let mut menu = state(Some(2));
        assert_eq!(menu.on_key("enter"), MenuKey::Commit(2));
    }

    #[test]
    fn arrows_walk_the_list_and_wrap_at_both_ends() {
        let mut menu = state(None);
        assert_eq!(menu.on_key("down"), MenuKey::Moved);
        assert_eq!(menu.highlighted, Some(0));
        for expected in [1, 2, 3] {
            menu.on_key("down");
            assert_eq!(menu.highlighted, Some(expected));
        }
        menu.on_key("down");
        assert_eq!(menu.highlighted, Some(0), "past the end wraps to the top");
        menu.on_key("up");
        assert_eq!(
            menu.highlighted,
            Some(3),
            "before the start wraps to the end"
        );
    }

    #[test]
    fn an_unopened_highlight_takes_the_end_on_arrow_up() {
        let mut menu = state(None);
        assert_eq!(menu.on_key("up"), MenuKey::Moved);
        assert_eq!(menu.highlighted, Some(3));
    }

    #[test]
    fn home_and_end_jump() {
        let mut menu = state(Some(1));
        menu.on_key("end");
        assert_eq!(menu.highlighted, Some(3));
        menu.on_key("home");
        assert_eq!(menu.highlighted, Some(0));
    }

    #[test]
    fn enter_commits_the_highlighted_row_and_escape_dismisses() {
        let mut menu = state(Some(2));
        assert_eq!(menu.on_key("enter"), MenuKey::Commit(2));
        assert_eq!(menu.on_key("escape"), MenuKey::Dismiss);
    }

    #[test]
    fn enter_with_nothing_highlighted_commits_nothing() {
        let mut menu = state(None);
        assert_eq!(menu.on_key("enter"), MenuKey::Ignored);
    }

    #[test]
    fn an_empty_menu_still_dismisses_but_never_commits() {
        let mut menu = MenuState::new(point(px(0.), px(0.)), &[]);
        assert_eq!(menu.on_key("down"), MenuKey::Ignored);
        assert_eq!(menu.on_key("enter"), MenuKey::Ignored);
        assert_eq!(menu.on_key("escape"), MenuKey::Dismiss);
    }

    #[test]
    fn keys_the_menu_does_not_own_pass_through() {
        let mut menu = state(Some(0));
        assert_eq!(menu.on_key("a"), MenuKey::Ignored);
        assert_eq!(menu.on_key("tab"), MenuKey::Ignored);
        assert_eq!(menu.highlighted, Some(0));
    }
}

#[cfg(test)]
mod virtual_menu_tests {
    use super::*;
    use gpui::{
        AvailableSpace, FontFallbacks, FontFeatures, FontStyle, FontWeight, Modifiers, ScrollDelta,
        ScrollWheelEvent, TestAppContext, TouchPhase, VisualTestContext, WindowHandle, size,
    };

    fn row_width(item: &MenuItem, style: &TextStyle, window: &mut Window, cx: &mut App) -> Pixels {
        let mut label = div()
            .flex_1()
            .min_w_0()
            .truncate()
            .child(item.label.clone());
        label.text_style().line_clamp = style.line_clamp;
        let mut row = div()
            .flex()
            .flex_row()
            .flex_shrink_0()
            .items_center()
            .gap(px(6.))
            .h(px(24.))
            .px(px(6.))
            .font(style.font())
            .line_height(style.line_height)
            .text_size(px(12.))
            .text_color(style.color)
            .child(div().w(px(12.)).flex_shrink_0())
            .child(label)
            .into_any_element();
        row.layout_as_root(
            size(AvailableSpace::MaxContent, AvailableSpace::MinContent),
            window,
            cx,
        )
        .width
    }

    #[gpui::test]
    fn menu_width_uses_the_widest_actual_row(cx: &mut TestAppContext) {
        let window = cx.open_window(size(px(800.), px(600.)), |_, _| gpui::Empty);
        let mut visual = VisualTestContext::from_window(window.into(), cx);
        visual.draw(
            point(px(0.), px(0.)),
            size(AvailableSpace::MaxContent, AvailableSpace::MaxContent),
            |window, cx| {
                let items = [
                    "",
                    "Small",
                    "Device\tTab\tName",
                    "日本語のフォント",
                    "اسم جهاز בעברית",
                    "e\u{301} and ligatures ffi",
                    "short\nA much wider second line of the label",
                ]
                .into_iter()
                .map(|label| MenuItem::new(label, false))
                .collect::<Vec<_>>();
                let mut cache = MenuLayoutState::default();
                for line_clamp in [None, Some(1), Some(2)] {
                    let style = TextStyle {
                        font_family: "Menu test family".into(),
                        font_features: FontFeatures::disable_ligatures(),
                        font_fallbacks: Some(FontFallbacks::from_fonts(vec![
                            "CJK fallback".into(),
                            "RTL fallback".into(),
                        ])),
                        font_weight: FontWeight::BOLD,
                        font_style: FontStyle::Italic,
                        font_size: px(12.).into(),
                        white_space: WhiteSpace::Nowrap,
                        line_clamp,
                        ..TextStyle::default()
                    };
                    let widest = cache.widest(&items, style.clone(), window);
                    let widths = items
                        .iter()
                        .map(|item| row_width(item, &style, window, cx))
                        .collect::<Vec<_>>();
                    assert_eq!(widths[widest], widths.iter().copied().max().unwrap());
                }
                div()
            },
        );
    }

    #[derive(Default)]
    struct HeldClickMenu {
        selected: Option<usize>,
    }

    impl gpui::Render for HeldClickMenu {
        fn render(&mut self, _: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
            let items = (0..200)
                .map(|index| MenuItem::new(format!("Choice {index}"), false))
                .collect::<Vec<_>>();
            let state = MenuState::new(point(px(100.), px(100.)), &items);
            div().size_full().relative().child(
                Menu::editor(&Theme::light(), "held-click-menu", items, &state).on_select(
                    cx.listener(|this, index, _, cx| {
                        this.selected = Some(*index);
                        cx.notify();
                    }),
                ),
            )
        }
    }

    fn draw_held_menu(cx: &mut TestAppContext, window: WindowHandle<HeldClickMenu>) {
        VisualTestContext::from_window(window.into(), cx).update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
    }

    fn scroll_held_menu(
        cx: &mut TestAppContext,
        window: WindowHandle<HeldClickMenu>,
        position: Point<Pixels>,
        delta: f32,
    ) {
        VisualTestContext::from_window(window.into(), cx).simulate_event(ScrollWheelEvent {
            position,
            delta: ScrollDelta::Pixels(point(px(0.), px(delta))),
            modifiers: Modifiers::none(),
            touch_phase: TouchPhase::Moved,
        });
        for _ in 0..3 {
            draw_held_menu(cx, window);
        }
    }

    #[gpui::test]
    fn a_menu_click_survives_scrolling_away_and_back_while_held(cx: &mut TestAppContext) {
        let window = cx.open_window(size(px(1000.), px(700.)), |_, _| HeldClickMenu::default());
        let fourth_row_center = point(px(140.), px(189.));
        draw_held_menu(cx, window);
        {
            let mut visual = VisualTestContext::from_window(window.into(), cx);
            visual.simulate_mouse_move(fourth_row_center, None, Modifiers::none());
            visual.simulate_mouse_down(fourth_row_center, MouseButton::Left, Modifiers::none());
        }
        draw_held_menu(cx, window);
        scroll_held_menu(cx, window, fourth_row_center, -100_000.);
        scroll_held_menu(cx, window, fourth_row_center, 100_000.);
        assert_eq!(window.read_with(cx, |menu, _| menu.selected).unwrap(), None);
        VisualTestContext::from_window(window.into(), cx).simulate_mouse_up(
            fourth_row_center,
            MouseButton::Left,
            Modifiers::none(),
        );
        assert_eq!(
            window.read_with(cx, |menu, _| menu.selected).unwrap(),
            Some(3)
        );
    }

    #[gpui::test]
    fn releasing_a_held_menu_click_outside_cancels_it_without_breaking_the_next_click(
        cx: &mut TestAppContext,
    ) {
        let window = cx.open_window(size(px(1000.), px(700.)), |_, _| HeldClickMenu::default());
        let fourth_row_center = point(px(140.), px(189.));
        draw_held_menu(cx, window);
        {
            let mut visual = VisualTestContext::from_window(window.into(), cx);
            visual.simulate_mouse_move(fourth_row_center, None, Modifiers::none());
            visual.simulate_mouse_down(fourth_row_center, MouseButton::Left, Modifiers::none());
        }
        draw_held_menu(cx, window);
        scroll_held_menu(cx, window, fourth_row_center, -100_000.);
        VisualTestContext::from_window(window.into(), cx).simulate_mouse_up(
            point(px(20.), px(20.)),
            MouseButton::Left,
            Modifiers::none(),
        );
        draw_held_menu(cx, window);
        assert_eq!(window.read_with(cx, |menu, _| menu.selected).unwrap(), None);
        VisualTestContext::from_window(window.into(), cx).simulate_mouse_move(
            fourth_row_center,
            None,
            Modifiers::none(),
        );
        scroll_held_menu(cx, window, fourth_row_center, 100_000.);
        VisualTestContext::from_window(window.into(), cx)
            .simulate_click(fourth_row_center, Modifiers::none());
        assert_eq!(
            window.read_with(cx, |menu, _| menu.selected).unwrap(),
            Some(3)
        );
    }
}
