//! Settings for projects and issue tracker accounts, beside the walk settings.
//!
//! Every change goes through the walk engine (`crate::ux_walk_projects`), which validates
//! project files and reports problems; its refusals show inline under the field they name.
//! Tracker keys go to the login Keychain the same way transcription keys do.

use gpui::{
    AppContext as _, Context, Entity, Hsla, IntoElement, ParentElement, Styled, Window, div,
    prelude::FluentBuilder, px,
};

use crate::{
    settings_window::{MenuKind, SettingsWindow},
    ui,
    ux_walk_projects::{
        self as projects, Draft, DraftField, DraftText, Import, ProjectList, Target, TrackerStatus,
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProjectMenu {
    Default,
    Glossary,
    Provider,
    Target,
    ImportProvider,
}

pub(crate) struct ProjectsSettings {
    list: Option<ProjectList>,
    list_error: Option<String>,
    trackers: Option<Result<Vec<TrackerStatus>, String>>,
    draft: Option<Draft>,
    inputs: Vec<Entity<ui::TextInputState>>,
    /// The inputs' text, kept in step so menus (which have no `App`) can read it.
    text: DraftText,
    /// The editor's tracker targets: `None` while loading or before a tracker is chosen.
    targets: Option<Result<Vec<Target>, String>>,
    import: Option<Import>,
    confirm_delete: Option<String>,
    key_busy: bool,
    notice: Option<String>,
    _subscriptions: Vec<gpui::Subscription>,
}

impl ProjectsSettings {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<SettingsWindow>) -> Self {
        let mut subscriptions = Vec::new();
        let inputs = DraftField::ALL
            .iter()
            .enumerate()
            .map(|(index, field)| {
                let input = cx.new(|cx| {
                    let mut input = ui::TextInputState::single_line(window, cx);
                    input.set_placeholder(field.placeholder());
                    input
                });
                subscriptions.push(cx.subscribe(
                    &input,
                    move |this: &mut SettingsWindow, input, event, cx| {
                        if matches!(event, ui::TextInputEvent::Changed) {
                            this.ux_walk.projects.text[index] = input.read(cx).text().to_string();
                            cx.notify();
                        }
                    },
                ));
                input
            })
            .collect();
        Self {
            list: None,
            list_error: None,
            trackers: None,
            draft: None,
            inputs,
            text: Default::default(),
            targets: None,
            import: None,
            confirm_delete: None,
            key_busy: false,
            notice: None,
            _subscriptions: subscriptions,
        }
    }

    fn projects(&self) -> &[projects::Project] {
        self.list
            .as_ref()
            .map_or(&[], |list| list.projects.as_slice())
    }

    fn known_trackers(&self) -> Vec<(String, String)> {
        match &self.trackers {
            Some(Ok(trackers)) if !trackers.is_empty() => trackers
                .iter()
                .map(|tracker| (tracker.id.clone(), tracker.name.clone()))
                .collect(),
            _ => [
                ("beads", "Beads"),
                ("github", "GitHub Issues"),
                ("linear", "Linear"),
            ]
            .iter()
            .map(|(id, name)| (id.to_string(), name.to_string()))
            .collect(),
        }
    }

    fn tracker_name(&self, id: &str) -> String {
        self.known_trackers()
            .into_iter()
            .find(|(known, _)| known == id)
            .map_or_else(|| id.to_string(), |(_, name)| name)
    }
}

impl SettingsWindow {
    fn projects(&self) -> &ProjectsSettings {
        &self.ux_walk.projects
    }

    fn projects_mut(&mut self) -> &mut ProjectsSettings {
        &mut self.ux_walk.projects
    }

    /// Reloads the project list and tracker status; called when the walk settings open.
    pub(crate) fn ux_walk_projects_refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.projects_reload_list(window, cx);
        self.projects_reload_trackers(window, cx);
    }

    fn projects_reload_list(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { projects::list() })
                .await;
            this.update_in(cx, |this, window, cx| {
                let state = this.projects_mut();
                match result {
                    Ok(list) => {
                        state.list = Some(list);
                        state.list_error = None;
                    }
                    Err(error) => state.list_error = Some(error),
                }
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    fn projects_reload_trackers(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { projects::trackers() })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.projects_mut().trackers = Some(result);
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    fn projects_text(&self, field: DraftField) -> &str {
        &self.projects().text[field.index()]
    }

    fn projects_set_text(&mut self, text: DraftText, cx: &mut Context<Self>) {
        for field in DraftField::ALL {
            self.projects_set_field(field, text[field.index()].clone(), cx);
        }
    }

    fn projects_set_field(&mut self, field: DraftField, value: String, cx: &mut Context<Self>) {
        let input = self.projects().inputs[field.index()].clone();
        self.projects_mut().text[field.index()] = value.clone();
        input.update(cx, |input, cx| input.set_text(value, cx));
    }

    fn projects_open_editor(
        &mut self,
        draft: Draft,
        text: DraftText,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let provider = draft.provider.clone();
        let state = self.projects_mut();
        state.import = None;
        state.confirm_delete = None;
        state.targets = None;
        state.draft = Some(draft);
        self.projects_set_text(text, cx);
        if let Some(provider) = provider {
            self.projects_load_targets(provider, false, window, cx);
        }
        cx.notify();
    }

    fn projects_load_targets(
        &mut self,
        provider: String,
        import: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.spawn_in(window, async move |this, cx| {
            let wanted = provider.clone();
            let result = cx
                .background_executor()
                .spawn(async move { projects::targets(&wanted) })
                .await;
            this.update_in(cx, |this, window, cx| {
                let state = this.projects_mut();
                if import {
                    if let Some(import) = state
                        .import
                        .as_mut()
                        .filter(|import| import.provider.as_deref() == Some(provider.as_str()))
                    {
                        import.targets = Some(result);
                    }
                } else if state
                    .draft
                    .as_ref()
                    .is_some_and(|draft| draft.provider.as_deref() == Some(provider.as_str()))
                {
                    state.targets = Some(result);
                }
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn ux_walk_projects_menu_items(&self, menu: ProjectMenu) -> Vec<ui::MenuItem> {
        let state = self.projects();
        let none = |checked: bool, label: &'static str| ui::MenuItem::new(label, checked);
        match menu {
            ProjectMenu::Default => {
                let current = state.list.as_ref().and_then(|list| list.default.clone());
                std::iter::once(none(current.is_none(), projects::NO_PROJECT))
                    .chain(state.projects().iter().map(|project| {
                        ui::MenuItem::new(
                            project.name.clone(),
                            current.as_deref() == Some(project.id.as_str()),
                        )
                    }))
                    .collect()
            }
            ProjectMenu::Glossary => {
                let current = self.projects_text(DraftField::Glossary).to_string();
                let glossaries = state
                    .list
                    .as_ref()
                    .map_or(&[][..], |list| list.glossaries.as_slice());
                std::iter::once(none(current.is_empty(), "No glossary"))
                    .chain(
                        glossaries
                            .iter()
                            .map(|name| ui::MenuItem::new(name.clone(), *name == current)),
                    )
                    .collect()
            }
            ProjectMenu::Provider => {
                let current = state
                    .draft
                    .as_ref()
                    .and_then(|draft| draft.provider.clone());
                std::iter::once(none(current.is_none(), "No tracker"))
                    .chain(state.known_trackers().into_iter().map(|(id, name)| {
                        ui::MenuItem::new(name, current.as_deref() == Some(id.as_str()))
                    }))
                    .collect()
            }
            ProjectMenu::Target => {
                let current = self.projects_text(DraftField::Target).to_string();
                match &state.targets {
                    Some(Ok(targets)) => targets
                        .iter()
                        .map(|target| ui::MenuItem::new(target.name.clone(), target.id == current))
                        .collect(),
                    _ => Vec::new(),
                }
            }
            ProjectMenu::ImportProvider => {
                let current = state
                    .import
                    .as_ref()
                    .and_then(|import| import.provider.clone());
                state
                    .known_trackers()
                    .into_iter()
                    .map(|(id, name)| {
                        ui::MenuItem::new(name, current.as_deref() == Some(id.as_str()))
                    })
                    .collect()
            }
        }
    }

    pub(crate) fn ux_walk_projects_choose(
        &mut self,
        menu: ProjectMenu,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match menu {
            ProjectMenu::Default => {
                let id = match index {
                    0 => None,
                    index => match self.projects().projects().get(index - 1) {
                        Some(project) => Some(project.id.clone()),
                        None => return,
                    },
                };
                let result = projects::set_default(id.as_deref());
                let state = self.projects_mut();
                match result {
                    Ok(()) => {
                        if let Some(list) = state.list.as_mut() {
                            list.default = id;
                        }
                        state.notice = Some("Default project saved".into());
                    }
                    Err(error) => state.notice = Some(error),
                }
            }
            ProjectMenu::Glossary => {
                let name = match index {
                    0 => String::new(),
                    index => match self
                        .projects()
                        .list
                        .as_ref()
                        .and_then(|list| list.glossaries.get(index - 1))
                    {
                        Some(name) => name.clone(),
                        None => return,
                    },
                };
                self.projects_set_field(DraftField::Glossary, name, cx);
            }
            ProjectMenu::Provider => {
                let provider = match index {
                    0 => None,
                    index => match self.projects().known_trackers().get(index - 1) {
                        Some((id, _)) => Some(id.clone()),
                        None => return,
                    },
                };
                let mut text = self.projects().text.clone();
                let Some(draft) = self.projects_mut().draft.as_mut() else {
                    return;
                };
                draft.choose_provider(provider.clone(), &mut text);
                draft.error = None;
                self.projects_mut().targets = None;
                self.projects_set_text(text, cx);
                if let Some(provider) = provider {
                    self.projects_load_targets(provider, false, window, cx);
                }
            }
            ProjectMenu::Target => {
                let Some(Ok(target)) = self
                    .projects()
                    .targets
                    .as_ref()
                    .map(|targets| targets.as_ref().map(|targets| targets.get(index).cloned()))
                else {
                    return;
                };
                let Some(target) = target else {
                    return;
                };
                let mut text = self.projects().text.clone();
                if let Some(draft) = self.projects_mut().draft.as_mut() {
                    draft.choose_target(target, &mut text);
                    draft.error = None;
                }
                self.projects_set_text(text, cx);
            }
            ProjectMenu::ImportProvider => {
                let Some((id, _)) = self.projects().known_trackers().get(index).cloned() else {
                    return;
                };
                let import = self.projects_mut().import.get_or_insert_default();
                import.choose_provider(id.clone());
                self.projects_load_targets(id, true, window, cx);
            }
        }
        cx.notify();
    }

    fn projects_save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.projects().text.clone();
        let Some(draft) = self.projects_mut().draft.as_mut() else {
            return;
        };
        if draft.saving {
            return;
        }
        let project = match draft.project(&text) {
            Ok(project) => project,
            Err(error) => {
                draft.error = Some(error);
                cx.notify();
                return;
            }
        };
        draft.saving = true;
        draft.error = None;
        let create = draft.is_new();
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { projects::save(&project, create) })
                .await;
            this.update_in(cx, |this, window, cx| {
                let state = this.projects_mut();
                match result {
                    Ok(saved) => {
                        state.draft = None;
                        state.targets = None;
                        state.notice = Some(format!("Saved {}", saved.name));
                        this.projects_reload_list(window, cx);
                    }
                    Err(error) => {
                        if let Some(draft) = state.draft.as_mut() {
                            draft.refused(error);
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn projects_delete(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.projects().confirm_delete.as_deref() != Some(id.as_str()) {
            self.projects_mut().confirm_delete = Some(id);
            cx.notify();
            return;
        }
        self.projects_mut().confirm_delete = None;
        cx.spawn_in(window, async move |this, cx| {
            let deleting = id.clone();
            let result = cx
                .background_executor()
                .spawn(async move { projects::delete(&deleting) })
                .await;
            this.update_in(cx, |this, window, cx| {
                let state = this.projects_mut();
                state.notice = Some(match result {
                    Ok(()) => "Project deleted. Its recordings keep their notes.".into(),
                    Err(error) => error,
                });
                if state.draft.as_ref().and_then(|draft| draft.id.as_deref()) == Some(id.as_str()) {
                    state.draft = None;
                }
                this.projects_reload_list(window, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn projects_import(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let existing = self.projects().projects().to_vec();
        let Some(import) = self.projects_mut().import.as_mut() else {
            return;
        };
        let made = import.projects(&existing);
        if made.is_empty() || import.saving {
            return;
        }
        import.saving = true;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let mut added = 0;
                    let mut errors = Vec::new();
                    for project in made {
                        match projects::save(&project, true) {
                            Ok(_) => added += 1,
                            Err(error) => errors.push(format!("{}: {error}", project.name)),
                        }
                    }
                    (added, errors)
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                let (added, errors) = result;
                let state = this.projects_mut();
                state.notice = Some(if errors.is_empty() {
                    format!("Added {added} project{}", if added == 1 { "" } else { "s" })
                } else {
                    format!("Added {added}. Not added: {}", errors.join("; "))
                });
                state.import = None;
                this.projects_reload_list(window, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn projects_pick_path(
        &mut self,
        field: DraftField,
        directories: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: !directories,
            directories,
            multiple: false,
            prompt: None,
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            this.update(cx, |this, cx| {
                this.projects_set_field(field, path.to_string_lossy().to_string(), cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn projects_edit_key(
        &mut self,
        tracker: TrackerStatus,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.projects().key_busy || !tracker.takes_key() {
            return;
        }
        self.projects_mut().key_busy = true;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let secret = crate::ux_walk::prompt_secret(
                &format!("{} key", tracker.name),
                fork_brand::mode_text_static(
                    "Saved in your login Keychain for %walk%. It is used only to file and list issues in this tracker.",
                ),
            );
            let result = match secret {
                Some(secret) => {
                    let saving = tracker.clone();
                    Some(
                        cx.background_executor()
                            .spawn(async move { projects::save_tracker_key(&saving, &secret) })
                            .await,
                    )
                }
                None => None,
            };
            this.update_in(cx, |this, window, cx| {
                let state = this.projects_mut();
                state.key_busy = false;
                if let Some(result) = result {
                    state.notice = Some(match result {
                        Ok(()) => format!("{} key saved in Keychain", tracker.name),
                        Err(error) => error,
                    });
                    this.projects_reload_trackers(window, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // -- Rendering ----------------------------------------------------------------------------

    pub(crate) fn render_ux_walk_projects(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let state = self.projects();
        let theme = self.theme;
        let editing = state.draft.is_some() || state.import.is_some();
        let right = div()
            .flex()
            .gap(px(8.))
            .child(self.button(
                "ux-walk-projects-import",
                (ui::ButtonVariant::Gray, None),
                "Add from tracker…",
                editing,
                cx,
                |this, _, cx| {
                    let state = this.projects_mut();
                    state.draft = None;
                    state.confirm_delete = None;
                    state.import = Some(Import::default());
                    cx.notify();
                },
            ))
            .child(self.button(
                "ux-walk-projects-add",
                (ui::ButtonVariant::Primary, None),
                "Add project",
                editing,
                cx,
                |this, window, cx| {
                    let (draft, text) = Draft::adding();
                    this.projects_open_editor(draft, text, window, cx);
                },
            ))
            .into_any_element();

        let mut rows = Vec::new();
        let default_label = state
            .list
            .as_ref()
            .and_then(|list| list.default.as_deref().and_then(|id| list.name_of(id)))
            .unwrap_or(projects::NO_PROJECT)
            .to_string();
        rows.push(
            ui::SettingRow::settings(
                &theme,
                "Default project",
                Some(
                    "New recordings start in this project unless you pick another in the recorder.",
                ),
                self.select(
                    "ux-walk-projects-default",
                    default_label,
                    MenuKind::UxWalkProjects(ProjectMenu::Default),
                    cx,
                )
                .into_any_element(),
            )
            .into_any_element(),
        );
        let trackers = match &state.trackers {
            Some(Ok(trackers)) => trackers.clone(),
            _ => Vec::new(),
        };
        let confirm = state.confirm_delete.clone();
        for (index, project) in state.projects().iter().enumerate() {
            let edit = project.clone();
            let delete = project.id.clone();
            let confirming = confirm.as_deref() == Some(project.id.as_str());
            let controls = div()
                .flex()
                .gap(px(8.))
                .child(self.button(
                    ("ux-walk-project-edit", index),
                    (ui::ButtonVariant::Gray, None),
                    "Edit",
                    editing,
                    cx,
                    move |this, window, cx| {
                        let (draft, text) = Draft::editing(&edit);
                        this.projects_open_editor(draft, text, window, cx);
                    },
                ))
                .child(self.button(
                    ("ux-walk-project-delete", index),
                    (
                        if confirming {
                            ui::ButtonVariant::Destructive
                        } else {
                            ui::ButtonVariant::Gray
                        },
                        None,
                    ),
                    if confirming {
                        "Confirm delete"
                    } else {
                        "Delete"
                    },
                    editing,
                    cx,
                    move |this, window, cx| this.projects_delete(delete.clone(), window, cx),
                ));
            rows.push(
                ui::SettingRow::settings(
                    &theme,
                    project.name.clone(),
                    None,
                    controls.into_any_element(),
                )
                .description(project.summary(&trackers))
                .into_any_element(),
            );
        }
        if state
            .list
            .as_ref()
            .is_some_and(|list| list.projects.is_empty())
        {
            rows.push(
                ui::SettingRow::settings(
                    &theme,
                    "No projects yet",
                    Some("Add one, or add your repositories and teams from a tracker."),
                    div().into_any_element(),
                )
                .into_any_element(),
            );
        }

        let mut children = vec![self.rows(rows).into_any_element()];
        if let Some(list) = state.list.as_ref().filter(|list| !list.problems.is_empty()) {
            children.push(
                self.note_box()
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.red_11))
                    .child("Some project files could not be read:")
                    .children(
                        list.problems.iter().map(|problem| {
                            div().child(format!("{}: {}", problem.file, problem.error))
                        }),
                    )
                    .into_any_element(),
            );
        }
        if state.draft.is_some() {
            children.push(self.render_project_editor(cx));
        }
        if state.import.is_some() {
            children.push(self.render_project_import(cx));
        }
        let state = self.projects();
        if let Some(text) = state.list_error.clone().or_else(|| state.notice.clone()) {
            children.push(
                self.note_box()
                    .text_size(px(12.))
                    .text_color(theme.settings_muted())
                    .child(text)
                    .into_any_element(),
            );
        }
        ui::Section::settings(
            &theme,
            "Projects",
            Some("A project bundles a glossary, an issue tracker, a source folder and context notes. Recordings in a project use them for transcripts, notes and filing."),
            Some(right),
            children,
        )
        .into_any_element()
    }

    fn project_field(
        &self,
        field: DraftField,
        label: &'static str,
        extra: Option<gpui::AnyElement>,
        error: Option<&(Option<DraftField>, String)>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let input = &self.projects().inputs[field.index()];
        let id = match field {
            DraftField::Name => "ux-walk-project-name",
            DraftField::Glossary => "ux-walk-project-glossary",
            DraftField::Target => "ux-walk-project-target",
            DraftField::SourceRoot => "ux-walk-project-source",
            DraftField::BriefNotes => "ux-walk-project-notes",
            DraftField::Url => "ux-walk-project-url",
        };
        let controls = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .w(px(320.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(ui::TextInput::settings(&theme, id, input)),
            )
            .children(extra);
        let message = error
            .filter(|(at, _)| *at == Some(field))
            .map(|(_, message)| message.clone());
        div()
            .flex()
            .flex_col()
            .child(ui::SettingRow::settings(
                &theme,
                label,
                None,
                controls.into_any_element(),
            ))
            .children(message.map(|message| {
                div()
                    .px(px(12.))
                    .pb(px(10.))
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.red_11))
                    .child(message)
            }))
            .into_any_element()
    }

    fn render_project_editor(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = self.theme;
        let state = self.projects();
        let Some(draft) = state.draft.as_ref() else {
            return div().into_any_element();
        };
        let error = draft.error.as_ref();
        let provider_label = draft
            .provider
            .as_deref()
            .map_or_else(|| "No tracker".to_string(), |id| state.tracker_name(id));
        let mut rows = vec![
            self.project_field(DraftField::Name, "Name", None, error),
            self.project_field(
                DraftField::Glossary,
                "Glossary",
                Some(
                    self.select(
                        "ux-walk-project-glossary-pick",
                        "Choose",
                        MenuKind::UxWalkProjects(ProjectMenu::Glossary),
                        cx,
                    )
                    .into_any_element(),
                ),
                error,
            ),
            ui::SettingRow::settings(
                &theme,
                "Issue tracker",
                Some("Where this project's action items are filed."),
                self.select(
                    "ux-walk-project-provider",
                    provider_label,
                    MenuKind::UxWalkProjects(ProjectMenu::Provider),
                    cx,
                )
                .into_any_element(),
            )
            .into_any_element(),
        ];
        if draft.provider.is_some() {
            let (target_label, target_note) = match &state.targets {
                None => ("Loading…".to_string(), None),
                Some(Ok(targets)) if targets.is_empty() => (
                    "None found".to_string(),
                    Some("This tracker listed no targets. Type one instead.".to_string()),
                ),
                Some(Ok(targets)) => {
                    let current = self.projects_text(DraftField::Target).to_string();
                    (
                        targets
                            .iter()
                            .find(|target| target.id == current)
                            .map_or_else(|| "Choose".to_string(), |target| target.name.clone()),
                        None,
                    )
                }
                Some(Err(error)) => (
                    "Unavailable".to_string(),
                    Some(format!(
                        "Could not list targets: {error}. Type one instead."
                    )),
                ),
            };
            rows.push(
                self.project_field(
                    DraftField::Target,
                    "Target",
                    Some(
                        self.select(
                            "ux-walk-project-target-pick",
                            target_label,
                            MenuKind::UxWalkProjects(ProjectMenu::Target),
                            cx,
                        )
                        .into_any_element(),
                    ),
                    error,
                ),
            );
            if let Some(note) = target_note {
                rows.push(
                    div()
                        .px(px(12.))
                        .pb(px(10.))
                        .text_size(px(12.))
                        .text_color(theme.settings_muted())
                        .child(note)
                        .into_any_element(),
                );
            }
        }
        rows.push(
            self.project_field(
                DraftField::SourceRoot,
                "Source folder",
                Some(
                    self.button(
                        "ux-walk-project-source-pick",
                        (ui::ButtonVariant::Gray, None),
                        "Choose…",
                        false,
                        cx,
                        |this, window, cx| {
                            this.projects_pick_path(DraftField::SourceRoot, true, window, cx)
                        },
                    )
                    .into_any_element(),
                ),
                error,
            ),
        );
        rows.push(
            self.project_field(
                DraftField::BriefNotes,
                "Context notes",
                Some(
                    self.button(
                        "ux-walk-project-notes-pick",
                        (ui::ButtonVariant::Gray, None),
                        "Choose…",
                        false,
                        cx,
                        |this, window, cx| {
                            this.projects_pick_path(DraftField::BriefNotes, false, window, cx)
                        },
                    )
                    .into_any_element(),
                ),
                error,
            ),
        );
        rows.push(self.project_field(DraftField::Url, "URL", None, error));
        if let Some((None, message)) = error {
            rows.push(
                div()
                    .px(px(12.))
                    .py(px(10.))
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.red_11))
                    .child(message.clone())
                    .into_any_element(),
            );
        }
        let saving = draft.saving;
        rows.push(
            div()
                .flex()
                .justify_end()
                .gap(px(8.))
                .p(px(12.))
                .child(self.button(
                    "ux-walk-project-cancel",
                    (ui::ButtonVariant::Gray, None),
                    "Cancel",
                    saving,
                    cx,
                    |this, _, cx| {
                        let state = this.projects_mut();
                        state.draft = None;
                        state.targets = None;
                        cx.notify();
                    },
                ))
                .child(self.button(
                    "ux-walk-project-save",
                    (ui::ButtonVariant::Primary, None),
                    if saving {
                        "Saving…"
                    } else if draft.is_new() {
                        "Add project"
                    } else {
                        "Save project"
                    },
                    saving,
                    cx,
                    |this, window, cx| this.projects_save(window, cx),
                ))
                .into_any_element(),
        );
        self.rows(rows).into_any_element()
    }

    fn render_project_import(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = self.theme;
        let state = self.projects();
        let Some(import) = state.import.as_ref() else {
            return div().into_any_element();
        };
        let existing = state.projects();
        let provider_label = import.provider.as_deref().map_or_else(
            || "Choose a tracker".to_string(),
            |id| state.tracker_name(id),
        );
        let mut rows = vec![
            ui::SettingRow::settings(
                &theme,
                "Add from tracker",
                Some(
                    "Choose repositories, teams or folders; each becomes a project filing into it.",
                ),
                self.select(
                    "ux-walk-projects-import-provider",
                    provider_label,
                    MenuKind::UxWalkProjects(ProjectMenu::ImportProvider),
                    cx,
                )
                .into_any_element(),
            )
            .into_any_element(),
        ];
        match (import.provider.as_deref(), &import.targets) {
            (None, _) => {}
            (Some(_), None) => rows.push(
                ui::SettingRow::settings(&theme, "Loading…", None, div().into_any_element())
                    .into_any_element(),
            ),
            (Some(_), Some(Err(error))) => rows.push(
                div()
                    .p(px(12.))
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.red_11))
                    .child(format!(
                        "Could not list targets: {error}. Check the tracker's account below."
                    ))
                    .into_any_element(),
            ),
            (Some(_), Some(Ok(targets))) if targets.is_empty() => rows.push(
                ui::SettingRow::settings(
                    &theme,
                    "Nothing to add",
                    Some("This tracker listed no targets."),
                    div().into_any_element(),
                )
                .into_any_element(),
            ),
            (Some(provider), Some(Ok(targets))) => {
                for (index, target) in targets.iter().enumerate() {
                    let tracked = projects::already_tracked(provider, &target.id, existing);
                    let chosen = import.chosen.contains(&target.id);
                    let id = target.id.clone();
                    let mut row = ui::SettingRow::settings(
                        &theme,
                        target.name.clone(),
                        None,
                        if tracked {
                            div().into_any_element()
                        } else {
                            self.toggle(
                                ("ux-walk-import-target", index),
                                target.name.clone(),
                                chosen,
                                cx,
                                move |this, cx| {
                                    if let Some(import) = this.projects_mut().import.as_mut() {
                                        import.toggle(&id);
                                    }
                                    cx.notify();
                                },
                            )
                            .into_any_element()
                        },
                    );
                    if tracked {
                        row = row.description("Already a project");
                    } else if target.name != target.id {
                        row = row.description(target.id.clone());
                    }
                    rows.push(row.into_any_element());
                }
            }
        }
        let count = import.projects(existing).len();
        let saving = import.saving;
        rows.push(
            div()
                .flex()
                .justify_end()
                .gap(px(8.))
                .p(px(12.))
                .child(self.button(
                    "ux-walk-projects-import-cancel",
                    (ui::ButtonVariant::Gray, None),
                    "Cancel",
                    saving,
                    cx,
                    |this, _, cx| {
                        this.projects_mut().import = None;
                        cx.notify();
                    },
                ))
                .child(self.button(
                    "ux-walk-projects-import-add",
                    (ui::ButtonVariant::Primary, None),
                    match count {
                        _ if saving => "Adding…".to_string(),
                        0 => "Add projects".to_string(),
                        1 => "Add 1 project".to_string(),
                        count => format!("Add {count} projects"),
                    },
                    saving || count == 0,
                    cx,
                    |this, window, cx| this.projects_import(window, cx),
                ))
                .into_any_element(),
        );
        self.rows(rows).into_any_element()
    }

    pub(crate) fn render_ux_walk_trackers(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = self.theme;
        let state = self.projects();
        let rows = match &state.trackers {
            None => vec![
                ui::SettingRow::settings(
                    &theme,
                    "Checking trackers…",
                    None,
                    div().into_any_element(),
                )
                .into_any_element(),
            ],
            Some(Err(error)) => vec![
                ui::SettingRow::settings(
                    &theme,
                    "Trackers unavailable",
                    None,
                    div().into_any_element(),
                )
                .description(error.clone())
                .into_any_element(),
            ],
            Some(Ok(trackers)) => trackers
                .iter()
                .enumerate()
                .map(|(index, tracker)| {
                    let link = tracker.key_link().map(str::to_string);
                    let editing = tracker.clone();
                    let controls = div()
                        .flex()
                        .gap(px(8.))
                        .children(link.filter(|_| tracker.takes_key()).map(|link| {
                            self.button(
                                ("ux-walk-tracker-key-link", index),
                                (ui::ButtonVariant::Gray, None),
                                "Get a key ↗",
                                false,
                                cx,
                                move |_, _, cx| cx.open_url(&link),
                            )
                        }))
                        .when(tracker.takes_key(), |this| {
                            this.child(self.button(
                                ("ux-walk-tracker-key", index),
                                (ui::ButtonVariant::Gray, None),
                                "Add or Replace Key…",
                                state.key_busy || !cfg!(target_os = "macos"),
                                cx,
                                move |this, window, cx| {
                                    this.projects_edit_key(editing.clone(), window, cx)
                                },
                            ))
                        });
                    ui::SettingRow::settings(
                        &theme,
                        tracker.name.clone(),
                        None,
                        controls.into_any_element(),
                    )
                    .description(tracker.status())
                    .into_any_element()
                })
                .collect(),
        };
        ui::Section::settings(
            &theme,
            "Issue tracker accounts",
            Some("Used to list targets for projects and to file action items. Keys stay in your login Keychain."),
            Some(
                self.button(
                    "ux-walk-trackers-refresh",
                    (ui::ButtonVariant::Gray, None),
                    "Check again",
                    false,
                    cx,
                    |this, window, cx| {
                        this.projects_mut().trackers = None;
                        this.projects_reload_trackers(window, cx);
                        cx.notify();
                    },
                )
                .into_any_element(),
            ),
            vec![self.rows(rows).into_any_element()],
        )
        .into_any_element()
    }
}
