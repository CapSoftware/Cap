use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, PoisonError};

pub const APP_NAME: &str = env!("FORK_BRAND_APP_NAME");
pub const UPSTREAM_NAME: &str = env!("FORK_BRAND_UPSTREAM_NAME");
pub const SLUG: &str = env!("FORK_BRAND_SLUG");
pub const CLI_NAME: &str = env!("FORK_BRAND_CLI_NAME");
pub const SKILL_NAME: &str = env!("FORK_BRAND_SKILL_NAME");
pub const BUNDLE_ID: &str = env!("FORK_BRAND_BUNDLE_ID");
pub const CLI_KEYRING_SERVICE: &str = concat!(env!("FORK_BRAND_BUNDLE_ID"), ".cli");
pub const DEV_BUNDLE_ID: &str = concat!(env!("FORK_BRAND_BUNDLE_ID"), ".dev");
pub const URL_SCHEME: &str = env!("FORK_BRAND_URL_SCHEME");
pub const REPO_URL: &str = env!("FORK_BRAND_REPO_URL");
pub const RELEASES_URL: &str = env!("FORK_BRAND_RELEASES_URL");
pub const ISSUES_URL: &str = env!("FORK_BRAND_ISSUES_URL");
pub const CHANGES_URL: &str = env!("FORK_BRAND_CHANGES_URL");
pub const HELP_URL: &str = env!("FORK_BRAND_HELP_URL");
pub const DOCS_URL: &str = env!("FORK_BRAND_DOCS_URL");
pub const FEEDBACK_URL: &str = env!("FORK_BRAND_FEEDBACK_URL");
/// `None` when the fork has no status page; its menu item is hidden.
pub const STATUS_URL: Option<&str> = non_empty(env!("FORK_BRAND_STATUS_URL"));
/// `None` when the fork has no community chat; its menu item is hidden.
pub const COMMUNITY_URL: Option<&str> = non_empty(env!("FORK_BRAND_COMMUNITY_URL"));
pub const DEFAULT_SERVER_URL: &str = env!("FORK_BRAND_DEFAULT_SERVER_URL");
pub const LONG_DESCRIPTION: &str = env!("FORK_BRAND_LONG_DESCRIPTION");
pub const AGENT_SKILL: &str = include_str!(concat!(env!("OUT_DIR"), "/SKILL.md"));
pub const CLI_HELP: &str = include_str!(concat!(env!("OUT_DIR"), "/cli-help.txt"));

/// Hosts of upstream's own site, help center, status page and short links.
/// A fork build must not send people to any of them.
pub const UPSTREAM_SERVICE_HOSTS: &[&str] = &["cap.so", "cap.link", "cap.openstatus.dev"];

const fn non_empty(value: &'static str) -> Option<&'static str> {
    if value.is_empty() { None } else { Some(value) }
}

/// The first [`UPSTREAM_SERVICE_HOSTS`] entry `text` names, as a host or
/// subdomain (`help.cap.so`), in a URL, bare (`cap.link/discord`) or in an
/// address (`hello@cap.so`). Longer names that only contain one (`recap.so`,
/// `cap.social`) do not count.
pub fn upstream_service_host(text: &str) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    UPSTREAM_SERVICE_HOSTS.iter().copied().find(|host| {
        lower.match_indices(host).any(|(index, _)| {
            let before = lower[..index].chars().next_back();
            let mut after = lower[index + host.len()..].chars();
            let joined_before = before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '-');
            let joined_after = match after.next() {
                Some(c) if c.is_ascii_alphanumeric() || c == '-' => true,
                Some('.') => after.next().is_some_and(|c| c.is_ascii_alphanumeric()),
                _ => false,
            };
            !joined_before && !joined_after
        })
    })
}

/// Catalog keys whose "Cap" names upstream's product, service or `.cap`
/// file format rather than this app, so the build-time catalog pass leaves
/// them alone.
pub const KEEP_UPSTREAM_NAME: &[&str] = &[
    "editor.clips.cap_filter",
    "editor.clips.error.not_a_project",
    "editor.clips.error.source_empty",
    "editor.clips.error.source_failed",
    "editor.clips.error.source_recording",
    "editor.clips.error.source_unimportable",
    "editor.export.done.uploaded",
    "editor.panel.text_preset.sample.title",
    "settings.license.description",
];

/// Names this app shipped under before [`APP_NAME`].
pub fn former_names() -> impl Iterator<Item = &'static str> {
    env!("FORK_BRAND_FORMER_NAMES")
        .split('|')
        .filter(|name| !name.is_empty())
}

/// Whether `saved` is `current` as an earlier release spelled it, under
/// upstream's name or a former fork name. Saved window rules need this: a rule
/// keeps matching one of our windows only if its title follows the rename.
pub fn is_former_title(saved: &str, current: &str) -> bool {
    std::iter::once(UPSTREAM_NAME)
        .chain(former_names())
        .any(|name| current.replace(APP_NAME, name) == saved)
}

/// [`text`], plus each standalone `cap` command spelled as [`CLI_NAME`]. Paths
/// and sibling names (`.cap`, `cap-cli`, `foo.cap`) keep their spelling.
pub fn cli_text(source: &str) -> String {
    const COMMAND: &str = "cap";
    let joined = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/');
    let mut out = String::with_capacity(source.len() + CLI_NAME.len());
    let mut rest = source;
    while let Some(index) = rest.find(COMMAND) {
        let (head, tail) = rest.split_at(index);
        let after = &tail[COMMAND.len()..];
        let joined_before = head.chars().next_back().is_some_and(joined);
        let joined_after = after.chars().next().is_some_and(joined);
        out.push_str(head);
        out.push_str(if joined_before || joined_after {
            COMMAND
        } else {
            CLI_NAME
        });
        rest = after;
    }
    out.push_str(rest);
    text(&out)
}

/// [`cli_text`] for `&'static str`.
pub fn cli_text_static(source: &'static str) -> &'static str {
    static CACHE: LazyLock<Mutex<HashMap<&'static str, &'static str>>> =
        LazyLock::new(Default::default);
    let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
    cache
        .entry(source)
        .or_insert_with(|| Box::leak(cli_text(source).into_boxed_str()))
}

/// Swaps each standalone [`UPSTREAM_NAME`] for [`APP_NAME`]. Words that only
/// start with it ("Caps", "Capture"), domains ("Cap.so") and text that
/// already carries [`APP_NAME`] are left as they are.
pub fn text(text: &str) -> String {
    if APP_NAME == UPSTREAM_NAME || UPSTREAM_NAME.is_empty() {
        return text.to_string();
    }
    let suffix = APP_NAME
        .strip_prefix(UPSTREAM_NAME)
        .filter(|s| !s.is_empty());
    let mut out = String::with_capacity(text.len() + APP_NAME.len());
    let mut rest = text;
    while let Some(index) = rest.find(UPSTREAM_NAME) {
        let (head, tail) = rest.split_at(index);
        let after = &tail[UPSTREAM_NAME.len()..];
        let mut next = after.chars();
        let joined_before = head
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric());
        let joined_after = match next.next() {
            Some(c) if c.is_ascii_alphanumeric() => true,
            Some('.') => next.next().is_some_and(|c| c.is_ascii_alphanumeric()),
            _ => false,
        };
        let branded = suffix.is_some_and(|suffix| after.starts_with(suffix));
        out.push_str(head);
        out.push_str(if joined_before || joined_after || branded {
            UPSTREAM_NAME
        } else {
            APP_NAME
        });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// [`text`] for `&'static str`; each distinct input is rebranded once and
/// kept for the life of the process.
pub fn text_static(source: &'static str) -> &'static str {
    static CACHE: LazyLock<Mutex<HashMap<&'static str, &'static str>>> =
        LazyLock::new(Default::default);
    if !source.contains(UPSTREAM_NAME) {
        return source;
    }
    let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
    cache
        .entry(source)
        .or_insert_with(|| Box::leak(text(source).into_boxed_str()))
}

pub fn update_refusal() -> String {
    format!(
        "This {APP_NAME} build uses releases from {RELEASES_URL}; official {UPSTREAM_NAME} updates would replace it."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brand(source: &str) -> String {
        source.replace("{app}", APP_NAME)
    }

    #[test]
    fn standalone_names_are_branded() {
        assert_eq!(text("About Cap"), brand("About {app}"));
        assert_eq!(text("Cap v0.1.0"), brand("{app} v0.1.0"));
        assert_eq!(text("Cap's cloud"), brand("{app}'s cloud"));
        assert_eq!(text("Quit Cap."), brand("Quit {app}."));
        assert_eq!(text("CapはCaps"), brand("{app}はCaps"));
    }

    #[test]
    fn words_domains_and_branded_text_are_kept() {
        for kept in ["Caps", "Capture", "MyCap", "Cap.so/download", "recap"] {
            assert_eq!(text(kept), kept);
        }
        assert_eq!(text(APP_NAME), APP_NAME);
        assert_eq!(text(&text("Hide Cap")), text("Hide Cap"));
    }

    #[test]
    fn static_text_is_cached() {
        let first = text_static("Quit Cap");
        assert_eq!(first, text("Quit Cap"));
        assert!(std::ptr::eq(first, text_static("Quit Cap")));
        assert!(std::ptr::eq(text_static("Settings"), "Settings"));
    }

    #[test]
    fn update_refusal_points_at_fork_releases() {
        assert!(update_refusal().contains(RELEASES_URL));
        assert!(update_refusal().contains(APP_NAME));
    }

    #[test]
    fn upstream_service_hosts_are_found_in_links_and_text() {
        for (text, host) in [
            ("https://cap.so/docs", "cap.so"),
            ("https://help.cap.so/", "cap.so"),
            ("email hello@cap.so today", "cap.so"),
            ("join us at cap.link/discord.", "cap.link"),
            ("https://cap.openstatus.dev/", "cap.openstatus.dev"),
            ("Opens CAP.SO/pricing", "cap.so"),
        ] {
            assert_eq!(upstream_service_host(text), Some(host), "{text}");
        }
        for text in [
            "recap.so",
            "cap.social",
            "my-cap.so",
            "https://openstatus.dev/",
            "Cap.app/Contents",
            "",
        ] {
            assert_eq!(upstream_service_host(text), None, "{text}");
        }
    }

    #[test]
    fn fork_destinations_stay_off_upstream_services() {
        let destinations = [
            REPO_URL,
            RELEASES_URL,
            ISSUES_URL,
            CHANGES_URL,
            HELP_URL,
            DOCS_URL,
            FEEDBACK_URL,
            DEFAULT_SERVER_URL,
        ]
        .into_iter()
        .chain(STATUS_URL)
        .chain(COMMUNITY_URL);
        for url in destinations {
            assert_eq!(upstream_service_host(url), None, "{url}");
        }
        for url in [HELP_URL, DOCS_URL, FEEDBACK_URL] {
            assert!(url.starts_with("https://"), "{url}");
        }
    }

    #[test]
    fn saved_titles_follow_every_earlier_name() {
        let current = format!("{APP_NAME} Settings");
        assert!(is_former_title("Cap Settings", &current));
        for former in former_names() {
            assert_ne!(former, APP_NAME);
            assert!(is_former_title(&format!("{former} Settings"), &current));
        }
        assert!(!is_former_title("Finder", &current));
    }

    #[test]
    fn cli_text_swaps_the_command_and_keeps_paths() {
        assert_eq!(
            cli_text("Run `cap upload` with cap-cli on foo.cap in ~/.cap/bin"),
            format!("Run `{CLI_NAME} upload` with cap-cli on foo.cap in ~/.cap/bin")
        );
        assert_eq!(
            cli_text("Update Cap Desktop"),
            brand("Update {app} Desktop")
        );
    }

    #[test]
    fn templates_are_filled_from_the_brand() {
        for template in [AGENT_SKILL, CLI_HELP] {
            assert!(!template.contains("%app%"), "unfilled token");
            assert!(!template.contains("%cli%"), "unfilled token");
        }
        assert!(AGENT_SKILL.starts_with(&format!("---\nname: {SKILL_NAME}\n")));
        assert!(CLI_HELP.contains(CLI_NAME));
    }

    #[test]
    fn derived_ids_follow_the_bundle_id() {
        assert_eq!(CLI_KEYRING_SERVICE, format!("{BUNDLE_ID}.cli"));
        assert_eq!(DEV_BUNDLE_ID, format!("{BUNDLE_ID}.dev"));
    }
}
