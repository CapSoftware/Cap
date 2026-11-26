use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
    time::{Duration, Instant},
};

use cap_meetings::library::{DocKind, DocMeta, Folder, Library, group_by_local_day, is_valid_id};
use chrono::{DateTime, NaiveDate, Utc};
use gpui::{App, Context, EventEmitter, Subscription, Task};

use super::{format, writer};
use crate::i18n::tr;
use crate::library_window::text::natural_cmp;
use crate::meetings::{MeetingEvent, Meetings};

const REFRESH_COALESCE: Duration = Duration::from_millis(120);

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub docs: Vec<DocMeta>,
    pub trashed: Vec<DocMeta>,
    pub folders: Vec<Folder>,
}

pub fn load_snapshot(library: &Library) -> Snapshot {
    let names: Vec<String> = std::fs::read_dir(library.root())
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|name| is_valid_id(name))
                .collect()
        })
        .unwrap_or_default();
    let threads = std::thread::available_parallelism()
        .map_or(4, usize::from)
        .clamp(1, 8);
    let chunk = names.len().div_ceil(threads).max(64);
    let mut metas: Vec<DocMeta> = std::thread::scope(|scope| {
        let handles: Vec<_> = names
            .chunks(chunk)
            .map(|part| {
                scope.spawn(move || {
                    part.iter()
                        // A doc whose details can't be read still shows,
                        // from what its folder holds, instead of vanishing.
                        .filter_map(|name| library.load_or_recover(name).ok())
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    });
    metas.sort_by(|a, b| b.sort_time().cmp(&a.sort_time()).then(b.id.cmp(&a.id)));
    let (trashed, docs): (Vec<DocMeta>, Vec<DocMeta>) =
        metas.into_iter().partition(DocMeta::is_trashed);
    let mut folders = library.folders().unwrap_or_default();
    folders.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    Snapshot {
        docs,
        trashed,
        folders,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    All,
    Pinned,
    Folder(String),
    Trash,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Row {
    Head,
    Header(String),
    Doc(usize),
    Trashed(usize),
    Hit(usize),
    Empty,
    Foot,
}

/// The calendar day a moment falls on here, with the daylight saving rules of
/// that date (not today's offset).
pub fn local_day(at: DateTime<Utc>) -> NaiveDate {
    format::local(at).date()
}

pub fn build_rows(
    snapshot: &Snapshot,
    scope: &Scope,
    today: NaiveDate,
    day_of: &dyn Fn(DateTime<Utc>) -> NaiveDate,
) -> Vec<Row> {
    let mut rows = vec![Row::Head];
    if *scope == Scope::Trash {
        rows.extend((0..snapshot.trashed.len()).map(Row::Trashed));
        if rows.len() == 1 {
            rows.push(Row::Empty);
        }
        rows.push(Row::Foot);
        return rows;
    }
    let in_scope = |doc: &DocMeta| match scope {
        Scope::Folder(id) => doc.folder_id.as_deref() == Some(id.as_str()),
        Scope::Pinned => doc.pinned,
        _ => true,
    };
    if *scope == Scope::All {
        let pinned: Vec<usize> = snapshot
            .docs
            .iter()
            .enumerate()
            .filter(|(_, d)| d.pinned)
            .map(|(i, _)| i)
            .collect();
        if !pinned.is_empty() {
            rows.push(Row::Header(tr::documents::sidebar::pinned().to_string()));
            rows.extend(pinned.into_iter().map(Row::Doc));
        }
    }
    let rest: Vec<DocMeta> = snapshot
        .docs
        .iter()
        .filter(|d| in_scope(d) && (*scope != Scope::All || !d.pinned))
        .cloned()
        .collect();
    if rest.is_empty() && rows.len() == 1 {
        rows.push(Row::Empty);
        rows.push(Row::Foot);
        return rows;
    }
    let index: HashMap<&str, usize> = snapshot
        .docs
        .iter()
        .enumerate()
        .map(|(i, d)| (d.id.as_str(), i))
        .collect();
    for group in group_by_local_day(&rest, day_of) {
        rows.push(Row::Header(format::day_label(group.date, today)));
        rows.extend(
            group
                .ids
                .iter()
                .filter_map(|id| index.get(id.as_str()).copied())
                .map(Row::Doc),
        );
    }
    rows.push(Row::Foot);
    rows
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoreEvent {
    Listed,
    Opened(Option<String>),
    MetaChanged(String),
    Created(String),
}

pub struct DocStore {
    library: Option<Library>,
    pub snapshot: Arc<Snapshot>,
    index: HashMap<String, usize>,
    pub listed: bool,
    pub open: Option<String>,
    pub selection: BTreeSet<String>,
    pub selection_anchor: Option<String>,
    pending_open: Option<String>,
    refresh: Option<Task<()>>,
    refresh_again: bool,
    pub last_list_ms: Option<f64>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<StoreEvent> for DocStore {}

pub fn library(cx: &mut App) -> Option<Library> {
    if let Some(meetings) = Meetings::try_global(cx) {
        return meetings.update(cx, |m, _| m.library().cloned());
    }
    Library::open(crate::store::app_data_dir().join("documents")).ok()
}

impl DocStore {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let library = library(cx);
        Self::with_library(library, cx)
    }

    pub fn with_library(library: Option<Library>, cx: &mut Context<Self>) -> Self {
        let mut subscriptions = Vec::new();
        if let Some(meetings) = Meetings::try_global(cx) {
            subscriptions.push(
                cx.subscribe(&meetings, |this, _, event: &MeetingEvent, cx| {
                    if matches!(event, MeetingEvent::LibraryChanged) {
                        this.refresh(cx);
                    }
                }),
            );
        }
        let mut this = Self {
            library,
            snapshot: Arc::new(Snapshot::default()),
            index: HashMap::new(),
            listed: false,
            open: None,
            selection: BTreeSet::new(),
            selection_anchor: None,
            pending_open: None,
            refresh: None,
            refresh_again: false,
            last_list_ms: None,
            _subscriptions: subscriptions,
        };
        this.refresh(cx);
        this
    }

    pub fn library(&self) -> Option<&Library> {
        self.library.as_ref()
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.refresh.is_some() {
            self.refresh_again = true;
            return;
        }
        let Some(library) = self.library.clone() else {
            self.listed = true;
            cx.emit(StoreEvent::Listed);
            cx.notify();
            return;
        };
        let first = !self.listed;
        self.refresh = Some(cx.spawn(async move |this, cx| {
            if !first {
                cx.background_executor().timer(REFRESH_COALESCE).await;
            }
            let started = Instant::now();
            let snapshot = cx
                .background_executor()
                .spawn(async move { load_snapshot(&library) })
                .await;
            let elapsed = started.elapsed().as_secs_f64() * 1000.;
            this.update(cx, |this, cx| {
                this.refresh = None;
                this.last_list_ms = Some(elapsed);
                tracing::info!(
                    docs = snapshot.docs.len(),
                    trashed = snapshot.trashed.len(),
                    ms = elapsed,
                    "documents listed"
                );
                this.apply(snapshot, cx);
                if std::mem::take(&mut this.refresh_again) {
                    this.refresh(cx);
                }
            })
            .ok();
        }));
    }

    fn apply(&mut self, snapshot: Snapshot, cx: &mut Context<Self>) {
        self.snapshot = Arc::new(snapshot);
        self.reindex();
        self.listed = true;
        self.selection.retain(|id| {
            self.index.contains_key(id) || self.snapshot.trashed.iter().any(|d| &d.id == id)
        });
        cx.emit(StoreEvent::Listed);
        if let Some(id) = self.pending_open.take() {
            self.open(Some(id), cx);
        } else if let Some(open) = self.open.clone()
            && self.get(&open).is_none()
            && !self.snapshot.trashed.iter().any(|d| d.id == open)
        {
            self.open(None, cx);
        } else if let Some(open) = self.open.clone() {
            cx.emit(StoreEvent::MetaChanged(open));
        }
        cx.notify();
    }

    fn reindex(&mut self) {
        self.index = self
            .snapshot
            .docs
            .iter()
            .enumerate()
            .map(|(i, d)| (d.id.clone(), i))
            .collect();
    }

    pub fn get(&self, id: &str) -> Option<&DocMeta> {
        self.index
            .get(id)
            .and_then(|i| self.snapshot.docs.get(*i))
            .or_else(|| self.snapshot.trashed.iter().find(|d| d.id == id))
    }

    pub fn folder_name(&self, id: &str) -> Option<&str> {
        self.snapshot
            .folders
            .iter()
            .find(|f| f.id == id)
            .map(|f| f.name.as_str())
    }

    pub fn open(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        if !self.listed {
            self.pending_open = id;
            return;
        }
        let id = id.filter(|id| self.get(id).is_some());
        if self.open == id {
            return;
        }
        self.open = id.clone();
        if let Some(id) = &id {
            self.selection.clear();
            self.selection_anchor = Some(id.clone());
        }
        cx.emit(StoreEvent::Opened(id));
        cx.notify();
    }

    pub fn open_when_listed(&mut self, id: String, cx: &mut Context<Self>) {
        if self.listed && self.get(&id).is_some() {
            self.open(Some(id), cx);
        } else {
            self.pending_open = Some(id);
            self.refresh(cx);
        }
    }

    fn mutate_snapshot(&mut self, f: impl FnOnce(&mut Snapshot)) {
        let snapshot = Arc::make_mut(&mut self.snapshot);
        f(snapshot);
        snapshot
            .docs
            .sort_by(|a, b| b.sort_time().cmp(&a.sort_time()).then(b.id.cmp(&a.id)));
        self.reindex();
    }

    pub fn update_meta(
        &mut self,
        id: &str,
        change: impl Fn(&mut DocMeta) + Send + Sync + 'static,
        cx: &mut Context<Self>,
    ) {
        let change = Arc::new(change);
        let local = change.clone();
        let target = id.to_string();
        self.mutate_snapshot(|s| {
            for doc in s.docs.iter_mut().chain(s.trashed.iter_mut()) {
                if doc.id == target {
                    local(doc);
                    doc.updated_at = Utc::now();
                }
            }
            let (trashed, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut s.docs)
                .into_iter()
                .chain(std::mem::take(&mut s.trashed))
                .partition(DocMeta::is_trashed);
            s.docs = kept;
            s.trashed = trashed;
            s.trashed
                .sort_by(|a, b| b.trashed_at.cmp(&a.trashed_at).then(b.id.cmp(&a.id)));
        });
        if let Some(library) = self.library.clone() {
            let id = id.to_string();
            writer::submit(move || {
                match (
                    cap_meetings::library::lock_meta(),
                    library.load_or_recover(&id),
                ) {
                    (_lock, Ok(mut meta)) => {
                        change(&mut meta);
                        meta.updated_at = Utc::now();
                        if let Err(error) = library.save(&meta) {
                            tracing::warn!(%error, "could not save the document");
                        }
                    }
                    (_, Err(error)) => {
                        tracing::warn!(%error, "could not load the document to update it")
                    }
                }
            });
        }
        cx.emit(StoreEvent::MetaChanged(id.to_string()));
        cx.notify();
    }

    pub fn rename(
        &mut self,
        id: &str,
        title: &str,
        auto_title: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let title = title.trim().to_string();
        self.update_meta(
            id,
            move |meta| {
                if title.is_empty() {
                    meta.title_is_auto = true;
                    meta.title = auto_title.clone().unwrap_or_default();
                } else {
                    meta.title_is_auto = false;
                    meta.title = title.clone();
                }
            },
            cx,
        );
    }

    pub fn set_pinned(&mut self, ids: Vec<String>, pinned: bool, cx: &mut Context<Self>) {
        for id in ids {
            self.update_meta(&id, move |meta| meta.pinned = pinned, cx);
        }
    }

    pub fn move_to_folder(
        &mut self,
        ids: Vec<String>,
        folder: Option<String>,
        cx: &mut Context<Self>,
    ) {
        for id in ids {
            let folder = folder.clone();
            self.update_meta(&id, move |meta| meta.folder_id = folder.clone(), cx);
        }
    }

    pub fn trash(&mut self, ids: Vec<String>, cx: &mut Context<Self>) {
        let now = Utc::now();
        let open_trashed = self.open.as_ref().is_some_and(|o| ids.contains(o));
        for id in ids {
            self.update_meta(&id, move |meta| meta.trashed_at = Some(now), cx);
        }
        if open_trashed {
            self.open(None, cx);
        }
    }

    pub fn restore(&mut self, ids: Vec<String>, cx: &mut Context<Self>) {
        for id in ids {
            self.update_meta(&id, |meta| meta.trashed_at = None, cx);
        }
    }

    pub fn delete_permanently(&mut self, ids: Vec<String>, cx: &mut Context<Self>) {
        let removed = ids.clone();
        self.mutate_snapshot(|s| {
            s.trashed.retain(|d| !removed.contains(&d.id));
            s.docs.retain(|d| !removed.contains(&d.id));
        });
        if self.open.as_ref().is_some_and(|o| ids.contains(o)) {
            self.open = None;
            cx.emit(StoreEvent::Opened(None));
        }
        self.selection.retain(|id| !ids.contains(id));
        if let Some(library) = self.library.clone() {
            writer::submit(move || {
                for id in ids {
                    if let Err(error) = library.delete_permanently(&id) {
                        tracing::warn!(%error, "could not delete the document");
                    }
                }
            });
        }
        cx.emit(StoreEvent::Listed);
        cx.notify();
    }

    pub fn empty_trash(&mut self, cx: &mut Context<Self>) {
        let ids = self.snapshot.trashed.iter().map(|d| d.id.clone()).collect();
        self.delete_permanently(ids, cx);
    }

    pub fn create(&mut self, kind: DocKind, folder: Option<String>, cx: &mut Context<Self>) {
        let Some(library) = self.library.clone() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let created = writer::run(move || {
                let mut meta = library.create(kind, Utc::now(), crate_entropy())?;
                if folder.is_some() {
                    meta.folder_id = folder;
                    library.save(&meta)?;
                }
                Ok::<_, cap_meetings::library::LibraryError>(meta)
            })
            .await;
            match created {
                Some(Ok(meta)) => {
                    this.update(cx, |this, cx| this.insert_created(meta, cx))
                        .ok();
                }
                Some(Err(error)) => tracing::warn!(%error, "could not create a note"),
                None => {}
            }
        })
        .detach();
    }

    pub fn duplicate(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(library) = self.library.clone() else {
            return;
        };
        let Some(source) = self.get(id).cloned() else {
            return;
        };
        if source.kind != DocKind::Note {
            return;
        }
        let suffix = tr::documents::menu::copy_suffix().to_string();
        cx.spawn(async move |this, cx| {
            let created = writer::run(move || {
                let mut meta = library.create(DocKind::Note, Utc::now(), crate_entropy())?;
                meta.title = if source.title.trim().is_empty() {
                    String::new()
                } else {
                    format!("{} {suffix}", source.title.trim())
                };
                meta.title_is_auto = source.title_is_auto;
                meta.folder_id = source.folder_id.clone();
                meta.tags = source.tags.clone();
                library.save(&meta)?;
                if let Ok(Some(notes)) = library.read_notes(&source.id) {
                    library.write_notes(&meta.id, &notes)?;
                }
                Ok::<_, cap_meetings::library::LibraryError>(meta)
            })
            .await;
            match created {
                Some(Ok(meta)) => {
                    this.update(cx, |this, cx| this.insert_created(meta, cx))
                        .ok();
                }
                Some(Err(error)) => tracing::warn!(%error, "could not duplicate the note"),
                None => {}
            }
        })
        .detach();
    }

    fn insert_created(&mut self, meta: DocMeta, cx: &mut Context<Self>) {
        let id = meta.id.clone();
        self.mutate_snapshot(|s| {
            s.docs.retain(|d| d.id != meta.id);
            s.docs.push(meta);
        });
        cx.emit(StoreEvent::Listed);
        self.open(Some(id.clone()), cx);
        cx.emit(StoreEvent::Created(id));
        cx.notify();
    }

    pub fn create_folder(&mut self, name: String, then_move: Vec<String>, cx: &mut Context<Self>) {
        let Some(library) = self.library.clone() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let created = writer::run(move || {
                library.create_folder(&name, None, Utc::now(), crate_entropy())
            })
            .await;
            if let Some(Ok(folder)) = created {
                this.update(cx, |this, cx| {
                    let id = folder.id.clone();
                    this.mutate_snapshot(|s| {
                        s.folders.push(folder);
                        s.folders.sort_by(|a, b| natural_cmp(&a.name, &b.name));
                    });
                    if !then_move.is_empty() {
                        this.move_to_folder(then_move, Some(id), cx);
                    }
                    cx.emit(StoreEvent::Listed);
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    pub fn rename_folder(&mut self, id: &str, name: &str, cx: &mut Context<Self>) {
        let name = name.trim().to_string();
        if name.is_empty() {
            return;
        }
        let target = id.to_string();
        let local = name.clone();
        self.mutate_snapshot(|s| {
            if let Some(folder) = s.folders.iter_mut().find(|f| f.id == target) {
                folder.name = local;
            }
            s.folders.sort_by(|a, b| natural_cmp(&a.name, &b.name));
        });
        if let Some(library) = self.library.clone() {
            let id = id.to_string();
            writer::submit(move || {
                if let Err(error) = library.rename_folder(&id, &name) {
                    tracing::warn!(%error, "could not rename the folder");
                }
            });
        }
        cx.emit(StoreEvent::Listed);
        cx.notify();
    }

    pub fn delete_folder(&mut self, id: &str, cx: &mut Context<Self>) {
        let target = id.to_string();
        self.mutate_snapshot(|s| {
            s.folders.retain(|f| f.id != target);
            for doc in s.docs.iter_mut().chain(s.trashed.iter_mut()) {
                if doc.folder_id.as_deref() == Some(target.as_str()) {
                    doc.folder_id = None;
                }
            }
        });
        if let Some(library) = self.library.clone() {
            let id = id.to_string();
            writer::submit(move || {
                if let Err(error) = library.delete_folder(&id) {
                    tracing::warn!(%error, "could not delete the folder");
                }
            });
        }
        cx.emit(StoreEvent::Listed);
        cx.notify();
    }

    pub fn ids_for_action(&self, id: &str) -> Vec<String> {
        if self.selection.contains(id) && self.selection.len() > 1 {
            self.selection.iter().cloned().collect()
        } else {
            vec![id.to_string()]
        }
    }
}

pub fn crate_entropy() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as u64);
    nanos
        ^ (u64::from(std::process::id()) << 32)
        ^ COUNTER.fetch_add(0x9e37_79b9, Ordering::Relaxed)
}

/// A note's saved notes and (when asked) its summary. `Err` when a payload
/// exists but could not be read: the caller must not let anything replace it.
pub fn read_payloads(
    library: &Library,
    id: &str,
    enhanced: bool,
) -> (Result<Option<String>, String>, Result<Option<String>, String>) {
    let notes = library.read_notes(id).map_err(|e| e.to_string());
    let enhanced = if enhanced {
        library.read_enhanced(id).map_err(|e| e.to_string())
    } else {
        Ok(None)
    };
    (notes, enhanced)
}
