#[path = "entitlement.rs"]
pub mod entitlement;
#[cfg(all(test, feature = "ux-walk"))]
#[path = "fork_catalog_tests.rs"]
pub mod fork_catalog_tests;
#[cfg(all(test, feature = "ux-walk"))]
#[path = "fork_identity_tests.rs"]
pub mod fork_identity_tests;
#[cfg(all(test, feature = "ux-walk"))]
#[path = "fork_link_tests.rs"]
pub mod fork_link_tests;
#[path = "fork_policy.rs"]
pub mod fork_policy;
#[path = "fork_titles.rs"]
pub mod fork_titles;
#[cfg(all(test, feature = "ux-walk"))]
#[path = "i18n_shipped.rs"]
pub mod i18n_shipped;
#[path = "mode_choice.rs"]
pub mod mode_choice;
#[path = "settings_sharing.rs"]
pub mod settings_sharing;
#[path = "settings_ux_walk.rs"]
pub mod settings_ux_walk;
#[path = "ux_walk.rs"]
pub mod ux_walk;
#[path = "ux_walk_browser.rs"]
pub mod ux_walk_browser;
#[path = "ux_walk_browser_target.rs"]
pub mod ux_walk_browser_target;
#[path = "ux_walk_checkpoints.rs"]
pub mod ux_walk_checkpoints;
#[path = "ux_walk_items.rs"]
pub mod ux_walk_items;
#[path = "ux_walk_journal.rs"]
pub mod ux_walk_journal;
#[path = "ux_walk_library.rs"]
pub mod ux_walk_library;
#[path = "ux_walk_preferences.rs"]
pub mod ux_walk_preferences;
#[path = "ux_walk_window.rs"]
pub mod ux_walk_window;
