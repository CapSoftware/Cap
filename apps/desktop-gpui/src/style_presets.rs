use cap_project::{
    BackgroundConfiguration, Camera, CaptionSettings, CursorConfiguration, MaskKind, MaskSegment,
    ProjectConfiguration, StyleOverrides,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

use crate::editor_panels::{
    TEXT_FONT_SIZE_MAX, TEXT_FONT_SIZE_MIN, TextStyle, encode_mask_effect, mask_effect,
    mask_effect_amount,
};

pub const STORE_SECTION: &str = "stylePresets";
pub const STORE_VERSION: u64 = 1;
pub const NAME_MAX_CHARS: usize = 64;
const FONT_FAMILY_MAX_CHARS: usize = 128;
const GENERIC_FAMILIES: [&str; 3] = ["sans-serif", "serif", "monospace"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PresetKind {
    Text,
    Mask,
    Captions,
    Style,
}

impl PresetKind {
    pub const fn key(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Mask => "mask",
            Self::Captions => "captions",
            Self::Style => "style",
        }
    }
}

pub trait PresetStyle: Serialize + DeserializeOwned + Default + Clone + PartialEq {
    const KIND: PresetKind;

    fn sanitize(&mut self) {}
}

#[derive(Debug, Clone, PartialEq)]
pub struct StylePreset<S> {
    pub id: String,
    pub name: String,
    pub style: S,
    extra: Map<String, Value>,
    stored_style: Map<String, Value>,
}

impl<S: PresetStyle> StylePreset<S> {
    fn new(id: String, name: String, style: S) -> Self {
        let stored_style = style_map(&style);
        Self {
            id,
            name,
            style,
            extra: Map::new(),
            stored_style,
        }
    }

    fn from_value(value: &Value, position: usize) -> Option<Self> {
        let entry = value.as_object()?;
        let name = clean_name(entry.get("name")?.as_str()?)?;
        let stored_style = entry.get("style")?.as_object()?.clone();
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map_or_else(|| format!("legacy-{position}"), str::to_string);
        let mut extra = entry.clone();
        for key in ["id", "name", "style"] {
            extra.remove(key);
        }
        Some(Self {
            id,
            name,
            style: decode_style(&stored_style),
            extra,
            stored_style,
        })
    }

    fn to_value(&self) -> Value {
        let mut entry = self.extra.clone();
        entry.insert("id".into(), Value::String(self.id.clone()));
        entry.insert("name".into(), Value::String(self.name.clone()));
        entry.insert("style".into(), Value::Object(self.stored_style.clone()));
        Value::Object(entry)
    }

    fn set_style(&mut self, style: S) {
        self.stored_style = style_map(&style);
        self.style = style;
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StylePresets<S> {
    presets: Vec<StylePreset<S>>,
    default: Option<String>,
    unreadable: Vec<Value>,
    extra: Map<String, Value>,
}

impl<S> Default for StylePresets<S> {
    fn default() -> Self {
        Self {
            presets: Vec::new(),
            default: None,
            unreadable: Vec::new(),
            extra: Map::new(),
        }
    }
}

impl<S: PresetStyle> StylePresets<S> {
    pub fn load() -> Self {
        Self::from_section(&crate::store::store_section(STORE_SECTION))
    }

    pub fn from_section(section: &Map<String, Value>) -> Self {
        section
            .get(S::KIND.key())
            .map(Self::from_value)
            .unwrap_or_default()
    }

    pub fn from_value(value: &Value) -> Self {
        let empty = Vec::new();
        let (entries, default, extra) = match value {
            Value::Object(map) => {
                let mut extra = map.clone();
                extra.remove("presets");
                extra.remove("default");
                (
                    map.get("presets")
                        .and_then(Value::as_array)
                        .unwrap_or(&empty),
                    map.get("default"),
                    extra,
                )
            }
            Value::Array(entries) => (entries, None, Map::new()),
            _ => (&empty, None, Map::new()),
        };

        let mut presets: Vec<StylePreset<S>> = Vec::with_capacity(entries.len());
        let mut unreadable = Vec::new();
        let mut positions = Vec::with_capacity(entries.len());
        for (position, entry) in entries.iter().enumerate() {
            match StylePreset::<S>::from_value(entry, position) {
                Some(mut preset) => {
                    let base = preset.id.clone();
                    let mut suffix = position;
                    while presets.iter().any(|existing| existing.id == preset.id) {
                        preset.id = format!("{base}-{suffix}");
                        suffix += 1;
                    }
                    positions.push((position, preset.id.clone()));
                    presets.push(preset);
                }
                None => unreadable.push(entry.clone()),
            }
        }

        let default = match default {
            Some(Value::String(id)) if !id.trim().is_empty() => Some(id.trim().to_string()),
            Some(Value::Number(index)) => index
                .as_u64()
                .and_then(|index| usize::try_from(index).ok())
                .and_then(|index| {
                    positions
                        .iter()
                        .find(|(position, _)| *position == index)
                        .map(|(_, id)| id.clone())
                }),
            _ => None,
        };

        Self {
            presets,
            default,
            unreadable,
            extra,
        }
    }

    pub fn to_value(&self) -> Value {
        let mut map = self.extra.clone();
        map.insert(
            "presets".into(),
            Value::Array(
                self.presets
                    .iter()
                    .map(StylePreset::to_value)
                    .chain(self.unreadable.iter().cloned())
                    .collect(),
            ),
        );
        map.insert(
            "default".into(),
            self.default.clone().map_or(Value::Null, Value::String),
        );
        Value::Object(map)
    }

    pub fn update<R>(mutate: impl FnOnce(&mut Self) -> R) -> Option<(Self, R)> {
        let mut outcome = None;
        let written = crate::store::update_store_section(STORE_SECTION, |section| {
            let mut presets = Self::from_section(section);
            let result = mutate(&mut presets);
            let version = section
                .get("version")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .max(STORE_VERSION);
            section.insert("version".into(), json!(version));
            section.insert(S::KIND.key().into(), presets.to_value());
            outcome = Some((presets, result));
            true
        });
        if !written {
            tracing::warn!(kind = S::KIND.key(), "the style presets could not be saved");
            return None;
        }
        outcome
    }

    pub fn presets(&self) -> &[StylePreset<S>] {
        &self.presets
    }

    pub fn is_empty(&self) -> bool {
        self.presets.is_empty()
    }

    pub fn get(&self, id: &str) -> Option<&StylePreset<S>> {
        self.presets.iter().find(|preset| preset.id == id)
    }

    pub fn position(&self, id: &str) -> Option<usize> {
        self.presets.iter().position(|preset| preset.id == id)
    }

    pub fn default_preset(&self) -> Option<&StylePreset<S>> {
        self.default.as_deref().and_then(|id| self.get(id))
    }

    pub fn default_style(&self) -> Option<&S> {
        self.default_preset().map(|preset| &preset.style)
    }

    pub fn is_default(&self, id: &str) -> bool {
        self.default_preset().is_some_and(|preset| preset.id == id)
    }

    pub fn matching(&self, style: &S) -> Option<&StylePreset<S>> {
        let default = self
            .default_preset()
            .filter(|preset| preset.style == *style);
        default.or_else(|| self.presets.iter().find(|preset| preset.style == *style))
    }

    pub fn unique_name(&self, base: &str) -> String {
        let base = clean_name(base).unwrap_or_else(|| "Preset".to_string());
        let taken = |name: &str| {
            self.presets
                .iter()
                .any(|preset| preset.name.eq_ignore_ascii_case(name))
        };
        if !taken(&base) {
            return base;
        }
        let mut suffix = 2_usize;
        loop {
            let name = format!("{base} {suffix}");
            if !taken(&name) {
                return name;
            }
            suffix += 1;
        }
    }

    pub fn add(&mut self, name: &str, mut style: S) -> Option<String> {
        let name = clean_name(name)?;
        style.sanitize();
        let mut id = crate::store::new_uuid_v4();
        while self.get(&id).is_some() {
            id = crate::store::new_uuid_v4();
        }
        self.presets.push(StylePreset::new(id.clone(), name, style));
        Some(id)
    }

    pub fn set_style(&mut self, id: &str, mut style: S) -> bool {
        style.sanitize();
        match self.presets.iter_mut().find(|preset| preset.id == id) {
            Some(preset) => {
                preset.set_style(style);
                true
            }
            None => false,
        }
    }

    pub fn rename(&mut self, id: &str, name: &str) -> bool {
        let Some(name) = clean_name(name) else {
            return false;
        };
        match self.presets.iter_mut().find(|preset| preset.id == id) {
            Some(preset) => {
                preset.name = name;
                true
            }
            None => false,
        }
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let Some(index) = self.position(id) else {
            return false;
        };
        self.presets.remove(index);
        if self.default.as_deref() == Some(id) {
            self.default = None;
        }
        true
    }

    pub fn move_to(&mut self, id: &str, target: usize) -> bool {
        let Some(index) = self.position(id) else {
            return false;
        };
        let target = target.min(self.presets.len() - 1);
        if index == target {
            return false;
        }
        let preset = self.presets.remove(index);
        self.presets.insert(target, preset);
        true
    }

    pub fn move_by(&mut self, id: &str, offset: isize) -> bool {
        let Some(index) = self.position(id) else {
            return false;
        };
        match index.checked_add_signed(offset) {
            Some(target) if target < self.presets.len() => self.move_to(id, target),
            _ => false,
        }
    }

    pub fn set_default(&mut self, id: Option<&str>) -> bool {
        match id {
            Some(id) if self.get(id).is_none() => false,
            Some(id) => {
                self.default = Some(id.to_string());
                true
            }
            None => {
                let changed = self.default_preset().is_some();
                self.default = None;
                changed
            }
        }
    }

    pub fn make_default_from(&mut self, style: S, name: &str) -> Option<String> {
        let mut style = style;
        style.sanitize();
        let id = match self.presets.iter().find(|preset| preset.style == style) {
            Some(existing) => existing.id.clone(),
            None => {
                let name = self.unique_name(name);
                self.add(&name, style)?
            }
        };
        self.set_default(Some(&id));
        Some(id)
    }
}

pub fn clean_name(name: &str) -> Option<String> {
    let collapsed = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = collapsed.chars().take(NAME_MAX_CHARS).collect();
    let trimmed = trimmed.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn style_map<S: Serialize>(style: &S) -> Map<String, Value> {
    match serde_json::to_value(style) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

pub fn decode_style<S: PresetStyle>(stored: &Map<String, Value>) -> S {
    let mut style = match serde_json::from_value::<S>(Value::Object(stored.clone())) {
        Ok(style) => style,
        Err(_) => decode_style_field_by_field(stored),
    };
    style.sanitize();
    style
}

fn decode_style_field_by_field<S: PresetStyle>(stored: &Map<String, Value>) -> S {
    let mut merged = style_map(&S::default());
    for (key, value) in stored {
        let Some(previous) = merged.get(key).cloned() else {
            continue;
        };
        merged.insert(key.clone(), value.clone());
        if serde_json::from_value::<S>(Value::Object(merged.clone())).is_err() {
            merged.insert(key.clone(), previous);
        }
    }
    serde_json::from_value(Value::Object(merged)).unwrap_or_default()
}

fn finite_f32(value: f32, fallback: f32, min: f32, max: f32) -> f32 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

fn finite_f64(value: f64, fallback: f64, min: f64, max: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

fn valid_color(value: &mut String, fallback: &str) {
    if crate::editor_sidebar::normalize_hex(value).is_none() {
        *value = fallback.to_string();
    }
}

fn valid_optional_color(value: &mut Option<String>) {
    if value
        .as_deref()
        .is_some_and(|color| crate::editor_sidebar::normalize_hex(color).is_none())
    {
        *value = None;
    }
}

fn same_json<T: Serialize>(a: &T, b: &T) -> bool {
    match (serde_json::to_value(a), serde_json::to_value(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

pub fn font_is_available(family: &str, installed: &[String]) -> bool {
    let family = family.trim();
    installed.is_empty()
        || GENERIC_FAMILIES
            .iter()
            .any(|generic| generic.eq_ignore_ascii_case(family))
        || installed
            .iter()
            .any(|name| name.eq_ignore_ascii_case(family))
}

impl Default for TextStyle {
    fn default() -> Self {
        Self::of(&crate::editor_edits::default_text_segment(0., 0., 0))
    }
}

impl TextStyle {
    pub fn for_installed_fonts(&self, installed: &[String]) -> Self {
        let mut style = self.clone();
        if !font_is_available(&style.font_family, installed) {
            style.font_family = GENERIC_FAMILIES[0].to_string();
        }
        style
    }
}

impl PresetStyle for TextStyle {
    const KIND: PresetKind = PresetKind::Text;

    fn sanitize(&mut self) {
        let fallback = Self::default();
        let family: String = self
            .font_family
            .trim()
            .chars()
            .take(FONT_FAMILY_MAX_CHARS)
            .collect();
        self.font_family = if family.is_empty() {
            fallback.font_family.clone()
        } else {
            family
        };
        self.font_size = finite_f32(
            self.font_size,
            fallback.font_size,
            TEXT_FONT_SIZE_MIN,
            TEXT_FONT_SIZE_MAX,
        );
        self.font_weight = finite_f32(self.font_weight, fallback.font_weight, 100., 900.);
        self.letter_spacing = finite_f32(self.letter_spacing, 0., -2., 20.);
        self.line_height = finite_f32(self.line_height, fallback.line_height, 0.8, 2.);
        self.opacity = finite_f32(self.opacity, 1., 0., 1.);
        self.shadow = finite_f32(self.shadow, 0., 0., 1.);
        self.glow = finite_f32(self.glow, 0., 0., 1.);
        self.stroke_width = finite_f32(self.stroke_width, 0., 0., 12.);
        self.animation_in_duration = finite_f64(
            self.animation_in_duration,
            fallback.animation_in_duration,
            0.,
            3.,
        );
        self.animation_out_duration = finite_f64(
            self.animation_out_duration,
            fallback.animation_out_duration,
            0.,
            3.,
        );
        self.fade_duration = finite_f64(self.fade_duration, fallback.fade_duration, 0., 3.);
        valid_color(&mut self.color, &fallback.color);
        valid_color(&mut self.stroke_color, &fallback.stroke_color);
        valid_optional_color(&mut self.background_color);
        valid_optional_color(&mut self.gradient_color);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MaskStyle {
    pub mask_type: MaskKind,
    pub feather: f64,
    pub opacity: f64,
    pub pixelation: f64,
    pub darkness: f64,
    pub fade_duration: f64,
}

impl PartialEq for MaskStyle {
    fn eq(&self, other: &Self) -> bool {
        matches!(
            (self.mask_type, other.mask_type),
            (MaskKind::Sensitive, MaskKind::Sensitive) | (MaskKind::Highlight, MaskKind::Highlight)
        ) && self.feather == other.feather
            && self.opacity == other.opacity
            && self.pixelation == other.pixelation
            && self.darkness == other.darkness
            && self.fade_duration == other.fade_duration
    }
}

impl Default for MaskStyle {
    fn default() -> Self {
        Self::of(&crate::editor_edits::default_mask_segment(0., 0., 0))
    }
}

impl MaskStyle {
    pub fn of(segment: &MaskSegment) -> Self {
        Self {
            mask_type: segment.mask_type,
            feather: segment.feather,
            opacity: segment.opacity,
            pixelation: segment.pixelation,
            darkness: segment.darkness,
            fade_duration: segment.fade_duration,
        }
    }

    pub fn apply_to(&self, segment: &mut MaskSegment) -> bool {
        let previous = Self::of(segment);
        let animated = !segment.keyframes.intensity.is_empty();
        if previous == *self && !animated {
            return false;
        }
        segment.keyframes.intensity.clear();
        segment.mask_type = self.mask_type;
        segment.feather = self.feather;
        segment.opacity = self.opacity;
        segment.pixelation = self.pixelation;
        segment.darkness = self.darkness;
        segment.fade_duration = self.fade_duration;
        true
    }
}

impl PresetStyle for MaskStyle {
    const KIND: PresetKind = PresetKind::Mask;

    fn sanitize(&mut self) {
        let fallback = Self::default();
        self.feather = finite_f64(self.feather, fallback.feather, 0., 1.);
        self.opacity = finite_f64(self.opacity, fallback.opacity, 0., 1.);
        self.darkness = finite_f64(self.darkness, fallback.darkness, 0., 1.);
        self.fade_duration = finite_f64(self.fade_duration, fallback.fade_duration, 0., 1.);
        let mut probe = crate::editor_edits::default_mask_segment(0., 0., 0);
        probe.pixelation = if self.pixelation.is_finite() {
            self.pixelation
        } else {
            fallback.pixelation
        };
        let encoded = encode_mask_effect(mask_effect(&probe), mask_effect_amount(&probe));
        self.pixelation = if (encoded - probe.pixelation).abs() > 1e-9 {
            encoded
        } else {
            probe.pixelation
        };
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CaptionStyle(pub CaptionSettings);

impl PartialEq for CaptionStyle {
    fn eq(&self, other: &Self) -> bool {
        same_json(&self.0, &other.0)
    }
}

impl Default for CaptionStyle {
    fn default() -> Self {
        Self::of(&CaptionSettings::default())
    }
}

impl CaptionStyle {
    pub fn of(settings: &CaptionSettings) -> Self {
        let mut settings = settings.clone();
        settings.enabled = false;
        settings.export_with_subtitles = false;
        Self(settings)
    }

    pub fn applied_to(&self, current: &CaptionSettings) -> CaptionSettings {
        CaptionSettings {
            enabled: current.enabled,
            export_with_subtitles: current.export_with_subtitles,
            ..self.0.clone()
        }
    }

    pub fn apply_to(&self, settings: &mut CaptionSettings) -> bool {
        let next = self.applied_to(settings);
        if same_json(&next, settings) {
            return false;
        }
        *settings = next;
        true
    }
}

impl PresetStyle for CaptionStyle {
    const KIND: PresetKind = PresetKind::Captions;

    fn sanitize(&mut self) {
        let fallback = CaptionSettings::default();
        let settings = &mut self.0;
        settings.enabled = false;
        settings.export_with_subtitles = false;
        if !crate::editor_tabs::FONT_OPTIONS.contains(&settings.font.as_str()) {
            settings.font = fallback.font.clone();
        }
        settings.size = settings.size.clamp(12, 100);
        settings.background_opacity = settings.background_opacity.min(100);
        settings.font_weight = settings.font_weight.clamp(100, 900);
        settings.fade_duration =
            finite_f32(settings.fade_duration, fallback.fade_duration, 0., 0.5);
        settings.linger_duration =
            finite_f32(settings.linger_duration, fallback.linger_duration, 0., 5.);
        settings.word_transition_duration = finite_f32(
            settings.word_transition_duration,
            fallback.word_transition_duration,
            0.,
            5.,
        );
        settings.manual_position = settings.manual_position.and_then(|position| {
            (position.x.is_finite() && position.y.is_finite())
                .then(|| cap_project::XY::new(position.x.clamp(0., 1.), position.y.clamp(0., 1.)))
        });
        valid_color(&mut settings.color, &fallback.color);
        valid_color(&mut settings.background_color, &fallback.background_color);
        valid_color(&mut settings.outline_color, &fallback.outline_color);
        valid_color(&mut settings.highlight_color, &fallback.highlight_color);
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StyleTrackStyle {
    pub background: Option<BackgroundConfiguration>,
    pub camera: Option<Camera>,
    pub cursor: Option<CursorConfiguration>,
    pub camera_only_padding: Option<f64>,
}

impl PartialEq for StyleTrackStyle {
    fn eq(&self, other: &Self) -> bool {
        same_json(self, other)
    }
}

impl StyleTrackStyle {
    pub fn of(overrides: &StyleOverrides) -> Self {
        Self {
            background: overrides.background.clone(),
            camera: overrides.camera.clone(),
            cursor: overrides.cursor.clone(),
            camera_only_padding: overrides.camera_only_padding,
        }
    }

    pub fn apply_to(&self, overrides: &mut StyleOverrides) -> bool {
        if Self::of(overrides) == *self {
            return false;
        }
        overrides.background = self.background.clone();
        overrides.camera = self.camera.clone();
        overrides.cursor = self.cursor.clone();
        overrides.camera_only_padding = self.camera_only_padding;
        true
    }
}

impl PresetStyle for StyleTrackStyle {
    const KIND: PresetKind = PresetKind::Style;

    fn sanitize(&mut self) {
        self.camera_only_padding = self
            .camera_only_padding
            .filter(|padding| padding.is_finite())
            .map(|padding| padding.clamp(0., 40.));
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PresetLibrary {
    pub text: StylePresets<TextStyle>,
    pub mask: StylePresets<MaskStyle>,
    pub captions: StylePresets<CaptionStyle>,
    pub style: StylePresets<StyleTrackStyle>,
}

impl PresetLibrary {
    pub fn load() -> Self {
        Self::from_section(&crate::store::store_section(STORE_SECTION))
    }

    pub fn from_section(section: &Map<String, Value>) -> Self {
        Self {
            text: StylePresets::from_section(section),
            mask: StylePresets::from_section(section),
            captions: StylePresets::from_section(section),
            style: StylePresets::from_section(section),
        }
    }
}

pub trait PresetTarget: PresetStyle {
    fn presets(library: &PresetLibrary) -> &StylePresets<Self>;

    fn presets_mut(library: &mut PresetLibrary) -> &mut StylePresets<Self>;

    fn count(project: &ProjectConfiguration) -> usize;

    fn read(project: &ProjectConfiguration, index: usize) -> Option<Self>;

    fn write(&self, project: &mut ProjectConfiguration, index: usize) -> bool;

    fn for_this_machine(&self) -> Self {
        self.clone()
    }

    fn missing_font(&self) -> Option<&str> {
        None
    }
}

impl PresetTarget for TextStyle {
    fn presets(library: &PresetLibrary) -> &StylePresets<Self> {
        &library.text
    }

    fn presets_mut(library: &mut PresetLibrary) -> &mut StylePresets<Self> {
        &mut library.text
    }

    fn count(project: &ProjectConfiguration) -> usize {
        project
            .timeline
            .as_ref()
            .map_or(0, |timeline| timeline.text_segments.len())
    }

    fn read(project: &ProjectConfiguration, index: usize) -> Option<Self> {
        let segment = project.timeline.as_ref()?.text_segments.get(index)?;
        Some(Self::of(segment))
    }

    fn write(&self, project: &mut ProjectConfiguration, index: usize) -> bool {
        project
            .timeline
            .as_mut()
            .and_then(|timeline| timeline.text_segments.get_mut(index))
            .is_some_and(|segment| self.apply_to(segment))
    }

    fn for_this_machine(&self) -> Self {
        self.for_installed_fonts(crate::editor_panels::installed_fonts())
    }

    fn missing_font(&self) -> Option<&str> {
        (!font_is_available(&self.font_family, crate::editor_panels::installed_fonts()))
            .then_some(self.font_family.as_str())
    }
}

impl PresetTarget for MaskStyle {
    fn presets(library: &PresetLibrary) -> &StylePresets<Self> {
        &library.mask
    }

    fn presets_mut(library: &mut PresetLibrary) -> &mut StylePresets<Self> {
        &mut library.mask
    }

    fn count(project: &ProjectConfiguration) -> usize {
        project
            .timeline
            .as_ref()
            .map_or(0, |timeline| timeline.mask_segments.len())
    }

    fn read(project: &ProjectConfiguration, index: usize) -> Option<Self> {
        let segment = project.timeline.as_ref()?.mask_segments.get(index)?;
        Some(Self::of(segment))
    }

    fn write(&self, project: &mut ProjectConfiguration, index: usize) -> bool {
        project
            .timeline
            .as_mut()
            .and_then(|timeline| timeline.mask_segments.get_mut(index))
            .is_some_and(|segment| self.apply_to(segment))
    }
}

impl PresetTarget for CaptionStyle {
    fn presets(library: &PresetLibrary) -> &StylePresets<Self> {
        &library.captions
    }

    fn presets_mut(library: &mut PresetLibrary) -> &mut StylePresets<Self> {
        &mut library.captions
    }

    fn count(project: &ProjectConfiguration) -> usize {
        usize::from(project.captions.is_some())
    }

    fn read(project: &ProjectConfiguration, _index: usize) -> Option<Self> {
        Some(Self::of(
            &project
                .captions
                .as_ref()
                .map(|captions| captions.settings.clone())
                .unwrap_or_default(),
        ))
    }

    fn write(&self, project: &mut ProjectConfiguration, _index: usize) -> bool {
        project
            .captions
            .as_mut()
            .is_some_and(|captions| self.apply_to(&mut captions.settings))
    }
}

impl PresetTarget for StyleTrackStyle {
    fn presets(library: &PresetLibrary) -> &StylePresets<Self> {
        &library.style
    }

    fn presets_mut(library: &mut PresetLibrary) -> &mut StylePresets<Self> {
        &mut library.style
    }

    fn count(project: &ProjectConfiguration) -> usize {
        project
            .timeline
            .as_ref()
            .map_or(0, |timeline| timeline.style_segments.len())
    }

    fn read(project: &ProjectConfiguration, index: usize) -> Option<Self> {
        let segment = project.timeline.as_ref()?.style_segments.get(index)?;
        Some(Self::of(&segment.overrides))
    }

    fn write(&self, project: &mut ProjectConfiguration, index: usize) -> bool {
        project
            .timeline
            .as_mut()
            .and_then(|timeline| timeline.style_segments.get_mut(index))
            .is_some_and(|segment| self.apply_to(&mut segment.overrides))
    }
}

pub fn apply_to_items<S: PresetTarget>(
    project: &mut ProjectConfiguration,
    indices: &[usize],
    style: &S,
) -> bool {
    let style = style.for_this_machine();
    let mut changed = false;
    for index in indices {
        changed |= style.write(project, *index);
    }
    changed
}

pub fn apply_to_all<S: PresetTarget>(project: &mut ProjectConfiguration, style: &S) -> bool {
    let indices: Vec<usize> = (0..S::count(project)).collect();
    apply_to_items(project, &indices, style)
}

pub fn default_style<S: PresetTarget>() -> Option<S> {
    StylePresets::<S>::load()
        .default_style()
        .map(S::for_this_machine)
}

pub fn new_text_segment(start: f64, end: f64, track: u32) -> cap_project::TextSegment {
    let mut segment = crate::editor_edits::default_text_segment(start, end, track);
    if let Some(style) = default_style::<TextStyle>() {
        style.apply_to(&mut segment);
    }
    segment
}

pub fn new_mask_segment(start: f64, end: f64, track: u32) -> MaskSegment {
    let mut segment = crate::editor_edits::default_mask_segment(start, end, track);
    if let Some(style) = default_style::<MaskStyle>() {
        style.apply_to(&mut segment);
    }
    segment
}

pub fn new_style_segment(start: f64, end: f64, track: u32) -> cap_project::StyleSegment {
    let mut segment = cap_project::StyleSegment {
        start,
        end,
        track,
        ..Default::default()
    };
    if let Some(style) = default_style::<StyleTrackStyle>() {
        style.apply_to(&mut segment.overrides);
    }
    segment
}

pub fn seed_default_captions(project: &mut ProjectConfiguration) {
    if project.captions.is_some() {
        return;
    }
    let Some(style) = default_style::<CaptionStyle>() else {
        return;
    };
    project.captions = Some(cap_project::CaptionsData {
        settings: style.applied_to(&CaptionSettings::default()),
        ..Default::default()
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{TextAlign, TextAnimation, TextBackgroundStyle, TextLayout, XY};

    struct TempStore {
        path: std::path::PathBuf,
    }

    impl TempStore {
        fn new(contents: Option<&str>) -> Self {
            let path = std::env::temp_dir().join(format!(
                "cap-style-presets-{}.json",
                crate::store::new_uuid_v4()
            ));
            if let Some(contents) = contents {
                std::fs::write(&path, contents).unwrap();
            }
            crate::store::set_test_tauri_store_path(Some(path.clone()));
            Self { path }
        }

        fn read(&self) -> Value {
            serde_json::from_slice(&std::fs::read(&self.path).unwrap()).unwrap()
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
            crate::store::set_test_tauri_store_path(None);
        }
    }

    fn lower_third() -> TextStyle {
        TextStyle {
            font_family: "Georgia".to_string(),
            font_size: 64.,
            font_weight: 500.,
            italic: true,
            uppercase: true,
            align: TextAlign::Left,
            letter_spacing: 1.5,
            line_height: 1.4,
            opacity: 0.8,
            shadow: 0.3,
            glow: 0.2,
            stroke_width: 2.,
            stroke_color: "#112233".to_string(),
            background_style: TextBackgroundStyle::Pill,
            background_color: Some("#000000CC".to_string()),
            color: "#FFEE00".to_string(),
            gradient_color: Some("#FF00FF".to_string()),
            animation_in: TextAnimation::SlideUp,
            animation_out: TextAnimation::Pop,
            animation_in_duration: 0.4,
            animation_out_duration: 0.25,
            fade_duration: 0.4,
        }
    }

    fn highlight_mask() -> MaskStyle {
        MaskStyle {
            mask_type: MaskKind::Highlight,
            feather: 0.,
            opacity: 1.,
            darkness: 0.7,
            fade_duration: 0.3,
            ..MaskStyle::default()
        }
    }

    fn timeline_project() -> ProjectConfiguration {
        serde_json::from_value(json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 7200.0 }
                ],
                "zoomSegments": []
            }
        }))
        .unwrap()
    }

    #[test]
    fn the_text_style_serializes_every_inspector_field() {
        let map = style_map(&TextStyle::default());
        for key in [
            "fontFamily",
            "fontSize",
            "fontWeight",
            "italic",
            "uppercase",
            "align",
            "letterSpacing",
            "lineHeight",
            "opacity",
            "shadow",
            "glow",
            "strokeWidth",
            "strokeColor",
            "backgroundStyle",
            "backgroundColor",
            "color",
            "gradientColor",
            "animationIn",
            "animationOut",
            "animationInDuration",
            "animationOutDuration",
            "fadeDuration",
        ] {
            assert!(map.contains_key(key), "{key}");
        }
        assert_eq!(map.len(), 22);
    }

    #[test]
    fn presets_round_trip_through_json() {
        let mut presets = StylePresets::<TextStyle>::default();
        let first = presets.add("Lower third", lower_third()).unwrap();
        let second = presets.add("Plain", TextStyle::default()).unwrap();
        assert!(presets.set_default(Some(&second)));

        let restored = StylePresets::<TextStyle>::from_value(&presets.to_value());
        assert_eq!(restored, presets);
        assert_eq!(restored.presets()[0].id, first);
        assert_eq!(restored.presets()[0].style, lower_third());
        assert_eq!(restored.default_style(), Some(&TextStyle::default()));
    }

    #[test]
    fn presets_round_trip_through_the_settings_store() {
        let store = TempStore::new(Some(r#"{"general_settings":{"theme":"dark"}}"#));
        let (_, id) = StylePresets::<TextStyle>::update(|presets| {
            let id = presets.add("Lower third", lower_third()).unwrap();
            presets.set_default(Some(&id));
            id
        })
        .unwrap();
        StylePresets::<MaskStyle>::update(|presets| presets.add("Spotlight", highlight_mask()))
            .unwrap();

        let library = PresetLibrary::load();
        assert_eq!(library.text.default_preset().unwrap().id, id);
        assert_eq!(library.text.default_style(), Some(&lower_third()));
        assert_eq!(library.mask.presets()[0].style, highlight_mask());
        assert!(library.captions.is_empty());
        assert!(library.style.is_empty());

        let file = store.read();
        assert_eq!(file["general_settings"]["theme"], "dark");
        assert_eq!(file[STORE_SECTION]["version"], STORE_VERSION);
    }

    #[test]
    fn a_store_without_presets_changes_nothing() {
        let _store = TempStore::new(Some(r#"{"presets":{"presets":[],"default":null}}"#));
        assert_eq!(PresetLibrary::load(), PresetLibrary::default());
        assert!(default_style::<TextStyle>().is_none());

        let project_text = crate::editor_edits::default_text_segment(1., 3., 2);
        let created = new_text_segment(1., 3., 2);
        assert_eq!(
            serde_json::to_value(&created).unwrap(),
            serde_json::to_value(&project_text).unwrap()
        );
        let created_mask = new_mask_segment(1., 3., 0);
        assert_eq!(
            serde_json::to_value(&created_mask).unwrap(),
            serde_json::to_value(crate::editor_edits::default_mask_segment(1., 3., 0)).unwrap()
        );
        let created_style = new_style_segment(1., 3., 0);
        assert!(created_style.overrides.background.is_none());
        assert!(created_style.overrides.camera.is_none());

        let mut project = timeline_project();
        seed_default_captions(&mut project);
        assert!(project.captions.is_none());
    }

    #[test]
    fn a_missing_store_file_is_an_empty_library() {
        let _store = TempStore::new(None);
        assert_eq!(PresetLibrary::load(), PresetLibrary::default());
    }

    #[test]
    fn a_corrupt_store_file_is_empty_and_never_overwritten() {
        let store = TempStore::new(Some("{ not json"));
        assert_eq!(PresetLibrary::load(), PresetLibrary::default());
        assert!(
            StylePresets::<TextStyle>::update(|presets| presets.add("A", lower_third())).is_none()
        );
        assert_eq!(std::fs::read_to_string(&store.path).unwrap(), "{ not json");
    }

    #[test]
    fn corrupt_entries_are_skipped_but_kept_on_disk() {
        let section = json!({
            "text": {
                "presets": [
                    "garbage",
                    { "name": "No style" },
                    { "name": "   ", "style": {} },
                    { "name": "Bad style", "style": 12 },
                    { "id": "good", "name": "Good", "style": { "fontSize": 72 } },
                    null
                ],
                "default": "good"
            }
        });
        let presets = StylePresets::<TextStyle>::from_section(section.as_object().unwrap());
        assert_eq!(presets.presets().len(), 1);
        assert_eq!(presets.presets()[0].style.font_size, 72.);
        assert_eq!(presets.default_preset().unwrap().id, "good");

        let written = presets.to_value();
        assert_eq!(written["presets"].as_array().unwrap().len(), 6);
    }

    #[test]
    fn unknown_kinds_and_fields_survive_a_write() {
        let store = TempStore::new(Some(
            &json!({
                "stylePresets": {
                    "version": 7,
                    "shape": { "presets": [{ "id": "s", "name": "Arrow", "style": { "stroke": 4 } }] },
                    "text": {
                        "lastUsed": "x",
                        "presets": [{
                            "id": "x",
                            "name": "Future",
                            "pinned": true,
                            "style": { "fontSize": 50, "fontVariation": "wdth 80" }
                        }]
                    }
                }
            })
            .to_string(),
        ));
        StylePresets::<TextStyle>::update(|presets| presets.rename("x", "Renamed")).unwrap();

        let file = store.read();
        let section = &file[STORE_SECTION];
        assert_eq!(section["version"], 7);
        assert_eq!(section["shape"]["presets"][0]["name"], "Arrow");
        assert_eq!(section["text"]["lastUsed"], "x");
        let entry = &section["text"]["presets"][0];
        assert_eq!(entry["name"], "Renamed");
        assert_eq!(entry["pinned"], true);
        assert_eq!(entry["style"]["fontVariation"], "wdth 80");
        assert_eq!(entry["style"]["fontSize"], 50);
    }

    #[test]
    fn a_wrongly_typed_field_falls_back_without_losing_the_rest() {
        let stored = json!({
            "fontFamily": "Georgia",
            "fontSize": "huge",
            "align": "diagonal",
            "color": "#123456",
            "animationIn": "teleport",
            "animationOut": "pop"
        });
        let style: TextStyle = decode_style(stored.as_object().unwrap());
        let fallback = TextStyle::default();
        assert_eq!(style.font_family, "Georgia");
        assert_eq!(style.font_size, fallback.font_size);
        assert_eq!(style.align, fallback.align);
        assert_eq!(style.color, "#123456");
        assert_eq!(style.animation_in, fallback.animation_in);
        assert_eq!(style.animation_out, TextAnimation::Pop);
    }

    #[test]
    fn hostile_values_are_clamped_to_what_the_inspector_allows() {
        let stored = json!({
            "fontFamily": "   ",
            "fontSize": 1.0e9,
            "fontWeight": -5,
            "letterSpacing": 900,
            "lineHeight": 0,
            "opacity": 4,
            "strokeWidth": -1,
            "animationInDuration": 1.0e300,
            "color": "not a colour",
            "backgroundColor": "#zzz",
            "gradientColor": "#abc"
        });
        let style: TextStyle = decode_style(stored.as_object().unwrap());
        assert_eq!(style.font_family, "sans-serif");
        assert_eq!(style.font_size, TEXT_FONT_SIZE_MAX);
        assert_eq!(style.font_weight, 100.);
        assert_eq!(style.letter_spacing, 20.);
        assert_eq!(style.line_height, 0.8);
        assert_eq!(style.opacity, 1.);
        assert_eq!(style.stroke_width, 0.);
        assert_eq!(style.animation_in_duration, 3.);
        assert_eq!(style.color, TextStyle::default().color);
        assert_eq!(style.background_color, None);
        assert_eq!(style.gradient_color.as_deref(), Some("#abc"));

        let mask: MaskStyle = decode_style(
            json!({ "maskType": "highlight", "feather": -2, "darkness": 9, "pixelation": -40 })
                .as_object()
                .unwrap(),
        );
        assert!(matches!(mask.mask_type, MaskKind::Highlight));
        assert_eq!(mask.feather, 0.);
        assert_eq!(mask.darkness, 1.);
        assert!(mask.pixelation.is_finite() && mask.pixelation > 0.);

        let captions: CaptionStyle = decode_style(
            json!({ "size": 9000, "font": "Comic", "enabled": true, "manualPosition": { "x": 4, "y": -1 } })
                .as_object()
                .unwrap(),
        );
        assert_eq!(captions.0.size, 100);
        assert_eq!(captions.0.font, CaptionSettings::default().font);
        assert!(!captions.0.enabled);
        let position = captions.0.manual_position.unwrap();
        assert_eq!((position.x, position.y), (1., 0.));
    }

    #[test]
    fn a_legacy_shape_migrates() {
        let legacy = json!([
            { "name": "One", "style": { "fontSize": 40 } },
            { "name": "Two", "style": { "fontSize": 80 } },
            { "id": "dup", "name": "Three", "style": {} },
            { "id": "dup", "name": "Four", "style": {} }
        ]);
        let presets = StylePresets::<TextStyle>::from_value(&legacy);
        assert_eq!(presets.presets().len(), 4);
        let ids: std::collections::HashSet<_> = presets
            .presets()
            .iter()
            .map(|preset| preset.id.clone())
            .collect();
        assert_eq!(ids.len(), 4);
        assert!(presets.presets().iter().all(|preset| !preset.id.is_empty()));

        let again = StylePresets::<TextStyle>::from_value(&legacy);
        assert_eq!(again, presets);

        let by_index = json!({ "presets": legacy, "default": 1 });
        let presets = StylePresets::<TextStyle>::from_value(&by_index);
        assert_eq!(presets.default_preset().unwrap().name, "Two");

        let after_garbage = json!({
            "presets": ["garbage", { "name": "A", "style": {} }, { "name": "B", "style": {} }],
            "default": 1
        });
        let presets = StylePresets::<TextStyle>::from_value(&after_garbage);
        assert_eq!(presets.default_preset().unwrap().name, "A");
        let pointing_at_garbage = json!({
            "presets": ["garbage", { "name": "A", "style": {} }],
            "default": 0
        });
        assert!(
            StylePresets::<TextStyle>::from_value(&pointing_at_garbage)
                .default_preset()
                .is_none()
        );

        for bad in [
            json!("text"),
            json!(4),
            json!(null),
            json!({ "presets": "x" }),
        ] {
            assert!(StylePresets::<TextStyle>::from_value(&bad).is_empty());
        }
        let dangling = json!({ "presets": [], "default": "gone" });
        assert!(
            StylePresets::<TextStyle>::from_value(&dangling)
                .default_style()
                .is_none()
        );
    }

    #[test]
    fn a_legacy_entry_can_be_edited_on_the_first_try() {
        let store = TempStore::new(Some(
            &json!({ "stylePresets": { "text": [{ "name": "Old", "style": { "fontSize": 40 } }] } })
                .to_string(),
        ));
        let id = PresetLibrary::load().text.presets()[0].id.clone();
        let (_, renamed) =
            StylePresets::<TextStyle>::update(|presets| presets.rename(&id, "New")).unwrap();
        assert!(renamed);
        let entry = &store.read()["stylePresets"]["text"]["presets"][0];
        assert_eq!(entry["name"], "New");
        assert_eq!(entry["id"], id.as_str());
        assert_eq!(PresetLibrary::load().text.presets()[0].id, id);
    }

    #[test]
    fn rename_delete_reorder_and_default_bookkeeping() {
        let mut presets = StylePresets::<TextStyle>::default();
        let a = presets.add("A", TextStyle::default()).unwrap();
        let b = presets.add("B", lower_third()).unwrap();
        let c = presets
            .add(
                "C",
                TextStyle {
                    font_size: 30.,
                    ..TextStyle::default()
                },
            )
            .unwrap();
        assert!(presets.add("  \n ", TextStyle::default()).is_none());
        assert!(!presets.rename(&a, "   "));
        assert!(presets.rename(&a, "  First \t one "));
        assert_eq!(presets.get(&a).unwrap().name, "First one");
        let long = "x".repeat(300);
        assert!(presets.rename(&a, &long));
        assert_eq!(
            presets.get(&a).unwrap().name.chars().count(),
            NAME_MAX_CHARS
        );

        assert!(presets.move_by(&c, -2));
        assert_eq!(presets.position(&c), Some(0));
        assert!(!presets.move_by(&c, -1));
        assert!(!presets.move_by(&b, 1));
        assert!(presets.move_to(&c, 99));
        assert_eq!(presets.position(&c), Some(2));

        assert!(!presets.set_default(Some("missing")));
        assert!(presets.set_default(Some(&b)));
        assert!(presets.is_default(&b));
        assert!(presets.remove(&b));
        assert!(presets.default_style().is_none());
        assert!(!presets.remove(&b));
        assert!(!presets.set_default(None));

        assert!(presets.set_style(&a, lower_third()));
        assert_eq!(presets.get(&a).unwrap().style, lower_third());
        assert!(!presets.set_style("missing", lower_third()));
    }

    #[test]
    fn making_a_default_reuses_a_matching_preset_or_names_a_new_one() {
        let mut presets = StylePresets::<TextStyle>::default();
        let existing = presets.add("Lower third", lower_third()).unwrap();
        assert_eq!(
            presets.make_default_from(lower_third(), "My text style"),
            Some(existing.clone())
        );
        assert_eq!(presets.presets().len(), 1);

        presets.add("My text style", TextStyle::default()).unwrap();
        let fresh = presets
            .make_default_from(
                TextStyle {
                    font_size: 120.,
                    ..TextStyle::default()
                },
                "My text style",
            )
            .unwrap();
        assert_eq!(presets.get(&fresh).unwrap().name, "My text style 2");
        assert!(presets.is_default(&fresh));
        assert_eq!(presets.matching(&lower_third()).unwrap().id, existing);
    }

    #[test]
    fn new_items_start_from_the_default_preset() {
        let _store = TempStore::new(None);
        StylePresets::<TextStyle>::update(|presets| {
            presets.make_default_from(lower_third(), "Mine")
        })
        .unwrap();
        StylePresets::<MaskStyle>::update(|presets| {
            presets.make_default_from(highlight_mask(), "Mine")
        })
        .unwrap();
        let padded = StyleTrackStyle {
            camera_only_padding: Some(12.),
            ..StyleTrackStyle::default()
        };
        StylePresets::<StyleTrackStyle>::update(|presets| {
            presets.make_default_from(padded.clone(), "Mine")
        })
        .unwrap();
        let mut caption_settings = CaptionSettings {
            size: 64,
            color: "#FFD400".to_string(),
            ..CaptionSettings::default()
        };
        caption_settings.enabled = true;
        StylePresets::<CaptionStyle>::update(|presets| {
            presets.make_default_from(CaptionStyle::of(&caption_settings), "Mine")
        })
        .unwrap();

        let text = new_text_segment(4., 6., 1);
        assert_eq!(TextStyle::of(&text), lower_third());
        assert_eq!((text.start, text.end, text.track), (4., 6., 1));
        assert_eq!(text.content, "Text");
        assert_eq!(text.center.x, 0.5);

        let mask = new_mask_segment(4., 6., 0);
        assert_eq!(MaskStyle::of(&mask), highlight_mask());
        assert_eq!((mask.center.x, mask.size.x), (0.5, 0.35));

        let style = new_style_segment(0., 3., 0);
        assert_eq!(style.overrides.camera_only_padding, Some(12.));

        let mut project = timeline_project();
        seed_default_captions(&mut project);
        let settings = &project.captions.as_ref().unwrap().settings;
        assert_eq!(settings.size, 64);
        assert_eq!(settings.color, "#FFD400");
        assert!(!settings.enabled);

        crate::transcription::apply_caption_result(&mut project, Vec::new(), &[7200.], 7200.);
        let settings = &project.captions.as_ref().unwrap().settings;
        assert!(settings.enabled);
        assert_eq!(settings.size, 64);

        let mut existing = timeline_project();
        existing.captions = Some(cap_project::CaptionsData::default());
        seed_default_captions(&mut existing);
        assert_eq!(
            existing.captions.unwrap().settings.size,
            CaptionSettings::default().size
        );
    }

    #[test]
    fn a_preset_whose_font_is_missing_falls_back_to_the_system_sans() {
        let installed = vec!["Helvetica Neue".to_string(), "Georgia".to_string()];
        assert_eq!(
            lower_third().for_installed_fonts(&installed).font_family,
            "Georgia"
        );
        let missing = TextStyle {
            font_family: "Brand Display".to_string(),
            ..lower_third()
        };
        assert_eq!(
            missing.for_installed_fonts(&installed).font_family,
            "sans-serif"
        );
        let generic = TextStyle {
            font_family: "monospace".to_string(),
            ..lower_third()
        };
        assert_eq!(
            generic.for_installed_fonts(&installed).font_family,
            "monospace"
        );
        assert_eq!(
            missing.for_installed_fonts(&[]).font_family,
            "Brand Display"
        );
        assert!(font_is_available("georgia", &installed));
    }

    fn project_with_texts(count: usize) -> ProjectConfiguration {
        let mut project = timeline_project();
        let timeline = project.timeline.as_mut().unwrap();
        for index in 0..count {
            let start = index as f64 * 30.;
            let mut segment =
                crate::editor_edits::default_text_segment(start, start + 2., (index % 3) as u32);
            segment.content = format!("Line {index}");
            segment.center = XY::new(0.2, 0.1 + index as f64 * 0.001);
            segment.layout = if index == 1 {
                TextLayout::Fullscreen
            } else {
                TextLayout::Overlay
            };
            timeline.text_segments.push(segment);
        }
        project
    }

    #[test]
    fn apply_to_all_is_one_undo_step_and_keeps_content_timing_and_layout() {
        let mut project = project_with_texts(240);
        let before = project.clone();
        let mut history = crate::editor_edits::ProjectHistory::new(project.clone());

        assert!(apply_to_all(&mut project, &lower_third()));
        history.record(&project);

        let texts = &project.timeline.as_ref().unwrap().text_segments;
        let originals = &before.timeline.as_ref().unwrap().text_segments;
        assert_eq!(texts.len(), 240);
        for (segment, original) in texts.iter().zip(originals) {
            assert_eq!(TextStyle::of(segment), lower_third());
            assert_eq!(segment.content, original.content);
            assert_eq!((segment.start, segment.end), (original.start, original.end));
            assert_eq!(segment.track, original.track);
            assert_eq!(segment.layout, original.layout);
            assert_eq!(segment.center.x, original.center.x);
        }
        assert!(!apply_to_all(&mut project, &lower_third()));

        let undone = history.undo().unwrap().clone();
        assert_eq!(
            serde_json::to_value(&undone).unwrap(),
            serde_json::to_value(&before).unwrap()
        );
        assert!(!history.can_undo());
        let redone = history.redo().unwrap().clone();
        assert_eq!(
            serde_json::to_value(&redone).unwrap(),
            serde_json::to_value(&project).unwrap()
        );
    }

    #[test]
    fn applying_to_a_selection_leaves_the_rest_alone() {
        let mut project = project_with_texts(5);
        assert!(apply_to_items(&mut project, &[1, 3, 99], &lower_third()));
        let texts = &project.timeline.as_ref().unwrap().text_segments;
        for (index, segment) in texts.iter().enumerate() {
            assert_eq!(
                TextStyle::of(segment) == lower_third(),
                index == 1 || index == 3,
                "{index}"
            );
        }
        let mut empty = ProjectConfiguration::default();
        assert!(!apply_to_all(&mut empty, &lower_third()));
        assert!(!apply_to_items(&mut empty, &[0], &highlight_mask()));
        assert!(!apply_to_items(&mut empty, &[0], &CaptionStyle::default()));
    }

    #[test]
    fn masks_and_captions_apply_only_their_style() {
        let mut project = timeline_project();
        let mut mask = crate::editor_edits::default_mask_segment(1., 4., 0);
        mask.center = XY::new(0.2, 0.3);
        mask.keyframes
            .intensity
            .push(cap_project::MaskScalarKeyframe {
                time: 0.5,
                value: 0.2,
            });
        mask.keyframes
            .position
            .push(cap_project::MaskVectorKeyframe {
                time: 0.5,
                x: 0.1,
                y: 0.1,
            });
        project.timeline.as_mut().unwrap().mask_segments.push(mask);
        let style = MaskStyle {
            pixelation: 20.,
            ..highlight_mask()
        };
        assert!(apply_to_all(&mut project, &style));
        let mask = &project.timeline.as_ref().unwrap().mask_segments[0];
        assert_eq!(MaskStyle::of(mask), style);
        assert_eq!((mask.center.x, mask.center.y), (0.2, 0.3));
        assert!(mask.keyframes.intensity.is_empty());
        assert_eq!(mask.keyframes.position.len(), 1);

        let timeline = project.timeline.as_mut().unwrap();
        timeline.mask_segments[0]
            .keyframes
            .intensity
            .push(cap_project::MaskScalarKeyframe {
                time: 1.,
                value: 0.4,
            });
        assert!(apply_to_all(&mut project, &style));
        let mask = &project.timeline.as_ref().unwrap().mask_segments[0];
        assert!(mask.keyframes.intensity.is_empty());
        assert!(!apply_to_all(&mut project, &style));

        project.captions = Some(cap_project::CaptionsData {
            settings: CaptionSettings {
                enabled: true,
                export_with_subtitles: true,
                ..CaptionSettings::default()
            },
            ..Default::default()
        });
        let captions = CaptionStyle(CaptionSettings {
            size: 70,
            ..CaptionSettings::default()
        });
        assert!(apply_to_items(&mut project, &[0], &captions));
        let settings = &project.captions.as_ref().unwrap().settings;
        assert_eq!(settings.size, 70);
        assert!(settings.enabled);
        assert!(settings.export_with_subtitles);
        assert_eq!(CaptionStyle::read(&project, 0).unwrap(), captions);
    }
}
