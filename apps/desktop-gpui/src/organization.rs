//! Organization data for the editor's organization dropdown and brand colours.
//!
//! The cache is the `auth.organizations` array `auth::update_auth_plan` writes
//! from `GET /api/desktop/organizations`, the same raw JSON the Tauri app kept.
//! The selected organization is `recording_settings.organizationId`, which
//! Instant recordings already upload into. Branding edits go to
//! `PATCH /api/desktop/organizations/:id/branding`.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use gpui::RenderImage;
use serde_json::{Map, Value, json};

use crate::auth::{self, AuthApiError};
use crate::store;

pub const LOGO_MAX_BYTES: usize = 1024 * 1024;
const LOGO_DOWNLOAD_MAX_BYTES: usize = 5 * 1024 * 1024;
const LOGO_DISPLAY_MAX_PX: u32 = 128;
pub const REFRESH_AFTER_SECS: i64 = 45 * 60;
pub const RETRY_AFTER: Duration = Duration::from_secs(60);
const SELECTED_ORGANIZATION_KEY: &str = "organizationId";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BrandColorKey {
    Primary,
    Secondary,
    Accent,
    Background,
}

impl BrandColorKey {
    pub const ALL: [Self; 4] = [
        Self::Primary,
        Self::Secondary,
        Self::Accent,
        Self::Background,
    ];

    fn index(self) -> usize {
        match self {
            Self::Primary => 0,
            Self::Secondary => 1,
            Self::Accent => 2,
            Self::Background => 3,
        }
    }

    fn json_key(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::Secondary => "secondary",
            Self::Accent => "accent",
            Self::Background => "background",
        }
    }

    pub fn default_color(self) -> [u8; 3] {
        match self {
            Self::Primary => [0x47, 0x85, 0xFF],
            Self::Secondary => [0xFF, 0xFF, 0xFF],
            Self::Accent => [0xFF, 0x47, 0x66],
            Self::Background => [0x00, 0x00, 0x00],
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BrandColors([Option<[u8; 3]>; 4]);

impl BrandColors {
    pub fn get(&self, key: BrandColorKey) -> Option<[u8; 3]> {
        self.0[key.index()]
    }

    pub fn set(&mut self, key: BrandColorKey, color: Option<[u8; 3]>) {
        self.0[key.index()] = color;
    }

    pub fn from_json(value: Option<&Value>) -> Self {
        let mut colors = Self::default();
        let Some(object) = value.and_then(Value::as_object) else {
            return colors;
        };
        for key in BrandColorKey::ALL {
            colors.set(
                key,
                object
                    .get(key.json_key())
                    .and_then(Value::as_str)
                    .and_then(parse_hex),
            );
        }
        colors
    }

    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        for key in BrandColorKey::ALL {
            object.insert(
                key.json_key().into(),
                self.get(key)
                    .map_or(Value::Null, |color| Value::String(format_hex(color))),
            );
        }
        Value::Object(object)
    }

    /// The swatches the colour inputs offer, in the web's key order.
    pub fn swatches(&self) -> Vec<(BrandColorKey, [u8; 3])> {
        BrandColorKey::ALL
            .into_iter()
            .filter_map(|key| self.get(key).map(|color| (key, color)))
            .collect()
    }
}

/// `OrganizationHexColor`: exactly `#RRGGBB`.
pub fn parse_hex(value: &str) -> Option<[u8; 3]> {
    let digits = value.strip_prefix('#')?;
    if digits.len() != 6 || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).ok();
    Some([channel(0)?, channel(2)?, channel(4)?])
}

pub fn format_hex(color: [u8; 3]) -> String {
    format!("#{:02X}{:02X}{:02X}", color[0], color[1], color[2])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrganizationRole {
    Owner,
    Admin,
    Member,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Organization {
    pub id: String,
    pub name: String,
    pub role: OrganizationRole,
    pub can_edit_brand: bool,
    pub icon_url: Option<String>,
    pub brand_colors: BrandColors,
}

impl Organization {
    pub fn from_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let id = object.get("id")?.as_str()?.trim();
        if id.is_empty() {
            return None;
        }
        let role = match object.get("role").and_then(Value::as_str) {
            Some("owner") => OrganizationRole::Owner,
            Some("admin") => OrganizationRole::Admin,
            _ => OrganizationRole::Member,
        };
        Some(Self {
            id: id.to_string(),
            name: object
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            role,
            can_edit_brand: object
                .get("canEditBrand")
                .and_then(Value::as_bool)
                .unwrap_or_else(|| role_can_edit_brand(role)),
            icon_url: object
                .get("iconUrl")
                .and_then(Value::as_str)
                .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
                .map(str::to_string),
            brand_colors: BrandColors::from_json(object.get("brandColors")),
        })
    }

    pub fn initial(&self) -> String {
        self.name
            .chars()
            .next()
            .map(|first| first.to_uppercase().collect())
            .unwrap_or_else(|| "?".into())
    }
}

/// `canEditOrganizationBranding` on the web: owners and admins only. Used when
/// a cache written before `canEditBrand` existed has only the role.
pub fn role_can_edit_brand(role: OrganizationRole) -> bool {
    matches!(role, OrganizationRole::Owner | OrganizationRole::Admin)
}

pub fn parse_organizations(value: &Value) -> Vec<Organization> {
    value
        .as_array()
        .map(|entries| entries.iter().filter_map(Organization::from_json).collect())
        .unwrap_or_default()
}

/// `getSelectedOrganizationId`: the stored id while it is still one of the
/// user's organizations (or while the list is not known), otherwise the first.
pub fn resolve_selected_id(organizations: &[Organization], stored: Option<&str>) -> Option<String> {
    if let Some(stored) = stored
        && (organizations.is_empty() || organizations.iter().any(|org| org.id == stored))
    {
        return Some(stored.to_string());
    }
    organizations.first().map(|org| org.id.clone())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Availability {
    SignedOut,
    Loading,
    Available,
    Unavailable,
}

/// What the dropdown shows. A cached list is shown even when it is old or the
/// network is down: brand colours keep working offline.
pub fn availability(signed_in: bool, cached: bool, refreshing: bool) -> Availability {
    match (signed_in, cached, refreshing) {
        (false, _, _) => Availability::SignedOut,
        (true, true, _) => Availability::Available,
        (true, false, true) => Availability::Loading,
        (true, false, false) => Availability::Unavailable,
    }
}

/// The Tauri cadence: refetch once the cache is 45 minutes old, and wait a
/// minute after a failed attempt before trying again.
pub fn should_refresh(
    signed_in: bool,
    updated_at: Option<i64>,
    now: i64,
    failed_recently: bool,
) -> bool {
    if !signed_in || failed_recently {
        return false;
    }
    updated_at.is_none_or(|updated_at| now.saturating_sub(updated_at) >= REFRESH_AFTER_SECS)
}

/// Brand colours are saved as a whole set. Keys the user did not touch take
/// the server's latest value, so saving here never reverts a colour another
/// device changed since this dialog opened.
pub fn merge_brand_edit(
    base: &BrandColors,
    edited: &BrandColors,
    latest: &BrandColors,
) -> BrandColors {
    let mut merged = *latest;
    for key in BrandColorKey::ALL {
        if edited.get(key) != base.get(key) {
            merged.set(key, edited.get(key));
        }
    }
    merged
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LogoEdit {
    Keep,
    Remove,
    Upload {
        content_type: &'static str,
        data: Vec<u8>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogoError {
    Empty,
    TooLarge,
    Unsupported,
}

/// The server's `isImageDataForContentType`, run before upload so a wrong
/// file fails here rather than after a 1MB round trip.
pub fn sniff_logo_content_type(data: &[u8]) -> Option<&'static str> {
    let ascii_at =
        |offset: usize, value: &[u8]| data.get(offset..offset + value.len()) == Some(value);
    if data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        Some("image/png")
    } else if data.starts_with(&[255, 216, 255]) {
        Some("image/jpeg")
    } else if data.len() >= 12 && ascii_at(0, b"RIFF") && ascii_at(8, b"WEBP") {
        Some("image/webp")
    } else if ascii_at(0, b"GIF87a") || ascii_at(0, b"GIF89a") {
        Some("image/gif")
    } else if data.len() >= 12
        && ascii_at(4, b"ftyp")
        && (ascii_at(8, b"avif") || ascii_at(8, b"avis"))
    {
        Some("image/avif")
    } else {
        None
    }
}

pub fn validate_logo(data: &[u8]) -> Result<&'static str, LogoError> {
    if data.is_empty() {
        return Err(LogoError::Empty);
    }
    if data.len() > LOGO_MAX_BYTES {
        return Err(LogoError::TooLarge);
    }
    sniff_logo_content_type(data).ok_or(LogoError::Unsupported)
}

pub fn branding_patch_body(colors: &BrandColors, logo: &LogoEdit) -> Value {
    let logo = match logo {
        LogoEdit::Keep => json!({ "action": "keep" }),
        LogoEdit::Remove => json!({ "action": "remove" }),
        LogoEdit::Upload { content_type, data } => json!({
            "action": "upload",
            "contentType": content_type,
            "data": base64::engine::general_purpose::STANDARD.encode(data),
        }),
    };
    json!({ "brandColors": colors.to_json(), "logo": logo })
}

// -- The store -----------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct OrganizationSnapshot {
    pub signed_in: bool,
    /// `auth.organizations` is an array, even an empty one.
    pub cached: bool,
    pub updated_at: Option<i64>,
    pub organizations: Vec<Organization>,
    pub selected_id: Option<String>,
}

impl OrganizationSnapshot {
    pub fn load() -> Self {
        let signed_in = store::auth_snapshot().signed_in();
        let auth = store::store_section("auth");
        let stored = stored_selected_id();
        Self::from_parts(signed_in, &auth, stored.as_deref())
    }

    pub fn from_parts(signed_in: bool, auth: &Map<String, Value>, stored: Option<&str>) -> Self {
        if !signed_in {
            return Self::default();
        }
        let list = auth.get("organizations");
        let organizations = list.map(parse_organizations).unwrap_or_default();
        let selected_id = resolve_selected_id(&organizations, stored);
        Self {
            signed_in,
            cached: list.is_some_and(Value::is_array),
            updated_at: auth.get("organizations_updated_at").and_then(Value::as_i64),
            organizations,
            selected_id,
        }
    }

    pub fn selected(&self) -> Option<&Organization> {
        let id = self.selected_id.as_deref()?;
        self.organizations.iter().find(|org| org.id == id)
    }

    pub fn find(&self, id: &str) -> Option<&Organization> {
        self.organizations.iter().find(|org| org.id == id)
    }
}

pub fn stored_selected_id() -> Option<String> {
    store::store_section(store::RECORDING_SETTINGS)
        .get(SELECTED_ORGANIZATION_KEY)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

/// Where Instant recordings and, through the export dialog, new shares go.
pub fn persist_selected_id(id: &str) -> bool {
    store::set_store_setting(
        store::RECORDING_SETTINGS,
        SELECTED_ORGANIZATION_KEY,
        Value::String(id.to_string()),
    )
}

fn session_identity(auth: &Map<String, Value>) -> Option<(Value, Value)> {
    Some((auth.get("user_id")?.clone(), auth.get("secret")?.clone()))
}

/// Replace the cached list with `organizations`, but only if the session that
/// fetched it is still the one signed in.
fn write_cached_organizations(identity: &Option<(Value, Value)>, organizations: Vec<Value>) {
    let written = store::update_store_section("auth", |auth| {
        if identity.is_none() || session_identity(auth) != *identity {
            return false;
        }
        auth.insert("organizations".into(), Value::Array(organizations));
        auth.insert(
            "organizations_updated_at".into(),
            json!(chrono::Utc::now().timestamp() as i32),
        );
        true
    });
    if !written {
        tracing::warn!(
            "organization cache not updated; the session changed or the store is unwritable"
        );
    }
}

/// Replace `updated` in `organizations` by id, appending it if it is new.
pub fn merge_organization(mut organizations: Vec<Value>, updated: Value) -> Vec<Value> {
    let id = updated
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string);
    match organizations
        .iter_mut()
        .find(|entry| entry.get("id").and_then(Value::as_str) == id.as_deref())
    {
        Some(entry) => *entry = updated,
        None => organizations.push(updated),
    }
    organizations
}

// -- The API -------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BrandingError {
    SignedOut,
    Offline,
    NotFound,
    Forbidden,
    Rejected(String),
    Failed,
}

impl From<AuthApiError> for BrandingError {
    fn from(error: AuthApiError) -> Self {
        match error {
            AuthApiError::InvalidAuthentication => Self::SignedOut,
            AuthApiError::Timeout | AuthApiError::Other(_) => Self::Offline,
            AuthApiError::UpgradeRequired | AuthApiError::Status(..) => Self::Failed,
        }
    }
}

fn encode_path_segment(segment: &str) -> String {
    segment
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

async fn fetch_organizations_json() -> Result<Vec<Value>, BrandingError> {
    let response =
        auth::authed_request(reqwest::Method::GET, "/api/desktop/organizations", None).await?;
    if !response.status().is_success() {
        tracing::warn!("organizations fetch returned {}", response.status());
        return Err(BrandingError::Failed);
    }
    match response.json::<Value>().await {
        Ok(Value::Array(entries)) => Ok(entries),
        _ => Err(BrandingError::Failed),
    }
}

/// Save branding the way the Tauri dialog did, with one addition: the latest
/// colours are fetched first and merged, so two devices editing different
/// keys both keep their change. A role revoked since the cache was written
/// fails here as Forbidden instead of as a confusing server error.
pub async fn save_branding(
    organization_id: String,
    base: BrandColors,
    edited: BrandColors,
    logo: LogoEdit,
) -> Result<Organization, BrandingError> {
    let identity = session_identity(&store::store_section("auth"));
    let latest_list = fetch_organizations_json().await?;
    let latest = latest_list
        .iter()
        .filter_map(Organization::from_json)
        .find(|org| org.id == organization_id)
        .ok_or(BrandingError::NotFound)?;
    if !latest.can_edit_brand {
        write_cached_organizations(&identity, latest_list);
        return Err(BrandingError::Forbidden);
    }

    let colors = merge_brand_edit(&base, &edited, &latest.brand_colors);
    let path = format!(
        "/api/desktop/organizations/{}/branding",
        encode_path_segment(&organization_id)
    );
    let response = auth::authed_request(
        reqwest::Method::PATCH,
        &path,
        Some(branding_patch_body(&colors, &logo)),
    )
    .await?;
    let status = response.status();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let message = body
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string);
        return Err(match status.as_u16() {
            403 => BrandingError::Forbidden,
            404 => BrandingError::NotFound,
            400 => message.map_or(BrandingError::Failed, BrandingError::Rejected),
            _ => BrandingError::Failed,
        });
    }
    let organization = Organization::from_json(&body).ok_or(BrandingError::Failed)?;
    write_cached_organizations(&identity, merge_organization(latest_list, body));
    Ok(organization)
}

/// Download and decode an organization logo. `iconUrl` is a storage URL, not
/// a Cap API route, so it is fetched without the session token.
pub async fn fetch_logo(url: String) -> Result<Arc<RenderImage>, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("logo fetch returned {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > LOGO_DOWNLOAD_MAX_BYTES as u64)
    {
        return Err("logo is too large".into());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > LOGO_DOWNLOAD_MAX_BYTES {
        return Err("logo is too large".into());
    }
    decode_logo(&bytes)
}

pub fn decode_logo(bytes: &[u8]) -> Result<Arc<RenderImage>, String> {
    let image = image::load_from_memory(bytes).map_err(|error| error.to_string())?;
    let image = if image.width() > LOGO_DISPLAY_MAX_PX || image.height() > LOGO_DISPLAY_MAX_PX {
        image.thumbnail(LOGO_DISPLAY_MAX_PX, LOGO_DISPLAY_MAX_PX)
    } else {
        image
    };
    Ok(crate::library::rgba_to_render_image(image.into_rgba8()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn org(id: &str) -> Organization {
        Organization::from_json(&json!({ "id": id, "name": id })).unwrap()
    }

    #[test]
    fn parses_the_desktop_organization_contract() {
        let parsed = Organization::from_json(&json!({
            "id": "org_1",
            "name": "  Acme  ",
            "ownerId": "user_1",
            "role": "admin",
            "canEditBrand": true,
            "iconUrl": "https://cdn.example.com/organizations/org_1/logo.png",
            "brandColors": {
                "primary": "#4785ff",
                "secondary": null,
                "accent": "#FF4766",
                "background": "not-a-colour"
            }
        }))
        .unwrap();
        assert_eq!(parsed.id, "org_1");
        assert_eq!(parsed.name, "Acme");
        assert_eq!(parsed.role, OrganizationRole::Admin);
        assert!(parsed.can_edit_brand);
        assert_eq!(
            parsed.icon_url.as_deref(),
            Some("https://cdn.example.com/organizations/org_1/logo.png")
        );
        assert_eq!(
            parsed.brand_colors.swatches(),
            vec![
                (BrandColorKey::Primary, [0x47, 0x85, 0xFF]),
                (BrandColorKey::Accent, [0xFF, 0x47, 0x66]),
            ]
        );
        assert_eq!(parsed.initial(), "A");
    }

    #[test]
    fn rejects_entries_without_an_id_and_tolerates_missing_fields() {
        assert!(Organization::from_json(&json!({ "name": "No id" })).is_none());
        assert!(Organization::from_json(&json!({ "id": "  " })).is_none());
        assert!(Organization::from_json(&json!("org")).is_none());

        let bare = Organization::from_json(&json!({ "id": "org_2" })).unwrap();
        assert_eq!(bare.name, "");
        assert_eq!(bare.initial(), "?");
        assert_eq!(bare.role, OrganizationRole::Member);
        assert!(!bare.can_edit_brand);
        assert_eq!(bare.icon_url, None);
        assert!(bare.brand_colors.swatches().is_empty());

        let list = parse_organizations(&json!([{ "id": "a" }, 7, { "name": "x" }, { "id": "b" }]));
        assert_eq!(
            list.iter().map(|org| org.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(parse_organizations(&json!({ "id": "a" })).is_empty());
    }

    #[test]
    fn only_web_and_storage_logo_urls_are_fetched() {
        for url in [
            "file:///etc/passwd",
            "data:image/png;base64,AAAA",
            "organizations/key.png",
            "",
        ] {
            let parsed = Organization::from_json(&json!({ "id": "o", "iconUrl": url })).unwrap();
            assert_eq!(parsed.icon_url, None, "{url}");
        }
    }

    #[test]
    fn edit_rights_follow_the_web_roles() {
        let with_role = |role: &str| {
            Organization::from_json(&json!({ "id": "o", "role": role }))
                .unwrap()
                .can_edit_brand
        };
        assert!(with_role("owner"));
        assert!(with_role("admin"));
        assert!(!with_role("member"));
        assert!(!with_role("guest"));

        // The server's flag wins over the role when it is present.
        let revoked = Organization::from_json(&json!({
            "id": "o",
            "role": "admin",
            "canEditBrand": false
        }))
        .unwrap();
        assert!(!revoked.can_edit_brand);
        let member = Organization::from_json(&json!({
            "id": "o",
            "role": "member",
            "canEditBrand": false
        }))
        .unwrap();
        assert!(!member.can_edit_brand);
    }

    #[test]
    fn hex_round_trips_only_the_contract_shape() {
        assert_eq!(parse_hex("#00ff7F"), Some([0, 255, 127]));
        assert_eq!(format_hex([0, 255, 127]), "#00FF7F");
        for bad in [
            "00FF7F",
            "#0F0",
            "#00FF7F80",
            "#GGGGGG",
            "#00FF7",
            " #00FF7F",
            "#ééé",
        ] {
            assert_eq!(parse_hex(bad), None, "{bad}");
        }
    }

    #[test]
    fn brand_colours_serialise_every_key() {
        let mut colors = BrandColors::default();
        colors.set(BrandColorKey::Accent, Some([1, 2, 3]));
        assert_eq!(
            colors.to_json(),
            json!({ "primary": null, "secondary": null, "accent": "#010203", "background": null })
        );
        assert_eq!(BrandColors::from_json(Some(&colors.to_json())), colors);
        assert_eq!(BrandColors::from_json(None), BrandColors::default());
    }

    #[test]
    fn selection_keeps_a_valid_choice_and_falls_back_to_the_first() {
        let orgs = vec![org("personal"), org("team"), org("client")];
        assert_eq!(
            resolve_selected_id(&orgs, Some("team")).as_deref(),
            Some("team")
        );
        assert_eq!(
            resolve_selected_id(&orgs, Some("left-this-org")).as_deref(),
            Some("personal")
        );
        assert_eq!(
            resolve_selected_id(&orgs, None).as_deref(),
            Some("personal")
        );
        // The list is unknown (never fetched, offline): the choice survives.
        assert_eq!(
            resolve_selected_id(&[], Some("team")).as_deref(),
            Some("team")
        );
        assert_eq!(resolve_selected_id(&[], None), None);

        let single = vec![org("personal")];
        assert_eq!(
            resolve_selected_id(&single, None).as_deref(),
            Some("personal")
        );
    }

    #[test]
    fn availability_shows_a_cached_list_even_when_refreshing_or_offline() {
        use Availability::*;
        assert_eq!(availability(false, true, true), SignedOut);
        assert_eq!(availability(true, true, false), Available);
        assert_eq!(availability(true, true, true), Available);
        assert_eq!(availability(true, false, true), Loading);
        assert_eq!(availability(true, false, false), Unavailable);
    }

    #[test]
    fn refreshes_a_stale_cache_and_backs_off_after_a_failure() {
        let now = 10_000_000;
        assert!(!should_refresh(false, None, now, false));
        assert!(should_refresh(true, None, now, false));
        assert!(!should_refresh(true, None, now, true));
        assert!(!should_refresh(true, Some(now - 60), now, false));
        assert!(should_refresh(
            true,
            Some(now - REFRESH_AFTER_SECS),
            now,
            false
        ));
        // A clock that moved backwards does not hot-loop.
        assert!(!should_refresh(true, Some(now + 600), now, false));
    }

    #[test]
    fn a_save_only_overwrites_the_keys_this_device_changed() {
        let mut base = BrandColors::default();
        base.set(BrandColorKey::Primary, Some([1, 1, 1]));
        base.set(BrandColorKey::Accent, Some([2, 2, 2]));

        let mut edited = base;
        edited.set(BrandColorKey::Primary, Some([9, 9, 9]));
        edited.set(BrandColorKey::Accent, None);

        let mut latest = base;
        latest.set(BrandColorKey::Secondary, Some([5, 5, 5]));
        latest.set(BrandColorKey::Primary, Some([7, 7, 7]));

        let merged = merge_brand_edit(&base, &edited, &latest);
        assert_eq!(merged.get(BrandColorKey::Primary), Some([9, 9, 9]));
        assert_eq!(merged.get(BrandColorKey::Secondary), Some([5, 5, 5]));
        assert_eq!(merged.get(BrandColorKey::Accent), None);
        assert_eq!(merged.get(BrandColorKey::Background), None);

        // Nothing edited: the server's colours go back unchanged.
        assert_eq!(merge_brand_edit(&base, &base, &latest), latest);
    }

    #[test]
    fn logo_checks_match_the_server() {
        let png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0];
        assert_eq!(validate_logo(&png), Ok("image/png"));
        assert_eq!(validate_logo(&[255, 216, 255, 224]), Ok("image/jpeg"));
        assert_eq!(validate_logo(b"RIFF\0\0\0\0WEBPVP8 "), Ok("image/webp"));
        assert_eq!(validate_logo(b"GIF89a.."), Ok("image/gif"));
        assert_eq!(validate_logo(b"\0\0\0\x1cftypavif"), Ok("image/avif"));
        assert_eq!(validate_logo(b"<svg></svg>"), Err(LogoError::Unsupported));
        assert_eq!(validate_logo(b"RIFF"), Err(LogoError::Unsupported));
        assert_eq!(validate_logo(&[]), Err(LogoError::Empty));
        let mut big = png.to_vec();
        big.resize(LOGO_MAX_BYTES + 1, 0);
        assert_eq!(validate_logo(&big), Err(LogoError::TooLarge));
        big.truncate(LOGO_MAX_BYTES);
        assert_eq!(validate_logo(&big), Ok("image/png"));
    }

    #[test]
    fn patch_body_matches_organization_branding_patch_body() {
        let mut colors = BrandColors::default();
        colors.set(BrandColorKey::Primary, Some([0x47, 0x85, 0xFF]));
        assert_eq!(
            branding_patch_body(&colors, &LogoEdit::Keep),
            json!({
                "brandColors": { "primary": "#4785FF", "secondary": null, "accent": null, "background": null },
                "logo": { "action": "keep" }
            })
        );
        assert_eq!(
            branding_patch_body(&colors, &LogoEdit::Remove)["logo"],
            json!({ "action": "remove" })
        );
        assert_eq!(
            branding_patch_body(
                &colors,
                &LogoEdit::Upload {
                    content_type: "image/png",
                    data: vec![1, 2, 3],
                },
            )["logo"],
            json!({ "action": "upload", "contentType": "image/png", "data": "AQID" })
        );
    }

    #[test]
    fn organization_ids_are_escaped_in_the_path() {
        assert_eq!(encode_path_segment("org_AZ-09.~"), "org_AZ-09.~");
        assert_eq!(encode_path_segment("a/../b?c"), "a%2F..%2Fb%3Fc");
    }

    #[test]
    fn merging_a_saved_organization_replaces_it_in_place() {
        let list = vec![
            json!({ "id": "a", "name": "A" }),
            json!({ "id": "b", "name": "B" }),
        ];
        let merged = merge_organization(list.clone(), json!({ "id": "b", "name": "B2" }));
        assert_eq!(
            merged,
            vec![
                json!({ "id": "a", "name": "A" }),
                json!({ "id": "b", "name": "B2" })
            ]
        );
        let appended = merge_organization(list, json!({ "id": "c" }));
        assert_eq!(appended.len(), 3);
    }

    #[test]
    fn snapshot_reads_the_auth_cache_and_the_stored_choice() {
        let auth = json!({
            "organizations": [
                { "id": "personal", "name": "Me", "role": "owner", "canEditBrand": true },
                { "id": "team", "name": "Team", "role": "member", "canEditBrand": false,
                  "brandColors": { "primary": "#112233" } }
            ],
            "organizations_updated_at": 1_700_000_000
        });
        let auth = auth.as_object().unwrap();

        let snapshot = OrganizationSnapshot::from_parts(true, auth, Some("team"));
        assert!(snapshot.cached);
        assert_eq!(snapshot.updated_at, Some(1_700_000_000));
        let selected = snapshot.selected().unwrap();
        assert_eq!(selected.id, "team");
        assert!(!selected.can_edit_brand);
        assert_eq!(
            selected.brand_colors.swatches(),
            vec![(BrandColorKey::Primary, [0x11, 0x22, 0x33])]
        );

        let signed_out = OrganizationSnapshot::from_parts(false, auth, Some("team"));
        assert!(signed_out.organizations.is_empty());
        assert!(signed_out.selected().is_none());

        let never_fetched = OrganizationSnapshot::from_parts(true, &Map::new(), Some("team"));
        assert!(!never_fetched.cached);
        assert!(never_fetched.selected().is_none());
        assert_eq!(never_fetched.selected_id.as_deref(), Some("team"));
    }

    #[test]
    fn the_selected_organization_lives_in_recording_settings() {
        let path =
            std::env::temp_dir().join(format!("cap-gpui-organization-test-{}", std::process::id()));
        std::fs::write(
            &path,
            r#"{"recording_settings":{"mode":"studio"},"auth":{"secret":{"token":"t"}}}"#,
        )
        .unwrap();
        store::set_test_tauri_store_path(Some(path.clone()));
        assert_eq!(stored_selected_id(), None);
        assert!(persist_selected_id("team"));
        assert_eq!(stored_selected_id().as_deref(), Some("team"));
        let written: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["recording_settings"]["mode"], "studio");
        assert_eq!(written["recording_settings"]["organizationId"], "team");
        assert_eq!(written["auth"]["secret"]["token"], "t");
        store::set_test_tauri_store_path(None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn decodes_a_logo_and_bounds_its_size() {
        let mut png = Vec::new();
        image::DynamicImage::new_rgba8(600, 300)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let decoded = decode_logo(&png).unwrap();
        let size = decoded.size(0);
        assert_eq!((size.width.0, size.height.0), (128, 64));
        assert!(decode_logo(b"not an image").is_err());
    }
}
