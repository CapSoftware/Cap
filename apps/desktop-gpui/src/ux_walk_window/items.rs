use super::WalkWindow;
use crate::{
    theme::Theme,
    ui,
    ux_walk_items::{Field, ItemsEditor, Origin, Row, type_label},
};
use gpui::{
    AnyElement, AppContext as _, Bounds, Context, Entity, FontWeight, Hsla,
    InteractiveElement as _, IntoElement, ParentElement as _, Pixels, SharedString,
    StatefulInteractiveElement as _, Styled, Window, div, prelude::FluentBuilder as _, px,
};
use std::path::PathBuf;

pub(super) type Then = Box<dyn FnOnce(&mut WalkWindow, &mut Window, &mut Context<WalkWindow>)>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Tab {
    #[default]
    Notes,
    Items,
}

struct TypeMenu {
    key: String,
    types: Vec<String>,
    state: ui::MenuState,
}

pub(super) struct ItemsState {
    pub(super) tab: Tab,
    pub(super) file: Option<PathBuf>,
    pub(super) editor: Option<ItemsEditor>,
    pub(super) loading: bool,
    pub(super) saving: bool,
    pub(super) error: Option<String>,
    pub(super) notice: Option<String>,
    selected: Option<String>,
    menu: Option<TypeMenu>,
    inputs: Vec<(Field, Entity<ui::TextInputState>)>,
    revision: u64,
}

fn placeholder(field: Field) -> &'static str {
    match field {
        Field::Title => "What should happen",
        Field::Priority => "Priority",
        Field::Owner => "Owner",
        Field::Due => "Due",
        Field::Note => "A note for the agent",
        Field::Type => "",
    }
}

impl ItemsState {
    pub(super) fn new(window: &mut Window, cx: &mut Context<WalkWindow>) -> Self {
        let inputs = Field::TEXT
            .iter()
            .map(|&field| {
                let input = cx.new(|cx| {
                    let mut input = if field == Field::Note {
                        ui::TextInputState::multi_line(window, cx)
                    } else {
                        ui::TextInputState::single_line(window, cx)
                    };
                    input.set_placeholder(placeholder(field));
                    input
                });
                cx.subscribe(&input, move |this: &mut WalkWindow, _, event, cx| {
                    if matches!(event, ui::TextInputEvent::Changed) {
                        this.item_text_changed(field, cx);
                    }
                })
                .detach();
                (field, input)
            })
            .collect();
        Self {
            tab: Tab::Notes,
            file: None,
            editor: None,
            loading: false,
            saving: false,
            error: None,
            notice: None,
            selected: None,
            menu: None,
            inputs,
            revision: 0,
        }
    }

    pub(super) fn dirty(&self) -> bool {
        self.editor.as_ref().is_some_and(ItemsEditor::dirty)
    }

    pub(super) fn shows(&self, file: &std::path::Path) -> bool {
        self.file.as_deref() == Some(file)
    }

    fn input(&self, field: Field) -> Option<&Entity<ui::TextInputState>> {
        self.inputs
            .iter()
            .find(|(candidate, _)| *candidate == field)
            .map(|(_, input)| input)
    }

    pub(super) fn forget(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        self.file = None;
        self.editor = None;
        self.loading = false;
        self.saving = false;
        self.error = None;
        self.notice = None;
        self.selected = None;
        self.menu = None;
    }

    pub(super) fn discard(&mut self) {
        if let Some(editor) = self.editor.as_mut() {
            editor.discard();
        }
        if self.selected.as_deref().is_some_and(|key| {
            self.editor
                .as_ref()
                .is_none_or(|editor| editor.row(key).is_none())
        }) {
            self.selected = None;
        }
        self.menu = None;
        self.error = None;
    }
}

impl WalkWindow {
    pub(super) fn ensure_items(
        &mut self,
        file: std::path::PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.items.shows(&file) && (self.items.editor.is_some() || self.items.loading) {
            return;
        }
        if self.items.dirty() {
            return;
        }
        self.load_items(file, window, cx);
    }

    pub(super) fn load_items(
        &mut self,
        file: std::path::PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.items.shows(&file) {
            self.items.forget();
        }
        self.items.revision = self.items.revision.wrapping_add(1);
        let revision = self.items.revision;
        self.items.file = Some(file.clone());
        self.items.loading = true;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let requested = file.clone();
            let result = cx
                .background_executor()
                .spawn(async move {
                    crate::ux_walk::run_engine("items", &file)
                        .and_then(|output| ItemsEditor::parse(&output))
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                if this.items.revision != revision || !this.items.shows(&requested) {
                    return;
                }
                this.items.loading = false;
                match result {
                    Ok(editor) => this.replace_items(editor, cx),
                    Err(error) => this.items.error = Some(error),
                }
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    fn replace_items(&mut self, editor: ItemsEditor, cx: &mut Context<Self>) {
        let before = self
            .items
            .editor
            .as_ref()
            .map_or(0, |editor| editor.orphans().len());
        let after = editor.orphans().len();
        if after > before {
            self.items.notice = Some(format!(
                "{after} saved {} no longer {} an item after reprocessing. Review {} at the top of Items.",
                if after == 1 { "edit" } else { "edits" },
                if after == 1 { "matches" } else { "match" },
                if after == 1 { "it" } else { "them" },
            ));
        }
        self.items.error = None;
        self.items.editor = Some(editor);
        let selected = self.items.selected.clone();
        if selected.as_deref().is_some_and(|key| {
            self.items
                .editor
                .as_ref()
                .is_none_or(|e| e.row(key).is_none())
        }) {
            self.items.selected = None;
        }
        self.fill_inputs(cx);
    }

    fn fill_inputs(&mut self, cx: &mut Context<Self>) {
        let row = self
            .items
            .selected
            .as_deref()
            .and_then(|key| self.items.editor.as_ref()?.row(key));
        let Some(row) = row else {
            return;
        };
        for (field, input) in self.items.inputs.clone() {
            let value = row.values.get(field).unwrap_or_default().to_string();
            input.update(cx, |input, cx| input.set_text(value, cx));
        }
    }

    fn item_text_changed(&mut self, field: Field, cx: &mut Context<Self>) {
        let Some(key) = self.items.selected.clone() else {
            return;
        };
        let Some(text) = self
            .items
            .input(field)
            .map(|input| input.read(cx).text().to_string())
        else {
            return;
        };
        if let Some(editor) = self.items.editor.as_mut() {
            editor.set(&key, field, &text);
        }
        self.items.error = None;
        cx.notify();
    }

    fn select_item(&mut self, key: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.items.selected = key;
        self.items.menu = None;
        self.fill_inputs(cx);
        if let Some(title) = self.items.input(Field::Title).cloned()
            && self.items.selected.is_some()
        {
            title.update(cx, |input, cx| input.focus_and_select_all(window, cx));
        }
        cx.notify();
    }

    fn edit_items(&mut self, cx: &mut Context<Self>, change: impl FnOnce(&mut ItemsEditor)) {
        if let Some(editor) = self.items.editor.as_mut() {
            change(editor);
        }
        self.items.error = None;
        cx.notify();
    }

    fn add_item(&mut self, chapter: u64, window: &mut Window, cx: &mut Context<Self>) {
        let key = crate::ux_walk_items::new_key();
        let added = self
            .items
            .editor
            .as_mut()
            .is_some_and(|editor| editor.add(chapter, key.clone()));
        if added {
            self.select_item(Some(key), window, cx);
        }
    }

    fn open_type_menu(&mut self, key: String, bounds: Bounds<Pixels>, cx: &mut Context<Self>) {
        let Some(editor) = self.items.editor.as_ref() else {
            return;
        };
        let (Some(row), Some(chapter)) = (editor.row(&key), editor.chapter_of(&key)) else {
            return;
        };
        let mut types: Vec<String> = chapter
            .types()
            .iter()
            .map(|kind| kind.to_string())
            .collect();
        if !types.contains(&row.values.kind) && !row.values.kind.is_empty() {
            types.push(row.values.kind.clone());
        }
        let items: Vec<ui::MenuItem> = types
            .iter()
            .map(|kind| ui::MenuItem::new(type_label(kind), *kind == row.values.kind))
            .collect();
        self.items.menu = Some(TypeMenu {
            key,
            state: ui::MenuState::anchored(bounds, &items),
            types,
        });
        cx.notify();
    }

    pub(super) fn save_items(
        &mut self,
        then: Option<Then>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(file), Some(editor)) = (self.items.file.clone(), self.items.editor.as_ref())
        else {
            return;
        };
        if self.items.saving {
            return;
        }
        if let Err(error) = editor.validate() {
            self.items.error = Some(error);
            self.items.tab = Tab::Items;
            cx.notify();
            return;
        }
        let edits = editor.outgoing();
        self.items.saving = true;
        self.items.error = None;
        self.items.revision = self.items.revision.wrapping_add(1);
        let revision = self.items.revision;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let requested = file.clone();
            let result = cx
                .background_executor()
                .spawn(async move {
                    let request = std::env::temp_dir().join(format!(
                        "ux-walk-items-{}.json",
                        crate::store::new_uuid_v4()
                    ));
                    let body = serde_json::json!({ "journal": file, "edits": edits });
                    std::fs::write(
                        &request,
                        serde_json::to_vec(&body).map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("Could not stage the item edits: {error}"))?;
                    let result = crate::ux_walk::run_engine("save-items", &request);
                    let _ = std::fs::remove_file(&request);
                    ItemsEditor::parse(&result?)
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                if this.items.revision != revision || !this.items.shows(&requested) {
                    return;
                }
                this.items.saving = false;
                match result {
                    Ok(editor) => {
                        this.replace_items(editor, cx);
                        this.items.notice =
                            Some("Item edits saved. Agent handoffs use them.".into());
                        if let Some(then) = then {
                            then(this, window, cx);
                        }
                    }
                    Err(error) => {
                        this.items.error = Some(format!("Could not save the item edits: {error}"));
                        this.items.tab = Tab::Items;
                    }
                }
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn save_items_then(
        &mut self,
        file: std::path::PathBuf,
        then: Then,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.items.shows(&file) {
            self.settle_items(true, then, window, cx);
        } else {
            then(self, window, cx);
        }
    }

    pub(super) fn settle_items(
        &mut self,
        save_first: bool,
        then: Then,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.items.dirty() {
            then(self, window, cx);
            return;
        }
        let confirm = if save_first {
            confirm(
                "Save your item edits first?",
                "The agent and the reprocessed report use the saved items. Your unsaved edits are saved before continuing.",
                "Save and continue",
                "Cancel",
                window,
                cx,
            )
        } else {
            confirm(
                "Discard unsaved item edits?",
                "Your changes to this walk's items have not been saved.",
                "Discard",
                "Keep editing",
                window,
                cx,
            )
        };
        cx.spawn_in(window, async move |this, cx| {
            if !confirm.await {
                return;
            }
            this.update_in(cx, |this, window, cx| {
                if save_first {
                    this.save_items(Some(then), window, cx);
                } else {
                    this.items.discard();
                    then(this, window, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn render_item_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.items.menu.as_ref()?;
        let current = self
            .items
            .editor
            .as_ref()
            .and_then(|editor| editor.row(&menu.key))
            .map(|row| row.values.kind)
            .unwrap_or_default();
        let items = menu
            .types
            .iter()
            .map(|kind| ui::MenuItem::new(type_label(kind), *kind == current))
            .collect();
        Some(
            ui::Menu::plain(&self.theme, "walk-item-type-menu", items, &menu.state)
                .min_width(px(140.))
                .on_select(cx.listener(|this, index: &usize, _, cx| {
                    if let Some(menu) = this.items.menu.take()
                        && let Some(kind) = menu.types.get(*index)
                    {
                        let kind = kind.clone();
                        this.edit_items(cx, |editor| editor.set(&menu.key, Field::Type, &kind));
                    }
                    cx.notify();
                }))
                .on_dismiss(cx.listener(|this, _, _, cx| {
                    this.items.menu = None;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }

    pub(super) fn render_tabs(&self, file: PathBuf, cx: &mut Context<Self>) -> AnyElement {
        let label = match self
            .items
            .editor
            .as_ref()
            .filter(|_| self.items.shows(&file))
        {
            Some(editor) => {
                let (open, _, _) = editor.counts();
                if editor.dirty() {
                    format!("Items ({open}) •")
                } else {
                    format!("Items ({open})")
                }
            }
            None => "Items".into(),
        };
        ui::SegmentedControl::settings(
            &self.theme,
            "walk-tabs",
            vec![
                ui::SegmentOption::new("Notes", self.items.tab == Tab::Notes),
                ui::SegmentOption::new(label, self.items.tab == Tab::Items),
            ],
        )
        .on_select(cx.listener(move |this, index: &usize, window, cx| {
            this.items.tab = if *index == 1 { Tab::Items } else { Tab::Notes };
            if this.items.tab == Tab::Items {
                this.ensure_items(file.clone(), window, cx);
            }
            cx.notify();
        }))
        .into_any_element()
    }

    pub(super) fn render_items(&self, editable: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let muted = |text: String| {
            div()
                .text_size(px(12.))
                .line_height(px(18.))
                .text_color(theme.gray_10)
                .child(text)
        };
        let Some(editor) = self.items.editor.clone() else {
            return div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .flex_1()
                .min_h_0()
                .child(muted(if self.items.loading {
                    "Loading items…".into()
                } else {
                    "Items appear here after the walk is processed.".into()
                }))
                .when_some(self.items.error.clone(), |this, error| {
                    this.child(
                        div()
                            .text_size(px(12.))
                            .text_color(theme.red_9)
                            .child(error),
                    )
                })
                .into_any_element();
        };
        let dirty = editor.dirty();
        let (open, changed, deleted) = editor.counts();
        let orphans = editor.orphans();
        let status = format!(
            "{open} {} for the agent · {changed} edited or added · {deleted} deleted",
            if open == 1 { "item" } else { "items" }
        );
        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .flex_1()
            .min_h_0()
            .when(!editable, |this| {
                this.child(muted(
                    "Items can be edited once processing finishes.".into(),
                ))
            })
            .when_some(self.items.notice.clone(), |this, notice| {
                this.child(muted(notice))
            })
            .child(
                div()
                    .id("walk-items")
                    .flex()
                    .flex_col()
                    .gap(px(16.))
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .when(!orphans.is_empty(), |this| {
                        this.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(6.))
                                .p(px(10.))
                                .rounded(px(8.))
                                .bg(theme.amber_3)
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(theme.amber_11)
                                        .child("These saved edits no longer match an item after reprocessing. The agent is told about them but does not file them."),
                                )
                                .children(orphans.into_iter().map(|orphan| {
                                    let key = orphan.key.clone();
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(8.))
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .text_size(px(12.))
                                                .child(orphan.summary),
                                        )
                                        .when(editable, |this| {
                                            this.child(
                                                ui::Button::plain(
                                                    &theme,
                                                    SharedString::from(format!(
                                                        "walk-orphan-drop-{key}"
                                                    )),
                                                    ui::ButtonVariant::Gray,
                                                    ui::ButtonSize::Xs,
                                                )
                                                .label("Drop")
                                                .on_click(cx.listener(
                                                    move |this, _, _, cx| {
                                                        let key = key.clone();
                                                        this.edit_items(cx, |editor| {
                                                            editor.drop_orphan(&key)
                                                        });
                                                    },
                                                )),
                                            )
                                        })
                                })),
                        )
                    })
                    .when(editor.is_empty() && !editable, |this| {
                        this.child(muted("This walk has no generated items.".into()))
                    })
                    .children(editor.chapters.iter().map(|chapter| {
                        let n = chapter.n;
                        let rows = editor.rows(n);
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(6.))
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
                                            .child(format!("Chapter {n} · {}", chapter.name)),
                                    )
                                    .when(editable, |this| {
                                        this.child(
                                            ui::Button::plain(
                                                &theme,
                                                SharedString::from(format!("walk-item-add-{n}")),
                                                ui::ButtonVariant::Gray,
                                                ui::ButtonSize::Xs,
                                            )
                                            .label("Add item")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.add_item(n, window, cx)
                                            })),
                                        )
                                    }),
                            )
                            .when(rows.is_empty(), |this| {
                                this.child(muted(if chapter.brief {
                                    "No items in this chapter.".into()
                                } else {
                                    "No brief for this chapter yet. Items you add are handed to the agent.".into()
                                }))
                            })
                            .children(
                                rows.into_iter()
                                    .map(|row| self.render_row(row, editable, cx)),
                            )
                            .when(!chapter.decisions.is_empty(), |this| {
                                this.child(section_label(&theme, "Decisions")).children(
                                    chapter.decisions.iter().map(|decision| {
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.gray_11)
                                            .child(format!("• {decision}"))
                                    }),
                                )
                            })
                            .when(!chapter.questions.is_empty(), |this| {
                                this.child(section_label(&theme, "Open questions")).children(
                                    chapter.questions.iter().map(|question| {
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.gray_11)
                                            .child(format!(
                                                "• {}{}",
                                                question
                                                    .id
                                                    .as_ref()
                                                    .map(|id| format!("{id} · "))
                                                    .unwrap_or_default(),
                                                question.text
                                            ))
                                    }),
                                )
                            })
                    })),
            )
            .when_some(self.items.error.clone(), |this, error| {
                this.child(
                    div()
                        .text_size(px(12.))
                        .text_color(theme.red_9)
                        .child(error),
                )
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(11.))
                            .text_color(if dirty { theme.amber_11 } else { theme.gray_10 })
                            .child(if dirty {
                                format!("Unsaved changes · {status}")
                            } else {
                                status
                            }),
                    )
                    .when(editable, |this| {
                        this.child(
                            ui::Button::plain(
                                &theme,
                                "walk-items-discard",
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Sm,
                            )
                            .label("Discard")
                            .disabled(!dirty || self.items.saving)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.items.discard();
                                this.fill_inputs(cx);
                                cx.notify();
                            })),
                        )
                        .child(
                            ui::Button::plain(
                                &theme,
                                "walk-items-save",
                                ui::ButtonVariant::Blue,
                                ui::ButtonSize::Sm,
                            )
                            .label(if self.items.saving { "Saving…" } else { "Save items" })
                            .disabled(!dirty || self.items.saving)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.save_items(None, window, cx)
                            })),
                        )
                    }),
            )
            .into_any_element()
    }

    fn render_row(&self, row: Row, editable: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let key = row.key.clone();
        let selected = editable && self.items.selected.as_deref() == Some(key.as_str());
        let meta: Vec<String> = [
            row.id.clone(),
            row.when.clone(),
            row.values
                .priority
                .clone()
                .map(|value| format!("priority: {value}")),
            row.values
                .owner
                .clone()
                .map(|value| format!("owner: {value}")),
            row.values.due.clone().map(|value| format!("due: {value}")),
            (!row.refs.is_empty()).then(|| format!("filed: {}", row.refs.join(", "))),
        ]
        .into_iter()
        .flatten()
        .collect();
        let badges: Vec<(&str, Hsla)> = [
            (row.origin == Origin::User).then_some(("Added", theme.blue_11.into())),
            (row.origin == Origin::Agent).then_some(("Agent", theme.gray_11.into())),
            row.edited.then_some(("Edited", theme.amber_11.into())),
            row.deleted.then_some(("Deleted", theme.red_11.into())),
            row.unsaved.then_some(("Unsaved", theme.amber_11.into())),
        ]
        .into_iter()
        .flatten()
        .collect();
        let toggle_key = key.clone();
        let delete_key = key.clone();
        let deleted = row.deleted;
        div()
            .id(SharedString::from(format!("walk-item-{key}")))
            .flex()
            .flex_col()
            .gap(px(4.))
            .p(px(8.))
            .rounded(px(8.))
            .bg(theme.gray_2)
            .border_1()
            .border_color(if selected { theme.blue_8 } else { theme.gray_4 })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        div()
                            .flex_shrink_0()
                            .px(px(6.))
                            .rounded(px(4.))
                            .bg(theme.gray_4)
                            .text_size(px(11.))
                            .text_color(theme.gray_11)
                            .child(type_label(&row.values.kind)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(13.))
                            .when(deleted, |this| this.text_color(theme.gray_9))
                            .child(if row.values.title.trim().is_empty() {
                                "Untitled item".to_string()
                            } else {
                                row.values.title.clone()
                            }),
                    )
                    .children(badges.into_iter().map(|(label, color)| {
                        div()
                            .flex_shrink_0()
                            .text_size(px(10.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(color)
                            .child(label)
                    }))
                    .when(editable && !deleted, |this| {
                        this.child(
                            ui::Button::plain(
                                &theme,
                                SharedString::from(format!("walk-item-edit-{key}")),
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Xs,
                            )
                            .label(if selected { "Done" } else { "Edit" })
                            .on_click(cx.listener(
                                move |this, _, window, cx| {
                                    let next = (this.items.selected.as_deref()
                                        != Some(toggle_key.as_str()))
                                    .then(|| toggle_key.clone());
                                    this.select_item(next, window, cx);
                                },
                            )),
                        )
                    })
                    .when(editable, |this| {
                        this.child(
                            ui::Button::plain(
                                &theme,
                                SharedString::from(format!("walk-item-delete-{key}")),
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Xs,
                            )
                            .label(if deleted { "Undo" } else { "Delete" })
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    let key = delete_key.clone();
                                    if this.items.selected.as_deref() == Some(key.as_str()) {
                                        this.items.selected = None;
                                    }
                                    this.edit_items(cx, |editor| {
                                        editor.set_deleted(&key, !deleted)
                                    });
                                },
                            )),
                        )
                    }),
            )
            .when(!meta.is_empty(), |this| {
                this.child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme.gray_10)
                        .child(meta.join(" · ")),
                )
            })
            .when_some(
                row.values.note.clone().filter(|_| !selected),
                |this, note| {
                    this.child(
                        div()
                            .text_size(px(12.))
                            .text_color(theme.gray_11)
                            .child(format!("Note: {note}")),
                    )
                },
            )
            .when(selected && !deleted, |this| {
                this.child(self.render_fields(&row, cx))
            })
            .into_any_element()
    }

    fn render_fields(&self, row: &Row, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let key = row.key.clone();
        let field = |field: Field| -> AnyElement {
            match self.items.input(field) {
                Some(input) => div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(section_label(&theme, field.label()))
                    .child(ui::TextInput::settings(
                        &theme,
                        SharedString::from(format!("walk-item-field-{}", field.key())),
                        input,
                    ))
                    .into_any_element(),
                None => div().into_any_element(),
            }
        };
        let type_key = key.clone();
        let up_key = key.clone();
        let down_key = key.clone();
        let revert_key = key.clone();
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .pt(px(6.))
            .child(field(Field::Title))
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(section_label(&theme, "Type"))
                            .child(
                                ui::Select::settings(
                                    &theme,
                                    SharedString::from(format!("walk-item-type-{key}")),
                                    type_label(&row.values.kind),
                                )
                                .on_open(cx.listener(
                                    move |this, bounds: &Bounds<Pixels>, _, cx| {
                                        this.open_type_menu(type_key.clone(), *bounds, cx)
                                    },
                                )),
                            ),
                    )
                    .child(field(Field::Priority)),
            )
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(field(Field::Owner))
                    .child(field(Field::Due)),
            )
            .child(field(Field::Note))
            .child(
                div()
                    .flex()
                    .gap(px(6.))
                    .child(
                        ui::Button::plain(
                            &theme,
                            SharedString::from(format!("walk-item-up-{key}")),
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Xs,
                        )
                        .label("Move up")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let key = up_key.clone();
                            this.edit_items(cx, |editor| {
                                editor.move_item(&key, true);
                            });
                        })),
                    )
                    .child(
                        ui::Button::plain(
                            &theme,
                            SharedString::from(format!("walk-item-down-{key}")),
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Xs,
                        )
                        .label("Move down")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let key = down_key.clone();
                            this.edit_items(cx, |editor| {
                                editor.move_item(&key, false);
                            });
                        })),
                    )
                    .when(row.edited && row.origin != Origin::User, |this| {
                        this.child(
                            ui::Button::plain(
                                &theme,
                                SharedString::from(format!("walk-item-revert-{key}")),
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Xs,
                            )
                            .label("Restore generated text")
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    let key = revert_key.clone();
                                    this.edit_items(cx, |editor| editor.revert(&key));
                                    this.fill_inputs(cx);
                                },
                            )),
                        )
                    }),
            )
            .into_any_element()
    }
}

pub(super) fn confirm(
    title: &str,
    detail: &str,
    accept: &str,
    cancel: &str,
    window: &mut Window,
    cx: &mut gpui::App,
) -> impl std::future::Future<Output = bool> + use<> {
    let answer = window.prompt(
        gpui::PromptLevel::Warning,
        title,
        Some(detail),
        &[
            gpui::PromptButton::ok(accept.to_string()),
            gpui::PromptButton::cancel(cancel.to_string()),
        ],
        cx,
    );
    async move { answer.await.ok() == Some(0) }
}

fn section_label(theme: &Theme, text: &'static str) -> gpui::Div {
    div()
        .text_size(px(11.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.gray_10)
        .child(text)
}
