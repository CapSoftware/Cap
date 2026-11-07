use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Title,
    Type,
    Priority,
    Owner,
    Due,
    Note,
}

impl Field {
    pub const TEXT: [Field; 5] = [
        Field::Title,
        Field::Priority,
        Field::Owner,
        Field::Due,
        Field::Note,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Field::Title => "title",
            Field::Type => "type",
            Field::Priority => "priority",
            Field::Owner => "owner",
            Field::Due => "due",
            Field::Note => "note",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Field::Title => "Title",
            Field::Type => "Type",
            Field::Priority => "Priority",
            Field::Owner => "Owner",
            Field::Due => "Due",
            Field::Note => "Note",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Values {
    pub title: String,
    pub kind: String,
    pub priority: Option<String>,
    pub owner: Option<String>,
    pub due: Option<String>,
    pub note: Option<String>,
}

impl Values {
    pub fn get(&self, field: Field) -> Option<&str> {
        match field {
            Field::Title => Some(self.title.as_str()),
            Field::Type => Some(self.kind.as_str()),
            Field::Priority => self.priority.as_deref(),
            Field::Owner => self.owner.as_deref(),
            Field::Due => self.due.as_deref(),
            Field::Note => self.note.as_deref(),
        }
    }

    fn set(&mut self, field: Field, value: Option<String>) {
        match field {
            Field::Title => self.title = value.unwrap_or_default(),
            Field::Type => self.kind = value.unwrap_or_default(),
            Field::Priority => self.priority = value,
            Field::Owner => self.owner = value,
            Field::Due => self.due = value,
            Field::Note => self.note = value,
        }
    }

    fn apply(&mut self, edit: &Map<String, Value>) {
        for field in [
            Field::Title,
            Field::Type,
            Field::Priority,
            Field::Owner,
            Field::Due,
            Field::Note,
        ] {
            if let Some(value) = edit.get(field.key()) {
                self.set(field, value.as_str().map(str::to_string));
            }
        }
    }
}

/// A ledger link on an item: the tracker's ref, and its web address when the tracker has one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ItemRef {
    pub reference: String,
    pub url: Option<String>,
}

impl ItemRef {
    /// What the item shows: the url when there is one, else the ref text.
    pub fn link(&self) -> Option<&str> {
        self.url
            .as_deref()
            .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
    }
}

fn refs_of(item: &Value) -> Vec<ItemRef> {
    item["refs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|reference| {
            Some(ItemRef {
                reference: text(&reference["ref"])?,
                url: text(&reference["url"]),
            })
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Brief,
    Agent,
    User,
}

#[derive(Clone, Debug, PartialEq)]
struct Generated {
    key: String,
    id: Option<String>,
    when: Option<String>,
    origin: Origin,
    refs: Vec<ItemRef>,
    original: Values,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Question {
    pub id: Option<String>,
    pub when: Option<String>,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Chapter {
    pub n: u64,
    pub name: String,
    pub kind: Option<String>,
    pub brief: bool,
    pub decisions: Vec<String>,
    pub questions: Vec<Question>,
    generated: Vec<Generated>,
}

impl Chapter {
    pub fn types(&self) -> &'static [&'static str] {
        types_for(self.kind.as_deref())
    }
}

pub fn types_for(kind: Option<&str>) -> &'static [&'static str] {
    if kind == Some("diatribe") {
        &["action", "decision", "note", "question"]
    } else {
        &["bug", "ask", "decision", "question", "error"]
    }
}

/// The engine's DEFAULT_TYPES (file.mjs): what filing picks when nothing is chosen. A diatribe's (and a
/// recording's notes') action items; a walk's bugs and asks.
pub fn default_file_types(kind: Option<&str>) -> &'static [&'static str] {
    if kind == Some("diatribe") {
        &["action"]
    } else {
        &["bug", "ask"]
    }
}

fn default_type(kind: Option<&str>) -> &'static str {
    if kind == Some("diatribe") {
        "action"
    } else {
        "ask"
    }
}

pub fn type_label(kind: &str) -> String {
    let mut chars = kind.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub key: String,
    pub id: Option<String>,
    pub when: Option<String>,
    pub origin: Origin,
    pub values: Values,
    pub edited: bool,
    pub deleted: bool,
    pub unsaved: bool,
    pub refs: Vec<ItemRef>,
}

impl Row {
    /// Filing can create an issue for it: not deleted and not already linked.
    pub fn fileable(&self) -> bool {
        !self.deleted && self.refs.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Orphan {
    pub key: String,
    pub summary: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Edits {
    items: BTreeMap<String, Map<String, Value>>,
    added: Vec<Map<String, Value>>,
    order: Option<Vec<String>>,
}

impl Edits {
    fn parse(value: &Value) -> Self {
        let items = value["items"]
            .as_object()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|(key, edit)| Some((key.clone(), edit.as_object()?.clone())))
                    .collect()
            })
            .unwrap_or_default();
        let added = value["added"]
            .as_array()
            .map(|added| {
                added
                    .iter()
                    .filter_map(|entry| entry.as_object().cloned())
                    .collect()
            })
            .unwrap_or_default();
        let order = value["order"].as_array().map(|order| {
            order
                .iter()
                .filter_map(|key| key.as_str().map(str::to_string))
                .collect()
        });
        Self {
            items,
            added,
            order,
        }
    }

    fn added_index(&self, key: &str) -> Option<usize> {
        self.added
            .iter()
            .position(|entry| entry.get("key").and_then(Value::as_str) == Some(key))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ItemsEditor {
    pub session: String,
    pub topic: Option<String>,
    pub chapters: Vec<Chapter>,
    updated_at: Option<String>,
    saved: Edits,
    edits: Edits,
    user_refs: BTreeMap<String, Vec<ItemRef>>,
    file_choice: BTreeSet<String>,
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn values_of(value: &Value) -> Values {
    Values {
        title: value["title"].as_str().unwrap_or_default().to_string(),
        kind: value["type"].as_str().unwrap_or_default().to_string(),
        priority: text(&value["priority"]),
        owner: text(&value["owner"]),
        due: text(&value["due"]),
        note: None,
    }
}

fn normalize(field: Field, value: &str) -> Option<String> {
    let trimmed = value.trim();
    if field == Field::Title || !trimmed.is_empty() {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn to_json(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::String)
}

impl ItemsEditor {
    pub fn parse(output: &str) -> Result<Self, String> {
        let value: Value = serde_json::from_str(output)
            .map_err(|error| format!("The walk items could not be read: {error}"))?;
        if value["version"].as_u64() != Some(1) {
            return Err("The walk items use an unsupported format.".into());
        }
        let chapters = value["chapters"]
            .as_array()
            .ok_or("The walk items have no chapters.")?
            .iter()
            .filter_map(|chapter| {
                let n = chapter["n"].as_u64()?;
                let generated = chapter["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|item| item["origin"].as_str() != Some("user"))
                    .filter_map(|item| {
                        Some(Generated {
                            key: item["key"].as_str()?.to_string(),
                            id: text(&item["id"]),
                            when: text(&item["when"]),
                            origin: if item["origin"].as_str() == Some("agent") {
                                Origin::Agent
                            } else {
                                Origin::Brief
                            },
                            refs: refs_of(item),
                            original: if item["original"].is_object() {
                                values_of(&item["original"])
                            } else {
                                values_of(item)
                            },
                        })
                    })
                    .collect();
                Some(Chapter {
                    n,
                    name: chapter["name"].as_str().unwrap_or_default().to_string(),
                    kind: text(&chapter["kind"]).or_else(|| text(&value["kind"])),
                    brief: chapter["brief"].as_bool().unwrap_or(false),
                    decisions: chapter["decisions"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(text)
                        .collect(),
                    questions: chapter["questions"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|question| {
                            Some(Question {
                                id: text(&question["id"]),
                                when: text(&question["when"]),
                                text: text(&question["text"])?,
                            })
                        })
                        .collect(),
                    generated,
                })
            })
            .collect();
        let user_refs = value["chapters"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|chapter| chapter["items"].as_array().into_iter().flatten())
            .filter(|item| item["origin"].as_str() == Some("user"))
            .filter_map(|item| Some((item["key"].as_str()?.to_string(), refs_of(item))))
            .filter(|(_, refs)| !refs.is_empty())
            .collect();
        let edits = Edits::parse(&value["edits"]);
        let mut editor = Self {
            session: value["session"].as_str().unwrap_or_default().to_string(),
            topic: text(&value["topic"]),
            chapters,
            updated_at: text(&value["edits"]["updatedAt"]),
            saved: edits.clone(),
            edits,
            user_refs,
            file_choice: BTreeSet::new(),
        };
        editor.file_choice = editor.default_file_choice();
        Ok(editor)
    }

    fn all_rows(&self) -> Vec<Row> {
        self.chapters
            .iter()
            .flat_map(|chapter| self.rows(chapter.n))
            .collect()
    }

    /// The items filing starts with: every fileable item of the chapter's DEFAULT_TYPES.
    fn default_file_choice(&self) -> BTreeSet<String> {
        self.chapters
            .iter()
            .flat_map(|chapter| {
                let types = default_file_types(chapter.kind.as_deref());
                self.rows(chapter.n)
                    .into_iter()
                    .filter(move |row| row.fileable() && types.contains(&row.values.kind.as_str()))
                    .map(|row| row.key)
            })
            .collect()
    }

    /// After a reload (a save, a filing run, a reprocess) keep what the user chose; items that are new since
    /// get the default choice.
    pub fn adopt_file_choice(&mut self, previous: &ItemsEditor) {
        if previous.session != self.session {
            return;
        }
        let known: BTreeSet<String> = previous.all_rows().into_iter().map(|row| row.key).collect();
        let defaults = self.default_file_choice();
        self.file_choice = self
            .all_rows()
            .into_iter()
            .filter(|row| {
                if known.contains(&row.key) {
                    previous.file_choice.contains(&row.key)
                } else {
                    defaults.contains(&row.key)
                }
            })
            .map(|row| row.key)
            .collect();
    }

    pub fn chosen_for_file(&self, key: &str) -> bool {
        self.file_choice.contains(key) && self.row(key).is_some_and(|row| row.fileable())
    }

    pub fn toggle_file(&mut self, key: &str) {
        if !self.file_choice.remove(key) && self.row(key).is_some_and(|row| row.fileable()) {
            self.file_choice.insert(key.to_string());
        }
    }

    /// The chosen, still fileable keys in the order the items are shown.
    pub fn file_keys(&self) -> Vec<String> {
        self.all_rows()
            .into_iter()
            .filter(|row| row.fileable() && self.file_choice.contains(&row.key))
            .map(|row| row.key)
            .collect()
    }

    pub fn dirty(&self) -> bool {
        self.edits != self.saved
    }

    pub fn discard(&mut self) {
        self.edits = self.saved.clone();
    }

    pub fn is_empty(&self) -> bool {
        self.chapters
            .iter()
            .all(|chapter| chapter.generated.is_empty())
            && self.edits.added.is_empty()
    }

    fn generated(&self, key: &str) -> Option<&Generated> {
        self.chapters
            .iter()
            .flat_map(|chapter| &chapter.generated)
            .find(|item| item.key == key)
    }

    fn chapter(&self, n: u64) -> Option<&Chapter> {
        self.chapters.iter().find(|chapter| chapter.n == n)
    }

    fn row_in(&self, edits: &Edits, chapter: &Chapter) -> Vec<Row> {
        let generated = chapter.generated.iter().map(|item| {
            let edit = edits.items.get(&item.key);
            let mut values = item.original.clone();
            if let Some(edit) = edit {
                values.apply(edit);
            }
            Row {
                key: item.key.clone(),
                id: item.id.clone(),
                when: item.when.clone(),
                origin: item.origin,
                edited: values != item.original,
                deleted: edit
                    .and_then(|edit| edit.get("deleted"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                values,
                unsaved: false,
                refs: item.refs.clone(),
            }
        });
        let added = edits
            .added
            .iter()
            .filter(|entry| entry.get("chapter").and_then(Value::as_u64) == Some(chapter.n))
            .filter_map(|entry| {
                let mut values = Values {
                    kind: default_type(chapter.kind.as_deref()).to_string(),
                    ..Values::default()
                };
                values.apply(entry);
                Some(Row {
                    key: entry.get("key")?.as_str()?.to_string(),
                    id: None,
                    when: None,
                    origin: Origin::User,
                    values,
                    edited: false,
                    deleted: entry
                        .get("deleted")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    unsaved: false,
                    refs: self
                        .user_refs
                        .get(entry.get("key")?.as_str()?)
                        .cloned()
                        .unwrap_or_default(),
                })
            });
        let mut rows: Vec<Row> = generated.chain(added).collect();
        if let Some(order) = &edits.order {
            let position: BTreeMap<&str, usize> = order
                .iter()
                .enumerate()
                .map(|(index, key)| (key.as_str(), index))
                .collect();
            rows.sort_by_key(|row| {
                position
                    .get(row.key.as_str())
                    .copied()
                    .unwrap_or(usize::MAX)
            });
        }
        rows
    }

    pub fn rows(&self, n: u64) -> Vec<Row> {
        let Some(chapter) = self.chapter(n) else {
            return Vec::new();
        };
        let saved: BTreeMap<String, Row> = self
            .row_in(&self.saved, chapter)
            .into_iter()
            .map(|row| (row.key.clone(), row))
            .collect();
        self.row_in(&self.edits, chapter)
            .into_iter()
            .map(|mut row| {
                row.unsaved = saved
                    .get(&row.key)
                    .is_none_or(|saved| saved.values != row.values || saved.deleted != row.deleted);
                row
            })
            .collect()
    }

    pub fn row(&self, key: &str) -> Option<Row> {
        self.chapters
            .iter()
            .flat_map(|chapter| self.rows(chapter.n))
            .find(|row| row.key == key)
    }

    pub fn chapter_of(&self, key: &str) -> Option<&Chapter> {
        self.chapters.iter().find(|chapter| {
            chapter.generated.iter().any(|item| item.key == key)
                || self.edits.added.iter().any(|entry| {
                    entry.get("key").and_then(Value::as_str) == Some(key)
                        && entry.get("chapter").and_then(Value::as_u64) == Some(chapter.n)
                })
        })
    }

    pub fn set(&mut self, key: &str, field: Field, value: &str) {
        let value = normalize(field, value);
        if let Some(original) = self.generated(key).map(|item| item.original.clone()) {
            let entry = self.edits.items.entry(key.to_string()).or_default();
            if original.get(field).map(str::to_string) == value {
                entry.remove(field.key());
            } else {
                entry.insert(field.key().into(), to_json(value));
            }
            if entry.is_empty() {
                self.edits.items.remove(key);
            }
        } else if let Some(index) = self.edits.added_index(key) {
            let entry = &mut self.edits.added[index];
            match value {
                Some(value) => {
                    entry.insert(field.key().into(), Value::String(value));
                }
                None => {
                    entry.remove(field.key());
                }
            }
        }
    }

    pub fn set_deleted(&mut self, key: &str, deleted: bool) {
        if self.generated(key).is_some() {
            let entry = self.edits.items.entry(key.to_string()).or_default();
            if deleted {
                entry.insert("deleted".into(), Value::Bool(true));
            } else {
                entry.remove("deleted");
            }
            if entry.is_empty() {
                self.edits.items.remove(key);
            }
        } else if let Some(index) = self.edits.added_index(key) {
            let entry = &mut self.edits.added[index];
            if deleted {
                entry.insert("deleted".into(), Value::Bool(true));
            } else {
                entry.remove("deleted");
            }
        }
    }

    pub fn revert(&mut self, key: &str) {
        if self.generated(key).is_some() {
            let deleted = self
                .edits
                .items
                .get(key)
                .and_then(|edit| edit.get("deleted"))
                .cloned();
            self.edits.items.remove(key);
            if let Some(deleted) = deleted {
                self.edits.items.insert(
                    key.to_string(),
                    Map::from_iter([("deleted".into(), deleted)]),
                );
            }
        }
    }

    pub fn add(&mut self, n: u64, key: String) -> bool {
        let Some(chapter) = self.chapter(n) else {
            return false;
        };
        let default = default_type(chapter.kind.as_deref());
        self.edits.added.push(Map::from_iter([
            ("key".into(), Value::String(key)),
            ("chapter".into(), json!(n)),
            ("title".into(), Value::String(String::new())),
            ("type".into(), Value::String(default.into())),
        ]));
        true
    }

    pub fn move_item(&mut self, key: &str, up: bool) -> bool {
        let Some(n) = self.chapter_of(key).map(|chapter| chapter.n) else {
            return false;
        };
        let mut keys: Vec<String> = self.rows(n).into_iter().map(|row| row.key).collect();
        let Some(index) = keys.iter().position(|candidate| candidate == key) else {
            return false;
        };
        let target = if up {
            index.checked_sub(1)
        } else {
            Some(index + 1).filter(|target| *target < keys.len())
        };
        let Some(target) = target else {
            return false;
        };
        keys.swap(index, target);
        let mut order: Vec<String> = Vec::new();
        for chapter in &self.chapters {
            if chapter.n == n {
                order.extend(keys.iter().cloned());
            } else {
                order.extend(self.rows(chapter.n).into_iter().map(|row| row.key));
            }
        }
        self.edits.order = Some(order);
        true
    }

    pub fn orphans(&self) -> Vec<Orphan> {
        let generated: BTreeSet<&str> = self
            .chapters
            .iter()
            .flat_map(|chapter| &chapter.generated)
            .map(|item| item.key.as_str())
            .collect();
        let chapters: BTreeSet<u64> = self.chapters.iter().map(|chapter| chapter.n).collect();
        let describe = |edit: &Map<String, Value>| {
            edit.get("title")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    if edit.get("deleted").and_then(Value::as_bool) == Some(true) {
                        "A deleted item".into()
                    } else {
                        "An edited item".into()
                    }
                })
        };
        self.edits
            .items
            .iter()
            .filter(|(key, _)| !generated.contains(key.as_str()))
            .map(|(key, edit)| Orphan {
                key: key.clone(),
                summary: describe(edit),
            })
            .chain(
                self.edits
                    .added
                    .iter()
                    .filter(|entry| {
                        entry
                            .get("chapter")
                            .and_then(Value::as_u64)
                            .is_none_or(|n| !chapters.contains(&n))
                    })
                    .filter_map(|entry| {
                        Some(Orphan {
                            key: entry.get("key")?.as_str()?.to_string(),
                            summary: format!("Added: {}", describe(entry)),
                        })
                    }),
            )
            .collect()
    }

    pub fn drop_orphan(&mut self, key: &str) {
        if self.generated(key).is_none() {
            self.edits.items.remove(key);
        }
        let chapters: BTreeSet<u64> = self.chapters.iter().map(|chapter| chapter.n).collect();
        self.edits.added.retain(|entry| {
            entry.get("key").and_then(Value::as_str) != Some(key)
                || entry
                    .get("chapter")
                    .and_then(Value::as_u64)
                    .is_some_and(|n| chapters.contains(&n))
        });
    }

    pub fn validate(&self) -> Result<(), String> {
        let untitled = self
            .chapters
            .iter()
            .flat_map(|chapter| self.rows(chapter.n))
            .find(|row| !row.deleted && row.values.title.trim().is_empty());
        match untitled {
            Some(row) => Err(format!(
                "Give {} a title before saving.",
                row.id
                    .map_or("the new item".to_string(), |id| format!("item {id}"))
            )),
            None => Ok(()),
        }
    }

    pub fn outgoing(&self) -> Value {
        let saved_added: BTreeSet<&str> = self
            .saved
            .added
            .iter()
            .filter_map(|entry| entry.get("key").and_then(Value::as_str))
            .collect();
        let added: Vec<Value> = self
            .edits
            .added
            .iter()
            .filter(|entry| {
                entry.get("deleted").and_then(Value::as_bool) != Some(true)
                    || entry
                        .get("key")
                        .and_then(Value::as_str)
                        .is_some_and(|key| saved_added.contains(key))
            })
            .map(|entry| Value::Object(entry.clone()))
            .collect();
        let mut out = json!({
            "version": 1,
            "updatedAt": self.updated_at,
            "items": self.edits.items,
            "added": added,
        });
        if let Some(order) = &self.edits.order {
            out["order"] = json!(order);
        }
        out
    }

    pub fn counts(&self) -> (usize, usize, usize) {
        let rows: Vec<Row> = self
            .chapters
            .iter()
            .flat_map(|chapter| self.rows(chapter.n))
            .collect();
        (
            rows.iter().filter(|row| !row.deleted).count(),
            rows.iter()
                .filter(|row| row.edited || row.origin == Origin::User)
                .count(),
            rows.iter().filter(|row| row.deleted).count(),
        )
    }
}

pub fn new_key() -> String {
    format!(
        "u{}",
        crate::store::new_uuid_v4()
            .chars()
            .filter(char::is_ascii_hexdigit)
            .take(10)
            .collect::<String>()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(edits: Value, kind: Option<&str>) -> ItemsEditor {
        ItemsEditor::parse(
            &json!({
                "version": 1,
                "session": "/walks/checkout",
                "topic": "Checkout",
                "kind": kind,
                "chapters": [
                    {
                        "n": 1, "name": "Intro", "kind": kind, "brief": true,
                        "items": [
                            {"id": "C1-01", "key": "c1-a", "type": "bug", "title": "Edited by user", "priority": "high", "origin": "brief", "refs": [{"ref": "bead-1"}],
                             "original": {"title": "Clipped button", "type": "bug", "priority": "high", "owner": null, "due": null}},
                            {"id": "C1-02", "key": "c1-b", "type": "ask", "title": "Rename total", "origin": "agent", "refs": [],
                             "original": {"title": "Rename total", "type": "ask", "priority": null, "owner": "Jo", "due": null}},
                            {"id": null, "key": "u1", "type": "ask", "title": "Mine", "origin": "user", "refs": []}
                        ],
                        "decisions": ["Keep summary"],
                        "questions": [{"id": "C1-Q1", "when": null, "text": "Who owns tax?"}]
                    },
                    {"n": 2, "name": "Pay", "brief": false, "items": [], "decisions": [], "questions": []}
                ],
                "orphans": [],
                "edits": edits
            })
            .to_string(),
        )
        .unwrap()
    }

    fn base() -> ItemsEditor {
        fixture(
            json!({
                "version": 1, "updatedAt": "2026-11-04T10:00:00.000Z",
                "items": {"c1-a": {"title": "Edited by user"}},
                "added": [{"key": "u1", "chapter": 1, "title": "Mine", "type": "ask"}]
            }),
            None,
        )
    }

    #[test]
    fn parses_merged_items_and_marks_saved_edits() {
        let editor = base();
        assert_eq!(editor.session, "/walks/checkout");
        assert_eq!(editor.chapters.len(), 2);
        assert_eq!(editor.chapters[0].decisions, vec!["Keep summary"]);
        assert_eq!(editor.chapters[0].questions[0].text, "Who owns tax?");
        let rows = editor.rows(1);
        assert_eq!(
            rows.iter().map(|row| row.key.as_str()).collect::<Vec<_>>(),
            ["c1-a", "c1-b", "u1"]
        );
        assert_eq!(rows[0].values.title, "Edited by user");
        assert!(rows[0].edited);
        assert_eq!(
            rows[0].refs,
            vec![ItemRef {
                reference: "bead-1".into(),
                url: None
            }]
        );
        assert!(!rows[1].edited);
        assert_eq!(rows[1].origin, Origin::Agent);
        assert_eq!(rows[1].values.owner.as_deref(), Some("Jo"));
        assert_eq!(rows[2].origin, Origin::User);
        assert!(rows.iter().all(|row| !row.unsaved));
        assert!(!editor.dirty());
        assert_eq!(editor.counts(), (3, 2, 0));
    }

    #[test]
    fn field_edits_reach_the_outgoing_json_and_reverting_to_the_original_clears_them() {
        let mut editor = base();
        editor.set("c1-b", Field::Owner, "  Sam ");
        editor.set("c1-b", Field::Due, "Friday");
        editor.set("c1-b", Field::Note, "check with finance");
        editor.set("c1-b", Field::Type, "bug");
        assert!(editor.dirty());
        let out = editor.outgoing();
        assert_eq!(
            out["items"]["c1-b"],
            json!({"owner": "Sam", "due": "Friday", "note": "check with finance", "type": "bug"})
        );
        assert_eq!(out["items"]["c1-a"], json!({"title": "Edited by user"}));
        assert_eq!(out["version"], 1);
        let row = editor.row("c1-b").unwrap();
        assert!(row.edited && row.unsaved);
        assert_eq!(row.values.note.as_deref(), Some("check with finance"));
        for (field, value) in [
            (Field::Owner, "Jo"),
            (Field::Due, ""),
            (Field::Note, " "),
            (Field::Type, "ask"),
        ] {
            editor.set("c1-b", field, value);
        }
        assert!(editor.outgoing()["items"].get("c1-b").is_none());
        assert!(!editor.dirty());
        editor.set("c1-a", Field::Title, "Clipped button");
        assert!(editor.outgoing()["items"].get("c1-a").is_none());
        assert!(!editor.row("c1-a").unwrap().edited);
    }

    #[test]
    fn clearing_a_generated_value_sends_null() {
        let mut editor = base();
        editor.set("c1-a", Field::Priority, "");
        editor.set("c1-b", Field::Owner, "");
        let out = editor.outgoing();
        assert_eq!(out["items"]["c1-a"]["priority"], Value::Null);
        assert_eq!(out["items"]["c1-b"]["owner"], Value::Null);
        assert_eq!(editor.row("c1-b").unwrap().values.owner, None);
        let reloaded = fixture(out.clone(), None);
        assert_eq!(reloaded.row("c1-a").unwrap().values.priority, None);
        assert!(reloaded.row("c1-a").unwrap().edited);
    }

    #[test]
    fn delete_and_undo_round_trip_without_leaving_empty_edits() {
        let mut editor = base();
        editor.set_deleted("c1-b", true);
        assert_eq!(editor.outgoing()["items"]["c1-b"], json!({"deleted": true}));
        assert!(editor.row("c1-b").unwrap().deleted);
        assert_eq!(editor.counts(), (2, 2, 1));
        editor.set_deleted("c1-b", false);
        assert!(editor.outgoing()["items"].get("c1-b").is_none());
        assert!(!editor.dirty());
        editor.set_deleted("c1-a", true);
        editor.revert("c1-a");
        assert_eq!(editor.outgoing()["items"]["c1-a"], json!({"deleted": true}));
        assert_eq!(editor.row("c1-a").unwrap().values.title, "Clipped button");
        editor.set_deleted("u1", true);
        assert_eq!(editor.outgoing()["added"][0]["deleted"], true);
    }

    #[test]
    fn adding_items_uses_the_chapter_kind_and_drops_unsaved_deleted_additions() {
        let mut editor = base();
        assert!(editor.add(2, "unew0001".into()));
        assert!(!editor.add(9, "unew0002".into()));
        let row = editor.row("unew0001").unwrap();
        assert_eq!(row.origin, Origin::User);
        assert_eq!(row.values.kind, "ask");
        assert!(row.unsaved);
        assert!(editor.validate().is_err());
        editor.set("unew0001", Field::Title, "Add receipt");
        editor.set("unew0001", Field::Owner, "Jo");
        editor.set("unew0001", Field::Owner, "");
        assert!(editor.validate().is_ok());
        let added = editor.outgoing()["added"].clone();
        assert_eq!(
            added[1],
            json!({"key": "unew0001", "chapter": 2, "title": "Add receipt", "type": "ask"})
        );
        editor.set_deleted("unew0001", true);
        assert!(editor.validate().is_ok());
        assert_eq!(editor.outgoing()["added"].as_array().unwrap().len(), 1);
        let mut diatribe = fixture(
            json!({"version": 1, "items": {}, "added": []}),
            Some("diatribe"),
        );
        diatribe.add(1, "unew0003".into());
        assert_eq!(diatribe.row("unew0003").unwrap().values.kind, "action");
        assert_eq!(
            diatribe.chapters[0].types(),
            ["action", "decision", "note", "question"]
        );
        assert_eq!(
            base().chapters[0].types(),
            ["bug", "ask", "decision", "question", "error"]
        );
    }

    #[test]
    fn reordering_writes_every_key_and_orders_the_rows() {
        let mut editor = base();
        assert!(!editor.move_item("c1-a", true));
        assert!(editor.move_item("u1", true));
        assert_eq!(editor.outgoing()["order"], json!(["c1-a", "u1", "c1-b"]));
        assert_eq!(
            editor
                .rows(1)
                .iter()
                .map(|row| row.key.as_str())
                .collect::<Vec<_>>(),
            ["c1-a", "u1", "c1-b"]
        );
        assert!(editor.dirty());
        editor.discard();
        assert!(!editor.dirty());
        assert!(editor.outgoing().get("order").is_none());
    }

    #[test]
    fn orphans_come_from_edits_without_items_and_can_be_dropped() {
        let mut editor = fixture(
            json!({
                "version": 1,
                "items": {"gone-1": {"title": "Old title"}, "gone-2": {"deleted": true}, "c1-a": {"owner": "Sam"}},
                "added": [{"key": "u9", "chapter": 7, "title": "Lost"}]
            }),
            None,
        );
        let orphans = editor.orphans();
        assert_eq!(
            orphans
                .iter()
                .map(|orphan| (orphan.key.as_str(), orphan.summary.as_str()))
                .collect::<Vec<_>>(),
            [
                ("gone-1", "Old title"),
                ("gone-2", "A deleted item"),
                ("u9", "Added: Lost")
            ]
        );
        editor.drop_orphan("gone-1");
        editor.drop_orphan("u9");
        editor.drop_orphan("c1-a");
        let out = editor.outgoing();
        assert!(out["items"].get("gone-1").is_none());
        assert_eq!(out["items"]["c1-a"], json!({"owner": "Sam"}));
        assert!(out["added"].as_array().unwrap().is_empty());
        assert_eq!(editor.orphans().len(), 1);
        assert!(editor.dirty());
    }

    fn diatribe_items() -> ItemsEditor {
        ItemsEditor::parse(
            &json!({
                "version": 1, "session": "/walks/talk", "kind": "diatribe",
                "chapters": [{
                    "n": 1, "name": "Talk", "kind": "diatribe", "brief": true,
                    "items": [
                        {"id": "C1-01", "key": "c1-act", "type": "action", "title": "Ship it", "origin": "brief", "refs": []},
                        {"id": "C1-02", "key": "c1-dec", "type": "decision", "title": "Keep it", "origin": "brief", "refs": []},
                        {"id": "C1-03", "key": "c1-gone", "type": "action", "title": "Dropped", "origin": "brief", "refs": []},
                        {"id": "C1-04", "key": "c1-done", "type": "action", "title": "Filed", "origin": "brief",
                         "refs": [{"ref": "acme/app#7", "url": "https://github.com/acme/app/issues/7", "tracker": "github"}]},
                        {"id": null, "key": "u2", "type": "action", "title": "Mine, filed", "origin": "user",
                         "refs": [{"ref": "wk-9", "tracker": "beads"}]}
                    ],
                    "decisions": [], "questions": []
                }],
                "edits": {"version": 1, "items": {"c1-gone": {"deleted": true}},
                          "added": [{"key": "u2", "chapter": 1, "title": "Mine, filed", "type": "action"}]}
            })
            .to_string(),
        )
        .unwrap()
    }

    #[test]
    fn filing_starts_with_the_engine_default_types_and_skips_linked_and_deleted_items() {
        assert_eq!(default_file_types(Some("diatribe")), ["action"]);
        assert_eq!(default_file_types(None), ["bug", "ask"]);
        assert_eq!(default_file_types(Some("walk")), ["bug", "ask"]);
        let walk = base();
        assert_eq!(walk.file_keys(), ["c1-b", "u1"], "c1-a is already linked");
        assert!(!walk.chosen_for_file("c1-a"));
        let mut talk = diatribe_items();
        assert_eq!(talk.file_keys(), ["c1-act"]);
        let done = talk.row("c1-done").unwrap();
        assert!(!done.fileable());
        assert_eq!(
            done.refs[0].link(),
            Some("https://github.com/acme/app/issues/7")
        );
        let mine = talk.row("u2").unwrap();
        assert_eq!(mine.refs[0].reference, "wk-9");
        assert_eq!(mine.refs[0].link(), None);
        assert!(!mine.fileable());
        talk.toggle_file("c1-gone");
        talk.toggle_file("c1-done");
        talk.toggle_file("u2");
        assert_eq!(
            talk.file_keys(),
            ["c1-act"],
            "deleted and linked items cannot be chosen"
        );
        talk.toggle_file("c1-dec");
        talk.toggle_file("c1-act");
        assert_eq!(talk.file_keys(), ["c1-dec"]);
        talk.set_deleted("c1-dec", true);
        assert!(talk.file_keys().is_empty(), "deleting an item unchooses it");
        talk.set_deleted("c1-dec", false);
        assert_eq!(talk.file_keys(), ["c1-dec"]);
    }

    #[test]
    fn a_reload_keeps_the_choice_and_defaults_new_items() {
        let mut before = base();
        before.toggle_file("c1-b");
        let mut after = fixture(
            json!({
                "version": 1, "items": {"c1-a": {"title": "Edited by user"}},
                "added": [{"key": "u1", "chapter": 1, "title": "Mine", "type": "ask"},
                          {"key": "u3", "chapter": 2, "title": "New", "type": "bug"}]
            }),
            None,
        );
        assert_eq!(after.file_keys(), ["c1-b", "u1", "u3"]);
        after.adopt_file_choice(&before);
        assert_eq!(after.file_keys(), ["u1", "u3"]);
        let mut other = diatribe_items();
        other.adopt_file_choice(&before);
        assert_eq!(
            other.file_keys(),
            ["c1-act"],
            "another recording's choice is ignored"
        );
    }

    #[test]
    fn rejects_unknown_formats_and_titles_types() {
        assert!(ItemsEditor::parse("{}").is_err());
        assert!(ItemsEditor::parse("not json").is_err());
        assert_eq!(type_label("bug"), "Bug");
        assert!(new_key().starts_with('u'));
        assert_eq!(new_key().len(), 11);
    }
}
