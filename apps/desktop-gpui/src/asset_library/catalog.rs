//! What can be downloaded: the wallpapers and tracks this build knows by hash,
//! plus any extras a newer remote manifest lists.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};

use serde::Deserialize;

use super::Kind;
use crate::editor_audio::AUDIO_LIBRARY;
use crate::editor_sidebar::{BACKGROUND_THEMES, WALLPAPER_NAMES};

const BUILTIN_MANIFEST: &str = include_str!("../../assets/asset-manifest.json");

/// Remote limits. A wallpaper is a JPEG of a few MB at most and a track a
/// few minutes of MP3; anything larger is a mistake in the manifest.
const MAX_REMOTE_ENTRIES: usize = 400;
const MAX_WALLPAPER_BYTES: u64 = 16 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES: u64 = 1024 * 1024;
const MAX_TRACK_BYTES: u64 = 40 * 1024 * 1024;
pub(super) const MAX_MANIFEST_BYTES: usize = 512 * 1024;

const ALLOWED_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "cap.so",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRef {
    pub url: String,
    pub size: u64,
    pub sha256: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub kind: Kind,
    pub id: &'static str,
    pub file: FileRef,
    /// Only remote wallpapers carry one; built-in thumbnails ship in the app.
    pub thumbnail: Option<FileRef>,
    /// Wallpapers: the theme tab. Music: unused.
    pub theme: &'static str,
    /// Music: the row title. Wallpapers: unused.
    pub name: &'static str,
    pub builtin: bool,
}

#[derive(Default)]
pub struct Catalog {
    items: HashMap<Kind, HashMap<&'static str, Arc<Item>>>,
    wallpapers: Vec<&'static str>,
    music: Vec<&'static str>,
    extra_themes: Vec<(&'static str, &'static str)>,
}

#[derive(Deserialize)]
struct ManifestFile {
    version: u32,
    #[serde(default)]
    themes: Vec<RawTheme>,
    #[serde(default)]
    wallpapers: Vec<RawEntry>,
    #[serde(default)]
    music: Vec<RawEntry>,
}

#[derive(Deserialize)]
struct RawTheme {
    id: String,
    label: String,
}

#[derive(Deserialize)]
struct RawEntry {
    id: String,
    url: String,
    size: u64,
    sha256: String,
    #[serde(default)]
    theme: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    thumbnail: Option<RawFile>,
}

#[derive(Deserialize)]
struct RawFile {
    url: String,
    size: u64,
    sha256: String,
}

/// Remote strings live for the process. Each distinct one is leaked once,
/// and the remote manifest is capped, so this is bounded.
fn intern(value: &str) -> &'static str {
    static INTERNED: LazyLock<Mutex<HashSet<&'static str>>> =
        LazyLock::new(|| Mutex::new(HashSet::new()));
    let mut set = INTERNED.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(existing) = set.get(value) {
        return existing;
    }
    let leaked: &'static str = Box::leak(value.to_owned().into_boxed_str());
    set.insert(leaked);
    leaked
}

fn parse_sha256(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(index * 2..index * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

fn allowed_url_with(url: &str, dev_origin: Option<&str>) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if let Some(origin) = dev_origin
        && reqwest::Url::parse(origin).is_ok_and(|origin| origin.origin() == parsed.origin())
    {
        return true;
    }
    parsed.scheme() == "https"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.port().is_none()
        && parsed
            .host_str()
            .is_some_and(|host| ALLOWED_HOSTS.contains(&host) || host.ends_with(".cap.so"))
}

fn file_ref(url: &str, size: u64, sha256: &str, max: u64, origin: Option<&str>) -> Option<FileRef> {
    (size > 0 && size <= max && allowed_url_with(url, origin)).then_some(())?;
    Some(FileRef {
        url: url.to_owned(),
        size,
        sha256: parse_sha256(sha256)?,
    })
}

fn slug(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn label(value: &str, max: usize) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= max && !value.chars().any(char::is_control)
}

impl Catalog {
    pub fn builtin() -> Self {
        let manifest: ManifestFile =
            serde_json::from_str(BUILTIN_MANIFEST).expect("bundled asset-manifest.json parses");
        let mut catalog = Catalog::default();
        let builtin_file = |entry: &RawEntry, max: u64| {
            file_ref(&entry.url, entry.size, &entry.sha256, max, None)
                .unwrap_or_else(|| panic!("bundled manifest entry {} is invalid", entry.id))
        };
        let wallpapers: HashMap<&str, &RawEntry> = manifest
            .wallpapers
            .iter()
            .map(|entry| (entry.id.as_str(), entry))
            .collect();
        for id in WALLPAPER_NAMES {
            let Some(entry) = wallpapers.get(id) else {
                continue;
            };
            let theme = id.split('/').next().unwrap_or_default();
            catalog.insert(Item {
                kind: Kind::Wallpaper,
                id,
                file: builtin_file(entry, MAX_WALLPAPER_BYTES),
                thumbnail: None,
                theme: BACKGROUND_THEMES
                    .iter()
                    .find(|(known, _)| *known == theme)
                    .map(|(known, _)| *known)
                    .unwrap_or_default(),
                name: "",
                builtin: true,
            });
        }
        let tracks: HashMap<&str, &RawEntry> = manifest
            .music
            .iter()
            .map(|entry| (entry.id.as_str(), entry))
            .collect();
        for (id, name) in AUDIO_LIBRARY {
            let Some(entry) = tracks.get(id) else {
                continue;
            };
            catalog.insert(Item {
                kind: Kind::Music,
                id,
                file: builtin_file(entry, MAX_TRACK_BYTES),
                thumbnail: None,
                theme: "",
                name,
                builtin: true,
            });
        }
        catalog
    }

    pub(super) fn insert(&mut self, item: Item) {
        match item.kind {
            Kind::Wallpaper => self.wallpapers.push(item.id),
            Kind::Music => self.music.push(item.id),
        }
        self.items
            .entry(item.kind)
            .or_default()
            .insert(item.id, Arc::new(item));
    }

    fn contains(&self, kind: Kind, id: &str) -> bool {
        self.item(kind, id).is_some()
    }

    /// The built-in catalogue plus whatever in `bytes` passes validation.
    /// Entries that fail are skipped one by one; a manifest that does not
    /// parse at all is an error and changes nothing.
    /// `origin` (`CAP_ASSETS_DEV_ORIGIN`, say `http://127.0.0.1:8123`) is
    /// one more origin entries may point at, for testing end to end.
    pub fn with_remote_from(bytes: &[u8], origin: Option<&str>) -> Result<Self, String> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err("remote asset manifest is too large".into());
        }
        let manifest: ManifestFile = serde_json::from_slice(bytes)
            .map_err(|error| format!("remote asset manifest: {error}"))?;
        if manifest.version != 1 {
            return Err(format!(
                "remote asset manifest version {} is not supported",
                manifest.version
            ));
        }
        let mut catalog = Self::builtin();
        let builtin_themes: HashSet<&str> = BACKGROUND_THEMES.iter().map(|(id, _)| *id).collect();
        let mut remote_themes = HashSet::new();
        for theme in manifest.themes.iter().take(32) {
            if slug(&theme.id, 32)
                && label(&theme.label, 32)
                && !builtin_themes.contains(theme.id.as_str())
                && remote_themes.insert(theme.id.clone())
            {
                catalog
                    .extra_themes
                    .push((intern(&theme.id), intern(theme.label.trim())));
            }
        }
        let mut accepted = 0;
        let wallpapers = manifest.wallpapers.iter().map(|entry| {
            (
                entry,
                remote_wallpaper(entry, &builtin_themes, &remote_themes, origin),
            )
        });
        let tracks = manifest
            .music
            .iter()
            .map(|entry| (entry, remote_track(entry, origin)));
        for (entry, item) in wallpapers.chain(tracks) {
            if accepted >= MAX_REMOTE_ENTRIES {
                break;
            }
            let Some(item) = item else {
                tracing::warn!(id = entry.id, "skipping invalid remote asset entry");
                continue;
            };
            if catalog.contains(item.kind, item.id) {
                continue;
            }
            catalog.insert(item);
            accepted += 1;
        }
        Ok(catalog)
    }

    pub fn item(&self, kind: Kind, id: &str) -> Option<Arc<Item>> {
        self.items.get(&kind)?.get(id).cloned()
    }

    pub fn items(&self, kind: Kind) -> impl Iterator<Item = Arc<Item>> + '_ {
        let ids = match kind {
            Kind::Wallpaper => &self.wallpapers,
            Kind::Music => &self.music,
        };
        ids.iter().filter_map(move |id| self.item(kind, id))
    }

    pub fn extra_themes(&self) -> &[(&'static str, &'static str)] {
        &self.extra_themes
    }
}

fn remote_wallpaper(
    entry: &RawEntry,
    builtin_themes: &HashSet<&str>,
    remote_themes: &HashSet<String>,
    origin: Option<&str>,
) -> Option<Item> {
    let (theme, name) = entry.id.split_once('/')?;
    if !slug(theme, 32) || !slug(name, 64) {
        return None;
    }
    if entry
        .theme
        .as_deref()
        .is_some_and(|declared| declared != theme)
    {
        return None;
    }
    if !builtin_themes.contains(theme) && !remote_themes.contains(theme) {
        return None;
    }
    let thumbnail = entry.thumbnail.as_ref()?;
    Some(Item {
        kind: Kind::Wallpaper,
        id: intern(&entry.id),
        file: file_ref(
            &entry.url,
            entry.size,
            &entry.sha256,
            MAX_WALLPAPER_BYTES,
            origin,
        )?,
        thumbnail: Some(file_ref(
            &thumbnail.url,
            thumbnail.size,
            &thumbnail.sha256,
            MAX_THUMBNAIL_BYTES,
            origin,
        )?),
        theme: intern(theme),
        name: "",
        builtin: false,
    })
}

fn remote_track(entry: &RawEntry, origin: Option<&str>) -> Option<Item> {
    if !slug(&entry.id, 80) {
        return None;
    }
    let name = entry.name.as_deref().filter(|name| label(name, 48))?;
    Some(Item {
        kind: Kind::Music,
        id: intern(&entry.id),
        file: file_ref(
            &entry.url,
            entry.size,
            &entry.sha256,
            MAX_TRACK_BYTES,
            origin,
        )?,
        thumbnail: None,
        theme: "",
        name: intern(name.trim()),
        builtin: false,
    })
}

/// The app's catalogue.
pub fn current() -> Arc<Catalog> {
    super::library().catalog()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_manifest_covers_every_catalogue_entry() {
        let catalog = Catalog::builtin();
        assert_eq!(
            catalog
                .items(Kind::Wallpaper)
                .map(|item| item.id)
                .collect::<Vec<_>>(),
            WALLPAPER_NAMES.to_vec()
        );
        assert_eq!(
            catalog
                .items(Kind::Music)
                .map(|item| item.id)
                .collect::<Vec<_>>(),
            AUDIO_LIBRARY.iter().map(|(id, _)| *id).collect::<Vec<_>>()
        );
        for item in catalog
            .items(Kind::Wallpaper)
            .chain(catalog.items(Kind::Music))
        {
            assert!(item.builtin);
            assert!(
                !item.theme.is_empty() || item.kind == Kind::Music,
                "{}",
                item.id
            );
        }
    }

    /// The manifest hashes are what downloads are checked against, so they
    /// must describe the files in the repository byte for byte.
    #[test]
    fn the_bundled_manifest_matches_the_files_in_the_repository() {
        use sha2::Digest as _;
        let assets = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
        let catalog = Catalog::builtin();
        for item in catalog
            .items(Kind::Wallpaper)
            .chain(catalog.items(Kind::Music))
        {
            let path = match item.kind {
                Kind::Wallpaper => assets.join("backgrounds").join(format!("{}.jpg", item.id)),
                Kind::Music => assets.join("music").join(format!("{}.mp3", item.id)),
            };
            let bytes = std::fs::read(&path).unwrap_or_else(|_| panic!("{path:?}"));
            assert_eq!(bytes.len() as u64, item.file.size, "{}", item.id);
            assert_eq!(
                <[u8; 32]>::from(sha2::Sha256::digest(&bytes)),
                item.file.sha256,
                "{}",
                item.id
            );
            assert!(allowed_url_with(&item.file.url, None), "{}", item.file.url);
        }
    }

    fn remote(json: serde_json::Value) -> Catalog {
        Catalog::with_remote_from(json.to_string().as_bytes(), None).unwrap()
    }

    const HASH: &str = "27e23cfcfbc3ca728aa5de03bab62544afca87e810594ed747c092e189d8b62f";
    const URL: &str = "https://github.com/CapSoftware/transcription-models/releases/download/x/y";

    fn wallpaper(id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "url": URL, "size": 10, "sha256": HASH,
            "thumbnail": { "url": URL, "size": 5, "sha256": HASH }
        })
    }

    #[test]
    fn remote_extras_append_after_the_built_in_entries() {
        let catalog = remote(serde_json::json!({
            "version": 1,
            "themes": [{ "id": "space", "label": "Space" }],
            "wallpapers": [wallpaper("space/nebula"), wallpaper("blue/7")],
            "music": [{ "id": "new-track", "name": "New Track", "url": URL, "size": 9, "sha256": HASH }]
        }));
        let wallpapers: Vec<_> = catalog.items(Kind::Wallpaper).map(|item| item.id).collect();
        assert_eq!(wallpapers.len(), WALLPAPER_NAMES.len() + 2);
        assert_eq!(
            &wallpapers[WALLPAPER_NAMES.len()..],
            ["space/nebula", "blue/7"]
        );
        assert_eq!(catalog.extra_themes(), [("space", "Space")]);
        let track = catalog.item(Kind::Music, "new-track").unwrap();
        assert_eq!(track.name, "New Track");
        assert!(!track.builtin);
    }

    #[test]
    fn remote_entries_cannot_replace_or_escape_the_catalogue() {
        let built_in = Catalog::builtin().item(Kind::Wallpaper, "blue/1").unwrap();
        let catalog = remote(serde_json::json!({
            "version": 1,
            "themes": [{ "id": "blue", "label": "Hijack" }, { "id": "../x", "label": "Bad" }],
            "wallpapers": [
                wallpaper("blue/1"),
                wallpaper("blue/../../etc"),
                wallpaper("nowhere/a"),
                wallpaper("blue"),
                { "id": "blue/nothumb", "url": URL, "size": 10, "sha256": HASH },
                { "id": "blue/http", "url": "http://github.com/a", "size": 10, "sha256": HASH,
                  "thumbnail": { "url": URL, "size": 5, "sha256": HASH } },
                { "id": "blue/host", "url": "https://evil.example/a", "size": 10, "sha256": HASH,
                  "thumbnail": { "url": URL, "size": 5, "sha256": HASH } },
                { "id": "blue/lookalike", "url": "https://cap.so.evil.example/a", "size": 10, "sha256": HASH,
                  "thumbnail": { "url": URL, "size": 5, "sha256": HASH } },
                { "id": "blue/huge", "url": URL, "size": 1_000_000_000u64, "sha256": HASH,
                  "thumbnail": { "url": URL, "size": 5, "sha256": HASH } },
                { "id": "blue/badhash", "url": URL, "size": 10, "sha256": "zz",
                  "thumbnail": { "url": URL, "size": 5, "sha256": HASH } }
            ],
            "music": [
                { "id": "lofi-beats-mirostar", "name": "Swap", "url": URL, "size": 9, "sha256": HASH },
                { "id": "no-name", "url": URL, "size": 9, "sha256": HASH },
                { "id": "a/b", "name": "Path", "url": URL, "size": 9, "sha256": HASH }
            ]
        }));
        assert_eq!(
            catalog.items(Kind::Wallpaper).count(),
            WALLPAPER_NAMES.len()
        );
        assert_eq!(catalog.items(Kind::Music).count(), AUDIO_LIBRARY.len());
        assert_eq!(catalog.item(Kind::Wallpaper, "blue/1").unwrap(), built_in);
        assert!(catalog.extra_themes().is_empty());
    }

    #[test]
    fn an_unreadable_or_newer_manifest_changes_nothing() {
        assert!(Catalog::with_remote_from(b"not json", None).is_err());
        assert!(Catalog::with_remote_from(br#"{"version":2}"#, None).is_err());
        assert!(Catalog::with_remote_from(&vec![b' '; MAX_MANIFEST_BYTES + 1], None).is_err());
        assert!(Catalog::with_remote_from(br#"{"version":1}"#, None).is_ok());
    }
}
