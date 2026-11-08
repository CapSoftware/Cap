//! `CAP_GPUI_FAIL` switches on the recording crates' `cap_fail` failure
//! points, which only debug builds compile in, so their error paths can be
//! reached without patching code. It takes a comma-separated list of full
//! names, such as `cap-recording::ScreenCaptureSource::init`.

use std::collections::BTreeMap;

const ENV: &str = "CAP_GPUI_FAIL";

/// Call once at startup, after logging and before any recording can start.
pub fn configure() {
    let Some(spec) = std::env::var_os(ENV) else {
        return;
    };
    let spec = spec.to_string_lossy();
    let known = cap_fail::get_state();
    if known.is_empty() {
        tracing::warn!(%spec, "{ENV} is ignored: this build has no failure points");
        return;
    }

    let (enabled, unknown) = partition(&spec, &known);
    for name in enabled {
        cap_fail::set_fail(name, true);
        tracing::warn!(failure_point = name, "failure point enabled");
    }
    if !unknown.is_empty() {
        tracing::warn!(
            ?unknown,
            available = ?known.keys().collect::<Vec<_>>(),
            "{ENV} names failure points that don't exist"
        );
    }
}

fn partition<'a>(spec: &'a str, known: &BTreeMap<String, bool>) -> (Vec<&'a str>, Vec<&'a str>) {
    spec.split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .partition(|name| known.contains_key(*name))
}

#[cfg(test)]
mod tests {
    use super::partition;
    use std::collections::BTreeMap;

    fn known() -> BTreeMap<String, bool> {
        BTreeMap::from([
            (
                "cap-recording::ScreenCaptureSource::init".to_string(),
                false,
            ),
            (
                "cap-recording::screen_capture video frame skip".to_string(),
                false,
            ),
        ])
    }

    #[test]
    fn names_are_split_on_commas_and_trimmed() {
        let (enabled, unknown) = partition(
            " cap-recording::ScreenCaptureSource::init ,cap-recording::screen_capture video frame skip,,",
            &known(),
        );

        assert_eq!(
            enabled,
            [
                "cap-recording::ScreenCaptureSource::init",
                "cap-recording::screen_capture video frame skip",
            ]
        );
        assert!(unknown.is_empty());
    }

    #[test]
    fn a_name_without_its_crate_prefix_is_unknown() {
        let (enabled, unknown) = partition(
            "ScreenCaptureSource::init,cap-recording::ScreenCaptureSource::init",
            &known(),
        );

        assert_eq!(enabled, ["cap-recording::ScreenCaptureSource::init"]);
        assert_eq!(unknown, ["ScreenCaptureSource::init"]);
    }
}
