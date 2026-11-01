pub(crate) const PLAN_UNLOCKED: bool = cfg!(feature = "ux-walk");

pub(crate) const fn account_optional(ux_walk: bool, test: bool) -> bool {
    ux_walk && !test
}

// Off under cfg(test) so upstream's store test, which expects set_auth(None)
// to leave signed_in() false, keeps passing unchanged.
pub(crate) const NO_ACCOUNT_NEEDED: bool = account_optional(cfg!(feature = "ux-walk"), cfg!(test));

#[cfg(all(test, feature = "ux-walk"))]
mod tests {
    use super::*;
    use crate::{mode_choice::ModeChoice, settings_window::Page, store::AuthSnapshot};

    const PAYWALL_WORDS: &[&str] = &[
        "cap pro",
        "pro plan",
        "upgrade",
        "pricing",
        "free plan",
        "license key",
        "sign in",
    ];

    const PAYWALL_SITES: &[&str] = &[
        "PRICING_URL",
        ".is_upgraded()",
        ".signed_in()",
        ".plan_upgraded",
        "Page::License",
        "UpgradeRequired",
        "upgrade_required",
        "render_plan_badge",
        "tr::settings::license::",
        "tr::onboarding::faq::pricing",
        "SignInOrigin::",
    ];

    const PAYWALL_INVENTORY: &[(&str, &str, usize)] = &[
        ("auth.rs", ".signed_in()", 1),
        ("auth.rs", "PRICING_URL", 1),
        ("auth.rs", "UpgradeRequired", 2),
        ("editor_export.rs", ".is_upgraded()", 1),
        ("editor_export.rs", ".signed_in()", 2),
        ("editor_export.rs", "PRICING_URL", 2),
        ("editor_export.rs", "SignInOrigin::", 2),
        ("editor_export.rs", "UpgradeRequired", 1),
        ("fork_link_tests.rs", "PRICING_URL", 1),
        ("i18n/dialogs_surface_tests.rs", "upgrade_required", 1),
        (
            "i18n/settings_surface_tests.rs",
            "tr::settings::license::",
            27,
        ),
        ("i18n/surface_tests.rs", "tr::onboarding::faq::pricing", 2),
        ("main_window.rs", ".is_upgraded()", 1),
        ("main_window.rs", ".signed_in()", 1),
        ("main_window.rs", "PRICING_URL", 1),
        ("main_window.rs", "SignInOrigin::", 4),
        ("main_window.rs", "render_plan_badge", 2),
        ("onboarding_window.rs", "PRICING_URL", 2),
        ("onboarding_window.rs", "tr::onboarding::faq::pricing", 2),
        ("recording.rs", ".is_upgraded()", 1),
        ("recording.rs", ".signed_in()", 1),
        ("screenshot_editor.rs", "SignInOrigin::", 1),
        ("screenshot_editor.rs", "UpgradeRequired", 1),
        ("screenshot_editor.rs", "upgrade_required", 1),
        ("settings_pages.rs", ".is_upgraded()", 1),
        ("settings_pages.rs", ".plan_upgraded", 2),
        ("settings_pages.rs", ".signed_in()", 4),
        ("settings_pages.rs", "PRICING_URL", 3),
        ("settings_pages.rs", "Page::License", 1),
        ("settings_pages.rs", "tr::settings::license::", 27),
        ("settings_window.rs", ".is_upgraded()", 7),
        ("settings_window.rs", ".signed_in()", 5),
        ("settings_window.rs", "PRICING_URL", 1),
        ("settings_window.rs", "Page::License", 2),
        ("settings_window.rs", "SignInOrigin::", 1),
        ("sign_in.rs", "SignInOrigin::", 1),
        ("store.rs", ".is_upgraded()", 1),
        ("store.rs", ".plan_upgraded", 1),
        ("store.rs", ".signed_in()", 3),
        ("target_overlay.rs", ".signed_in()", 3),
        ("upload.rs", ".is_upgraded()", 2),
        ("upload.rs", ".signed_in()", 2),
        ("upload.rs", "UpgradeRequired", 16),
        ("upload.rs", "upgrade_required", 1),
        ("upload/queue.rs", "UpgradeRequired", 1),
    ];

    #[test]
    fn plan_gates_are_open() {
        let auth = AuthSnapshot {
            token: None,
            plan_upgraded: false,
            plan_manual: false,
            organizations: vec![],
        };
        assert!(auth.is_upgraded());
        assert!(auth.token.is_none());
        assert!(account_optional(true, false));
        assert!(!account_optional(false, false));
        assert!(!account_optional(true, true));
    }

    #[test]
    fn license_page_is_unreachable() {
        assert!(!Page::ALL.contains(&Page::License));
        assert!(Page::from_slug("license").is_none());
        assert!(Page::ALL.contains(&Page::Sharing));
    }

    fn menu_labels(items: &[gpui::MenuItem], labels: &mut Vec<String>) {
        for item in items {
            match item {
                gpui::MenuItem::Separator => {}
                gpui::MenuItem::Action { name, .. } => labels.push(name.to_string()),
                gpui::MenuItem::Submenu(menu) => {
                    labels.push(menu.name.to_string());
                    menu_labels(&menu.items, labels);
                }
                gpui::MenuItem::SystemMenu(menu) => labels.push(menu.name.to_string()),
            }
        }
    }

    #[test]
    fn fork_copy_has_no_paywall_words() {
        let mut copy: Vec<String> = Vec::new();
        for &choice in ModeChoice::ALL {
            copy.push(choice.title().into());
            copy.push(choice.card_description().into());
            copy.push(choice.hover_description().into());
            copy.push(choice.panel_description().into());
            let detail = crate::onboarding_window::mode_detail(choice);
            copy.push((detail.title)().into());
            copy.push((detail.tagline)().into());
            copy.extend(detail.features.iter().map(|feature| feature().to_string()));
        }
        for menu in crate::menus::build_menus(&crate::updates::UpdateStatus::Idle, true) {
            copy.push(menu.name.to_string());
            menu_labels(&menu.items, &mut copy);
        }
        for text in &copy {
            let lower = text.to_lowercase();
            for word in PAYWALL_WORDS {
                assert!(!lower.contains(word), "{text:?} mentions {word:?}");
            }
        }
    }

    fn collect_sources(dir: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                collect_sources(&path, files);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                files.push(path);
            }
        }
    }

    #[test]
    fn paywall_site_inventory() {
        let root = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
        let mut files = Vec::new();
        collect_sources(root, &mut files);
        let mut found = Vec::new();
        for path in files {
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if relative == "entitlement.rs" {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            for site in PAYWALL_SITES {
                let count = source.matches(site).count();
                if count > 0 {
                    found.push((relative.clone(), *site, count));
                }
            }
        }
        found.sort();
        let expected: Vec<_> = PAYWALL_INVENTORY
            .iter()
            .map(|(file, site, count)| (file.to_string(), *site, *count))
            .collect();
        let table: String = found
            .iter()
            .map(|(file, site, count)| format!("        ({file:?}, {site:?}, {count}),\n"))
            .collect();
        assert_eq!(
            found, expected,
            "Paywall call sites changed. A new upstream plan, pricing or sign-in gate must go \
             through crate::entitlement or be hidden in this fork; then update PAYWALL_INVENTORY:\n{table}"
        );
    }
}
