//! Camera and microphone access, as every device picker sees it.
//!
//! Selecting a device used to be the only way to trigger the AV prompt, and
//! a denial or an unanswered prompt surfaced nowhere: the preview spun
//! forever and the row still said "On". This model is the one place the
//! pickers (main window, recording overlay, camera window) read the current
//! authorization from, and the one place that asks for it: the system prompt
//! while undetermined, the exact System Settings pane once denied.
//!
//! The status is a cached preflight (`AVCaptureDevice authorizationStatus`,
//! never prompts), refreshed when an app window activates and after every
//! request, so renders never hit TCC.

use gpui::{App, AppContext, Context, Entity, Global, Task};

use crate::permissions::{self, OSPermission, OSPermissionStatus};

pub struct MediaAccess {
    camera: OSPermissionStatus,
    microphone: OSPermissionStatus,
    requesting: Option<OSPermission>,
    refresh: Option<Task<()>>,
    request: Option<Task<()>>,
}

struct MediaAccessGlobal(Entity<MediaAccess>);

impl Global for MediaAccessGlobal {}

impl MediaAccess {
    pub fn init(cx: &mut App) {
        let entity = cx.new(|cx| {
            let mut this = Self {
                camera: OSPermissionStatus::Granted,
                microphone: OSPermissionStatus::Granted,
                requesting: None,
                refresh: None,
                request: None,
            };
            this.refresh(cx);
            this
        });
        cx.set_global(MediaAccessGlobal(entity));
    }

    /// Re-read the statuses from anywhere, tolerating the model not being
    /// installed yet (feeds can finish before it is).
    pub fn refresh_global(cx: &mut App) {
        if let Some(global) = cx.try_global::<MediaAccessGlobal>() {
            let entity = global.0.clone();
            entity.update(cx, |access, cx| access.refresh(cx));
        }
    }

    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<MediaAccessGlobal>().0.clone()
    }

    pub fn status(&self, permission: OSPermission) -> OSPermissionStatus {
        match permission {
            OSPermission::Camera => self.camera,
            OSPermission::Microphone => self.microphone,
            OSPermission::ScreenRecording | OSPermission::Accessibility => {
                OSPermissionStatus::NotNeeded
            }
        }
    }

    pub fn allowed(&self, permission: OSPermission) -> bool {
        self.status(permission).permitted()
    }

    pub fn requesting(&self, permission: OSPermission) -> bool {
        self.requesting == Some(permission)
    }

    /// Re-read both statuses off the main thread.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.refresh.is_some() {
            return;
        }
        self.refresh = Some(cx.spawn(async move |this, cx| {
            let raw = cx
                .background_executor()
                .spawn(async { crate::permissions_ui::sweep_raw() })
                .await;
            this.update(cx, |this, cx| {
                this.refresh = None;
                let check = permissions::classify(raw, Default::default());
                let camera = check.get(OSPermission::Camera);
                let microphone = check.get(OSPermission::Microphone);
                if camera != this.camera || microphone != this.microphone {
                    this.camera = camera;
                    this.microphone = microphone;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// The one action a missing permission offers: the system prompt while
    /// macOS has not asked yet, the Privacy pane once it has been denied.
    pub fn request(&mut self, permission: OSPermission, cx: &mut Context<Self>) {
        match self.status(permission) {
            OSPermissionStatus::Granted | OSPermissionStatus::NotNeeded => {}
            OSPermissionStatus::Denied => permissions::open_permission_settings(permission),
            OSPermissionStatus::NotDetermined => {
                if self.requesting.is_some() {
                    return;
                }
                self.requesting = Some(permission);
                cx.notify();
                self.request = Some(cx.spawn(async move |this, cx| {
                    #[cfg(target_os = "macos")]
                    {
                        let answer = gpui_tokio::Tokio::spawn(
                            cx,
                            permissions::ensure_capture_media_permission(permission),
                        )
                        .await;
                        if let Ok(Err(error)) = answer {
                            tracing::info!(?permission, "media access not granted: {error}");
                        }
                    }
                    this.update(cx, |this, cx| {
                        this.requesting = None;
                        this.request = None;
                        this.refresh(cx);
                        cx.notify();
                    })
                    .ok();
                }));
            }
        }
    }
}

/// Short action label for a missing permission: what clicking will do.
pub fn action_label(status: OSPermissionStatus) -> &'static str {
    match status {
        OSPermissionStatus::Denied => "Turn on in Settings",
        _ => "Allow access",
    }
}
