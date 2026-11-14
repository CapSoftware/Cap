use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SUPPORTED_API_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAsset {
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
}

impl CatalogAsset {
    pub fn extension(&self) -> &str {
        self.url
            .rsplit_once('.')
            .map(|(_, extension)| extension)
            .filter(|extension| matches!(*extension, "png" | "jpg" | "webp"))
            .unwrap_or("bin")
    }

    pub fn is_valid_hash(&self) -> bool {
        self.sha256.len() == 64 && self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub name: String,
    pub github: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CatalogBackground {
    Image {
        id: String,
        name: String,
        image: CatalogAsset,
    },
    Gradient {
        id: String,
        name: String,
        from: String,
        to: String,
        angle: u16,
    },
    Color {
        id: String,
        name: String,
        color: String,
    },
}

impl CatalogBackground {
    pub fn id(&self) -> &str {
        match self {
            Self::Image { id, .. } | Self::Gradient { id, .. } | Self::Color { id, .. } => id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Image { name, .. } | Self::Gradient { name, .. } | Self::Color { name, .. } => {
                name
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionStyle {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub font_weight: u32,
    pub size: u32,
    pub color: String,
    pub background_color: String,
    pub background_opacity: u32,
    pub outline: bool,
    pub outline_color: String,
    pub highlight_color: String,
    pub active_word_highlight: bool,
    pub highlight_style: String,
    pub animation: String,
    pub uppercase: bool,
    pub fade_duration: f32,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LookValues {
    pub intensity: Option<f32>,
    pub exposure: Option<f32>,
    pub contrast: Option<f32>,
    pub saturation: Option<f32>,
    pub temperature: Option<f32>,
    pub tint: Option<f32>,
    pub fade: Option<f32>,
    pub split_tone: Option<f32>,
    pub vignette: Option<f32>,
    pub grain: Option<f32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColorLook {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub values: LookValues,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionAction {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingField {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub label: String,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogConnection {
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub settings: Vec<SettingField>,
    #[serde(default)]
    pub actions: Vec<ConnectionAction>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogApp {
    pub api_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: Author,
    pub first_party: bool,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    pub icon: CatalogAsset,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub builtin: Option<String>,
    #[serde(default)]
    pub backgrounds: Vec<CatalogBackground>,
    #[serde(default)]
    pub caption_styles: Vec<CaptionStyle>,
    #[serde(default)]
    pub color_looks: Vec<ColorLook>,
    #[serde(default)]
    pub connection: Option<CatalogConnection>,
    pub content_hash: String,
}

impl CatalogApp {
    pub fn has_content(&self) -> bool {
        !self.backgrounds.is_empty()
            || !self.caption_styles.is_empty()
            || !self.color_looks.is_empty()
    }

    pub fn runs_on_desktop(&self) -> bool {
        self.platforms.iter().any(|platform| platform == "desktop")
    }

    pub fn needs_web_setup(&self) -> bool {
        self.builtin.is_some()
            || self
                .connection
                .as_ref()
                .is_some_and(|connection| connection.settings.iter().any(|field| field.required))
    }

    pub fn image_assets(&self) -> impl Iterator<Item = &CatalogAsset> {
        self.backgrounds
            .iter()
            .filter_map(|background| match background {
                CatalogBackground::Image { image, .. } => Some(image),
                _ => None,
            })
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Catalog {
    pub revision: String,
    pub apps: Vec<CatalogApp>,
    pub blocked: Vec<String>,
}

impl Catalog {
    /// Each app is read on its own, so one this build does not understand,
    /// for example from a newer API version, is skipped instead of hiding the
    /// whole store.
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        if object.get("catalogVersion").and_then(Value::as_u64) != Some(1) {
            return None;
        }
        let revision = object.get("revision")?.as_str()?.to_string();
        let blocked: Vec<String> = object
            .get("blocked")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| entry.get("id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let apps = object
            .get("apps")
            .and_then(Value::as_array)
            .map(|apps| {
                apps.iter()
                    .filter_map(|app| serde_json::from_value::<CatalogApp>(app.clone()).ok())
                    .filter(|app| app.api_version <= SUPPORTED_API_VERSION)
                    .filter(|app| !blocked.contains(&app.id))
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            revision,
            apps,
            blocked,
        })
    }

    pub fn app(&self, id: &str) -> Option<&CatalogApp> {
        self.apps.iter().find(|app| app.id == id)
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    pub id: String,
    pub app_id: String,
    pub scope: String,
    #[serde(default)]
    pub organization_name: Option<String>,
    pub status: String,
    #[serde(default)]
    pub needs_review: bool,
    #[serde(default)]
    pub can_manage: bool,
}

impl Installation {
    pub fn is_active(&self) -> bool {
        self.status == "active"
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct InstallationsResponse {
    pub installations: Vec<Installation>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ActionResult {
    Toast {
        message: String,
    },
    Open {
        url: String,
        #[serde(default)]
        message: Option<String>,
    },
}

impl ActionResult {
    pub fn open_url(&self) -> Option<&str> {
        match self {
            Self::Open { url, .. } if url.starts_with("https://") => Some(url),
            _ => None,
        }
    }

    pub fn message(&self) -> Option<&str> {
        match self {
            Self::Toast { message } => Some(message),
            Self::Open { message, .. } => message.as_deref(),
        }
    }
}

/// The Cap id from a share link: the segment after `/s/`.
pub fn cap_id_from_share_url(url: &str) -> Option<String> {
    let (_, rest) = url.split_once("/s/")?;
    let id = rest
        .split(['?', '#', '/'])
        .next()
        .filter(|id| !id.is_empty())?;
    id.chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
        .then(|| id.to_string())
}
