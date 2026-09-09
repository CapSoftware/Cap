use winreg::RegKey;
use winreg::enums::HKEY_LOCAL_MACHINE;

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

pub fn capture_streamed_display_reason() -> Option<String> {
    streamed_display_reason_with(
        std::env::var(ENV_OVERRIDE).ok().as_deref(),
        remote_session_active,
        streamed_computer_marker,
        virtual_display_adapter,
    )
}

fn exclusion_override(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "on" | "always" | "1" => Some(true),
        "off" | "never" | "0" => Some(false),
        _ => None,
    }
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

fn remote_session_active() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTESESSION};
    unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
}

fn streamed_computer_marker() -> Option<String> {
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("HARDWARE\\DESCRIPTION\\System\\BIOS")
        .ok()?;

    for value in [
        "SystemManufacturer",
        "SystemProductName",
        "SystemFamily",
        "BIOSVendor",
    ] {
        let Ok(text) = key.get_value::<String, _>(value) else {
            continue;
        };
        if let Some(marker) = find_marker(&text, SMBIOS_MARKERS) {
            return Some(format!("{value}=\"{text}\" matched \"{marker}\""));
        }
    }

    None
}

fn virtual_display_adapter() -> Option<String> {
    use windows::Win32::Graphics::Gdi::{
        DISPLAY_DEVICE_ATTACHED_TO_DESKTOP, DISPLAY_DEVICEW, EnumDisplayDevicesW,
    };
    use windows::core::PCWSTR;

    let mut index = 0u32;
    loop {
        let mut device = DISPLAY_DEVICEW {
            cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        if !unsafe { EnumDisplayDevicesW(PCWSTR::null(), index, &mut device, 0) }.as_bool() {
            return None;
        }
        index += 1;

        if !device
            .StateFlags
            .contains(DISPLAY_DEVICE_ATTACHED_TO_DESKTOP)
        {
            continue;
        }

        let name = String::from_utf16_lossy(&device.DeviceString);
        let name = name.trim_matches(char::from(0));
        if let Some(marker) = find_marker(name, VIRTUAL_DISPLAY_MARKERS) {
            return Some(format!("\"{name}\" matched \"{marker}\""));
        }
    }
}

fn find_marker(text: &str, markers: &[&'static str]) -> Option<&'static str> {
    let lower = text.to_lowercase();
    markers.iter().copied().find(|m| lower.contains(m))
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
}
