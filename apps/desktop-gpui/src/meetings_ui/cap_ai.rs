pub mod flow;
pub mod pitch;

use std::time::Instant;

use gpui::{App, AppContext as _, Context, Entity, EventEmitter, Global, Subscription, Task};
use serde_json::{Value, json};

use crate::meetings::{AiAccess, Meetings};
use flow::{Effect, Flow, Input, Phase};
use pitch::Pitch;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
    Documents,
    Window,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CapAiEvent {
    Changed,
    Upgraded {
        doc_id: Option<String>,
        question: Option<String>,
    },
}

enum Checkout {
    Url(String),
    AlreadyPro,
}

pub struct CapAi {
    flow: Flow,
    host: Host,
    doc_id: Option<String>,
    pitch: Option<Pitch>,
    question: Option<(String, String)>,
    checkout_url: Option<String>,
    shown_at: Instant,
    timer: Option<Task<()>>,
    request: Option<Task<()>>,
    plan_check: Option<Task<()>>,
    _sign_in: Option<Subscription>,
}

impl EventEmitter<CapAiEvent> for CapAi {}

struct CapAiGlobal(Entity<CapAi>);

impl Global for CapAiGlobal {}

pub fn init(cx: &mut App) {
    let entity = cx.new(|cx: &mut Context<CapAi>| {
        let mut this = CapAi::new();
        let sign_in = crate::sign_in::SignIn::global(cx);
        this._sign_in = Some(cx.subscribe(&sign_in, |this, _, event, cx| {
            use crate::sign_in::{SignInEvent, SignInOutcome};
            match event {
                SignInEvent::AccountRefreshed => {
                    if let Some(meetings) = Meetings::try_global(cx) {
                        meetings.update(cx, |m, cx| m.refresh_capabilities(cx));
                    }
                    let pro = crate::store::auth_snapshot().is_upgraded();
                    this.input(Input::SignedIn { pro }, cx);
                }
                SignInEvent::Finished { outcome, .. } if *outcome != SignInOutcome::SignedIn => {
                    this.input(Input::SignInStopped, cx)
                }
                SignInEvent::Finished { .. } => {}
            }
        }));
        this
    });
    cx.set_global(CapAiGlobal(entity));
}

impl CapAi {
    pub fn new() -> Self {
        Self {
            flow: Flow::default(),
            host: Host::Documents,
            doc_id: None,
            pitch: None,
            question: None,
            checkout_url: None,
            shown_at: Instant::now(),
            timer: None,
            request: None,
            plan_check: None,
            _sign_in: None,
        }
    }

    pub fn global(cx: &App) -> Option<Entity<Self>> {
        cx.try_global::<CapAiGlobal>().map(|g| g.0.clone())
    }

    pub fn phase(&self) -> Phase {
        self.flow.phase
    }

    pub fn is_open_in(&self, host: Host) -> bool {
        self.flow.is_open() && self.host == host
    }

    pub fn doc_id(&self) -> Option<&str> {
        self.doc_id.as_deref()
    }

    pub fn pitch(&self) -> Option<&Pitch> {
        self.pitch.as_ref()
    }

    pub fn shown_at(&self) -> Instant {
        self.shown_at
    }

    #[cfg(test)]
    pub fn has_timer(&self) -> bool {
        self.timer.is_some()
    }

    pub fn open(
        &mut self,
        doc_id: Option<String>,
        pitch: Option<Pitch>,
        host: Host,
        cx: &mut Context<Self>,
    ) {
        if self.flow.is_open() {
            return;
        }
        self.host = host;
        self.doc_id = doc_id;
        self.pitch = pitch;
        self.checkout_url = None;
        let auth = crate::store::auth_snapshot();
        self.input(
            Input::Open {
                signed_in: auth.signed_in(),
                pro: auth.is_upgraded(),
            },
            cx,
        );
        if host == Host::Window && self.flow.is_open() {
            cx.defer(crate::meetings_ui::documents::open_upgrade_window);
        }
    }

    pub fn remember_question(&mut self, doc_id: String, question: String) {
        self.question = Some((doc_id, question));
    }

    pub fn proceed(&mut self, cx: &mut Context<Self>) {
        let signed_in = crate::store::auth_snapshot().signed_in();
        self.input(Input::Continue { signed_in }, cx);
    }

    pub fn reopen_checkout(&mut self, cx: &mut Context<Self>) {
        let url = self
            .checkout_url
            .clone()
            .unwrap_or_else(|| crate::auth::PRICING_URL.to_string());
        cx.open_url(&url);
    }

    pub fn activated(&mut self, cx: &mut Context<Self>) {
        if self.flow.phase == Phase::Waiting {
            self.input(Input::Activated, cx);
        }
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        self.input(Input::Close, cx);
    }

    pub fn input(&mut self, input: Input, cx: &mut Context<Self>) {
        let before = self.flow.phase;
        let effects = self.flow.step(input);
        if self.flow.phase != before {
            self.shown_at = Instant::now();
            tracing::info!(?before, after = ?self.flow.phase, "cap ai upgrade");
        }
        for effect in effects {
            self.apply(effect, cx);
        }
        if !self.flow.is_open() {
            self.request = None;
            self.plan_check = None;
            self.timer = None;
        }
        cx.emit(CapAiEvent::Changed);
        cx.notify();
    }

    fn apply(&mut self, effect: Effect, cx: &mut Context<Self>) {
        match effect {
            Effect::StartSignIn => {
                let sign_in = crate::sign_in::SignIn::global(cx);
                sign_in.update(cx, |s, cx| {
                    s.start(crate::sign_in::SignInOrigin::Settings, cx)
                });
            }
            Effect::StartCheckout => self.start_checkout(cx),
            Effect::CheckPlan => self.check_plan(cx),
            Effect::Wait(delay) => {
                self.timer = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(delay).await;
                    this.update(cx, |this, cx| {
                        this.timer = None;
                        this.input(Input::Tick, cx);
                    })
                    .ok();
                }));
            }
            Effect::StopTimers => {
                self.timer = None;
                self.plan_check = None;
            }
            Effect::Upgraded => self.upgraded(cx),
            Effect::CloseAfter(delay) => {
                self.timer = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(delay).await;
                    this.update(cx, |this, cx| {
                        this.timer = None;
                        this.input(Input::WelcomeDone, cx);
                    })
                    .ok();
                }));
            }
        }
    }

    fn start_checkout(&mut self, cx: &mut Context<Self>) {
        self.request = Some(cx.spawn(async move |this, cx| {
            let result = gpui_tokio::Tokio::spawn(cx, request_checkout()).await;
            let result = result.unwrap_or_else(|error| Err(error.to_string()));
            this.update(cx, |this, cx| {
                this.request = None;
                match result {
                    Ok(Checkout::Url(url)) => {
                        cx.open_url(&url);
                        this.checkout_url = Some(url);
                        this.input(Input::CheckoutOpened, cx);
                    }
                    Ok(Checkout::AlreadyPro) => this.input(Input::AlreadyPro, cx),
                    Err(error) => {
                        tracing::warn!(%error, "checkout request failed, opening the pricing page");
                        cx.open_url(crate::auth::PRICING_URL);
                        this.input(Input::CheckoutOpened, cx);
                    }
                }
            })
            .ok();
        }));
    }

    fn check_plan(&mut self, cx: &mut Context<Self>) {
        if self.plan_check.is_some() {
            return;
        }
        self.plan_check = Some(cx.spawn(async move |this, cx| {
            let result = gpui_tokio::Tokio::spawn(cx, crate::auth::update_auth_plan()).await;
            if let Ok(Err(error)) = &result {
                tracing::info!(%error, "plan check after checkout");
            }
            this.update(cx, |this, cx| {
                this.plan_check = None;
                let pro = crate::store::auth_snapshot().is_upgraded();
                this.input(Input::PlanChecked { pro }, cx);
            })
            .ok();
        }));
    }

    fn upgraded(&mut self, cx: &mut Context<Self>) {
        let doc_id = self.doc_id.clone();
        let question = self
            .question
            .take()
            .filter(|(doc, _)| Some(doc) == doc_id.as_ref())
            .map(|(_, q)| q);
        if let Some(meetings) = Meetings::try_global(cx) {
            let doc = doc_id.clone();
            meetings.update(cx, |m, cx| {
                m.refresh_capabilities(cx);
                if let Some(doc) = doc {
                    m.write_notes_now(&doc, cx);
                }
            });
        }
        cx.emit(CapAiEvent::Upgraded { doc_id, question });
    }

    #[cfg(debug_assertions)]
    pub fn debug_show(&mut self, phase: &str, cx: &mut Context<Self>) {
        let target = match phase {
            "signin" => Phase::SigningIn,
            "starting" => Phase::Starting,
            "waiting" => Phase::Waiting,
            "welcome" => Phase::Welcome,
            _ => Phase::Pitch,
        };
        self.flow = flow::debug_flow(target);
        self.shown_at = Instant::now();
        cx.emit(CapAiEvent::Changed);
        cx.notify();
    }
}

#[cfg(debug_assertions)]
pub fn run_from_env(cx: &mut App) {
    let Some(phase) = std::env::var("CAP_GPUI_AI_SHEET")
        .ok()
        .filter(|v| !v.trim().is_empty())
    else {
        return;
    };
    cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(std::time::Duration::from_secs(2))
            .await;
        cx.update(|cx| {
            open_upgrade(None, Host::Window, cx);
            if let Some(cap_ai) = CapAi::global(cx) {
                cap_ai.update(cx, |c, cx| c.debug_show(&phase, cx));
            }
        });
    })
    .detach();
}

impl Default for CapAi {
    fn default() -> Self {
        Self::new()
    }
}

// The server picks the plan, so it can change without an app release.
async fn request_checkout() -> Result<Checkout, String> {
    let response = crate::auth::authed_request(
        reqwest::Method::POST,
        "/api/desktop/subscribe",
        Some(json!({})),
    )
    .await
    .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    parse_checkout(status, &body)
}

fn parse_checkout(status: u16, body: &Value) -> Result<Checkout, String> {
    if body.get("subscription").and_then(Value::as_bool) == Some(true) {
        return Ok(Checkout::AlreadyPro);
    }
    match body.get("url").and_then(Value::as_str) {
        Some(url) if status == 200 && url.starts_with("https://") => Ok(Checkout::Url(url.into())),
        _ => Err(format!("checkout returned {status}")),
    }
}

pub fn open_upgrade(doc_id: Option<String>, host: Host, cx: &mut App) {
    let Some(cap_ai) = CapAi::global(cx) else {
        return;
    };
    let pitch = doc_id.as_deref().and_then(|id| pitch::for_doc(id, cx));
    cap_ai.update(cx, |c, cx| c.open(doc_id, pitch, host, cx));
}

/// One line on what Cap AI does for this person, and the action that
/// unlocks it (`true` when that action is sign in).
pub fn status_line(
    access: AiAccess,
    trial: Option<u32>,
) -> (String, Option<(&'static str, bool)>) {
    use crate::i18n::tr;
    match access {
        AiAccess::Ready => (tr::cap_ai::settings::ready().into(), None),
        AiAccess::Trial { remaining } => (
            tr::cap_ai::settings::trial(remaining as usize),
            Some((tr::cap_ai::settings::get_pro(), false)),
        ),
        AiAccess::NeedsUpgrade if trial == Some(0) => (
            tr::cap_ai::settings::spent().into(),
            Some((tr::cap_ai::settings::get_pro(), false)),
        ),
        AiAccess::NeedsUpgrade => (
            tr::cap_ai::settings::upgrade().into(),
            Some((tr::cap_ai::settings::get_pro(), false)),
        ),
        AiAccess::NeedsSignIn => (
            tr::cap_ai::settings::signed_out().into(),
            Some((tr::cap_ai::settings::sign_in(), true)),
        ),
        AiAccess::Unavailable => (tr::cap_ai::settings::unavailable().into(), None),
    }
}

pub fn ensure_access(cx: &mut App) {
    if let Some(meetings) = Meetings::try_global(cx) {
        meetings.update(cx, |m, cx| m.ensure_access(cx));
    }
}

pub fn sign_in(cx: &mut App) {
    let sign_in = crate::sign_in::SignIn::global(cx);
    sign_in.update(cx, |s, cx| {
        s.start(crate::sign_in::SignInOrigin::Settings, cx)
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The server sets how many meetings are free, so the signed-out line
    /// names no number of its own.
    #[test]
    fn the_signed_out_line_claims_no_count() {
        let (line, action) = status_line(AiAccess::NeedsSignIn, None);
        assert!(!line.chars().any(|c| c.is_ascii_digit()), "{line}");
        assert_eq!(
            line,
            "Sign in and Cap AI writes up your first meetings free."
        );
        assert_eq!(action.map(|(_, sign_in)| sign_in), Some(true));
    }

    #[test]
    fn checkout_replies_are_read_safely() {
        assert!(matches!(
            parse_checkout(200, &json!({ "url": "https://checkout.example.com/x" })),
            Ok(Checkout::Url(_))
        ));
        assert!(matches!(
            parse_checkout(400, &json!({ "error": true, "subscription": true })),
            Ok(Checkout::AlreadyPro)
        ));
        assert!(parse_checkout(503, &json!({ "code": "billing_unavailable" })).is_err());
        assert!(parse_checkout(200, &json!({ "url": "javascript:alert(1)" })).is_err());
        assert!(parse_checkout(200, &Value::Null).is_err());
        assert_eq!(flow::BACKOFF_SECS.iter().sum::<u64>(), 120);
    }

    #[gpui::test]
    fn no_timer_or_request_runs_unless_a_checkout_is_pending(cx: &mut gpui::TestAppContext) {
        let cap_ai = cx.new(|_| CapAi::new());
        cap_ai.update(cx, |c, cx| {
            c.input(Input::Activated, cx);
            c.input(Input::Tick, cx);
            c.input(Input::PlanChecked { pro: false }, cx);
            assert!(!c.has_timer() && c.plan_check.is_none() && c.request.is_none());
            c.input(
                Input::Open {
                    signed_in: true,
                    pro: false,
                },
                cx,
            );
            c.input(Input::Activated, cx);
            c.input(Input::PlanChecked { pro: false }, cx);
            assert_eq!(c.phase(), Phase::Pitch);
            assert!(!c.has_timer() && c.plan_check.is_none() && c.request.is_none());
        });
        cap_ai.update(cx, |c, cx| {
            c.flow = flow::debug_flow(Phase::Waiting);
            c.input(Input::PlanChecked { pro: false }, cx);
            assert!(c.has_timer());
            c.close(cx);
            assert!(!c.has_timer() && c.plan_check.is_none() && c.request.is_none());
            assert_eq!(c.phase(), Phase::Closed);
        });
    }
}
