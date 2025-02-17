use cap_utils::spawn_actor;
use futures::Stream;
use serde::Serialize;
use std::sync::RwLock;
use std::{any::Any, collections::HashMap, sync::Arc};
use tauri::ipc::{Channel, InvokeBody};
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::watch::{self, Ref};
use tokio_stream::StreamExt;

pub trait LiveDataErasedApi {
    fn get(&self) -> serde_json::Value;
    fn subscribe(&self, channel: Channel<serde_json::Value>);
}

#[derive(Clone)]
pub struct LiveDataErased(pub Arc<dyn LiveDataErasedApi + Send + Sync + 'static>);

pub struct LiveData<T> {
    name: &'static str,
    value: watch::Sender<T>,
    app: AppHandle,
}

impl<T: Serialize + Send + Sync + Clone + 'static> LiveDataErasedApi for LiveData<T> {
    fn get(&self) -> serde_json::Value {
        serde_json::to_value(&*LiveData::get(self)).unwrap()
    }

    fn subscribe(&self, channel: Channel<serde_json::Value>) {
        let this = self.clone();
        spawn_actor(async move {
            let mut stream = this.stream().await;

            while let Some(data) = stream.next().await {
                channel.send(serde_json::to_value(data).unwrap()).ok();
            }
        });
    }
}

impl<T> Clone for LiveData<T> {
    fn clone(&self) -> Self {
        Self {
            name: self.name,
            value: self.value.clone(),
            app: self.app.clone(),
        }
    }
}

impl<T: Send + Sync + Clone + Serialize + 'static> LiveData<T> {
    pub fn new(name: &'static str, value: T, app: AppHandle) -> Self {
        let (tx, rx) = watch::channel(value);

        let this = Self {
            name,
            value: tx,
            app: app.clone(),
        };

        let state = match app.try_state::<Arc<RwLock<LiveDataStore>>>() {
            None => {
                app.manage(Arc::new(RwLock::new(LiveDataStore::new())));
                app.state::<Arc<RwLock<LiveDataStore>>>()
            }
            Some(state) => state,
        };
        state.write().unwrap().insert(name, this.clone());

        this
    }

    pub fn get(&self) -> Ref<'_, T> {
        self.value.borrow()
    }

    pub async fn update(&self, update: impl FnOnce(&mut T)) {
        self.value.send_modify(update);
    }

    pub async fn stream(&self) -> impl Stream<Item = T> {
        tokio_stream::wrappers::WatchStream::new(self.value.subscribe())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_live_data(app: AppHandle, name: String) -> Result<serde_json::Value, ()> {
    let state = app.state::<Arc<RwLock<LiveDataStore>>>();
    let store = state.read().unwrap();
    Ok(store.get(&name).unwrap().0.get())
}

#[tauri::command]
#[specta::specta]
pub async fn subscribe_live_data(
    app: AppHandle,
    name: String,
    channel: Channel<serde_json::Value>,
) {
    let state = app.state::<Arc<RwLock<LiveDataStore>>>();
    let store = state.read().unwrap();
    store.get(&name).unwrap().0.subscribe(channel);
}

pub struct LiveDataStore {
    data: HashMap<&'static str, LiveDataErased>,
}

impl LiveDataStore {
    pub fn new() -> Self {
        Self {
            data: std::collections::HashMap::new(),
        }
    }

    pub fn insert<T: Any + Send + Sync + Clone + Serialize>(
        &mut self,
        name: &'static str,
        data: LiveData<T>,
    ) {
        self.data.insert(name, LiveDataErased(Arc::new(data)));
    }

    pub fn get(&self, name: &str) -> Option<LiveDataErased> {
        self.data.get(name).cloned()
    }
}

pub trait LiveDataExt<R: Runtime>: Manager<R> {
    async fn live_data(&self, name: &str) -> LiveDataErased {
        let state = self.state::<Arc<RwLock<LiveDataStore>>>();
        let store = state.read().unwrap();
        store.get(name).unwrap().clone()
    }
}
