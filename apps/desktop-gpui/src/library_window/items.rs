//! One list of everything Cap keeps on this computer: recordings, screenshots
//! and notes, each reduced to the few facts the library shows and the smart
//! folders match on. Strings are folded once here so matching never allocates.

use std::path::PathBuf;

use cap_meetings::apps::AppInfo;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::text::fold;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Recording,
    Screenshot,
    Meeting,
    Note,
}

impl ItemKind {
    pub const ALL: [Self; 4] = [Self::Recording, Self::Screenshot, Self::Meeting, Self::Note];

    pub fn is_doc(self) -> bool {
        matches!(self, Self::Meeting | Self::Note)
    }
}

/// Stable identity across rescans: the doc id for notes, the bundle path for
/// recordings and screenshots.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ItemKey {
    Doc(String),
    Path(PathBuf),
}

impl ItemKey {
    /// The string a manual folder stores for this item.
    #[cfg(test)]
    pub fn stored(&self) -> String {
        match self {
            Self::Doc(id) => format!("doc:{id}"),
            Self::Path(path) => format!("path:{}", path.to_string_lossy()),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub key: ItemKey,
    pub kind: ItemKind,
    pub title: String,
    pub at: DateTime<Utc>,
    pub duration_ms: Option<u64>,
    /// Speakers and attendees, as shown.
    pub people: Vec<String>,
    /// The meeting app or the recorded app, as shown.
    pub app: Option<String>,
    pub has_transcript: bool,
    pub has_summary: bool,
    pub has_notes: bool,
    pub pinned: bool,
    pub trashed: bool,
    /// The note's saved details could not be read; it was rebuilt from its
    /// folder (see `Library::load_or_recover`).
    pub damaged: bool,
    /// The notes library folder, for notes only.
    pub notes_folder: Option<String>,
    pub thumbnail: Option<PathBuf>,
    /// A short line of body text for note cards.
    pub excerpt: Option<String>,
    /// The meeting app, when Cap knows it: its icon is read from the system.
    pub meeting_app: Option<&'static AppInfo>,
    /// The calendar event the note was taken for. Boxed: every smart folder
    /// and search walks all items, so the item stays small.
    pub event: Option<Box<EventFacts>>,
    pub(crate) folded: Folded,
}

/// What a calendar note shows of its event.
#[derive(Clone, Debug, PartialEq)]
pub struct EventFacts {
    pub start: DateTime<Utc>,
    pub end: Option<DateTime<Utc>>,
    pub calendar: Option<String>,
}

/// The item's text, folded once when the item is built: the title, the app
/// and each person in one string, a NUL before every part after the title.
/// A search keystroke walks every item, so each item's text is one
/// allocation read by one `contains`. Folded parts never hold a NUL, so no
/// match can run from one part into the next.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Folded {
    text: String,
    title_end: u32,
    app_end: u32,
    /// Where the item's own people (saved guests and attendees) end, in the
    /// text and in `Item::people`: names heard in its transcript follow.
    own_end: u32,
    own_people: u32,
}

const PART_END: char = '\0';

impl Folded {
    fn new(title: &str, app: &str) -> Self {
        let mut text = String::with_capacity(title.len() + 1 + app.len());
        push_part(&mut text, title);
        let title_end = text.len() as u32;
        text.push(PART_END);
        push_part(&mut text, app);
        let app_end = text.len() as u32;
        Self {
            text,
            title_end,
            app_end,
            own_end: app_end,
            own_people: 0,
        }
    }

    fn title(&self) -> &str {
        &self.text[..self.title_end as usize]
    }

    fn app(&self) -> &str {
        &self.text[self.title_end as usize + 1..self.app_end as usize]
    }

    fn people(&self) -> impl Iterator<Item = &str> {
        self.text[self.app_end as usize..].split(PART_END).skip(1)
    }

    /// Adds a folded name unless it is there already; true when added.
    fn add_person(&mut self, folded: &str) -> bool {
        let clean: std::borrow::Cow<'_, str> = if folded.contains(PART_END) {
            folded.replace(PART_END, "").into()
        } else {
            folded.into()
        };
        if self.people().any(|p| p == clean) {
            return false;
        }
        self.text.push(PART_END);
        self.text.push_str(&clean);
        true
    }

    fn contains(&self, folded_query: &str) -> bool {
        !folded_query.contains(PART_END) && self.text.contains(folded_query)
    }
}

fn push_part(text: &mut String, part: &str) {
    if part.contains(PART_END) {
        text.extend(part.chars().filter(|c| *c != PART_END));
    } else {
        text.push_str(part);
    }
}

#[derive(Clone, Debug, Default)]
pub struct ItemFacts {
    pub duration_ms: Option<u64>,
    pub people: Vec<String>,
    pub app: Option<String>,
    pub has_transcript: bool,
    pub has_summary: bool,
    pub has_notes: bool,
    pub pinned: bool,
    pub trashed: bool,
    pub damaged: bool,
    pub notes_folder: Option<String>,
    pub thumbnail: Option<PathBuf>,
    pub excerpt: Option<String>,
    pub meeting_app: Option<&'static AppInfo>,
    pub event: Option<EventFacts>,
}

impl Item {
    pub fn new(
        key: ItemKey,
        kind: ItemKind,
        title: impl Into<String>,
        at: DateTime<Utc>,
        facts: ItemFacts,
    ) -> Self {
        let title = title.into();
        let mut people: Vec<String> = facts
            .people
            .into_iter()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        let mut folded = Folded::new(
            &fold(&title),
            &facts.app.as_deref().map(fold).unwrap_or_default(),
        );
        people.retain(|p| folded.add_person(&fold(p)));
        folded.own_end = folded.text.len() as u32;
        folded.own_people = people.len() as u32;
        folded.text.shrink_to_fit();
        Self {
            key,
            kind,
            title,
            at,
            duration_ms: facts.duration_ms,
            people,
            app: facts.app.filter(|a| !a.trim().is_empty()),
            has_transcript: facts.has_transcript,
            has_summary: facts.has_summary,
            has_notes: facts.has_notes,
            pinned: facts.pinned,
            trashed: facts.trashed,
            damaged: facts.damaged,
            notes_folder: facts.notes_folder,
            thumbnail: facts.thumbnail,
            excerpt: facts.excerpt,
            meeting_app: facts.meeting_app,
            event: facts.event.map(Box::new),
            folded,
        }
    }

    /// Adds speaker names heard in the meeting, keeping the order people were
    /// listed in and never repeating a name (case and accents aside).
    pub fn add_people(&mut self, names: &[String]) {
        for name in names {
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            if self.folded.add_person(&fold(name)) {
                self.people.push(name.to_string());
            }
        }
    }

    /// Puts the names heard in the meeting's transcript in place of the
    /// ones an earlier read gave, keeping the meeting's saved guests and
    /// attendees: a renamed speaker no longer shows under the old name.
    pub fn set_heard(&mut self, names: &[String]) {
        self.people.truncate(self.folded.own_people as usize);
        self.folded.text.truncate(self.folded.own_end as usize);
        self.add_people(names);
    }

    /// Whether `set_heard(names)` would change the item, without copying it.
    pub fn heard_differs(&self, names: &[String]) -> bool {
        let own = self.folded.own_people as usize;
        let mut seen: Vec<String> = self.folded.people().take(own).map(str::to_string).collect();
        let mut heard = self.people[own.min(self.people.len())..].iter();
        for name in names {
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            let folded = fold(name).replace(PART_END, "");
            if seen.contains(&folded) {
                continue;
            }
            seen.push(folded);
            if heard.next().map(String::as_str) != Some(name) {
                return true;
            }
        }
        heard.next().is_some()
    }

    pub fn folded_title(&self) -> &str {
        self.folded.title()
    }

    pub fn folded_people(&self) -> impl Iterator<Item = &str> {
        self.folded.people()
    }

    pub fn folded_app(&self) -> &str {
        self.folded.app()
    }

    /// Whether a search query (already folded) finds this item: title,
    /// people or app.
    pub fn matches_query(&self, folded_query: &str) -> bool {
        if folded_query.is_empty() {
            return true;
        }
        self.folded.contains(folded_query)
    }
}

/// Newest first, ties broken by key so the order never flickers.
pub fn sort_newest_first(items: &mut [Item]) {
    items.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.key.cmp(&b.key)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_keys_never_collide_between_notes_and_files() {
        let doc = ItemKey::Doc("x".into()).stored();
        let path = ItemKey::Path(PathBuf::from("x")).stored();
        assert_eq!(doc, "doc:x");
        assert_eq!(path, "path:x");
        assert_ne!(doc, path);
    }

    #[test]
    fn people_are_trimmed_and_blank_names_dropped() {
        let item = Item::new(
            ItemKey::Doc("a".into()),
            ItemKind::Meeting,
            "Sync",
            Utc::now(),
            ItemFacts {
                people: vec![" Ana ".into(), "".into(), "  ".into(), "Ana".into()],
                ..Default::default()
            },
        );
        assert_eq!(item.people, vec!["Ana".to_string()]);
        assert_eq!(item.folded_people().collect::<Vec<_>>(), ["ana"]);
    }

    #[test]
    fn speaker_names_merge_with_attendees_without_repeats() {
        let mut item = Item::new(
            ItemKey::Doc("a".into()),
            ItemKind::Meeting,
            "Sync",
            Utc::now(),
            ItemFacts {
                people: vec!["José Álvarez".into()],
                ..Default::default()
            },
        );
        item.add_people(&["jose alvarez".into(), "Bo".into(), " ".into(), "BO".into()]);
        assert_eq!(
            item.people,
            vec!["José Álvarez".to_string(), "Bo".to_string()]
        );
        assert!(item.matches_query("bo"));
    }

    #[test]
    fn search_finds_each_part_and_never_runs_across_two() {
        let mut item = Item::new(
            ItemKey::Doc("a".into()),
            ItemKind::Meeting,
            "Road\0map",
            Utc::now(),
            ItemFacts {
                people: vec!["Ana".into(), "Bo".into()],
                app: Some("Zoom".into()),
                ..Default::default()
            },
        );
        item.add_people(&["Cy".into()]);
        assert_eq!(item.folded_title(), "roadmap");
        assert_eq!(item.folded_app(), "zoom");
        assert_eq!(
            item.folded_people().collect::<Vec<_>>(),
            ["ana", "bo", "cy"]
        );
        for query in ["", "roadmap", "zoo", "ana", "bo", "cy"] {
            assert!(item.matches_query(query), "{query}");
        }
        for query in ["mapzoom", "zoomana", "anabo", "\0", "p\0z"] {
            assert!(!item.matches_query(query), "{query:?}");
        }

        let bare = Item::new(
            ItemKey::Doc("b".into()),
            ItemKind::Note,
            "Plan",
            Utc::now(),
            ItemFacts::default(),
        );
        assert_eq!(bare.folded_app(), "");
        assert_eq!(bare.folded_people().count(), 0);
        assert!(!bare.matches_query("ana"));
    }
}
