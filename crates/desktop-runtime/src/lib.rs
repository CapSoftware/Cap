mod protocol;
mod transport;

use std::{
    any::{Any, TypeId},
    collections::{HashMap, hash_map::Entry},
    future::Future,
    marker::PhantomData,
    ops::Deref,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc, Mutex as StdMutex, OnceLock, RwLock,
        atomic::{AtomicU64, Ordering},
    },
};

extern crate self as cap_desktop_runtime;

pub use cap_desktop_runtime_macros::{Event, command};
pub use inventory;
pub use protocol::{
    BackendMessage, ChannelMessage, CommandResponse, DesktopOperation, PROTOCOL_VERSION,
    ShellMessage, WindowEvent, WindowOptions, WindowState,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};
use tokio::sync::mpsc;
pub use transport::{BackendOptions, run_backend};
pub use url::Url;

pub type Error = String;
pub type Result<T> = std::result::Result<T, Error>;
pub type CommandFuture = Pin<Box<dyn Future<Output = Result<Value>> + Send + 'static>>;
pub type EventId = u64;

pub trait Runtime: Send + Sync + 'static {}

#[derive(Clone, Copy, Debug)]
pub struct ElectronRuntime;

impl Runtime for ElectronRuntime {}

pub type Wry = ElectronRuntime;

pub trait Manager<R: Runtime = Wry> {
    fn app_handle(&self) -> &AppHandle<R>;

    fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> {
        self.app_handle().state()
    }

    fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>> {
        self.app_handle().try_state()
    }
}
pub trait Emitter<R: Runtime = Wry> {}
pub trait Listener<R: Runtime = Wry> {}

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
pub struct LogicalPosition<T> {
    pub x: T,
    pub y: T,
}

impl<T> LogicalPosition<T> {
    pub const fn new(x: T, y: T) -> Self {
        Self { x, y }
    }
}

impl From<LogicalPosition<u32>> for Position {
    fn from(value: LogicalPosition<u32>) -> Self {
        Self::Logical(LogicalPosition::new(value.x as f64, value.y as f64))
    }
}

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
pub struct PhysicalPosition<T> {
    pub x: T,
    pub y: T,
}

impl<T> PhysicalPosition<T> {
    pub const fn new(x: T, y: T) -> Self {
        Self { x, y }
    }
}

impl PhysicalPosition<i32> {
    pub fn to_logical<U: From<f64>>(self, scale_factor: f64) -> LogicalPosition<U> {
        LogicalPosition::new(
            U::from(self.x as f64 / scale_factor),
            U::from(self.y as f64 / scale_factor),
        )
    }
}

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
pub struct LogicalSize<T> {
    pub width: T,
    pub height: T,
}

impl<T> LogicalSize<T> {
    pub const fn new(width: T, height: T) -> Self {
        Self { width, height }
    }
}

impl From<LogicalSize<u32>> for Size {
    fn from(value: LogicalSize<u32>) -> Self {
        Self::Logical(LogicalSize::new(value.width as f64, value.height as f64))
    }
}

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
pub struct PhysicalSize<T> {
    pub width: T,
    pub height: T,
}

impl<T> PhysicalSize<T> {
    pub const fn new(width: T, height: T) -> Self {
        Self { width, height }
    }
}

impl PhysicalSize<u32> {
    pub fn to_logical<U: From<f64>>(self, scale_factor: f64) -> LogicalSize<U> {
        LogicalSize::new(
            U::from(self.width as f64 / scale_factor),
            U::from(self.height as f64 / scale_factor),
        )
    }
}

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
pub enum Position {
    Logical(LogicalPosition<f64>),
    Physical(PhysicalPosition<i32>),
}

impl From<LogicalPosition<f64>> for Position {
    fn from(value: LogicalPosition<f64>) -> Self {
        Self::Logical(value)
    }
}

impl From<PhysicalPosition<i32>> for Position {
    fn from(value: PhysicalPosition<i32>) -> Self {
        Self::Physical(value)
    }
}

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
pub enum Size {
    Logical(LogicalSize<f64>),
    Physical(PhysicalSize<u32>),
}

impl From<LogicalSize<f64>> for Size {
    fn from(value: LogicalSize<f64>) -> Self {
        Self::Logical(value)
    }
}

impl From<PhysicalSize<u32>> for Size {
    fn from(value: PhysicalSize<u32>) -> Self {
        Self::Physical(value)
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct Monitor {
    pub name: Option<String>,
    pub position: PhysicalPosition<i32>,
    pub size: PhysicalSize<u32>,
    pub work_area: MonitorWorkArea,
    pub scale_factor: f64,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct MonitorWorkArea {
    pub position: PhysicalPosition<i32>,
    pub size: PhysicalSize<u32>,
}

impl Monitor {
    pub fn position(&self) -> &PhysicalPosition<i32> {
        &self.position
    }

    pub fn size(&self) -> &PhysicalSize<u32> {
        &self.size
    }

    pub fn scale_factor(&self) -> f64 {
        self.scale_factor
    }
}

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivationPolicy {
    Regular,
    Accessory,
    Prohibited,
}

pub mod path {
    #[derive(Clone, Copy, Debug)]
    pub enum BaseDirectory {
        Audio,
        Cache,
        Config,
        Data,
        LocalData,
        Desktop,
        Document,
        Download,
        Home,
        Picture,
        Public,
        Resource,
        Temp,
        Template,
        Video,
        AppConfig,
        AppData,
        AppLocalData,
        AppCache,
        AppLog,
    }
}

pub mod ipc {
    pub use crate::{Channel, CommandArg};
    pub type InvokeError = String;
}

pub struct CommandRegistration {
    pub name: &'static str,
    pub handler: fn(CommandContext, Value) -> CommandFuture,
}

inventory::collect!(CommandRegistration);

#[derive(Clone)]
pub struct CommandContext {
    app: AppHandle,
    window_label: String,
    channel_sender: mpsc::UnboundedSender<ChannelMessage>,
}

impl CommandContext {
    pub fn new(
        app: AppHandle,
        window_label: impl Into<String>,
        channel_sender: mpsc::UnboundedSender<ChannelMessage>,
    ) -> Self {
        Self {
            app,
            window_label: window_label.into(),
            channel_sender,
        }
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }

    pub fn window(&self) -> Window {
        Window::new(self.app.clone(), self.window_label.clone())
    }

    pub fn channel_sender(&self) -> mpsc::UnboundedSender<ChannelMessage> {
        self.channel_sender.clone()
    }
}

pub trait CommandArg: Sized {
    fn from_command(context: &CommandContext) -> Result<Self>;
}

pub fn argument_object(value: Value) -> Result<Map<String, Value>> {
    match value {
        Value::Null => Ok(Map::new()),
        Value::Object(arguments) => Ok(arguments),
        _ => Err("desktop command arguments must be an object".to_string()),
    }
}

pub fn take_argument(arguments: &mut Map<String, Value>, name: &str) -> Result<Value> {
    arguments
        .remove(name)
        .ok_or_else(|| format!("missing desktop command argument '{name}'"))
}

pub fn deserialize_argument<T: DeserializeOwned>(value: Value, name: &str) -> Result<T> {
    serde_json::from_value(value)
        .map_err(|error| format!("invalid desktop command argument '{name}': {error}"))
}

pub fn serialize_command_result<T: Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value)
        .map_err(|error| format!("failed to serialize command result: {error}"))
}

pub async fn dispatch_command(
    context: CommandContext,
    command: &str,
    arguments: Value,
) -> Result<Value> {
    let registration = inventory::iter::<CommandRegistration>
        .into_iter()
        .find(|registration| registration.name == command)
        .ok_or_else(|| format!("unknown desktop command '{command}'"))?;
    (registration.handler)(context, arguments).await
}

type ManagedState = HashMap<TypeId, Arc<dyn Any + Send + Sync>>;
type EventHandler = Arc<dyn Fn(Value) + Send + Sync>;
type WindowEventHandler = Arc<dyn Fn(WindowEvent) + Send + Sync>;
type GlobalWindowEventHandler = Arc<dyn Fn(String, WindowEvent) + Send + Sync>;

pub struct AppHandle<R: Runtime = Wry> {
    inner: Arc<AppHandleInner>,
    runtime: PhantomData<R>,
}

struct AppHandleInner {
    outbound: mpsc::UnboundedSender<BackendMessage>,
    state: RwLock<ManagedState>,
    windows: RwLock<HashMap<String, WindowState>>,
    listeners: RwLock<HashMap<String, HashMap<EventId, EventHandler>>>,
    window_listeners: RwLock<HashMap<String, HashMap<EventId, WindowEventHandler>>>,
    global_window_listeners: RwLock<HashMap<EventId, GlobalWindowEventHandler>>,
    next_event_id: AtomicU64,
    paths: AppPaths,
    stores: RwLock<HashMap<String, Arc<Store>>>,
    native_requests: StdMutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<Value>>>>,
    next_native_request_id: AtomicU64,
    cursor_position: RwLock<PhysicalPosition<f64>>,
}

impl<R: Runtime> Clone for AppHandle<R> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            runtime: PhantomData,
        }
    }
}

impl<R: Runtime> std::fmt::Debug for AppHandle<R> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("AppHandle").finish_non_exhaustive()
    }
}

impl<R: Runtime> Manager<R> for AppHandle<R> {
    fn app_handle(&self) -> &AppHandle<R> {
        self
    }
}
impl<R: Runtime> Emitter<R> for AppHandle<R> {}
impl<R: Runtime> Listener<R> for AppHandle<R> {}

impl<R: Runtime> AppHandle<R> {
    pub fn new(outbound: mpsc::UnboundedSender<BackendMessage>, paths: AppPaths) -> Self {
        Self {
            inner: Arc::new(AppHandleInner {
                outbound,
                state: RwLock::new(HashMap::new()),
                windows: RwLock::new(HashMap::new()),
                listeners: RwLock::new(HashMap::new()),
                window_listeners: RwLock::new(HashMap::new()),
                global_window_listeners: RwLock::new(HashMap::new()),
                next_event_id: AtomicU64::new(1),
                paths,
                stores: RwLock::new(HashMap::new()),
                native_requests: StdMutex::new(HashMap::new()),
                next_native_request_id: AtomicU64::new(1),
                cursor_position: RwLock::new(PhysicalPosition::new(0.0, 0.0)),
            }),
            runtime: PhantomData,
        }
    }

    pub fn manage<T: Send + Sync + 'static>(&self, value: T) -> bool {
        let mut state = self
            .inner
            .state
            .write()
            .expect("desktop state lock poisoned");
        match state.entry(TypeId::of::<T>()) {
            Entry::Vacant(entry) => {
                entry.insert(Arc::new(value));
                true
            }
            Entry::Occupied(_) => false,
        }
    }

    pub fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> {
        self.try_state::<T>().unwrap_or_else(|| {
            panic!(
                "desktop state '{}' is not managed",
                std::any::type_name::<T>()
            )
        })
    }

    pub fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>> {
        let value = self
            .inner
            .state
            .read()
            .expect("desktop state lock poisoned")
            .get(&TypeId::of::<T>())?
            .clone()
            .downcast::<T>()
            .ok()?;
        Some(State {
            value,
            lifetime: PhantomData,
        })
    }

    pub fn emit<S: Serialize>(&self, event: &str, payload: S) -> Result<()> {
        let payload = serde_json::to_value(payload)
            .map_err(|error| format!("failed to serialize event '{event}': {error}"))?;
        self.emit_value(event, payload)
    }

    pub fn emit_value(&self, event: &str, payload: Value) -> Result<()> {
        self.receive_event(event, payload.clone());
        self.send(BackendMessage::Event {
            event: event.to_string(),
            payload,
            target: None,
        })
    }

    pub fn receive_event(&self, event: &str, payload: Value) {
        if let Some(handlers) = self
            .inner
            .listeners
            .read()
            .expect("desktop event lock poisoned")
            .get(event)
        {
            for handler in handlers.values() {
                handler(payload.clone());
            }
        }
    }

    pub fn receive_window_event(&self, label: String, event: WindowEvent) {
        if matches!(event, WindowEvent::Destroyed) {
            self.remove_window(&label);
        }
        if let Some(handlers) = self
            .inner
            .window_listeners
            .read()
            .expect("desktop window event lock poisoned")
            .get(&label)
        {
            for handler in handlers.values() {
                handler(event.clone());
            }
        }
        for handler in self
            .inner
            .global_window_listeners
            .read()
            .expect("desktop global window event lock poisoned")
            .values()
        {
            handler(label.clone(), event.clone());
        }
    }

    fn listen_value(
        &self,
        event: impl Into<String>,
        handler: impl Fn(Value) + Send + Sync + 'static,
    ) -> EventId {
        let id = self.inner.next_event_id.fetch_add(1, Ordering::Relaxed);
        self.inner
            .listeners
            .write()
            .expect("desktop event lock poisoned")
            .entry(event.into())
            .or_default()
            .insert(id, Arc::new(handler));
        id
    }

    pub fn listen(
        &self,
        event: impl Into<String>,
        handler: impl Fn(RuntimeEvent) + Send + Sync + 'static,
    ) -> EventId {
        self.listen_value(event, move |payload| {
            handler(RuntimeEvent {
                payload: serde_json::to_string(&payload).unwrap_or_else(|_| "null".to_string()),
            });
        })
    }

    pub fn listen_any(
        &self,
        event: impl Into<String>,
        handler: impl Fn(RuntimeEvent) + Send + Sync + 'static,
    ) -> EventId {
        self.listen(event, handler)
    }

    pub fn unlisten(&self, id: EventId) {
        for handlers in self
            .inner
            .listeners
            .write()
            .expect("desktop event lock poisoned")
            .values_mut()
        {
            handlers.remove(&id);
        }
    }

    fn listen_window(
        &self,
        label: String,
        handler: impl Fn(WindowEvent) + Send + Sync + 'static,
    ) -> EventId {
        let id = self.inner.next_event_id.fetch_add(1, Ordering::Relaxed);
        self.inner
            .window_listeners
            .write()
            .expect("desktop window event lock poisoned")
            .entry(label)
            .or_default()
            .insert(id, Arc::new(handler));
        id
    }

    pub fn on_window_event(
        &self,
        handler: impl Fn(Window<R>, WindowEvent) + Send + Sync + 'static,
    ) -> EventId {
        let id = self.inner.next_event_id.fetch_add(1, Ordering::Relaxed);
        let app = self.clone();
        self.inner
            .global_window_listeners
            .write()
            .expect("desktop global window event lock poisoned")
            .insert(
                id,
                Arc::new(move |label, event| {
                    handler(Window::new(app.clone(), label), event);
                }),
            );
        id
    }

    pub fn get_webview_window(&self, label: &str) -> Option<Window<R>> {
        self.inner
            .windows
            .read()
            .expect("desktop window lock poisoned")
            .contains_key(label)
            .then(|| Window::new(self.clone(), label))
    }

    pub fn webview_windows(&self) -> HashMap<String, Window<R>> {
        self.inner
            .windows
            .read()
            .expect("desktop window lock poisoned")
            .keys()
            .map(|label| (label.clone(), Window::new(self.clone(), label)))
            .collect()
    }

    pub fn update_window_state(&self, label: String, state: WindowState) {
        self.inner
            .windows
            .write()
            .expect("desktop window lock poisoned")
            .insert(label, state);
    }

    pub fn remove_window(&self, label: &str) {
        self.inner
            .windows
            .write()
            .expect("desktop window lock poisoned")
            .remove(label);
    }

    pub fn path(&self) -> &AppPaths {
        &self.inner.paths
    }

    pub fn store(&self, name: &str) -> Result<Arc<Store>> {
        if let Some(store) = self
            .inner
            .stores
            .read()
            .expect("desktop stores lock poisoned")
            .get(name)
        {
            return Ok(store.clone());
        }
        let path = self.inner.paths.app_data_dir.join(format!("{name}.json"));
        let store = Arc::new(Store::load(path)?);
        self.inner
            .stores
            .write()
            .expect("desktop stores lock poisoned")
            .insert(name.to_string(), store.clone());
        Ok(store)
    }

    pub fn run_on_main_thread(&self, task: impl FnOnce() + Send + 'static) -> Result<()> {
        task();
        Ok(())
    }

    pub fn exit(&self, code: i32) {
        let _ = self.send(BackendMessage::NativeOperation {
            operation: "app.exit".to_string(),
            payload: serde_json::json!({ "exitCode": code }),
        });
    }

    pub fn set_dock_visibility(&self, visible: bool) -> Result<()> {
        self.native_operation(
            "app.dockVisibility",
            serde_json::json!({ "visible": visible }),
        )
    }

    pub fn set_activation_policy(&self, policy: ActivationPolicy) -> Result<()> {
        self.native_operation(
            "app.activationPolicy",
            serde_json::json!({ "policy": policy }),
        )
    }

    pub fn native_operation<S: Serialize>(&self, operation: &str, payload: S) -> Result<()> {
        let payload = serde_json::to_value(payload)
            .map_err(|error| format!("failed to serialize native operation: {error}"))?;
        self.send(BackendMessage::NativeOperation {
            operation: operation.to_string(),
            payload,
        })
    }

    pub async fn native_request<T: DeserializeOwned, S: Serialize>(
        &self,
        operation: &str,
        payload: S,
    ) -> Result<T> {
        let id = self
            .inner
            .next_native_request_id
            .fetch_add(1, Ordering::Relaxed);
        let payload = serde_json::to_value(payload)
            .map_err(|error| format!("failed to serialize native request: {error}"))?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.inner
            .native_requests
            .lock()
            .expect("desktop native request lock poisoned")
            .insert(id, sender);
        if let Err(error) = self.send(BackendMessage::NativeRequest {
            id,
            operation: operation.to_string(),
            payload,
        }) {
            self.inner
                .native_requests
                .lock()
                .expect("desktop native request lock poisoned")
                .remove(&id);
            return Err(error);
        }
        let value = receiver
            .await
            .map_err(|_| "Electron native request was cancelled".to_string())??;
        serde_json::from_value(value)
            .map_err(|error| format!("invalid Electron native response: {error}"))
    }

    pub fn receive_native_result(&self, id: u64, result: Result<Value>) {
        if let Some(sender) = self
            .inner
            .native_requests
            .lock()
            .expect("desktop native request lock poisoned")
            .remove(&id)
        {
            let _ = sender.send(result);
        }
    }

    pub fn receive_cursor_position(&self, x: f64, y: f64) {
        *self
            .inner
            .cursor_position
            .write()
            .expect("desktop cursor position lock poisoned") = PhysicalPosition::new(x, y);
    }

    pub fn send(&self, message: BackendMessage) -> Result<()> {
        self.inner
            .outbound
            .send(message)
            .map_err(|_| "Electron desktop connection is closed".to_string())
    }
}

pub struct State<'a, T> {
    value: Arc<T>,
    lifetime: PhantomData<&'a T>,
}

pub type MutableState<'a, T> = State<'a, T>;

impl<T> Clone for State<'_, T> {
    fn clone(&self) -> Self {
        Self {
            value: self.value.clone(),
            lifetime: PhantomData,
        }
    }
}

impl<T> Deref for State<'_, T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.value
    }
}

impl<T> State<'_, T> {
    pub fn inner(&self) -> &T {
        &self.value
    }
}

impl<T: std::fmt::Debug> std::fmt::Debug for State<'_, T> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.value.fmt(formatter)
    }
}

pub struct Window<R: Runtime = Wry> {
    app: AppHandle<R>,
    label: String,
}

pub type WebviewWindow<R = Wry> = Window<R>;

impl<R: Runtime> Clone for Window<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            label: self.label.clone(),
        }
    }
}

impl<R: Runtime> std::fmt::Debug for Window<R> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Window")
            .field("label", &self.label)
            .finish()
    }
}

impl<R: Runtime> Manager<R> for Window<R> {
    fn app_handle(&self) -> &AppHandle<R> {
        &self.app
    }
}
impl<R: Runtime> Emitter<R> for Window<R> {}
impl<R: Runtime> Listener<R> for Window<R> {}

impl<R: Runtime> Window<R> {
    pub fn new(app: AppHandle<R>, label: impl Into<String>) -> Self {
        Self {
            app,
            label: label.into(),
        }
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn app_handle(&self) -> &AppHandle<R> {
        &self.app
    }

    pub fn run_on_main_thread(&self, task: impl FnOnce() + Send + 'static) -> Result<()> {
        self.app.run_on_main_thread(task)
    }

    pub fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> {
        self.app.state()
    }

    pub fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>> {
        self.app.try_state()
    }

    pub fn manage<T: Send + Sync + 'static>(&self, value: T) -> bool {
        self.app.manage(value)
    }

    pub fn show(&self) -> Result<()> {
        self.operation(DesktopOperation::Show)
    }

    pub fn hide(&self) -> Result<()> {
        self.operation(DesktopOperation::Hide)
    }

    pub fn close(&self) -> Result<()> {
        self.operation(DesktopOperation::Close)
    }

    pub fn destroy(&self) -> Result<()> {
        self.operation(DesktopOperation::Destroy)
    }

    pub fn set_focus(&self) -> Result<()> {
        self.operation(DesktopOperation::Focus)
    }

    pub fn is_visible(&self) -> Result<bool> {
        Ok(self.state_snapshot()?.visible)
    }

    pub fn is_focused(&self) -> Result<bool> {
        Ok(self.state_snapshot()?.focused)
    }

    pub fn is_fullscreen(&self) -> Result<bool> {
        Ok(self.state_snapshot()?.fullscreen)
    }

    pub fn native_window_id(&self) -> Result<Option<u64>> {
        Ok(self.state_snapshot()?.native_window_id)
    }

    pub fn set_content_protected(&self, enabled: bool) -> Result<()> {
        self.operation(DesktopOperation::SetContentProtected { enabled })
    }

    pub fn minimize(&self) -> Result<()> {
        self.operation(DesktopOperation::Minimize)
    }

    pub fn unminimize(&self) -> Result<()> {
        self.operation(DesktopOperation::Unminimize)
    }

    pub fn maximize(&self) -> Result<()> {
        self.operation(DesktopOperation::Maximize)
    }

    pub fn unmaximize(&self) -> Result<()> {
        self.operation(DesktopOperation::Unmaximize)
    }

    pub fn set_fullscreen(&self, fullscreen: bool) -> Result<()> {
        self.operation(DesktopOperation::SetFullscreen { fullscreen })
    }

    pub fn set_always_on_top(&self, always_on_top: bool) -> Result<()> {
        self.operation(DesktopOperation::SetAlwaysOnTop { always_on_top })
    }

    pub fn set_ignore_cursor_events(&self, ignore: bool) -> Result<()> {
        self.operation(DesktopOperation::SetIgnoreCursorEvents { ignore })
    }

    pub fn set_position(&self, position: impl Into<Position>) -> Result<()> {
        let (x, y, physical) = match position.into() {
            Position::Logical(position) => (position.x, position.y, false),
            Position::Physical(position) => (position.x as f64, position.y as f64, true),
        };
        self.operation(DesktopOperation::SetPosition { x, y, physical })
    }

    pub fn set_size(&self, size: impl Into<Size>) -> Result<()> {
        let (width, height, physical) = match size.into() {
            Size::Logical(size) => (size.width, size.height, false),
            Size::Physical(size) => (size.width as f64, size.height as f64, true),
        };
        self.operation(DesktopOperation::SetSize {
            width,
            height,
            physical,
        })
    }

    pub fn set_min_size(&self, size: Option<Size>) -> Result<()> {
        let (width, height, physical) = match size {
            Some(Size::Logical(size)) => (Some(size.width), Some(size.height), false),
            Some(Size::Physical(size)) => (Some(size.width as f64), Some(size.height as f64), true),
            None => (None, None, false),
        };
        self.operation(DesktopOperation::SetMinSize {
            width,
            height,
            physical,
        })
    }

    pub fn set_title(&self, title: &str) -> Result<()> {
        self.operation(DesktopOperation::SetTitle {
            title: title.to_string(),
        })
    }

    pub fn set_resizable(&self, resizable: bool) -> Result<()> {
        self.operation(DesktopOperation::SetResizable { resizable })
    }

    pub fn set_opacity(&self, opacity: f64) -> Result<()> {
        self.operation(DesktopOperation::SetOpacity { opacity })
    }

    pub fn outer_position(&self) -> Result<PhysicalPosition<i32>> {
        let state = self.state_snapshot()?;
        Ok(PhysicalPosition::new(state.x as i32, state.y as i32))
    }

    pub fn outer_size(&self) -> Result<PhysicalSize<u32>> {
        let state = self.state_snapshot()?;
        Ok(PhysicalSize::new(state.width as u32, state.height as u32))
    }

    pub fn inner_size(&self) -> Result<PhysicalSize<u32>> {
        self.outer_size()
    }

    pub fn scale_factor(&self) -> Result<f64> {
        Ok(self.state_snapshot()?.scale_factor)
    }

    pub fn current_monitor(&self) -> Result<Option<Monitor>> {
        let state = self.state_snapshot()?;
        Ok(state.monitor.map(|monitor| Monitor {
            name: monitor.name,
            position: PhysicalPosition::new(monitor.x, monitor.y),
            size: PhysicalSize::new(monitor.width, monitor.height),
            work_area: MonitorWorkArea {
                position: PhysicalPosition::new(monitor.work_x, monitor.work_y),
                size: PhysicalSize::new(monitor.work_width, monitor.work_height),
            },
            scale_factor: monitor.scale_factor.max(1.0),
        }))
    }

    pub fn cursor_position(&self) -> Result<PhysicalPosition<f64>> {
        Ok(*self
            .app
            .inner
            .cursor_position
            .read()
            .expect("desktop cursor position lock poisoned"))
    }

    pub fn emit<S: Serialize>(&self, event: &str, payload: S) -> Result<()> {
        let payload = serde_json::to_value(payload)
            .map_err(|error| format!("failed to serialize event '{event}': {error}"))?;
        self.app.send(BackendMessage::Event {
            event: event.to_string(),
            payload,
            target: Some(self.label.clone()),
        })
    }

    pub fn on_window_event(
        &self,
        handler: impl Fn(WindowEvent) + Send + Sync + 'static,
    ) -> EventId {
        self.app.listen_window(self.label.clone(), handler)
    }

    pub fn operation(&self, operation: DesktopOperation) -> Result<()> {
        self.app.send(BackendMessage::DesktopOperation {
            label: self.label.clone(),
            operation,
        })
    }

    fn state_snapshot(&self) -> Result<WindowState> {
        self.app
            .inner
            .windows
            .read()
            .expect("desktop window lock poisoned")
            .get(&self.label)
            .cloned()
            .ok_or_else(|| format!("window '{}' does not exist", self.label))
    }
}

#[derive(Clone)]
pub struct Channel<T> {
    id: u64,
    next_index: Arc<AtomicU64>,
    sender: Option<mpsc::UnboundedSender<ChannelMessage>>,
    local_sender: Option<Arc<dyn Fn(T) -> Result<()> + Send + Sync>>,
    message: PhantomData<T>,
}

impl<T> Channel<T> {
    pub fn new(sender: impl Fn(T) -> Result<()> + Send + Sync + 'static) -> Self {
        Self {
            id: 0,
            next_index: Arc::new(AtomicU64::new(0)),
            sender: None,
            local_sender: Some(Arc::new(sender)),
            message: PhantomData,
        }
    }

    pub fn from_value(sender: mpsc::UnboundedSender<ChannelMessage>, value: Value) -> Result<Self> {
        let marker = value
            .as_str()
            .and_then(|value| value.strip_prefix("__CHANNEL__:"))
            .ok_or_else(|| "invalid desktop channel marker".to_string())?;
        let id = marker
            .parse()
            .map_err(|error| format!("invalid desktop channel id: {error}"))?;
        Ok(Self {
            id,
            next_index: Arc::new(AtomicU64::new(0)),
            sender: Some(sender),
            local_sender: None,
            message: PhantomData,
        })
    }
}

impl<T: Serialize> Channel<T> {
    pub fn send(&self, value: T) -> Result<()> {
        if let Some(sender) = &self.local_sender {
            return sender(value);
        }
        let message = serde_json::to_value(value)
            .map_err(|error| format!("failed to serialize channel message: {error}"))?;
        self.sender
            .as_ref()
            .ok_or_else(|| "desktop channel sender is unavailable".to_string())?
            .send(ChannelMessage {
                channel_id: self.id,
                index: self.next_index.fetch_add(1, Ordering::Relaxed),
                message: Some(message),
                end: false,
            })
            .map_err(|_| "Electron desktop channel is closed".to_string())
    }
}

impl<T> Drop for Channel<T> {
    fn drop(&mut self) {
        let Some(sender) = &self.sender else {
            return;
        };
        let _ = sender.send(ChannelMessage {
            channel_id: self.id,
            index: self.next_index.load(Ordering::Relaxed),
            message: None,
            end: true,
        });
    }
}

pub trait Event: Sized + 'static {
    const NAME: &'static str;

    fn emit(&self, app: &AppHandle) -> Result<()>
    where
        Self: Serialize,
    {
        app.emit(Self::NAME, self)
    }

    fn listen_any(
        app: &AppHandle,
        handler: impl Fn(EventPayload<Self>) + Send + Sync + 'static,
    ) -> EventId
    where
        Self: DeserializeOwned,
    {
        app.listen_value(Self::NAME, move |payload| {
            match serde_json::from_value(payload) {
                Ok(payload) => handler(EventPayload { payload }),
                Err(error) => {
                    tracing::warn!(event = Self::NAME, %error, "Invalid desktop event payload")
                }
            }
        })
    }
}

pub struct EventPayload<T> {
    pub payload: T,
}

pub struct RuntimeEvent {
    payload: String,
}

impl RuntimeEvent {
    pub fn payload(&self) -> &str {
        &self.payload
    }
}

pub struct Store {
    path: PathBuf,
    values: RwLock<Map<String, Value>>,
}

impl Store {
    fn load(path: PathBuf) -> Result<Self> {
        let values = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("failed to read desktop store: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Map::new(),
            Err(error) => return Err(format!("failed to read desktop store: {error}")),
        };
        Ok(Self {
            path,
            values: RwLock::new(values),
        })
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.values
            .read()
            .expect("desktop store lock poisoned")
            .get(key)
            .cloned()
    }

    pub fn set<T: Serialize>(&self, key: impl Into<String>, value: T) {
        match serde_json::to_value(value) {
            Ok(value) => {
                self.values
                    .write()
                    .expect("desktop store lock poisoned")
                    .insert(key.into(), value);
            }
            Err(error) => tracing::error!(%error, "Failed to serialize desktop store value"),
        }
    }

    pub fn delete(&self, key: &str) -> bool {
        self.values
            .write()
            .expect("desktop store lock poisoned")
            .remove(key)
            .is_some()
    }

    pub fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create desktop store directory: {error}"))?;
        }
        let bytes =
            serde_json::to_vec_pretty(&*self.values.read().expect("desktop store lock poisoned"))
                .map_err(|error| format!("failed to serialize desktop store: {error}"))?;
        std::fs::write(&self.path, bytes)
            .map_err(|error| format!("failed to write desktop store: {error}"))
    }
}

#[derive(Clone)]
pub struct AppPaths {
    app_data_dir: PathBuf,
    resource_dir: PathBuf,
}

impl AppPaths {
    pub fn discover(identifier: &str, resource_dir: PathBuf) -> Result<Self> {
        let app_data_dir = std::env::var_os("CAP_ELECTRON_APP_DATA_DIR")
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(|| {
                dirs::data_local_dir()
                    .ok_or_else(|| "failed to resolve local application data directory".to_string())
                    .map(|directory| directory.join(identifier))
            })?;
        Ok(Self {
            app_data_dir,
            resource_dir,
        })
    }

    pub fn app_data_dir(&self) -> Result<PathBuf> {
        Ok(self.app_data_dir.clone())
    }

    pub fn app_local_data_dir(&self) -> Result<PathBuf> {
        Ok(self.app_data_dir.clone())
    }

    pub fn resource_dir(&self) -> Result<PathBuf> {
        Ok(self.resource_dir.clone())
    }

    pub fn resolve(
        &self,
        path: impl AsRef<std::path::Path>,
        base: path::BaseDirectory,
    ) -> Result<PathBuf> {
        let base = match base {
            path::BaseDirectory::Resource => Some(self.resource_dir.clone()),
            path::BaseDirectory::AppData
            | path::BaseDirectory::AppLocalData
            | path::BaseDirectory::AppConfig
            | path::BaseDirectory::AppCache
            | path::BaseDirectory::AppLog => Some(self.app_data_dir.clone()),
            path::BaseDirectory::Home => dirs::home_dir(),
            path::BaseDirectory::Desktop => dirs::desktop_dir(),
            path::BaseDirectory::Document => dirs::document_dir(),
            path::BaseDirectory::Download => dirs::download_dir(),
            path::BaseDirectory::Picture => dirs::picture_dir(),
            path::BaseDirectory::Video => dirs::video_dir(),
            path::BaseDirectory::Audio => dirs::audio_dir(),
            path::BaseDirectory::Cache => dirs::cache_dir(),
            path::BaseDirectory::Config => dirs::config_dir(),
            path::BaseDirectory::Data | path::BaseDirectory::LocalData => dirs::data_local_dir(),
            path::BaseDirectory::Public
            | path::BaseDirectory::Temp
            | path::BaseDirectory::Template => Some(std::env::temp_dir()),
        }
        .ok_or_else(|| "failed to resolve desktop base directory".to_string())?;
        Ok(base.join(path))
    }
}

pub mod async_runtime {
    use super::*;

    static HANDLE: OnceLock<tokio::runtime::Handle> = OnceLock::new();

    pub fn set(handle: tokio::runtime::Handle) {
        let _ = HANDLE.set(handle);
    }

    pub fn spawn<F>(future: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        HANDLE
            .get()
            .cloned()
            .unwrap_or_else(tokio::runtime::Handle::current)
            .spawn(future)
    }

    pub fn spawn_blocking<F, R>(task: F) -> tokio::task::JoinHandle<R>
    where
        F: FnOnce() -> R + Send + 'static,
        R: Send + 'static,
    {
        HANDLE
            .get()
            .cloned()
            .unwrap_or_else(tokio::runtime::Handle::current)
            .spawn_blocking(task)
    }

    pub fn block_on<F: Future>(future: F) -> F::Output {
        HANDLE
            .get()
            .cloned()
            .unwrap_or_else(tokio::runtime::Handle::current)
            .block_on(future)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Clone, Debug, Deserialize, Event, PartialEq, Serialize)]
    struct RecordingStarted {
        id: String,
    }

    #[test]
    fn event_names_match_the_existing_frontend_contract() {
        assert_eq!(RecordingStarted::NAME, "recording-started");
    }

    #[test]
    fn command_argument_names_are_deserialized_from_json() {
        let mut arguments =
            argument_object(serde_json::json!({ "projectPath": "/tmp/a.cap" })).unwrap();
        let project_path: PathBuf = deserialize_argument(
            take_argument(&mut arguments, "projectPath").unwrap(),
            "projectPath",
        )
        .unwrap();
        assert_eq!(project_path, PathBuf::from("/tmp/a.cap"));
    }
}
