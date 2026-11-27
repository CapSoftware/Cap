//! Apps whose only audio output is a hidden virtual device, such as the
//! internal sink a virtual microphone app writes processed speech into.
//!
//! ScreenCaptureKit records every app's output whichever device it goes to,
//! so that audio would land in System Audio even with the microphone off.
//! ScreenCaptureKit leaves out an app's audio once one of its windows is
//! excluded, so excluding one window the app is not showing removes its
//! audio and keeps every visible window in the video.

use cidre::{arc, core_audio as ca, sc, sys};
use core_graphics::window::{
    CGWindowListOption, create_window_list, kCGNullWindowID, kCGWindowListOptionAll,
    kCGWindowListOptionOnScreenOnly,
};
use tracing::info;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OutputDevice {
    id: u32,
    hidden: bool,
    virtual_transport: bool,
}

#[derive(Debug, Clone)]
struct OutputProcess {
    pid: sys::Pid,
    bundle_id: String,
    outputs: Vec<OutputDevice>,
}

/// Apps whose only output right now is a hidden virtual device. Decided when
/// capture starts and kept for the whole recording, so an app that pauses its
/// audio is not let back in.
pub(super) fn writers() -> Vec<sys::Pid> {
    hidden_sink_writers(&output_processes(), &default_outputs())
}

pub(super) fn off_screen_windows(
    content: &sc::ShareableContent,
    writers: &[sys::Pid],
    log: bool,
) -> Vec<arc::R<sc::Window>> {
    if writers.is_empty() {
        return Vec::new();
    }

    let windows = content.windows();
    let mut excluded = Vec::new();
    for &pid in writers {
        let mut hidden_windows: Vec<&sc::Window> = windows
            .iter()
            .filter(|window| {
                !window.is_on_screen()
                    && window
                        .owning_app()
                        .is_some_and(|app| app.process_id() == pid)
            })
            .collect();
        // Prefer an ordinary-level window over panels and overlays, which are
        // the ones most likely to be shown during the recording.
        hidden_windows.sort_by_key(|window| (window.window_layer() != 0, window.id()));

        match hidden_windows.first() {
            Some(window) => {
                if log {
                    info!(
                        pid,
                        window_id = window.id(),
                        "Leaving out the audio of an app that only plays to a hidden virtual device"
                    );
                }
                excluded.push(window.retained());
            }
            None if log => info!(
                pid,
                "App only plays to a hidden virtual device but has no off-screen window; its audio stays in System Audio"
            ),
            None => {}
        }
    }
    excluded
}

/// Whether any of the excluded windows is now shown or has closed, so the
/// exclusion must move to another window to keep the video complete.
pub(super) fn any_shown_or_closed(window_ids: &[u32]) -> bool {
    let (Some(on_screen), Some(all)) = (
        window_list(kCGWindowListOptionOnScreenOnly),
        window_list(kCGWindowListOptionAll),
    ) else {
        return false;
    };
    window_ids
        .iter()
        .any(|id| on_screen.contains(id) || !all.contains(id))
}

/// What the watcher does on a tick while an excluded window is shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Step {
    Wait,
    /// Move the exclusion to another off-screen window.
    Refresh,
    /// Apply the filter without hidden-sink exclusions: the app's audio comes
    /// back, but no window is missing from the video.
    Fallback,
}

const REFRESH_ATTEMPTS: u32 = 3;
const MAX_WAIT_TICKS: u32 = 7;

/// Paces attempts after failures: retries back off, and after a few failed
/// refreshes the watcher falls back instead of leaving a shown window excluded.
#[derive(Debug, Default)]
pub(super) struct Retry {
    failures: u32,
    wait: u32,
}

impl Retry {
    pub(super) fn step(&mut self) -> Step {
        if self.wait > 0 {
            self.wait -= 1;
            return Step::Wait;
        }
        if self.failures >= REFRESH_ATTEMPTS {
            Step::Fallback
        } else {
            Step::Refresh
        }
    }

    /// Records a failed attempt; true for the first one, the one to log.
    pub(super) fn failed(&mut self) -> bool {
        self.failures += 1;
        self.wait = ((1u32 << (self.failures - 1).min(3)) - 1).min(MAX_WAIT_TICKS);
        self.failures == 1
    }

    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }
}

fn window_list(option: CGWindowListOption) -> Option<Vec<u32>> {
    let list = create_window_list(option, kCGNullWindowID)?;
    // The list holds window numbers, not CF objects.
    Some(
        list.get_all_values()
            .into_iter()
            .map(|id| id as usize as u32)
            .collect(),
    )
}

fn default_outputs() -> Vec<u32> {
    [
        ca::System::default_output_device(),
        ca::System::default_sys_output_device(),
    ]
    .into_iter()
    .filter_map(|device| device.ok().map(|device| device.0.0))
    .collect()
}

fn output_processes() -> Vec<OutputProcess> {
    let Ok(processes) = ca::Process::list() else {
        return Vec::new();
    };
    let devices_addr =
        ca::PropSelector::PROCESS_DEVICES.addr(ca::PropScope::OUTPUT, ca::PropElement::MAIN);

    processes
        .iter()
        .filter(|process| process.is_running_output().unwrap_or(false))
        .filter_map(|process| {
            let pid = process.pid().ok()?;
            let outputs = process
                .prop_vec::<ca::Device>(&devices_addr)
                .ok()?
                .iter()
                .map(|device| OutputDevice {
                    id: device.0.0,
                    hidden: device
                        .bool_prop(&ca::PropSelector::DEVICE_IS_HIDDEN.global_addr())
                        .unwrap_or(false),
                    virtual_transport: device
                        .transport_type()
                        .is_ok_and(|transport| transport == ca::DeviceTransportType::VIRTUAL),
                })
                .collect();
            let bundle_id = process
                .bundle_id()
                .map(|id| id.to_string())
                .unwrap_or_default();
            Some(OutputProcess {
                pid,
                bundle_id,
                outputs,
            })
        })
        .collect()
}

fn is_hidden_sink(device: &OutputDevice, default_outputs: &[u32]) -> bool {
    device.hidden && device.virtual_transport && !default_outputs.contains(&device.id)
}

fn same_app(a: &str, b: &str) -> bool {
    !a.is_empty()
        && !b.is_empty()
        && (a == b
            || b.strip_prefix(a).is_some_and(|rest| rest.starts_with('.'))
            || a.strip_prefix(b).is_some_and(|rest| rest.starts_with('.')))
}

/// Processes whose every output device is a hidden virtual device that is not
/// a default output, unless a process of the same app plays anywhere else:
/// leaving the app out would take that audio with it.
fn hidden_sink_writers(processes: &[OutputProcess], default_outputs: &[u32]) -> Vec<sys::Pid> {
    let only_hidden_sinks = |process: &OutputProcess| {
        !process.outputs.is_empty()
            && process
                .outputs
                .iter()
                .all(|device| is_hidden_sink(device, default_outputs))
    };

    processes
        .iter()
        .filter(|process| only_hidden_sinks(process))
        .filter(|writer| {
            !processes.iter().any(|other| {
                other.pid != writer.pid
                    && same_app(&writer.bundle_id, &other.bundle_id)
                    && !other.outputs.is_empty()
                    && !only_hidden_sinks(other)
            })
        })
        .map(|process| process.pid)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEAKERS: OutputDevice = OutputDevice {
        id: 10,
        hidden: false,
        virtual_transport: false,
    };
    const HEADSET: OutputDevice = OutputDevice {
        id: 11,
        hidden: false,
        virtual_transport: false,
    };
    const LOOPBACK: OutputDevice = OutputDevice {
        id: 20,
        hidden: false,
        virtual_transport: true,
    };
    const SINK: OutputDevice = OutputDevice {
        id: 30,
        hidden: true,
        virtual_transport: true,
    };
    const PRIVATE_AGGREGATE: OutputDevice = OutputDevice {
        id: 40,
        hidden: true,
        virtual_transport: false,
    };

    fn process(pid: sys::Pid, bundle_id: &str, outputs: &[OutputDevice]) -> OutputProcess {
        OutputProcess {
            pid,
            bundle_id: bundle_id.to_string(),
            outputs: outputs.to_vec(),
        }
    }

    fn steps(retry: &mut Retry, failures: &[bool]) -> Vec<Step> {
        let mut out = Vec::new();
        let mut results = failures.iter();
        for _ in 0..40 {
            let step = retry.step();
            out.push(step);
            if step == Step::Wait {
                continue;
            }
            match results.next() {
                Some(true) => {
                    retry.failed();
                }
                _ => break,
            }
        }
        out
    }

    #[test]
    fn retry_backs_off_then_falls_back() {
        use Step::*;
        let mut retry = Retry::default();
        assert_eq!(
            steps(&mut retry, &[true, true, true, false]),
            vec![Refresh, Refresh, Wait, Refresh, Wait, Wait, Wait, Fallback]
        );
    }

    #[test]
    fn failed_fallback_keeps_retrying_at_the_capped_pace() {
        use Step::*;
        let mut retry = Retry::default();
        let all = steps(&mut retry, &[true, true, true, true, true, false]);
        assert_eq!(all.iter().filter(|step| **step == Fallback).count(), 3);
        assert_eq!(
            all[all.len() - 8..],
            [Wait, Wait, Wait, Wait, Wait, Wait, Wait, Fallback]
        );
    }

    #[test]
    fn only_the_first_failure_is_logged_and_reset_starts_over() {
        let mut retry = Retry::default();
        assert!(retry.failed());
        assert!(!retry.failed());
        retry.reset();
        assert_eq!(retry.step(), Step::Refresh);
        assert!(retry.failed());
    }

    #[test]
    fn writer_to_a_hidden_virtual_sink_only() {
        let processes = [
            process(1, "com.example.music", &[SPEAKERS]),
            process(2, "com.example.mic", &[SINK]),
        ];
        assert_eq!(hidden_sink_writers(&processes, &[SPEAKERS.id]), vec![2]);
    }

    #[test]
    fn ordinary_outputs_are_never_writers() {
        let processes = [
            process(1, "com.example.music", &[SPEAKERS]),
            process(2, "com.example.call", &[HEADSET]),
            process(3, "com.example.router", &[LOOPBACK]),
            process(4, "com.example.meeting", &[PRIVATE_AGGREGATE]),
            process(5, "com.example.idle", &[]),
        ];
        assert!(hidden_sink_writers(&processes, &[SPEAKERS.id]).is_empty());
    }

    #[test]
    fn writer_that_also_plays_elsewhere_is_kept() {
        let processes = [
            process(1, "com.example.mic", &[SINK, SPEAKERS]),
            process(2, "com.example.other", &[SINK, LOOPBACK]),
        ];
        assert!(hidden_sink_writers(&processes, &[SPEAKERS.id]).is_empty());
    }

    #[test]
    fn hidden_sink_set_as_default_output_is_kept() {
        let processes = [process(1, "com.example.mic", &[SINK])];
        assert!(hidden_sink_writers(&processes, &[SINK.id]).is_empty());
    }

    #[test]
    fn writer_whose_helper_plays_elsewhere_is_kept() {
        let processes = [
            process(1, "com.example.mic", &[SINK]),
            process(2, "com.example.mic.helper", &[SPEAKERS]),
            process(3, "com.example.microphone", &[SPEAKERS]),
        ];
        assert!(hidden_sink_writers(&processes, &[SPEAKERS.id]).is_empty());

        let processes = [
            process(1, "com.example.mic", &[SINK]),
            process(3, "com.example.microphone", &[SPEAKERS]),
        ];
        assert_eq!(hidden_sink_writers(&processes, &[SPEAKERS.id]), vec![1]);
    }
}
