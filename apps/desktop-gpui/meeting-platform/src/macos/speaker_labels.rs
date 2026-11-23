//! What a meeting app says about who is speaking, read from its accessibility
//! tree: the labels of participant tiles that mention speaking, and the tile
//! marked as the user's own. Only raw labels come back; the app decides what
//! they mean. Every walk is bounded in nodes, depth and time, so a busy or
//! hung meeting app costs a few milliseconds and never blocks a recording.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use cidre::{arc, ax, cf};

use crate::SpeakerLabels;

const MESSAGING_TIMEOUT: Duration = Duration::from_millis(80);
const DEADLINE: Duration = Duration::from_millis(120);
const NODE_BUDGET: usize = 2500;
const MAX_DEPTH: usize = 40;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementSetAttributeValue(
        element: &ax::UiElement,
        attribute: &cf::String,
        value: &cf::Boolean,
    ) -> i32;
}

/// Browsers build their page's accessibility tree only once asked to.
static ASKED: Mutex<Option<HashSet<u32>>> = Mutex::new(None);

fn attribute(element: &ax::UiElement, name: &'static cf::String) -> Option<arc::R<cf::Type>> {
    element.attr_value(ax::Attr::with_string(name)).ok()
}

fn string_attribute(element: &ax::UiElement, name: &'static cf::String) -> Option<String> {
    let value = attribute(element, name)?;
    if value.get_type_id() != cf::String::type_id() {
        return None;
    }
    let string = unsafe { &*std::ptr::from_ref(&*value).cast::<cf::String>() };
    Some(string.to_string()).filter(|t| !t.trim().is_empty())
}

fn children(element: &ax::UiElement) -> Vec<arc::R<ax::UiElement>> {
    let Some(value) = attribute(element, cf::str!(c"AXChildren")) else {
        return Vec::new();
    };
    if value.get_type_id() != cf::Array::type_id() {
        return Vec::new();
    }
    let array = unsafe { &*std::ptr::from_ref(&*value).cast::<cf::ArrayOf<cf::Type>>() };
    array
        .iter()
        .filter(|item| item.get_type_id() == ax::UiElement::type_id())
        .map(|item| unsafe { &*std::ptr::from_ref(item).cast::<ax::UiElement>() }.retained())
        .collect()
}

struct Walk {
    labels: SpeakerLabels,
    started: Instant,
    exhausted: bool,
    /// For a browser: only the page whose address says it is a call.
    pages: &'static [&'static str],
}

impl Walk {
    fn take(&mut self, label: Option<String>) {
        if let Some(label) = label
            && crate::interesting_label(&label)
            && self.labels.labels.len() < crate::MAX_LABELS
            && !self.labels.labels.contains(&label)
        {
            self.labels.labels.push(label);
        }
    }

    fn visit(&mut self, element: &ax::UiElement, depth: usize, in_call: bool) {
        if self.exhausted {
            return;
        }
        self.labels.visited += 1;
        if self.labels.visited > NODE_BUDGET || self.started.elapsed() > DEADLINE {
            self.exhausted = true;
            return;
        }
        let role = string_attribute(element, cf::str!(c"AXRole")).unwrap_or_default();
        let mut in_call = in_call;
        if role == "AXWebArea" && !self.pages.is_empty() {
            let url = string_attribute(element, cf::str!(c"AXURL")).unwrap_or_default();
            in_call = self.pages.iter().any(|p| url.contains(p));
            if !in_call {
                return;
            }
        }
        if in_call {
            self.take(string_attribute(element, cf::str!(c"AXDescription")));
            self.take(string_attribute(element, cf::str!(c"AXTitle")));
            if role == "AXStaticText" {
                self.take(string_attribute(element, cf::str!(c"AXValue")));
            }
        }
        if matches!(
            role.as_str(),
            "AXMenuBar" | "AXMenu" | "AXScrollBar" | "AXImage"
        ) {
            return;
        }
        if depth >= MAX_DEPTH {
            return;
        }
        for child in children(element) {
            self.visit(&child, depth + 1, in_call);
            if self.exhausted {
                return;
            }
        }
    }
}

/// One look at a meeting app's windows. `pages` limits a browser to the tab
/// whose address contains one of them (empty for a native meeting app).
pub fn speaker_labels(pid: u32, browser: bool, pages: &'static [&'static str]) -> SpeakerLabels {
    let _pool = cidre::objc::AutoreleasePoolPage::push();
    let started = Instant::now();
    let mut walk = Walk {
        labels: SpeakerLabels {
            trusted: super::browser_probe::accessibility_trusted(),
            ..SpeakerLabels::default()
        },
        started,
        exhausted: false,
        pages: if browser { pages } else { &[] },
    };
    if !walk.labels.trusted {
        return walk.labels;
    }
    let app = ax::UiElement::with_app_pid(pid as cidre::sys::Pid);
    let _ = app.set_messaging_timeout(MESSAGING_TIMEOUT);
    if browser {
        let mut asked = ASKED.lock().unwrap_or_else(|e| e.into_inner());
        if asked.get_or_insert_with(HashSet::new).insert(pid) {
            // Chromium builds its page tree for assistive apps on
            // AXEnhancedUserInterface; Electron-based apps on
            // AXManualAccessibility.
            unsafe {
                AXUIElementSetAttributeValue(
                    &app,
                    cf::str!(c"AXEnhancedUserInterface"),
                    cf::Boolean::value_true(),
                );
                AXUIElementSetAttributeValue(
                    &app,
                    cf::str!(c"AXManualAccessibility"),
                    cf::Boolean::value_true(),
                );
            }
        }
    }
    let windows = match attribute(&app, cf::str!(c"AXWindows")) {
        Some(value) if value.get_type_id() == cf::Array::type_id() => {
            let array = unsafe { &*std::ptr::from_ref(&*value).cast::<cf::ArrayOf<cf::Type>>() };
            array
                .iter()
                .filter(|item| item.get_type_id() == ax::UiElement::type_id())
                .map(|item| {
                    unsafe { &*std::ptr::from_ref(item).cast::<ax::UiElement>() }.retained()
                })
                .collect::<Vec<_>>()
        }
        _ => Vec::new(),
    };
    for window in &windows {
        walk.visit(window, 0, !browser);
    }
    walk.labels.complete = !windows.is_empty() && !walk.exhausted;
    walk.labels.took = started.elapsed();
    walk.labels
}
