use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

use super::session::RepairPhase;

const REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const CONFIG_PATH: &str = "/api/desktop/repair/config";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepairConfig {
    pub enabled: bool,
    pub submissions: bool,
}

#[derive(Deserialize)]
struct WireConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    submissions: bool,
}

struct State {
    config: Option<RepairConfig>,
    fetched_at: Option<Instant>,
    in_flight: bool,
    pinned: bool,
}

static STATE: Mutex<State> = Mutex::new(State {
    config: None,
    fetched_at: None,
    in_flight: false,
    pinned: false,
});

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|poison| poison.into_inner())
}

pub fn parse_config(status: u16, body: &[u8]) -> Option<RepairConfig> {
    if status != 200 {
        return None;
    }
    let wire: WireConfig = serde_json::from_slice(body).ok()?;
    Some(RepairConfig {
        enabled: wire.enabled,
        submissions: wire.submissions,
    })
}

pub fn fix_offered(config: Option<RepairConfig>) -> bool {
    config.is_some_and(|config| config.enabled)
}

pub fn send_offered(phase: &RepairPhase, config: Option<RepairConfig>) -> bool {
    config.is_some_and(|config| config.submissions)
        && matches!(
            phase,
            RepairPhase::CantFix { .. }
                | RepairPhase::Failed { .. }
                | RepairPhase::SendFailed { .. }
        )
}

pub fn pin_for_preview(config: RepairConfig) {
    let mut state = state();
    state.config = Some(config);
    state.pinned = true;
}

pub fn current() -> Option<RepairConfig> {
    state().config
}

pub fn fix_enabled() -> bool {
    fix_offered(current())
}

async fn fetch(base: String) -> Option<RepairConfig> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .ok()?;
    let response = client
        .get(format!("{base}{CONFIG_PATH}"))
        .send()
        .await
        .ok()?;
    let status = response.status().as_u16();
    let body = response.bytes().await.ok()?;
    parse_config(status, &body)
}

pub fn refresh(cx: &mut gpui::App) {
    {
        let mut state = state();
        let fresh = state
            .fetched_at
            .is_some_and(|fetched| fetched.elapsed() < REFRESH_INTERVAL);
        if state.in_flight || fresh || state.pinned {
            return;
        }
        state.in_flight = true;
    }
    let task = gpui_tokio::Tokio::spawn(cx, fetch(crate::auth::server_url()));
    cx.spawn(async move |cx| {
        let config = task.await.ok().flatten();
        let changed = {
            let mut state = state();
            state.in_flight = false;
            if state.pinned {
                return;
            }
            state.fetched_at = Some(Instant::now());
            let changed = state.config != config;
            state.config = config;
            changed
        };
        if changed {
            cx.update(|cx| cx.refresh_windows());
        }
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_parses_and_ignores_unknown_fields() {
        assert_eq!(
            parse_config(
                200,
                br#"{"enabled":true,"submissions":false,"model":"x","limits":{"a":1}}"#
            ),
            Some(RepairConfig {
                enabled: true,
                submissions: false,
            })
        );
        assert_eq!(
            parse_config(200, br#"{}"#),
            Some(RepairConfig {
                enabled: false,
                submissions: false,
            })
        );
    }

    #[test]
    fn errors_and_missing_endpoints_hide_fix() {
        assert!(fix_offered(parse_config(200, br#"{"enabled":true}"#)));
        assert!(!fix_offered(parse_config(404, br#"{"enabled":true}"#)));
        assert!(!fix_offered(parse_config(503, b"")));
        assert!(!fix_offered(parse_config(200, b"<html>not json</html>")));
        assert!(!fix_offered(parse_config(200, br#"{"enabled":"yes"}"#)));
        assert!(!fix_offered(None));
        assert!(!fix_offered(parse_config(200, br#"{"enabled":false}"#)));
    }

    #[test]
    fn submissions_flag_controls_send_action() {
        let on = Some(RepairConfig {
            enabled: true,
            submissions: true,
        });
        let off = Some(RepairConfig {
            enabled: true,
            submissions: false,
        });
        let cant_fix = RepairPhase::CantFix {
            summary: "s".into(),
        };
        let failed = RepairPhase::Failed {
            message: "m".into(),
        };
        assert!(send_offered(&cant_fix, on));
        assert!(send_offered(&failed, on));
        assert!(!send_offered(&cant_fix, off));
        assert!(!send_offered(&failed, off));
        assert!(!send_offered(&cant_fix, None));
        assert!(!send_offered(&RepairPhase::Working, on));
        assert!(!send_offered(&RepairPhase::Sent, on));
    }
}
