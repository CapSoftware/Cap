//! Building the item list from disk, off the main thread.

use std::path::PathBuf;

use cap_meetings::apps::{self, AppInfo, AppKind};
use cap_meetings::library::{DocKind, DocMeta, Folder, Library, MeetingDetails};
use chrono::{DateTime, Duration, TimeZone, Utc};

use super::items::{EventFacts, Item, ItemFacts, ItemKey, ItemKind, sort_newest_first};
use super::visuals;

#[derive(Clone, Debug, Default)]
pub struct Scan {
    pub items: Vec<Item>,
    pub folders: Vec<Folder>,
    /// The notes library opened and its folder list was read, so `folders`
    /// is the whole truth. False means "unknown", never "none".
    pub folders_loaded: bool,
    pub visual_jobs: Vec<visuals::Job>,
    pub seed_visuals: std::collections::HashMap<ItemKey, visuals::Visual>,
}

/// Everything a scan found, as one number: two scans of a library that did
/// not change on disk give the same one. Worked out with the scan, off the
/// main thread.
pub fn fingerprint(scan: &Scan) -> u64 {
    use std::hash::Hasher as _;
    struct Hasher(std::collections::hash_map::DefaultHasher);
    impl std::fmt::Write for Hasher {
        fn write_str(&mut self, s: &str) -> std::fmt::Result {
            self.0.write(s.as_bytes());
            Ok(())
        }
    }
    let mut hasher = Hasher(Default::default());
    let _ = std::fmt::Write::write_fmt(
        &mut hasher,
        format_args!(
            "{:?}{:?}{}{:?}",
            scan.items, scan.folders, scan.folders_loaded, scan.visual_jobs
        ),
    );
    hasher.0.finish()
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
    let notes_file = library
        .and_then(|l| l.doc_dir(&meta.id).ok())
        .map(|dir| dir.join(cap_meetings::library::NOTES_FILE));
    let notes_len = notes_file
        .as_ref()
        .and_then(|path| std::fs::metadata(path).ok())
        .map_or(0, |m| m.len());
    let has_notes = notes_len > 64;
    let preview = meta
        .extra
        .get(crate::meetings_ui::documents::PREVIEW_KEY)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    // A note's card shows its first lines. Meetings show their summary's
    // first line; a plain note has none, so its own text is read (once per
    // scan, small files only).
    let excerpt = preview.or_else(|| {
        (kind == ItemKind::Note && has_notes && notes_len <= NOTE_EXCERPT_MAX_FILE)
            .then(|| std::fs::read_to_string(notes_file.as_ref()?).ok())
            .flatten()
            .and_then(|json| note_excerpt(&json))
    });
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
            damaged: meta.extra.contains_key(cap_meetings::library::DAMAGED_KEY),
            notes_folder: meta.folder_id.clone(),
            thumbnail: None,
            excerpt,
            meeting_app: meeting.and_then(meeting_app),
            event: meeting.and_then(|m| m.event.as_ref()).and_then(|e| {
                Some(EventFacts {
                    start: e.start?,
                    end: e.end,
                    calendar: e.calendar_name.clone().filter(|c| !c.trim().is_empty()),
                })
            }),
        },
    )
}

/// Bigger notes files are not read just for a card's first lines.
const NOTE_EXCERPT_MAX_FILE: u64 = 256 * 1024;
const NOTE_EXCERPT_CHARS: usize = 220;

/// The first lines of a note, as one line of text: headings and blocks
/// joined, cut on a word.
pub fn note_excerpt(json: &str) -> Option<String> {
    let doc = cap_notes::Document::from_json(json).ok()?;
    let mut text = String::new();
    for block in &doc.blocks {
        let line = block.text.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push_str(" \u{00b7} ");
        }
        text.push_str(&line);
        if text.chars().count() > NOTE_EXCERPT_CHARS {
            break;
        }
    }
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= NOTE_EXCERPT_CHARS {
        return Some(text);
    }
    let cut: String = text.chars().take(NOTE_EXCERPT_CHARS).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    Some(format!("{}\u{2026}", cut.trim_end()))
}

/// The app the meeting ran in, for its icon. A call in a browser counts as
/// the browser only when nothing better is known: the event's link says
/// which service it was (a Meet link in Chrome is Google Meet).
pub fn meeting_app(meeting: &MeetingDetails) -> Option<&'static AppInfo> {
    let recorded = meeting
        .app_id
        .as_deref()
        .and_then(apps::app_by_id)
        .or_else(|| {
            let name = meeting.app_name.as_deref()?.trim();
            apps::all_apps()
                .iter()
                .find(|a| a.name.eq_ignore_ascii_case(name))
        });
    if recorded.is_some_and(|a| a.kind != AppKind::Browser) {
        return recorded;
    }
    meeting
        .event
        .as_ref()
        .and_then(|e| e.link.as_deref())
        .and_then(app_for_link)
}

/// The meeting service a join link points at.
pub fn app_for_link(link: &str) -> Option<&'static AppInfo> {
    let rest = link.trim().split_once("://").map_or(link, |(_, r)| r);
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let on = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));
    let id = if on("meet.google.com") {
        apps::GOOGLE_MEET_APP_ID
    } else if on("zoom.us") || on("zoom.com") || on("zoomgov.com") {
        "zoom"
    } else if on("teams.microsoft.com") || on("teams.live.com") {
        "teams"
    } else if on("webex.com") {
        "webex"
    } else if on("whereby.com") {
        "whereby"
    } else if on("facetime.apple.com") {
        "facetime"
    } else {
        return None;
    };
    apps::app_by_id(id)
}

/// The folder list from exactly one read: the folders sorted by name and
/// `true`, or nothing and `false` when the read failed. A failure is
/// "unknown", so callers keep every membership.
pub fn read_folders_once<E>(read: impl FnOnce() -> Result<Vec<Folder>, E>) -> (Vec<Folder>, bool) {
    match read() {
        Ok(mut folders) => {
            folders.sort_by(|a, b| super::text::natural_cmp(&a.name, &b.name));
            (folders, true)
        }
        Err(_) => (Vec::new(), false),
    }
}

/// Everything on disk. Each source is read independently: one failing (a
/// missing notes library, an unreadable recordings folder) leaves the others.
pub fn scan(library: Option<Library>) -> Scan {
    let mut items = Vec::new();
    let mut visual_jobs = Vec::new();
    for rec in crate::library::list_recordings() {
        let at = millis_to_utc(rec.sort_time_millis);
        visual_jobs.push(visuals::recording_job(
            ItemKey::Path(rec.path.clone()),
            rec.path.clone(),
            rec.thumbnail.is_some() || rec.audio_only,
        ));
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
            let item = doc_item(Some(library), meta);
            if let Some(meeting) = meta.meeting.as_ref()
                && let Ok(dir) = library.doc_dir(&meta.id)
                && let Some(job) = visuals::meeting_job(
                    item.key.clone(),
                    dir,
                    meeting,
                    item.excerpt.is_none() && meeting.transcript_chars > 0,
                )
            {
                visual_jobs.push(job);
            }
            items.push(item);
        }
        // One read of the folder list feeds both the list and whether it is
        // the whole truth. (`load_snapshot` reads it leniently: an error there
        // looks like "no folders", which must never drive pruning.)
        (folders, folders_loaded) = read_folders_once(|| library.folders());
    }
    let mut seed_visuals = Default::default();
    if let Some(seed) = seed_from_env() {
        items.extend(seed.items);
        seed_visuals = seed.seed_visuals;
        if folders.is_empty() {
            folders = seed.folders;
        }
    }
    sort_newest_first(&mut items);
    Scan {
        items,
        folders,
        folders_loaded,
        visual_jobs,
        seed_visuals,
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
/// The meeting apps the seed has always used (by detector id), so searches
/// and benchmarks match exactly what they did.
const APPS: [&str; 4] = ["zoom", "google-meet", "teams", "slack"];
/// With gaps on: every app the library draws differently. `None` is a
/// meeting with no app (in person, or the app was not known).
const SHOWCASE_APPS: [Option<&str>; 10] = [
    Some("zoom"),
    Some("google-meet"),
    Some("teams"),
    Some("slack"),
    Some("whatsapp"),
    Some("facetime"),
    Some("discord"),
    Some("webex"),
    Some("chrome"),
    None,
];
const CALENDARS: [&str; 3] = ["Work", "Team", "Personal"];

pub fn seed(count: usize, images: &[PathBuf], now: DateTime<Utc>) -> Scan {
    let gaps = std::env::var_os("CAP_GPUI_LIBRARY_SEED_GAPS").is_some();
    let folders = vec![
        seed_folder("f-seed-clients", "Clients"),
        seed_folder("f-seed-product", "Product"),
        seed_folder("f-seed-personal", "Personal"),
    ];
    let mut items = Vec::with_capacity(count);
    let mut seed_visuals = std::collections::HashMap::new();
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
                let app = if gaps {
                    SHOWCASE_APPS[(i / 7 * 3 + i % 7) % SHOWCASE_APPS.len()]
                } else {
                    Some(APPS[i % APPS.len()])
                }
                .and_then(apps::app_by_id);
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
                        app: app.map(|a| a.name.to_string()),
                        meeting_app: app.filter(|a| a.kind != AppKind::Browser),
                        // Every other meeting came from the calendar.
                        event: (i % 2 == 0).then(|| {
                            let start = at - Duration::minutes(2);
                            EventFacts {
                                start,
                                end: Some(start + Duration::minutes(30 + 15 * (i as i64 % 3))),
                                calendar: Some(CALENDARS[i % CALENDARS.len()].to_string()),
                            }
                        }),
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
                    // With gaps on, some pictures are missing on disk, as
                    // after a crash. Off (benchmarks, before/after shots),
                    // the seed is exactly what it always was, and the
                    // pictures stay in the same order either way.
                    thumbnail: next_image(images)
                        .filter(|_| !(gaps && i % 4 == 1))
                        .map(|image| {
                            if gaps && i % 5 == 4 {
                                PathBuf::from(format!("/seed/missing/{i}.png"))
                            } else {
                                image
                            }
                        }),
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
                        // With gaps on, some notes have nothing written yet.
                        has_notes: !(gaps && i % 4 == 2),
                        excerpt: (!(gaps && i % 4 == 2)).then(|| excerpt.to_string()),
                        notes_folder: (i % 3 == 0).then(|| folders[2].id.clone()),
                        ..Default::default()
                    },
                )
            }
        };
        // Every seeded meeting has its sound; with gaps on, every fourth
        // recording is sound only, the way a voice memo is.
        let wave = match item.kind {
            ItemKind::Meeting => Some(visuals::seed_wave(i)),
            ItemKind::Recording if gaps && i % 4 == 1 => Some(visuals::seed_wave(i)),
            _ => None,
        };
        if let Some(wave) = wave {
            seed_visuals.insert(
                item.key.clone(),
                visuals::Visual {
                    wave: Some(wave),
                    ..Default::default()
                },
            );
        }
        items.push(item);
    }
    Scan {
        items,
        folders,
        folders_loaded: false,
        visual_jobs: Vec::new(),
        seed_visuals,
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

    #[test]
    fn a_meeting_rebuilt_from_its_folder_is_a_damaged_item() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::open(dir.path()).unwrap();
        let meta = library
            .create(
                DocKind::Meeting,
                Utc.with_ymd_and_hms(2026, 11, 20, 9, 0, 0).unwrap(),
                1,
            )
            .unwrap();
        assert!(!doc_item(Some(&library), &meta).damaged);
        std::fs::write(library.transcript_path(&meta.id).unwrap(), "{}\n").unwrap();
        let doc_json = library.doc_dir(&meta.id).unwrap().join("doc.json");
        std::fs::write(&doc_json, "{\"id\": \"cut").unwrap();
        let recovered = library.load_or_recover(&meta.id).unwrap();
        let item = doc_item(Some(&library), &recovered);
        assert!(item.damaged);
        assert_eq!(item.kind, ItemKind::Meeting);
        assert!(item.has_transcript);
    }

    #[test]
    fn a_rescan_of_an_unchanged_library_has_the_same_fingerprint() {
        let at = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        let scan = |title: &str, bundle: &str| Scan {
            items: vec![Item::new(
                ItemKey::Path(bundle.into()),
                ItemKind::Recording,
                title,
                at,
                ItemFacts::default(),
            )],
            visual_jobs: vec![visuals::recording_job(
                ItemKey::Path(bundle.into()),
                bundle.into(),
                false,
            )],
            folders_loaded: true,
            ..Scan::default()
        };
        let shown = fingerprint(&scan("Demo", "/r/a.cap"));
        assert_eq!(fingerprint(&scan("Demo", "/r/a.cap")), shown);
        assert_ne!(fingerprint(&scan("Demo 2", "/r/a.cap")), shown, "renamed");
        let mut moved = scan("Demo", "/r/a.cap");
        moved.visual_jobs[0] =
            visuals::recording_job(ItemKey::Path("/r/a.cap".into()), "/r/b.cap".into(), false);
        assert_ne!(fingerprint(&moved), shown, "a visual job changed");
        let mut unknown = scan("Demo", "/r/a.cap");
        unknown.folders_loaded = false;
        assert_ne!(fingerprint(&unknown), shown, "folders no longer known");
    }
}
