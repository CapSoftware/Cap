//! Projects and issue trackers for walks, diatribes and recording notes.
//!
//! A project bundles a name, a glossary, an issue tracker and target, a source folder and a
//! context notes file. Its file lives at `<configDir>/projects/<id>.json` and belongs to the
//! walk engine: Settings reads and writes projects only through the engine's validated
//! helpers (`native-walk.mjs projects|save-project|delete-project|trackers|targets`). The
//! recorder only needs ids and names, so it reads the files directly and never waits on the
//! engine. A recording names its project in its walk request (`Request::project`); processing
//! carries it into session.json, where the engine applies the project's settings.

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The recorder's last choice, in the recording settings store. An empty string is an
/// explicit "No project".
pub const LAST_USED: &str = "uxWalkProject";
/// The config key the engine reads as the default project for new recordings.
pub const DEFAULT_KEY: &str = "project";
pub const NO_PROJECT: &str = "No project";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracker {
    pub provider: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub target_name: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Empty for a project that is not saved yet; the engine names it from `name`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub glossary: Option<String>,
    #[serde(default)]
    pub tracker: Option<Tracker>,
    #[serde(default)]
    pub source_root: Option<String>,
    #[serde(default)]
    pub brief_notes: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

impl Project {
    /// "GitHub Issues (acme/web) · Glossary acme · ~/code/acme", for the project's row.
    pub fn summary(&self, trackers: &[TrackerStatus]) -> String {
        let mut parts = Vec::new();
        if let Some(tracker) = self.tracker.as_ref()
            && let Some(provider) = tracker.provider.as_deref()
        {
            let name = trackers
                .iter()
                .find(|known| known.id == provider)
                .map_or(provider, |known| known.name.as_str());
            let target = tracker
                .target_name
                .as_deref()
                .or(tracker.target.as_deref())
                .unwrap_or_default();
            parts.push(if target.is_empty() {
                name.to_string()
            } else {
                format!("{name} ({target})")
            });
        }
        if let Some(glossary) = self.glossary.as_deref() {
            parts.push(format!("Glossary {glossary}"));
        }
        if let Some(folder) = self.source_root.as_deref() {
            parts.push(folder.to_string());
        }
        if parts.is_empty() {
            "No glossary, tracker or folder yet".into()
        } else {
            parts.join(" · ")
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Problem {
    pub file: String,
    pub error: String,
}

/// What `native-walk.mjs projects` prints.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct ProjectList {
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub problems: Vec<Problem>,
    /// Named glossaries in `<configDir>/glossaries`.
    #[serde(default)]
    pub glossaries: Vec<String>,
}

impl ProjectList {
    pub fn name_of(&self, id: &str) -> Option<&str> {
        self.projects
            .iter()
            .find(|project| project.id == id)
            .map(|project| project.name.as_str())
    }
}

/// One issue tracker plugin as `native-walk.mjs trackers` reports it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerStatus {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub needs_key: bool,
    #[serde(default)]
    pub env: Option<String>,
    #[serde(default)]
    pub keychain_item: Option<String>,
    #[serde(default)]
    pub key_url: Option<String>,
    #[serde(default)]
    pub target_kind: Option<String>,
    #[serde(default)]
    pub key_present: bool,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub problem: Option<String>,
    #[serde(default)]
    pub via: Option<String>,
}

impl TrackerStatus {
    /// Whether a key can be saved for this tracker (beads uses the bd CLI and needs none).
    pub fn takes_key(&self) -> bool {
        self.keychain_item
            .as_deref()
            .is_some_and(|item| !item.trim().is_empty())
    }

    pub fn status(&self) -> String {
        if self.id == "beads" {
            return match (&self.problem, self.ok) {
                (_, true) => "Uses the bd CLI".into(),
                (Some(problem), false) => format!("Uses the bd CLI: {problem}"),
                (None, false) => "Uses the bd CLI, which is not available".into(),
            };
        }
        if self.ok {
            return match self.via.as_deref() {
                Some("gh") => "Signed in with the gh CLI".into(),
                _ if self
                    .env
                    .as_deref()
                    .is_some_and(|env| std::env::var(env).is_ok_and(|value| !value.is_empty()))
                    && !self.key_present =>
                {
                    "Using environment key".into()
                }
                _ if self.key_present => "Key saved and working".into(),
                _ => "Ready".into(),
            };
        }
        match (self.key_present, self.problem.as_deref()) {
            (true, Some(problem)) => format!("Key saved, but it did not work: {problem}"),
            (false, _) if self.id == "github" => {
                "Not signed in. Run gh auth login, or add a token.".into()
            }
            (false, _) => "No key saved".into(),
            (true, None) => "Key saved, but it did not work".into(),
        }
    }

    /// The page to create a key on, from the plugin's key hint ("https://… (scopes)").
    pub fn key_link(&self) -> Option<&str> {
        self.key_url
            .as_deref()?
            .split_whitespace()
            .find(|word| word.starts_with("https://"))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub id: String,
    pub name: String,
}

/// The engine's project id rule: a lowercase slug of at most 64 characters.
pub fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && !bytes[0].is_ascii_uppercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || *b == b'-')
}

fn config_dir() -> PathBuf {
    crate::ux_walk::config_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
}

fn project_file(dir: &Path, id: &str) -> PathBuf {
    dir.join("projects").join(format!("{id}.json"))
}

/// Saved projects as (id, name), by name, read straight from their files for the recorder.
/// The engine validates them properly; a file that does not even parse is left out here.
pub fn quick_list_in(dir: &Path) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(dir.join("projects")) else {
        return Vec::new();
    };
    let mut projects: Vec<(String, String)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let id = path
                .file_name()?
                .to_str()?
                .strip_suffix(".json")?
                .to_string();
            if !valid_id(&id) {
                return None;
            }
            let value: Value = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
            let name = value.get("name")?.as_str()?.trim().to_string();
            (value.get("id")?.as_str() == Some(id.as_str()) && !name.is_empty())
                .then_some((id, name))
        })
        .collect();
    projects.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
    projects
}

pub fn quick_list() -> Vec<(String, String)> {
    quick_list_in(&config_dir())
}

/// What the recorder last chose: `None` when it never chose, `Some(None)` for "No project".
pub fn last_used() -> Option<Option<String>> {
    crate::store::store_section(crate::store::RECORDING_SETTINGS)
        .get(LAST_USED)
        .and_then(Value::as_str)
        .map(|id| Some(id.to_string()).filter(|id| !id.is_empty()))
}

pub fn remember(choice: Option<&str>) {
    crate::store::set_store_setting(
        crate::store::RECORDING_SETTINGS,
        LAST_USED,
        Value::String(choice.unwrap_or_default().to_string()),
    );
}

pub fn configured_default(settings: &serde_json::Map<String, Value>) -> Option<String> {
    settings
        .get(DEFAULT_KEY)
        .and_then(Value::as_str)
        .filter(|id| valid_id(id))
        .map(str::to_string)
}

/// The project a new recording starts with: the recorder's last choice (including an explicit
/// "No project"), else the configured default, else none. A project that no longer exists is
/// skipped.
pub fn picker_default(
    last: Option<Option<&str>>,
    default: Option<&str>,
    exists: impl Fn(&str) -> bool,
) -> Option<String> {
    match last {
        Some(None) => None,
        Some(Some(id)) if exists(id) => Some(id.to_string()),
        _ => default.filter(|id| exists(id)).map(str::to_string),
    }
}

/// The project for a recording starting now, read fresh: Record Diatribe uses it without
/// asking. Blocking only on small file reads.
pub fn recording_project() -> Option<String> {
    let dir = config_dir();
    let settings = crate::ux_walk::load().unwrap_or_default();
    let last = last_used();
    picker_default(
        last.as_ref().map(Option::as_deref),
        configured_default(&settings).as_deref(),
        |id| valid_id(id) && project_file(&dir, id).is_file(),
    )
}

// -- The engine bridge (blocking: call off the main thread) --------------------------------

fn engine_json<T: serde::de::DeserializeOwned>(
    command: &str,
    request: Option<Value>,
) -> Result<T, String> {
    let output = match request {
        None => crate::ux_walk::run_engine(command, &crate::ux_walk::config_path()),
        Some(request) => {
            let file = std::env::temp_dir().join(format!(
                "ux-walk-{command}-{}.json",
                crate::store::new_uuid_v4()
            ));
            std::fs::write(
                &file,
                serde_json::to_vec(&request).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            let output = crate::ux_walk::run_engine(command, &file);
            let _ = std::fs::remove_file(file);
            output
        }
    }
    .map_err(|error| clean_error(&error))?;
    serde_json::from_str(output.trim()).map_err(|_| "The walk engine returned invalid JSON.".into())
}

fn clean_error(error: &str) -> String {
    let error = error.trim();
    if error.is_empty() {
        "The walk engine failed without saying why.".into()
    } else {
        error.lines().last().unwrap_or(error).to_string()
    }
}

pub fn list() -> Result<ProjectList, String> {
    engine_json("projects", None)
}

pub fn save(project: &Project, create: bool) -> Result<Project, String> {
    engine_json(
        "save-project",
        Some(serde_json::json!({ "project": project, "create": create })),
    )
}

/// Deletes a project's file. When it was the default, the default goes back to none.
pub fn delete(id: &str) -> Result<(), String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Deleted {
        was_default: bool,
    }
    let deleted: Deleted = engine_json("delete-project", Some(serde_json::json!({ "id": id })))?;
    if deleted.was_default {
        set_default(None)?;
    }
    Ok(())
}

pub fn set_default(id: Option<&str>) -> Result<(), String> {
    crate::ux_walk::save(
        DEFAULT_KEY,
        Value::String(id.unwrap_or_default().to_string()),
    )
    .map(|_| ())
}

pub fn trackers() -> Result<Vec<TrackerStatus>, String> {
    engine_json("trackers", None)
}

pub fn targets(provider: &str) -> Result<Vec<Target>, String> {
    engine_json("targets", Some(serde_json::json!({ "provider": provider })))
}

/// Saves a tracker's key in the login Keychain item the engine reads for it.
pub fn save_tracker_key(tracker: &TrackerStatus, secret: &str) -> Result<(), String> {
    let item = tracker
        .keychain_item
        .as_deref()
        .ok_or("This tracker does not use a key.")?;
    crate::ux_walk::save_keychain_secret(item, secret)
}

// -- The Settings editor's model ------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DraftField {
    Name,
    Glossary,
    Target,
    SourceRoot,
    BriefNotes,
    Url,
}

impl DraftField {
    pub const ALL: [Self; 6] = [
        Self::Name,
        Self::Glossary,
        Self::Target,
        Self::SourceRoot,
        Self::BriefNotes,
        Self::Url,
    ];

    pub fn index(self) -> usize {
        Self::ALL
            .iter()
            .position(|field| *field == self)
            .unwrap_or(0)
    }

    pub fn placeholder(self) -> &'static str {
        match self {
            Self::Name => "Project name",
            Self::Glossary => "Glossary name (new or existing)",
            Self::Target => "Target, typed by hand",
            Self::SourceRoot => "Source folder",
            Self::BriefNotes => "Context notes file",
            Self::Url => "https://",
        }
    }

    /// The field an engine validation message names ("…: project.url: must be a URL").
    pub fn from_engine_error(message: &str) -> Option<Self> {
        let rest = &message[message.find("project.")? + "project.".len()..];
        let field: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        match field.as_str() {
            "name" | "id" => Some(Self::Name),
            "glossary" => Some(Self::Glossary),
            "tracker" => Some(Self::Target),
            "sourceRoot" => Some(Self::SourceRoot),
            "briefNotes" => Some(Self::BriefNotes),
            "url" => Some(Self::Url),
            _ => None,
        }
    }
}

/// The editor's text fields, in [`DraftField::ALL`] order.
pub type DraftText = [String; 6];

/// A project being added or edited. The text lives in the editor's inputs; this holds the
/// rest: which project, the tracker choice and the inline error.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Draft {
    /// The project's id when editing; `None` while adding.
    pub id: Option<String>,
    pub provider: Option<String>,
    /// The target picked from the tracker's list, so its display name is kept.
    pub picked_target: Option<Target>,
    pub error: Option<(Option<DraftField>, String)>,
    pub saving: bool,
}

fn optional(text: &str) -> Option<String> {
    Some(text.trim().to_string()).filter(|text| !text.is_empty())
}

impl Draft {
    pub fn adding() -> (Self, DraftText) {
        (Self::default(), Default::default())
    }

    pub fn editing(project: &Project) -> (Self, DraftText) {
        let tracker = project
            .tracker
            .as_ref()
            .filter(|tracker| tracker.provider.is_some());
        let draft = Self {
            id: Some(project.id.clone()),
            provider: tracker.and_then(|tracker| tracker.provider.clone()),
            picked_target: tracker.and_then(|tracker| {
                Some(Target {
                    id: tracker.target.clone()?,
                    name: tracker
                        .target_name
                        .clone()
                        .or_else(|| tracker.target.clone())?,
                })
            }),
            error: None,
            saving: false,
        };
        let text = [
            project.name.clone(),
            project.glossary.clone().unwrap_or_default(),
            tracker
                .and_then(|tracker| tracker.target.clone())
                .unwrap_or_default(),
            project.source_root.clone().unwrap_or_default(),
            project.brief_notes.clone().unwrap_or_default(),
            project.url.clone().unwrap_or_default(),
        ];
        (draft, text)
    }

    pub fn is_new(&self) -> bool {
        self.id.is_none()
    }

    /// Picking a tracker clears a target from another tracker.
    pub fn choose_provider(&mut self, provider: Option<String>, text: &mut DraftText) {
        if self.provider != provider {
            self.picked_target = None;
            text[DraftField::Target.index()].clear();
        }
        self.provider = provider;
    }

    pub fn choose_target(&mut self, target: Target, text: &mut DraftText) {
        text[DraftField::Target.index()] = target.id.clone();
        self.picked_target = Some(target);
    }

    /// The project to send to the engine, or the first problem the editor can see itself.
    /// Everything else (URLs, tracker ids) the engine validates and its message shows inline.
    pub fn project(&self, text: &DraftText) -> Result<Project, (Option<DraftField>, String)> {
        let field = |field: DraftField| optional(&text[field.index()]);
        let name = field(DraftField::Name).ok_or((
            Some(DraftField::Name),
            "Give the project a name.".to_string(),
        ))?;
        let tracker = match self.provider.clone() {
            None => None,
            Some(provider) => {
                let target = field(DraftField::Target).ok_or((
                    Some(DraftField::Target),
                    "Choose a target for this tracker, or type one.".to_string(),
                ))?;
                let target_name = self
                    .picked_target
                    .as_ref()
                    .filter(|picked| picked.id == target)
                    .map(|picked| picked.name.clone());
                Some(Tracker {
                    provider: Some(provider),
                    target: Some(target),
                    target_name,
                })
            }
        };
        Ok(Project {
            id: self.id.clone().unwrap_or_default(),
            name,
            glossary: field(DraftField::Glossary),
            tracker,
            source_root: field(DraftField::SourceRoot),
            brief_notes: field(DraftField::BriefNotes),
            url: field(DraftField::Url),
        })
    }

    /// An engine refusal, placed under the field it names.
    pub fn refused(&mut self, message: String) {
        self.saving = false;
        self.error = Some((DraftField::from_engine_error(&message), message));
    }
}

/// "Add from tracker…": a tracker, its targets and the ones chosen.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Import {
    pub provider: Option<String>,
    pub targets: Option<Result<Vec<Target>, String>>,
    pub chosen: BTreeSet<String>,
    pub saving: bool,
}

impl Import {
    pub fn choose_provider(&mut self, provider: String) {
        if self.provider.as_deref() != Some(provider.as_str()) {
            self.provider = Some(provider);
            self.targets = None;
            self.chosen.clear();
        }
    }

    pub fn toggle(&mut self, target: &str) {
        if !self.chosen.remove(target) {
            self.chosen.insert(target.to_string());
        }
    }

    /// New projects for the chosen targets, named after them with the tracker preset. A
    /// beads target is a folder, so it is also the project's source folder. Targets that a
    /// project already files into are skipped.
    pub fn projects(&self, existing: &[Project]) -> Vec<Project> {
        let (Some(provider), Some(Ok(targets))) = (self.provider.as_deref(), &self.targets) else {
            return Vec::new();
        };
        targets
            .iter()
            .filter(|target| self.chosen.contains(&target.id))
            .filter(|target| !already_tracked(provider, &target.id, existing))
            .map(|target| Project {
                id: String::new(),
                name: target.name.clone(),
                glossary: None,
                tracker: Some(Tracker {
                    provider: Some(provider.to_string()),
                    target: Some(target.id.clone()),
                    target_name: Some(target.name.clone()),
                }),
                source_root: (provider == "beads").then(|| target.id.clone()),
                brief_notes: None,
                url: (provider == "github").then(|| format!("https://github.com/{}", target.id)),
            })
            .collect()
    }
}

pub fn already_tracked(provider: &str, target: &str, existing: &[Project]) -> bool {
    existing.iter().any(|project| {
        project.tracker.as_ref().is_some_and(|tracker| {
            tracker.provider.as_deref() == Some(provider)
                && tracker.target.as_deref() == Some(target)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str, name: &str) -> Project {
        Project {
            id: id.into(),
            name: name.into(),
            ..Project::default()
        }
    }

    #[test]
    fn picker_prefers_the_last_choice_then_the_default_then_none() {
        let exists = |id: &str| ["acme", "beta"].contains(&id);
        assert_eq!(
            picker_default(Some(Some("beta")), Some("acme"), exists).as_deref(),
            Some("beta")
        );
        assert_eq!(picker_default(Some(None), Some("acme"), exists), None);
        assert_eq!(
            picker_default(None, Some("acme"), exists).as_deref(),
            Some("acme")
        );
        assert_eq!(
            picker_default(Some(Some("gone")), Some("acme"), exists).as_deref(),
            Some("acme")
        );
        assert_eq!(picker_default(None, Some("gone"), exists), None);
        assert_eq!(picker_default(None, None, exists), None);
    }

    #[test]
    fn project_ids_follow_the_engine_rule() {
        for id in ["acme", "acme-web-2", "0day"] {
            assert!(valid_id(id), "{id}");
        }
        for id in [
            "",
            "Acme",
            "-acme",
            "acme/web",
            "../x",
            "a b",
            &"a".repeat(65),
        ] {
            assert!(!valid_id(id), "{id}");
        }
    }

    #[test]
    fn project_json_matches_the_engine_contract() {
        let json = r#"{"version":1,"id":"acme","name":"Acme","glossary":"acme","tracker":{"provider":"linear","target":"T1/P2","targetName":"Eng / Web"},"sourceRoot":"~/code/acme","briefNotes":null,"url":"https://acme.test"}"#;
        let parsed: Project = serde_json::from_str(json).unwrap();
        assert_eq!(
            parsed.tracker.as_ref().unwrap().target_name.as_deref(),
            Some("Eng / Web")
        );
        assert_eq!(parsed.source_root.as_deref(), Some("~/code/acme"));
        let sent = serde_json::to_value(Project {
            id: String::new(),
            ..parsed.clone()
        })
        .unwrap();
        assert!(
            sent.get("id").is_none(),
            "a new project lets the engine pick its id"
        );
        assert_eq!(sent["sourceRoot"], "~/code/acme");
        assert_eq!(sent["tracker"]["targetName"], "Eng / Web");
        assert_eq!(serde_json::to_value(&parsed).unwrap()["id"], "acme");
        let list: ProjectList = serde_json::from_str(
            r#"{"version":1,"default":"acme","projects":[{"version":1,"id":"acme","name":"Acme","glossary":null,"tracker":null,"sourceRoot":null,"briefNotes":null,"url":null}],"problems":[{"file":"/x/bad.json","error":"not JSON"}]}"#,
        )
        .unwrap();
        assert_eq!(list.default.as_deref(), Some("acme"));
        assert_eq!(list.name_of("acme"), Some("Acme"));
        assert_eq!(list.problems.len(), 1);
        assert!(list.glossaries.is_empty());
    }

    #[test]
    fn adding_a_project_needs_a_name_and_a_target_for_its_tracker() {
        let (mut draft, mut text) = Draft::adding();
        assert!(draft.is_new());
        assert_eq!(draft.project(&text).unwrap_err().0, Some(DraftField::Name));
        text[DraftField::Name.index()] = "  Acme  ".into();
        text[DraftField::Url.index()] = " ".into();
        let plain = draft.project(&text).unwrap();
        assert_eq!(plain.name, "Acme");
        assert_eq!(plain.url, None);
        assert_eq!(plain.tracker, None);
        assert!(plain.id.is_empty());

        draft.choose_provider(Some("github".into()), &mut text);
        assert_eq!(
            draft.project(&text).unwrap_err().0,
            Some(DraftField::Target)
        );
        draft.choose_target(
            Target {
                id: "acme/web".into(),
                name: "Acme Web".into(),
            },
            &mut text,
        );
        let tracked = draft.project(&text).unwrap();
        let tracker = tracked.tracker.unwrap();
        assert_eq!(tracker.target.as_deref(), Some("acme/web"));
        assert_eq!(tracker.target_name.as_deref(), Some("Acme Web"));

        // Typed by hand over a picked target: the picked name no longer applies.
        text[DraftField::Target.index()] = "acme/api".into();
        let typed = draft.project(&text).unwrap().tracker.unwrap();
        assert_eq!(typed.target.as_deref(), Some("acme/api"));
        assert_eq!(typed.target_name, None);

        // Another tracker clears the target.
        draft.choose_provider(Some("linear".into()), &mut text);
        assert!(text[DraftField::Target.index()].is_empty());
        assert_eq!(draft.picked_target, None);
        draft.choose_provider(None, &mut text);
        assert_eq!(draft.project(&text).unwrap().tracker, None);
    }

    #[test]
    fn editing_round_trips_a_saved_project_and_keeps_its_id() {
        let saved = Project {
            id: "acme".into(),
            name: "Acme".into(),
            glossary: Some("acme".into()),
            tracker: Some(Tracker {
                provider: Some("linear".into()),
                target: Some("T1".into()),
                target_name: Some("Engineering".into()),
            }),
            source_root: Some("~/code/acme".into()),
            brief_notes: Some("~/notes/acme.md".into()),
            url: Some("https://acme.test".into()),
        };
        let (draft, text) = Draft::editing(&saved);
        assert!(!draft.is_new());
        assert_eq!(draft.project(&text).unwrap(), saved);
    }

    #[test]
    fn engine_refusals_land_on_the_field_they_name() {
        for (message, field) in [
            ("project.url: must be a URL", Some(DraftField::Url)),
            (
                "/x/projects/a.json: project.tracker.target: required when a provider is set",
                Some(DraftField::Target),
            ),
            ("project.glossary: use letters", Some(DraftField::Glossary)),
            ("project.id: \"a\" is already used", Some(DraftField::Name)),
            ("EACCES: permission denied", None),
        ] {
            let (mut draft, _) = Draft::adding();
            draft.saving = true;
            draft.refused(message.into());
            assert!(!draft.saving);
            assert_eq!(draft.error, Some((field, message.to_string())));
        }
    }

    #[test]
    fn importing_names_projects_after_targets_and_skips_tracked_ones() {
        let mut import = Import::default();
        import.choose_provider("github".into());
        import.targets = Some(Ok(vec![
            Target {
                id: "acme/web".into(),
                name: "acme/web".into(),
            },
            Target {
                id: "acme/api".into(),
                name: "acme/api".into(),
            },
            Target {
                id: "acme/old".into(),
                name: "acme/old".into(),
            },
        ]));
        import.toggle("acme/web");
        import.toggle("acme/api");
        import.toggle("acme/old");
        import.toggle("acme/old");
        let mut tracked = project("web", "Web");
        tracked.tracker = Some(Tracker {
            provider: Some("github".into()),
            target: Some("acme/web".into()),
            target_name: None,
        });
        let made = import.projects(&[tracked]);
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].name, "acme/api");
        assert!(made[0].id.is_empty());
        assert_eq!(
            made[0].tracker.as_ref().unwrap().provider.as_deref(),
            Some("github")
        );
        assert_eq!(made[0].url.as_deref(), Some("https://github.com/acme/api"));

        import.choose_provider("beads".into());
        assert!(import.chosen.is_empty() && import.targets.is_none());
        import.targets = Some(Ok(vec![Target {
            id: "/code/acme".into(),
            name: "acme".into(),
        }]));
        import.toggle("/code/acme");
        let beads = import.projects(&[]);
        assert_eq!(beads[0].source_root.as_deref(), Some("/code/acme"));
        assert_eq!(beads[0].url, None);
    }

    #[test]
    fn tracker_rows_say_how_each_tracker_is_reached() {
        let tracker = |id: &str| TrackerStatus {
            id: id.into(),
            name: id.into(),
            ..TrackerStatus::default()
        };
        let mut beads = tracker("beads");
        beads.ok = true;
        assert_eq!(beads.status(), "Uses the bd CLI");
        assert!(!beads.takes_key());
        beads.ok = false;
        beads.problem = Some("bd is not installed (not on PATH)".into());
        assert!(beads.status().contains("not installed"));

        let mut github = tracker("github");
        github.keychain_item = Some("ux-walk-github".into());
        github.key_url = Some(
            "https://github.com/settings/personal-access-tokens (Issues: read and write), or run gh auth login"
                .into(),
        );
        github.ok = true;
        github.via = Some("gh".into());
        assert_eq!(github.status(), "Signed in with the gh CLI");
        assert!(github.takes_key());
        assert_eq!(
            github.key_link(),
            Some("https://github.com/settings/personal-access-tokens")
        );
        github.ok = false;
        github.via = None;
        assert!(github.status().contains("gh auth login"));

        let mut linear = tracker("linear");
        linear.keychain_item = Some("ux-walk-linear".into());
        linear.problem = Some("no Linear key".into());
        assert_eq!(linear.status(), "No key saved");
        linear.key_present = true;
        linear.problem = Some("Linear 401: bad key".into());
        assert!(linear.status().contains("401"));
        linear.ok = true;
        linear.problem = None;
        assert_eq!(linear.status(), "Key saved and working");
    }

    #[test]
    fn the_recorder_reads_names_from_project_files_and_skips_broken_ones() {
        let dir = std::env::temp_dir().join(format!(
            "ux-walk-projects-{}-{}",
            std::process::id(),
            crate::store::new_uuid_v4()
        ));
        let projects = dir.join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::write(projects.join("zeta.json"), r#"{"id":"zeta","name":"Zeta"}"#).unwrap();
        std::fs::write(
            projects.join("acme.json"),
            r#"{"id":"acme","name":"acme web"}"#,
        )
        .unwrap();
        std::fs::write(projects.join("broken.json"), "{nope").unwrap();
        std::fs::write(
            projects.join("other.json"),
            r#"{"id":"else","name":"Else"}"#,
        )
        .unwrap();
        std::fs::write(projects.join("Bad.json"), r#"{"id":"Bad","name":"Bad"}"#).unwrap();
        assert_eq!(
            quick_list_in(&dir),
            vec![
                ("acme".to_string(), "acme web".to_string()),
                ("zeta".to_string(), "Zeta".to_string())
            ]
        );
        assert!(quick_list_in(&dir.join("missing")).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_project_summary_names_its_tracker_glossary_and_folder() {
        let trackers = [TrackerStatus {
            id: "github".into(),
            name: "GitHub Issues".into(),
            ..TrackerStatus::default()
        }];
        let mut acme = project("acme", "Acme");
        assert_eq!(
            acme.summary(&trackers),
            "No glossary, tracker or folder yet"
        );
        acme.tracker = Some(Tracker {
            provider: Some("github".into()),
            target: Some("acme/web".into()),
            target_name: None,
        });
        acme.glossary = Some("acme".into());
        acme.source_root = Some("~/code/acme".into());
        assert_eq!(
            acme.summary(&trackers),
            "GitHub Issues (acme/web) · Glossary acme · ~/code/acme"
        );
    }
}
