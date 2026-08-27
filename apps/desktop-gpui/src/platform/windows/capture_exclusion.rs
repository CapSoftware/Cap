use std::ffi::c_void;

use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTESESSION};

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

// Match Tauri's streamed-desktop policy: WDA exclusion also hides controls from
// Shadow/RDP viewers, not just from the recording being made.
pub(super) fn streamed_display_reason() -> Option<String> {
    match std::env::var(ENV_OVERRIDE)
        .ok()
        .and_then(|value| exclusion_override(&value))
    {
        Some(true) => return None,
        Some(false) => return Some(format!("{ENV_OVERRIDE} env override")),
        None => {}
    }
    if unsafe { GetSystemMetrics(SM_REMOTESESSION) } != 0 {
        return Some("remote desktop session (SM_REMOTESESSION)".to_string());
    }
    if let Some(vendor) = hypervisor_guest() {
        return Some(format!("hypervisor guest ({vendor})"));
    }
    for value in [
        "SystemManufacturer",
        "SystemProductName",
        "SystemFamily",
        "BIOSVendor",
    ] {
        if let Some(text) = bios_value(value)
            && let Some(marker) = find_marker(&text, SMBIOS_MARKERS)
        {
            return Some(format!(
                "virtual machine SMBIOS ({value}=\"{text}\" matched \"{marker}\")"
            ));
        }
    }
    virtual_display_adapter().map(|device| format!("virtual display adapter ({device})"))
}

#[cfg(target_arch = "x86_64")]
fn hypervisor_guest() -> Option<String> {
    use std::arch::x86_64::__cpuid;

    if __cpuid(1).ecx & (1 << 31) == 0 {
        return None;
    }
    let hypervisor = __cpuid(0x4000_0000);
    let mut vendor = [0u8; 12];
    vendor[0..4].copy_from_slice(&hypervisor.ebx.to_le_bytes());
    vendor[4..8].copy_from_slice(&hypervisor.ecx.to_le_bytes());
    vendor[8..12].copy_from_slice(&hypervisor.edx.to_le_bytes());
    let privileges = if &vendor == b"Microsoft Hv" && hypervisor.eax >= 0x4000_0003 {
        __cpuid(0x4000_0003).ebx
    } else {
        0
    };
    if is_hyperv_root(&vendor, hypervisor.eax, privileges) {
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

#[cfg(any(target_arch = "x86_64", test))]
fn is_hyperv_root(vendor: &[u8; 12], maximum_leaf: u32, privileges: u32) -> bool {
    // VBS/WSL2 exposes Hyper-V on physical hosts; CreatePartitions identifies
    // the root partition, which must retain ordinary capture exclusion.
    vendor == b"Microsoft Hv" && maximum_leaf >= 0x4000_0003 && privileges & 1 != 0
}

#[cfg(not(target_arch = "x86_64"))]
fn hypervisor_guest() -> Option<String> {
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
    fn known_streamed_displays_match_but_physical_hardware_does_not() {
        for value in [
            "Shadow Computer",
            "Amazon EC2",
            "QEMU Standard PC",
            "Virtual Machine",
        ] {
            assert!(find_marker(value, SMBIOS_MARKERS).is_some(), "{value}");
        }
        for value in ["Parsec Virtual Display Adapter", "Shadow", "spacedesk"] {
            assert!(
                find_marker(value, VIRTUAL_DISPLAY_MARKERS).is_some(),
                "{value}"
            );
        }
        for value in [
            "Dell Inc.",
            "LENOVO",
            "NVIDIA GeForce RTX 3080",
            "AMD Radeon RX 7900 XTX",
        ] {
            assert_eq!(find_marker(value, SMBIOS_MARKERS), None);
            assert_eq!(find_marker(value, VIRTUAL_DISPLAY_MARKERS), None);
        }
    }

    #[test]
    fn hyperv_root_is_not_mistaken_for_a_guest() {
        assert!(is_hyperv_root(b"Microsoft Hv", 0x4000_0003, 1));
        assert!(!is_hyperv_root(b"Microsoft Hv", 0x4000_0003, 0));
        assert!(!is_hyperv_root(b"Microsoft Hv", 0x4000_0002, 1));
        assert!(!is_hyperv_root(b"VMwareVMware", 0x4000_0003, 1));
    }

    #[test]
    fn display_description_ends_at_first_null() {
        assert_eq!(wide_text(&[83, 104, 97, 100, 111, 119, 0, 88]), "Shadow");
        assert_eq!(std::mem::size_of::<DisplayDevice>(), 840);
    }
}
