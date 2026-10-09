use std::path::Path;

pub(super) fn install() {
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    if !is_installed_executable(&executable) {
        return;
    }
    std::thread::Builder::new()
        .name("cap-url-scheme".into())
        .spawn(move || {
            if let Err(error) = claim_url_scheme("cap-desktop", &executable) {
                tracing::warn!(%error, "could not register the cap-desktop link handler");
            }
        })
        .ok();
}

fn is_installed_executable(executable: &Path) -> bool {
    executable
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("Cap.exe"))
        && !executable
            .components()
            .any(|component| component.as_os_str() == "target")
}

fn wide_null(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt as _;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn read_user_registry_string(key: &str) -> Option<String> {
    use std::os::windows::ffi::OsStringExt as _;
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_SZ, RegGetValueW},
    };

    let key = wide_null(std::ffi::OsStr::new(key));
    let mut buffer = vec![0_u16; 2048];
    let mut size = (buffer.len() * std::mem::size_of::<u16>()) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            std::ptr::null(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let length = (size as usize / std::mem::size_of::<u16>()).min(buffer.len());
    let value = std::ffi::OsString::from_wide(&buffer[..length]);
    Some(value.to_string_lossy().trim_end_matches('\0').to_string())
}

fn write_user_registry_string(key: &str, name: Option<&str>, value: &str) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Registry::{HKEY_CURRENT_USER, REG_SZ, RegSetKeyValueW},
    };

    let key = wide_null(std::ffi::OsStr::new(key));
    let name = name.map(|name| wide_null(std::ffi::OsStr::new(name)));
    let value = wide_null(std::ffi::OsStr::new(value));
    let status = unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ref().map_or(std::ptr::null(), |name| name.as_ptr()),
            REG_SZ,
            value.as_ptr().cast(),
            (value.len() * std::mem::size_of::<u16>()) as u32,
        )
    };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("registry write failed with code {status}"))
    }
}

fn claim_url_scheme(scheme: &str, executable: &Path) -> Result<(), String> {
    let executable = executable.display().to_string();
    let class = format!("Software\\Classes\\{scheme}");
    let command_key = format!("{class}\\shell\\open\\command");
    let command = format!("\"{executable}\" \"%1\"");
    if read_user_registry_string(&command_key).as_deref() == Some(command.as_str()) {
        return Ok(());
    }
    write_user_registry_string(&class, None, "URL:so.cap.desktop protocol")?;
    write_user_registry_string(&class, Some("URL Protocol"), "")?;
    write_user_registry_string(
        &format!("{class}\\DefaultIcon"),
        None,
        &format!("\"{executable}\",0"),
    )?;
    write_user_registry_string(&command_key, None, &command)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    #[test]
    fn only_installed_builds_claim_the_link_scheme() {
        assert!(super::is_installed_executable(Path::new(
            r"C:\Users\x\AppData\Local\Cap\Cap.exe"
        )));
        assert!(!super::is_installed_executable(Path::new(
            r"C:\src\Cap\apps\desktop-gpui\target\release\Cap.exe"
        )));
        assert!(!super::is_installed_executable(Path::new(
            r"C:\Users\x\AppData\Local\Cap Classic\Cap Classic.exe"
        )));
        assert!(!super::is_installed_executable(Path::new(
            r"C:\Users\x\AppData\Local\Cap\cap-gpui.exe"
        )));
    }
}
