use std::{
    collections::HashSet,
    ffi::CStr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};

use cidre::{
    core_audio::{Device, Obj, Process, PropAddr, PropSelector, System},
    ns, os,
};

use crate::{MicClient, MicSnapshot, WatchError};

const ACTIVE_RESYNC: Duration = Duration::from_secs(5);
const IDLE_RESYNC: Duration = Duration::from_secs(60);
const COALESCE: Duration = Duration::from_millis(40);

const SYSTEM_SELECTORS: [PropSelector; 3] = [
    PropSelector::HW_PROCESS_OBJ_LIST,
    PropSelector::HW_DEVICES,
    PropSelector::HW_DEFAULT_INPUT_DEVICE,
];

struct Signal {
    tx: flume::Sender<()>,
}

extern "C-unwind" fn on_change(
    _obj: Obj,
    _count: u32,
    _addresses: *const PropAddr,
    signal: *mut Signal,
) -> os::Status {
    if let Some(signal) = unsafe { signal.as_ref() } {
        let _ = signal.tx.try_send(());
    }
    os::Status::NO_ERR
}

type ResponsiblePid = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;

fn responsible_pid_fn() -> Option<ResponsiblePid> {
    super::dynamic_symbol(c"responsibility_get_pid_responsible_for_pid").map(|symbol| unsafe {
        std::mem::transmute::<*mut std::ffi::c_void, ResponsiblePid>(symbol)
    })
}

pub struct Watcher {
    stop: Arc<AtomicBool>,
    wake: flume::Sender<()>,
    thread: Option<JoinHandle<()>>,
}

impl Watcher {
    pub fn spawn(updates: flume::Sender<MicSnapshot>) -> Result<Self, WatchError> {
        let (wake, dirty) = flume::bounded::<()>(1);
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::Builder::new()
            .name("cap-mic-activity".into())
            .spawn({
                let stop = stop.clone();
                let wake = wake.clone();
                move || Worker::new(wake, updates).run(&dirty, &stop)
            })
            .map_err(|error| WatchError::Start(error.to_string()))?;
        Ok(Self {
            stop,
            wake,
            thread: Some(thread),
        })
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.wake.try_send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct Worker {
    signal: *mut Signal,
    updates: flume::Sender<MicSnapshot>,
    process_listeners: HashSet<u32>,
    device_listeners: HashSet<u32>,
    reader: Reader,
}

impl Worker {
    fn new(wake: flume::Sender<()>, updates: flume::Sender<MicSnapshot>) -> Self {
        Self {
            signal: Box::into_raw(Box::new(Signal { tx: wake })),
            updates,
            process_listeners: HashSet::new(),
            device_listeners: HashSet::new(),
            reader: Reader::new(),
        }
    }

    fn run(mut self, dirty: &flume::Receiver<()>, stop: &AtomicBool) {
        for selector in SYSTEM_SELECTORS {
            if let Err(error) =
                System::OBJ.add_prop_listener(&selector.global_addr(), on_change, self.signal)
            {
                tracing::warn!(?error, "audio system listener unavailable");
            }
        }

        let mut last = None;
        while !stop.load(Ordering::Acquire) {
            let reading = self.reader.read();
            self.sync_listeners(&reading);
            let active = reading.snapshot.mic_in_use;
            if last.as_ref() != Some(&reading.snapshot) {
                last = Some(reading.snapshot.clone());
                if self.updates.send(reading.snapshot).is_err() {
                    break;
                }
            }

            let wait = if active { ACTIVE_RESYNC } else { IDLE_RESYNC };
            match dirty.recv_timeout(wait) {
                Ok(()) => {
                    std::thread::sleep(COALESCE);
                    while dirty.try_recv().is_ok() {}
                }
                Err(flume::RecvTimeoutError::Timeout) => {}
                Err(flume::RecvTimeoutError::Disconnected) => break,
            }
        }

        self.remove_listeners();
    }

    fn sync_listeners(&mut self, reading: &Reading) {
        let address = PropSelector::PROCESS_IS_RUNNING_INPUT.global_addr();
        for id in &reading.process_objects {
            if !self.process_listeners.contains(id)
                && Obj(*id)
                    .add_prop_listener(&address, on_change, self.signal)
                    .is_ok()
            {
                self.process_listeners.insert(*id);
            }
        }
        forget_gone(
            &mut self.process_listeners,
            &reading.process_objects,
            &address,
            self.signal,
        );

        let address = PropSelector::DEVICE_IS_RUNNING_SOMEWHERE.global_addr();
        for id in &reading.input_device_objects {
            if !self.device_listeners.contains(id)
                && Obj(*id)
                    .add_prop_listener(&address, on_change, self.signal)
                    .is_ok()
            {
                self.device_listeners.insert(*id);
            }
        }
        forget_gone(
            &mut self.device_listeners,
            &reading.input_device_objects,
            &address,
            self.signal,
        );
    }

    fn remove_listeners(&mut self) {
        for selector in SYSTEM_SELECTORS {
            let _ =
                System::OBJ.remove_prop_listener(&selector.global_addr(), on_change, self.signal);
        }
        let address = PropSelector::PROCESS_IS_RUNNING_INPUT.global_addr();
        for id in self.process_listeners.drain() {
            let _ = Obj(id).remove_prop_listener(&address, on_change, self.signal);
        }
        let address = PropSelector::DEVICE_IS_RUNNING_SOMEWHERE.global_addr();
        for id in self.device_listeners.drain() {
            let _ = Obj(id).remove_prop_listener(&address, on_change, self.signal);
        }
        drop(unsafe { Box::from_raw(self.signal) });
        self.signal = std::ptr::null_mut();
    }
}

/// Drops the listeners on objects that left the latest reading. Each one is
/// removed from CoreAudio before it is forgotten: an object CoreAudio keeps
/// alive could otherwise call `on_change` with the signal after
/// `remove_listeners` frees it, and an id that comes back would be listened
/// to twice.
fn forget_gone(
    listening: &mut HashSet<u32>,
    present: &[u32],
    address: &PropAddr,
    signal: *mut Signal,
) {
    listening.retain(|id| {
        if present.contains(id) {
            return true;
        }
        let _ = Obj(*id).remove_prop_listener(address, on_change, signal);
        false
    });
}

struct Reading {
    snapshot: MicSnapshot,
    process_objects: Vec<u32>,
    input_device_objects: Vec<u32>,
}

struct Reader {
    own_pid: libc::pid_t,
    responsible: Option<ResponsiblePid>,
}

impl Reader {
    fn new() -> Self {
        Self {
            own_pid: unsafe { libc::getpid() },
            responsible: responsible_pid_fn(),
        }
    }

    fn read(&self) -> Reading {
        let _pool = cidre::objc::AutoreleasePoolPage::push();
        let mut snapshot = MicSnapshot::default();
        let mut input_device_objects = Vec::new();
        let mut any_device_running = false;

        for device in System::devices().unwrap_or_default() {
            if !has_input_streams(&device) {
                continue;
            }
            input_device_objects.push(device.0.0);
            if let Ok(uid) = device.uid() {
                snapshot.input_devices.push(uid.to_string());
            }
            any_device_running |= device
                .bool_prop(&PropSelector::DEVICE_IS_RUNNING_SOMEWHERE.global_addr())
                .unwrap_or(false);
        }
        snapshot.input_devices.sort();
        snapshot.default_input = System::default_input_device()
            .ok()
            .and_then(|device| device.uid().ok())
            .map(|uid| uid.to_string());

        let mut process_objects = Vec::new();
        match Process::list() {
            Ok(processes) => {
                snapshot.attributed = true;
                for process in processes {
                    process_objects.push(process.0.0);
                    if !process.is_running_input().unwrap_or(false) {
                        continue;
                    }
                    let Ok(pid) = process.pid() else { continue };
                    if pid == self.own_pid || pid <= 0 {
                        continue;
                    }
                    snapshot.clients.push(self.client(&process, pid));
                }
                snapshot.clients.sort();
                snapshot.clients.dedup();
                snapshot.mic_in_use = !snapshot.clients.is_empty();
            }
            Err(_) => snapshot.mic_in_use = any_device_running,
        }

        Reading {
            snapshot,
            process_objects,
            input_device_objects,
        }
    }

    fn client(&self, process: &Process, pid: libc::pid_t) -> MicClient {
        let raw_id = process
            .bundle_id()
            .ok()
            .map(|id| id.to_string())
            .filter(|id| !id.is_empty())
            .or_else(|| executable_name(pid))
            .unwrap_or_default();

        let responsible_id = self
            .responsible
            .map(|responsible| unsafe { responsible(pid) })
            .filter(|responsible| *responsible > 0 && *responsible != pid)
            .and_then(bundle_id_for_pid);

        let device_uid = process
            .prop_vec::<Device>(&PropSelector::PROCESS_DEVICES.input_addr())
            .ok()
            .and_then(|devices| devices.first().and_then(|device| device.uid().ok()))
            .map(|uid| uid.to_string());

        MicClient {
            id: responsible_id.unwrap_or_else(|| raw_id.clone()),
            raw_id,
            pid: pid as u32,
            device_uid,
        }
    }
}

fn has_input_streams(device: &Device) -> bool {
    device.streams().is_ok_and(|streams| {
        streams
            .iter()
            .any(|stream| stream.direction().is_ok_and(|direction| direction == 1))
    })
}

fn bundle_id_for_pid(pid: libc::pid_t) -> Option<String> {
    ns::RunningApp::with_pid(pid)
        .and_then(|app| app.bundle_id())
        .map(|id| id.to_string())
        .filter(|id| !id.is_empty())
}

fn executable_name(pid: libc::pid_t) -> Option<String> {
    let mut buffer = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 {
        return None;
    }
    let path = CStr::from_bytes_until_nul(&buffer).ok()?.to_str().ok()?;
    path.rsplit('/').next().map(str::to_owned)
}

pub fn snapshot_now() -> MicSnapshot {
    Reader::new().read().snapshot
}
