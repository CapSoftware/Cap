//! One list of everything Cap keeps on this computer: recordings, screenshots
//! and notes, each reduced to the few facts the library shows and the smart
//! folders match on. Strings are folded once here so matching never allocates.

use std::path::PathBuf;

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
    /// The notes library folder, for notes only.
    pub notes_folder: Option<String>,
    pub thumbnail: Option<PathBuf>,
    /// A short line of body text for note cards.
    pub excerpt: Option<String>,
    pub(crate) folded: Folded,
}

/// The item's text, folded once when the item is built.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Folded {
    pub title: String,
    pub people: Vec<String>,
    pub app: String,
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
    pub notes_folder: Option<String>,
    pub thumbnail: Option<PathBuf>,
    pub excerpt: Option<String>,
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
        let mut seen = Vec::with_capacity(people.len());
        people.retain(|p| {
            let folded = fold(p);
            let fresh = !seen.contains(&folded);
            if fresh {
                seen.push(folded);
            }
            fresh
        });
        let folded = Folded {
            title: fold(&title),
            people: seen,
            app: facts.app.as_deref().map(fold).unwrap_or_default(),
        };
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
            notes_folder: facts.notes_folder,
            thumbnail: facts.thumbnail,
            excerpt: facts.excerpt,
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
            let folded = fold(name);
            if !self.folded.people.contains(&folded) {
                self.people.push(name.to_string());
                self.folded.people.push(folded);
            }
        }
    }

    pub fn folded_title(&self) -> &str {
        &self.folded.title
    }

    pub fn folded_people(&self) -> &[String] {
        &self.folded.people
    }

    pub fn folded_app(&self) -> &str {
        &self.folded.app
    }

    /// Whether a search query (already folded) finds this item: title,
    /// people or app.
    pub fn matches_query(&self, folded_query: &str) -> bool {
        if folded_query.is_empty() {
            return true;
        }
        self.folded.title.contains(folded_query)
            || self.folded.people.iter().any(|p| p.contains(folded_query))
            || self.folded.app.contains(folded_query)
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
        assert_eq!(item.folded_people(), ["ana".to_string()]);
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
        assert_eq!(item.people, vec!["José Álvarez".to_string(), "Bo".to_string()]);
        assert!(item.matches_query("bo"));
    }
}
