use std::time::{Duration, Instant};

use cidre::{arc, ax, cf};

use crate::BrowserProbe;

const MESSAGING_TIMEOUT: Duration = Duration::from_millis(400);
const DEADLINE: Duration = Duration::from_millis(1500);
const NODE_BUDGET: usize = 900;
const MAX_DEPTH: usize = 12;

pub fn accessibility_trusted() -> bool {
    ax::is_process_trusted()
}

fn attribute(element: &ax::UiElement, name: &'static cf::String) -> Option<arc::R<cf::Type>> {
    element.attr_value(ax::Attr::with_string(name)).ok()
}

fn text(value: &cf::Type) -> Option<String> {
    if value.get_type_id() == cf::String::type_id() {
        let string = unsafe { &*std::ptr::from_ref(value).cast::<cf::String>() };
        Some(string.to_string()).filter(|text| !text.trim().is_empty())
    } else if value.get_type_id() == cf::Url::type_id() {
        let url = unsafe { &*std::ptr::from_ref(value).cast::<cf::Url>() };
        Some(url.cf_string().to_string()).filter(|text| !text.is_empty())
    } else {
        None
    }
}

fn string_attribute(element: &ax::UiElement, name: &'static cf::String) -> Option<String> {
    attribute(element, name).and_then(|value| text(&value))
}

fn elements(element: &ax::UiElement, name: &'static cf::String) -> Vec<arc::R<ax::UiElement>> {
    let Some(value) = attribute(element, name) else {
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
    probe: BrowserProbe,
    visited: usize,
    started: Instant,
    exhausted: bool,
}

impl Walk {
    fn push_title(&mut self, title: Option<String>) {
        if let Some(title) = title
            && !self.probe.titles.contains(&title)
        {
            self.probe.titles.push(title);
        }
    }

    fn visit(&mut self, element: &ax::UiElement, depth: usize) {
        if self.exhausted {
            return;
        }
        self.visited += 1;
        if self.visited > NODE_BUDGET || self.started.elapsed() > DEADLINE {
            self.exhausted = true;
            return;
        }

        let role = string_attribute(element, cf::str!(c"AXRole")).unwrap_or_default();
        match role.as_str() {
            "AXWebArea" => {
                if let Some(url) = string_attribute(element, cf::str!(c"AXURL"))
                    && !self.probe.urls.contains(&url)
                {
                    self.probe.urls.push(url);
                }
                self.push_title(string_attribute(element, cf::str!(c"AXTitle")));
                return;
            }
            "AXRadioButton" | "AXTabButton" => {
                let title = string_attribute(element, cf::str!(c"AXTitle"))
                    .or_else(|| string_attribute(element, cf::str!(c"AXDescription")));
                self.push_title(title);
                return;
            }
            "AXMenuBar" | "AXMenu" | "AXScrollBar" | "AXImage" | "AXStaticText" => return,
            _ => {}
        }

        if depth >= MAX_DEPTH {
            return;
        }
        for child in elements(element, cf::str!(c"AXChildren")) {
            self.visit(&child, depth + 1);
            if self.exhausted {
                return;
            }
        }
    }
}

pub fn probe_browser(pid: u32) -> BrowserProbe {
    let _pool = cidre::objc::AutoreleasePoolPage::push();
    let mut walk = Walk {
        probe: BrowserProbe {
            trusted: accessibility_trusted(),
            ..BrowserProbe::default()
        },
        visited: 0,
        started: Instant::now(),
        exhausted: false,
    };
    if !walk.probe.trusted {
        return walk.probe;
    }

    let app = ax::UiElement::with_app_pid(pid as cidre::sys::Pid);
    let _ = app.set_messaging_timeout(MESSAGING_TIMEOUT);
    let windows = elements(&app, cf::str!(c"AXWindows"));
    for window in &windows {
        walk.push_title(string_attribute(window, cf::str!(c"AXTitle")));
        walk.visit(window, 0);
    }
    walk.probe.complete = !windows.is_empty() && !walk.exhausted;
    walk.probe
}
