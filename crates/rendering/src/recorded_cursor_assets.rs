use cap_project::{CursorMeta, XY};
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FrozenCursorAssetError {
    #[error("Frozen recorded cursor ID is empty")]
    EmptyId,
    #[error("Duplicate frozen recorded cursor ID: {0}")]
    DuplicateId(String),
    #[error("Frozen recorded cursor is missing: {0}")]
    Missing(String),
    #[error("Failed to decode frozen recorded cursor {cursor_id}: {message}")]
    Decode { cursor_id: String, message: String },
}

struct FrozenRecordedCursor {
    metadata: CursorMeta,
    bytes: Arc<[u8]>,
}

struct FrozenRecordedCursorState {
    assets: HashMap<String, FrozenRecordedCursor>,
    first_error: OnceLock<FrozenCursorAssetError>,
}

#[derive(Clone)]
pub struct FrozenRecordedCursorAssets {
    state: Arc<FrozenRecordedCursorState>,
}

pub(crate) struct DecodedRecordedCursor {
    pub(crate) image: image::DynamicImage,
    pub(crate) hotspot: XY<f64>,
}

pub(crate) fn select_recorded_cursor_image(
    frozen: Option<&FrozenRecordedCursorAssets>,
    cursor_id: &str,
    ordinary: impl FnOnce() -> Option<DecodedRecordedCursor>,
) -> Result<Option<DecodedRecordedCursor>, FrozenCursorAssetError> {
    match frozen {
        Some(assets) => assets.decode(cursor_id).map(Some),
        None => Ok(ordinary()),
    }
}

impl FrozenRecordedCursorAssets {
    pub fn new(
        assets: impl IntoIterator<Item = (String, CursorMeta, Arc<[u8]>)>,
    ) -> Result<Self, FrozenCursorAssetError> {
        let mut indexed = HashMap::new();
        for (id, metadata, bytes) in assets {
            if id.is_empty() {
                return Err(FrozenCursorAssetError::EmptyId);
            }
            if indexed
                .insert(id.clone(), FrozenRecordedCursor { metadata, bytes })
                .is_some()
            {
                return Err(FrozenCursorAssetError::DuplicateId(id));
            }
        }
        Ok(Self {
            state: Arc::new(FrozenRecordedCursorState {
                assets: indexed,
                first_error: OnceLock::new(),
            }),
        })
    }

    pub fn first_error(&self) -> Option<FrozenCursorAssetError> {
        self.state.first_error.get().cloned()
    }

    fn failed(&self, error: FrozenCursorAssetError) -> FrozenCursorAssetError {
        let _ = self.state.first_error.set(error.clone());
        error
    }

    pub(crate) fn ids(&self) -> impl Iterator<Item = &String> {
        self.state.assets.keys()
    }

    pub(crate) fn metadata(&self, cursor_id: &str) -> Result<&CursorMeta, FrozenCursorAssetError> {
        self.state
            .assets
            .get(cursor_id)
            .map(|asset| &asset.metadata)
            .ok_or_else(|| self.failed(FrozenCursorAssetError::Missing(cursor_id.to_owned())))
    }

    pub(crate) fn decode(
        &self,
        cursor_id: &str,
    ) -> Result<DecodedRecordedCursor, FrozenCursorAssetError> {
        let asset =
            self.state.assets.get(cursor_id).ok_or_else(|| {
                self.failed(FrozenCursorAssetError::Missing(cursor_id.to_owned()))
            })?;
        let decoded = image::ImageFormat::from_path(asset.metadata.image_path.as_str())
            .and_then(|format| image::load_from_memory_with_format(&asset.bytes, format));
        let image = decoded.map_err(|error| {
            self.failed(FrozenCursorAssetError::Decode {
                cursor_id: cursor_id.to_owned(),
                message: error.to_string(),
            })
        })?;
        Ok(DecodedRecordedCursor {
            image,
            hotspot: asset.metadata.hotspot,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;
    use std::io::Cursor;

    fn metadata(path: &str) -> CursorMeta {
        CursorMeta {
            image_path: path.into(),
            hotspot: XY::new(0.25, 0.75),
            shape: None,
        }
    }

    fn png() -> Arc<[u8]> {
        let image =
            image::RgbaImage::from_raw(2, 1, vec![11, 22, 33, 255, 44, 55, 66, 127]).unwrap();
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        bytes.into_inner().into()
    }

    #[test]
    fn frozen_pixels_and_hotspot_match_ordinary_image_decoding() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recorded.png");
        let bytes = png();
        std::fs::write(&path, &bytes).unwrap();
        let ordinary = image::open(&path).unwrap();
        let assets = FrozenRecordedCursorAssets::new([(
            "arrow".into(),
            metadata(path.to_str().unwrap()),
            bytes,
        )])
        .unwrap();
        let frozen = assets.decode("arrow").unwrap();
        assert_eq!(frozen.image.dimensions(), ordinary.dimensions());
        assert_eq!(
            frozen.image.to_rgba8().as_raw(),
            ordinary.to_rgba8().as_raw()
        );
        assert_eq!(frozen.hotspot, XY::new(0.25, 0.75));
        assert!(assets.first_error().is_none());
    }

    #[test]
    fn frozen_bytes_survive_original_file_removal() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recorded.png");
        let bytes = png();
        std::fs::write(&path, &bytes).unwrap();
        let assets = FrozenRecordedCursorAssets::new([(
            "arrow".into(),
            metadata(path.to_str().unwrap()),
            bytes,
        )])
        .unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(assets.decode("arrow").unwrap().image.dimensions(), (2, 1));
        assert!(assets.first_error().is_none());
    }

    #[test]
    fn corrupt_frozen_bytes_never_fall_back_to_valid_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recorded.png");
        std::fs::write(&path, png()).unwrap();
        let assets = FrozenRecordedCursorAssets::new([(
            "arrow".into(),
            metadata(path.to_str().unwrap()),
            Arc::from(&b"corrupt"[..]),
        )])
        .unwrap();
        assert!(image::open(&path).is_ok());
        assert!(matches!(
            assets.decode("arrow"),
            Err(FrozenCursorAssetError::Decode { .. })
        ));
        assert!(matches!(
            assets.first_error(),
            Some(FrozenCursorAssetError::Decode { .. })
        ));
    }

    #[test]
    fn missing_asset_error_is_shared_and_sticky_across_clones() {
        let assets =
            FrozenRecordedCursorAssets::new([("arrow".into(), metadata("recorded.png"), png())])
                .unwrap();
        let clone = assets.clone();
        assert!(matches!(
            clone.metadata("missing"),
            Err(FrozenCursorAssetError::Missing(_))
        ));
        assert!(assets.decode("arrow").is_ok());
        assert!(matches!(
            assets.decode("other"),
            Err(FrozenCursorAssetError::Missing(_))
        ));
        assert_eq!(
            assets.first_error(),
            Some(FrozenCursorAssetError::Missing("missing".into()))
        );
        assert_eq!(clone.first_error(), assets.first_error());
    }

    #[test]
    fn frozen_format_selection_preserves_recorded_path_extension() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recorded.unknown");
        let bytes = png();
        std::fs::write(&path, &bytes).unwrap();
        let assets = FrozenRecordedCursorAssets::new([(
            "arrow".into(),
            metadata(path.to_str().unwrap()),
            bytes,
        )])
        .unwrap();
        assert!(image::open(&path).is_err());
        assert!(matches!(
            assets.decode("arrow"),
            Err(FrozenCursorAssetError::Decode { .. })
        ));
    }

    #[test]
    fn frozen_ids_are_complete_and_duplicate_or_empty_ids_decline() {
        let meta = metadata("recorded.png");
        let bytes = png();
        let assets = FrozenRecordedCursorAssets::new([
            ("one".into(), meta.clone(), bytes.clone()),
            ("two".into(), meta.clone(), bytes.clone()),
        ])
        .unwrap();
        let mut ids = assets.ids().cloned().collect::<Vec<_>>();
        ids.sort();
        assert_eq!(ids, ["one", "two"]);
        assert!(matches!(
            FrozenRecordedCursorAssets::new([
                ("one".into(), meta.clone(), bytes.clone()),
                ("one".into(), meta.clone(), bytes.clone())
            ]),
            Err(FrozenCursorAssetError::DuplicateId(_))
        ));
        assert!(matches!(
            FrozenRecordedCursorAssets::new([(String::new(), meta, bytes)]),
            Err(FrozenCursorAssetError::EmptyId)
        ));
    }

    #[test]
    fn frozen_selection_never_calls_ordinary_provider_on_missing_or_corrupt_assets() {
        let missing = FrozenRecordedCursorAssets::new([]).unwrap();
        let corrupt = FrozenRecordedCursorAssets::new([(
            "arrow".into(),
            metadata("recorded.png"),
            Arc::from(&b"corrupt"[..]),
        )])
        .unwrap();
        for assets in [&missing, &corrupt] {
            assert!(
                select_recorded_cursor_image(Some(assets), "arrow", || panic!(
                    "Ordinary path fallback must never run"
                ))
                .is_err()
            );
            assert!(assets.first_error().is_some());
        }
    }

    #[test]
    fn ordinary_selection_preserves_the_supplied_provider_result() {
        let image = image::load_from_memory(&png()).unwrap();
        let decoded = select_recorded_cursor_image(None, "arrow", || {
            Some(DecodedRecordedCursor {
                image,
                hotspot: XY::new(0.25, 0.75),
            })
        })
        .unwrap()
        .unwrap();
        assert_eq!(decoded.image.dimensions(), (2, 1));
        assert_eq!(decoded.hotspot, XY::new(0.25, 0.75));
        assert!(
            select_recorded_cursor_image(None, "missing", || None)
                .unwrap()
                .is_none()
        );
    }
}
