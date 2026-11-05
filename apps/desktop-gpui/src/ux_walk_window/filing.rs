//! The notes window's project, filing and glossary surfaces for a processed recording: the project bar (assign
//! or change the recording's project), "File N items in <tracker>" on the Items tab, and the glossary
//! suggestions on the Notes tab. Every write goes through the native-walk bridge and only after a click.

use super::{WalkWindow, items};
use crate::{
    ui,
    ux_walk_filing::{
        FileGate, FileOutcome, Handoff, Projects, Suggestions, file_gate, file_label, items_word,
        reprocess_for_glossary,
    },
};
use gpui::{
    AnyElement, Bounds, Context, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, SharedString, StatefulInteractiveElement as _, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};
use std::path::{Path, PathBuf};

struct ProjectMenu {
    ids: Vec<Option<String>>,
    state: ui::MenuState,
}

#[derive(Default)]
pub(super) struct FilingState {
    file: Option<PathBuf>,
    handoff: Option<Handoff>,
    projects: Option<Projects>,
    suggestions: Option<Suggestions>,
    loading: bool,
    busy: Option<&'static str>,
    outcome: Option<FileOutcome>,
    error: Option<String>,
    notice: Option<String>,
    reprocess_hint: Option<String>,
    menu: Option<ProjectMenu>,
    revision: u64,
}

impl FilingState {
    pub(super) fn shows(&self, file: &Path) -> bool {
        self.file.as_deref() == Some(file)
    }

    fn reset(&mut self, file: PathBuf) {
        *self = Self {
            file: Some(file),
            revision: self.revision.wrapping_add(1),
            ..Self::default()
        };
    }
}

/// Runs a bridge command whose argument is a request file (`file`, `glossary-*`, `assign-project`).
fn run_request(command: &str, body: serde_json::Value) -> Result<String, String> {
    let request = std::env::temp_dir().join(format!(
        "ux-walk-{command}-{}.json",
        crate::store::new_uuid_v4()
    ));
    std::fs::write(
        &request,
        serde_json::to_vec(&body).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Could not stage the request: {error}"))?;
    let result = crate::ux_walk::run_engine(command, &request);
    let _ = std::fs::remove_file(&request);
    result
}

fn muted(theme: &crate::theme::Theme, text: impl Into<SharedString>) -> gpui::Div {
    div()
        .text_size(px(12.))
        .line_height(px(18.))
        .text_color(theme.gray_10)
        .child(text.into())
}

impl WalkWindow {
    pub(super) fn ensure_filing(
        &mut self,
        file: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.filing.shows(&file) && (self.filing.loading || self.filing.handoff.is_some()) {
            return;
        }
        self.load_filing(file, window, cx);
    }

    /// Loads the recording's project, the project list and the glossary suggestions together.
    pub(super) fn load_filing(
        &mut self,
        file: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.filing.shows(&file) {
            self.filing.reset(file.clone());
        }
        self.filing.revision = self.filing.revision.wrapping_add(1);
        let revision = self.filing.revision;
        self.filing.loading = true;
        cx.spawn_in(window, async move |this, cx| {
            let requested = file.clone();
            let (handoff, projects, suggestions) = cx
                .background_executor()
                .spawn(async move {
                    let handoff = crate::ux_walk::run_engine("handoff-ask", &file)
                        .and_then(|output| Handoff::parse(&output));
                    let projects = crate::ux_walk::run_engine("projects", Path::new("-"))
                        .and_then(|output| Projects::parse(&output));
                    let suggestions = crate::ux_walk::run_engine("glossary-suggestions", &file)
                        .and_then(|output| Suggestions::parse(&output));
                    (handoff, projects, suggestions)
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                if this.filing.revision != revision || !this.filing.shows(&requested) {
                    return;
                }
                this.filing.loading = false;
                let mut problems = Vec::new();
                match handoff {
                    Ok(handoff) => this.filing.handoff = Some(handoff),
                    Err(error) => {
                        problems.push(format!("Could not read the recording's project: {error}"))
                    }
                }
                match projects {
                    Ok(projects) => this.filing.projects = Some(projects),
                    Err(error) => problems.push(format!("Could not list projects: {error}")),
                }
                match suggestions {
                    Ok(suggestions) => this.filing.suggestions = Some(suggestions),
                    Err(error) => {
                        problems.push(format!("Could not read glossary suggestions: {error}"))
                    }
                }
                this.filing.error = (!problems.is_empty()).then(|| problems.join(" "));
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    fn filing_target(&self) -> Option<PathBuf> {
        let file = self.items.file.clone()?;
        self.filing.shows(&file).then_some(file)
    }

    /// The File button: save edits first (asked), then a dry run, then a confirm, then the real run.
    pub(super) fn start_filing(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(file) = self.filing_target() else {
            return;
        };
        if self.filing.busy.is_some() || self.items.saving {
            return;
        }
        let (Some(handoff), Some(editor)) =
            (self.filing.handoff.as_ref(), self.items.editor.as_ref())
        else {
            return;
        };
        let keys = editor.file_keys();
        match file_gate(handoff, keys.len(), editor.dirty()) {
            FileGate::SaveFirst(_) => {
                self.settle_items(
                    true,
                    Box::new(|this, window, cx| this.start_filing(window, cx)),
                    window,
                    cx,
                );
                return;
            }
            FileGate::Ready(_) => {}
            _ => return,
        }
        self.filing.busy = Some("Checking what will be filed…");
        self.filing.error = None;
        self.filing.outcome = None;
        let revision = self.filing.revision;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let requested = file.clone();
            let request_keys = keys.clone();
            let preview = cx
                .background_executor()
                .spawn(async move {
                    run_request(
                        "file",
                        serde_json::json!({ "journal": file, "keys": request_keys, "dryRun": true }),
                    )
                    .and_then(|output| FileOutcome::parse(&output))
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                if this.filing.revision != revision || !this.filing.shows(&requested) {
                    return;
                }
                this.filing.busy = None;
                match preview {
                    Ok(preview) if preview.filed.is_empty() => {
                        this.filing.notice = Some(if preview.skipped.is_empty() {
                            "Nothing to file.".into()
                        } else {
                            format!(
                                "Nothing to file: {} chosen {} already linked.",
                                preview.skipped.len(),
                                if preview.skipped.len() == 1 { "item is" } else { "items are" }
                            )
                        });
                        this.load_items(requested.clone(), window, cx);
                    }
                    Ok(preview) => this.confirm_filing(requested.clone(), keys, preview, window, cx),
                    Err(error) => this.filing.error = Some(format!("Could not prepare filing: {error}")),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn confirm_filing(
        &mut self,
        file: PathBuf,
        keys: Vec<String>,
        preview: FileOutcome,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (title, detail) = preview.preview();
        let n = preview.filed.len();
        let confirm = items::confirm(
            &title,
            &detail,
            &format!("File {n} {}", items_word(n)),
            "Cancel",
            window,
            cx,
        );
        let revision = self.filing.revision;
        cx.spawn_in(window, async move |this, cx| {
            if !confirm.await {
                return;
            }
            this.update_in(cx, |this, window, cx| {
                if this.filing.revision != revision || !this.filing.shows(&file) {
                    return;
                }
                this.run_filing(file, keys, window, cx);
            })
            .ok();
        })
        .detach();
    }

    fn run_filing(
        &mut self,
        file: PathBuf,
        keys: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.items.dirty() {
            self.filing.error =
                Some("Items changed after the preview. Save them and file again.".into());
            cx.notify();
            return;
        }
        self.filing.busy = Some("Filing…");
        self.filing.notice = None;
        let revision = self.filing.revision;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let requested = file.clone();
            let result = cx
                .background_executor()
                .spawn(async move {
                    run_request("file", serde_json::json!({ "journal": file, "keys": keys }))
                        .and_then(|output| FileOutcome::parse(&output))
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                if this.filing.revision != revision || !this.filing.shows(&requested) {
                    return;
                }
                this.filing.busy = None;
                match result {
                    Ok(outcome) => this.filing.outcome = Some(outcome),
                    Err(error) => {
                        this.filing.error = Some(format!("Could not file the items: {error}"))
                    }
                }
                // Refs land in the ledger even when some items failed: show them on each item.
                if this.items.shows(&requested) {
                    this.load_items(requested.clone(), window, cx);
                }
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    fn open_project_menu(&mut self, bounds: Bounds<Pixels>, cx: &mut Context<Self>) {
        let Some(projects) = self.filing.projects.as_ref() else {
            return;
        };
        let current = self
            .filing
            .handoff
            .as_ref()
            .and_then(|handoff| handoff.project_id().map(str::to_string));
        let mut ids: Vec<Option<String>> = vec![None];
        let mut items = vec![ui::MenuItem::new("No project", current.is_none())];
        for project in &projects.projects {
            ids.push(Some(project.id.clone()));
            let label = match &project.tracker {
                Some(tracker) => format!("{} · {}", project.name, tracker.label()),
                None => project.name.clone(),
            };
            items.push(ui::MenuItem::new(
                label,
                current.as_deref() == Some(project.id.as_str()),
            ));
        }
        self.filing.menu = Some(ProjectMenu {
            ids,
            state: ui::MenuState::anchored(bounds, &items),
        });
        cx.notify();
    }

    fn assign_project(&mut self, id: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(file) = self.filing.file.clone() else {
            return;
        };
        let before = self
            .filing
            .handoff
            .as_ref()
            .and_then(|handoff| handoff.project_id().map(str::to_string));
        if before == id || self.filing.busy.is_some() {
            return;
        }
        self.filing.busy = Some("Changing project…");
        self.filing.error = None;
        self.filing.notice = None;
        let revision = self.filing.revision;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let requested = file.clone();
            let chosen = id.clone();
            let result = cx
                .background_executor()
                .spawn(async move {
                    let handoff = run_request(
                        "assign-project",
                        serde_json::json!({ "journal": file, "project": chosen }),
                    )
                    .and_then(|output| Handoff::parse(&output))?;
                    // The glossary accepts go to the new project's glossary now.
                    let suggestions = crate::ux_walk::run_engine("glossary-suggestions", &file)
                        .and_then(|output| Suggestions::parse(&output))
                        .ok();
                    Ok::<_, String>((handoff, suggestions))
                })
                .await;
            this.update_in(cx, |this, _, cx| {
                if this.filing.revision != revision || !this.filing.shows(&requested) {
                    return;
                }
                this.filing.busy = None;
                match result {
                    Ok((handoff, suggestions)) => {
                        let projects = this.filing.projects.as_ref();
                        let old = before.as_deref().and_then(|id| projects?.find(id));
                        let new = id.as_deref().and_then(|id| projects?.find(id));
                        this.filing.notice = Some(match handoff.project_name() {
                            Some(name) => format!(
                                "Moved to {name}. Filing and glossary accepts use it; the notes are not reprocessed."
                            ),
                            None => "Removed from its project. The notes are not reprocessed.".into(),
                        });
                        this.filing.reprocess_hint = reprocess_for_glossary(old, new).then(|| {
                            format!(
                                "{} has its own glossary. Reprocess so the transcript uses its spellings.",
                                new.map_or("This project".to_string(), |project| project.name.clone())
                            )
                        });
                        this.filing.handoff = Some(handoff);
                        if let Some(suggestions) = suggestions {
                            this.filing.suggestions = Some(suggestions);
                        }
                        this.filing.outcome = None;
                    }
                    Err(error) => this.filing.error = Some(format!("Could not change the project: {error}")),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// terms None: accept every pending suggestion.
    fn decide_terms(
        &mut self,
        accept: bool,
        terms: Option<Vec<String>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(file) = self.filing.file.clone() else {
            return;
        };
        if self.filing.busy.is_some() {
            return;
        }
        self.filing.busy = Some(if accept {
            "Adding to the glossary…"
        } else {
            "Rejecting…"
        });
        self.filing.error = None;
        let revision = self.filing.revision;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let requested = file.clone();
            let result = cx
                .background_executor()
                .spawn(async move {
                    let terms = terms.map_or(serde_json::json!("all"), |terms| serde_json::json!(terms));
                    run_request(
                        if accept { "glossary-accept" } else { "glossary-reject" },
                        serde_json::json!({ "journal": file, "terms": terms }),
                    )
                    .and_then(|output| Suggestions::parse(&output))
                })
                .await;
            this.update_in(cx, |this, _, cx| {
                if this.filing.revision != revision || !this.filing.shows(&requested) {
                    return;
                }
                this.filing.busy = None;
                match result {
                    Ok(suggestions) => {
                        this.filing.suggestions = Some(suggestions);
                        if accept {
                            this.filing.reprocess_hint = Some(
                                "Glossary updated. Reprocess so the transcript picks up the spelling.".into(),
                            );
                        }
                    }
                    Err(error) => this.filing.error = Some(format!("Could not update the glossary: {error}")),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn reprocess_from_hint(&mut self, file: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        self.filing.reprocess_hint = None;
        if self.selection.file.is_some() {
            self.reprocess_saved(file, false, window, cx);
        } else {
            self.save_items_then(
                file.clone(),
                Box::new(move |this, _, cx| {
                    if this.items.shows(&file) {
                        this.items.forget();
                    }
                    this.session
                        .update(cx, |session, cx| session.process_walk(cx));
                }),
                window,
                cx,
            );
        }
        cx.notify();
    }

    fn project_select(&self, id: &'static str, cx: &mut Context<Self>) -> AnyElement {
        let label = match self.filing.handoff.as_ref() {
            Some(handoff) => handoff.project_name().unwrap_or("No project").to_string(),
            None => "Loading…".into(),
        };
        ui::Select::settings(&self.theme, id, label)
            .disabled(self.filing.projects.is_none() || self.filing.busy.is_some())
            .on_open(cx.listener(|this, bounds: &Bounds<Pixels>, _, cx| {
                this.open_project_menu(*bounds, cx)
            }))
            .into_any_element()
    }

    /// The header line: the recording's project with a picker, and where its items are filed.
    pub(super) fn render_project_bar(&self, file: PathBuf, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        if !self.filing.shows(&file) {
            return muted(&theme, "Loading project…").into_any_element();
        }
        let tracker = self.filing.handoff.as_ref().map(|handoff| {
            match (&handoff.project, &handoff.tracker) {
                (Some(_), Some(tracker)) => format!("Files to {}", tracker.label()),
                (Some(_), None) => "No tracker set for this project".into(),
                (None, _) => "Choose a project to file items and keep its glossary".into(),
            }
        });
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.gray_11)
                            .child("Project"),
                    )
                    .child(self.project_select("walk-project", cx))
                    .when_some(tracker, |this, tracker| {
                        this.child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(px(11.))
                                .text_color(theme.gray_10)
                                .child(tracker),
                        )
                    }),
            )
            .when_some(self.filing.busy, |this, busy| {
                this.child(muted(&theme, busy))
            })
            .when_some(self.filing.notice.clone(), |this, notice| {
                this.child(muted(&theme, notice))
            })
            .when_some(self.filing.reprocess_hint.clone(), |this, hint| {
                let disabled = self.session.read(cx).phase != crate::session::Phase::Idle
                    || self.reprocessing.contains(&file);
                this.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .p(px(8.))
                        .rounded(px(8.))
                        .bg(theme.amber_3)
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(px(12.))
                                .text_color(theme.amber_11)
                                .child(hint),
                        )
                        .child(
                            ui::Button::plain(
                                &theme,
                                "walk-filing-reprocess",
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Xs,
                            )
                            .label("Reprocess")
                            .disabled(disabled)
                            .on_click(cx.listener(
                                move |this, _, window, cx| {
                                    this.reprocess_from_hint(file.clone(), window, cx)
                                },
                            )),
                        )
                        .child(
                            ui::Button::plain(
                                &theme,
                                "walk-filing-reprocess-later",
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Xs,
                            )
                            .label("Later")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.filing.reprocess_hint = None;
                                cx.notify();
                            })),
                        ),
                )
            })
            .when_some(self.filing.error.clone(), |this, error| {
                this.child(
                    div()
                        .text_size(px(12.))
                        .text_color(theme.red_9)
                        .child(error),
                )
            })
            .into_any_element()
    }

    pub(super) fn render_project_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.filing.menu.as_ref()?;
        let projects = self.filing.projects.as_ref()?;
        let current = self
            .filing
            .handoff
            .as_ref()
            .and_then(|handoff| handoff.project_id().map(str::to_string));
        let items = menu
            .ids
            .iter()
            .map(|id| {
                let label = match id.as_deref().and_then(|id| projects.find(id)) {
                    Some(project) => match &project.tracker {
                        Some(tracker) => format!("{} · {}", project.name, tracker.label()),
                        None => project.name.clone(),
                    },
                    None => "No project".into(),
                };
                ui::MenuItem::new(label, *id == current)
            })
            .collect();
        Some(
            ui::Menu::plain(&self.theme, "walk-project-menu", items, &menu.state)
                .min_width(px(220.))
                .on_select(cx.listener(|this, index: &usize, window, cx| {
                    if let Some(menu) = this.filing.menu.take()
                        && let Some(id) = menu.ids.get(*index)
                    {
                        this.assign_project(id.clone(), window, cx);
                    }
                    cx.notify();
                }))
                .on_dismiss(cx.listener(|this, _, _, cx| {
                    this.filing.menu = None;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }

    /// The Items tab's filing bar: the File button, or why it cannot file yet, and the last run's results.
    pub(super) fn render_file_bar(
        &self,
        editable: bool,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let theme = self.theme;
        self.filing_target()?;
        let editor = self.items.editor.as_ref()?;
        let handoff = self.filing.handoff.as_ref()?;
        let chosen = editor.file_keys().len();
        let gate = file_gate(handoff, chosen, editor.dirty());
        let busy = self.filing.busy.is_some() || self.items.saving;
        let explain = match &gate {
            FileGate::NoProject => Some(
                "This recording is in no project, so there is no tracker to file into. Choose a project:"
                    .to_string(),
            ),
            FileGate::NoTracker(name) => Some(format!(
                "{name} has no issue tracker. Set one in Settings › Projects, or choose another project:"
            )),
            _ => None,
        };
        let button_label = match &gate {
            FileGate::NothingChosen => "Choose items to file".to_string(),
            FileGate::SaveFirst(n) | FileGate::Ready(n) => file_label(handoff, *n),
            _ => String::new(),
        };
        let outcome = self.filing.outcome.clone();
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .p(px(10.))
                .rounded(px(8.))
                .bg(theme.gray_2)
                .border_1()
                .border_color(theme.gray_4)
                .when_some(explain.clone(), |this, explain| {
                    this.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .text_size(px(12.))
                                    .text_color(theme.gray_11)
                                    .child(explain),
                            )
                            .child(self.project_select("walk-file-project", cx)),
                    )
                })
                .when(explain.is_none(), |this| {
                    this.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .text_size(px(11.))
                                    .text_color(theme.gray_10)
                                    .child(match gate {
                                        FileGate::SaveFirst(_) => {
                                            "Unsaved edits are saved before filing.".to_string()
                                        }
                                        _ => "Tick the items to file. Nothing is created until you confirm."
                                            .to_string(),
                                    }),
                            )
                            .child(
                                ui::Button::plain(
                                    &theme,
                                    "walk-file-items",
                                    ui::ButtonVariant::Blue,
                                    ui::ButtonSize::Sm,
                                )
                                .label(self.filing.busy.map_or(button_label, str::to_string))
                                .disabled(
                                    busy || !editable
                                        || !matches!(gate, FileGate::Ready(_) | FileGate::SaveFirst(_)),
                                )
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.start_filing(window, cx)
                                })),
                            ),
                    )
                })
                .when_some(outcome, |this, outcome| this.child(self.render_outcome(outcome, cx)))
                .into_any_element(),
        )
    }

    fn render_outcome(&self, outcome: FileOutcome, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_col()
            .gap(px(3.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .child(outcome.summary()),
                    )
                    .child(
                        ui::Button::plain(
                            &theme,
                            "walk-file-results-close",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Xs,
                        )
                        .label("Close")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.filing.outcome = None;
                            cx.notify();
                        })),
                    ),
            )
            .children(outcome.filed.iter().map(|item| {
                let reference = item.reference.clone().unwrap_or_default();
                div()
                    .flex()
                    .gap(px(6.))
                    .text_size(px(11.))
                    .child(div().text_color(theme.gray_11).child("Filed"))
                    .child(ref_link(
                        &theme,
                        format!("walk-filed-{}", item.key),
                        reference,
                        item.link().map(str::to_string),
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_color(theme.gray_10)
                            .child(item.title.clone()),
                    )
            }))
            .children(outcome.skipped.iter().map(|item| {
                div()
                    .text_size(px(11.))
                    .text_color(theme.gray_10)
                    .child(format!(
                        "Skipped, already linked{}: {}",
                        if item.refs.is_empty() {
                            String::new()
                        } else {
                            format!(" ({})", item.refs.join(", "))
                        },
                        item.title
                    ))
            }))
            .children(outcome.failed.iter().map(|item| {
                div()
                    .text_size(px(11.))
                    .text_color(theme.red_9)
                    .child(format!("Failed: {} — {}", item.title, item.error))
            }))
            .into_any_element()
    }

    /// The Notes tab's glossary suggestions: pending ones with Accept / Reject, the done count, and where
    /// accepted terms are written.
    pub(super) fn render_glossary(
        &self,
        file: PathBuf,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let theme = self.theme;
        if !self.filing.shows(&file) {
            return None;
        }
        let suggestions = self
            .filing
            .suggestions
            .as_ref()
            .filter(|list| !list.is_empty())?;
        let pending: Vec<_> = suggestions.pending().into_iter().cloned().collect();
        let (accepted, rejected) = suggestions.done();
        let busy = self.filing.busy.is_some();
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .p(px(10.))
                .rounded(px(8.))
                .bg(theme.gray_2)
                .border_1()
                .border_color(theme.gray_4)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("Glossary suggestions"),
                        )
                        .when(pending.len() > 1, |this| {
                            this.child(
                                ui::Button::plain(
                                    &theme,
                                    "walk-glossary-accept-all",
                                    ui::ButtonVariant::Gray,
                                    ui::ButtonSize::Xs,
                                )
                                .label("Accept all")
                                .disabled(busy)
                                .on_click(cx.listener(
                                    |this, _, window, cx| this.decide_terms(true, None, window, cx),
                                )),
                            )
                        }),
                )
                .child(muted(&theme, suggestions.target_line()))
                .children(pending.into_iter().enumerate().map(|(index, suggestion)| {
                    let accept_term = suggestion.term.clone();
                    let reject_term = suggestion.term.clone();
                    div()
                        .flex()
                        .items_start()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .flex_1()
                                .min_w_0()
                                .gap(px(2.))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .child(suggestion.term.clone()),
                                )
                                .child(div().text_size(px(11.)).text_color(theme.gray_10).child(
                                    if suggestion.wrongs.is_empty() {
                                        suggestion.source_label().to_string()
                                    } else {
                                        format!(
                                            "Heard as {} · {}",
                                            suggestion.wrongs.join(", "),
                                            suggestion.source_label()
                                        )
                                    },
                                ))
                                .when_some(suggestion.evidence_line(), |this, line| {
                                    this.child(
                                        div()
                                            .text_size(px(11.))
                                            .text_color(theme.gray_10)
                                            .child(line),
                                    )
                                }),
                        )
                        .child(
                            ui::Button::plain(
                                &theme,
                                SharedString::from(format!("walk-glossary-accept-{index}")),
                                ui::ButtonVariant::Blue,
                                ui::ButtonSize::Xs,
                            )
                            .label("Accept")
                            .disabled(busy)
                            .on_click(cx.listener(
                                move |this, _, window, cx| {
                                    this.decide_terms(
                                        true,
                                        Some(vec![accept_term.clone()]),
                                        window,
                                        cx,
                                    )
                                },
                            )),
                        )
                        .child(
                            ui::Button::plain(
                                &theme,
                                SharedString::from(format!("walk-glossary-reject-{index}")),
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Xs,
                            )
                            .label("Reject")
                            .disabled(busy)
                            .on_click(cx.listener(
                                move |this, _, window, cx| {
                                    this.decide_terms(
                                        false,
                                        Some(vec![reject_term.clone()]),
                                        window,
                                        cx,
                                    )
                                },
                            )),
                        )
                }))
                .when(accepted + rejected > 0, |this| {
                    this.child(muted(
                        &theme,
                        format!("Done: {accepted} accepted · {rejected} rejected"),
                    ))
                })
                .into_any_element(),
        )
    }

    /// The tick box filing uses; linked and deleted items get a dimmed box that cannot be ticked.
    pub(super) fn render_file_box(
        &self,
        key: &str,
        fileable: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let chosen = self
            .items
            .editor
            .as_ref()
            .is_some_and(|editor| editor.chosen_for_file(key));
        let toggle = key.to_string();
        div()
            .id(SharedString::from(format!("walk-item-file-{key}")))
            .flex_shrink_0()
            .size(px(14.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(3.))
            .border_1()
            .border_color(if chosen { theme.blue_9 } else { theme.gray_7 })
            .when(chosen, |this| this.bg(theme.blue_9))
            .when(!fileable, |this| this.opacity(0.35))
            .text_size(px(10.))
            .text_color(gpui::white())
            .when(chosen, |this| this.child("✓"))
            .when(fileable, |this| {
                this.cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(editor) = this.items.editor.as_mut() {
                            editor.toggle_file(&toggle);
                        }
                        cx.notify();
                    }))
            })
            .into_any_element()
    }
}

/// A ref that opens its issue when it has a web address, else the ref text.
pub(super) fn ref_link(
    theme: &crate::theme::Theme,
    id: String,
    reference: String,
    url: Option<String>,
) -> AnyElement {
    match url {
        Some(url) => div()
            .id(SharedString::from(id))
            .flex_shrink_0()
            .text_color(theme.blue_11)
            .underline()
            .cursor_pointer()
            .child(reference)
            .on_click(move |_, _, cx| cx.open_url(&url))
            .into_any_element(),
        None => div()
            .flex_shrink_0()
            .text_color(theme.gray_11)
            .child(reference)
            .into_any_element(),
    }
}
