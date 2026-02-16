#[cfg(any(target_os = "macos", target_os = "linux"))]
use scap_targets::{Window, WindowId};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowExclusion {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_identifier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
}

impl WindowExclusion {
    pub fn matches(
        &self,
        bundle_identifier: Option<&str>,
        owner_name: Option<&str>,
        window_title: Option<&str>,
    ) -> bool {
        if let Some(identifier) = self.bundle_identifier.as_deref()
            && bundle_identifier
                .map(|candidate| candidate == identifier)
                .unwrap_or(false)
        {
            return true;
        }

        if let Some(expected_owner) = self.owner_name.as_deref() {
            let owner_matches = owner_name
                .map(|candidate| candidate == expected_owner)
                .unwrap_or(false);

            if self.window_title.is_some() {
                return owner_matches
                    && self
                        .window_title
                        .as_deref()
                        .map(|expected_title| {
                            window_title
                                .map(|candidate| candidate == expected_title)
                                .unwrap_or(false)
                        })
                        .unwrap_or(false);
            }

            if owner_matches {
                return true;
            }
        }

        if let Some(expected_title) = self.window_title.as_deref() {
            return window_title
                .map(|candidate| candidate == expected_title)
                .unwrap_or(false);
        }

        false
    }
}

#[cfg(target_os = "macos")]
pub fn resolve_window_ids(exclusions: &[WindowExclusion]) -> Vec<WindowId> {
    if exclusions.is_empty() {
        return Vec::new();
    }

    Window::list()
        .into_iter()
        .filter_map(|window| {
            let owner_name = window.owner_name();
            let window_title = window.name();
            let bundle_identifier = window.raw_handle().bundle_identifier();

            exclusions
                .iter()
                .find(|entry| {
                    entry.matches(
                        bundle_identifier.as_deref(),
                        owner_name.as_deref(),
                        window_title.as_deref(),
                    )
                })
                .map(|_| window.id())
        })
        .collect()
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub fn resolve_window_ids(exclusions: &[WindowExclusion]) -> Vec<WindowId> {
    if exclusions.is_empty() {
        return Vec::new();
    }

    Window::list()
        .into_iter()
        .filter_map(|window| {
            let owner_name = window.owner_name();
            let window_title = window.name();

            exclusions
                .iter()
                .find(|entry| entry.matches(None, owner_name.as_deref(), window_title.as_deref()))
                .map(|_| window.id())
        })
        .collect()
}
