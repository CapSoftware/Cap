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
    pub fn stored(&self) -> String {
        match self {
            Self::Doc(id) => format!("doc:{id}"),
            Self::Path(path) => format!("path:{}", path.to_string_lossy()),
        }
    }

    pub fn from_stored(stored: &str) -> Option<Self> {
        if let Some(id) = stored.strip_prefix("doc:") {
            return (!id.is_empty()).then(|| Self::Doc(id.to_string()));
        }
        stored
            .strip_prefix("path:")
            .filter(|p| !p.is_empty())
            .map(|p| Self::Path(PathBuf::from(p)))
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
        people.dedup();
        let folded = Folded {
            title: fold(&title),
            people: people.iter().map(|p| fold(p)).collect(),
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
    fn stored_keys_round_trip_and_reject_junk() {
        let doc = ItemKey::Doc("20261120-abc".into());
        let path = ItemKey::Path(PathBuf::from("/x/My Recording.cap"));
        assert_eq!(ItemKey::from_stored(&doc.stored()), Some(doc));
        assert_eq!(ItemKey::from_stored(&path.stored()), Some(path));
        assert_eq!(ItemKey::from_stored("doc:"), None);
        assert_eq!(ItemKey::from_stored("path:"), None);
        assert_eq!(ItemKey::from_stored("nonsense"), None);
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
}
