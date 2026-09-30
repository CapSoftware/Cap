use std::ffi::c_void;

use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTESESSION};

const ENV_OVERRIDE: &str = "CAP_WINDOW_CAPTURE_EXCLUSION";
// Shadow reports S:102 for protected windows; EC2/DCV still displays excluded windows.
const SMBIOS_MARKERS: &[&str] = &["shadow"];
const VIRTUAL_DISPLAY_MARKERS: &[&str] = &[
    "parsec",
    "spacedesk",
    "iddsample",
    "virtual display",
    "usbmmidd",
    "amyuni",
    "shadow",
];

#[repr(C)]
struct DisplayDevice {
    size: u32,
    name: [u16; 32],
    description: [u16; 128],
    state_flags: u32,
    id: [u16; 128],
    key: [u16; 128],
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn RegGetValueW(
        key: *mut c_void,
        subkey: *const u16,
        value: *const u16,
        flags: u32,
        value_type: *mut u32,
        data: *mut c_void,
        data_size: *mut u32,
    ) -> i32;
}

#[link(name = "user32")]
unsafe extern "system" {
    fn EnumDisplayDevicesW(
        device: *const u16,
        index: u32,
        display: *mut DisplayDevice,
        flags: u32,
    ) -> i32;
}

fn exclusion_override(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "on" | "always" | "1" => Some(true),
        "off" | "never" | "0" => Some(false),
        _ => None,
    }
}

pub(super) fn streamed_display_reason() -> Option<String> {
    streamed_display_reason_with(
        std::env::var(ENV_OVERRIDE).ok().as_deref(),
        || unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 },
        streamed_computer_marker,
        virtual_display_adapter,
    )
}

fn streamed_display_reason_with(
    override_value: Option<&str>,
    remote_session: impl FnOnce() -> bool,
    streamed_computer: impl FnOnce() -> Option<String>,
    virtual_display: impl FnOnce() -> Option<String>,
) -> Option<String> {
    match override_value.and_then(exclusion_override) {
        Some(true) => return None,
        Some(false) => return Some(format!("{ENV_OVERRIDE} env override")),
        None => {}
    }
    if remote_session() {
        return Some("remote desktop session (SM_REMOTESESSION)".to_string());
    }
    if let Some(marker) = streamed_computer() {
        return Some(format!("streamed computer SMBIOS ({marker})"));
    }
    virtual_display().map(|device| format!("virtual display adapter ({device})"))
}

fn streamed_computer_marker() -> Option<String> {
    for value in [
        "SystemManufacturer",
        "SystemProductName",
        "SystemFamily",
        "BIOSVendor",
    ] {
        if let Some(text) = bios_value(value)
            && let Some(marker) = find_marker(&text, SMBIOS_MARKERS)
        {
            return Some(format!("{value}=\"{text}\" matched \"{marker}\""));
        }
    }
    None
}

fn bios_value(value: &str) -> Option<String> {
    const HKEY_LOCAL_MACHINE: *mut c_void = 0x8000_0002u32 as i32 as isize as *mut c_void;
    const STRING_FLAGS: u32 = 0x1000_0006;
    let subkey: Vec<u16> = "HARDWARE\\DESCRIPTION\\System\\BIOS\0"
        .encode_utf16()
        .collect();
    let value: Vec<u16> = value.encode_utf16().chain([0]).collect();
    let mut byte_count = 0u32;
    if unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value.as_ptr(),
            STRING_FLAGS,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut byte_count,
        )
    } != 0
        || byte_count == 0
        || byte_count > 65_536
        || !byte_count.is_multiple_of(2)
    {
        return None;
    }
    let mut data = vec![0u16; byte_count as usize / 2];
    if unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value.as_ptr(),
            STRING_FLAGS,
            std::ptr::null_mut(),
            data.as_mut_ptr().cast(),
            &mut byte_count,
        )
    } != 0
    {
        return None;
    }
    Some(wide_text(&data))
}

fn virtual_display_adapter() -> Option<String> {
    let mut index = 0u32;
    loop {
        let mut display = DisplayDevice {
            size: std::mem::size_of::<DisplayDevice>() as u32,
            name: [0; 32],
            description: [0; 128],
            state_flags: 0,
            id: [0; 128],
            key: [0; 128],
        };
        if unsafe { EnumDisplayDevicesW(std::ptr::null(), index, &mut display, 0) } == 0 {
            return None;
        }
        index += 1;
        if display.state_flags & 1 == 0 {
            continue;
        }
        let name = wide_text(&display.description);
        if let Some(marker) = find_marker(&name, VIRTUAL_DISPLAY_MARKERS) {
            return Some(format!("\"{name}\" matched \"{marker}\""));
        }
    }
}

fn wide_text(value: &[u16]) -> String {
    let end = value
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..end])
}

fn find_marker(text: &str, markers: &[&'static str]) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    markers
        .iter()
        .copied()
        .find(|marker| lower.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_preserve_auto_and_explicit_choices() {
        for value in ["on", " ALWAYS ", "1"] {
            assert_eq!(exclusion_override(value), Some(true));
        }
        for value in ["off", " NEVER ", "0"] {
            assert_eq!(exclusion_override(value), Some(false));
        }
        for value in ["", "auto", "unknown"] {
            assert_eq!(exclusion_override(value), None);
        }
    }

    #[test]
    fn explicit_override_does_not_probe_the_environment() {
        for (value, expected) in [
            ("on", None),
            ("off", Some(format!("{ENV_OVERRIDE} env override"))),
        ] {
            assert_eq!(
                streamed_display_reason_with(
                    Some(value),
                    || panic!("override must skip remote-session detection"),
                    || panic!("override must skip SMBIOS detection"),
                    || panic!("override must skip display detection"),
                ),
                expected
            );
        }
    }

    #[test]
    fn remote_session_keeps_its_compatibility_exception() {
        assert_eq!(
            streamed_display_reason_with(
                None,
                || true,
                || panic!("remote session must skip SMBIOS detection"),
                || panic!("remote session must skip display detection"),
            ),
            Some("remote desktop session (SM_REMOTESESSION)".to_string())
        );
    }

    #[test]
    fn shadow_keeps_its_compatibility_exception() {
        for computer in ["Shadow", "SHADOW COMPUTER"] {
            assert_eq!(
                streamed_display_reason_with(
                    None,
                    || false,
                    || find_marker(computer, SMBIOS_MARKERS).map(str::to_string),
                    || panic!("Shadow must skip display detection"),
                ),
                Some("streamed computer SMBIOS (shadow)".to_string())
            );
        }
    }

    #[test]
    fn existing_streamed_adapters_keep_their_compatibility_exception() {
        for adapter in [
            "Parsec Virtual Display Adapter",
            "spacedesk",
            "IddSampleDriver",
            "Virtual Display",
            "usbmmidd",
            "Amyuni",
            "Shadow",
        ] {
            assert!(
                streamed_display_reason_with(
                    None,
                    || false,
                    || None,
                    || find_marker(adapter, VIRTUAL_DISPLAY_MARKERS).map(str::to_string),
                )
                .is_some(),
                "{adapter}"
            );
        }
    }

    #[test]
    fn virtual_machine_hardware_keeps_capture_exclusion() {
        for computer in [
            "Amazon EC2",
            "QEMU Standard PC (Q35 + ICH9, 2009)",
            "KVM",
            "VMware",
            "VirtualBox",
            "innotek",
            "Xen",
            "Bochs",
            "Parallels",
            "Microsoft Corporation Virtual Machine",
            "HVM domU",
            "Google Compute Engine",
            "OpenStack",
        ] {
            assert_eq!(
                streamed_display_reason_with(
                    None,
                    || false,
                    || find_marker(computer, SMBIOS_MARKERS).map(str::to_string),
                    || None,
                ),
                None,
                "{computer}"
            );
        }
    }

    #[test]
    fn physical_hardware_keeps_capture_exclusion() {
        for name in [
            "Dell Inc.",
            "ASUSTeK COMPUTER INC.",
            "NVIDIA GeForce RTX 3080",
            "AMD Radeon RX 7900 XTX",
            "Intel(R) UHD Graphics 770",
            "LENOVO",
            "Micro-Star International Co., Ltd.",
        ] {
            assert_eq!(find_marker(name, SMBIOS_MARKERS), None, "{name}");
            assert_eq!(find_marker(name, VIRTUAL_DISPLAY_MARKERS), None, "{name}");
        }
        for override_value in [None, Some("auto"), Some("unknown")] {
            assert_eq!(
                streamed_display_reason_with(override_value, || false, || None, || None),
                None
            );
        }
    }

    #[test]
    fn display_description_ends_at_first_null() {
        assert_eq!(wide_text(&[83, 104, 97, 100, 111, 119, 0, 88]), "Shadow");
        assert_eq!(std::mem::size_of::<DisplayDevice>(), 840);
    }
}
