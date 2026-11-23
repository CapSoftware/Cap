use std::borrow::Cow;

use cap_meetings::{
    library::{DocKind, DocMeta, Library},
    transcript::Transcript,
};
use cap_notes::Document;
use gpui::{App, ClipboardItem, Entity, Task, WeakEntity, Window};

use super::{export, store::DocStore, window::DocumentsWindow, writer};
use crate::{i18n::tr, meetings::Meetings};

pub fn markdown_of(json: Option<String>) -> Option<String> {
    json.and_then(|json| Document::from_json(&json).ok())
        .map(|doc| doc.to_markdown())
        .filter(|md| !md.trim().is_empty())
}

pub fn load_transcript(id: &str, cx: &mut App) -> Task<Option<Transcript>> {
    let live = Meetings::try_global(cx).and_then(|meetings| {
        meetings.update(cx, |m, _| {
            if m.is_finishing(id) {
                m.transcript(id).map(Cow::into_owned)
            } else {
                None
            }
        })
    });
    if let Some(live) = live {
        return Task::ready(Some(live));
    }
    let path = super::store::library(cx).and_then(|l| l.transcript_path(id).ok());
    cx.background_executor().spawn(async move {
        let path = path?;
        Transcript::load_jsonl(&path).ok().map(|(t, _)| t)
    })
}

fn toast(root: &WeakEntity<DocumentsWindow>, message: &'static str, cx: &mut App) {
    root.update(cx, |root, cx| root.show_toast(message, None, None, cx))
        .ok();
}

pub fn copy_notes(
    store: &Entity<DocStore>,
    id: &str,
    root: WeakEntity<DocumentsWindow>,
    cx: &mut App,
) {
    let Some(library) = store.read(cx).library().cloned() else {
        return;
    };
    let Some(meta) = store.read(cx).get(id).cloned() else {
        return;
    };
    let id = id.to_string();
    // Read on the writer, behind any save still queued, so the copy has the
    // edits made just before.
    let markdown = writer::run(move || {
        let enhanced = (meta.kind == DocKind::Meeting)
            .then(|| markdown_of(library.read_enhanced(&id).ok().flatten()))
            .flatten();
        let notes = markdown_of(library.read_notes(&id).ok().flatten());
        match (enhanced, notes) {
            (Some(enhanced), Some(notes)) => Some(format!("{enhanced}\n\n{notes}")),
            (enhanced, notes) => enhanced.or(notes),
        }
    });
    cx.spawn(async move |cx| {
        let markdown = markdown.await.flatten();
        cx.update(|cx| match markdown {
            Some(markdown) => {
                cx.write_to_clipboard(ClipboardItem::new_string(markdown));
                toast(&root, tr::documents::toast::copied(), cx);
            }
            None => toast(&root, tr::documents::toast::nothing_to_copy(), cx),
        });
    })
    .detach();
}

pub fn copy_transcript(
    store: &Entity<DocStore>,
    id: &str,
    root: WeakEntity<DocumentsWindow>,
    cx: &mut App,
) {
    let Some(meta) = store.read(cx).get(id).cloned() else {
        return;
    };
    let transcript = load_transcript(id, cx);
    cx.spawn(async move |cx| {
        let transcript = transcript.await.unwrap_or_default();
        cx.update(|cx| {
            if transcript.is_empty() {
                toast(&root, tr::documents::toast::nothing_to_copy(), cx);
                return;
            }
            let text = export::plain_transcript(&meta, &transcript);
            cx.write_to_clipboard(ClipboardItem::new_string(text));
            toast(&root, tr::documents::toast::copied(), cx);
        });
    })
    .detach();
}

pub fn export_markdown(
    store: &Entity<DocStore>,
    id: &str,
    root: WeakEntity<DocumentsWindow>,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(library) = store.read(cx).library().cloned() else {
        return;
    };
    let Some(meta) = store.read(cx).get(id).cloned() else {
        return;
    };
    let folder = meta
        .folder_id
        .as_deref()
        .and_then(|f| store.read(cx).folder_name(f))
        .map(str::to_string);
    let transcript = (meta.kind == DocKind::Meeting).then(|| load_transcript(id, cx));
    let id = id.to_string();
    window
        .spawn(cx, async move |cx| {
            let transcript = match transcript {
                Some(task) => task.await,
                None => None,
            };
            let name = export::file_name(&meta);
            let Some(markdown) = writer::run(move || {
                compose_from_disk(&library, &id, &meta, transcript.as_ref(), folder.as_deref())
            })
            .await
            else {
                return;
            };
            let Some(dest) = crate::platform::save_file_panel_async(&name, &["md"], cx).await
            else {
                return;
            };
            let written = cx
                .background_executor()
                .spawn(async move { std::fs::write(&dest, markdown) })
                .await;
            cx.update(|_, cx| match written {
                Ok(()) => toast(&root, tr::documents::toast::exported(), cx),
                Err(error) => {
                    tracing::warn!(%error, "could not export the document");
                    toast(&root, tr::documents::toast::export_failed(), cx);
                }
            })
            .ok();
        })
        .detach();
}

fn compose_from_disk(
    library: &Library,
    id: &str,
    meta: &DocMeta,
    transcript: Option<&Transcript>,
    folder: Option<&str>,
) -> String {
    let notes = markdown_of(library.read_notes(id).ok().flatten());
    let enhanced = (meta.kind == DocKind::Meeting)
        .then(|| markdown_of(library.read_enhanced(id).ok().flatten()))
        .flatten();
    export::compose(&export::Parts {
        meta,
        notes_markdown: notes,
        enhanced_markdown: enhanced,
        transcript,
        folder,
    })
}

pub fn reveal_files(store: &Entity<DocStore>, id: &str, cx: &mut App) {
    let Some(library) = store.read(cx).library().cloned() else {
        return;
    };
    let path = library
        .audio_dir(id)
        .ok()
        .filter(|p| p.is_dir())
        .or_else(|| library.doc_dir(id).ok());
    if let Some(path) = path {
        crate::library::reveal_path(&path, cx);
    }
}

pub fn open_link(url: &str, cx: &mut App) {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
    {
        cx.open_url(url.trim());
    }
}
