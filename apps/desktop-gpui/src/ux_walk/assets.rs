pub(crate) const ALL: &[(&str, &[u8])] = &[
    (
        "branding/app-icon.png",
        include_bytes!("../../assets/branding/app-icon.png"),
    ),
    (
        "icons/logo-full.svg",
        include_bytes!("../../assets/branding/logo-full.svg"),
    ),
    (
        "icons/logo-full-dark.svg",
        include_bytes!("../../assets/branding/logo-full-dark.svg"),
    ),
    (
        "icons/logo-mark.svg",
        include_bytes!("../../assets/branding/logo-mark.svg"),
    ),
];

#[cfg(test)]
mod tests {
    use gpui::AssetSource;

    use crate::assets::Assets;

    const SOURCES: &[&str] = &[
        include_str!("../mode_choice.rs"),
        include_str!("../ux_walk.rs"),
        include_str!("../ux_walk_window.rs"),
        include_str!("../ux_walk_browser.rs"),
        include_str!("../ux_walk_browser_target.rs"),
        include_str!("../ux_walk_checkpoints.rs"),
        include_str!("../ux_walk_journal.rs"),
        include_str!("../ux_walk_library.rs"),
        include_str!("../ux_walk_preferences.rs"),
        include_str!("../settings_ux_walk.rs"),
        include_str!("../onboarding_window.rs"),
        include_str!("../onboarding_window/ux_walk.rs"),
        include_str!("../main_window/ux_walk.rs"),
        include_str!("../settings_window/fork.rs"),
        include_str!("../settings_pages/fork.rs"),
        include_str!("../tray/ux_walk.rs"),
        include_str!("../library/ux_walk.rs"),
        include_str!("../session/ux_walk.rs"),
    ];

    fn referenced(prefix: &str) -> Vec<String> {
        let source = SOURCES.concat();
        let needle = format!("\"{prefix}");
        source
            .match_indices(&needle)
            .filter_map(|(start, _)| source[start + 1..].split('"').next())
            .filter(|path| path.ends_with(".svg") || path.ends_with(".png"))
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn fork_drawn_assets_resolve() {
        let paths = [referenced("icons/"), referenced("branding/")].concat();
        assert!(
            paths.iter().any(|path| path == "icons/ux-walk.svg"),
            "mode_choice.rs stopped naming icons/ux-walk.svg as a string literal"
        );
        let missing: Vec<&String> = paths
            .iter()
            .filter(|path| Assets.load(path).unwrap().is_none())
            .collect();
        assert!(
            missing.is_empty(),
            "assets drawn by fork code but not embedded: {missing:?}"
        );
    }

    #[test]
    fn every_fork_asset_is_drawn() {
        let source = SOURCES.concat();
        let unused: Vec<&str> = super::ALL
            .iter()
            .map(|(path, _)| *path)
            .filter(|path| !source.contains(&format!("\"{path}\"")))
            .collect();
        assert!(
            unused.is_empty(),
            "fork assets embedded but never drawn: {unused:?}"
        );
    }

    #[test]
    fn fork_assets_load_their_own_bytes() {
        for (path, bytes) in super::ALL {
            assert_eq!(Assets.load(path).unwrap().as_deref(), Some(*bytes));
        }
    }
}
