//! Auto redact in the player toolbar: a chip with the same switch as
//! Enhance, and a card that holds what to hide, how, and how the scan is
//! going. The card stays open while the pointer is on the chip or the card.
//! Analysis runs in the background (see `crate::redact`); its results reach
//! the renderer as they arrive.

use super::*;
use crate::redact::{JobPhase, RedactJob};
use cap_project::{AutoRedactConfiguration, RedactCategory, RedactStyle, redaction::Redactions};
use gpui::{AnyElement, relative};

const CARD_DELAY: Duration = Duration::from_millis(350);
const CARD_CLOSE_GRACE: Duration = Duration::from_millis(220);
const CARD_WIDTH: f32 = 304.;
const POLL: Duration = Duration::from_millis(300);

#[derive(Default)]
pub(crate) struct RedactUi {
    chip_bounds: Rc<Cell<Option<gpui::Bounds<Pixels>>>>,
    chip_hovered: bool,
    card_hovered: bool,
    card_open: bool,
    card_task: Option<gpui::Task<()>>,
    job: Option<RedactJob>,
    poll_task: Option<gpui::Task<()>>,
    pub(crate) phase: Option<JobPhase>,
    pub(crate) progress: f32,
    pub(crate) redactions: Option<Arc<Redactions>>,
    loaded_for: Option<PathBuf>,
    highlighted: Vec<String>,
}

pub(crate) fn category_label(category: RedactCategory) -> &'static str {
    match category {
        RedactCategory::Email => tr::editor::redact::category_email(),
        RedactCategory::Name => tr::editor::redact::category_name(),
        RedactCategory::Phone => tr::editor::redact::category_phone(),
        RedactCategory::Address => tr::editor::redact::category_address(),
        RedactCategory::Card => tr::editor::redact::category_card(),
        RedactCategory::Secret => tr::editor::redact::category_secret(),
        RedactCategory::Ip => tr::editor::redact::category_ip(),
        RedactCategory::Url => tr::editor::redact::category_url(),
    }
}

/// The detections the current settings hide, per category and in total.
pub(crate) fn hidden_counts(
    redactions: Option<&Redactions>,
    config: &AutoRedactConfiguration,
) -> (usize, Vec<(RedactCategory, usize)>) {
    let mut per = RedactCategory::ALL
        .map(|category| (category, 0usize))
        .to_vec();
    let mut total = 0;
    if let Some(redactions) = redactions {
        for region in &redactions.regions {
            if let Some(slot) = per.iter_mut().find(|(c, _)| *c == region.category) {
                slot.1 += 1;
            }
            if config.has_category(region.category) && !config.is_excluded(&region.id) {
                total += 1;
            }
        }
    }
    (total, per)
}

/// The chip's switch, the same shape as Enhance's.
fn redact_switch(theme: &Theme, on: bool) -> impl IntoElement {
    const TRACK_WIDTH: f32 = 22.;
    const TRACK_HEIGHT: f32 = 13.;
    const INSET: f32 = 2.;
    const KNOB: f32 = TRACK_HEIGHT - INSET * 2.;
    let editor = theme.editor;
    div()
        .flex_none()
        .relative()
        .w(px(TRACK_WIDTH))
        .h(px(TRACK_HEIGHT))
        .rounded_full()
        .map(|this| {
            if on {
                this.bg(Hsla::from(editor.accent))
            } else {
                this.bg(Hsla::from(editor.text_3).opacity(0.45))
            }
        })
        .child(
            div()
                .absolute()
                .top(px(INSET))
                .left(px(if on {
                    TRACK_WIDTH - INSET - KNOB
                } else {
                    INSET
                }))
                .size(px(KNOB))
                .rounded_full()
                .bg(gpui::white())
                .shadow(vec![gpui::BoxShadow {
                    color: gpui::hsla(0., 0., 0., 0.25),
                    offset: gpui::point(px(0.), px(0.5)),
                    blur_radius: px(1.),
                    spread_radius: px(0.),
                    inset: false,
                }]),
        )
}

impl EditorWindow {
    pub(super) fn render_preview_redact(
        &self,
        labels: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let ready = self.project_ready();
        let on = self.project.auto_redact.enabled;
        let wash = Hsla::from(editor.accent);
        let ink = Hsla::from(if on { editor.accent_ink } else { editor.text_2 });
        let bounds = self.redact.chip_bounds.clone();
        div()
            .id("transport-redact")
            .group("transport-redact")
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.))
            .h(px(28.))
            .px(px(9.))
            .rounded(px(9.))
            .text_size(px(12.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(ink)
            .map(|this| {
                if on {
                    this.bg(wash.opacity(0.14))
                } else {
                    this.bg(Hsla::from(editor.ctl)).shadow(editor.trough_ring())
                }
            })
            .when(!ready, |this| this.opacity(0.45))
            .when(ready, |this| {
                this.cursor_pointer()
                    .hover(move |style| {
                        if on {
                            style.bg(wash.opacity(0.22))
                        } else {
                            style
                                .bg(Hsla::from(editor.ctl_hover))
                                .text_color(Hsla::from(editor.text_1))
                        }
                    })
                    .on_click(cx.listener(|this, _, window, cx| {
                        let on = !this.project.auto_redact.enabled;
                        this.set_redact_enabled(on, window, cx);
                        if this.redact.chip_hovered {
                            this.open_redact_card(cx);
                        }
                    }))
            })
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                this.redact.chip_hovered = *hovered;
                this.redact_hover_changed(cx);
            }))
            .child(
                svg()
                    .path("icons/eye-off.svg")
                    .size(px(14.))
                    .flex_none()
                    .text_color(ink)
                    .when(ready && !on, |this| {
                        this.group_hover("transport-redact", |style| {
                            style.text_color(Hsla::from(editor.text_1))
                        })
                    }),
            )
            .when(labels, |this| this.child(tr::editor::redact::chip()))
            .child(redact_switch(&theme, on))
            .child(
                gpui::canvas(move |value, _, _| bounds.set(Some(value)), |_, _, _, _| {})
                    .absolute()
                    .size_full(),
            )
    }

    /// Opens the card after the pointer rests on the chip; closes it a moment
    /// after the pointer has left both the chip and the card, so it can cross
    /// the gap between them.
    fn redact_hover_changed(&mut self, cx: &mut Context<Self>) {
        let inside = self.redact.chip_hovered || self.redact.card_hovered;
        if inside {
            if self.redact.card_open {
                self.redact.card_task = None;
                return;
            }
            if self.redact.card_task.is_some() || !self.redact.chip_hovered {
                return;
            }
            self.redact.card_task = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(CARD_DELAY).await;
                let _ = this.update(cx, |this, cx| {
                    this.redact.card_task = None;
                    if this.redact.chip_hovered || this.redact.card_hovered {
                        this.open_redact_card(cx);
                    }
                });
            }));
            return;
        }
        if !self.redact.card_open {
            self.redact.card_task = None;
            return;
        }
        self.redact.card_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CARD_CLOSE_GRACE).await;
            let _ = this.update(cx, |this, cx| {
                this.redact.card_task = None;
                if !this.redact.chip_hovered && !this.redact.card_hovered {
                    this.redact.card_open = false;
                    cx.notify();
                }
            });
        }));
    }

    fn open_redact_card(&mut self, cx: &mut Context<Self>) {
        self.redact.card_task = None;
        if !self.redact.card_open {
            self.redact.card_open = true;
            cx.notify();
        }
    }

    pub(super) fn render_redact_card(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        if !self.redact.card_open {
            return None;
        }
        let bounds = self.redact.chip_bounds.get()?;
        let theme = self.theme;
        let editor = theme.editor;
        let config = &self.project.auto_redact;
        let on = config.enabled;
        let (hidden, per_category) = hidden_counts(self.redact.redactions.as_deref(), config);
        let state = div()
            .flex()
            .items_center()
            .h(px(18.))
            .px(px(7.))
            .rounded_full()
            .text_size(px(11.))
            .font_weight(FontWeight::MEDIUM)
            .map(|this| {
                if on {
                    this.bg(Hsla::from(editor.accent).opacity(0.14))
                        .text_color(Hsla::from(editor.accent_ink))
                        .child(tr::editor::window::transport::enhance_on())
                } else {
                    this.bg(Hsla::from(editor.ctl_hover))
                        .text_color(Hsla::from(editor.text_2))
                        .child(tr::editor::window::transport::enhance_off())
                }
            });
        let status: Option<AnyElement> = on.then(|| {
            let (text, fraction): (SharedString, Option<f32>) = match &self.redact.phase {
                Some(JobPhase::Preparing) => (tr::editor::redact::preparing().into(), None),
                Some(JobPhase::Scanning) => (
                    tr::editor::redact::scanning((self.redact.progress * 100.).floor() as u32)
                        .into(),
                    Some(self.redact.progress),
                ),
                Some(JobPhase::Failed(_)) => (tr::editor::redact::failed().into(), None),
                _ if hidden == 0 => (tr::editor::redact::nothing().into(), None),
                _ => (tr::editor::redact::hidden(hidden).into(), None),
            };
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div()
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(editor.text_1))
                        .child(text),
                )
                .children(fraction.map(|fraction| {
                    div()
                        .h(px(4.))
                        .w_full()
                        .rounded_full()
                        .bg(Hsla::from(editor.track))
                        .child(
                            div()
                                .h_full()
                                .rounded_full()
                                .bg(Hsla::from(editor.accent))
                                .w(relative(fraction.clamp(0.02, 1.0))),
                        )
                }))
                .into_any_element()
        });
        let category_row = |category: RedactCategory, count: usize, cx: &mut Context<Self>| {
            let checked = config.has_category(category);
            div()
                .id(SharedString::from(format!(
                    "redact-category-{}",
                    category.as_str()
                )))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.))
                .h(px(26.))
                .px(px(6.))
                .rounded(px(7.))
                .cursor_pointer()
                .hover(|style| style.bg(Hsla::from(editor.ctl_hover)))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.toggle_redact_category(category, window, cx);
                }))
                .child(
                    div()
                        .flex_none()
                        .size(px(14.))
                        .rounded(px(4.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .map(|this| {
                            if checked {
                                this.bg(Hsla::from(editor.accent_fill)).child(
                                    svg()
                                        .path("icons/check.svg")
                                        .size(px(10.))
                                        .text_color(gpui::white()),
                                )
                            } else {
                                this.border_1().border_color(Hsla::from(editor.line_strong))
                            }
                        }),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(px(12.))
                        .text_color(Hsla::from(editor.text_1))
                        .child(category_label(category)),
                )
                .when(count > 0, |this| {
                    this.child(
                        div()
                            .text_size(px(11.))
                            .text_color(Hsla::from(editor.text_2))
                            .child(count.to_string()),
                    )
                })
        };
        let rows = RedactCategory::ALL
            .into_iter()
            .map(|category| {
                let count = per_category
                    .iter()
                    .find(|(c, _)| *c == category)
                    .map_or(0, |(_, n)| *n);
                category_row(category, count, cx).into_any_element()
            })
            .collect::<Vec<_>>();
        let style = config.style;
        let card = div()
            .id("redact-card")
            .w(px(CARD_WIDTH))
            .flex()
            .flex_col()
            .gap(px(10.))
            .p(px(14.))
            .rounded(px(12.))
            .border_1()
            .border_color(editor.pop_line())
            .bg(editor.pop_bg())
            .shadow(editor.pop_shadow())
            .occlude()
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                this.redact.card_hovered = *hovered;
                this.redact_hover_changed(cx);
            }))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(7.))
                            .text_size(px(13.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(Hsla::from(editor.text_1))
                            .child(svg().path("icons/eye-off.svg").size(px(14.)).text_color(
                                Hsla::from(if on { editor.accent_ink } else { editor.text_1 }),
                            ))
                            .child(tr::editor::redact::title()),
                    )
                    .child(state),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(17.))
                    .text_color(Hsla::from(editor.text_2))
                    .child(tr::editor::redact::body()),
            )
            .children(status)
            .child(div().h(px(1.)).bg(Hsla::from(editor.line)))
            .child(
                div()
                    .text_size(px(11.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(editor.text_2))
                    .child(tr::editor::redact::hide()),
            )
            .child(div().flex().flex_col().gap(px(1.)).children(rows))
            .child(div().h(px(1.)).bg(Hsla::from(editor.line)))
            .child(
                ui::SegmentedControl::editor(
                    &theme,
                    "redact-style",
                    vec![
                        ui::SegmentOption::new(
                            tr::editor::redact::style_pixelate(),
                            style == RedactStyle::Pixelate,
                        ),
                        ui::SegmentOption::new(
                            tr::editor::redact::style_blur(),
                            style == RedactStyle::Blur,
                        ),
                    ],
                )
                .fill()
                .on_select(cx.listener(|this, choice: &usize, window, cx| {
                    let style = if *choice == 1 {
                        RedactStyle::Blur
                    } else {
                        RedactStyle::Pixelate
                    };
                    this.set_redact_style(style, window, cx);
                })),
            );
        Some(
            gpui::anchored()
                .anchor(gpui::Anchor::TopRight)
                .position(gpui::point(bounds.right(), bounds.bottom() + px(10.)))
                .snap_to_window_with_margin(px(12.))
                .child(card),
        )
    }

    fn edit_redact(
        &mut self,
        change: impl FnOnce(&mut AutoRedactConfiguration) -> bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let changed =
            self.edit_timeline_project(|project| change(&mut project.auto_redact), window, cx);
        if changed {
            if self.tracks.redact != self.project.auto_redact.enabled {
                self.tracks.redact = self.project.auto_redact.enabled;
                self.rebuild_timeline();
            }
            self.note_edit("auto-redact", None);
            self.sync_redact(cx);
        }
    }

    pub(crate) fn set_redact_enabled(
        &mut self,
        on: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_redact(
            |config| {
                let changed = config.enabled != on;
                config.enabled = on;
                changed
            },
            window,
            cx,
        );
    }

    pub(crate) fn toggle_redact_category(
        &mut self,
        category: RedactCategory,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_redact(
            |config| {
                if let Some(at) = config.categories.iter().position(|c| *c == category) {
                    config.categories.remove(at);
                } else {
                    config.categories.push(category);
                    config.categories.sort();
                }
                true
            },
            window,
            cx,
        );
    }

    pub(crate) fn set_redact_style(
        &mut self,
        style: RedactStyle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_redact(
            |config| {
                let changed = config.style != style;
                config.style = style;
                changed
            },
            window,
            cx,
        );
    }

    /// Keeps one detection visible (or hides it again).
    pub(crate) fn set_redact_kept(
        &mut self,
        id: &str,
        kept: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = id.to_string();
        self.edit_redact(
            move |config| {
                let present = config.is_excluded(&id);
                if kept == present {
                    return false;
                }
                if kept {
                    config.excluded.push(id);
                } else {
                    config.excluded.retain(|other| *other != id);
                }
                true
            },
            window,
            cx,
        );
    }

    /// Per recording clip, how far its display video's timestamps run ahead
    /// of segment time.
    pub(crate) fn redact_video_offsets(&self) -> Vec<f64> {
        let Some(instance) = self.instance.as_ref() else {
            return Vec::new();
        };
        let meta = &instance.render_constants.meta;
        (0..instance.recordings.segments.len())
            .map(|clip| cap_rendering::display_video_offset(meta, clip))
            .collect()
    }

    /// Starts, keeps or stops the scan to match the project, and hands the
    /// renderer what is known. Called after every project change, undo and
    /// redo, and when the editor opens.
    pub(crate) fn sync_redact(&mut self, cx: &mut Context<Self>) {
        let Some(instance) = self.instance.clone() else {
            return;
        };
        let project_path = instance.project_path.clone();
        if self.redact.loaded_for.as_ref() != Some(&project_path) {
            self.redact.loaded_for = Some(project_path.clone());
            self.redact.redactions = Redactions::load(&project_path).map(Arc::new);
            instance
                .render_constants
                .redactions
                .set(self.redact.redactions.clone());
        }
        if !self.project.auto_redact.enabled {
            if let Some(job) = self.redact.job.take() {
                job.cancel();
            }
            self.redact.poll_task = None;
            if matches!(
                self.redact.phase,
                Some(JobPhase::Scanning | JobPhase::Preparing)
            ) {
                self.redact.phase = None;
            }
            return;
        }
        let complete = self
            .redact
            .redactions
            .as_ref()
            .is_some_and(|redactions| redactions.is_complete())
            && matches!(self.redact.phase, Some(JobPhase::Done));
        if self.redact.job.is_some() || complete {
            return;
        }
        let durations = instance
            .recordings
            .segments
            .iter()
            .map(|segment| segment.display.duration)
            .collect::<Vec<_>>();
        self.redact.job = Some(RedactJob::start(project_path, durations));
        self.redact.phase = Some(JobPhase::Preparing);
        self.redact.progress = 0.0;
        self.redact.poll_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(POLL).await;
                let running = this
                    .update(cx, |this, cx| this.poll_redact(cx))
                    .unwrap_or(false);
                if !running {
                    break;
                }
            }
        }));
        cx.notify();
    }

    /// Reads the scan's progress; returns whether it is still running.
    fn poll_redact(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(job) = self.redact.job.as_mut() else {
            return false;
        };
        let update = job.poll();
        let running = matches!(update.phase, JobPhase::Preparing | JobPhase::Scanning);
        let changed = self.redact.phase.as_ref() != Some(&update.phase)
            || (self.redact.progress - update.progress).abs() > 0.004
            || update.snapshot.is_some();
        self.redact.phase = Some(update.phase);
        self.redact.progress = update.progress;
        if let Some(snapshot) = update.snapshot {
            self.redact.redactions = Some(snapshot.clone());
            if let Some(instance) = &self.instance {
                instance.render_constants.redactions.set(Some(snapshot));
            }
            let video_offsets = self.redact_video_offsets();
            self.timeline.set_redact(
                &self.project,
                self.redact.redactions.as_deref(),
                &video_offsets,
            );
            self.publish_project();
        }
        if !running {
            self.redact.job = None;
            self.redact.poll_task = None;
        }
        if changed {
            cx.notify();
        }
        running
    }

    /// Why a video export must wait: auto redact is on and its scan has not
    /// finished and been saved (export renders from the saved detections),
    /// or the export would write the screen track on its own, which is never
    /// redacted.
    pub(crate) fn redact_export_blocker(&self, screen_track: bool) -> Option<&'static str> {
        if !self.project.auto_redact.enabled {
            return None;
        }
        if screen_track {
            return Some(tr::editor::redact::export_screen_track());
        }
        let saved =
            Redactions::load(&self.project_path).is_some_and(|redactions| redactions.is_complete());
        let running = matches!(
            self.redact.phase,
            Some(JobPhase::Preparing | JobPhase::Scanning)
        );
        if !saved || running {
            return Some(match self.redact.phase {
                Some(JobPhase::Failed(_)) => tr::editor::redact::export_failed(),
                _ => tr::editor::redact::export_wait(),
            });
        }
        None
    }

    /// Detections active within `start..end` of the timeline, with their
    /// category, after the category settings (exclusions included).
    pub(crate) fn redact_regions_between(
        &self,
        start: f64,
        end: f64,
    ) -> Vec<cap_project::redaction::RedactionRegion> {
        let Some(redactions) = self.redact.redactions.as_deref() else {
            return Vec::new();
        };
        let config = &self.project.auto_redact;
        let mut found = Vec::new();
        let video_offsets = self.redact_video_offsets();
        for (output_start, output_end, region) in
            crate::editor_timeline::redact_region_spans(&self.project, redactions, &video_offsets)
        {
            if output_end > start
                && output_start < end
                && config.has_category(region.category)
                && !found
                    .iter()
                    .any(|r: &cap_project::redaction::RedactionRegion| r.id == region.id)
            {
                found.push(region.clone());
            }
        }
        found
    }
}

impl EditorWindow {
    /// The selected redact spans' time ranges on the timeline.
    fn selected_redact_spans(&self) -> Vec<(f64, f64)> {
        let Some(selection) = self.selection.as_ref() else {
            return Vec::new();
        };
        if selection.track != TrackKind::Redact {
            return Vec::new();
        }
        selection
            .indices
            .iter()
            .filter_map(|index| self.timeline.redact.get(*index))
            .map(|segment| (segment.start, segment.end))
            .collect()
    }

    /// Outlines the selected span's detections on the preview.
    pub(crate) fn refresh_redact_highlight(&mut self) {
        let Some(instance) = self.instance.as_ref() else {
            return;
        };
        let ids = self
            .selected_redact_spans()
            .into_iter()
            .flat_map(|(start, end)| self.redact_regions_between(start, end))
            .map(|region| region.id)
            .collect::<Vec<_>>();
        if ids == self.redact.highlighted {
            return;
        }
        instance
            .render_constants
            .redactions
            .set_highlighted(ids.clone());
        self.redact.highlighted = ids;
        self.publish_project();
    }

    /// The sidebar for selected redact spans: what is hidden there, by
    /// category, each with a switch to keep it visible.
    pub(crate) fn render_redact_panel(
        &self,
        selection: &Selection,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let editor = theme.editor;
        let config = &self.project.auto_redact;
        let header = ui::SelectionHeader::plain(
            &theme,
            "panel-redact",
            SharedString::from(tr::editor::redact::panel_title()),
        )
        .on_done(cx.listener(|this, _, _window, cx| this.set_selection(None, cx)));
        let mut regions = Vec::new();
        for index in &selection.indices {
            let Some(segment) = self.timeline.redact.get(*index) else {
                continue;
            };
            for region in self.redact_regions_between(segment.start, segment.end) {
                if !regions
                    .iter()
                    .any(|r: &cap_project::redaction::RedactionRegion| r.id == region.id)
                {
                    regions.push(region);
                }
            }
        }
        regions.sort_by(|a, b| {
            a.category
                .cmp(&b.category)
                .then(a.start.total_cmp(&b.start))
        });
        let mut body = div().flex().flex_col().gap(px(14.)).child(header);
        if regions.is_empty() {
            return body
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(Hsla::from(editor.text_2))
                        .child(tr::editor::redact::panel_empty()),
                )
                .into_any_element();
        }
        let mut categories = regions.iter().map(|r| r.category).collect::<Vec<_>>();
        categories.dedup();
        for category in categories {
            let enabled = config.has_category(category);
            let mut group = div().flex().flex_col().gap(px(2.)).child(
                div()
                    .id(SharedString::from(format!(
                        "redact-panel-category-{}",
                        category.as_str()
                    )))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .h(px(28.))
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.toggle_redact_category(category, window, cx);
                    }))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(editor.text_1))
                            .child(category_label(category)),
                    )
                    .child(redact_switch(&theme, enabled)),
            );
            for region in regions.iter().filter(|r| r.category == category) {
                let kept = config.is_excluded(&region.id);
                let id = region.id.clone();
                let span = format!(
                    "{}\u{2013}{}",
                    format_redact_time(region.start),
                    format_redact_time(region.end)
                );
                group = group.child(
                    div()
                        .id(SharedString::from(format!("redact-region-{}", region.id)))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.))
                        .h(px(26.))
                        .px(px(6.))
                        .rounded(px(7.))
                        .cursor_pointer()
                        .hover(|style| style.bg(Hsla::from(editor.ctl_hover)))
                        .when(!enabled, |this| this.opacity(0.5))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.set_redact_kept(&id, !kept, window, cx);
                        }))
                        .child(
                            svg()
                                .path(if kept {
                                    "icons/eye.svg"
                                } else {
                                    "icons/eye-off.svg"
                                })
                                .size(px(13.))
                                .flex_none()
                                .text_color(Hsla::from(if kept {
                                    editor.text_2
                                } else {
                                    editor.accent_ink
                                })),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(px(12.))
                                .text_color(Hsla::from(editor.text_1))
                                .child(span),
                        )
                        .child(
                            div()
                                .text_size(px(11.))
                                .text_color(Hsla::from(editor.text_2))
                                .child(if kept {
                                    tr::editor::redact::kept()
                                } else {
                                    tr::editor::redact::keep()
                                }),
                        ),
                );
            }
            body = body.child(group);
        }
        body.into_any_element()
    }
}

fn format_redact_time(seconds: f64) -> String {
    let seconds = seconds.max(0.0);
    let minutes = (seconds / 60.0).floor();
    format!("{}:{:04.1}", minutes as u64, seconds - minutes * 60.0)
}
