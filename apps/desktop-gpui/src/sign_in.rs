//! The one sign-in flow every surface drives.
//!
//! Settings, the editor's share export and the recording overlay used to each
//! run their own attempt. Two at once fought over the single deep-link slot and
//! the loser's teardown cleared the winner's, and each surface only learned
//! about sign-ins it had started itself. Here there is at most one attempt app
//! wide: starting while one is pending re-opens its browser page, every window
//! observes the same pending state, and every window hears the outcome.

use gpui::{App, AppContext, Context, Entity, EventEmitter, Global, Task};

use crate::auth;
use crate::main_window::TargetType;
use crate::platform;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignInOrigin {
    Settings,
    Editor,
    ScreenshotEditor,
    Overlay(TargetType),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInOutcome {
    SignedIn,
    Cancelled,
    TimedOut,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInEvent {
    Finished {
        origin: SignInOrigin,
        outcome: SignInOutcome,
    },
    AccountRefreshed,
}

struct Attempt {
    id: u64,
    origin: SignInOrigin,
    url: String,
    task: Task<()>,
}

pub struct SignIn {
    attempt: Option<Attempt>,
    next_id: u64,
}

struct SignInGlobal(Entity<SignIn>);

impl Global for SignInGlobal {}

impl EventEmitter<SignInEvent> for SignIn {}

impl SignIn {
    pub fn init(cx: &mut App) {
        let entity = cx.new(|_| Self {
            attempt: None,
            next_id: 1,
        });
        cx.set_global(SignInGlobal(entity));
    }

    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<SignInGlobal>().0.clone()
    }

    pub fn is_pending(&self) -> bool {
        self.attempt.is_some()
    }

    pub fn pending_origin(&self) -> Option<SignInOrigin> {
        self.attempt.as_ref().map(|attempt| attempt.origin)
    }

    /// Open the browser sign-in. A second call while an attempt is pending
    /// re-opens that attempt's page (the user may have closed the tab) and
    /// moves the attempt to the newer origin.
    pub fn start(&mut self, origin: SignInOrigin, cx: &mut Context<Self>) {
        if let Some(attempt) = self.attempt.as_mut() {
            attempt.origin = origin;
            cx.open_url(&attempt.url);
            cx.notify();
            return;
        }

        let session = auth::begin_sign_in();
        let url = session.url.clone();
        let id = self.next_id;
        self.next_id += 1;
        let timeout = cx.background_executor().timer(auth::SIGN_IN_TIMEOUT);
        let task = cx.spawn(async move |this, cx| {
            let outcome = match session.wait(timeout).await {
                Ok(params) => match auth::process_auth_data(params) {
                    Ok(()) => {
                        session.mark_completed();
                        SignInOutcome::SignedIn
                    }
                    Err(error) => SignInOutcome::Failed(error),
                },
                Err(auth::SignInWaitError::TimedOut) => SignInOutcome::TimedOut,
            };
            drop(session);

            let Ok(Some(origin)) = this.update(cx, |this, cx| this.finish(id, outcome.clone(), cx))
            else {
                return;
            };
            // After the update, not inside it: both re-enter the run loop. The
            // main window's prompt shows its own failures inline.
            match &outcome {
                SignInOutcome::SignedIn => platform::activate_app(),
                SignInOutcome::Failed(error) if !matches!(origin, SignInOrigin::Overlay(_)) => {
                    platform::alert_dialog("Sign in failed", error)
                }
                _ => {}
            }
            if outcome != SignInOutcome::SignedIn {
                return;
            }
            match gpui_tokio::Tokio::spawn(cx, auth::update_auth_plan()).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::warn!("updating auth plan after sign-in: {error}"),
                Err(error) => tracing::warn!("updating auth plan after sign-in: {error}"),
            }
            this.update(cx, |_, cx| {
                cx.emit(SignInEvent::AccountRefreshed);
                cx.notify();
            })
            .ok();
        });

        cx.open_url(&url);
        self.attempt = Some(Attempt {
            id,
            origin,
            url,
            task,
        });
        cx.notify();
    }

    pub fn reopen(&mut self, cx: &mut Context<Self>) {
        if let Some(attempt) = &self.attempt {
            cx.open_url(&attempt.url);
        }
    }

    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        let Some(attempt) = self.attempt.take() else {
            return;
        };
        drop(attempt.task);
        cx.emit(SignInEvent::Finished {
            origin: attempt.origin,
            outcome: SignInOutcome::Cancelled,
        });
        cx.notify();
    }

    /// Clear a finished attempt. Its task is detached rather than dropped
    /// because this runs from inside that task, which still has the
    /// activation, the alert and the plan refresh to do.
    fn finish(
        &mut self,
        id: u64,
        outcome: SignInOutcome,
        cx: &mut Context<Self>,
    ) -> Option<SignInOrigin> {
        if self.attempt.as_ref().map(|attempt| attempt.id) != Some(id) {
            return None;
        }
        let attempt = self.attempt.take()?;
        let origin = attempt.origin;
        attempt.task.detach();
        match &outcome {
            SignInOutcome::SignedIn => tracing::info!("signed in"),
            SignInOutcome::TimedOut => tracing::info!("sign-in timed out"),
            SignInOutcome::Failed(error) => tracing::warn!("sign-in failed: {error}"),
            SignInOutcome::Cancelled => {}
        }
        cx.emit(SignInEvent::Finished { origin, outcome });
        cx.notify();
        Some(origin)
    }
}
