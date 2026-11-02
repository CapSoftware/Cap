use gpui::{AppContext as _, Context, Entity, IntoElement, ParentElement, Styled, Window, div, px};

use crate::{
    settings_window::{Page, SettingsWindow},
    ui,
};

pub(crate) struct SharingSettings {
    settings: cap_cloud_sharing::Settings,
    endpoint: Entity<ui::TextInputState>,
    notice: Option<String>,
    key_busy: bool,
    _events: gpui::Subscription,
}

impl SharingSettings {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<SettingsWindow>) -> Self {
        let result = cap_cloud_sharing::load();
        let notice = result.as_ref().err().cloned();
        let settings = result.unwrap_or_default();
        let endpoint = cx.new(|cx| {
            let mut field = ui::TextInputState::single_line(window, cx);
            field.set_placeholder("https://your-sharing-server.example");
            field.set_text(settings.endpoint.clone(), cx);
            field
        });
        let events = cx.subscribe(&endpoint, |_, _, _, cx| cx.notify());
        Self {
            settings,
            endpoint,
            notice,
            key_busy: false,
            _events: events,
        }
    }
}

impl SettingsWindow {
    pub(crate) fn render_sharing(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let theme = self.theme;
        let settings = &self.sharing.settings;
        vec![
            self.section("Sharing", Some("Record locally. Share only when you choose, through a server you control."), None, vec![
                self.card(true).flex().flex_col().gap(px(16.))
                    .child(self.setting_row("Enable cloud sharing", Some("Enables Share actions. Private walk backup is a separate choice."), self.toggle("sharing-enabled", "Enable cloud sharing", settings.enabled, cx, |this, cx| {
                        let mut settings = this.sharing.settings.clone();
                        settings.enabled = !settings.enabled;
                        settings.endpoint = this.sharing.endpoint.read(cx).text().to_string();
                        this.sharing_save(settings, cx);
                    }).into_any_element()))
                    .child(self.setting_row("Back up new walks privately", Some("Upload recorded source speech, transcripts, notes and click/error logs as you record. No public link is created. Later edits do not remove original backup content. Requires this server and its credential."), self.toggle("walk-backup-enabled", "Back up new walks privately", settings.backup_enabled, cx, |this, cx| { let mut settings = this.sharing.settings.clone(); settings.backup_enabled = !settings.backup_enabled; settings.endpoint = this.sharing.endpoint.read(cx).text().to_string(); this.sharing_save(settings, cx); }).into_any_element()))
                    .child(self.button("sharing-recover-walk", (ui::ButtonVariant::Gray, None), "Recover private walk backup", settings.endpoint.is_empty(), cx, |_, _, cx| crate::ux_walk_window::open_recovery(cx)))
                    .child(div().text_size(px(13.)).child("Sharing server"))
                    .child(ui::TextInput::settings(&theme, "sharing-server", &self.sharing.endpoint))
                    .child(self.button("sharing-save", (ui::ButtonVariant::Dark, None), "Save server", false, cx, |this, _, cx| {
                        let mut settings = this.sharing.settings.clone();
                        settings.endpoint = this.sharing.endpoint.read(cx).text().to_string();
                        this.sharing_save(settings, cx);
                    }))
                    .child(div().text_size(px(12.)).child(fork_brand::text("Use Cap Cloud, your own Cloudflare deployment, or a compatible server. There is no default upload destination.")))
                    .into_any_element()
            ]).into_any_element(),
            self.section("Upload credential", Some("Stored in your system credential store for this server. Recordings never contain it."), None, vec![
                self.card(true).flex().flex_row().gap(px(12.))
                    .child(self.button("sharing-credential", (ui::ButtonVariant::Dark, None), "Set upload credential", settings.endpoint.is_empty() || self.sharing.key_busy || !cfg!(target_os = "macos"), cx, |this, window, cx| this.sharing_credential(false, window, cx)))
                    .child(self.button("sharing-forget", (ui::ButtonVariant::Gray, None), "Forget credential", settings.endpoint.is_empty() || self.sharing.key_busy, cx, |this, window, cx| this.sharing_credential(true, window, cx)))
                    .into_any_element()
            ]).into_any_element(),
            self.section("Link expiry", Some("Anyone with the full link can view it until it expires or you revoke it. Shared media stays private in your server's storage."), None, vec![
                self.card(true).flex().gap(px(8.)).children([1, 7, 30].into_iter().map(|days| self.button(("sharing-expiry", days as usize), (if settings.expires_in_days == days { ui::ButtonVariant::Primary } else { ui::ButtonVariant::Gray }, None), format!("{days} {}", if days == 1 { "day" } else { "days" }), false, cx, move |this, _, cx| {
                    let mut settings = this.sharing.settings.clone(); settings.expires_in_days = days; this.sharing_save(settings, cx);
                }))).into_any_element()
            ]).into_any_element(),
            div().text_size(px(13.)).child(self.sharing.notice.clone().unwrap_or_default()).into_any_element(),
        ]
    }

    fn sharing_credential(&mut self, remove: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.sharing.key_busy {
            return;
        }
        self.sharing.key_busy = true;
        let server = self.sharing.settings.endpoint.clone();
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let token = if remove { None } else { crate::ux_walk::prompt_secret("Sharing upload credential", "Saved in your system credential store for this sharing server. Used for explicit sharing and, when enabled separately, private walk backups.") };
            let result = if remove || token.is_some() {
                Some(cx.background_executor().spawn(async move {
                    if remove { cap_cloud_sharing::remove_token(&server) } else { cap_cloud_sharing::set_token(&server, token.as_deref().unwrap_or_default()) }
                }).await)
            } else { None };
            let _ = this.update_in(cx, |this, window, cx| {
                this.sharing.key_busy = false;
                if let Some(result) = result { this.sharing.notice = Some(match result { Ok(()) => if remove { "Upload credential removed.".into() } else { "Upload credential saved.".into() }, Err(error) => error }); }
                cx.notify(); window.refresh();
            });
        }).detach();
    }

    pub(crate) fn render_sharing_shortcut(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        self.section(
            "Sharing",
            Some("Choose your cloud server and link expiry in Sharing settings."),
            None,
            vec![
                self.button(
                    "general-sharing",
                    (ui::ButtonVariant::Gray, None),
                    "Sharing settings",
                    false,
                    cx,
                    |this, window, cx| this.set_page(Page::Sharing, window, cx),
                )
                .into_any_element(),
            ],
        )
        .into_any_element()
    }

    fn sharing_save(&mut self, settings: cap_cloud_sharing::Settings, cx: &mut Context<Self>) {
        self.sharing.notice = Some(match cap_cloud_sharing::save(&settings) {
            Ok(()) => {
                self.sharing.settings = settings;
                "Sharing settings saved.".into()
            }
            Err(error) => error,
        });
        cx.notify();
    }

    pub(crate) fn render_owned_integrations(
        &self,
        cx: &mut Context<Self>,
    ) -> Vec<gpui::AnyElement> {
        vec![self.section("Integrations", Some(fork_brand::text_static("Connect the services you choose. Cap does not require an account or subscription.")), None, vec![
            self.card(true).flex().flex_col().gap(px(12.))
                .child(self.button("integrations-sharing", (ui::ButtonVariant::Dark, None), "Configure cloud sharing", false, cx, |this, window, cx| this.set_page(Page::Sharing, window, cx)))
                .child(self.button("integrations-transcription", (ui::ButtonVariant::Gray, None), "Configure transcription", false, cx, |this, window, cx| this.set_page(Page::Transcription, window, cx)))
                .into_any_element()
        ]).into_any_element()]
    }
}
