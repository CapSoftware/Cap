//! Built once per change to the items or the library file, read every frame:
//! which manual folders hold which recording or screenshot, and how many items
//! each sidebar row has. The sidebar used to recount everything on every
//! render (scroll frames included), allocating a key string per item per
//! folder; now a frame only looks numbers up.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};

use cap_meetings::library::Folder;

use super::{
    KindView, Section,
    items::{Item, ItemKey},
    store::LibraryFile,
};

/// Manual folder membership for recordings and screenshots (notes carry their
/// folder in `Item::notes_folder`).
#[derive(Default)]
pub struct Membership {
    by_folder: HashMap<String, HashSet<PathBuf>>,
    by_path: HashMap<PathBuf, Vec<String>>,
}

impl Membership {
    pub fn from_file(file: &LibraryFile) -> Self {
        let mut by_folder: HashMap<String, HashSet<PathBuf>> = HashMap::new();
        let mut by_path: HashMap<PathBuf, Vec<String>> = HashMap::new();
        for (id, keys) in &file.members {
            for key in keys {
                if let Some(path) = key.strip_prefix("path:") {
                    let path = PathBuf::from(path);
                    by_folder
                        .entry(id.clone())
                        .or_default()
                        .insert(path.clone());
                    by_path.entry(path).or_default().push(id.clone());
                }
            }
        }
        Self { by_folder, by_path }
    }

    pub fn holds(&self, folder: &str, item: &Item) -> bool {
        match &item.key {
            ItemKey::Doc(_) => item.notes_folder.as_deref() == Some(folder),
            ItemKey::Path(path) => self
                .by_folder
                .get(folder)
                .is_some_and(|paths| paths.contains(path)),
        }
    }

    fn folders_of<'a>(&'a self, item: &'a Item) -> impl Iterator<Item = &'a str> + 'a {
        let note = item.notes_folder.as_deref().filter(|_| item.kind.is_doc());
        let paths = match &item.key {
            ItemKey::Path(path) => self.by_path.get(path),
            ItemKey::Doc(_) => None,
        };
        note.into_iter()
            .chain(paths.into_iter().flatten().map(String::as_str))
    }
}

/// Every sidebar count in one pass over the items.
pub fn counts(
    items: &[Item],
    folders: &[Folder],
    smart: &HashMap<String, Vec<u32>>,
    membership: &Membership,
) -> HashMap<Section, usize> {
    let mut out: HashMap<Section, usize> = HashMap::new();
    let known: HashSet<&str> = folders.iter().map(|f| f.id.as_str()).collect();
    let mut by_folder: HashMap<&str, usize> = HashMap::new();
    for item in items {
        if item.trashed {
            *out.entry(Section::Trash).or_default() += 1;
            continue;
        }
        for kind in [KindView::Recordings, KindView::Screenshots, KindView::Notes] {
            if kind.holds(item.kind) {
                *out.entry(Section::Kind(kind)).or_default() += 1;
            }
        }
        if item.pinned {
            *out.entry(Section::Pinned).or_default() += 1;
        }
        let mut seen: Vec<&str> = Vec::new();
        for folder in membership.folders_of(item) {
            if known.contains(folder) && !seen.contains(&folder) {
                seen.push(folder);
                *by_folder.entry(folder).or_default() += 1;
            }
        }
    }
    for (folder, count) in by_folder {
        out.insert(Section::Folder(folder.to_string()), count);
    }
    for (id, members) in smart {
        out.insert(Section::Smart(id.clone()), members.len());
    }
    out
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;
    use crate::library_window::items::{ItemFacts, ItemKind};

    fn folder(id: &str) -> Folder {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "createdAt": "2026-11-01T00:00:00Z"
        }))
        .unwrap()
    }

    fn library() -> (Vec<Item>, LibraryFile, Vec<Folder>) {
        let mut items = Vec::new();
        for i in 0..400 {
            let trashed = i % 23 == 0;
            let (key, kind) = match i % 4 {
                0 => (
                    ItemKey::Path(PathBuf::from(format!("/r/{i}.cap"))),
                    ItemKind::Recording,
                ),
                1 => (
                    ItemKey::Path(PathBuf::from(format!("/s/{i}.cap"))),
                    ItemKind::Screenshot,
                ),
                2 => (ItemKey::Doc(format!("m{i}")), ItemKind::Meeting),
                _ => (ItemKey::Doc(format!("n{i}")), ItemKind::Note),
            };
            items.push(Item::new(
                key,
                kind,
                format!("item {i}"),
                Utc::now(),
                ItemFacts {
                    pinned: i % 7 == 0,
                    trashed,
                    notes_folder: (kind.is_doc() && i % 3 == 0)
                        .then(|| ["a", "b", "gone"][i % 3 + (i % 2)].to_string()),
                    ..Default::default()
                },
            ));
        }
        let mut file = LibraryFile::default();
        file.members.insert(
            "a".into(),
            (0..400)
                .step_by(8)
                .map(|i| format!("path:/r/{i}.cap"))
                .chain(["path:/r/missing.cap".to_string()])
                .collect(),
        );
        file.members.insert(
            "b".into(),
            (1..400)
                .step_by(12)
                .map(|i| format!("path:/s/{i}.cap"))
                .collect(),
        );
        file.members
            .insert("gone".into(), ["path:/r/0.cap".to_string()].into());
        (items, file, vec![folder("a"), folder("b")])
    }

    /// The old per-render counting, kept as the reference.
    fn naive(items: &[Item], file: &LibraryFile, section: &Section) -> usize {
        let holds = |id: &str, item: &Item| {
            if item.kind.is_doc() {
                return item.notes_folder.as_deref() == Some(id);
            }
            file.members
                .get(id)
                .is_some_and(|keys| keys.contains(&item.key.stored()))
        };
        match section {
            Section::Kind(kind) => items
                .iter()
                .filter(|i| !i.trashed && kind.holds(i.kind))
                .count(),
            Section::Pinned => items.iter().filter(|i| !i.trashed && i.pinned).count(),
            Section::Folder(id) => items.iter().filter(|i| !i.trashed && holds(id, i)).count(),
            Section::Trash => items.iter().filter(|i| i.trashed).count(),
            _ => 0,
        }
    }

    #[test]
    fn one_pass_counts_match_counting_each_row() {
        let (items, file, folders) = library();
        let membership = Membership::from_file(&file);
        let counted = counts(&items, &folders, &HashMap::new(), &membership);
        let mut sections = vec![
            Section::Kind(KindView::Recordings),
            Section::Kind(KindView::Screenshots),
            Section::Kind(KindView::Notes),
            Section::Pinned,
            Section::Trash,
        ];
        sections.extend(folders.iter().map(|f| Section::Folder(f.id.clone())));
        for section in sections {
            assert_eq!(
                counted.get(&section).copied().unwrap_or(0),
                naive(&items, &file, &section),
                "{section:?}"
            );
        }
        // A folder that is not in the notes library has no row and no count.
        assert!(!counted.contains_key(&Section::Folder("gone".into())));
        for item in &items {
            for id in ["a", "b", "gone"] {
                let reference = if item.kind.is_doc() {
                    item.notes_folder.as_deref() == Some(id)
                } else {
                    file.members[id].contains(&item.key.stored())
                };
                assert_eq!(membership.holds(id, item), reference);
            }
        }
    }
}
