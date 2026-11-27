//! Processes and their top-level windows. The consent store names the
//! executable that holds the microphone but not its process, so the watcher
//! looks the process up here, and the interface readers find every window
//! that belongs to the same executable (browsers and Electron apps own their
//! windows from one of many processes).

use std::collections::HashMap;

use windows_sys::Win32::{
    Foundation::{CloseHandle, HWND, INVALID_HANDLE_VALUE, LPARAM},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
        Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW},
    },
    UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GetWindow, GetWindowThreadProcessId, IsWindowVisible,
    },
};

fn file_name(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .next()
        .unwrap_or(path)
        .to_lowercase()
}

/// The lowercase executable file name of a running process.
pub fn executable(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }
    let mut buffer = [0u16; 1024];
    let mut length = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) };
    unsafe { CloseHandle(process) };
    (ok != 0).then(|| file_name(&String::from_utf16_lossy(&buffer[..length as usize])))
}

/// One running process for each wanted executable name (lowercase file
/// names), preferring the one that owns a visible window: that is the
/// browser or app process a person looks at, not a helper.
pub fn processes_for(names: &[&str]) -> HashMap<String, u32> {
    let mut found: HashMap<String, Vec<u32>> = HashMap::new();
    if names.is_empty() {
        return HashMap::new();
    }
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return HashMap::new();
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while more {
        let end = entry
            .szExeFile
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..end]).to_lowercase();
        if names.contains(&name.as_str()) {
            found.entry(name).or_default().push(entry.th32ProcessID);
        }
        more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    if found.is_empty() {
        return HashMap::new();
    }
    let with_windows: Vec<u32> = top_level_windows()
        .into_iter()
        .map(|(_, pid)| pid)
        .collect();
    found
        .into_iter()
        .map(|(name, pids)| {
            let pid = pids
                .iter()
                .copied()
                .find(|pid| with_windows.contains(pid))
                .unwrap_or(pids[0]);
            (name, pid)
        })
        .collect()
}

/// Every running process: its parent and lowercase executable file name.
pub fn tree() -> HashMap<u32, crate::call_output::Proc> {
    let mut out = HashMap::new();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return out;
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while more {
        let end = entry
            .szExeFile
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(entry.szExeFile.len());
        out.insert(
            entry.th32ProcessID,
            crate::call_output::Proc {
                parent: entry.th32ParentProcessID,
                exe: String::from_utf16_lossy(&entry.szExeFile[..end]).to_lowercase(),
            },
        );
        more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    out
}

/// Visible, unowned top-level windows with their process ids.
pub fn top_level_windows() -> Vec<(HWND, u32)> {
    unsafe extern "system" fn each(window: HWND, list: LPARAM) -> i32 {
        let list = unsafe { &mut *(list as *mut Vec<(HWND, u32)>) };
        if unsafe { IsWindowVisible(window) } != 0
            && unsafe { GetWindow(window, GW_OWNER) }.is_null()
        {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(window, &mut pid) };
            list.push((window, pid));
        }
        1
    }
    let mut list: Vec<(HWND, u32)> = Vec::new();
    unsafe { EnumWindows(Some(each), (&raw mut list) as LPARAM) };
    list
}

/// Every visible top-level window whose process runs the same executable as
/// `pid`.
pub fn windows_of_app(pid: u32) -> Vec<HWND> {
    let Some(target) = executable(pid) else {
        return Vec::new();
    };
    let mut names: HashMap<u32, Option<String>> = HashMap::new();
    top_level_windows()
        .into_iter()
        .filter(|(_, owner)| {
            names
                .entry(*owner)
                .or_insert_with(|| executable(*owner))
                .as_deref()
                == Some(target.as_str())
        })
        .map(|(window, _)| window)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_is_found_by_its_executable() {
        let own = executable(std::process::id()).expect("own executable");
        assert!(own.ends_with(".exe"), "{own}");
        let found = processes_for(&[own.as_str()]);
        assert!(found.contains_key(&own), "{found:?}");
        assert_eq!(file_name(r"C:\Program Files\Zoom\bin\Zoom.exe"), "zoom.exe");
    }
}
