use cap_project::{
    AnimatedGradientCatalog, AnimatedGradientConfig, AnimatedGradientControl,
    AnimatedGradientLibrary, AnimatedGradientPreset, AnimatedGradientStop,
    animated_gradient_catalog,
};
use gpui::{AppContext as _, MouseButton};

use super::*;
use crate::theme::Theme;

const STORE_SECTION: &str = "animated_gradients";
const MAX_STOPS: usize = 5;
const MIN_STOPS: usize = 2;
const MAX_SAVED: usize = 100;
const STOP_INPUT_IDS: [&str; MAX_STOPS] = [
    "animated-gradient-stop-0",
    "animated-gradient-stop-1",
    "animated-gradient-stop-2",
    "animated-gradient-stop-3",
    "animated-gradient-stop-4",
];
const SWATCH_COLUMNS: usize = 7;
const SWATCH_GAP: f32 = 8.;
const BAR_HEIGHT: f32 = 40.;
const HANDLE_SIZE: f32 = 20.;
const SELECTED_HANDLE_SIZE: f32 = 24.;

#[derive(Clone)]
struct PendingSelection {
    last_used: Option<AnimatedGradientConfig>,
    selected: bool,
}

impl PendingSelection {
    fn merge(self, previous: Option<&Self>) -> Self {
        Self {
            selected: self.selected,
            last_used: self
                .last_used
                .or_else(|| previous.and_then(|pending| pending.last_used.clone())),
        }
    }
}

fn pending_selection(
    source: &BackgroundSource,
    previous: Option<AnimatedGradientConfig>,
    source_tab: SourceTab,
) -> PendingSelection {
    let current = match source {
        BackgroundSource::AnimatedGradient { config } => Some(config.normalized()),
        _ => None,
    };
    PendingSelection {
        selected: current.is_some() && source_tab != SourceTab::None,
        last_used: current.or_else(|| previous.map(|config| config.normalized())),
    }
}

pub(super) struct AnimatedGradientState {
    pub(super) library: AnimatedGradientLibrary,
    catalog: AnimatedGradientCatalog,
    pending: Option<PendingSelection>,
    save_task: Option<gpui::Task<()>>,
    name_input: Option<gpui::Entity<ui::TextInputState>>,
    error: Option<String>,
    persistence_failed: bool,
    selected_stop: usize,
    save_open: bool,
    fine_tune_open: CollapsibleState,
    fine_tune_group: usize,
}

impl AnimatedGradientState {
    pub(super) fn new() -> Self {
        Self {
            library: read_library(),
            catalog: animated_gradient_catalog(),
            pending: None,
            save_task: None,
            name_input: None,
            error: None,
            persistence_failed: false,
            selected_stop: 0,
            save_open: false,
            fine_tune_open: CollapsibleState::new(false),
            fine_tune_group: 0,
        }
    }

    fn flush_selection(&mut self) {
        let Some(pending) = self.pending.as_ref() else {
            return;
        };
        let config_saved = pending
            .last_used
            .as_ref()
            .is_none_or(|config| write_setting("lastUsed", config));
        let selection_saved = write_setting("selected", &pending.selected);
        if config_saved && selection_saved {
            self.pending = None;
            self.persistence_failed = false;
        } else {
            self.persistence_failed = true;
            tracing::warn!("failed to remember animated gradient selection");
        }
    }
}

fn control_groups(catalog: &AnimatedGradientCatalog) -> Vec<(&str, Vec<&AnimatedGradientControl>)> {
    let mut groups: Vec<(&str, Vec<&AnimatedGradientControl>)> = Vec::new();
    for control in &catalog.controls {
        if control.key == AnimatedGradientParameter::MotionSpeed {
            continue;
        }
        match groups.iter_mut().find(|(name, _)| *name == control.group) {
            Some((_, controls)) => controls.push(control),
            None => groups.push((&control.group, vec![control])),
        }
    }
    groups
}

impl Drop for AnimatedGradientState {
    fn drop(&mut self) {
        self.flush_selection();
    }
}

fn read_library() -> AnimatedGradientLibrary {
    serde_json::from_value(serde_json::Value::Object(crate::store::store_section(
        STORE_SECTION,
    )))
    .unwrap_or_default()
}

fn write_setting(key: &str, value: &impl serde::Serialize) -> bool {
    match serde_json::to_value(value) {
        Ok(value) => crate::store::set_store_setting(STORE_SECTION, key, value),
        Err(error) => {
            tracing::warn!("serializing animated gradient setting failed: {error}");
            false
        }
    }
}

fn stop_limits(config: &AnimatedGradientConfig, index: usize) -> (f32, f32) {
    let min = index
        .checked_sub(1)
        .and_then(|previous| config.color_stops.get(previous))
        .map_or(0., |stop| stop.position)
        .clamp(0., 100.);
    let max = config
        .color_stops
        .get(index + 1)
        .map_or(100., |stop| stop.position)
        .clamp(min, 100.);
    (min, max)
}

fn color_at(stops: &[AnimatedGradientStop], position: f32) -> Color {
    let (Some(first), Some(last)) = (stops.first(), stops.last()) else {
        return [128, 128, 128];
    };
    if position <= first.position {
        return first.color;
    }
    if position >= last.position {
        return last.color;
    }
    for pair in stops.windows(2) {
        if position < pair[0].position || position > pair[1].position {
            continue;
        }
        let span = pair[1].position - pair[0].position;
        let t = if span <= 0. {
            0.
        } else {
            (position - pair[0].position) / span
        };
        return std::array::from_fn(|channel| {
            let left = f32::from(pair[0].color[channel].min(255));
            let right = f32::from(pair[1].color[channel].min(255));
            (left + (right - left) * t).round() as u16
        });
    }
    last.color
}

fn insert_stop(config: &mut AnimatedGradientConfig, position: f32) -> Option<usize> {
    if config.color_stops.len() >= MAX_STOPS {
        return None;
    }
    let position = position.clamp(0., 100.).round();
    let stop = AnimatedGradientStop {
        color: color_at(&config.color_stops, position),
        position,
    };
    let index = config
        .color_stops
        .iter()
        .position(|existing| existing.position > position)
        .unwrap_or(config.color_stops.len());
    config.color_stops.insert(index, stop);
    Some(index)
}

fn largest_gap_position(config: &AnimatedGradientConfig) -> f32 {
    config
        .color_stops
        .windows(2)
        .max_by(|a, b| (a[1].position - a[0].position).total_cmp(&(b[1].position - b[0].position)))
        .map_or(50., |pair| {
            ((pair[0].position + pair[1].position) / 2.).round()
        })
}

fn add_stop(config: &mut AnimatedGradientConfig) -> Option<usize> {
    insert_stop(config, largest_gap_position(config))
}

fn remove_stop(config: &mut AnimatedGradientConfig, index: usize) -> bool {
    if config.color_stops.len() <= MIN_STOPS || index >= config.color_stops.len() {
        return false;
    }
    config.color_stops.remove(index);
    true
}

fn slider_unit(key: AnimatedGradientParameter) -> &'static str {
    match key {
        AnimatedGradientParameter::Direction => "deg",
        AnimatedGradientParameter::FlowScale | AnimatedGradientParameter::GrainSize => "",
        _ => "int",
    }
}

fn format_control_value(control: &AnimatedGradientControl, value: f32) -> String {
    match control.key {
        AnimatedGradientParameter::Direction => format!("{}\u{b0}", value.round() as i32),
        AnimatedGradientParameter::MotionSpeed if value == 0. => "Still".into(),
        _ if control.step < 1. => format!("{value:.1}"),
        _ => format!("{}", value.round() as i32),
    }
}

enum Band {
    Solid(Color),
    Blend(Color, Color),
}

fn palette(config: &AnimatedGradientConfig, radius: Pixels) -> gpui::Div {
    let stops = &config.color_stops;
    let mut bands = Vec::new();
    if let Some(first) = stops.first()
        && first.position > 0.
    {
        bands.push((first.position / 100., Band::Solid(first.color)));
    }
    for pair in stops.windows(2) {
        let width = (pair[1].position - pair[0].position).max(0.) / 100.;
        bands.push((width, Band::Blend(pair[0].color, pair[1].color)));
    }
    if let Some(last) = stops.last()
        && last.position < 100.
    {
        bands.push(((100. - last.position) / 100., Band::Solid(last.color)));
    }
    let count = bands.len();
    div()
        .flex()
        .w_full()
        .h_full()
        .children(bands.into_iter().enumerate().map(|(index, (width, band))| {
            let band_div = div().h_full().w(gpui::relative(width));
            let band_div = match band {
                Band::Solid(color) => band_div.bg(color_to_hsla(color)),
                Band::Blend(from, to) => band_div.bg(linear_gradient(
                    90.,
                    linear_color_stop(color_to_hsla(from), 0.),
                    linear_color_stop(color_to_hsla(to), 1.),
                )),
            };
            band_div
                .when(index == 0, |this| this.rounded_l(radius))
                .when(index + 1 == count, |this| this.rounded_r(radius))
        }))
}

fn swatch_cell() -> f32 {
    ((CONTENT_WIDTH - SWATCH_GAP * (SWATCH_COLUMNS as f32 - 1.)) / SWATCH_COLUMNS as f32).floor()
}

fn swatch_rows(items: Vec<AnyElement>) -> gpui::Div {
    let mut rows = Vec::new();
    let mut items = items.into_iter().peekable();
    while items.peek().is_some() {
        let row = items.by_ref().take(SWATCH_COLUMNS).collect::<Vec<_>>();
        rows.push(div().flex().flex_row().gap(px(SWATCH_GAP)).children(row));
    }
    div().flex().flex_col().gap(px(SWATCH_GAP)).children(rows)
}

fn header_button(
    theme: &Theme,
    id: &'static str,
    icon: &'static str,
    label: &'static str,
    tooltip: &'static str,
    disabled: bool,
    pressed: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> gpui::Stateful<gpui::Div> {
    let theme = *theme;
    let foreground = Hsla::from(if pressed {
        theme.gray_12
    } else {
        theme.gray_11
    });
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(px(4.))
        .h(px(28.))
        .px(px(8.))
        .rounded(px(6.))
        .text_size(px(12.))
        .text_color(foreground)
        .when(pressed, |this| this.bg(Hsla::from(theme.gray_3)))
        .when(disabled, |this| this.opacity(0.4))
        .when(!disabled, |this| {
            this.cursor_pointer()
                .hover(|this| {
                    this.bg(Hsla::from(theme.gray_3))
                        .text_color(Hsla::from(theme.gray_12))
                })
                .on_click(on_click)
        })
        .tooltip(move |_window, cx| ui::Tooltip::new(&theme, tooltip).view(cx))
        .child(
            svg()
                .path(icon)
                .size(px(14.))
                .flex_shrink_0()
                .text_color(foreground),
        )
        .child(label)
}

fn icon_button(
    theme: &Theme,
    id: impl Into<SharedString>,
    icon: &'static str,
    tooltip: &'static str,
    disabled: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> gpui::Stateful<gpui::Div> {
    let theme = *theme;
    div()
        .id(id.into())
        .flex()
        .items_center()
        .justify_center()
        .size(px(26.))
        .rounded(px(6.))
        .text_color(Hsla::from(theme.gray_10))
        .when(disabled, |this| this.opacity(0.3))
        .when(!disabled, |this| {
            this.cursor_pointer()
                .hover(|this| {
                    this.bg(Hsla::from(theme.gray_3))
                        .text_color(Hsla::from(theme.gray_12))
                })
                .on_click(on_click)
        })
        .tooltip(move |_window, cx| ui::Tooltip::new(&theme, tooltip).view(cx))
        .child(
            svg()
                .path(icon)
                .size(px(14.))
                .text_color(Hsla::from(theme.gray_10)),
        )
}

impl EditorWindow {
    pub(crate) fn animated_gradient_config(&self) -> Option<&AnimatedGradientConfig> {
        match &self.project.background.source {
            BackgroundSource::AnimatedGradient { config } => Some(config),
            _ => None,
        }
    }

    pub(crate) fn remember_animated_gradient_selection(
        &mut self,
        previous: Option<AnimatedGradientConfig>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let selection = pending_selection(
            &self.project.background.source,
            previous,
            self.sidebar.source_tab,
        );
        let state = &mut self.sidebar.animated_gradient;
        let selection = selection.merge(state.pending.as_ref());
        state.library.selected = selection.selected;
        if let Some(config) = &selection.last_used {
            state.library.last_used = Some(config.clone());
        }
        state.pending = Some(selection);
        state.save_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(350))
                .await;
            this.update(cx, |this, cx| {
                this.sidebar.animated_gradient.flush_selection();
                cx.notify();
            })
            .ok();
        }));
    }

    pub(crate) fn flush_animated_gradient_selection(&mut self) {
        self.sidebar.animated_gradient.flush_selection();
    }

    pub(crate) fn refresh_animated_gradient_library(&mut self) {
        self.flush_animated_gradient_selection();
        if !self.sidebar.animated_gradient.persistence_failed {
            self.sidebar.animated_gradient.library = read_library();
        }
    }

    pub(crate) fn prepare_animated_gradient_fields(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.sidebar.source_tab != SourceTab::AnimatedGradient {
            return;
        }
        let count = self
            .animated_gradient_config()
            .map_or(0, |config| config.color_stops.len());
        for index in 0..count.min(MAX_STOPS) {
            self.ensure_hex_input(ColorTarget::AnimatedGradientStop(index), window, cx);
        }
        if self.sidebar.animated_gradient.name_input.is_some() {
            return;
        }
        let input = cx.new(|cx| {
            let mut input = ui::TextInputState::single_line(window, cx);
            input.set_placeholder("Name this gradient");
            input
        });
        self.push_text_subscription(cx.subscribe_in(
            &input,
            window,
            |this: &mut Self, _, event: &ui::TextInputEvent, window, cx| match event {
                ui::TextInputEvent::Confirmed => {
                    this.save_animated_gradient_preset(cx);
                    this.focus_root(window, cx);
                }
                ui::TextInputEvent::Cancelled => {
                    this.close_animated_gradient_save(cx);
                    this.focus_root(window, cx);
                }
                ui::TextInputEvent::Changed => cx.notify(),
                ui::TextInputEvent::Blurred => {}
            },
        ));
        self.sidebar.animated_gradient.name_input = Some(input);
    }

    pub(super) fn select_animated_gradient(
        &mut self,
        config: AnimatedGradientConfig,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.refresh_animated_gradient_library();
        self.close_color_picker(cx);
        self.sidebar.source_tab = SourceTab::AnimatedGradient;
        self.edit_background(
            "animated-gradient",
            move |project| {
                project.background.source = BackgroundSource::AnimatedGradient {
                    config: config.normalized(),
                };
                true
            },
            window,
            cx,
        );
    }

    fn edit_animated_gradient(
        &mut self,
        change: impl FnOnce(&mut AnimatedGradientConfig) -> bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_background(
            "animated-gradient-setting",
            |project| match &mut project.background.source {
                BackgroundSource::AnimatedGradient { config } => change(config),
                _ => false,
            },
            window,
            cx,
        );
    }

    pub(super) fn apply_animated_gradient_parameter(
        &mut self,
        parameter: AnimatedGradientParameter,
        value: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_animated_gradient(
            |config| {
                let previous = parameter.get(config);
                parameter.set(config, value);
                parameter.get(config) != previous
            },
            window,
            cx,
        );
    }

    pub(super) fn apply_animated_gradient_stop_position(
        &mut self,
        index: usize,
        value: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_animated_gradient(
            |config| {
                let (min, max) = stop_limits(config, index);
                let Some(stop) = config.color_stops.get_mut(index) else {
                    return false;
                };
                let position = value.round().clamp(min, max);
                if stop.position == position {
                    return false;
                }
                stop.position = position;
                true
            },
            window,
            cx,
        );
    }

    fn selected_animated_gradient_stop(&self) -> usize {
        let count = self
            .animated_gradient_config()
            .map_or(0, |config| config.color_stops.len());
        self.sidebar
            .animated_gradient
            .selected_stop
            .min(count.saturating_sub(1))
    }

    fn begin_animated_gradient_stop_drag(&mut self, index: usize, cx: &mut Context<Self>) {
        self.close_color_picker(cx);
        self.sidebar.animated_gradient.selected_stop = index;
        let history = &mut self.history;
        self.sidebar
            .slider_drag
            .begin(SliderKey::AnimatedGradientStop(index), || history.pause());
        cx.notify();
    }

    fn add_animated_gradient_stop_at(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(bounds) = self
            .sidebar
            .track_bounds(SliderKey::AnimatedGradientStop(0))
        else {
            return;
        };
        let Some(fraction) = ui::fraction_from_x(event.position.x, bounds) else {
            return;
        };
        self.close_color_picker(cx);
        let Some(mut updated) = self.animated_gradient_config().cloned() else {
            return;
        };
        let Some(index) = insert_stop(&mut updated, fraction * 100.) else {
            return;
        };
        self.begin_animated_gradient_stop_drag(index, cx);
        self.edit_animated_gradient(
            |config| {
                *config = updated;
                true
            },
            window,
            cx,
        );
    }

    fn add_animated_gradient_stop(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut inserted = None;
        self.close_color_picker(cx);
        self.edit_animated_gradient(
            |config| {
                inserted = add_stop(config);
                inserted.is_some()
            },
            window,
            cx,
        );
        if let Some(index) = inserted {
            self.sidebar.animated_gradient.selected_stop = index;
            cx.notify();
        }
    }

    fn remove_animated_gradient_stop(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_color_picker(cx);
        self.edit_animated_gradient(|config| remove_stop(config, index), window, cx);
        self.sidebar.animated_gradient.selected_stop = index.saturating_sub(1);
        cx.notify();
    }

    fn reset_animated_gradient_fine_tune(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let defaults = self
            .sidebar
            .animated_gradient
            .catalog
            .default_config
            .clone();
        self.edit_animated_gradient(
            |config| {
                let mut changed = false;
                for parameter in AnimatedGradientParameter::ALL {
                    if *parameter == AnimatedGradientParameter::MotionSpeed {
                        continue;
                    }
                    let previous = parameter.get(config);
                    parameter.set(config, parameter.get(&defaults));
                    changed |= parameter.get(config) != previous;
                }
                changed
            },
            window,
            cx,
        );
    }

    fn open_animated_gradient_save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.sidebar.animated_gradient.save_open = true;
        self.sidebar.animated_gradient.error = None;
        if let Some(input) = self.sidebar.animated_gradient.name_input.clone() {
            input.update(cx, |input, cx| input.focus_and_select_all(window, cx));
        }
        cx.notify();
    }

    fn close_animated_gradient_save(&mut self, cx: &mut Context<Self>) {
        self.sidebar.animated_gradient.save_open = false;
        if let Some(input) = self.sidebar.animated_gradient.name_input.clone() {
            input.update(cx, |input, cx| input.set_text("", cx));
        }
        cx.notify();
    }

    fn save_animated_gradient_preset(&mut self, cx: &mut Context<Self>) {
        let Some(config) = self.animated_gradient_config().cloned() else {
            return;
        };
        let Some(input) = self.sidebar.animated_gradient.name_input.clone() else {
            return;
        };
        let name = input.read(cx).text().to_string();
        let mut library = read_library();
        if library.save_preset(&name, &config).is_none() {
            self.sidebar.animated_gradient.error = Some(if name.trim().is_empty() {
                "Enter a name for this gradient.".to_string()
            } else {
                format!("You can save up to {MAX_SAVED} gradients. Delete one to add another.")
            });
        } else if write_setting("presets", &library.presets) {
            self.sidebar.animated_gradient.library.presets = library.presets;
            self.sidebar.animated_gradient.error = None;
            self.close_animated_gradient_save(cx);
        } else {
            self.sidebar.animated_gradient.error =
                Some("Could not save this gradient. Try again.".into());
        }
        cx.notify();
    }

    fn delete_animated_gradient_preset(&mut self, id: &str, cx: &mut Context<Self>) {
        let mut library = read_library();
        library.presets.retain(|preset| preset.id != id);
        if write_setting("presets", &library.presets) {
            self.sidebar.animated_gradient.library.presets = library.presets;
            self.sidebar.animated_gradient.error = None;
        } else {
            self.sidebar.animated_gradient.error =
                Some("Could not delete this gradient. Try again.".into());
        }
        cx.notify();
    }

    pub(super) fn render_animated_gradient_icon(&self) -> AnyElement {
        let config = self.animated_gradient_config().cloned().unwrap_or_default();
        div()
            .size(px(14.))
            .child(palette(&config, px(3.)))
            .into_any_element()
    }

    pub(super) fn render_animated_gradient_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(config) = self.animated_gradient_config() else {
            return div().into_any_element();
        };
        let theme = self.theme;
        let state = &self.sidebar.animated_gradient;
        let error = state.error.clone().or_else(|| {
            state
                .persistence_failed
                .then(|| "Could not remember your animated gradient settings.".to_string())
        });

        div()
            .flex()
            .flex_col()
            .gap(px(20.))
            .children(error.map(|error| {
                div()
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.red_11))
                    .child(error)
            }))
            .child(self.render_animated_gradient_presets(cx))
            .child(dashed_divider(Hsla::from(theme.gray_5)))
            .child(self.render_animated_gradient_colours(config, cx))
            .child(dashed_divider(Hsla::from(theme.gray_5)))
            .child(self.render_animated_gradient_motion(config, cx))
            .child(dashed_divider(Hsla::from(theme.gray_5)))
            .child(self.render_animated_gradient_fine_tune(config, cx))
            .into_any_element()
    }

    fn render_animated_gradient_presets(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let state = &self.sidebar.animated_gradient;
        let cell = swatch_cell();
        let save_disabled = state.library.presets.len() >= MAX_SAVED;
        let save_open = state.save_open;

        let shuffle = div()
            .id("animated-gradient-randomize")
            .flex()
            .items_center()
            .justify_center()
            .size(px(cell))
            .rounded(px(8.))
            .bg(Hsla::from(theme.gray_2))
            .border_1()
            .border_color(Hsla::from(theme.gray_8))
            .text_color(Hsla::from(theme.gray_10))
            .cursor_pointer()
            .hover(|this| this.opacity(0.8))
            .tooltip(move |_window, cx| ui::Tooltip::new(&theme, "Randomize").view(cx))
            .child(
                svg()
                    .path("icons/shuffle.svg")
                    .size(px(16.))
                    .text_color(Hsla::from(theme.gray_10)),
            )
            .on_click(cx.listener(|this, _, window, cx| {
                this.select_animated_gradient(AnimatedGradientConfig::random(), window, cx);
            }));

        let mut swatches = vec![shuffle.into_any_element()];
        swatches.extend(state.catalog.templates.iter().map(|preset| {
            self.render_animated_gradient_swatch(preset, cell, false, cx)
                .into_any_element()
        }));
        let saved = state
            .library
            .presets
            .iter()
            .map(|preset| {
                self.render_animated_gradient_swatch(preset, cell, true, cx)
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        let save_row = state.save_open.then(|| {
            let input = state.name_input.clone();
            let name_empty = input
                .as_ref()
                .is_none_or(|input| input.read(cx).text().trim().is_empty());
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .children(input.map(|input| {
                    ui::TextInput::plain(&theme, "animated-gradient-name", &input)
                        .height(px(32.))
                        .flex(true)
                }))
                .child(
                    div()
                        .id("animated-gradient-save")
                        .flex()
                        .items_center()
                        .h(px(32.))
                        .px(px(12.))
                        .rounded(px(8.))
                        .bg(Hsla::from(theme.gray_3))
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(theme.gray_12))
                        .when(name_empty, |this| this.opacity(0.4))
                        .when(!name_empty, |this| {
                            this.cursor_pointer()
                                .hover(|this| this.bg(Hsla::from(theme.gray_4)))
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.save_animated_gradient_preset(cx);
                                    this.focus_root(window, cx);
                                }))
                        })
                        .child("Save"),
                )
                .child(icon_button(
                    &theme,
                    "animated-gradient-save-cancel",
                    "icons/x.svg",
                    "Cancel",
                    false,
                    cx.listener(|this, _, window, cx| {
                        this.close_animated_gradient_save(cx);
                        this.focus_root(window, cx);
                    }),
                ))
                .into_any_element()
        });

        ui::Field::plain(&theme, "Presets")
            .value(
                header_button(
                    &theme,
                    "animated-gradient-save-toggle",
                    "icons/save.svg",
                    "Save",
                    "Save the current gradient",
                    save_disabled,
                    save_open,
                    cx.listener(move |this, _, window, cx| {
                        if save_open {
                            this.close_animated_gradient_save(cx);
                            this.focus_root(window, cx);
                        } else {
                            this.open_animated_gradient_save(window, cx);
                        }
                    }),
                )
                .into_any_element(),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(swatch_rows(swatches))
                    .children(save_row)
                    .when(!saved.is_empty(), |this| {
                        this.child(
                            div()
                                .text_size(px(11.))
                                .text_color(Hsla::from(theme.gray_10))
                                .child("Saved"),
                        )
                        .child(swatch_rows(saved))
                    }),
            )
            .into_any_element()
    }

    fn render_animated_gradient_swatch(
        &self,
        preset: &AnimatedGradientPreset,
        cell: f32,
        saved: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let theme = self.theme;
        let selected = self.animated_gradient_config() == Some(&preset.config);
        let config = preset.config.clone();
        let name = SharedString::from(preset.name.clone());
        let id = preset.id.clone();
        let swatch = div()
            .id(SharedString::from(format!("animated-gradient-preset-{id}")))
            .size_full()
            .rounded(px(8.))
            .cursor_pointer()
            .when(selected, |this| {
                this.border_2()
                    .border_color(Hsla::from(theme.gray_500_legacy))
            })
            .when(!selected, |this| this.hover(|this| this.opacity(0.8)))
            .child(palette(&config, px(if selected { 6. } else { 8. })))
            .tooltip(move |_window, cx| ui::Tooltip::new(&theme, name.clone()).view(cx))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.select_animated_gradient(config.clone(), window, cx);
            }));
        div()
            .relative()
            .size(px(cell))
            .child(swatch)
            .when(saved && selected, |this| {
                let delete_id = id.clone();
                this.child(
                    div()
                        .id(SharedString::from(format!("animated-gradient-delete-{id}")))
                        .absolute()
                        .top(px(-6.))
                        .right(px(-6.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(20.))
                        .rounded_full()
                        .bg(Hsla::from(theme.gray_12))
                        .text_color(Hsla::from(theme.gray_1))
                        .shadow_sm()
                        .cursor_pointer()
                        .hover(|this| this.bg(Hsla::from(theme.red_11)))
                        .tooltip(move |_window, cx| ui::Tooltip::new(&theme, "Delete").view(cx))
                        .child(
                            svg()
                                .path("icons/x.svg")
                                .size(px(12.))
                                .text_color(Hsla::from(theme.gray_1)),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.delete_animated_gradient_preset(&delete_id, cx);
                        })),
                )
            })
    }

    fn render_animated_gradient_colours(
        &self,
        config: &AnimatedGradientConfig,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let selected = self.selected_animated_gradient_stop();
        let count = config.color_stops.len();
        let tracks = (0..MAX_STOPS)
            .map(|index| self.sidebar.track(SliderKey::AnimatedGradientStop(index)))
            .collect::<Vec<_>>();

        let handles = config
            .color_stops
            .iter()
            .take(MAX_STOPS)
            .enumerate()
            .map(|(index, stop)| {
                let is_selected = index == selected;
                let size = if is_selected {
                    SELECTED_HANDLE_SIZE
                } else {
                    HANDLE_SIZE
                };
                let core = div()
                    .size_full()
                    .rounded_full()
                    .bg(color_to_hsla(stop.color));
                div()
                    .id(SharedString::from(format!(
                        "animated-gradient-handle-{index}"
                    )))
                    .absolute()
                    .top(px((BAR_HEIGHT - size) / 2.))
                    .left(gpui::relative(stop.position / 100.))
                    .ml(px(-size / 2.))
                    .size(px(size))
                    .rounded_full()
                    .p(px(2.))
                    .shadow_sm()
                    .cursor_pointer()
                    .map(|this| {
                        if is_selected {
                            this.bg(Hsla::from(theme.blue_9)).child(
                                div()
                                    .size_full()
                                    .rounded_full()
                                    .p(px(2.))
                                    .bg(gpui::white())
                                    .child(core),
                            )
                        } else {
                            this.bg(gpui::white()).child(core)
                        }
                    })
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.begin_animated_gradient_stop_drag(index, cx);
                        }),
                    )
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        let bar = div()
            .id("animated-gradient-bar")
            .relative()
            .w_full()
            .h(px(BAR_HEIGHT))
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(8.))
                    .border_1()
                    .border_color(Hsla::from(theme.gray_5))
                    .child(
                        canvas(
                            move |bounds, _window, _cx| {
                                for track in &tracks {
                                    track.set(Some(bounds));
                                }
                            },
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    )
                    .child(palette(config, px(7.))),
            )
            .children(handles)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    this.add_animated_gradient_stop_at(event, window, cx);
                }),
            );

        let stop_row = config.color_stops.get(selected).map(|stop| {
            div()
                .flex()
                .items_center()
                .gap(px(12.))
                .child(self.render_rgb_input(
                    STOP_INPUT_IDS[selected],
                    ColorTarget::AnimatedGradientStop(selected),
                    stop.color,
                    cx,
                ))
                .child(
                    div()
                        .ml_auto()
                        .text_size(px(12.))
                        .text_color(Hsla::from(theme.gray_11))
                        .child(format!("{}%", stop.position.round() as i32)),
                )
                .child(icon_button(
                    &theme,
                    "animated-gradient-remove-stop",
                    "icons/trash.svg",
                    "Remove colour",
                    count <= MIN_STOPS,
                    cx.listener(move |this, _, window, cx| {
                        this.remove_animated_gradient_stop(selected, window, cx);
                    }),
                ))
        });

        ui::Field::plain(&theme, "Colours")
            .value(
                header_button(
                    &theme,
                    "animated-gradient-add-stop",
                    "icons/plus.svg",
                    "Add",
                    "Add a colour",
                    count >= MAX_STOPS,
                    false,
                    cx.listener(|this, _, window, cx| {
                        this.add_animated_gradient_stop(window, cx);
                    }),
                )
                .into_any_element(),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(div().px(px(SELECTED_HANDLE_SIZE / 2.)).child(bar))
                    .children(stop_row),
            )
            .into_any_element()
    }

    fn render_animated_gradient_motion(
        &self,
        config: &AnimatedGradientConfig,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let control = AnimatedGradientParameter::MotionSpeed.control();
        let value = AnimatedGradientParameter::MotionSpeed.get(config);
        ui::Subfield::plain(&theme, "Motion")
            .gap(px(16.))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(px(12.))
                    .child(self.slider_flex(
                        SliderKey::AnimatedGradient(AnimatedGradientParameter::MotionSpeed),
                        slider_unit(AnimatedGradientParameter::MotionSpeed),
                        cx,
                    ))
                    .child(
                        div()
                            .w(px(40.))
                            .flex_shrink_0()
                            .text_right()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_11))
                            .child(format_control_value(&control, value)),
                    ),
            )
            .into_any_element()
    }

    fn render_animated_gradient_fine_tune(
        &self,
        config: &AnimatedGradientConfig,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let state = &self.sidebar.animated_gradient;
        let open = state.fine_tune_open.is_open();
        let groups = control_groups(&state.catalog);
        let active = state.fine_tune_group.min(groups.len().saturating_sub(1));

        let tabs = ui::SegmentedControl::icons(
            &theme,
            "animated-gradient-groups",
            groups
                .iter()
                .enumerate()
                .map(|(index, (name, _))| ui::SegmentOption::new(name.to_string(), index == active))
                .collect(),
        )
        .item_padding(px(6.), px(4.))
        .on_select(cx.listener(|this, index: &usize, _, cx| {
            this.sidebar.animated_gradient.fine_tune_group = *index;
            cx.notify();
        }));

        let rows = groups
            .get(active)
            .map(|(_, controls)| controls.as_slice())
            .unwrap_or_default()
            .iter()
            .map(|control| {
                let value = control.key.get(config);
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(
                        div()
                            .w(px(96.))
                            .flex_shrink_0()
                            .truncate()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_11))
                            .child(control.label.clone()),
                    )
                    .child(self.slider_flex(
                        SliderKey::AnimatedGradient(control.key),
                        slider_unit(control.key),
                        cx,
                    ))
                    .child(
                        div()
                            .w(px(40.))
                            .flex_shrink_0()
                            .text_right()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_11))
                            .child(format_control_value(control, value)),
                    )
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_center()
                    .child(
                        div()
                            .id("animated-gradient-fine-tune")
                            .flex()
                            .flex_1()
                            .items_center()
                            .gap(px(6.))
                            .text_size(px(14.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.gray_12))
                            .cursor_pointer()
                            .child("Fine-tune")
                            .child(
                                svg()
                                    .path(if open {
                                        "icons/chevron-up.svg"
                                    } else {
                                        "icons/chevron-down.svg"
                                    })
                                    .size(px(14.))
                                    .text_color(Hsla::from(theme.gray_10)),
                            )
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.sidebar.animated_gradient.fine_tune_open.toggle();
                                this.animate_collapsibles(window, cx);
                            })),
                    )
                    .when(open, |this| {
                        this.child(header_button(
                            &theme,
                            "animated-gradient-reset",
                            "icons/rotate-ccw.svg",
                            "Reset",
                            "Reset fine-tune settings",
                            false,
                            false,
                            cx.listener(|this, _, window, cx| {
                                this.reset_animated_gradient_fine_tune(window, cx);
                            }),
                        ))
                    }),
            )
            .child(collapsible(
                &state.fine_tune_open,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .pt(px(16.))
                    .child(tabs)
                    .child(div().flex().flex_col().gap(px(4.)).children(rows))
                    .into_any_element(),
            ))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inactive_selection_does_not_rewrite_another_editors_last_used_gradient() {
        let selection = pending_selection(&BackgroundSource::default(), None, SourceTab::Color);
        assert!(!selection.selected);
        assert!(selection.last_used.is_none());
    }

    #[test]
    fn switching_away_remembers_the_outgoing_gradient() {
        let gradient = AnimatedGradientConfig::from_seed(77);
        let selection = pending_selection(
            &BackgroundSource::default(),
            Some(gradient.clone()),
            SourceTab::Color,
        );
        assert!(!selection.selected);
        assert_eq!(selection.last_used, Some(gradient));
    }

    #[test]
    fn later_edits_retain_the_pending_gradient_without_reselecting_it() {
        let gradient = AnimatedGradientConfig::from_seed(77);
        let pending = pending_selection(
            &BackgroundSource::default(),
            Some(gradient.clone()),
            SourceTab::None,
        );
        let selection = pending_selection(&BackgroundSource::default(), None, SourceTab::Color)
            .merge(Some(&pending));
        assert!(!selection.selected);
        assert_eq!(selection.last_used, Some(gradient));
    }

    #[test]
    fn selecting_none_disables_animation_and_remembers_its_config() {
        let gradient = AnimatedGradientConfig::from_seed(17);
        let mut project = ProjectConfiguration::default();
        project.background.source = BackgroundSource::AnimatedGradient {
            config: gradient.clone(),
        };
        project.background.padding = 10.;
        project.background.rounding = 15.;
        assert!(hide_background(&mut project));
        assert!(is_none_background(&project));
        assert!(matches!(
            project.background.source,
            BackgroundSource::Color {
                value: [255, 255, 255],
                alpha: 255
            }
        ));
        let selection = pending_selection(
            &project.background.source,
            Some(gradient.clone()),
            SourceTab::None,
        );
        assert!(!selection.selected);
        assert_eq!(selection.last_used, Some(gradient));

        project.background.source = BackgroundSource::Wallpaper {
            path: Some("keep.jpg".into()),
        };
        assert!(hide_background(&mut project));
        assert!(
            matches!(project.background.source, BackgroundSource::Wallpaper { path: Some(path) } if path == "keep.jpg")
        );
    }

    #[test]
    fn adding_and_removing_colours_preserves_limits_and_order() {
        let mut config = AnimatedGradientConfig::default();
        assert!(add_stop(&mut config).is_none());
        assert!(remove_stop(&mut config, 2));
        assert!(remove_stop(&mut config, 2));
        assert!(remove_stop(&mut config, 1));
        assert!(!remove_stop(&mut config, 1));
        assert!(!remove_stop(&mut config, 7));
        assert_eq!(add_stop(&mut config), Some(1));
        assert_eq!(config.color_stops.len(), 3);
        assert_eq!(config.color_stops[1].position, 50.);
        assert_eq!(stop_limits(&config, 1), (0., 100.));
        assert!(add_stop(&mut config).is_some());
        assert!(add_stop(&mut config).is_some());
        assert!(add_stop(&mut config).is_none());
        assert!(
            config
                .color_stops
                .windows(2)
                .all(|pair| pair[0].position <= pair[1].position)
        );
    }

    #[test]
    fn clicking_the_bar_inserts_a_blended_stop_in_order() {
        let mut config = AnimatedGradientConfig {
            color_stops: vec![
                AnimatedGradientStop {
                    color: [0, 0, 0],
                    position: 0.,
                },
                AnimatedGradientStop {
                    color: [200, 100, 0],
                    position: 100.,
                },
            ],
            ..Default::default()
        };
        assert_eq!(insert_stop(&mut config, 25.), Some(1));
        assert_eq!(config.color_stops[1].position, 25.);
        assert_eq!(config.color_stops[1].color, [50, 25, 0]);
        assert_eq!(insert_stop(&mut config, 10.4), Some(1));
        assert_eq!(config.color_stops[1].position, 10.);
        assert_eq!(insert_stop(&mut config, 100.), Some(4));
        assert_eq!(config.color_stops[4].color, [200, 100, 0]);
        assert!(insert_stop(&mut config, 60.).is_none());
        assert_eq!(color_at(&config.color_stops, -5.), [0, 0, 0]);
    }

    #[test]
    fn position_limits_keep_colour_identity_stable() {
        let config = AnimatedGradientConfig::default();
        assert_eq!(stop_limits(&config, 0), (0., 25.));
        assert_eq!(stop_limits(&config, 2), (25., 75.));
        assert_eq!(stop_limits(&config, 4), (75., 100.));
    }

    #[test]
    fn adding_and_dragging_a_colour_is_one_history_entry() {
        let mut config = AnimatedGradientConfig::default();
        assert!(remove_stop(&mut config, 2));
        let mut project = ProjectConfiguration::default();
        project.background.source = BackgroundSource::AnimatedGradient { config };
        let initial = project.clone();
        let mut history = crate::editor_edits::ProjectHistory::new(initial.clone());
        let mut drag = ui::SliderDrag::new();
        let BackgroundSource::AnimatedGradient { config } = &mut project.background.source else {
            panic!("expected animated gradient");
        };
        let mut updated = config.clone();
        let index = insert_stop(&mut updated, 40.).unwrap();
        drag.begin(SliderKey::AnimatedGradientStop(index), || history.pause());
        *config = updated;
        history.record(&project);
        let BackgroundSource::AnimatedGradient { config } = &mut project.background.source else {
            panic!("expected animated gradient");
        };
        config.color_stops[index].position = 50.;
        history.record(&project);
        drag.end(|| history.resume(&project));
        assert_eq!(
            serde_json::to_value(history.undo().unwrap()).unwrap(),
            serde_json::to_value(&initial).unwrap()
        );
        assert!(!history.can_undo());
    }

    #[test]
    fn control_values_read_like_the_solid_editor() {
        let direction = AnimatedGradientParameter::Direction.control();
        let motion = AnimatedGradientParameter::MotionSpeed.control();
        let scale = AnimatedGradientParameter::FlowScale.control();
        let strength = AnimatedGradientParameter::FlowStrength.control();
        assert_eq!(format_control_value(&direction, 45.4), "45\u{b0}");
        assert_eq!(format_control_value(&motion, 0.), "Still");
        assert_eq!(format_control_value(&motion, 30.), "30");
        assert_eq!(format_control_value(&scale, 2.), "2.0");
        assert_eq!(format_control_value(&strength, 55.), "55");
    }

    #[test]
    fn fine_tune_groups_exclude_motion() {
        let catalog = animated_gradient_catalog();
        let groups = control_groups(&catalog);
        assert_eq!(groups.len(), 4);
        assert!(groups.iter().all(|(name, _)| *name != "Animation"));
        assert!(
            groups
                .iter()
                .flat_map(|(_, controls)| controls)
                .all(|control| control.key != AnimatedGradientParameter::MotionSpeed)
        );
    }
}
