//! Text-based editing: the Transcript tab of the editor's side panel, where
//! deleting words cuts them out of the video.
//!
//! The source of truth never changes shape. Caption words stay in source time
//! in `project.captions`, the clip list in `project.timeline` says what plays,
//! and a word is shown as cut when less than half of it plays. Deleting words
//! therefore only edits clips (with the same all-track ripple the timeline's
//! own delete uses), a cut made on the timeline shows up struck through here,
//! and restoring a word grows the clips back over it.

pub(crate) mod automation;
pub(crate) mod cuts;
pub(crate) mod energy;
pub(crate) mod model;
#[cfg(test)]
mod tests;
mod view;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use cap_project::disfluency::DisfluencyKind;
use gpui::{FocusHandle, ListAlignment, ListState, TextLayout, px};

use self::energy::EnergyEnvelope;
use self::model::{TranscriptDoc, TranscriptEdl};

pub(crate) const STORE_SECTION: &str = "editorTranscript";
const PAUSE_LONGER_KEY: &str = "pauseLongerThan";
const PAUSE_KEEP_KEY: &str = "pauseKeep";

pub(crate) const DEFAULT_PAUSE_LONGER_THAN: f64 = 1.0;
pub(crate) const DEFAULT_PAUSE_KEEP: f64 = 0.5;
pub(crate) const PAUSE_LONGER_RANGE: (f64, f64) = (0.3, 5.0);
pub(crate) const PAUSE_KEEP_RANGE: (f64, f64) = (0.1, 2.0);

/// After the user scrolls the transcript by hand, playback stops pulling it
/// along for this long.
pub(crate) const FOLLOW_PAUSE: std::time::Duration = std::time::Duration::from_secs(4);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WordSelection {
    pub anchor: usize,
    pub focus: usize,
}

impl WordSelection {
    pub fn single(word: usize) -> Self {
        Self {
            anchor: word,
            focus: word,
        }
    }

    pub fn range(self) -> Range<usize> {
        self.anchor.min(self.focus)..self.anchor.max(self.focus) + 1
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DragUnit {
    Word,
    Sentence,
    Paragraph,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct WordDrag {
    pub unit: DragUnit,
    pub origin: (usize, usize),
}

pub(crate) struct SearchState {
    pub input: gpui::Entity<crate::ui::TextInputState>,
    pub matches: Arc<Vec<Range<usize>>>,
    pub current: usize,
    pub query: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CleanupTab {
    Fillers,
    Pauses,
}

pub(crate) struct CleanupState {
    pub open: bool,
    pub tab: CleanupTab,
    pub categories: [bool; 4],
    pub ignored: HashSet<usize>,
    pub pause_longer_than: f64,
    pub pause_keep: f64,
    pub filler_rows: gpui::UniformListScrollHandle,
    pub pause_rows: gpui::UniformListScrollHandle,
}

impl CleanupState {
    fn new() -> Self {
        let section = crate::store::store_section(STORE_SECTION);
        let read = |key: &str, default: f64, (min, max): (f64, f64)| {
            section
                .get(key)
                .and_then(serde_json::Value::as_f64)
                .filter(|value| value.is_finite())
                .map_or(default, |value| value.clamp(min, max))
        };
        Self {
            open: false,
            tab: CleanupTab::Fillers,
            categories: [true, true, true, false],
            ignored: HashSet::new(),
            pause_longer_than: read(
                PAUSE_LONGER_KEY,
                DEFAULT_PAUSE_LONGER_THAN,
                PAUSE_LONGER_RANGE,
            ),
            pause_keep: read(PAUSE_KEEP_KEY, DEFAULT_PAUSE_KEEP, PAUSE_KEEP_RANGE),
            filler_rows: gpui::UniformListScrollHandle::new(),
            pause_rows: gpui::UniformListScrollHandle::new(),
        }
    }

    pub fn category_enabled(&self, kind: DisfluencyKind) -> bool {
        self.categories[category_index(kind)]
    }

    pub fn persist_pauses(&self) {
        crate::store::set_store_setting(
            STORE_SECTION,
            PAUSE_LONGER_KEY,
            serde_json::json!(self.pause_longer_than),
        );
        crate::store::set_store_setting(
            STORE_SECTION,
            PAUSE_KEEP_KEY,
            serde_json::json!(self.pause_keep),
        );
    }
}

pub(crate) fn category_index(kind: DisfluencyKind) -> usize {
    match kind {
        DisfluencyKind::Hesitation => 0,
        DisfluencyKind::Repetition => 1,
        DisfluencyKind::FalseStart => 2,
        DisfluencyKind::Discourse => 3,
    }
}

pub(crate) struct TranscriptState {
    /// Whether the side panel is on its Transcript tab. Switch with
    /// `EditorWindow::set_panel_tab`, which keeps it exclusive with Clips.
    pub open: bool,
    pub doc: Option<Arc<TranscriptDoc>>,
    pub edl: Option<Arc<TranscriptEdl>>,
    /// Set by every project change; the models are only re-derived while the
    /// panel is open, so the feature costs nothing when it is closed.
    pub dirty: bool,
    edl_key: u64,
    pub list: ListState,
    pub selection: Option<WordSelection>,
    pub caret: Option<usize>,
    pub drag: Option<WordDrag>,
    pub active: Option<usize>,
    pub hovered_cut: Option<usize>,
    pub user_scrolled: Option<Instant>,
    pub search: Option<SearchState>,
    pub cleanup: CleanupState,
    pub focus: FocusHandle,
    pub layouts: Rc<RefCell<HashMap<usize, TextLayout>>>,
    pub energy: Option<Arc<EnergyEnvelope>>,
    pub energy_loading: bool,
    pub energy_offsets: Vec<(f64, f64)>,
    pub voiced_for: usize,
}

impl TranscriptState {
    pub fn new(focus: FocusHandle) -> Self {
        Self {
            open: false,
            doc: None,
            edl: None,
            dirty: true,
            edl_key: 0,
            list: ListState::new(0, ListAlignment::Top, px(600.)),
            selection: None,
            caret: None,
            drag: None,
            active: None,
            hovered_cut: None,
            user_scrolled: None,
            search: None,
            cleanup: CleanupState::new(),
            focus,
            layouts: Rc::new(RefCell::new(HashMap::new())),
            energy: None,
            energy_loading: false,
            energy_offsets: Vec::new(),
            voiced_for: 0,
        }
    }

    pub fn refresh(
        &mut self,
        project: &cap_project::ProjectConfiguration,
        recording_durations: &[f64],
    ) -> bool {
        if !self.dirty && self.doc.is_some() == has_words(project) {
            return false;
        }
        self.dirty = false;
        let Some(captions) = project.captions.as_ref().filter(|_| has_words(project)) else {
            let changed = self.doc.is_some();
            self.doc = None;
            self.edl = None;
            self.list.reset(0);
            self.selection = None;
            self.caret = None;
            self.active = None;
            return changed;
        };
        let mut changed = false;
        let signature = model::captions_signature(Some(captions));
        if self
            .doc
            .as_ref()
            .is_none_or(|doc| doc.signature != signature)
        {
            let doc = TranscriptDoc::build(captions);
            self.list.reset(doc.paragraphs.len());
            self.layouts.borrow_mut().clear();
            self.selection = None;
            self.caret = None;
            self.active = None;
            self.hovered_cut = None;
            self.cleanup.ignored.clear();
            self.doc = Some(Arc::new(doc));
            self.edl_key = 0;
            self.voiced_for = 0;
            changed = true;
        }
        let energy_key = self
            .energy
            .as_ref()
            .map_or(1, |energy| Arc::as_ptr(energy) as usize);
        if energy_key != self.voiced_for
            && let Some(doc) = self.doc.as_mut()
        {
            Arc::make_mut(doc).refine_voiced(self.energy.as_deref());
            self.voiced_for = energy_key;
            changed = true;
        }
        let key = timeline_key(project.timeline.as_ref(), recording_durations);
        if changed || key != self.edl_key || self.edl.is_none() {
            self.edl_key = key;
            let doc = self.doc.as_ref().expect("document was just built");
            self.edl = project
                .timeline
                .as_ref()
                .map(|timeline| Arc::new(TranscriptEdl::build(doc, timeline, recording_durations)));
            self.hovered_cut = None;
            changed = true;
        }
        if let (Some(search), Some(doc)) = (self.search.as_mut(), self.doc.as_ref())
            && changed
        {
            search.matches = Arc::new(view::find_matches(doc, &search.query));
            search.current = search.current.min(search.matches.len().saturating_sub(1));
        }
        changed
    }
}

pub(crate) fn has_words(project: &cap_project::ProjectConfiguration) -> bool {
    project.captions.as_ref().is_some_and(|captions| {
        captions
            .segments
            .iter()
            .any(|segment| !segment.words.is_empty())
    })
}

fn timeline_key(
    timeline: Option<&cap_project::TimelineConfiguration>,
    recording_durations: &[f64],
) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    for duration in recording_durations {
        duration.to_bits().hash(&mut hasher);
    }
    if let Some(timeline) = timeline {
        for segment in &timeline.segments {
            segment.recording_clip.hash(&mut hasher);
            segment.start.to_bits().hash(&mut hasher);
            segment.end.to_bits().hash(&mut hasher);
            segment.timescale.to_bits().hash(&mut hasher);
        }
        for transition in &timeline.transitions {
            transition.segment_index.hash(&mut hasher);
            transition.duration.to_bits().hash(&mut hasher);
        }
        for (start, end) in timeline.hold_windows() {
            start.to_bits().hash(&mut hasher);
            end.to_bits().hash(&mut hasher);
        }
    } else {
        1u8.hash(&mut hasher);
    }
    hasher.finish()
}
