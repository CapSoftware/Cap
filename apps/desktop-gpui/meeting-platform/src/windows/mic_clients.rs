use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
};

use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE, WAIT_FAILED},
    System::{
        Registry::{
            HKEY, HKEY_CURRENT_USER, KEY_NOTIFY, KEY_READ, REG_NOTIFY_CHANGE_LAST_SET,
            REG_NOTIFY_CHANGE_NAME, REG_QWORD, RegCloseKey, RegEnumKeyExW, RegNotifyChangeKeyValue,
            RegOpenKeyExW, RegQueryValueExW,
        },
        Threading::{CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects},
    },
};

use crate::{MicClient, MicSnapshot, WatchError};

const CONSENT_STORE: &str =
    r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

const PACKAGED_APPS: &[(&str, &str)] = &[
    ("msteams", "ms-teams.exe"),
    ("microsoftteams", "teams.exe"),
    ("whatsapp", "whatsapp.exe"),
    ("skype", "skype.exe"),
    ("slack", "slack.exe"),
    ("discord", "discord.exe"),
    ("zoom", "zoom.exe"),
    ("telegram", "telegram.exe"),
    ("webex", "webex.exe"),
];

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

struct Key(HKEY);

impl Key {
    fn open(parent: HKEY, path: &str, access: u32) -> Option<Self> {
        let mut key: HKEY = std::ptr::null_mut();
        let status = unsafe { RegOpenKeyExW(parent, wide(path).as_ptr(), 0, access, &mut key) };
        (status == ERROR_SUCCESS).then_some(Self(key))
    }

    fn subkeys(&self) -> Vec<String> {
        let mut names = Vec::new();
        for index in 0.. {
            let mut buffer = [0u16; 1024];
            let mut length = buffer.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    self.0,
                    index,
                    buffer.as_mut_ptr(),
                    &mut length,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if status != ERROR_SUCCESS {
                break;
            }
            names.push(String::from_utf16_lossy(&buffer[..length as usize]));
        }
        names
    }

    fn qword(&self, name: &str) -> Option<u64> {
        let mut value = 0u64;
        let mut size = size_of::<u64>() as u32;
        let mut kind = 0u32;
        let status = unsafe {
            RegQueryValueExW(
                self.0,
                wide(name).as_ptr(),
                std::ptr::null(),
                &mut kind,
                (&raw mut value).cast(),
                &mut size,
            )
        };
        (status == ERROR_SUCCESS && kind == REG_QWORD).then_some(value)
    }

    fn in_use(&self) -> bool {
        self.qword("LastUsedTimeStart")
            .is_some_and(|start| start != 0)
            && self.qword("LastUsedTimeStop") == Some(0)
    }
}

impl Drop for Key {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}

fn packaged_id(family: &str) -> String {
    let lowered = family.to_lowercase();
    PACKAGED_APPS
        .iter()
        .find(|(needle, _)| lowered.contains(needle))
        .map_or(lowered.clone(), |(_, exe)| (*exe).to_owned())
}

fn own_executable() -> Option<String> {
    std::env::current_exe()
        .ok()?
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
}

pub fn snapshot_now() -> MicSnapshot {
    let mut snapshot = MicSnapshot {
        attributed: true,
        ..MicSnapshot::default()
    };
    let Some(store) = Key::open(HKEY_CURRENT_USER, CONSENT_STORE, KEY_READ) else {
        snapshot.attributed = false;
        return snapshot;
    };
    let own = own_executable();

    for name in store.subkeys() {
        if name.eq_ignore_ascii_case("NonPackaged") {
            let Some(unpackaged) = Key::open(store.0, &name, KEY_READ) else {
                continue;
            };
            for path in unpackaged.subkeys() {
                let Some(entry) = Key::open(unpackaged.0, &path, KEY_READ) else {
                    continue;
                };
                if !entry.in_use() {
                    continue;
                }
                let executable = path.rsplit('#').next().unwrap_or(&path).to_lowercase();
                if own.as_deref() == Some(executable.as_str()) {
                    continue;
                }
                snapshot.clients.push(MicClient {
                    id: executable,
                    raw_id: path.replace('#', "\\"),
                    pid: 0,
                    device_uid: None,
                    device_uids: Vec::new(),
                });
            }
        } else if let Some(entry) = Key::open(store.0, &name, KEY_READ)
            && entry.in_use()
        {
            snapshot.clients.push(MicClient {
                id: packaged_id(&name),
                raw_id: name,
                pid: 0,
                device_uid: None,
                device_uids: Vec::new(),
            });
        }
    }

    // The consent store names executables, not processes: look up one
    // running process per app so its windows can be read (call check,
    // speaker names). 0 when it has already exited.
    let names: Vec<&str> = snapshot.clients.iter().map(|c| c.id.as_str()).collect();
    let running = super::procs::processes_for(&names);
    for client in &mut snapshot.clients {
        client.pid = running.get(&client.id).copied().unwrap_or(0);
    }

    snapshot.clients.sort();
    snapshot.clients.dedup();
    snapshot.mic_in_use = !snapshot.clients.is_empty();
    snapshot
}

struct Event(HANDLE);

unsafe impl Send for Event {}
unsafe impl Sync for Event {}

impl Event {
    fn new() -> Option<Self> {
        let handle = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
        (!handle.is_null()).then_some(Self(handle))
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

pub struct Watcher {
    stop: Arc<AtomicBool>,
    wake: Arc<Event>,
    thread: Option<JoinHandle<()>>,
}

impl Watcher {
    pub fn spawn(updates: flume::Sender<MicSnapshot>) -> Result<Self, WatchError> {
        let wake = Arc::new(
            Event::new().ok_or_else(|| WatchError::Start("event creation failed".into()))?,
        );
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::Builder::new()
            .name("cap-mic-activity".into())
            .spawn({
                let stop = stop.clone();
                let wake = wake.clone();
                move || run(&updates, &stop, &wake)
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
        unsafe { SetEvent(self.wake.0) };
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run(updates: &flume::Sender<MicSnapshot>, stop: &AtomicBool, wake: &Event) {
    let Some(changed) = Event::new() else { return };
    let store = Key::open(HKEY_CURRENT_USER, CONSENT_STORE, KEY_READ | KEY_NOTIFY);
    let mut last = None;

    while !stop.load(Ordering::Acquire) {
        let armed = store.as_ref().is_some_and(|store| {
            (unsafe {
                RegNotifyChangeKeyValue(
                    store.0,
                    1,
                    REG_NOTIFY_CHANGE_NAME | REG_NOTIFY_CHANGE_LAST_SET,
                    changed.0,
                    1,
                )
            }) == ERROR_SUCCESS
        });

        let snapshot = snapshot_now();
        if last.as_ref() != Some(&snapshot) {
            last = Some(snapshot.clone());
            if updates.send(snapshot).is_err() {
                return;
            }
        }

        let handles = [wake.0, changed.0];
        let timeout = if armed { INFINITE } else { 5_000 };
        if unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, timeout) } == WAIT_FAILED {
            std::thread::sleep(std::time::Duration::from_secs(5));
        }
    }
}
