//! Google Calendar and Outlook sign-in rows, shared by the setup window's
//! calendar step and the Calendars section in Settings. Each surface draws
//! the rows in its own style; what a row says and does lives here.

use cap_calendar::SourceKind;
use gpui::App;

use super::shared;
use crate::{
    i18n::tr,
    meetings::{
        Meetings,
        accounts::{self, ConnectError, ConnectState, Provider},
    },
};

pub(crate) const PROVIDERS: [Provider; 2] = [Provider::Google, Provider::Microsoft];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Phase {
    Available,
    /// Another provider's sign-in is in progress.
    Blocked,
    Waiting,
    Finishing,
    Failed(ConnectError),
    Connected(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AccountRow {
    pub provider: Provider,
    pub phase: Phase,
}

pub(crate) fn slug(provider: Provider) -> &'static str {
    match provider {
        Provider::Google => "google",
        Provider::Microsoft => "microsoft",
    }
}

fn kind(provider: Provider) -> SourceKind {
    match provider {
        Provider::Google => SourceKind::Google,
        Provider::Microsoft => SourceKind::Microsoft,
    }
}

fn fake_phase(provider: Provider) -> Option<Phase> {
    let value = shared::fake(slug(provider))?;
    Some(match value.as_str() {
        "waiting" => Phase::Waiting,
        "finishing" => Phase::Finishing,
        "blocked" => Phase::Blocked,
        "failed" => Phase::Failed(ConnectError::Network),
        "denied" => Phase::Failed(ConnectError::Denied),
        "cancelled" => Phase::Failed(ConnectError::Cancelled),
        "connected" => Phase::Connected(match provider {
            Provider::Google => "work@example.com".into(),
            Provider::Microsoft => "team@example.org".into(),
        }),
        _ => Phase::Available,
    })
}

/// A provider is offered only when this build can sign in to it.
pub(crate) fn offered(provider: Provider) -> bool {
    accounts::configured(provider) || fake_phase(provider).is_some()
}

pub(crate) fn rows(cx: &App) -> Vec<AccountRow> {
    let Some(meetings) = Meetings::try_global(cx) else {
        return Vec::new();
    };
    let m = meetings.read(cx);
    let state = m.calendar_connect_state();
    PROVIDERS
        .into_iter()
        .filter(|provider| offered(*provider))
        .map(|provider| {
            let connected = m
                .calendar_sources()
                .iter()
                .find(|source| source.config.kind() == kind(provider))
                .map(|source| source.name.clone());
            let phase =
                fake_phase(provider).unwrap_or_else(|| phase_for(provider, state, connected));
            AccountRow { provider, phase }
        })
        .collect()
}

pub(crate) fn phase_for(
    provider: Provider,
    state: ConnectState,
    connected: Option<String>,
) -> Phase {
    match state {
        ConnectState::WaitingForBrowser(p) if p == provider => Phase::Waiting,
        ConnectState::Finishing(p) if p == provider => Phase::Finishing,
        ConnectState::Failed(p, error) if p == provider && connected.is_none() => {
            Phase::Failed(error)
        }
        _ if connected.is_some() => Phase::Connected(connected.unwrap_or_default()),
        _ if state.busy().is_some() => Phase::Blocked,
        _ => Phase::Available,
    }
}

pub(crate) fn connect(provider: Provider, cx: &mut App) {
    if let Some(meetings) = Meetings::try_global(cx) {
        meetings.update(cx, |m, cx| m.connect_calendar_account(provider, cx));
    }
}

pub(crate) fn cancel(cx: &mut App) {
    if let Some(meetings) = Meetings::try_global(cx) {
        meetings.update(cx, |m, cx| m.cancel_calendar_connect(cx));
    }
}

pub(crate) fn name(provider: Provider) -> &'static str {
    match provider {
        Provider::Google => tr::settings::meetings::accounts::google(),
        Provider::Microsoft => tr::settings::meetings::accounts::outlook(),
    }
}

pub(crate) fn icon(provider: Provider) -> &'static str {
    match provider {
        Provider::Google => "icons/google.svg",
        Provider::Microsoft => "icons/microsoft.svg",
    }
}

/// The line under the provider's name.
pub(crate) fn detail(row: &AccountRow) -> String {
    match &row.phase {
        Phase::Available | Phase::Blocked => match row.provider {
            Provider::Google => tr::settings::meetings::accounts::google_detail(),
            Provider::Microsoft => tr::settings::meetings::accounts::outlook_detail(),
        }
        .to_string(),
        Phase::Waiting => tr::settings::meetings::accounts::waiting().to_string(),
        Phase::Finishing => tr::settings::meetings::accounts::finishing().to_string(),
        Phase::Failed(error) => error_text(*error).to_string(),
        Phase::Connected(account) if account.trim().is_empty() => {
            tr::settings::meetings::accounts::connected().to_string()
        }
        Phase::Connected(account) => account.clone(),
    }
}

pub(crate) fn error_text(error: ConnectError) -> &'static str {
    match error {
        ConnectError::NotConfigured => tr::settings::meetings::accounts::error_not_configured(),
        ConnectError::Cancelled => tr::settings::meetings::accounts::error_cancelled(),
        ConnectError::Denied => tr::settings::meetings::accounts::error_denied(),
        ConnectError::Network => tr::settings::meetings::accounts::error_network(),
        ConnectError::Rejected => tr::settings::meetings::accounts::error_rejected(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Action {
    Connect,
    TryAgain,
    Cancel,
}

/// The one button a row offers, if any.
pub(crate) fn action(phase: &Phase) -> Option<Action> {
    match phase {
        Phase::Available | Phase::Blocked => Some(Action::Connect),
        Phase::Failed(_) => Some(Action::TryAgain),
        Phase::Waiting | Phase::Finishing => Some(Action::Cancel),
        Phase::Connected(_) => None,
    }
}

pub(crate) fn action_label(action: Action) -> &'static str {
    match action {
        Action::Connect => tr::settings::meetings::accounts::connect(),
        Action::TryAgain => tr::settings::meetings::accounts::try_again(),
        Action::Cancel => tr::settings::meetings::accounts::cancel(),
    }
}

pub(crate) fn run(action: Action, provider: Provider, cx: &mut App) {
    match action {
        Action::Connect | Action::TryAgain => connect(provider, cx),
        Action::Cancel => cancel(cx),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_connect_state_maps_to_one_phase_per_provider() {
        let google = Provider::Google;
        let microsoft = Provider::Microsoft;
        assert_eq!(
            phase_for(google, ConnectState::Idle, None),
            Phase::Available
        );
        assert_eq!(
            phase_for(google, ConnectState::WaitingForBrowser(google), None),
            Phase::Waiting
        );
        assert_eq!(
            phase_for(microsoft, ConnectState::WaitingForBrowser(google), None),
            Phase::Blocked,
            "one sign-in at a time"
        );
        assert_eq!(
            phase_for(google, ConnectState::Finishing(google), None),
            Phase::Finishing
        );
        assert_eq!(
            phase_for(
                google,
                ConnectState::Failed(google, ConnectError::Denied),
                None
            ),
            Phase::Failed(ConnectError::Denied)
        );
        assert_eq!(
            phase_for(
                microsoft,
                ConnectState::Failed(google, ConnectError::Denied),
                None
            ),
            Phase::Available
        );
        assert_eq!(
            phase_for(google, ConnectState::Idle, Some("a@b.c".into())),
            Phase::Connected("a@b.c".into())
        );
        assert_eq!(action(&Phase::Waiting), Some(Action::Cancel));
        assert_eq!(
            action(&Phase::Failed(ConnectError::Network)),
            Some(Action::TryAgain)
        );
        assert_eq!(action(&Phase::Connected(String::new())), None);
    }
}
