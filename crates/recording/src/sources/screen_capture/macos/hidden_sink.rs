//! Apps whose only audio output is a hidden virtual device, such as the
//! internal sink a virtual microphone app writes processed speech into.
//!
//! ScreenCaptureKit records every app's output whichever device it goes to,
//! so that audio would land in System Audio even with the microphone off.
//! ScreenCaptureKit leaves out an app's audio once one of its windows is
//! excluded, so excluding one window the app is not showing removes its
//! audio and keeps every visible window in the video.

use std::ffi::c_void;

use cidre::{arc, core_audio as ca, sc, sys};
use core_foundation::{base::FromVoid, boolean::CFBoolean, string::CFString};
use core_graphics::{
    display::{CFDictionary, kCGWindowListOptionIncludingWindow},
    window::{copy_window_info, kCGWindowIsOnscreen},
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

/// One off-screen window of each app that writes only to hidden virtual
/// devices, to add to the display filter's excluded windows. `log` reports
/// each app once, at capture start.
pub(super) fn writer_windows(content: &sc::ShareableContent, log: bool) -> Vec<arc::R<sc::Window>> {
    let writers = hidden_sink_writers(&output_processes(), &default_outputs());
    if writers.is_empty() {
        return Vec::new();
    }

    let windows = content.windows();
    let mut excluded = Vec::new();
    for pid in writers {
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
    window_ids
        .iter()
        .any(|&id| window_on_screen(id).is_none_or(|on_screen| on_screen))
}

/// `None` once the window no longer exists.
fn window_on_screen(id: u32) -> Option<bool> {
    let windows = copy_window_info(kCGWindowListOptionIncludingWindow, id)?;
    let info = unsafe { CFDictionary::<CFString, *const c_void>::from_void(*windows.get(0)?) };
    // The window server leaves the key out for windows that are not on screen.
    Some(unsafe {
        info.find(kCGWindowIsOnscreen)
            .is_some_and(|value| bool::from((*CFBoolean::from_void(*value)).clone()))
    })
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
