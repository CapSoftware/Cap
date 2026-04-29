#[cfg(target_os = "macos")]
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

#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub fn filter_for_instant_mode(
    mut exclusions: Vec<WindowExclusion>,
    camera_title: &str,
) -> Vec<WindowExclusion> {
    exclusions.retain(|e| e.window_title.as_deref() != Some(camera_title));
    exclusions
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

#[cfg(test)]
mod tests {
    use super::*;

    fn title_exclusion(title: &str) -> WindowExclusion {
        WindowExclusion {
            bundle_identifier: None,
            owner_name: None,
            window_title: Some(title.to_string()),
        }
    }

    fn bundle_exclusion(bundle_id: &str) -> WindowExclusion {
        WindowExclusion {
            bundle_identifier: Some(bundle_id.to_string()),
            owner_name: None,
            window_title: None,
        }
    }

    fn owner_exclusion(owner: &str) -> WindowExclusion {
        WindowExclusion {
            bundle_identifier: None,
            owner_name: Some(owner.to_string()),
            window_title: None,
        }
    }

    #[test]
    fn matches_by_window_title() {
        let exclusion = title_exclusion("Cap Camera");
        assert!(exclusion.matches(None, None, Some("Cap Camera")));
        assert!(!exclusion.matches(None, None, Some("Other Window")));
        assert!(!exclusion.matches(None, None, None));
    }

    #[test]
    fn matches_by_bundle_identifier() {
        let exclusion = bundle_exclusion("com.cap.desktop");
        assert!(exclusion.matches(Some("com.cap.desktop"), None, None));
        assert!(!exclusion.matches(Some("com.other.app"), None, None));
        assert!(!exclusion.matches(None, None, None));
    }

    #[test]
    fn matches_by_owner_name() {
        let exclusion = owner_exclusion("Cap");
        assert!(exclusion.matches(None, Some("Cap"), None));
        assert!(!exclusion.matches(None, Some("Other"), None));
        assert!(!exclusion.matches(None, None, None));
    }

    #[test]
    fn matches_owner_and_title_requires_both() {
        let exclusion = WindowExclusion {
            bundle_identifier: None,
            owner_name: Some("Cap".to_string()),
            window_title: Some("Cap Camera".to_string()),
        };
        assert!(exclusion.matches(None, Some("Cap"), Some("Cap Camera")));
        assert!(!exclusion.matches(None, Some("Cap"), Some("Wrong Title")));
        assert!(!exclusion.matches(None, Some("Wrong Owner"), Some("Cap Camera")));
        assert!(!exclusion.matches(None, None, Some("Cap Camera")));
    }

    #[test]
    fn empty_exclusion_matches_nothing() {
        let exclusion = WindowExclusion {
            bundle_identifier: None,
            owner_name: None,
            window_title: None,
        };
        assert!(!exclusion.matches(None, None, None));
        assert!(!exclusion.matches(Some("any"), Some("any"), Some("any")));
    }

    #[test]
    fn bundle_identifier_takes_priority() {
        let exclusion = WindowExclusion {
            bundle_identifier: Some("com.cap.desktop".to_string()),
            owner_name: None,
            window_title: Some("Cap Camera".to_string()),
        };
        assert!(exclusion.matches(Some("com.cap.desktop"), None, None));
        assert!(exclusion.matches(Some("com.cap.desktop"), None, Some("Wrong")));
    }

    #[test]
    fn instant_mode_removes_camera_exclusion() {
        let exclusions = vec![
            title_exclusion("Cap"),
            title_exclusion("Cap Camera"),
            title_exclusion("Cap Settings"),
            title_exclusion("Cap Recording Controls"),
        ];

        let filtered = filter_for_instant_mode(exclusions, "Cap Camera");

        assert_eq!(filtered.len(), 3);
        assert!(
            filtered
                .iter()
                .all(|e| e.window_title.as_deref() != Some("Cap Camera"))
        );
        assert!(
            filtered
                .iter()
                .any(|e| e.window_title.as_deref() == Some("Cap"))
        );
        assert!(
            filtered
                .iter()
                .any(|e| e.window_title.as_deref() == Some("Cap Settings"))
        );
        assert!(
            filtered
                .iter()
                .any(|e| e.window_title.as_deref() == Some("Cap Recording Controls"))
        );
    }

    #[test]
    fn instant_mode_noop_when_camera_absent() {
        let exclusions = vec![title_exclusion("Cap"), title_exclusion("Cap Settings")];

        let filtered = filter_for_instant_mode(exclusions, "Cap Camera");
        assert_eq!(filtered.len(), 2);
    }

    #[test]
    fn instant_mode_handles_empty_list() {
        let filtered = filter_for_instant_mode(vec![], "Cap Camera");
        assert!(filtered.is_empty());
    }

    #[test]
    fn default_exclusions_contain_camera() {
        let defaults = crate::general_settings::default_excluded_windows();
        assert!(
            defaults
                .iter()
                .any(|e| e.window_title.as_deref() == Some("Cap Camera")),
            "Default exclusions must include 'Cap Camera' — instant mode filtering depends on this"
        );
    }

    #[test]
    fn default_exclusions_only_match_camera_by_title() {
        let defaults = crate::general_settings::default_excluded_windows();
        let camera = defaults
            .iter()
            .find(|e| e.window_title.as_deref() == Some("Cap Camera"))
            .expect("Cap Camera must be in default exclusions");

        assert!(
            camera.bundle_identifier.is_none(),
            "Default camera exclusion should match by title only"
        );
        assert!(
            camera.owner_name.is_none(),
            "Default camera exclusion should match by title only"
        );
    }
}
