use gpui::prelude::*;
use gpui::{AnyElement, Context, SharedString, div, img, px};

use super::{AppStoreSnapshot, CatalogApp, SyncState};
use crate::i18n::tr;
use crate::settings_window::SettingsWindow;
use crate::{auth, store, ui};

impl SettingsWindow {
    pub(crate) fn render_apps(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = self.theme;
        let browse = self
            .button(
                "apps-open-web",
                (ui::ButtonVariant::Outline, None),
                tr::settings::apps::browse_web(),
                false,
                cx,
                |_, _, cx| cx.open_url(&format!("{}/dashboard/apps", auth::server_url())),
            )
            .into_any_element();

        let state = super::snapshot(cx);

        let Some(catalog) = state.catalog.clone() else {
            let (message, retry) = match state.state {
                SyncState::Failed => (tr::settings::apps::failed(), true),
                _ => (tr::settings::apps::loading(), false),
            };
            let mut card = self.card(true).flex().flex_col().gap(px(10.)).child(
                div()
                    .text_size(px(12.))
                    .text_color(theme.settings_muted())
                    .child(message),
            );
            if retry {
                card = card.child(self.button(
                    "apps-retry",
                    (ui::ButtonVariant::Outline, None),
                    tr::settings::apps::retry(),
                    false,
                    cx,
                    |_, _, cx| super::refresh(cx),
                ));
            }
            return vec![
                self.section(
                    tr::settings::apps::title(),
                    Some(tr::settings::apps::description()),
                    Some(browse),
                    vec![card.into_any_element()],
                )
                .into_any_element(),
            ];
        };

        let (installed, available): (Vec<&CatalogApp>, Vec<&CatalogApp>) = catalog
            .apps
            .iter()
            .partition(|app| state.is_installed(&app.id));

        let mut sections = Vec::new();
        let mut intro = Vec::new();
        if !state.signed_in {
            intro.push(
                div()
                    .text_size(px(12.))
                    .text_color(theme.settings_muted())
                    .child(tr::settings::apps::sign_in_hint())
                    .into_any_element(),
            );
        }
        sections.push(
            self.section(
                tr::settings::apps::title(),
                Some(tr::settings::apps::description()),
                Some(browse),
                intro,
            )
            .into_any_element(),
        );

        if !installed.is_empty() {
            let rows = installed
                .iter()
                .map(|app| self.app_row(app, &state, cx))
                .collect();
            sections.push(
                self.section(
                    tr::settings::apps::installed_title(),
                    None,
                    None,
                    vec![self.rows(rows).into_any_element()],
                )
                .into_any_element(),
            );
        }

        if available.is_empty() && installed.is_empty() {
            sections.push(
                self.card(true)
                    .text_size(px(12.))
                    .text_color(theme.settings_muted())
                    .child(tr::settings::apps::empty())
                    .into_any_element(),
            );
        } else if !available.is_empty() {
            let rows = available
                .iter()
                .map(|app| self.app_row(app, &state, cx))
                .collect();
            sections.push(
                self.section(
                    tr::settings::apps::available_title(),
                    None,
                    None,
                    vec![self.rows(rows).into_any_element()],
                )
                .into_any_element(),
            );
        }

        sections
    }

    fn app_row(
        &self,
        app: &CatalogApp,
        state: &AppStoreSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let id = app.id.clone();
        let pending = state.pending.contains(&app.id);
        let installation = state.installation(&app.id);
        let local = state.local_installs.contains(&app.id);
        let installed = local || installation.is_some();
        let removable = local
            || installation.is_some_and(|installation| {
                installation.scope == "user" && installation.can_manage
            });
        let org_name = installation
            .filter(|installation| installation.scope == "organization")
            .and_then(|installation| installation.organization_name.clone());
        let paused = installation.is_some_and(|installation| !installation.is_active());
        let needs_review = installation.is_some_and(|installation| installation.needs_review);

        let icon = state.thumbnails.get(&app.icon.sha256).cloned();
        let author = if app.first_party {
            "Cap".to_string()
        } else {
            app.author.name.clone()
        };
        let platforms = app
            .platforms
            .iter()
            .map(|platform| match platform.as_str() {
                "web" => tr::settings::apps::platform_web(),
                _ => tr::settings::apps::platform_desktop(),
            })
            .collect::<Vec<_>>()
            .join(" · ");

        let status: Option<SharedString> = if paused {
            Some(tr::settings::apps::paused().into())
        } else if needs_review {
            Some(tr::settings::apps::review().into())
        } else {
            org_name.map(|organization| tr::settings::apps::managed_by_org(&organization).into())
        };

        let action: AnyElement = if installed {
            if removable && !pending {
                let remove_id = id.clone();
                self.button(
                    SharedString::from(format!("app-remove-{id}")),
                    (ui::ButtonVariant::Outline, None),
                    tr::settings::apps::remove(),
                    false,
                    cx,
                    move |_, _, cx| super::uninstall(remove_id.clone(), cx),
                )
                .into_any_element()
            } else {
                div()
                    .text_size(px(12.))
                    .text_color(theme.settings_muted())
                    .child(tr::settings::apps::installed())
                    .into_any_element()
            }
        } else {
            let label = if app.needs_web_setup()
                || (app.connection.is_some() && store::auth_snapshot().token.is_none())
            {
                tr::settings::apps::set_up()
            } else {
                tr::settings::apps::install()
            };
            let install_id = id.clone();
            self.button(
                SharedString::from(format!("app-install-{id}")),
                (ui::ButtonVariant::Primary, None),
                label,
                pending,
                cx,
                move |_, _, cx| {
                    super::install(install_id.clone(), cx);
                },
            )
            .into_any_element()
        };

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .px(px(14.))
            .py(px(12.))
            .child(
                div()
                    .size(px(36.))
                    .flex_shrink_0()
                    .rounded(px(8.))
                    .overflow_hidden()
                    .bg(theme.settings_fill())
                    .children(icon.map(|icon| img(icon).size_full().rounded(px(8.)))),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .text_color(theme.settings_text())
                                    .child(app.name.clone()),
                            )
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(theme.settings_muted())
                                    .child(author),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(theme.settings_muted())
                            .child(app.description.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme.settings_muted())
                            .child(match status {
                                Some(status) => {
                                    SharedString::from(format!("{platforms} · {status}"))
                                }
                                None => SharedString::from(platforms),
                            }),
                    ),
            )
            .child(div().flex_shrink_0().child(action))
            .into_any_element()
    }
}
