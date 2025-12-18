#![cfg(windows)]

use std::sync::OnceLock;
use windows::Win32::System::SystemInformation::{GetVersionExW, OSVERSIONINFOEXW, OSVERSIONINFOW};

static DETECTED_VERSION: OnceLock<Option<WindowsVersion>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowsVersion {
    pub major: u32,
    pub minor: u32,
    pub build: u32,
}

impl WindowsVersion {
    pub fn detect() -> Option<Self> {
        *DETECTED_VERSION.get_or_init(|| detect_version_internal())
    }

    pub fn meets_minimum_requirements(&self) -> bool {
        self.major > 10 || (self.major == 10 && self.build >= 18362)
    }

    pub fn supports_border_control(&self) -> bool {
        self.build >= 22000
    }

    pub fn is_windows_11(&self) -> bool {
        self.build >= 22000
    }

    pub fn display_name(&self) -> String {
        if self.build >= 22000 {
            format!("Windows 11 (Build {})", self.build)
        } else if self.major == 10 {
            format!("Windows 10 (Build {})", self.build)
        } else {
            format!(
                "Windows {}.{} (Build {})",
                self.major, self.minor, self.build
            )
        }
    }
}

fn detect_version_internal() -> Option<WindowsVersion> {
    unsafe {
        let mut info = OSVERSIONINFOEXW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOEXW>() as u32,
            ..Default::default()
        };

        let info_ptr = &mut info as *mut OSVERSIONINFOEXW as *mut OSVERSIONINFOW;

        #[allow(deprecated)]
        if GetVersionExW(info_ptr).is_ok() {
            let version = WindowsVersion {
                major: info.dwMajorVersion,
                minor: info.dwMinorVersion,
                build: info.dwBuildNumber,
            };

            tracing::debug!(
                major = version.major,
                minor = version.minor,
                build = version.build,
                display_name = %version.display_name(),
                "Detected Windows version"
            );

            return Some(version);
        }

        let mut basic_info = OSVERSIONINFOW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };

        #[allow(deprecated)]
        if GetVersionExW(&mut basic_info).is_ok() {
            let version = WindowsVersion {
                major: basic_info.dwMajorVersion,
                minor: basic_info.dwMinorVersion,
                build: basic_info.dwBuildNumber,
            };

            tracing::debug!(
                major = version.major,
                minor = version.minor,
                build = version.build,
                display_name = %version.display_name(),
                "Detected Windows version (basic)"
            );

            return Some(version);
        }

        tracing::warn!("Failed to detect Windows version");
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_returns_some() {
        let version = WindowsVersion::detect();
        assert!(version.is_some(), "Should detect Windows version");
    }

    #[test]
    fn test_version_requirements() {
        let old_version = WindowsVersion {
            major: 10,
            minor: 0,
            build: 17000,
        };
        assert!(!old_version.meets_minimum_requirements());

        let min_version = WindowsVersion {
            major: 10,
            minor: 0,
            build: 18362,
        };
        assert!(min_version.meets_minimum_requirements());

        let new_version = WindowsVersion {
            major: 10,
            minor: 0,
            build: 19041,
        };
        assert!(new_version.meets_minimum_requirements());
    }

    #[test]
    fn test_windows_11_detection() {
        let win10 = WindowsVersion {
            major: 10,
            minor: 0,
            build: 19045,
        };
        assert!(!win10.is_windows_11());
        assert!(!win10.supports_border_control());

        let win11 = WindowsVersion {
            major: 10,
            minor: 0,
            build: 22000,
        };
        assert!(win11.is_windows_11());
        assert!(win11.supports_border_control());
    }

    #[test]
    fn test_display_name() {
        let win10 = WindowsVersion {
            major: 10,
            minor: 0,
            build: 19045,
        };
        assert!(win10.display_name().contains("Windows 10"));
        assert!(win10.display_name().contains("19045"));

        let win11 = WindowsVersion {
            major: 10,
            minor: 0,
            build: 22631,
        };
        assert!(win11.display_name().contains("Windows 11"));
        assert!(win11.display_name().contains("22631"));
    }
}
