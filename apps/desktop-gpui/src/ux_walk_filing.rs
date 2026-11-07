//! What the walk notes window knows about a processed recording's project, its tracker, filing results and
//! glossary suggestions. Everything here is parsed from the native-walk bridge (`handoff-ask`, `projects`,
//! `file`, `glossary-*`); the window only draws it.

use serde_json::Value;

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn read(output: &str, what: &str) -> Result<Value, String> {
    serde_json::from_str(output).map_err(|error| format!("The {what} could not be read: {error}"))
}

/// A project's tracker and target, as the engine stores it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tracker {
    pub provider: String,
    pub target: String,
    pub target_name: Option<String>,
}

impl Tracker {
    fn parse(value: &Value) -> Option<Self> {
        Some(Self {
            provider: text(&value["provider"])?,
            target: text(&value["target"]).unwrap_or_default(),
            target_name: text(&value["targetName"]),
        })
    }

    pub fn name(&self) -> String {
        tracker_name(&self.provider)
    }

    /// "GitHub (acme/app)": the engine's trackerLabel.
    pub fn label(&self) -> String {
        let place = self
            .target_name
            .as_deref()
            .filter(|name| !name.is_empty())
            .unwrap_or(&self.target);
        if place.is_empty() {
            self.name()
        } else {
            format!("{} ({place})", self.name())
        }
    }
}

pub fn tracker_name(provider: &str) -> String {
    match provider {
        "github" => "GitHub".into(),
        "beads" => "beads".into(),
        "linear" => "Linear".into(),
        other => other.into(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub glossary: Option<String>,
    pub tracker: Option<Tracker>,
}

impl Project {
    fn parse(value: &Value) -> Option<Self> {
        let id = text(&value["id"])?;
        Some(Self {
            name: text(&value["name"]).unwrap_or_else(|| id.clone()),
            id,
            glossary: text(&value["glossary"]),
            tracker: Tracker::parse(&value["tracker"]),
        })
    }
}

/// `projects`: `{version, default, projects, problems}`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Projects {
    pub default: Option<String>,
    pub projects: Vec<Project>,
    pub problems: usize,
}

impl Projects {
    pub fn parse(output: &str) -> Result<Self, String> {
        let value = read(output, "projects")?;
        if value["version"].as_u64() != Some(1) {
            return Err("The projects use an unsupported format.".into());
        }
        Ok(Self {
            default: text(&value["default"]),
            projects: value["projects"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Project::parse)
                .collect(),
            problems: value["problems"].as_array().map_or(0, Vec::len),
        })
    }

    pub fn find(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|project| project.id == id)
    }
}

/// `handoff-ask` / `assign-project`: the recording's project and where its items are filed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Handoff {
    pub project: Option<(String, String)>,
    pub tracker: Option<Tracker>,
}

impl Handoff {
    pub fn parse(output: &str) -> Result<Self, String> {
        let value = read(output, "recording's project")?;
        Ok(Self {
            project: text(&value["project"]["id"])
                .map(|id| (id.clone(), text(&value["project"]["name"]).unwrap_or(id))),
            tracker: Tracker::parse(&value["tracker"]),
        })
    }

    pub fn project_id(&self) -> Option<&str> {
        self.project.as_ref().map(|(id, _)| id.as_str())
    }

    pub fn project_name(&self) -> Option<&str> {
        self.project.as_ref().map(|(_, name)| name.as_str())
    }
}

/// Whether the Items tab can file now, and what the button says when it cannot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileGate {
    /// The recording is in no project: pick one first.
    NoProject,
    /// Its project has no tracker: set one in Settings, or pick another project.
    NoTracker(String),
    NothingChosen,
    /// Unsaved item edits: they are saved (after a confirm) before the dry run.
    SaveFirst(usize),
    Ready(usize),
}

pub fn file_gate(handoff: &Handoff, chosen: usize, dirty: bool) -> FileGate {
    match (&handoff.project, &handoff.tracker) {
        (None, _) => FileGate::NoProject,
        (Some((_, name)), None) => FileGate::NoTracker(name.clone()),
        _ if chosen == 0 => FileGate::NothingChosen,
        _ if dirty => FileGate::SaveFirst(chosen),
        _ => FileGate::Ready(chosen),
    }
}

pub fn items_word(n: usize) -> &'static str {
    if n == 1 { "item" } else { "items" }
}

/// "File 3 items in GitHub (acme/app)".
pub fn file_label(handoff: &Handoff, chosen: usize) -> String {
    match &handoff.tracker {
        Some(tracker) => format!(
            "File {chosen} {} in {}",
            items_word(chosen),
            tracker.label()
        ),
        None => format!("File {chosen} {}", items_word(chosen)),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Filed {
    pub key: String,
    pub title: String,
    pub reference: Option<String>,
    pub url: Option<String>,
}

impl Filed {
    pub fn link(&self) -> Option<&str> {
        self.url
            .as_deref()
            .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skipped {
    pub key: String,
    pub title: String,
    pub refs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failed {
    pub key: String,
    pub title: String,
    pub error: String,
}

/// `file`: a dry run's plan or a real run's per-item results.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileOutcome {
    pub tracker: String,
    pub target_name: String,
    pub dry_run: bool,
    pub filed: Vec<Filed>,
    pub skipped: Vec<Skipped>,
    pub failed: Vec<Failed>,
}

impl FileOutcome {
    pub fn parse(output: &str) -> Result<Self, String> {
        let value = read(output, "filing result")?;
        let tracker = text(&value["tracker"]).ok_or("The filing result names no tracker.")?;
        let title = |item: &Value| {
            text(&item["issueTitle"])
                .or_else(|| text(&item["title"]))
                .unwrap_or_else(|| "Untitled item".into())
        };
        let key = |item: &Value| text(&item["key"]).or_else(|| text(&item["id"]));
        Ok(Self {
            target_name: text(&value["targetName"])
                .or_else(|| text(&value["target"]))
                .unwrap_or_default(),
            dry_run: value["dryRun"].as_bool().unwrap_or(false),
            filed: value["filed"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| Filed {
                    key: key(item).unwrap_or_default(),
                    title: title(item),
                    reference: text(&item["ref"]),
                    url: text(&item["url"]),
                })
                .collect(),
            skipped: value["skipped"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| Skipped {
                    key: key(item).unwrap_or_default(),
                    title: title(item),
                    refs: item["refs"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|reference| text(&reference["ref"]))
                        .collect(),
                })
                .collect(),
            failed: value["failed"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| Failed {
                    key: key(item).unwrap_or_default(),
                    title: title(item),
                    error: text(&item["error"]).unwrap_or_else(|| "Unknown error".into()),
                })
                .collect(),
            tracker,
        })
    }

    pub fn place(&self) -> String {
        let name = tracker_name(&self.tracker);
        if self.target_name.is_empty() {
            name
        } else {
            format!("{name} ({})", self.target_name)
        }
    }

    /// The confirm dialog after a dry run: what will be created, and what is skipped.
    pub fn preview(&self) -> (String, String) {
        let n = self.filed.len();
        let title = format!("Create {n} {} in {}?", issue_word(n), self.place());
        let mut lines: Vec<String> = self
            .filed
            .iter()
            .take(12)
            .map(|item| format!("• {}", item.title))
            .collect();
        if n > 12 {
            lines.push(format!("…and {} more", n - 12));
        }
        if !self.skipped.is_empty() {
            lines.push(format!(
                "{} already linked {} skipped.",
                self.skipped.len(),
                if self.skipped.len() == 1 {
                    "item is"
                } else {
                    "items are"
                }
            ));
        }
        (title, lines.join("\n"))
    }

    /// One line for the results panel.
    pub fn summary(&self) -> String {
        let mut parts = vec![format!(
            "Filed {} {} in {}",
            self.filed.len(),
            items_word(self.filed.len()),
            self.place()
        )];
        if !self.skipped.is_empty() {
            parts.push(format!("{} skipped as already linked", self.skipped.len()));
        }
        if !self.failed.is_empty() {
            parts.push(format!("{} failed", self.failed.len()));
        }
        parts.join(" · ")
    }
}

fn issue_word(n: usize) -> &'static str {
    if n == 1 { "issue" } else { "issues" }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evidence {
    pub chapter: Option<u64>,
    pub when: Option<String>,
    pub said: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Pending,
    Accepted,
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Suggestion {
    pub term: String,
    pub wrongs: Vec<String>,
    pub source: String,
    pub evidence: Option<Evidence>,
    pub status: Status,
}

impl Suggestion {
    pub fn source_label(&self) -> &str {
        match self.source.as_str() {
            "fixer" => "corrected from the screen",
            "screen" => "seen on screen",
            "brief" => "from the brief",
            other => other,
        }
    }

    /// "Chapter 1 · 00:12 · “the stripey page”".
    pub fn evidence_line(&self) -> Option<String> {
        let evidence = self.evidence.as_ref()?;
        let parts: Vec<String> = [
            evidence.chapter.map(|n| format!("Chapter {n}")),
            evidence.when.clone(),
            evidence.said.clone().map(|said| format!("“{said}”")),
        ]
        .into_iter()
        .flatten()
        .collect();
        (!parts.is_empty()).then(|| parts.join(" · "))
    }
}

/// `glossary-suggestions` / `glossary-accept` / `glossary-reject`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Suggestions {
    pub items: Vec<Suggestion>,
    pub accept_target: Option<String>,
}

impl Suggestions {
    pub fn parse(output: &str) -> Result<Self, String> {
        let value = read(output, "glossary suggestions")?;
        Ok(Self {
            items: value["suggestions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| {
                    Some(Suggestion {
                        term: text(&item["term"])?,
                        wrongs: item["wrongs"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(text)
                            .collect(),
                        source: text(&item["source"]).unwrap_or_default(),
                        evidence: item["evidence"].is_object().then(|| Evidence {
                            chapter: item["evidence"]["chapter"].as_u64(),
                            when: text(&item["evidence"]["when"]),
                            said: text(&item["evidence"]["said"]),
                        }),
                        status: match item["status"].as_str() {
                            Some("accepted") => Status::Accepted,
                            Some("rejected") => Status::Rejected,
                            _ => Status::Pending,
                        },
                    })
                })
                .collect(),
            accept_target: text(&value["acceptTarget"]),
        })
    }

    pub fn pending(&self) -> Vec<&Suggestion> {
        self.items
            .iter()
            .filter(|item| item.status == Status::Pending)
            .collect()
    }

    /// (accepted, rejected)
    pub fn done(&self) -> (usize, usize) {
        (
            self.items
                .iter()
                .filter(|item| item.status == Status::Accepted)
                .count(),
            self.items
                .iter()
                .filter(|item| item.status == Status::Rejected)
                .count(),
        )
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// "Accepted terms go to ~/.config/ux-walk/glossaries/shop.txt".
    pub fn target_line(&self) -> String {
        match &self.accept_target {
            Some(target) => format!("Accepted terms go to {}", home_relative(target)),
            None => "Accepted terms go to the default glossary".into(),
        }
    }
}

fn home_relative(path: &str) -> String {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() && path.starts_with(&format!("{home}/")) => {
            format!("~{}", &path[home.len()..])
        }
        _ => path.to_string(),
    }
}

/// After a project change: reprocessing is worth offering when the new project brings a glossary the old one
/// did not have (assigning only adds the glossary; the transcript picks it up on reprocess).
pub fn reprocess_for_glossary(before: Option<&Project>, after: Option<&Project>) -> bool {
    let glossary = |project: Option<&Project>| project.and_then(|project| project.glossary.clone());
    glossary(after).is_some() && glossary(after) != glossary(before)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn handoff(project: Option<&str>, tracker: Option<Value>) -> Handoff {
        Handoff::parse(
            &json!({
                "session": "/walks/x", "kind": "diatribe", "ask": "", "line": "", "context": "",
                "project": project.map(|id| json!({"id": id, "name": id.to_uppercase()})),
                "tracker": tracker,
            })
            .to_string(),
        )
        .unwrap()
    }

    #[test]
    fn the_file_button_waits_for_a_tracker_a_choice_and_saved_edits() {
        let github = json!({"provider": "github", "target": "acme/app", "targetName": "acme/app", "label": "GitHub (acme/app)"});
        assert_eq!(
            file_gate(&handoff(None, None), 2, false),
            FileGate::NoProject
        );
        assert_eq!(
            file_gate(&handoff(Some("shop"), None), 2, true),
            FileGate::NoTracker("SHOP".into())
        );
        let ready = handoff(Some("shop"), Some(github));
        assert_eq!(file_gate(&ready, 0, true), FileGate::NothingChosen);
        assert_eq!(file_gate(&ready, 3, true), FileGate::SaveFirst(3));
        assert_eq!(file_gate(&ready, 3, false), FileGate::Ready(3));
        assert_eq!(file_label(&ready, 1), "File 1 item in GitHub (acme/app)");
        assert_eq!(file_label(&ready, 3), "File 3 items in GitHub (acme/app)");
        assert_eq!(ready.project_id(), Some("shop"));
        assert_eq!(ready.project_name(), Some("SHOP"));
        let beads = handoff(
            Some("shop"),
            Some(json!({"provider": "beads", "target": "/src/shop"})),
        );
        assert_eq!(beads.tracker.unwrap().label(), "beads (/src/shop)");
    }

    #[test]
    fn filing_results_parse_into_filed_skipped_and_failed() {
        let outcome = FileOutcome::parse(
            &json!({
                "session": "/walks/x", "tracker": "github", "target": "acme/app", "targetName": "Acme app", "dryRun": false,
                "filed": [
                    {"key": "c1-a", "id": "C1-01", "type": "bug", "title": "Clipped", "ref": "acme/app#7", "url": "https://github.com/acme/app/issues/7", "tracker": "github"},
                    {"key": "c1-b", "id": "C1-02", "type": "ask", "title": "Rename", "ref": "acme/app#8", "url": null, "tracker": "github"}
                ],
                "skipped": [{"key": "c1-c", "id": "C1-03", "title": "Old", "refs": [{"ref": "acme/app#1", "at": "x"}]}],
                "failed": [{"key": "u1", "id": null, "type": "ask", "title": "Mine", "error": "gh: rate limited"}]
            })
            .to_string(),
        )
        .unwrap();
        assert!(!outcome.dry_run);
        assert_eq!(outcome.place(), "GitHub (Acme app)");
        assert_eq!(
            outcome.filed[0].link(),
            Some("https://github.com/acme/app/issues/7")
        );
        assert_eq!(outcome.filed[1].link(), None);
        assert_eq!(outcome.filed[1].reference.as_deref(), Some("acme/app#8"));
        assert_eq!(outcome.skipped[0].refs, ["acme/app#1"]);
        assert_eq!(outcome.failed[0].key, "u1");
        assert_eq!(outcome.failed[0].error, "gh: rate limited");
        assert_eq!(
            outcome.summary(),
            "Filed 2 items in GitHub (Acme app) · 1 skipped as already linked · 1 failed"
        );
        assert!(FileOutcome::parse("{}").is_err());
        assert!(FileOutcome::parse("nope").is_err());
    }

    #[test]
    fn a_dry_run_previews_titles_and_skips_for_the_confirm() {
        let filed: Vec<Value> = (1..=14)
            .map(|n| json!({"key": format!("k{n}"), "title": format!("Item {n}"), "issueTitle": format!("Issue {n}")}))
            .collect();
        let outcome = FileOutcome::parse(
            &json!({"tracker": "beads", "target": "/src/shop", "targetName": "shop", "dryRun": true,
                    "filed": filed, "skipped": [{"key": "old", "title": "Old", "refs": []}], "failed": []})
            .to_string(),
        )
        .unwrap();
        assert!(outcome.dry_run);
        let (title, detail) = outcome.preview();
        assert_eq!(title, "Create 14 issues in beads (shop)?");
        assert!(detail.starts_with("• Issue 1\n• Issue 2"));
        assert!(detail.contains("…and 2 more"));
        assert!(detail.ends_with("1 already linked item is skipped."));
    }

    #[test]
    fn suggestions_split_into_pending_and_done_with_their_target() {
        let mut list = Suggestions::parse(
            &json!({
                "version": 1, "acceptTarget": "/tmp/glossaries/shop.txt",
                "suggestions": [
                    {"term": "Stripe", "wrongs": ["stripey"], "source": "fixer", "evidence": {"chapter": 1, "when": "00:04", "said": "the stripey page"}, "status": "pending"},
                    {"term": "Klarna", "wrongs": [], "source": "screen", "evidence": null, "status": "rejected"},
                    {"term": "Adyen", "wrongs": ["a yen"], "source": "brief", "evidence": null, "status": "accepted"},
                    {"term": "", "wrongs": [], "source": "brief", "status": "pending"}
                ]
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(list.items.len(), 3);
        let pending = list.pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].source_label(), "corrected from the screen");
        assert_eq!(
            pending[0].evidence_line().as_deref(),
            Some("Chapter 1 · 00:04 · “the stripey page”")
        );
        assert_eq!(list.items[1].evidence_line(), None);
        assert_eq!(list.done(), (1, 1));
        assert_eq!(
            list.target_line(),
            "Accepted terms go to /tmp/glossaries/shop.txt"
        );
        list.accept_target = None;
        assert_eq!(
            list.target_line(),
            "Accepted terms go to the default glossary"
        );
        assert!(Suggestions::parse("{}").unwrap().is_empty());
    }

    #[test]
    fn projects_parse_and_a_new_glossary_offers_reprocessing() {
        let projects = Projects::parse(
            &json!({
                "version": 1, "default": "shop",
                "projects": [
                    {"version": 1, "id": "plain", "name": "Plain", "glossary": null, "tracker": null},
                    {"version": 1, "id": "shop", "name": "Shop", "glossary": "shop", "tracker": {"provider": "linear", "target": "t1", "targetName": "Engineering"}}
                ],
                "problems": [{"file": "/x/broken.json", "error": "bad"}]
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(projects.default.as_deref(), Some("shop"));
        assert_eq!(projects.problems, 1);
        let shop = projects.find("shop").unwrap();
        assert_eq!(
            shop.tracker.as_ref().unwrap().label(),
            "Linear (Engineering)"
        );
        let plain = projects.find("plain").unwrap();
        assert!(plain.tracker.is_none());
        assert!(reprocess_for_glossary(Some(plain), Some(shop)));
        assert!(reprocess_for_glossary(None, Some(shop)));
        assert!(!reprocess_for_glossary(Some(shop), Some(shop)));
        assert!(!reprocess_for_glossary(Some(shop), Some(plain)));
        assert!(!reprocess_for_glossary(Some(shop), None));
        assert!(Projects::parse(r#"{"version": 2}"#).is_err());
    }
}
