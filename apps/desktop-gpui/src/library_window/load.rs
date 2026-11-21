//! Building the item list from disk, off the main thread.

use std::path::PathBuf;

use cap_meetings::library::{DocKind, DocMeta, Folder, Library};
use chrono::{DateTime, Duration, TimeZone, Utc};

use super::items::{Item, ItemFacts, ItemKey, ItemKind, sort_newest_first};

#[derive(Clone, Debug, Default)]
pub struct Scan {
    pub items: Vec<Item>,
    pub folders: Vec<Folder>,
    /// The notes library opened and its folder list was read, so `folders`
    /// is the whole truth. False means "unknown", never "none".
    pub folders_loaded: bool,
}

fn millis_to_utc(ms: f64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms as i64)
        .single()
        .unwrap_or_else(Utc::now)
}

pub fn doc_item(library: Option<&Library>, meta: &DocMeta) -> Item {
    let kind = if meta.kind == DocKind::Meeting || meta.meeting.is_some() {
        ItemKind::Meeting
    } else {
        ItemKind::Note
    };
    let meeting = meta.meeting.as_ref();
    let has_notes = library
        .and_then(|l| l.doc_dir(&meta.id).ok())
        .and_then(|dir| std::fs::metadata(dir.join("notes.json")).ok())
        .is_some_and(|m| m.len() > 64);
    let title = meta.title.trim();
    Item::new(
        ItemKey::Doc(meta.id.clone()),
        kind,
        if title.is_empty() {
            crate::i18n::tr::documents::untitled().to_string()
        } else {
            title.to_string()
        },
        meta.sort_time(),
        ItemFacts {
            duration_ms: meeting.map(|m| m.duration_ms).filter(|d| *d > 0),
            people: crate::meetings_ui::documents::export::participants(meta),
            app: meeting.and_then(|m| m.app_name.clone()),
            has_transcript: meeting.is_some_and(|m| m.transcript_chars > 0),
            has_summary: meeting.is_some_and(|m| m.has_enhanced),
            has_notes,
            pinned: meta.pinned,
            trashed: meta.is_trashed(),
            notes_folder: meta.folder_id.clone(),
            thumbnail: None,
            excerpt: None,
        },
    )
}

/// The folder list from exactly one read: the folders sorted by name and
/// `true`, or nothing and `false` when the read failed. A failure is
/// "unknown", so callers keep every membership.
pub fn read_folders_once<E>(read: impl FnOnce() -> Result<Vec<Folder>, E>) -> (Vec<Folder>, bool) {
    match read() {
        Ok(mut folders) => {
            folders.sort_by_key(|f| f.name.to_lowercase());
            (folders, true)
        }
        Err(_) => (Vec::new(), false),
    }
}

/// Everything on disk. Each source is read independently: one failing (a
/// missing notes library, an unreadable recordings folder) leaves the others.
pub fn scan(library: Option<Library>) -> Scan {
    let mut items = Vec::new();
    for rec in crate::library::list_recordings() {
        let at = millis_to_utc(rec.sort_time_millis);
        items.push(Item::new(
            ItemKey::Path(rec.path.clone()),
            ItemKind::Recording,
            rec.pretty_name.clone(),
            at,
            ItemFacts {
                thumbnail: rec.thumbnail.clone(),
                ..Default::default()
            },
        ));
    }
    for shot in crate::library::list_screenshots() {
        items.push(Item::new(
            ItemKey::Path(shot.bundle.clone()),
            ItemKind::Screenshot,
            shot.pretty_name.clone(),
            millis_to_utc(shot.sort_time_millis),
            ItemFacts {
                thumbnail: shot.thumbnail.clone().or(Some(shot.path.clone())),
                ..Default::default()
            },
        ));
    }
    let mut folders = Vec::new();
    let mut folders_loaded = false;
    if let Some(library) = library.as_ref() {
        let snapshot = crate::meetings_ui::documents::store::load_snapshot(library);
        for meta in snapshot.docs.iter().chain(snapshot.trashed.iter()) {
            items.push(doc_item(Some(library), meta));
        }
        // One read of the folder list feeds both the list and whether it is
        // the whole truth. (`load_snapshot` reads it leniently: an error there
        // looks like "no folders", which must never drive pruning.)
        (folders, folders_loaded) = read_folders_once(|| library.folders());
    }
    if let Some(seed) = seed_from_env() {
        items.extend(seed.items);
        if folders.is_empty() {
            folders = seed.folders;
        }
    }
    sort_newest_first(&mut items);
    Scan {
        items,
        folders,
        folders_loaded,
    }
}

/// `CAP_GPUI_LIBRARY_SEED=<count>`: a made-up library for screenshots and
/// benchmarks, mixed into the real one. `CAP_GPUI_LIBRARY_SEED_IMAGES=<dir>`
/// gives recordings and screenshots real pictures.
pub fn seed_from_env() -> Option<Scan> {
    let count: usize = std::env::var("CAP_GPUI_LIBRARY_SEED").ok()?.parse().ok()?;
    let images: Vec<PathBuf> = std::env::var_os("CAP_GPUI_LIBRARY_SEED_IMAGES")
        .and_then(|dir| std::fs::read_dir(dir).ok())
        .map(|entries| {
            let mut v: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| {
                    p.extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|e| matches!(e, "png" | "jpg" | "jpeg"))
                })
                .collect();
            v.sort();
            v
        })
        .unwrap_or_default();
    Some(seed(count, &images, Utc::now()))
}

const MEETINGS: [&str; 12] = [
    "Weekly product sync",
    "Design review: onboarding",
    "1:1 with Ana",
    "Roadmap planning",
    "Customer call: export questions",
    "Standup",
    "Hiring loop debrief",
    "Pricing workshop",
    "Launch checklist",
    "Sprint retro",
    "Standup",
    "Partner intro",
];
const RECORDINGS: [&str; 8] = [
    "Export flow walkthrough",
    "Bug repro: timeline stalls",
    "New editor tour",
    "Onboarding demo for sales",
    "Release notes video",
    "Feedback on the pricing page",
    "Captions in three languages",
    "Quick update for the team",
];
const SHOTS: [&str; 6] = [
    "Pricing page",
    "Settings, dark",
    "Figma handoff",
    "Crash dialog",
    "Dashboard numbers",
    "Calendar invite",
];
const NOTES: [(&str, &str); 5] = [
    (
        "Ideas for the library",
        "Smart folders by speaker, a calmer home, search that never shrinks.",
    ),
    (
        "Launch post draft",
        "Short, confident, one screenshot. Say what changed from today.",
    ),
    (
        "Interview questions",
        "Walk me through a bug you were proud to fix.",
    ),
    (
        "Reading list",
        "Liquid Glass guidelines, source lists, smart albums.",
    ),
    ("Groceries", "Oat milk, coffee, lemons."),
];
const PEOPLE: [&str; 7] = [
    "Ana Pérez",
    "Bo Chen",
    "Sam Okafor",
    "Priya Shah",
    "Leo Martin",
    "Mia Novak",
    "Kenji Sato",
];
const APPS: [&str; 4] = ["Zoom", "Google Meet", "Microsoft Teams", "Slack"];

pub fn seed(count: usize, images: &[PathBuf], now: DateTime<Utc>) -> Scan {
    let folders = vec![
        seed_folder("f-seed-clients", "Clients"),
        seed_folder("f-seed-product", "Product"),
        seed_folder("f-seed-personal", "Personal"),
    ];
    let mut items = Vec::with_capacity(count);
    let mut image = 0usize;
    let mut next_image = |images: &[PathBuf]| {
        (!images.is_empty()).then(|| {
            image += 1;
            images[(image - 1) % images.len()].clone()
        })
    };
    for i in 0..count {
        // Dense today, thinning out over the weeks before.
        let minutes_ago = (i as i64) * (i as i64 + 6) * 7 + 25;
        let at = now - Duration::minutes(minutes_ago);
        let item = match i % 7 {
            0 | 3 | 5 => {
                let title = MEETINGS[(i / 7 * 3 + i % 7) % MEETINGS.len()];
                let n = 2 + i % 3;
                let people = (0..n)
                    .map(|k| PEOPLE[(i + k * 3) % PEOPLE.len()].to_string())
                    .collect();
                Item::new(
                    ItemKey::Doc(format!("seed-m-{i}")),
                    ItemKind::Meeting,
                    title,
                    at,
                    ItemFacts {
                        duration_ms: Some(((12 + (i * 13) % 50) as u64) * 60_000),
                        people,
                        app: Some(APPS[i % APPS.len()].to_string()),
                        has_transcript: true,
                        has_summary: i % 4 != 1,
                        has_notes: i % 3 == 0,
                        pinned: i == 5,
                        notes_folder: (i % 4 == 0).then(|| folders[i % 2].id.clone()),
                        excerpt: Some(
                            [
                                "Agreed to ship the calmer home first, smart folders next.",
                                "Ana owns the export follow-up. Revisit pricing on Friday.",
                                "Three blockers, two solved in the call.",
                            ][i % 3]
                                .to_string(),
                        ),
                        ..Default::default()
                    },
                )
            }
            1 | 4 => Item::new(
                ItemKey::Path(PathBuf::from(format!("/seed/recordings/{i}.cap"))),
                ItemKind::Recording,
                RECORDINGS[(i / 7 * 2 + usize::from(i % 7 == 4)) % RECORDINGS.len()],
                at,
                ItemFacts {
                    duration_ms: Some(((1 + (i * 7) % 9) as u64) * 60_000 + 23_000),
                    thumbnail: next_image(images),
                    pinned: i == 1,
                    ..Default::default()
                },
            ),
            2 => Item::new(
                ItemKey::Path(PathBuf::from(format!("/seed/screenshots/{i}.cap"))),
                ItemKind::Screenshot,
                SHOTS[(i / 7) % SHOTS.len()],
                at,
                ItemFacts {
                    thumbnail: next_image(images),
                    ..Default::default()
                },
            ),
            _ => {
                let (title, excerpt) = NOTES[(i / 7) % NOTES.len()];
                Item::new(
                    ItemKey::Doc(format!("seed-n-{i}")),
                    ItemKind::Note,
                    title,
                    at,
                    ItemFacts {
                        has_notes: true,
                        excerpt: Some(excerpt.to_string()),
                        notes_folder: (i % 3 == 0).then(|| folders[2].id.clone()),
                        ..Default::default()
                    },
                )
            }
        };
        items.push(item);
    }
    Scan {
        items,
        folders,
        folders_loaded: false,
    }
}

fn seed_folder(id: &str, name: &str) -> Folder {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": name,
        "createdAt": "2026-11-01T00:00:00Z",
    }))
    .expect("seed folder")
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[test]
    fn a_failed_folder_read_is_unknown_even_if_a_second_read_would_succeed() {
        let reads = Cell::new(0);
        // Fails the first time, would succeed after: only the first counts.
        let flaky = || {
            reads.set(reads.get() + 1);
            if reads.get() == 1 {
                Err("busy")
            } else {
                Ok(vec![seed_folder("f-1", "Work")])
            }
        };
        let (folders, loaded) = read_folders_once(flaky);
        assert_eq!(reads.get(), 1);
        assert!(folders.is_empty());
        assert!(!loaded);

        // And unknown folders keep every membership.
        let mut file = super::super::store::LibraryFile::default();
        file.members
            .insert("f-1".into(), ["path:/kept.cap".to_string()].into());
        let ids: Option<std::collections::BTreeSet<String>> =
            loaded.then(|| folders.iter().map(|f| f.id.clone()).collect());
        assert!(!super::super::store::prune_members(
            &mut file,
            ids.as_ref(),
            |_| false
        ));
        assert_eq!(file.members["f-1"].len(), 1);
    }

    #[test]
    fn a_good_folder_read_is_sorted_by_name() {
        let (folders, loaded) = read_folders_once(|| {
            Ok::<_, ()>(vec![seed_folder("b", "beta"), seed_folder("a", "Alpha")])
        });
        assert!(loaded);
        assert_eq!(
            folders.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            ["Alpha", "beta"]
        );
    }
}
