use crate::store::DEFAULT_EXCLUDED_WINDOW_TITLES;

/// Upstream's tests pin these titles, so the test build keeps them, as it
/// keeps the unbranded catalog. `fork_identity_tests` checks what ships.
pub fn window_title(upstream: &'static str) -> &'static str {
    if cfg!(test) {
        upstream
    } else {
        fork_brand::text_static(upstream)
    }
}

/// The current title of a saved window rule written by an earlier release.
pub fn current_title(saved: &str) -> Option<&'static str> {
    current_title_among(saved, window_title)
}

pub(crate) fn current_title_among(
    saved: &str,
    shipped: impl Fn(&'static str) -> &'static str,
) -> Option<&'static str> {
    DEFAULT_EXCLUDED_WINDOW_TITLES
        .iter()
        .map(|title| shipped(title))
        .find(|current| fork_brand::is_former_title(saved, current))
}
