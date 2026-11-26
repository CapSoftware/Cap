//! What a meeting app or browser shows, read through UI Automation: the
//! browser's tab titles and addresses (is this tab a call?) and, while
//! recording, the labels of participant tiles that say who is speaking or
//! which tile is the user's own. Same contract as the macOS accessibility
//! reader: raw labels and addresses come back, the meetings crate decides
//! what they mean.
//!
//! UI Automation calls cross into the other app's process and can stall when
//! that app is busy, so every read runs on one dedicated COM thread with
//! UIA's own connection and transaction timeouts, and the caller waits a
//! bounded time. A read that runs late is reported incomplete; it never holds
//! up a recording. Searches are single `FindAll` calls with conditions (a
//! case-insensitive substring match on the name for speaker labels), so the
//! cost scales with what matches, not with every node of a large web page.

use std::sync::{
    OnceLock,
    mpsc::{Receiver, SyncSender, TrySendError, sync_channel},
};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
};
use windows::Win32::System::Variant::{VARIANT, VT_BSTR};
use windows::Win32::UI::Accessibility::{
    AutomationElementMode_None, CUIAutomation, CUIAutomation8, IUIAutomation, IUIAutomation2,
    IUIAutomationCacheRequest, IUIAutomationCondition, IUIAutomationElement,
    PropertyConditionFlags, PropertyConditionFlags_IgnoreCase,
    PropertyConditionFlags_MatchSubstring, TreeScope_Descendants, TreeScope_Element,
    UIA_ControlTypePropertyId, UIA_DocumentControlTypeId, UIA_EditControlTypeId,
    UIA_NamePropertyId, UIA_TabItemControlTypeId, UIA_ValueValuePropertyId,
};
use windows::core::{BSTR, Interface};

use super::procs;
use crate::{BrowserProbe, SpeakerLabels};

/// How long a caller waits for one read before reporting it incomplete.
const LABELS_WAIT: Duration = Duration::from_millis(250);
const PROBE_WAIT: Duration = Duration::from_millis(1500);
/// UIA's own limits for one cross-process call.
const CONNECTION_TIMEOUT_MS: u32 = 400;
const TRANSACTION_TIMEOUT_MS: u32 = 200;
const MAX_WINDOWS: usize = 8;

type Job = Box<dyn FnOnce(&IUIAutomation) + Send>;

/// The one thread that talks UI Automation. `None` when COM or UIA cannot
/// start on this system (then every read is empty).
fn worker() -> Option<&'static SyncSender<Job>> {
    static WORKER: OnceLock<Option<SyncSender<Job>>> = OnceLock::new();
    WORKER
        .get_or_init(|| {
            // One job at a time; a caller that finds the thread busy reports
            // its read incomplete instead of queueing behind a stalled app.
            let (tx, rx) = sync_channel::<Job>(1);
            let (ready_tx, ready_rx) = sync_channel::<bool>(1);
            std::thread::Builder::new()
                .name("cap-meeting-uia".into())
                .spawn(move || run(rx, ready_tx))
                .ok()?;
            ready_rx.recv().unwrap_or(false).then_some(tx)
        })
        .as_ref()
}

fn run(jobs: Receiver<Job>, ready: SyncSender<bool>) {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let automation: Option<IUIAutomation> = unsafe {
        CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
            .or_else(|_| CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))
    }
    .ok();
    let Some(automation) = automation else {
        let _ = ready.send(false);
        return;
    };
    if let Ok(timeouts) = automation.cast::<IUIAutomation2>() {
        unsafe {
            let _ = timeouts.SetConnectionTimeout(CONNECTION_TIMEOUT_MS);
            let _ = timeouts.SetTransactionTimeout(TRANSACTION_TIMEOUT_MS);
        }
    }
    let _ = ready.send(true);
    while let Ok(job) = jobs.recv() {
        job(&automation);
    }
}

/// Runs `read` on the UIA thread and waits up to `wait` for its answer.
fn on_worker<T: Send + 'static>(
    wait: Duration,
    read: impl FnOnce(&IUIAutomation) -> T + Send + 'static,
) -> Option<T> {
    let worker = worker()?;
    let (tx, rx) = sync_channel(1);
    let job: Job = Box::new(move |automation| {
        let _ = tx.send(read(automation));
    });
    match worker.try_send(job) {
        Ok(()) => rx.recv_timeout(wait).ok(),
        Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => None,
    }
}

/// Windows can always read other apps' interfaces; nothing to grant.
pub fn available() -> bool {
    worker().is_some()
}

struct Raw(isize);

unsafe impl Send for Raw {}

fn handles(pid: u32) -> Vec<Raw> {
    procs::windows_of_app(pid)
        .into_iter()
        .take(MAX_WINDOWS)
        .map(|window| Raw(window as isize))
        .collect()
}

fn element(automation: &IUIAutomation, window: &Raw) -> Option<IUIAutomationElement> {
    unsafe { automation.ElementFromHandle(HWND(window.0 as *mut _)) }.ok()
}

fn cache(
    automation: &IUIAutomation,
    values: bool,
    full: bool,
) -> Option<IUIAutomationCacheRequest> {
    let request = unsafe { automation.CreateCacheRequest() }.ok()?;
    unsafe {
        request.AddProperty(UIA_NamePropertyId).ok()?;
        request.AddProperty(UIA_ControlTypePropertyId).ok()?;
        if values {
            request.AddProperty(UIA_ValueValuePropertyId).ok()?;
        }
        if !full {
            request
                .SetAutomationElementMode(AutomationElementMode_None)
                .ok()?;
        }
        request.SetTreeScope(TreeScope_Element).ok()?;
    }
    Some(request)
}

fn control_type_is(automation: &IUIAutomation, id: i32) -> Option<IUIAutomationCondition> {
    unsafe { automation.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(id)) }
        .ok()
}

fn any_of(
    automation: &IUIAutomation,
    conditions: Vec<IUIAutomationCondition>,
) -> Option<IUIAutomationCondition> {
    let mut iter = conditions.into_iter();
    let mut joined = iter.next()?;
    for next in iter {
        joined = unsafe { automation.CreateOrCondition(&joined, &next) }.ok()?;
    }
    Some(joined)
}

fn text(value: windows::core::Result<BSTR>) -> Option<String> {
    let text = value.ok()?.to_string();
    (!text.trim().is_empty()).then_some(text)
}

fn cached_value(element: &IUIAutomationElement) -> Option<String> {
    let value = unsafe { element.GetCachedPropertyValue(UIA_ValueValuePropertyId) }.ok()?;
    if value.vt() != VT_BSTR {
        return None;
    }
    // A VT_BSTR variant holds its string in `bstrVal`; the variant still owns
    // it and frees it on drop.
    let text = unsafe { value.Anonymous.Anonymous.Anonymous.bstrVal.to_string() };
    (!text.trim().is_empty()).then_some(text)
}

fn find_all(
    root: &IUIAutomationElement,
    condition: &IUIAutomationCondition,
    request: &IUIAutomationCacheRequest,
) -> Option<Vec<IUIAutomationElement>> {
    let found =
        unsafe { root.FindAllBuildCache(TreeScope_Descendants, condition, request) }.ok()?;
    let length = unsafe { found.Length() }.ok()?;
    Some(
        (0..length)
            .filter_map(|index| unsafe { found.GetElement(index) }.ok())
            .collect(),
    )
}

/// Addresses in a browser window: the address bar's text and any web
/// document that reports its URL.
fn looks_like_address(text: &str) -> bool {
    let text = text.trim();
    !text.contains(char::is_whitespace)
        && text.len() <= 2048
        && text
            .split(['/', '?', '#'])
            .next()
            .is_some_and(|host| host.contains('.') || host.contains(':'))
}

pub fn probe_browser(pid: u32) -> BrowserProbe {
    let windows = handles(pid);
    let available = available();
    if windows.is_empty() || !available {
        return BrowserProbe {
            trusted: available,
            ..BrowserProbe::default()
        };
    }
    on_worker(PROBE_WAIT, move |automation| {
        let mut probe = BrowserProbe {
            trusted: true,
            complete: true,
            ..BrowserProbe::default()
        };
        let request = cache(automation, true, false);
        let condition = [
            UIA_TabItemControlTypeId.0,
            UIA_EditControlTypeId.0,
            UIA_DocumentControlTypeId.0,
        ]
        .into_iter()
        .filter_map(|id| control_type_is(automation, id))
        .collect::<Vec<_>>();
        let (Some(request), Some(condition)) = (request, any_of(automation, condition)) else {
            probe.complete = false;
            return probe;
        };
        for window in &windows {
            let Some(root) = element(automation, window) else {
                probe.complete = false;
                continue;
            };
            if let Some(title) = text(unsafe { root.CurrentName() })
                && !probe.titles.contains(&title)
            {
                probe.titles.push(title);
            }
            let Some(found) = find_all(&root, &condition, &request) else {
                probe.complete = false;
                continue;
            };
            for item in found {
                let kind = unsafe { item.CachedControlType() }
                    .map(|t| t.0)
                    .unwrap_or(0);
                if kind == UIA_TabItemControlTypeId.0 {
                    if let Some(title) = text(unsafe { item.CachedName() })
                        && !probe.titles.contains(&title)
                    {
                        probe.titles.push(title);
                    }
                } else if let Some(address) = cached_value(&item)
                    && looks_like_address(&address)
                    && !probe.urls.contains(&address)
                {
                    probe.urls.push(address);
                }
            }
        }
        probe
    })
    .unwrap_or(BrowserProbe {
        trusted: true,
        ..BrowserProbe::default()
    })
}

/// Name fragments worth searching for; `crate::interesting` makes the final
/// call on each match.
const MARKERS: &[&str] = &["speaking", "talking", "(you)", "(me)"];

pub fn speaker_labels(pid: u32, browser: bool, pages: &'static [&'static str]) -> SpeakerLabels {
    let started = Instant::now();
    let windows = handles(pid);
    let available = available();
    if windows.is_empty() || !available {
        return SpeakerLabels {
            trusted: available,
            took: started.elapsed(),
            ..SpeakerLabels::default()
        };
    }
    let pages: &'static [&'static str] = if browser { pages } else { &[] };
    let mut labels = on_worker(LABELS_WAIT, move |automation| {
        let mut labels = SpeakerLabels {
            trusted: true,
            complete: true,
            ..SpeakerLabels::default()
        };
        let markers = MARKERS
            .iter()
            .filter_map(|marker| unsafe {
                automation
                    .CreatePropertyConditionEx(
                        UIA_NamePropertyId,
                        &VARIANT::from(*marker),
                        PropertyConditionFlags(
                            PropertyConditionFlags_IgnoreCase.0
                                | PropertyConditionFlags_MatchSubstring.0,
                        ),
                    )
                    .ok()
            })
            .collect::<Vec<_>>();
        let (Some(names), Some(request)) =
            (any_of(automation, markers), cache(automation, false, false))
        else {
            labels.complete = false;
            return labels;
        };
        let documents = control_type_is(automation, UIA_DocumentControlTypeId.0);
        let full = cache(automation, true, true);
        for window in &windows {
            let Some(root) = element(automation, window) else {
                labels.complete = false;
                continue;
            };
            // A browser: only web documents whose address is a call page.
            let roots = if pages.is_empty() {
                vec![root]
            } else {
                let (Some(documents), Some(full)) = (&documents, &full) else {
                    labels.complete = false;
                    continue;
                };
                let Some(found) = find_all(&root, documents, full) else {
                    labels.complete = false;
                    continue;
                };
                found
                    .into_iter()
                    .filter(|document| {
                        cached_value(document)
                            .is_some_and(|url| pages.iter().any(|page| url.contains(page)))
                    })
                    .collect()
            };
            for root in roots {
                let Some(found) = find_all(&root, &names, &request) else {
                    labels.complete = false;
                    continue;
                };
                labels.visited += found.len();
                for item in found {
                    if let Some(label) = text(unsafe { item.CachedName() })
                        && crate::interesting_label(&label)
                        && labels.labels.len() < crate::MAX_LABELS
                        && !labels.labels.contains(&label)
                    {
                        labels.labels.push(label);
                    }
                }
            }
        }
        labels
    })
    .unwrap_or(SpeakerLabels {
        trusted: true,
        ..SpeakerLabels::default()
    });
    labels.took = started.elapsed();
    labels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_told_apart_from_search_text() {
        assert!(looks_like_address("meet.google.com/abc-defg-hij"));
        assert!(looks_like_address(
            "https://teams.microsoft.com/l/meetup-join/x"
        ));
        assert!(looks_like_address("localhost:8080/call"));
        assert!(!looks_like_address("how to join a call"));
        assert!(!looks_like_address("Search Google or type a URL"));
        assert!(!looks_like_address(""));
    }

    #[test]
    fn a_process_without_windows_reads_nothing_and_quickly() {
        let started = Instant::now();
        let labels = speaker_labels(std::process::id(), false, &[]);
        assert!(labels.labels.is_empty());
        assert!(!labels.complete);
        let probe = probe_browser(std::process::id());
        assert!(probe.urls.is_empty() && !probe.complete);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
