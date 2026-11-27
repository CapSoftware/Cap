use std::time::Duration;

#[cfg(not(target_arch = "wasm32"))]
pub use std::time::Instant;
#[cfg(target_arch = "wasm32")]
pub use web_time::Instant;

#[cfg(not(target_arch = "wasm32"))]
pub async fn sleep(duration: Duration) {
    tokio::time::sleep(duration).await;
}

#[cfg(target_arch = "wasm32")]
pub async fn sleep(duration: Duration) {
    browser_sleep(duration.as_millis().min(i32::MAX as u128) as i32).await;
}

#[cfg(target_arch = "wasm32")]
pub async fn browser_sleep(milliseconds: i32) {
    use wasm_bindgen::{JsCast, JsValue, closure::Closure};

    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        let global = js_sys::global();
        let set_timeout = js_sys::Reflect::get(&global, &JsValue::from_str("setTimeout"))
            .ok()
            .and_then(|value| value.dyn_into::<js_sys::Function>().ok());
        let Some(set_timeout) = set_timeout else {
            let _ = resolve.call0(&JsValue::NULL);
            return;
        };
        let resolve_now = resolve.clone();
        let callback = Closure::once(move || {
            let _ = resolve.call0(&JsValue::NULL);
        });
        if set_timeout
            .call2(
                &global,
                callback.as_ref(),
                &JsValue::from(milliseconds.max(0)),
            )
            .is_ok()
        {
            callback.forget();
        } else {
            let _ = resolve_now.call0(&JsValue::NULL);
        }
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(target_arch = "wasm32")]
pub async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    Ok(work())
}

#[cfg(not(target_arch = "wasm32"))]
pub fn path_exists(path: &std::path::Path) -> bool {
    path.exists()
}

#[cfg(target_arch = "wasm32")]
pub fn path_exists(path: &std::path::Path) -> bool {
    browser_assets::get(path).is_some()
}

#[cfg(not(target_arch = "wasm32"))]
pub fn open_image(path: impl AsRef<std::path::Path>) -> image::ImageResult<image::DynamicImage> {
    image::open(path)
}

#[cfg(target_arch = "wasm32")]
pub fn open_image(path: impl AsRef<std::path::Path>) -> image::ImageResult<image::DynamicImage> {
    let asset = browser_assets::get(path.as_ref()).ok_or_else(|| {
        image::ImageError::IoError(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Browser asset is not loaded",
        ))
    })?;
    match asset.data {
        browser_assets::BrowserAssetData::Encoded(bytes) => {
            image::ImageReader::new(std::io::Cursor::new(bytes.as_ref()))
                .with_guessed_format()?
                .decode()
        }
        browser_assets::BrowserAssetData::Rgba { .. } => asset
            .rgba_image()
            .map(image::DynamicImage::ImageRgba8)
            .ok_or_else(|| {
                image::ImageError::IoError(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Browser asset pixels are invalid",
                ))
            }),
    }
}

#[cfg(target_arch = "wasm32")]
pub mod browser_assets {
    use std::{
        collections::HashMap,
        path::{Component, Path, PathBuf},
        sync::{Arc, Mutex, OnceLock},
    };

    #[derive(Clone)]
    pub enum BrowserAssetData {
        Encoded(Arc<[u8]>),
        Rgba {
            width: u32,
            height: u32,
            pixels: Arc<[u8]>,
        },
    }

    #[derive(Clone)]
    pub struct BrowserAsset {
        pub data: BrowserAssetData,
        pub generation: u64,
    }

    impl BrowserAsset {
        pub fn byte_len(&self) -> usize {
            match &self.data {
                BrowserAssetData::Encoded(bytes) => bytes.len(),
                BrowserAssetData::Rgba { pixels, .. } => pixels.len(),
            }
        }

        pub fn rgba_image(&self) -> Option<image::RgbaImage> {
            match &self.data {
                BrowserAssetData::Rgba {
                    width,
                    height,
                    pixels,
                } => image::RgbaImage::from_raw(*width, *height, pixels.to_vec()),
                BrowserAssetData::Encoded(_) => None,
            }
        }
    }

    struct Store {
        assets: HashMap<PathBuf, BrowserAsset>,
        generation: u64,
    }

    fn store() -> &'static Mutex<Store> {
        static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
        STORE.get_or_init(|| {
            Mutex::new(Store {
                assets: HashMap::new(),
                generation: 0,
            })
        })
    }

    fn normalize(path: &Path) -> PathBuf {
        let mut normalized = PathBuf::new();
        for component in path.components() {
            match component {
                Component::CurDir => {}
                Component::ParentDir => {
                    normalized.pop();
                }
                other => normalized.push(other.as_os_str()),
            }
        }
        normalized
    }

    fn store_asset(path: &Path, data: BrowserAssetData) {
        let mut store = store().lock().unwrap_or_else(|error| error.into_inner());
        store.generation += 1;
        let generation = store.generation;
        store
            .assets
            .insert(normalize(path), BrowserAsset { data, generation });
    }

    pub fn insert(path: impl AsRef<Path>, bytes: Vec<u8>) {
        store_asset(path.as_ref(), BrowserAssetData::Encoded(bytes.into()));
    }

    pub fn insert_rgba(
        path: impl AsRef<Path>,
        width: u32,
        height: u32,
        pixels: Vec<u8>,
    ) -> Result<(), String> {
        if width == 0
            || height == 0
            || pixels.len() as u64 != u64::from(width) * u64::from(height) * 4
        {
            return Err("Browser asset pixels are invalid".to_string());
        }
        store_asset(
            path.as_ref(),
            BrowserAssetData::Rgba {
                width,
                height,
                pixels: pixels.into(),
            },
        );
        Ok(())
    }

    pub fn remove(path: impl AsRef<Path>) {
        store()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .assets
            .remove(&normalize(path.as_ref()));
    }

    pub fn get(path: &Path) -> Option<BrowserAsset> {
        store()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .assets
            .get(&normalize(path))
            .cloned()
    }
}
