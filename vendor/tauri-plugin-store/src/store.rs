// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use crate::{ChangePayload, StoreState};
use serde_json::Value as JsonValue;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, Resource, ResourceId, Runtime};
use tokio::{
    select,
    sync::mpsc::{unbounded_channel, UnboundedSender},
    time::sleep,
};

pub type SerializeFn =
    fn(&HashMap<String, JsonValue>) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>>;
pub type DeserializeFn =
    fn(&[u8]) -> Result<HashMap<String, JsonValue>, Box<dyn std::error::Error + Send + Sync>>;

pub fn resolve_store_path<R: Runtime>(
    app: &AppHandle<R>,
    path: impl AsRef<Path>,
) -> crate::Result<PathBuf> {
    Ok(dunce::simplified(&app.path().resolve(path, BaseDirectory::AppData)?).to_path_buf())
}

/// Builds a [`Store`]
pub struct StoreBuilder<R: Runtime> {
    app: AppHandle<R>,
    path: PathBuf,
    defaults: Option<HashMap<String, JsonValue>>,
    serialize_fn: SerializeFn,
    deserialize_fn: DeserializeFn,
    auto_save: Option<Duration>,
    create_new: bool,
    override_defaults: bool,
}

impl<R: Runtime> StoreBuilder<R> {
    /// Creates a new [`StoreBuilder`].
    ///
    /// # Examples
    /// ```
    /// tauri::Builder::default()
    ///   .plugin(tauri_plugin_store::Builder::default().build())
    ///   .setup(|app| {
    ///     let builder = tauri_plugin_store::StoreBuilder::new(app, "store.bin");
    ///     Ok(())
    ///   });
    /// ```
    pub fn new<M: Manager<R>, P: AsRef<Path>>(manager: &M, path: P) -> Self {
        let app = manager.app_handle().clone();
        let state = app.state::<StoreState>();
        let serialize_fn = state.default_serialize;
        let deserialize_fn = state.default_deserialize;
        Self {
            app,
            path: path.as_ref().to_path_buf(),
            defaults: None,
            serialize_fn,
            deserialize_fn,
            auto_save: Some(Duration::from_millis(100)),
            create_new: false,
            override_defaults: false,
        }
    }

    /// Inserts a default key-value pair.
    ///
    /// # Examples
    /// ```
    /// tauri::Builder::default()
    ///   .plugin(tauri_plugin_store::Builder::default().build())
    ///   .setup(|app| {
    ///     let mut defaults = std::collections::HashMap::new();
    ///     defaults.insert("foo".to_string(), "bar".into());
    ///
    ///     let store = tauri_plugin_store::StoreBuilder::new(app, "store.bin")
    ///       .defaults(defaults)
    ///       .build()?;
    ///     Ok(())
    ///   });
    /// ```
    pub fn defaults(mut self, defaults: HashMap<String, JsonValue>) -> Self {
        self.defaults = Some(defaults);
        self
    }

    /// Inserts multiple default key-value pairs.
    ///
    /// # Examples
    /// ```
    /// tauri::Builder::default()
    ///   .plugin(tauri_plugin_store::Builder::default().build())
    ///   .setup(|app| {
    ///     let store = tauri_plugin_store::StoreBuilder::new(app, "store.bin")
    ///       .default("foo".to_string(), "bar")
    ///       .build()?;
    ///     Ok(())
    ///   });
    /// ```
    pub fn default(mut self, key: impl Into<String>, value: impl Into<JsonValue>) -> Self {
        let key = key.into();
        let value = value.into();
        self.defaults
            .get_or_insert(HashMap::new())
            .insert(key, value);
        self
    }

    /// Defines a custom serialization function.
    ///
    /// # Examples
    /// ```
    /// tauri::Builder::default()
    ///   .plugin(tauri_plugin_store::Builder::default().build())
    ///   .setup(|app| {
    ///     let store = tauri_plugin_store::StoreBuilder::new(app, "store.json")
    ///       .serialize(|cache| serde_json::to_vec(&cache).map_err(Into::into))
    ///       .build()?;
    ///     Ok(())
    ///   });
    /// ```
    pub fn serialize(mut self, serialize: SerializeFn) -> Self {
        self.serialize_fn = serialize;
        self
    }

    /// Defines a custom deserialization function
    ///
    /// # Examples
    /// ```
    /// tauri::Builder::default()
    ///   .plugin(tauri_plugin_store::Builder::default().build())
    ///   .setup(|app| {
    ///     let store = tauri_plugin_store::StoreBuilder::new(app, "store.json")
    ///       .deserialize(|bytes| serde_json::from_slice(&bytes).map_err(Into::into))
    ///       .build()?;
    ///     Ok(())
    ///   });
    /// ```
    pub fn deserialize(mut self, deserialize: DeserializeFn) -> Self {
        self.deserialize_fn = deserialize;
        self
    }

    /// Auto save on modified with a debounce duration
    ///
    /// # Examples
    /// ```
    /// tauri::Builder::default()
    ///    .plugin(tauri_plugin_store::Builder::default().build())
    ///   .setup(|app| {
    ///     let store = tauri_plugin_store::StoreBuilder::new(app, "store.json")
    ///         .auto_save(std::time::Duration::from_millis(100))
    ///         .build()?;
    ///     Ok(())
    ///   });
    /// ```
    pub fn auto_save(mut self, debounce_duration: Duration) -> Self {
        self.auto_save = Some(debounce_duration);
        self
    }

    /// Disable auto save on modified with a debounce duration.
    pub fn disable_auto_save(mut self) -> Self {
        self.auto_save = None;
        self
    }

    /// Force create a new store with default values even if it already exists.
    pub fn create_new(mut self) -> Self {
        self.create_new = true;
        self
    }

    /// Override the store values when creating the store, ignoring defaults.
    pub fn override_defaults(mut self) -> Self {
        self.override_defaults = true;
        self
    }

    pub(crate) fn build_inner(mut self) -> crate::Result<(Arc<Store<R>>, ResourceId)> {
        let stores = self.app.state::<StoreState>().stores.clone();
        let mut stores = stores.lock().unwrap();

        self.path = resolve_store_path(&self.app, self.path)?;

        if self.create_new {
            if let Some(rid) = stores.remove(&self.path) {
                let _ = self.app.resources_table().take::<Store<R>>(rid);
            }
        } else if let Some(rid) = stores.get(&self.path) {
            // Tauri's exit cleanup clears resources without calling Store::close.
            return Ok((self.app.resources_table().get(*rid)?, *rid));
        }

        // if stores.contains_key(&self.path) {
        //     return Err(crate::Error::AlreadyExists(self.path));
        // }

        let mut store_inner = StoreInner::new(
            self.app.clone(),
            self.path.clone(),
            self.defaults.take(),
            self.serialize_fn,
            self.deserialize_fn,
        );

        if !self.create_new {
            if self.override_defaults {
                let _ = store_inner.load_ignore_defaults();
            } else {
                let _ = store_inner.load();
            }
        }

        let store = Store {
            auto_save: self.auto_save,
            auto_save_debounce_sender: Arc::new(Mutex::new(None)),
            store: Arc::new(Mutex::new(store_inner)),
        };

        let store = Arc::new(store);
        let rid = self.app.resources_table().add_arc(store.clone());
        stores.insert(self.path, rid);

        Ok((store, rid))
    }

    /// Load the existing store with the same path or creates a new [`Store`].
    ///
    /// If a store with the same path has already been loaded its instance is returned.
    ///
    /// # Examples
    /// ```
    /// tauri::Builder::default()
    ///   .plugin(tauri_plugin_store::Builder::default().build())
    ///   .setup(|app| {
    ///     let store = tauri_plugin_store::StoreBuilder::new(app, "store.json").build();
    ///     Ok(())
    ///   });
    /// ```
    pub fn build(self) -> crate::Result<Arc<Store<R>>> {
        let (store, _) = self.build_inner()?;
        Ok(store)
    }
}

enum AutoSaveMessage {
    Reset,
    Cancel,
}

#[derive(Clone)]
struct StoreInner<R: Runtime> {
    app: AppHandle<R>,
    path: PathBuf,
    cache: HashMap<String, JsonValue>,
    defaults: Option<HashMap<String, JsonValue>>,
    serialize_fn: SerializeFn,
    deserialize_fn: DeserializeFn,
}

impl<R: Runtime> StoreInner<R> {
    fn new(
        app: AppHandle<R>,
        path: PathBuf,
        defaults: Option<HashMap<String, JsonValue>>,
        serialize_fn: SerializeFn,
        deserialize_fn: DeserializeFn,
    ) -> Self {
        Self {
            app,
            path,
            cache: defaults.clone().unwrap_or_default(),
            defaults,
            serialize_fn,
            deserialize_fn,
        }
    }

    /// Saves the store to disk at the store's `path`.
    pub fn save(&self) -> crate::Result<()> {
        fs::create_dir_all(self.path.parent().expect("invalid store path"))?;

        let bytes = (self.serialize_fn)(&self.cache).map_err(crate::Error::Serialize)?;
        fs::write(&self.path, bytes)?;

        Ok(())
    }

    /// Update the store from the on-disk state
    ///
    /// Note: This method loads the data and merges it with the current store
    pub fn load(&mut self) -> crate::Result<()> {
        let bytes = fs::read(&self.path)?;

        self.cache
            .extend((self.deserialize_fn)(&bytes).map_err(crate::Error::Deserialize)?);

        Ok(())
    }

    /// Load the store from the on-disk state, ignoring defaults
    pub fn load_ignore_defaults(&mut self) -> crate::Result<()> {
        let bytes = fs::read(&self.path)?;
        self.cache = (self.deserialize_fn)(&bytes).map_err(crate::Error::Deserialize)?;
        Ok(())
    }

    /// Inserts a key-value pair into the store.
    pub fn set(&mut self, key: impl Into<String>, value: impl Into<JsonValue>) {
        let key = key.into();
        let value = value.into();
        self.cache.insert(key.clone(), value.clone());
        let _ = self.emit_change_event(&key, Some(&value));
    }

    /// Returns a reference to the value corresponding to the key.
    pub fn get(&self, key: impl AsRef<str>) -> Option<&JsonValue> {
        self.cache.get(key.as_ref())
    }

    /// Returns `true` if the given `key` exists in the store.
    pub fn has(&self, key: impl AsRef<str>) -> bool {
        self.cache.contains_key(key.as_ref())
    }

    /// Removes a key-value pair from the store.
    pub fn delete(&mut self, key: impl AsRef<str>) -> bool {
        let flag = self.cache.remove(key.as_ref()).is_some();
        if flag {
            let _ = self.emit_change_event(key.as_ref(), None);
        }
        flag
    }

    /// Clears the store, removing all key-value pairs.
    ///
    /// Note: To clear the storage and reset it to its `default` value, use [`reset`](Self::reset) instead.
    pub fn clear(&mut self) {
        let keys: Vec<String> = self.cache.keys().cloned().collect();
        self.cache.clear();
        for key in &keys {
            let _ = self.emit_change_event(key, None);
        }
    }

    /// Resets the store to its `default` value.
    ///
    /// If no default value has been set, this method behaves identical to [`clear`](Self::clear).
    pub fn reset(&mut self) {
        if let Some(defaults) = &self.defaults {
            for (key, value) in &self.cache {
                if defaults.get(key) != Some(value) {
                    let _ = self.emit_change_event(key, defaults.get(key));
                }
            }
            for (key, value) in defaults {
                if !self.cache.contains_key(key) {
                    let _ = self.emit_change_event(key, Some(value));
                }
            }
            self.cache.clone_from(defaults);
        } else {
            self.clear()
        }
    }

    /// An iterator visiting all keys in arbitrary order.
    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.cache.keys()
    }

    /// An iterator visiting all values in arbitrary order.
    pub fn values(&self) -> impl Iterator<Item = &JsonValue> {
        self.cache.values()
    }

    /// An iterator visiting all key-value pairs in arbitrary order.
    pub fn entries(&self) -> impl Iterator<Item = (&String, &JsonValue)> {
        self.cache.iter()
    }

    /// Returns the number of elements in the store.
    pub fn len(&self) -> usize {
        self.cache.len()
    }

    /// Returns true if the store contains no elements.
    pub fn is_empty(&self) -> bool {
        self.cache.is_empty()
    }

    fn emit_change_event(&self, key: &str, value: Option<&JsonValue>) -> crate::Result<()> {
        let state = self.app.state::<StoreState>();
        let stores = state.stores.lock().unwrap();
        let exists = value.is_some();
        self.app.emit(
            "store://change",
            ChangePayload {
                path: &self.path,
                resource_id: stores.get(&self.path).copied(),
                key,
                value,
                exists,
            },
        )?;
        Ok(())
    }
}

impl<R: Runtime> std::fmt::Debug for StoreInner<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store")
            .field("path", &self.path)
            .field("cache", &self.cache)
            .finish()
    }
}

pub struct Store<R: Runtime> {
    auto_save: Option<Duration>,
    auto_save_debounce_sender: Arc<Mutex<Option<UnboundedSender<AutoSaveMessage>>>>,
    store: Arc<Mutex<StoreInner<R>>>,
}

impl<R: Runtime> Resource for Store<R> {
    fn close(self: Arc<Self>) {
        let store = self.store.lock().unwrap();
        let state = store.app.state::<StoreState>();
        let mut stores = state.stores.lock().unwrap();
        stores.remove(&store.path);
    }
}

impl<R: Runtime> Store<R> {
    // /// Do something with the inner store,
    // /// useful for batching some work if you need higher performance
    // pub fn with_store<T>(&self, f: impl FnOnce(&mut StoreInner<R>) -> T) -> T {
    //     let mut store = self.store.lock().unwrap();
    //     f(&mut store)
    // }

    /// Inserts a key-value pair into the store.
    pub fn set(&self, key: impl Into<String>, value: impl Into<JsonValue>) {
        self.store.lock().unwrap().set(key.into(), value.into());
        let _ = self.trigger_auto_save();
    }

    /// Returns the value for the given `key` or `None` if the key does not exist.
    pub fn get(&self, key: impl AsRef<str>) -> Option<JsonValue> {
        self.store.lock().unwrap().get(key).cloned()
    }

    /// Returns `true` if the given `key` exists in the store.
    pub fn has(&self, key: impl AsRef<str>) -> bool {
        self.store.lock().unwrap().has(key)
    }

    /// Removes a key-value pair from the store.
    pub fn delete(&self, key: impl AsRef<str>) -> bool {
        let deleted = self.store.lock().unwrap().delete(key);
        if deleted {
            let _ = self.trigger_auto_save();
        }
        deleted
    }

    /// Clears the store, removing all key-value pairs.
    ///
    /// Note: To clear the storage and reset it to its `default` value, use [`reset`](Self::reset) instead.
    pub fn clear(&self) {
        self.store.lock().unwrap().clear();
        let _ = self.trigger_auto_save();
    }

    /// Resets the store to its `default` value.
    ///
    /// If no default value has been set, this method behaves identical to [`clear`](Self::clear).
    pub fn reset(&self) {
        self.store.lock().unwrap().reset();
        let _ = self.trigger_auto_save();
    }

    /// Returns a list of all keys in the store.
    pub fn keys(&self) -> Vec<String> {
        self.store.lock().unwrap().keys().cloned().collect()
    }

    /// Returns a list of all values in the store.
    pub fn values(&self) -> Vec<JsonValue> {
        self.store.lock().unwrap().values().cloned().collect()
    }

    /// Returns a list of all key-value pairs in the store.
    pub fn entries(&self) -> Vec<(String, JsonValue)> {
        self.store
            .lock()
            .unwrap()
            .entries()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect()
    }

    /// Returns the number of elements in the store.
    pub fn length(&self) -> usize {
        self.store.lock().unwrap().len()
    }

    /// Returns true if the store contains no elements.
    pub fn is_empty(&self) -> bool {
        self.store.lock().unwrap().is_empty()
    }

    /// Update the store from the on-disk state
    ///
    /// Note:
    ///   - This method loads the data and merges it with the current store,
    ///     this behavior will be changed to resetting to default first and then merging with the on-disk state in v3,
    ///     to fully match the store with the on-disk state,
    ///     use [`reload_override_defaults`](Self::reload_override_defaults) instead
    ///   - This method does not emit change events
    pub fn reload(&self) -> crate::Result<()> {
        self.store.lock().unwrap().load()
    }

    /// Load the store from the on-disk state, ignoring defaults
    ///
    /// Note: This method does not emit change events
    pub fn reload_ignore_defaults(&self) -> crate::Result<()> {
        self.store.lock().unwrap().load_ignore_defaults()
    }

    /// Saves the store to disk at the store's `path`.
    pub fn save(&self) -> crate::Result<()> {
        if let Some(sender) = self.auto_save_debounce_sender.lock().unwrap().take() {
            let _ = sender.send(AutoSaveMessage::Cancel);
        }
        self.store.lock().unwrap().save()
    }

    /// Removes the store from the resource table
    pub fn close_resource(&self) {
        let store = self.store.lock().unwrap();
        let app = store.app.clone();
        let state = app.state::<StoreState>();
        let stores = state.stores.lock().unwrap();
        if let Some(rid) = stores.get(&store.path).copied() {
            drop(store);
            drop(stores);
            let _ = app.resources_table().close(rid);
        }
    }

    fn trigger_auto_save(&self) -> crate::Result<()> {
        let Some(auto_save_delay) = self.auto_save else {
            return Ok(());
        };
        if auto_save_delay.is_zero() {
            return self.save();
        }
        let mut auto_save_debounce_sender = self.auto_save_debounce_sender.lock().unwrap();
        if let Some(ref sender) = *auto_save_debounce_sender {
            let _ = sender.send(AutoSaveMessage::Reset);
            return Ok(());
        }
        let (sender, mut receiver) = unbounded_channel();
        auto_save_debounce_sender.replace(sender);
        drop(auto_save_debounce_sender);
        let store = self.store.clone();
        let auto_save_debounce_sender = self.auto_save_debounce_sender.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                select! {
                    should_cancel = receiver.recv() => {
                        if matches!(should_cancel, Some(AutoSaveMessage::Cancel) | None) {
                            return;
                        }
                    }
                    _ = sleep(auto_save_delay) => {
                        auto_save_debounce_sender.lock().unwrap().take();
                        let _ = store.lock().unwrap().save();
                        return;
                    }
                };
            }
        });
        Ok(())
    }

    fn apply_pending_auto_save(&self) {
        // Cancel and save if auto save is pending
        if let Some(sender) = self.auto_save_debounce_sender.lock().unwrap().take() {
            let _ = sender.send(AutoSaveMessage::Cancel);
            let _ = self.save();
        };
    }
}

impl<R: Runtime> Drop for Store<R> {
    fn drop(&mut self) {
        self.apply_pending_auto_save();
    }
}
