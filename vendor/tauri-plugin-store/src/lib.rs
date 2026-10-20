// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Simple, persistent key-value store.

#![doc(
    html_logo_url = "https://github.com/tauri-apps/tauri/raw/dev/app-icon.png",
    html_favicon_url = "https://github.com/tauri-apps/tauri/raw/dev/app-icon.png"
)]

pub use error::{Error, Result};
use serde::{Deserialize, Serialize};
pub use serde_json::Value as JsonValue;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
pub use store::{resolve_store_path, DeserializeFn, SerializeFn, Store, StoreBuilder};
use tauri::{
    plugin::{self, TauriPlugin},
    AppHandle, Manager, ResourceId, RunEvent, Runtime, State,
};

mod error;
mod store;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChangePayload<'a> {
    path: &'a Path,
    resource_id: Option<u32>,
    key: &'a str,
    value: Option<&'a JsonValue>,
    exists: bool,
}

#[derive(Debug)]
struct StoreState {
    stores: Arc<Mutex<HashMap<PathBuf, ResourceId>>>,
    serialize_fns: HashMap<String, SerializeFn>,
    deserialize_fns: HashMap<String, DeserializeFn>,
    default_serialize: SerializeFn,
    default_deserialize: DeserializeFn,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum AutoSave {
    DebounceDuration(u64),
    Bool(bool),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadStoreOptions {
    defaults: Option<HashMap<String, JsonValue>>,
    auto_save: Option<AutoSave>,
    serialize_fn_name: Option<String>,
    deserialize_fn_name: Option<String>,
    #[serde(default)]
    create_new: bool,
    #[serde(default)]
    override_defaults: bool,
}

fn builder<R: Runtime>(
    app: AppHandle<R>,
    store_state: State<'_, StoreState>,
    path: PathBuf,
    options: Option<LoadStoreOptions>,
) -> Result<StoreBuilder<R>> {
    let mut builder = app.store_builder(path);

    let Some(options) = options else {
        return Ok(builder);
    };

    if let Some(defaults) = options.defaults {
        builder = builder.defaults(defaults);
    }

    if let Some(auto_save) = options.auto_save {
        match auto_save {
            AutoSave::DebounceDuration(duration) => {
                builder = builder.auto_save(Duration::from_millis(duration));
            }
            AutoSave::Bool(false) => {
                builder = builder.disable_auto_save();
            }
            _ => {}
        }
    }

    if let Some(serialize_fn_name) = options.serialize_fn_name {
        let serialize_fn = store_state
            .serialize_fns
            .get(&serialize_fn_name)
            .ok_or_else(|| crate::Error::SerializeFunctionNotFound(serialize_fn_name))?;
        builder = builder.serialize(*serialize_fn);
    }

    if let Some(deserialize_fn_name) = options.deserialize_fn_name {
        let deserialize_fn = store_state
            .deserialize_fns
            .get(&deserialize_fn_name)
            .ok_or_else(|| crate::Error::DeserializeFunctionNotFound(deserialize_fn_name))?;
        builder = builder.deserialize(*deserialize_fn);
    }

    if options.create_new {
        builder = builder.create_new();
    }

    if options.override_defaults {
        builder = builder.override_defaults();
    }

    Ok(builder)
}

#[tauri::command]
async fn load<R: Runtime>(
    app: AppHandle<R>,
    store_state: State<'_, StoreState>,
    path: PathBuf,
    options: Option<LoadStoreOptions>,
) -> Result<ResourceId> {
    let builder = builder(app, store_state, path, options)?;
    let (_, rid) = builder.build_inner()?;
    Ok(rid)
}

#[tauri::command]
async fn get_store<R: Runtime>(
    app: AppHandle<R>,
    store_state: State<'_, StoreState>,
    path: PathBuf,
) -> Result<Option<ResourceId>> {
    let stores = store_state.stores.lock().unwrap();
    Ok(stores.get(&resolve_store_path(&app, path)?).copied())
}

#[tauri::command]
async fn set<R: Runtime>(
    app: AppHandle<R>,
    rid: ResourceId,
    key: String,
    value: JsonValue,
) -> Result<()> {
    let store = app.resources_table().get::<Store<R>>(rid)?;
    store.set(key, value);
    Ok(())
}

#[tauri::command]
async fn get<R: Runtime>(
    app: AppHandle<R>,
    rid: ResourceId,
    key: String,
) -> Result<(Option<JsonValue>, bool)> {
    let store = app.resources_table().get::<Store<R>>(rid)?;
    let value = store.get(key);
    let exists = value.is_some();
    Ok((value, exists))
}

#[tauri::command]
async fn has<R: Runtime>(app: AppHandle<R>, rid: ResourceId, key: String) -> Result<bool> {
    let store = app.resources_table().get::<Store<R>>(rid)?;
    Ok(store.has(key))
}

#[tauri::command]
async fn delete<R: Runtime>(app: AppHandle<R>, rid: ResourceId, key: String) -> Result<bool> {
    let store = app.resources_table().get::<Store<R>>(rid)?;
    Ok(store.delete(key))
}

#[tauri::command]
async fn clear<R: Runtime>(app: AppHandle<R>, rid: ResourceId) -> Result<()> {
    let store = app.resources_table().get::<Store<R>>(rid)?;
    store.clear();
    Ok(())
}

#[tauri::command]
async fn reset<R: Runtime>(app: AppHandle<R>, rid: ResourceId) -> Result<()> {
    let store = app.resources_table().get::<Store<R>>(rid)?;
    store.reset();
    Ok(())
}

#[tauri::command]
async fn keys<R: Runtime>(app: AppHandle<R>, rid: ResourceId) -> Result<Vec<String>> {
    let store = app.resources_table().get::<Store<R>>(rid)?;
    Ok(store.keys())
}

#[tauri::command]
async fn values<R: Runtime>(app: AppHandle<R>, rid: ResourceId) -> Result<Vec<JsonValue>> {
    let store = app.resources_table().get::<Store<R>>(rid)?;
    Ok(store.values())
}

#[tauri::command]
async fn entries<R: Runtime>(
    app: AppHandle<R>,
    rid: ResourceId,
) -> Result<Vec<(String, JsonValue)>> {
    let store = app.resources_table().get::<Store<R>>(rid)?;
    Ok(store.entries())
}

#[tauri::command]
async fn length<R: Runtime>(app: AppHandle<R>, rid: ResourceId) -> Result<usize> {
    let store = app.resources_table().get::<Store<R>>(rid)?;
    Ok(store.length())
}

#[tauri::command]
async fn reload<R: Runtime>(
    app: AppHandle<R>,
    rid: ResourceId,
    ignore_defaults: Option<bool>,
) -> Result<()> {
    let store = app.resources_table().get::<Store<R>>(rid)?;
    if ignore_defaults.unwrap_or_default() {
        store.reload_ignore_defaults()
    } else {
        store.reload()
    }
}

#[tauri::command]
async fn save<R: Runtime>(app: AppHandle<R>, rid: ResourceId) -> Result<()> {
    let store = app.resources_table().get::<Store<R>>(rid)?;
    store.save()
}

pub trait StoreExt<R: Runtime> {
    /// Create a store or load an existing store with default settings at the given path.
    ///
    /// If the store is already loaded, its instance is automatically returned.
    ///
    /// # Examples
    ///
    /// ```
    /// use tauri_plugin_store::StoreExt;
    ///
    /// tauri::Builder::default()
    ///   .plugin(tauri_plugin_store::Builder::default().build())
    ///   .setup(|app| {
    ///     let store = app.store("my-store")?;
    ///     Ok(())
    ///   });
    /// ```
    fn store(&self, path: impl AsRef<Path>) -> Result<Arc<Store<R>>>;
    /// Get a store builder.
    ///
    /// The builder can be used to configure the store.
    /// To use the default settings see [`Self::store`].
    ///
    /// # Examples
    ///
    /// ```
    /// use tauri_plugin_store::StoreExt;
    /// use std::time::Duration;
    ///
    /// tauri::Builder::default()
    ///   .plugin(tauri_plugin_store::Builder::default().build())
    ///   .setup(|app| {
    ///     let store = app.store_builder("users.json").auto_save(Duration::from_secs(1)).build()?;
    ///     Ok(())
    ///   });
    /// ```
    fn store_builder(&self, path: impl AsRef<Path>) -> StoreBuilder<R>;
    /// Get a handle of an already loaded store.
    ///
    /// If the store is not loaded or does not exist, it returns `None`.
    ///
    /// Note that using this function can cause race conditions if you fallback to creating or loading the store,
    /// so you should consider using [`Self::store`] if you are not sure if the store is loaded or not.
    ///
    /// # Examples
    ///
    /// ```
    /// use tauri_plugin_store::StoreExt;
    ///
    /// tauri::Builder::default()
    ///   .plugin(tauri_plugin_store::Builder::default().build())
    ///   .setup(|app| {
    ///     let store = if let Some(s) = app.get_store("store.json") {
    ///       s
    ///     } else {
    ///       // this is not thread safe; if another thread is doing the same load/create,
    ///       // there will be a race condition; in this case we could remove the get_store
    ///       // and only run app.store() as it will return the existing store if it has been loaded
    ///       app.store("store.json")?
    ///     };
    ///     Ok(())
    ///   });
    /// ```
    fn get_store(&self, path: impl AsRef<Path>) -> Option<Arc<Store<R>>>;
}

impl<R: Runtime, T: Manager<R>> StoreExt<R> for T {
    fn store(&self, path: impl AsRef<Path>) -> Result<Arc<Store<R>>> {
        StoreBuilder::new(self.app_handle(), path).build()
    }

    fn store_builder(&self, path: impl AsRef<Path>) -> StoreBuilder<R> {
        StoreBuilder::new(self.app_handle(), path)
    }

    fn get_store(&self, path: impl AsRef<Path>) -> Option<Arc<Store<R>>> {
        let collection = self.state::<StoreState>();
        let stores = collection.stores.lock().unwrap();
        stores
            .get(&resolve_store_path(self.app_handle(), path.as_ref()).ok()?)
            .and_then(|rid| self.resources_table().get(*rid).ok())
    }
}

fn default_serialize(
    cache: &HashMap<String, JsonValue>,
) -> std::result::Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    Ok(serde_json::to_vec_pretty(&cache)?)
}

fn default_deserialize(
    bytes: &[u8],
) -> std::result::Result<HashMap<String, JsonValue>, Box<dyn std::error::Error + Send + Sync>> {
    serde_json::from_slice(bytes).map_err(Into::into)
}

pub struct Builder {
    serialize_fns: HashMap<String, SerializeFn>,
    deserialize_fns: HashMap<String, DeserializeFn>,
    default_serialize: SerializeFn,
    default_deserialize: DeserializeFn,
}

impl Default for Builder {
    fn default() -> Self {
        Self {
            serialize_fns: Default::default(),
            deserialize_fns: Default::default(),
            default_serialize,
            default_deserialize,
        }
    }
}

impl Builder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a serialize function to access it from the JavaScript side
    ///
    /// # Examples
    ///
    /// ```
    /// fn no_pretty_json(
    ///     cache: &std::collections::HashMap<String, serde_json::Value>,
    /// ) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    ///     Ok(serde_json::to_vec(&cache)?)
    /// }
    ///
    /// tauri::Builder::default()
    ///     .plugin(
    ///         tauri_plugin_store::Builder::default()
    ///             .register_serialize_fn("no-pretty-json".to_owned(), no_pretty_json)
    ///             .build(),
    ///     );
    /// ```
    pub fn register_serialize_fn(mut self, name: String, serialize_fn: SerializeFn) -> Self {
        self.serialize_fns.insert(name, serialize_fn);
        self
    }

    /// Register a deserialize function to access it from the JavaScript side
    pub fn register_deserialize_fn(mut self, name: String, deserialize_fn: DeserializeFn) -> Self {
        self.deserialize_fns.insert(name, deserialize_fn);
        self
    }

    /// Use this serialize function for stores by default
    ///
    /// # Examples
    ///
    /// ```
    /// fn no_pretty_json(
    ///     cache: &std::collections::HashMap<String, serde_json::Value>,
    /// ) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    ///     Ok(serde_json::to_vec(&cache)?)
    /// }
    ///
    /// tauri::Builder::default()
    ///     .plugin(
    ///         tauri_plugin_store::Builder::default()
    ///             .default_serialize_fn(no_pretty_json)
    ///             .build(),
    ///     );
    /// ```
    pub fn default_serialize_fn(mut self, serialize_fn: SerializeFn) -> Self {
        self.default_serialize = serialize_fn;
        self
    }

    /// Use this deserialize function for stores by default
    pub fn default_deserialize_fn(mut self, deserialize_fn: DeserializeFn) -> Self {
        self.default_deserialize = deserialize_fn;
        self
    }

    /// Builds the plugin.
    ///
    /// # Examples
    ///
    /// ```
    /// tauri::Builder::default()
    ///   .plugin(tauri_plugin_store::Builder::default().build())
    ///   .setup(|app| {
    ///     let store = tauri_plugin_store::StoreBuilder::new(app, "store.bin").build()?;
    ///     Ok(())
    ///   });
    /// ```
    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        plugin::Builder::new("store")
            .invoke_handler(tauri::generate_handler![
                load, get_store, set, get, has, delete, clear, reset, keys, values, length,
                entries, reload, save,
            ])
            .setup(move |app_handle, _api| {
                app_handle.manage(StoreState {
                    stores: Arc::new(Mutex::new(HashMap::new())),
                    serialize_fns: self.serialize_fns,
                    deserialize_fns: self.deserialize_fns,
                    default_serialize: self.default_serialize,
                    default_deserialize: self.default_deserialize,
                });
                Ok(())
            })
            .on_event(|app_handle, event| {
                if let RunEvent::Exit = event {
                    let collection = app_handle.state::<StoreState>();
                    let stores = collection.stores.lock().unwrap();
                    for (path, rid) in stores.iter() {
                        if let Ok(store) = app_handle.resources_table().get::<Store<R>>(*rid) {
                            if let Err(err) = store.save() {
                                tracing::error!("failed to save store {path:?} with error {err:?}");
                            }
                        }
                    }
                }
            })
            .build()
    }
}
