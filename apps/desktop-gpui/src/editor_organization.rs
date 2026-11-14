//! The editor header's organization dropdown (`OrganizationDropdown.tsx`), its
//! brand settings dialog, and the "Brand colours" menu under each colour
//! input (`BrandColorsDropdown.tsx`).

use std::{
    cell::RefCell,
    collections::HashMap,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use gpui::{
    Bounds, Context, FontWeight, Hsla, InteractiveElement, IntoElement, MouseButton, ParentElement,
    Pixels, Point, RenderImage, ScrollHandle, SharedString, StatefulInteractiveElement, Styled,
    StyledImage as _, Window, div, img, point, prelude::FluentBuilder, px, svg,
};

use crate::editor_sidebar::ColorTarget;
use crate::editor_window::EditorWindow;
use crate::i18n::tr;
use crate::organization::{
    self as org, Availability, BrandColorKey, BrandColors, BrandingError, LogoEdit, LogoError,
    Organization, OrganizationSnapshot,
};
use crate::sign_in::{SignIn, SignInOrigin};
use crate::ui;

const MENU_WIDTH: f32 = 288.;
const BRAND_MENU_WIDTH: f32 = 224.;
const BRAND_MENU_ROW: f32 = 36.;
const LOGO_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "avif"];
/// The header and every colour input read the snapshot on each render, and
/// playback re-renders them every frame. Writes from this window clear it at
/// once; writes from other windows show within this window.
const SNAPSHOT_TTL: Duration = Duration::from_millis(250);

#[derive(Default)]
pub(crate) struct OrganizationUi {
    menu: Option<OrganizationMenu>,
    brand_menu: Option<BrandColorsMenu>,
    dialog: Option<BrandDialog>,
    refresh: Option<gpui::Task<()>>,
    refresh_failed_at: Option<Instant>,
    logos: HashMap<String, LogoState>,
    retired_images: Vec<Arc<RenderImage>>,
    started: bool,
    sign_in_subscription: Option<gpui::Subscription>,
    snapshot: RefCell<Option<(Instant, Rc<OrganizationSnapshot>)>>,
}

struct OrganizationMenu {
    origin: Point<Pixels>,
    scroll: ScrollHandle,
}

struct BrandColorsMenu {
    target: ColorTarget,
    origin: Point<Pixels>,
}

enum LogoState {
    Loading { _task: gpui::Task<()> },
    Ready(Arc<RenderImage>),
    Failed,
}

enum LogoDraft {
    Keep,
    Remove,
    Upload {
        content_type: &'static str,
        data: Vec<u8>,
        preview: Option<Arc<RenderImage>>,
    },
}

struct BrandDialog {
    organization_id: String,
    name: String,
    base: BrandColors,
    draft: BrandColors,
    logo_url: Option<String>,
    logo: LogoDraft,
    picking_logo: bool,
    save: Option<gpui::Task<()>>,
    error: Option<SharedString>,
}

impl OrganizationUi {
    fn snapshot(&self) -> Rc<OrganizationSnapshot> {
        let mut cached = self.snapshot.borrow_mut();
        if let Some((read_at, snapshot)) = cached.as_ref()
            && read_at.elapsed() < SNAPSHOT_TTL
        {
            return snapshot.clone();
        }
        let snapshot = Rc::new(OrganizationSnapshot::load());
        *cached = Some((Instant::now(), snapshot.clone()));
        snapshot
    }

    fn invalidate_snapshot(&self) {
        self.snapshot.borrow_mut().take();
    }

    pub(crate) fn dialog_open(&self) -> bool {
        self.dialog.is_some()
    }

    pub(crate) fn has_open_overlay(&self) -> bool {
        self.menu.is_some() || self.brand_menu.is_some() || self.dialog.is_some()
    }

    pub(crate) fn brand_draft_color(&self, key: BrandColorKey) -> Option<[u16; 3]> {
        let color = self.dialog.as_ref()?.draft.get(key)?;
        Some(color.map(u16::from))
    }

    pub(crate) fn release_retired_images(&mut self, window: &mut Window) {
        for image in self.retired_images.drain(..) {
            let _ = window.drop_image(image);
        }
    }

    fn retire_upload_preview(&mut self, logo: LogoDraft) {
        if let LogoDraft::Upload {
            preview: Some(image),
            ..
        } = logo
        {
            self.retired_images.push(image);
        }
    }
}

fn branding_error_message(error: &BrandingError) -> SharedString {
    match error {
        BrandingError::SignedOut => tr::editor::window::organization::error::signed_out().into(),
        BrandingError::Offline => tr::editor::window::organization::error::offline().into(),
        BrandingError::NotFound => tr::editor::window::organization::error::not_found().into(),
        BrandingError::Forbidden => tr::editor::window::organization::error::forbidden().into(),
        BrandingError::Rejected(message) => message.clone().into(),
        BrandingError::Failed => tr::editor::window::organization::error::failed().into(),
    }
}

fn logo_error_message(error: LogoError) -> &'static str {
    match error {
        LogoError::Empty => tr::editor::window::organization::error::logo_empty(),
        LogoError::TooLarge => tr::editor::window::organization::error::logo_too_large(),
        LogoError::Unsupported => tr::editor::window::organization::error::logo_unsupported(),
    }
}

fn color_label(key: BrandColorKey) -> &'static str {
    match key {
        BrandColorKey::Primary => tr::editor::window::organization::color::primary(),
        BrandColorKey::Secondary => tr::editor::window::organization::color::secondary(),
        BrandColorKey::Accent => tr::editor::window::organization::color::accent(),
        BrandColorKey::Background => tr::editor::window::organization::color::background(),
    }
}

fn to_color(rgb: [u8; 3]) -> cap_project::Color {
    rgb.map(u16::from)
}

impl EditorWindow {
    // -- Data ------------------------------------------------------------------

    /// First frame: refresh a stale cache, load logos, and follow sign-ins
    /// from any window so the header updates without a reopen.
    pub(crate) fn start_organization_sync(&mut self, cx: &mut Context<Self>) {
        if std::mem::replace(&mut self.organization.started, true) {
            return;
        }
        if let Some(sign_in) = SignIn::try_global(cx) {
            self.organization.sign_in_subscription = Some(cx.subscribe(
                &sign_in,
                |this, _, event: &crate::sign_in::SignInEvent, cx| {
                    if matches!(event, crate::sign_in::SignInEvent::AccountRefreshed) {
                        this.organization.refresh_failed_at = None;
                        this.organization.invalidate_snapshot();
                        let snapshot = this.organization.snapshot();
                        this.load_organization_logos(&snapshot, cx);
                        cx.notify();
                    }
                },
            ));
        }
        self.refresh_organizations(false, cx);
    }

    fn organization_availability(&self, snapshot: &OrganizationSnapshot) -> Availability {
        org::availability(
            snapshot.signed_in,
            snapshot.cached,
            self.organization.refresh.is_some(),
        )
    }

    pub(crate) fn brand_swatches(&self) -> Vec<(BrandColorKey, [u8; 3])> {
        self.organization
            .snapshot()
            .selected()
            .map(|organization| organization.brand_colors.swatches())
            .unwrap_or_default()
    }

    /// Refetch the organization list through `update_auth_plan`, the same call
    /// the Tauri dropdown made, when the cache is stale or `force` (Retry).
    pub(crate) fn refresh_organizations(&mut self, force: bool, cx: &mut Context<Self>) {
        if self.organization.refresh.is_some() {
            return;
        }
        self.organization.invalidate_snapshot();
        let snapshot = self.organization.snapshot();
        let failed_recently = self
            .organization
            .refresh_failed_at
            .is_some_and(|at| at.elapsed() < org::RETRY_AFTER);
        let now = chrono::Utc::now().timestamp();
        if !snapshot.signed_in
            || (!force && !org::should_refresh(true, snapshot.updated_at, now, failed_recently))
        {
            self.load_organization_logos(&snapshot, cx);
            return;
        }
        let before = snapshot.updated_at;
        self.organization.refresh = Some(cx.spawn(async move |this, cx| {
            let result = gpui_tokio::Tokio::spawn(cx, crate::auth::update_auth_plan()).await;
            this.update(cx, |this, cx| {
                this.organization.refresh = None;
                this.organization.invalidate_snapshot();
                let after = this.organization.snapshot();
                let fetched = matches!(result, Ok(Ok(())))
                    && after.cached
                    && (after.updated_at != before || before.is_none());
                if !fetched {
                    tracing::warn!("organization refresh did not return a list");
                }
                this.organization.refresh_failed_at = (!fetched).then(Instant::now);
                if fetched {
                    this.organization
                        .logos
                        .retain(|_, logo| !matches!(logo, LogoState::Failed));
                }
                this.load_organization_logos(&after, cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn load_organization_logos(&mut self, snapshot: &OrganizationSnapshot, cx: &mut Context<Self>) {
        for url in snapshot
            .organizations
            .iter()
            .filter_map(|organization| organization.icon_url.clone())
        {
            if self.organization.logos.contains_key(&url) {
                continue;
            }
            let fetch_url = url.clone();
            let key = url.clone();
            let task = cx.spawn(async move |this, cx| {
                let result = gpui_tokio::Tokio::spawn(cx, org::fetch_logo(fetch_url)).await;
                this.update(cx, |this, cx| {
                    let state = match result {
                        Ok(Ok(image)) => LogoState::Ready(image),
                        Ok(Err(error)) => {
                            tracing::warn!("organization logo failed to load: {error}");
                            LogoState::Failed
                        }
                        Err(error) => {
                            tracing::warn!("organization logo failed to load: {error}");
                            LogoState::Failed
                        }
                    };
                    this.organization.logos.insert(key, state);
                    cx.notify();
                })
                .ok();
            });
            self.organization
                .logos
                .insert(url, LogoState::Loading { _task: task });
        }
    }

    fn organization_logo(&self, organization: &Organization) -> Option<Arc<RenderImage>> {
        match self
            .organization
            .logos
            .get(organization.icon_url.as_deref()?)?
        {
            LogoState::Ready(image) => Some(image.clone()),
            LogoState::Loading { .. } | LogoState::Failed => None,
        }
    }

    /// Pick `id`: new Instant recordings and new shares from the export dialog
    /// go there. An export already uploading keeps the organization it started
    /// with; `start_link_export` copied it before the upload began.
    fn select_organization(&mut self, id: String, cx: &mut Context<Self>) {
        self.organization.menu = None;
        if !org::persist_selected_id(&id) {
            tracing::warn!("the selected organization could not be saved");
        }
        self.organization.invalidate_snapshot();
        match self.export.as_mut() {
            Some(export) => export.select_organization(&id),
            None => {
                let id = id.clone();
                cx.background_executor()
                    .spawn(async move {
                        crate::store::update(|state| {
                            if let Some(export) = state.export.as_mut() {
                                export.organization_id = Some(id);
                            }
                        });
                    })
                    .detach();
            }
        }
        cx.notify();
    }

    // -- Header dropdown -------------------------------------------------------

    pub(crate) fn render_organization_button(
        &self,
        compact: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let snapshot = self.organization.snapshot();
        let label: SharedString = match self.organization_availability(&snapshot) {
            Availability::Available => snapshot
                .selected()
                .map(|organization| organization.name.clone())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| tr::editor::window::organization::button().into())
                .into(),
            Availability::Loading => tr::common::loading().into(),
            Availability::Unavailable => tr::editor::window::organization::button().into(),
            Availability::SignedOut => tr::editor::window::organization::sign_in().into(),
        };
        ui::EditorButton::plain(&theme, "organization")
            .left_icon("icons/building-2.svg")
            .when(!compact, |button| {
                button.label(label.clone()).max_width(px(180.))
            })
            .tooltip(&theme, label)
            .right_icon("icons/chevron-down.svg")
            .pressed(self.organization.menu.is_some())
            .on_open(cx.listener(|this, bounds: &Bounds<Pixels>, window, cx| {
                this.toggle_organization_menu(bounds.bottom_left(), window, cx);
            }))
    }

    fn toggle_organization_menu(
        &mut self,
        anchor: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.organization.menu.take().is_some() {
            cx.notify();
            return;
        }
        let focus = self.focus_handle_for_menu();
        window.focus(&focus, cx);
        self.organization.brand_menu = None;
        let viewport = window.viewport_size();
        let x = f32::from(anchor.x)
            .min(f32::from(viewport.width) - MENU_WIDTH - 12.)
            .max(12.);
        self.organization.menu = Some(OrganizationMenu {
            origin: point(px(x), anchor.y + px(8.)),
            scroll: ScrollHandle::new(),
        });
        self.refresh_organizations(false, cx);
        cx.notify();
    }

    pub(crate) fn render_organization_menu(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        let menu = self.organization.menu.as_ref()?;
        let theme = self.theme;
        let snapshot = self.organization.snapshot();
        let availability = self.organization_availability(&snapshot);

        let body = match availability {
            Availability::Available => self.render_organization_list(&snapshot, &menu.scroll, cx),
            _ => self.render_organization_fallback(availability, cx),
        };

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("organization-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .occlude()
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.organization.menu = None;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .debug_selector(|| "organization-menu".into())
                        .absolute()
                        .left(menu.origin.x)
                        .top(menu.origin.y)
                        .w(px(MENU_WIDTH))
                        .occlude()
                        .flex()
                        .flex_col()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(Hsla::from(theme.editor.line))
                        .bg(Hsla::from(theme.editor.card))
                        .shadow(theme.editor.pop_shadow())
                        .overflow_hidden()
                        .child(body),
                )
                .into_any_element(),
        )
    }

    fn render_organization_fallback(
        &self,
        availability: Availability,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let (title, description) = match availability {
            Availability::Loading => (
                tr::editor::window::organization::loading_title(),
                tr::editor::window::organization::loading_description(),
            ),
            Availability::Unavailable => (
                tr::editor::window::organization::unavailable_title(),
                tr::editor::window::organization::unavailable_description(),
            ),
            _ => (
                tr::editor::window::organization::signed_out_title(),
                tr::editor::window::organization::signed_out_description(),
            ),
        };
        let sign_in_pending =
            SignIn::try_global(cx).is_some_and(|sign_in| sign_in.read(cx).is_pending());
        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(12.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(14.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.editor.text_1))
                            .child(title),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(20.))
                            .text_color(Hsla::from(theme.editor.text_2))
                            .child(description),
                    ),
            )
            .when(availability == Availability::SignedOut, |this| {
                this.child(
                    ui::Button::plain(
                        &theme,
                        "organization-sign-in",
                        ui::ButtonVariant::Blue,
                        ui::ButtonSize::Md,
                    )
                    .full_width()
                    .label(tr::editor::window::organization::sign_in())
                    .disabled(sign_in_pending)
                    .on_click(cx.listener(|this, _, _window, cx| {
                        this.organization.menu = None;
                        if let Some(sign_in) = SignIn::try_global(cx) {
                            sign_in
                                .update(cx, |sign_in, cx| sign_in.start(SignInOrigin::Editor, cx));
                        }
                        cx.notify();
                    })),
                )
            })
            .when(availability == Availability::Unavailable, |this| {
                this.child(
                    ui::Button::plain(
                        &theme,
                        "organization-retry",
                        ui::ButtonVariant::Gray,
                        ui::ButtonSize::Md,
                    )
                    .full_width()
                    .icon("icons/refresh-cw.svg")
                    .label(tr::editor::window::organization::retry())
                    .on_click(cx.listener(|this, _, _window, cx| {
                        this.refresh_organizations(true, cx);
                    })),
                )
            })
            .into_any_element()
    }

    fn render_organization_list(
        &self,
        snapshot: &OrganizationSnapshot,
        scroll: &ScrollHandle,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let selected = snapshot.selected();
        let rows: Vec<gpui::AnyElement> = if snapshot.organizations.is_empty() {
            vec![
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .h(px(32.))
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.editor.text_3))
                    .child(tr::editor::window::organization::none())
                    .into_any_element(),
            ]
        } else {
            snapshot
                .organizations
                .iter()
                .enumerate()
                .map(|(index, organization)| {
                    let is_selected =
                        selected.is_some_and(|selected| selected.id == organization.id);
                    let id = organization.id.clone();
                    div()
                        .id(SharedString::from(format!("organization-{index}")))
                        .flex()
                        .flex_row()
                        .items_center()
                        .flex_none()
                        .gap(px(8.))
                        .h(px(40.))
                        .px(px(8.))
                        .rounded(px(8.))
                        .cursor_pointer()
                        .hover(|this| this.bg(Hsla::from(theme.editor.ctl_hover)))
                        .child(self.render_organization_avatar(organization, 24.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(14.))
                                .text_color(Hsla::from(theme.editor.text_1))
                                .child(display_name(organization)),
                        )
                        .when(is_selected, |this| {
                            this.child(
                                svg()
                                    .path("icons/check.svg")
                                    .size(px(16.))
                                    .flex_none()
                                    .text_color(Hsla::from(theme.editor.accent)),
                            )
                        })
                        .on_click(cx.listener(move |this, _, _window, cx| {
                            this.select_organization(id.clone(), cx);
                        }))
                        .into_any_element()
                })
                .collect()
        };

        let can_edit = selected.is_some_and(|organization| organization.can_edit_brand);
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .id("organization-list")
                    .flex()
                    .flex_col()
                    .max_h(px(224.))
                    .min_h_0()
                    .p(px(6.))
                    .gap(px(2.))
                    .overflow_y_scroll()
                    .track_scroll(scroll)
                    .children(rows),
            )
            .when(can_edit, |this| {
                this.child(
                    div()
                        .p(px(6.))
                        .border_t_1()
                        .border_color(Hsla::from(theme.editor.line))
                        .child(
                            div()
                                .id("organization-brand-settings")
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(8.))
                                .h(px(40.))
                                .px(px(8.))
                                .rounded(px(8.))
                                .cursor_pointer()
                                .hover(|this| this.bg(Hsla::from(theme.editor.ctl_hover)))
                                .text_size(px(14.))
                                .text_color(Hsla::from(theme.editor.text_1))
                                .child(
                                    svg()
                                        .path("icons/palette.svg")
                                        .size(px(16.))
                                        .flex_none()
                                        .text_color(Hsla::from(theme.editor.text_2)),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .child(tr::editor::window::organization::brand_settings()),
                                )
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.open_brand_dialog(window, cx);
                                })),
                        ),
                )
            })
            .into_any_element()
    }

    fn render_organization_avatar(
        &self,
        organization: &Organization,
        size: f32,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let logo = self.organization_logo(organization);
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(size))
            .rounded(px(8.))
            .overflow_hidden()
            .bg(Hsla::from(theme.editor.ctl))
            .text_size(px(11.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(Hsla::from(theme.editor.text_1))
            .map(|this| match logo {
                Some(image) => {
                    this.child(img(image).size_full().object_fit(gpui::ObjectFit::Contain))
                }
                None => this.child(organization.initial()),
            })
            .into_any_element()
    }

    // -- Brand settings dialog -------------------------------------------------

    fn open_brand_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.organization.menu = None;
        self.organization.invalidate_snapshot();
        let snapshot = self.organization.snapshot();
        let Some(organization) = snapshot
            .selected()
            .filter(|organization| organization.can_edit_brand)
        else {
            cx.notify();
            return;
        };
        self.close_color_picker(cx);
        for key in BrandColorKey::ALL {
            self.ensure_hex_input(ColorTarget::Brand(key), window, cx);
        }
        self.organization.dialog = Some(BrandDialog {
            organization_id: organization.id.clone(),
            name: display_name(organization).to_string(),
            base: organization.brand_colors,
            draft: organization.brand_colors,
            logo_url: organization.icon_url.clone(),
            logo: LogoDraft::Keep,
            picking_logo: false,
            save: None,
            error: None,
        });
        let focus = self.focus_handle_for_menu();
        window.focus(&focus, cx);
        cx.notify();
    }

    pub(crate) fn close_brand_dialog(&mut self, cx: &mut Context<Self>) {
        if self
            .sidebar
            .color_target
            .is_some_and(|target| matches!(target, ColorTarget::Brand(_)))
        {
            self.close_color_picker(cx);
        }
        if let Some(dialog) = self.organization.dialog.take() {
            self.organization.retire_upload_preview(dialog.logo);
        }
        cx.notify();
    }

    pub(crate) fn dismiss_organization_overlay(&mut self, cx: &mut Context<Self>) -> bool {
        if self.organization.brand_menu.take().is_some() || self.organization.menu.take().is_some()
        {
            cx.notify();
            return true;
        }
        if self.organization.dialog.is_some() {
            self.close_brand_dialog(cx);
            return true;
        }
        false
    }

    pub(crate) fn set_brand_draft(
        &mut self,
        key: BrandColorKey,
        color: Option<[u8; 3]>,
        cx: &mut Context<Self>,
    ) {
        let Some(dialog) = self.organization.dialog.as_mut() else {
            return;
        };
        if dialog.save.is_some() {
            return;
        }
        dialog.draft.set(key, color);
        if color.is_none() && self.sidebar.color_target == Some(ColorTarget::Brand(key)) {
            self.close_color_picker(cx);
        }
        cx.notify();
    }

    fn pick_brand_logo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(dialog) = self.organization.dialog.as_mut() else {
            return;
        };
        if dialog.picking_logo || dialog.save.is_some() {
            return;
        }
        dialog.picking_logo = true;
        dialog.error = None;
        cx.spawn_in(window, async move |this, cx| {
            let filters: &[(&str, &[&str])] =
                &[(tr::editor::window::image::filter(), LOGO_EXTENSIONS)];
            #[cfg(target_os = "linux")]
            let source = crate::platform::open_file_panel_async(filters, None, cx).await;
            #[cfg(not(target_os = "linux"))]
            let source = crate::import::pick_import_file(filters, cx).await;
            let read = match source {
                Some(path) => Some(
                    cx.background_executor()
                        .spawn(async move { read_logo_file(&path) })
                        .await,
                ),
                None => None,
            };
            this.update(cx, |this, cx| {
                let Some(dialog) = this.organization.dialog.as_mut() else {
                    return;
                };
                dialog.picking_logo = false;
                match read {
                    Some(Ok((content_type, data, preview))) => {
                        let previous = std::mem::replace(
                            &mut dialog.logo,
                            LogoDraft::Upload {
                                content_type,
                                data,
                                preview,
                            },
                        );
                        this.organization.retire_upload_preview(previous);
                    }
                    Some(Err(message)) => dialog.error = Some(message.into()),
                    None => {}
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn remove_brand_logo(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.organization.dialog.as_mut() else {
            return;
        };
        if dialog.save.is_some() {
            return;
        }
        let previous = std::mem::replace(&mut dialog.logo, LogoDraft::Remove);
        self.organization.retire_upload_preview(previous);
        cx.notify();
    }

    fn save_brand_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .sidebar
            .color_target
            .is_some_and(|target| matches!(target, ColorTarget::Brand(_)))
        {
            self.close_color_picker(cx);
        }
        let Some(dialog) = self.organization.dialog.as_mut() else {
            return;
        };
        if dialog.save.is_some() {
            return;
        }
        dialog.error = None;
        let organization_id = dialog.organization_id.clone();
        let base = dialog.base;
        let edited = dialog.draft;
        let logo = match &dialog.logo {
            LogoDraft::Keep => LogoEdit::Keep,
            LogoDraft::Remove => LogoEdit::Remove,
            LogoDraft::Upload {
                content_type, data, ..
            } => LogoEdit::Upload {
                content_type: *content_type,
                data: data.clone(),
            },
        };
        dialog.save = Some(cx.spawn_in(window, async move |this, cx| {
            let result = gpui_tokio::Tokio::spawn(
                cx,
                org::save_branding(organization_id.clone(), base, edited, logo),
            )
            .await;
            let result = match result {
                Ok(result) => result,
                Err(error) => {
                    tracing::warn!("branding save task failed: {error}");
                    Err(BrandingError::Failed)
                }
            };
            this.update_in(cx, |this, window, cx| {
                let Some(dialog) = this.organization.dialog.as_mut() else {
                    return;
                };
                if dialog.organization_id != organization_id {
                    return;
                }
                dialog.save = None;
                match result {
                    Ok(saved) => {
                        this.organization.invalidate_snapshot();
                        if let Some(url) = &saved.icon_url {
                            this.organization.logos.remove(url);
                        }
                        this.close_brand_dialog(cx);
                        this.refresh_organizations(false, cx);
                        this.show_notice(tr::editor::window::organization::saved(), window, cx);
                    }
                    Err(BrandingError::Forbidden) => {
                        tracing::warn!("saving organization branding was forbidden");
                        this.close_brand_dialog(cx);
                        this.show_notice(
                            branding_error_message(&BrandingError::Forbidden),
                            window,
                            cx,
                        );
                    }
                    Err(error) => {
                        tracing::warn!("saving organization branding failed: {error:?}");
                        dialog.error = Some(branding_error_message(&error));
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    pub(crate) fn render_brand_dialog(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let dialog = self.organization.dialog.as_ref()?;
        let theme = self.theme;
        let saving = dialog.save.is_some();

        let current_logo =
            dialog
                .logo_url
                .as_deref()
                .and_then(|url| match self.organization.logos.get(url)? {
                    LogoState::Ready(image) => Some(image.clone()),
                    _ => None,
                });
        let (logo_preview, has_logo) = match &dialog.logo {
            LogoDraft::Keep => (current_logo, dialog.logo_url.is_some()),
            LogoDraft::Remove => (None, false),
            LogoDraft::Upload { preview, .. } => (preview.clone(), true),
        };

        let logo_row = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(px(64.))
                    .rounded(px(12.))
                    .overflow_hidden()
                    .bg(Hsla::from(theme.editor.ctl))
                    .map(|this| match logo_preview {
                        Some(image) => {
                            this.child(img(image).size_full().object_fit(gpui::ObjectFit::Contain))
                        }
                        None => this.child(
                            svg()
                                .path("icons/image.svg")
                                .size(px(24.))
                                .text_color(Hsla::from(theme.editor.text_3)),
                        ),
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .gap(px(8.))
                    .child(
                        ui::Button::plain(
                            &theme,
                            "brand-logo-upload",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Md,
                        )
                        .icon("icons/upload-arrow.svg")
                        .label(tr::editor::window::organization::upload())
                        .disabled(saving || dialog.picking_logo)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.pick_brand_logo(window, cx);
                        })),
                    )
                    .when(has_logo, |this| {
                        this.child(
                            ui::Button::plain(
                                &theme,
                                "brand-logo-remove",
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Md,
                            )
                            .icon("icons/trash.svg")
                            .label(tr::editor::window::organization::remove())
                            .disabled(saving)
                            .on_click(cx.listener(
                                |this, _, _window, cx| {
                                    this.remove_brand_logo(cx);
                                },
                            )),
                        )
                    }),
            );

        let color_rows = BrandColorKey::ALL.into_iter().map(|key| {
            let value = dialog.draft.get(key);
            let target = ColorTarget::Brand(key);
            let open = self.sidebar.color_target == Some(target);
            let row = div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(12.))
                .min_h(px(40.))
                .child(
                    div()
                        .w(px(96.))
                        .flex_none()
                        .text_size(px(14.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(theme.editor.text_2))
                        .child(color_label(key)),
                );
            let controls = div()
                .flex()
                .flex_row()
                .flex_1()
                .items_center()
                .justify_end()
                .gap(px(8.));
            let controls = match (value, self.hex_input(target).cloned()) {
                (Some(color), Some(input)) => controls
                    .child(
                        div()
                            .id(SharedString::from(format!("brand-swatch-{key:?}")))
                            .size(px(30.))
                            .flex_none()
                            .rounded(px(7.))
                            .bg(crate::editor_sidebar::color_to_hsla(to_color(color)))
                            .border_1()
                            .border_color(crate::editor_sidebar::preview_border_color(to_color(
                                color,
                            )))
                            .when(open, |this| {
                                this.border_2().border_color(Hsla::from(theme.blue_9))
                            })
                            .when(!saving, |this| {
                                this.cursor_pointer().on_click(cx.listener(
                                    move |this, event: &gpui::ClickEvent, window, cx| {
                                        this.open_color_panel_for(
                                            target,
                                            event.position(),
                                            window,
                                            cx,
                                        );
                                    },
                                ))
                            }),
                    )
                    .child(
                        ui::TextInput::plain(
                            &theme,
                            SharedString::from(format!("brand-hex-{key:?}")),
                            &input,
                        )
                        .width(px(96.))
                        .padding_x(px(8.))
                        .height(px(30.))
                        .radius(px(7.))
                        .text_size(px(13.))
                        .bg(Hsla::from(theme.editor.ctl))
                        .border(gpui::transparent_black())
                        .text_color(Hsla::from(theme.editor.text_1))
                        .caret_color(Hsla::from(theme.editor.accent)),
                    )
                    .child(
                        ui::EditorButton::plain(
                            &theme,
                            SharedString::from(format!("brand-clear-{key:?}")),
                        )
                        .left_icon("icons/trash.svg")
                        .tooltip(&theme, tr::editor::window::organization::remove_colour())
                        .disabled(saving)
                        .on_click(cx.listener(
                            move |this, _, _window, cx| {
                                this.set_brand_draft(key, None, cx);
                            },
                        )),
                    ),
                _ => controls.child(
                    ui::Button::plain(
                        &theme,
                        SharedString::from(format!("brand-set-{key:?}")),
                        ui::ButtonVariant::Gray,
                        ui::ButtonSize::Md,
                    )
                    .label(tr::editor::window::organization::set())
                    .disabled(saving)
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        this.set_brand_draft(key, Some(key.default_color()), cx);
                    })),
                ),
            };
            row.child(controls)
        });

        let body = div()
            .flex()
            .flex_col()
            .gap(px(20.))
            .child(logo_row)
            .child(div().flex().flex_col().gap(px(12.)).children(color_rows))
            .children(dialog.error.clone().map(|error| {
                div()
                    .text_size(px(12.))
                    .line_height(px(18.))
                    .text_color(Hsla::from(theme.red_9))
                    .child(error)
            }));

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .id("brand-dialog-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .bg(gpui::hsla(0., 0., 0., 0.5))
                        .on_click(cx.listener(|this, _, _window, cx| {
                            if this
                                .organization
                                .dialog
                                .as_ref()
                                .is_some_and(|dialog| dialog.save.is_none())
                            {
                                this.close_brand_dialog(cx);
                            }
                        })),
                )
                .child(
                    div()
                        .debug_selector(|| "brand-dialog".into())
                        .occlude()
                        .w(px(400.))
                        .flex()
                        .flex_col()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(Hsla::from(theme.editor.line))
                        .bg(Hsla::from(theme.editor.card))
                        .shadow(theme.editor.pop_shadow())
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(
                            div()
                                .px(px(16.))
                                .py(px(12.))
                                .border_b_1()
                                .border_color(Hsla::from(theme.editor.line))
                                .text_size(px(14.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(Hsla::from(theme.editor.text_1))
                                .truncate()
                                .child(SharedString::from(dialog.name.clone())),
                        )
                        .child(div().p(px(16.)).child(body))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .justify_end()
                                .gap(px(8.))
                                .px(px(16.))
                                .pb(px(16.))
                                .child(
                                    ui::Button::plain(
                                        &theme,
                                        "brand-cancel",
                                        ui::ButtonVariant::Gray,
                                        ui::ButtonSize::Md,
                                    )
                                    .label(tr::common::cancel())
                                    .disabled(saving)
                                    .on_click(cx.listener(
                                        |this, _, _window, cx| {
                                            this.close_brand_dialog(cx);
                                        },
                                    )),
                                )
                                .child(
                                    ui::Button::plain(
                                        &theme,
                                        "brand-save",
                                        ui::ButtonVariant::Blue,
                                        ui::ButtonSize::Md,
                                    )
                                    .label(if saving {
                                        tr::editor::window::organization::saving()
                                    } else {
                                        tr::common::save()
                                    })
                                    .disabled(saving || dialog.picking_logo)
                                    .on_click(cx.listener(
                                        |this, _, window, cx| {
                                            this.save_brand_dialog(window, cx);
                                        },
                                    )),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }

    // -- Brand colours under each colour input ---------------------------------

    /// `BrandColorsDropdown`: nothing at all unless the selected organization
    /// has brand colours, so the sidebar is unchanged for everyone else.
    pub(crate) fn render_brand_colors_trigger(
        &self,
        target: ColorTarget,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        let swatches = self.brand_swatches();
        if swatches.is_empty() {
            return None;
        }
        let theme = self.theme;
        let open = self
            .organization
            .brand_menu
            .as_ref()
            .is_some_and(|menu| menu.target == target);
        let card = Hsla::from(theme.editor.card);
        let trigger = div()
            .id(SharedString::from(format!("brand-colors-{target:?}")))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .w_full()
            .h(px(32.))
            .px(px(8.))
            .rounded(px(7.))
            .cursor_pointer()
            .bg(Hsla::from(if open {
                theme.editor.ctl_hover
            } else {
                theme.editor.ctl
            }))
            .hover(|this| this.bg(Hsla::from(theme.editor.ctl_hover)))
            .text_size(px(13.))
            .text_color(Hsla::from(theme.editor.text_1))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .child(tr::editor::window::organization::brand_colours()),
            )
            .child(
                div().flex().flex_row().flex_none().children(
                    swatches
                        .iter()
                        .take(4)
                        .enumerate()
                        .map(|(index, (_, color))| {
                            let color = to_color(*color);
                            div()
                                .size(px(16.))
                                .when(index > 0, |this| this.ml(px(-4.)))
                                .rounded_full()
                                .border_1()
                                .border_color(card)
                                .child(
                                    div()
                                        .size_full()
                                        .rounded_full()
                                        .bg(crate::editor_sidebar::color_to_hsla(color))
                                        .border_1()
                                        .border_color(crate::editor_sidebar::preview_border_color(
                                            color,
                                        )),
                                )
                        }),
                ),
            )
            .child(
                svg()
                    .path("icons/chevron-down.svg")
                    .size(px(14.))
                    .flex_none()
                    .text_color(Hsla::from(theme.editor.text_3)),
            );
        Some(
            ui::Menu::trigger(
                trigger,
                cx.listener(move |this, bounds: &Bounds<Pixels>, window, cx| {
                    this.toggle_brand_colors_menu(target, *bounds, window, cx);
                }),
            )
            .into_any_element(),
        )
    }

    fn toggle_brand_colors_menu(
        &mut self,
        target: ColorTarget,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .organization
            .brand_menu
            .take()
            .is_some_and(|menu| menu.target == target)
        {
            cx.notify();
            return;
        }
        let rows = self.brand_swatches().len() as f32;
        let height = rows * BRAND_MENU_ROW + 12. + 2.;
        let viewport = window.viewport_size();
        let x = f32::from(bounds.left())
            .min(f32::from(viewport.width) - BRAND_MENU_WIDTH - 12.)
            .max(12.);
        let below = f32::from(bounds.bottom()) + 6.;
        let y = if below + height > f32::from(viewport.height) - 12. {
            (f32::from(bounds.top()) - 6. - height).max(12.)
        } else {
            below
        };
        self.organization.brand_menu = Some(BrandColorsMenu {
            target,
            origin: point(px(x), px(y)),
        });
        cx.notify();
    }

    pub(crate) fn render_brand_colors_menu(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        let menu = self.organization.brand_menu.as_ref()?;
        let theme = self.theme;
        let target = menu.target;
        let rows = self
            .brand_swatches()
            .into_iter()
            .map(|(key, color)| {
                let swatch = to_color(color);
                div()
                    .id(SharedString::from(format!("brand-color-{key:?}")))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .h(px(BRAND_MENU_ROW))
                    .px(px(8.))
                    .rounded(px(8.))
                    .cursor_pointer()
                    .hover(|this| this.bg(Hsla::from(theme.editor.ctl_hover)))
                    .child(
                        div()
                            .size(px(20.))
                            .flex_none()
                            .rounded(px(6.))
                            .bg(crate::editor_sidebar::color_to_hsla(swatch))
                            .border_1()
                            .border_color(crate::editor_sidebar::preview_border_color(swatch)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(14.))
                            .text_color(Hsla::from(theme.editor.text_1))
                            .child(color_label(key)),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_size(px(11.))
                            .text_color(Hsla::from(theme.editor.text_3))
                            .child(org::format_hex(color)),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.organization.brand_menu = None;
                        if this.color_for(target) != Some(swatch) {
                            this.set_color(target, swatch, window, cx);
                        }
                        cx.notify();
                    }))
            })
            .collect::<Vec<_>>();

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("brand-colors-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .occlude()
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.organization.brand_menu = None;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .debug_selector(|| "brand-colors-menu".into())
                        .absolute()
                        .left(menu.origin.x)
                        .top(menu.origin.y)
                        .w(px(BRAND_MENU_WIDTH))
                        .occlude()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .p(px(6.))
                        .rounded(px(12.))
                        .border_1()
                        .border_color(Hsla::from(theme.editor.line))
                        .bg(Hsla::from(theme.editor.card))
                        .shadow(theme.editor.pop_shadow())
                        .children(rows),
                )
                .into_any_element(),
        )
    }
}

fn display_name(organization: &Organization) -> SharedString {
    if organization.name.is_empty() {
        tr::editor::window::organization::button().into()
    } else {
        organization.name.clone().into()
    }
}

fn read_logo_file(
    path: &std::path::Path,
) -> Result<(&'static str, Vec<u8>, Option<Arc<RenderImage>>), &'static str> {
    let size = std::fs::metadata(path)
        .map_err(|_| tr::editor::window::organization::error::logo_read_failed())?
        .len();
    if size > org::LOGO_MAX_BYTES as u64 {
        return Err(logo_error_message(LogoError::TooLarge));
    }
    let data = std::fs::read(path)
        .map_err(|_| tr::editor::window::organization::error::logo_read_failed())?;
    let content_type = org::validate_logo(&data).map_err(logo_error_message)?;
    let preview = org::decode_logo(&data).ok();
    Ok((content_type, data, preview))
}
