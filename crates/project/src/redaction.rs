use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use specta::Type;

pub const REDACTIONS_FILE: &str = "redactions.json";
pub const REDACTIONS_VERSION: u32 = 1;

#[derive(
    Type, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord,
)]
#[serde(rename_all = "camelCase")]
pub enum RedactCategory {
    Email,
    Name,
    Phone,
    Address,
    Card,
    Secret,
    Ip,
    Url,
}

impl RedactCategory {
    pub const ALL: [Self; 8] = [
        Self::Email,
        Self::Phone,
        Self::Card,
        Self::Secret,
        Self::Name,
        Self::Address,
        Self::Ip,
        Self::Url,
    ];

    pub const DEFAULTS: [Self; 4] = [Self::Email, Self::Phone, Self::Card, Self::Secret];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Email => "email",
            Self::Name => "name",
            Self::Phone => "phone",
            Self::Address => "address",
            Self::Card => "card",
            Self::Secret => "secret",
            Self::Ip => "ip",
            Self::Url => "url",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|category| category.as_str().eq_ignore_ascii_case(value.trim()))
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum RedactStyle {
    #[default]
    Pixelate,
    Blur,
}

/// Auto redact settings saved with the project. The detections themselves
/// live in [`REDACTIONS_FILE`] next to it.
#[derive(Type, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoRedactConfiguration {
    pub enabled: bool,
    pub categories: Vec<RedactCategory>,
    pub style: RedactStyle,
    pub amount: f32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub excluded: Vec<String>,
}

impl AutoRedactConfiguration {
    pub const DEFAULT_AMOUNT: f32 = 0.5;

    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }

    pub fn has_category(&self, category: RedactCategory) -> bool {
        self.categories.contains(&category)
    }

    pub fn is_excluded(&self, id: &str) -> bool {
        self.excluded.iter().any(|excluded| excluded == id)
    }

    pub fn effective_amount(&self) -> f32 {
        if self.amount.is_finite() {
            self.amount.clamp(0.0, 1.0)
        } else {
            Self::DEFAULT_AMOUNT
        }
    }
}

impl Default for AutoRedactConfiguration {
    fn default() -> Self {
        Self {
            enabled: false,
            categories: RedactCategory::DEFAULTS.to_vec(),
            style: RedactStyle::default(),
            amount: Self::DEFAULT_AMOUNT,
            excluded: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Redactions {
    pub version: u32,
    #[serde(default)]
    pub model: String,
    /// The scanner revision that wrote the regions (0: written before
    /// revisions were recorded). A saved scan is reused only by the same
    /// revision.
    #[serde(default)]
    pub scanner: u32,
    #[serde(default)]
    pub segments: Vec<RedactionSegment>,
    #[serde(default)]
    pub regions: Vec<RedactionRegion>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RedactionSegment {
    pub index: u32,
    pub source_frames: u64,
    pub fps: f64,
    pub width: u32,
    pub height: u32,
    pub fingerprint: String,
    /// False while the analyser is still working through this segment.
    #[serde(default = "default_true")]
    pub complete: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RedactionRegion {
    pub id: String,
    pub segment: u32,
    pub category: RedactCategory,
    pub start: f64,
    pub end: f64,
    pub keys: Vec<RedactionKey>,
}

/// A normalized display-space rect (top-left origin) at source time `t`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct RedactionKey {
    pub t: f64,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl RedactionKey {
    fn lerp(self, other: Self, amount: f32) -> RedactRect {
        let mix = |a: f32, b: f32| a + (b - a) * amount;
        RedactRect {
            x: mix(self.x, other.x),
            y: mix(self.y, other.y),
            w: mix(self.w, other.w),
            h: mix(self.h, other.h),
        }
    }

    fn rect(self) -> RedactRect {
        RedactRect {
            x: self.x,
            y: self.y,
            w: self.w,
            h: self.h,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RedactRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl RedactRect {
    pub fn clamped(self) -> Option<Self> {
        let x0 = self.x.max(0.0);
        let y0 = self.y.max(0.0);
        let x1 = (self.x + self.w).min(1.0);
        let y1 = (self.y + self.h).min(1.0);
        (x1 > x0 && y1 > y0 && x0.is_finite() && y0.is_finite()).then_some(Self {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        })
    }
}

impl RedactionRegion {
    pub fn contains_time(&self, t: f64) -> bool {
        t >= self.start && t <= self.end
    }

    /// The region's rect at source time `t`, linear between keys and held
    /// past the first and last key.
    pub fn rect_at(&self, t: f64) -> Option<RedactRect> {
        if !self.contains_time(t) {
            return None;
        }
        let first = self.keys.first()?;
        if t <= first.t {
            return Some(first.rect());
        }
        let after = self.keys.partition_point(|key| key.t <= t);
        let Some(next) = self.keys.get(after) else {
            return self.keys.last().map(|key| key.rect());
        };
        let previous = self.keys[after - 1];
        let span = next.t - previous.t;
        let amount = if span > 0.0 {
            ((t - previous.t) / span) as f32
        } else {
            1.0
        };
        Some(previous.lerp(*next, amount.clamp(0.0, 1.0)))
    }
}

impl RedactionRegion {
    /// The smallest rect holding the region everywhere in `from..=to`: the
    /// rects at both ends and every key between. Rects move linearly between
    /// keys, so this covers the region at any time in the window.
    pub fn rect_between(&self, from: f64, to: f64) -> Option<RedactRect> {
        let from = from.max(self.start);
        let to = to.min(self.end);
        if to < from {
            return None;
        }
        let mut rect = self.rect_at(from)?;
        let mut grow = |other: RedactRect| {
            let x1 = (rect.x + rect.w).max(other.x + other.w);
            let y1 = (rect.y + rect.h).max(other.y + other.h);
            rect.x = rect.x.min(other.x);
            rect.y = rect.y.min(other.y);
            rect.w = x1 - rect.x;
            rect.h = y1 - rect.y;
        };
        if let Some(end) = self.rect_at(to) {
            grow(end);
        }
        let first = self.keys.partition_point(|key| key.t <= from);
        for key in self.keys[first..].iter().take_while(|key| key.t < to) {
            grow(key.rect());
        }
        Some(rect)
    }
}

impl Redactions {
    pub fn path_for(project_path: &Path) -> PathBuf {
        project_path.join(REDACTIONS_FILE)
    }

    pub fn load(project_path: &Path) -> Option<Self> {
        let path = Self::path_for(project_path);
        let bytes = std::fs::read(&path).ok()?;
        match serde_json::from_slice::<Self>(&bytes) {
            Ok(redactions) if redactions.version == REDACTIONS_VERSION => Some(redactions),
            Ok(redactions) => {
                tracing::warn!(
                    version = redactions.version,
                    "Ignoring redactions file with an unknown version"
                );
                None
            }
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "Ignoring unreadable redactions file");
                None
            }
        }
    }

    pub fn save(&self, project_path: &Path) -> std::io::Result<()> {
        let path = Self::path_for(project_path);
        let json = serde_json::to_vec(self).map_err(std::io::Error::other)?;
        let mut temp = tempfile::NamedTempFile::new_in(project_path)?;
        std::io::Write::write_all(&mut temp, &json)?;
        temp.as_file().sync_all()?;
        temp.persist(&path).map_err(|error| error.error)?;
        Ok(())
    }

    pub fn segment(&self, index: u32) -> Option<&RedactionSegment> {
        self.segments.iter().find(|segment| segment.index == index)
    }

    pub fn is_complete(&self) -> bool {
        !self.segments.is_empty() && self.segments.iter().all(|segment| segment.complete)
    }
}

/// Why a rendered export of a project must wait: auto redact is on and the
/// saved scan is missing or unfinished, so the renderer has nothing to hide
/// with.
pub fn export_blocker(
    project_path: &Path,
    config: &AutoRedactConfiguration,
) -> Option<&'static str> {
    if !config.enabled || Redactions::load(project_path).is_some_and(|r| r.is_complete()) {
        return None;
    }
    Some(
        "Auto redact is on but this recording has not been fully scanned yet. Open it in Cap and let the scan finish, then export.",
    )
}

const BUCKET_SECONDS: f64 = 0.5;

/// Regions of the enabled categories, bucketed by source time so a frame
/// looks at only the regions near it.
#[derive(Debug, Default)]
pub struct RedactionIndex {
    segments: Vec<SegmentIndex>,
}

#[derive(Debug, Default)]
struct SegmentIndex {
    segment: u32,
    /// One frame of the display video, in seconds.
    frame: f64,
    regions: Vec<RedactionRegion>,
    buckets: Vec<Vec<u32>>,
}

impl RedactionIndex {
    pub fn new(redactions: &Redactions, config: &AutoRedactConfiguration) -> Self {
        let categories = config.categories.iter().copied().collect::<HashSet<_>>();
        let mut segments: Vec<SegmentIndex> = Vec::new();
        for region in &redactions.regions {
            if !categories.contains(&region.category)
                || config.is_excluded(&region.id)
                || region.keys.is_empty()
                || region.start.is_nan()
                || region.end.is_nan()
                || region.end < region.start
            {
                continue;
            }
            let segment = match segments.iter_mut().find(|s| s.segment == region.segment) {
                Some(segment) => segment,
                None => {
                    let fps = redactions
                        .segment(region.segment)
                        .map(|segment| segment.fps)
                        .filter(|fps| fps.is_finite() && *fps >= 1.0)
                        .unwrap_or(30.0);
                    segments.push(SegmentIndex {
                        segment: region.segment,
                        frame: 1.0 / fps,
                        ..Default::default()
                    });
                    segments.last_mut().unwrap()
                }
            };
            let id = segment.regions.len() as u32;
            let first = bucket(region.start);
            let last = bucket(region.end);
            if segment.buckets.len() <= last {
                segment.buckets.resize_with(last + 1, Vec::new);
            }
            for bucket in &mut segment.buckets[first..=last] {
                bucket.push(id);
            }
            segment.regions.push(region.clone());
        }
        Self { segments }
    }

    pub fn is_empty(&self) -> bool {
        self.segments
            .iter()
            .all(|segment| segment.regions.is_empty())
    }

    pub fn region_count(&self) -> usize {
        self.segments.iter().map(|s| s.regions.len()).sum()
    }

    /// Calls `visit` with every active region's id and rect at source time `t`
    /// of `segment`.
    pub fn for_each_at(&self, segment: u32, t: f64, mut visit: impl FnMut(&str, RedactRect)) {
        let Some(index) = self.segments.iter().find(|s| s.segment == segment) else {
            return;
        };
        if !t.is_finite() || t < 0.0 {
            return;
        }
        let Some(bucket) = index.buckets.get(bucket(t)) else {
            return;
        };
        for id in bucket {
            let region = &index.regions[*id as usize];
            if let Some(rect) = region.rect_at(t).and_then(RedactRect::clamped) {
                visit(&region.id, rect);
            }
        }
    }

    /// Like [`Self::for_each_at`], but each rect covers the region from a
    /// frame and a half before `t` to half a frame after it. The decoder shows
    /// the sample nearest the requested time, which can be the frame before
    /// it, and edits (speed, cuts) change which times are requested; covering
    /// the window keeps the shown frame masked whichever one it is.
    pub fn for_each_around(&self, segment: u32, t: f64, mut visit: impl FnMut(&str, RedactRect)) {
        let Some(index) = self.segments.iter().find(|s| s.segment == segment) else {
            return;
        };
        if !t.is_finite() {
            return;
        }
        let from = (t - 1.5 * index.frame).max(0.0);
        let to = t + 0.5 * index.frame;
        if to < 0.0 {
            return;
        }
        let first = bucket(from);
        let last = bucket(to).min(index.buckets.len().saturating_sub(1));
        if first >= index.buckets.len() {
            return;
        }
        let mut seen: Vec<u32> = Vec::new();
        for bucket in &index.buckets[first..=last] {
            for id in bucket {
                if seen.contains(id) {
                    continue;
                }
                seen.push(*id);
                let region = &index.regions[*id as usize];
                if let Some(rect) = region.rect_between(from, to).and_then(RedactRect::clamped) {
                    visit(&region.id, rect);
                }
            }
        }
    }

    pub fn rects_at(&self, segment: u32, t: f64) -> Vec<RedactRect> {
        let mut rects = Vec::new();
        self.for_each_at(segment, t, |_, rect| rects.push(rect));
        rects
    }
}

fn bucket(t: f64) -> usize {
    (t.max(0.0) / BUCKET_SECONDS) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(id: &str, category: RedactCategory, start: f64, end: f64) -> RedactionRegion {
        RedactionRegion {
            id: id.into(),
            segment: 0,
            category,
            start,
            end,
            keys: vec![
                RedactionKey {
                    t: start,
                    x: 0.1,
                    y: 0.2,
                    w: 0.2,
                    h: 0.05,
                },
                RedactionKey {
                    t: end,
                    x: 0.3,
                    y: 0.4,
                    w: 0.2,
                    h: 0.05,
                },
            ],
        }
    }

    #[test]
    fn rect_between_covers_the_region_across_the_window() {
        let region = region("a", RedactCategory::Email, 1.0, 3.0);
        let rect = region.rect_between(1.5, 2.5).unwrap();
        let at = |t: f64| region.rect_at(t).unwrap();
        for t in [1.5, 1.75, 2.0, 2.25, 2.5] {
            let r = at(t);
            assert!(r.x >= rect.x - 1e-6 && r.y >= rect.y - 1e-6);
            assert!(r.x + r.w <= rect.x + rect.w + 1e-6 && r.y + r.h <= rect.y + rect.h + 1e-6);
        }
        assert!(region.rect_between(3.2, 3.5).is_none());
        let edge = region.rect_between(2.9, 3.4).unwrap();
        assert!((edge.x + edge.w - (at(3.0).x + at(3.0).w)).abs() < 1e-6);
    }

    #[test]
    fn index_around_includes_a_region_that_just_ended() {
        let mut redactions = Redactions {
            version: REDACTIONS_VERSION,
            model: "test".into(),
            segments: Vec::new(),
            regions: vec![region("a", RedactCategory::Email, 0.0, 2.0)],
            scanner: 0,
        };
        redactions.segments.push(RedactionSegment {
            index: 0,
            source_frames: 60,
            fps: 30.0,
            width: 100,
            height: 100,
            fingerprint: String::new(),
            complete: true,
        });
        let config = AutoRedactConfiguration {
            enabled: true,
            ..Default::default()
        };
        let index = RedactionIndex::new(&redactions, &config);
        assert!(index.rects_at(0, 2.03).is_empty());
        let mut around = Vec::new();
        index.for_each_around(0, 2.03, |id, _| around.push(id.to_string()));
        assert_eq!(around, vec!["a".to_string()]);
        let mut later = Vec::new();
        index.for_each_around(0, 2.1, |id, _| later.push(id.to_string()));
        assert!(later.is_empty());
    }

    #[test]
    fn rect_interpolates_between_keys_and_holds_outside() {
        let region = region("a", RedactCategory::Email, 1.0, 3.0);
        assert_eq!(region.rect_at(0.5), None);
        assert_eq!(region.rect_at(3.5), None);
        let mid = region.rect_at(2.0).unwrap();
        assert!((mid.x - 0.2).abs() < 1e-6);
        assert!((mid.y - 0.3).abs() < 1e-6);
        let start = region.rect_at(1.0).unwrap();
        assert!((start.x - 0.1).abs() < 1e-6);
    }

    #[test]
    fn index_filters_categories_and_exclusions() {
        let redactions = Redactions {
            version: REDACTIONS_VERSION,
            model: "test".into(),
            scanner: 0,
            segments: Vec::new(),
            regions: vec![
                region("a", RedactCategory::Email, 0.0, 2.0),
                region("b", RedactCategory::Name, 0.0, 2.0),
                region("c", RedactCategory::Phone, 0.0, 2.0),
            ],
        };
        let config = AutoRedactConfiguration {
            enabled: true,
            excluded: vec!["c".into()],
            ..Default::default()
        };
        let index = RedactionIndex::new(&redactions, &config);
        let mut ids = Vec::new();
        index.for_each_at(0, 1.0, |id, _| ids.push(id.to_string()));
        assert_eq!(ids, vec!["a".to_string()]);
        assert!(index.rects_at(1, 1.0).is_empty());
    }

    #[test]
    fn index_finds_regions_spanning_many_buckets() {
        let redactions = Redactions {
            version: REDACTIONS_VERSION,
            regions: vec![region("long", RedactCategory::Email, 0.2, 9.7)],
            ..Default::default()
        };
        let index = RedactionIndex::new(&redactions, &AutoRedactConfiguration::default());
        for t in [0.2, 0.49, 0.5, 4.0, 9.7] {
            assert_eq!(index.rects_at(0, t).len(), 1, "{t}");
        }
        assert!(index.rects_at(0, 9.71).is_empty());
        assert!(index.rects_at(0, 0.19).is_empty());
    }

    #[test]
    fn a_file_without_a_scanner_revision_reads_as_revision_zero() {
        let parsed: Redactions =
            serde_json::from_str(r#"{"version":1,"model":"m","segments":[],"regions":[]}"#)
                .unwrap();
        assert_eq!(parsed.scanner, 0);
    }

    #[test]
    fn sidecar_round_trips_in_camel_case() {
        let redactions = Redactions {
            version: REDACTIONS_VERSION,
            model: "m".into(),
            scanner: 3,
            segments: vec![RedactionSegment {
                index: 0,
                source_frames: 10,
                fps: 30.0,
                width: 1920,
                height: 1080,
                fingerprint: "f".into(),
                complete: true,
            }],
            regions: vec![region("a", RedactCategory::Card, 0.0, 1.0)],
        };
        let json = serde_json::to_string(&redactions).unwrap();
        assert!(json.contains("\"sourceFrames\":10"));
        assert!(json.contains("\"scanner\":3"));
        assert!(json.contains("\"category\":\"card\""));
        let dir = tempfile::tempdir().unwrap();
        redactions.save(dir.path()).unwrap();
        assert_eq!(Redactions::load(dir.path()), Some(redactions));
    }

    #[test]
    fn settings_are_left_out_of_project_files_until_changed() {
        let config = crate::ProjectConfiguration::default();
        let json = serde_json::to_string(&config).unwrap();
        assert!(!json.contains("autoRedact"));
        let mut changed = config.clone();
        changed.auto_redact.enabled = true;
        let json = serde_json::to_string(&changed).unwrap();
        assert!(json.contains("\"autoRedact\""));
        let loaded: crate::ProjectConfiguration = serde_json::from_str(&json).unwrap();
        assert!(loaded.auto_redact.enabled);
        assert_eq!(
            loaded.auto_redact.categories,
            RedactCategory::DEFAULTS.to_vec()
        );
    }

    #[test]
    fn exports_wait_for_a_finished_scan() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = AutoRedactConfiguration::default();
        assert!(export_blocker(dir.path(), &config).is_none());
        config.enabled = true;
        assert!(export_blocker(dir.path(), &config).is_some());
        let mut redactions = Redactions {
            version: REDACTIONS_VERSION,
            segments: vec![RedactionSegment {
                index: 0,
                source_frames: 1,
                fps: 30.0,
                width: 1,
                height: 1,
                fingerprint: "f".into(),
                complete: false,
            }],
            ..Default::default()
        };
        redactions.save(dir.path()).unwrap();
        assert!(export_blocker(dir.path(), &config).is_some());
        redactions.segments[0].complete = true;
        redactions.save(dir.path()).unwrap();
        assert!(export_blocker(dir.path(), &config).is_none());
    }

    #[test]
    fn category_names_parse() {
        for category in RedactCategory::ALL {
            assert_eq!(RedactCategory::parse(category.as_str()), Some(category));
        }
        assert_eq!(RedactCategory::parse("nope"), None);
    }
}
