use cap_project::{FrameConfiguration, FrameStyle, FrameTheme, ProjectConfiguration};
use gpui::{
    AppContext as _, Context, Entity, FontWeight, InteractiveElement, IntoElement, MouseButton,
    ParentElement, StatefulInteractiveElement as _, Styled, Window, div, point,
    prelude::FluentBuilder, px, svg,
};

use super::EditorWindow;
use crate::ui;

const FRAME_STYLES: [(FrameStyle, &str, &str, &str); 5] = [
    (
        FrameStyle::None,
        "None",
        "Show the recording as-is",
        "icons/ban.svg",
    ),
    (
        FrameStyle::MacOS,
        "macOS",
        "Window chrome with traffic lights",
        "icons/app-window-mac.svg",
    ),
    (
        FrameStyle::Windows,
        "Windows",
        "Title bar with window controls",
        "icons/app-window.svg",
    ),
    (
        FrameStyle::Browser,
        "Browser",
        "Browser chrome with address bar",
        "icons/globe.svg",
    ),
    (
        FrameStyle::Macbook,
        "MacBook",
        "Laptop bezel around the recording",
        "icons/laptop.svg",
    ),
];

#[derive(Default)]
pub(super) struct FrameControls {
    open: bool,
    trigger_bounds: ui::SliderTrack,
    fields: Option<[Entity<ui::TextInputState>; 2]>,
    editing: Option<FrameField>,
    style_target: Option<StyleFrameTarget>,
}

struct StyleFrameTarget {
    index: usize,
    fingerprint: String,
}

impl StyleFrameTarget {
    fn capture(project: &ProjectConfiguration, index: usize) -> Option<Self> {
        let segment = project.timeline.as_ref()?.style_segments.get(index)?;
        Some(Self {
            index,
            fingerprint: serde_json::to_string(segment).ok()?,
        })
    }

    fn matches(&self, project: &ProjectConfiguration) -> bool {
        Self::capture(project, self.index)
            .is_some_and(|target| target.fingerprint == self.fingerprint)
    }
}

impl FrameControls {
    pub(super) fn is_open(&self) -> bool {
        self.open
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FrameField {
    Url,
    Title,
}

impl FrameField {
    fn for_style(style: FrameStyle) -> Option<Self> {
        match style {
            FrameStyle::Browser => Some(Self::Url),
            FrameStyle::MacOS => Some(Self::Title),
            _ => None,
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Url => 0,
            Self::Title => 1,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Url => "URL",
            Self::Title => "Title",
        }
    }

    fn text(self, frame: &FrameConfiguration) -> &str {
        match self {
            Self::Url => &frame.url,
            Self::Title => &frame.title,
        }
    }
}

enum FrameChange {
    Style(FrameStyle),
    Theme(FrameTheme),
    Text(FrameField, String),
}

fn apply_frame_change(project: &mut ProjectConfiguration, change: FrameChange) -> bool {
    let previous = project.background.frame.clone();
    let frame = project
        .background
        .frame
        .get_or_insert_with(Default::default);
    match change {
        FrameChange::Style(style) => frame.style = style,
        FrameChange::Theme(theme) => frame.theme = theme,
        FrameChange::Text(FrameField::Url, text) => frame.url = text,
        FrameChange::Text(FrameField::Title, text) => frame.title = text,
    }
    project.background.frame != previous
}

fn apply_targeted_frame_change(
    project: &mut ProjectConfiguration,
    target: Option<&StyleFrameTarget>,
    change: FrameChange,
) -> bool {
    let Some(target) = target else {
        return apply_frame_change(project, change);
    };
    if !target.matches(project) {
        return false;
    }
    let mut scoped = project.clone();
    let Some(segment) = project
        .timeline
        .as_ref()
        .and_then(|timeline| timeline.style_segments.get(target.index))
    else {
        return false;
    };
    scoped.background = segment
        .overrides
        .background
        .clone()
        .unwrap_or_else(|| project.background.clone());
    if !apply_frame_change(&mut scoped, change) {
        return false;
    }
    let Some(segment) = project
        .timeline
        .as_mut()
        .and_then(|timeline| timeline.style_segments.get_mut(target.index))
    else {
        return false;
    };
    segment.overrides.background = Some(scoped.background);
    true
}

fn button_content(style: FrameStyle) -> (&'static str, &'static str) {
    if style == FrameStyle::None {
        return ("Frame", "icons/app-window-mac.svg");
    }
    FRAME_STYLES
        .iter()
        .find(|option| option.0 == style)
        .map(|option| (option.1, option.3))
        .unwrap_or(("Frame", "icons/app-window-mac.svg"))
}

impl EditorWindow {
    fn frame_background(&self) -> &cap_project::BackgroundConfiguration {
        let index = if self.frame_controls.open {
            self.frame_controls
                .style_target
                .as_ref()
                .map(|target| target.index)
        } else {
            self.selected_style_index()
        };
        index
            .and_then(|index| {
                self.project
                    .timeline
                    .as_ref()?
                    .style_segments
                    .get(index)?
                    .overrides
                    .background
                    .as_ref()
            })
            .unwrap_or(&self.project.background)
    }

    pub(crate) fn dismiss_frame_controls(&mut self, cx: &mut Context<Self>) {
        self.finish_frame_text_edit(cx);
        self.frame_controls.open = false;
        self.frame_controls.style_target = None;
    }

    fn edit_frame(&mut self, change: FrameChange, window: &mut Window, cx: &mut Context<Self>) {
        if !self.frame_controls.open {
            return;
        }
        if !apply_targeted_frame_change(
            &mut self.project,
            self.frame_controls.style_target.as_ref(),
            change,
        ) {
            return;
        }
        if let Some(target) = &mut self.frame_controls.style_target
            && let Some(next) = StyleFrameTarget::capture(&self.project, target.index)
        {
            *target = next;
        }
        self.project_changed(window, cx);
    }

    fn frame_style(&self) -> FrameStyle {
        FrameConfiguration::active_style(self.frame_background().frame.as_ref())
    }

    pub(super) fn render_frame_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let (label, icon) = button_content(self.frame_style());
        let bounds = self.frame_controls.trigger_bounds.clone();
        div()
            .relative()
            .flex_none()
            .child(
                ui::EditorButton::plain(&self.theme, "frame-settings")
                    .left_icon(icon)
                    .right_icon("icons/chevron-down.svg")
                    .label(label)
                    .tooltip(&self.theme, "Add a frame")
                    .pressed(self.frame_controls.open)
                    .disabled(self.instance.is_none())
                    .on_click(cx.listener(|this, _, window, cx| {
                        if this.frame_controls.open {
                            this.close_frame_controls(window, cx);
                        } else {
                            this.focus_root(window, cx);
                            this.toolbar_menu = None;
                            this.add_track = None;
                            this.frame_controls.style_target = this
                                .selected_style_index()
                                .and_then(|index| StyleFrameTarget::capture(&this.project, index));
                            this.frame_controls.open = true;
                            cx.notify();
                        }
                    })),
            )
            .child(
                gpui::canvas(move |rect, _, _| bounds.set(Some(rect)), |_, _, _, _| {})
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
            )
    }

    pub(super) fn prepare_frame_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.frame_controls.open {
            return;
        }
        if self.frame_controls.fields.is_none() {
            self.frame_controls.fields = Some([FrameField::Url, FrameField::Title].map(|field| {
                let input = cx.new(|cx| {
                    let mut input = ui::TextInputState::single_line(window, cx);
                    input.set_placeholder(match field {
                        FrameField::Url => "cap.so",
                        FrameField::Title => "Window title",
                    });
                    input
                });
                let subscription =
                    cx.subscribe_in(&input, window, move |this, input, event, window, cx| {
                        this.on_frame_field_event(field, input, event, window, cx);
                    });
                self.push_text_subscription(subscription);
                input
            }));
        }
        let frame = self.frame_background().frame.clone().unwrap_or_default();
        if let Some(inputs) = &self.frame_controls.fields {
            for field in [FrameField::Url, FrameField::Title] {
                let input = &inputs[field.index()];
                if !input.read(cx).focus_handle().is_focused(window) {
                    input.update(cx, |input, cx| {
                        input.set_text(field.text(&frame).to_owned(), cx)
                    });
                }
            }
        }
    }

    fn on_frame_field_event(
        &mut self,
        field: FrameField,
        input: &Entity<ui::TextInputState>,
        event: &ui::TextInputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ui::TextInputEvent::Changed => {
                if !self.frame_controls.open
                    || FrameField::for_style(self.frame_style()) != Some(field)
                {
                    return;
                }
                if self.frame_controls.editing != Some(field) {
                    self.finish_frame_text_edit(cx);
                    self.history.pause();
                    self.frame_controls.editing = Some(field);
                }
                let change = FrameChange::Text(field, input.read(cx).text().to_owned());
                self.edit_frame(change, window, cx);
            }
            ui::TextInputEvent::Blurred => self.finish_frame_text_edit(cx),
            ui::TextInputEvent::Confirmed => {
                self.finish_frame_text_edit(cx);
                self.focus_root(window, cx);
            }
            ui::TextInputEvent::Cancelled => self.close_frame_controls(window, cx),
        }
    }

    fn finish_frame_text_edit(&mut self, cx: &mut Context<Self>) {
        if self.frame_controls.editing.take().is_some() {
            self.history.resume(&self.project);
            cx.notify();
        }
    }

    pub(super) fn close_frame_controls(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.finish_frame_text_edit(cx);
        self.frame_controls.open = false;
        self.frame_controls.style_target = None;
        self.focus_root(window, cx);
        cx.notify();
    }

    fn change_frame(&mut self, change: FrameChange, window: &mut Window, cx: &mut Context<Self>) {
        self.finish_frame_text_edit(cx);
        self.focus_root(window, cx);
        self.edit_frame(change, window, cx);
    }

    pub(super) fn render_frame_controls(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        if !self.frame_controls.open {
            return None;
        }
        let bounds = self.frame_controls.trigger_bounds.get()?;
        let theme = self.theme;
        let style = self.frame_style();
        let frame_theme = self
            .frame_background()
            .frame
            .as_ref()
            .map_or(FrameTheme::Dark, |frame| frame.theme);
        let panel = div()
            .id("frame-popover")
            .occlude()
            .flex()
            .flex_col()
            .w(px(304.).min(window.viewport_size().width - px(24.)))
            .max_h(window.viewport_size().height - px(24.))
            .overflow_y_scroll()
            .rounded(px(16.))
            .border_1()
            .border_color(theme.gray(3))
            .bg(theme.gray(1))
            .shadow_lg()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .px(px(16.))
                    .pt(px(14.))
                    .pb(px(12.))
                    .border_b_1()
                    .border_color(theme.gray(3))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.gray(12))
                            .child("Frame"),
                    )
                    .child(
                        div().text_size(px(11.)).text_color(theme.gray(10)).child(
                            match &self.frame_controls.style_target {
                                Some(target) if !target.matches(&self.project) => {
                                    "This Style changed. Close and reopen Frame.".to_string()
                                }
                                Some(target)
                                    if self
                                        .project
                                        .timeline
                                        .as_ref()
                                        .and_then(|timeline| {
                                            timeline.style_segments.get(target.index)
                                        })
                                        .is_some_and(|segment| {
                                            segment.overrides.background.is_none()
                                        }) =>
                                {
                                    format!(
                                        "Style {} only · Editing enables its background override.",
                                        target.index + 1
                                    )
                                }
                                Some(target) => format!(
                                    "Style {} only · Global settings stay unchanged.",
                                    target.index + 1
                                ),
                                None => {
                                    "Global frame · Applies wherever Style inherits background."
                                        .to_string()
                                }
                            },
                        ),
                    ),
            )
            .child(div().flex().flex_col().gap(px(2.)).p(px(6.)).children(
                FRAME_STYLES.into_iter().enumerate().map(
                    |(index, (value, label, description, icon))| {
                        let selected = value == style;
                        div()
                            .id(("frame-style", index))
                            .tab_index(0)
                            .flex()
                            .items_center()
                            .gap(px(12.))
                            .p(px(8.))
                            .rounded(px(12.))
                            .cursor_pointer()
                            .hover(|row| row.bg(theme.gray(3)))
                            .focus_visible(|row| row.bg(theme.gray(3)))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .size(px(32.))
                                    .flex_shrink_0()
                                    .rounded(px(10.))
                                    .bg(if selected {
                                        theme.blue_9.into()
                                    } else {
                                        theme.gray(3)
                                    })
                                    .child(svg().path(icon).size(px(16.)).text_color(
                                        if selected {
                                            gpui::white()
                                        } else {
                                            theme.gray(11)
                                        },
                                    )),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .flex_1()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.gray(12))
                                            .child(label),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .text_color(theme.gray(10))
                                            .child(description),
                                    ),
                            )
                            .when(selected, |row| {
                                row.child(
                                    svg()
                                        .path("icons/circle-check.svg")
                                        .size(px(16.))
                                        .flex_shrink_0()
                                        .text_color(theme.blue_9),
                                )
                            })
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.change_frame(FrameChange::Style(value), window, cx)
                            }))
                    },
                ),
            ))
            .when(style != FrameStyle::None, |panel| {
                panel.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(12.))
                        .p(px(12.))
                        .border_t_1()
                        .border_color(theme.gray(3))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap(px(12.))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.gray(11))
                                        .child("Theme"),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .w(px(160.))
                                        .h(px(32.))
                                        .border_1()
                                        .border_color(theme.gray(3))
                                        .rounded(px(8.))
                                        .p(px(1.))
                                        .children(
                                            [
                                                (FrameTheme::Light, "Light"),
                                                (FrameTheme::Dark, "Dark"),
                                            ]
                                            .into_iter()
                                            .map(
                                                |(value, label)| {
                                                    div()
                                                        .id((
                                                            "frame-theme",
                                                            usize::from(value == FrameTheme::Dark),
                                                        ))
                                                        .tab_index(0)
                                                        .flex()
                                                        .flex_1()
                                                        .items_center()
                                                        .justify_center()
                                                        .rounded(px(7.))
                                                        .text_size(px(12.))
                                                        .text_color(if value == frame_theme {
                                                            theme.gray(12)
                                                        } else {
                                                            theme.gray(11)
                                                        })
                                                        .when(value == frame_theme, |tab| {
                                                            tab.bg(theme.gray(3))
                                                        })
                                                        .focus_visible(|tab| tab.bg(theme.gray(4)))
                                                        .cursor_pointer()
                                                        .child(label)
                                                        .on_click(cx.listener(
                                                            move |this, _, window, cx| {
                                                                this.change_frame(
                                                                    FrameChange::Theme(value),
                                                                    window,
                                                                    cx,
                                                                )
                                                            },
                                                        ))
                                                },
                                            ),
                                        ),
                                ),
                        )
                        .children(FrameField::for_style(style).and_then(|field| {
                            let input = &self.frame_controls.fields.as_ref()?[field.index()];
                            Some(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(12.))
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.gray(11))
                                            .child(field.label()),
                                    )
                                    .child(
                                        ui::TextInput::plain(
                                            &theme,
                                            ("frame-text", field.index()),
                                            input,
                                        )
                                        .width(px(160.))
                                        .height(px(32.))
                                        .radius(px(8.))
                                        .bg(theme.gray(2)),
                                    ),
                            )
                        })),
                )
            });
        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("frame-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .occlude()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, window, cx| {
                                this.close_frame_controls(window, cx);
                                cx.stop_propagation();
                            }),
                        ),
                )
                .child(
                    gpui::anchored()
                        .position(point(bounds.left(), bounds.bottom() + px(8.)))
                        .snap_to_window_with_margin(px(12.))
                        .child(panel),
                )
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor_edits::ProjectHistory;

    #[test]
    fn frame_styles_and_button_labels_match_tauri() {
        assert_eq!(
            FRAME_STYLES.map(|option| option.1),
            ["None", "macOS", "Windows", "Browser", "MacBook"]
        );
        assert_eq!(
            button_content(FrameStyle::None),
            ("Frame", "icons/app-window-mac.svg")
        );
        for (style, label, _, icon) in FRAME_STYLES.into_iter().skip(1) {
            assert_eq!(button_content(style), (label, icon));
        }
    }

    #[test]
    fn frame_style_initializes_matching_defaults_and_keeps_existing_settings() {
        let mut project = ProjectConfiguration::default();
        assert!(apply_frame_change(
            &mut project,
            FrameChange::Style(FrameStyle::Browser)
        ));
        let frame = project.background.frame.as_ref().unwrap();
        assert_eq!(frame.theme, FrameTheme::Dark);
        assert_eq!(frame.url, "Cap.so");
        assert_eq!(frame.title, "");
        assert!(!apply_frame_change(
            &mut project,
            FrameChange::Style(FrameStyle::Browser)
        ));
        assert!(apply_frame_change(
            &mut project,
            FrameChange::Text(FrameField::Url, "example.com".into())
        ));
        assert!(apply_frame_change(
            &mut project,
            FrameChange::Text(FrameField::Title, "Demo".into())
        ));
        assert!(apply_frame_change(
            &mut project,
            FrameChange::Theme(FrameTheme::Light)
        ));
        for (style, _, _, _) in FRAME_STYLES {
            apply_frame_change(&mut project, FrameChange::Style(style));
            let frame = project.background.frame.as_ref().unwrap();
            assert_eq!(frame.url, "example.com");
            assert_eq!(frame.title, "Demo");
            assert_eq!(frame.theme, FrameTheme::Light);
        }
    }

    #[test]
    fn frame_text_fields_match_tauri_visibility() {
        assert!(FrameField::for_style(FrameStyle::Browser) == Some(FrameField::Url));
        assert!(FrameField::for_style(FrameStyle::MacOS) == Some(FrameField::Title));
        for style in [FrameStyle::None, FrameStyle::Windows, FrameStyle::Macbook] {
            assert!(FrameField::for_style(style).is_none());
        }
    }

    #[test]
    fn frame_changes_round_trip_and_undo_without_changing_the_background() {
        let mut project = ProjectConfiguration::default();
        let source = serde_json::to_value(&project.background.source).unwrap();
        let mut history = ProjectHistory::new(project.clone());
        for (style, _, _, _) in FRAME_STYLES {
            apply_frame_change(&mut project, FrameChange::Style(style));
            history.record(&project);
            let saved = serde_json::to_vec(&project).unwrap();
            let loaded: ProjectConfiguration = serde_json::from_slice(&saved).unwrap();
            assert_eq!(loaded.background.frame, project.background.frame);
            assert_eq!(
                serde_json::to_value(&loaded.background.source).unwrap(),
                source
            );
        }
        assert_eq!(
            history
                .undo()
                .unwrap()
                .background
                .frame
                .as_ref()
                .unwrap()
                .style,
            FrameStyle::Browser
        );
        assert_eq!(
            history
                .redo()
                .unwrap()
                .background
                .frame
                .as_ref()
                .unwrap()
                .style,
            FrameStyle::Macbook
        );
    }
}

#[cfg(test)]
mod style_image_tests {
    use super::*;

    #[test]
    fn style_image_frame_opt_in_preserves_globals_and_rejects_stale_target() {
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({"timeline":{"zoomSegments":[],"segments":[],"styleSegments":[{"start":1,"end":5,"name":"A"},{"start":7,"end":9,"name":"B"}]}})).unwrap();
        let base = project.background.clone();
        let target = StyleFrameTarget::capture(&project, 0).unwrap();
        assert!(apply_targeted_frame_change(
            &mut project,
            Some(&target),
            FrameChange::Style(FrameStyle::Browser)
        ));
        assert_eq!(
            serde_json::to_value(&project.background).unwrap(),
            serde_json::to_value(&base).unwrap()
        );
        let target = StyleFrameTarget::capture(&project, 0).unwrap();
        assert!(apply_targeted_frame_change(
            &mut project,
            Some(&target),
            FrameChange::Text(FrameField::Url, "example.com".into())
        ));
        let target = StyleFrameTarget::capture(&project, 0).unwrap();
        project.timeline.as_mut().unwrap().style_segments.swap(0, 1);
        assert!(!apply_targeted_frame_change(
            &mut project,
            Some(&target),
            FrameChange::Style(FrameStyle::Windows)
        ));
        assert!(
            project.timeline.as_ref().unwrap().style_segments[0]
                .overrides
                .background
                .is_none()
        );
        assert_eq!(
            serde_json::to_value(&project.background).unwrap(),
            serde_json::to_value(&base).unwrap()
        );
        let frame = project.timeline.as_ref().unwrap().style_segments[1]
            .overrides
            .background
            .as_ref()
            .unwrap()
            .frame
            .as_ref()
            .unwrap();
        assert_eq!(frame.style, FrameStyle::Browser);
        assert_eq!(frame.url, "example.com");
    }
}
