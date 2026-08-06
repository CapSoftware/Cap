//! Detection of desktops that are only viewable through a capture-based
//! stream (cloud PCs like Shadow, RDP sessions, VMs, virtual display
//! adapters).
//!
//! On these systems `WDA_EXCLUDEFROMCAPTURE` does not just hide a window from
//! recordings — the streamer itself sees the desktop through the capture
//! APIs, so an excluded window becomes invisible to the user and DRM
//! detectors flag it as protected content (e.g. Shadow error S:102).

use winreg::RegKey;
use winreg::enums::HKEY_LOCAL_MACHINE;

/// Environment override (case-insensitive): `off`/`never`/`0` forces
/// exclusion off, `on`/`always`/`1` forces it on (skips detection),
/// anything else = auto.
const ENV_OVERRIDE: &str = "CAP_WINDOW_CAPTURE_EXCLUSION";

const SMBIOS_MARKERS: &[&str] = &[
    "qemu",
    "kvm",
    "vmware",
    "virtualbox",
    "innotek",
    "xen",
    "bochs",
    "parallels",
    "virtual machine",
    "hvm domu",
    "amazon ec2",
    "google compute engine",
    "openstack",
    "shadow",
];

const VIRTUAL_DISPLAY_MARKERS: &[&str] = &[
    "parsec",
    "spacedesk",
    "iddsample",
    "virtual display",
    "usbmmidd",
    "amyuni",
    "shadow",
];

/// Returns `Some(reason)` when this desktop is being viewed through a
/// capture-based stream and window capture exclusion would hide Cap's
/// windows from the user themselves.
pub fn capture_streamed_display_reason() -> Option<String> {
    let override_value = std::env::var(ENV_OVERRIDE)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase());
    match override_value.as_deref() {
        Some("on" | "always" | "1") => return None,
        Some("off" | "never" | "0") => {
            return Some(format!("{ENV_OVERRIDE} env override"));
        }
        _ => {}
    }

    if remote_session_active() {
        return Some("remote desktop session (SM_REMOTESESSION)".to_string());
    }

    if let Some(vendor) = hypervisor_guest() {
        return Some(format!("hypervisor guest ({vendor})"));
    }

    if let Some(marker) = smbios_virtual_machine_marker() {
        return Some(format!("virtual machine SMBIOS ({marker})"));
    }

    if let Some(device) = virtual_display_adapter() {
        return Some(format!("virtual display adapter ({device})"));
    }

    None
}

fn remote_session_active() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTESESSION};
    unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
}

#[cfg(target_arch = "x86_64")]
fn hypervisor_guest() -> Option<String> {
    use std::arch::x86_64::__cpuid;

    if unsafe { __cpuid(1) }.ecx & (1 << 31) == 0 {
        return None;
    }

    let hv = unsafe { __cpuid(0x4000_0000) };
    let mut vendor = [0u8; 12];
    vendor[0..4].copy_from_slice(&hv.ebx.to_le_bytes());
    vendor[4..8].copy_from_slice(&hv.ecx.to_le_bytes());
    vendor[8..12].copy_from_slice(&hv.edx.to_le_bytes());

    // Hyper-V hosts the desktop OS itself when VBS / WSL2 / Hyper-V is
    // enabled. The root partition (CreatePartitions privilege, leaf
    // 0x40000003 EBX bit 0) is the physical machine, not a guest.
    if &vendor == b"Microsoft Hv"
        && hv.eax >= 0x4000_0003
        && unsafe { __cpuid(0x4000_0003) }.ebx & 1 != 0
    {
        return None;
    }

    let vendor = String::from_utf8_lossy(&vendor)
        .trim_matches([char::from(0), ' '])
        .to_string();
    Some(if vendor.is_empty() {
        "unknown hypervisor".to_string()
    } else {
        vendor
    })
}

#[cfg(not(target_arch = "x86_64"))]
fn hypervisor_guest() -> Option<String> {
    None
}

fn smbios_virtual_machine_marker() -> Option<String> {
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
    fn markers_match_known_environments() {
        assert_eq!(
            find_marker("QEMU Standard PC (Q35 + ICH9, 2009)", SMBIOS_MARKERS),
            Some("qemu")
        );
        assert_eq!(
            find_marker("Virtual Machine", SMBIOS_MARKERS),
            Some("virtual machine")
        );
        assert_eq!(
            find_marker("Parsec Virtual Display Adapter", VIRTUAL_DISPLAY_MARKERS),
            Some("parsec")
        );
    }

    #[test]
    fn markers_ignore_physical_hardware() {
        for text in [
            "Dell Inc.",
            "ASUSTeK COMPUTER INC.",
            "NVIDIA GeForce RTX 3080",
            "AMD Radeon RX 7900 XTX",
            "Intel(R) UHD Graphics 770",
            "LENOVO",
            "Micro-Star International Co., Ltd.",
        ] {
            assert_eq!(find_marker(text, SMBIOS_MARKERS), None, "{text}");
            assert_eq!(find_marker(text, VIRTUAL_DISPLAY_MARKERS), None, "{text}");
        }
    }
}
