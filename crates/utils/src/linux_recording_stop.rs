use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::task::JoinHandle;
use zbus::{Connection, Proxy, message::Header, proxy::CacheProperties, zvariant::ObjectPath};

const WATCHER: &str = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH: &str = "/StatusNotifierWatcher";
const ITEM_PATH: &str = "/StatusNotifierItem";
const OPERATION_TIMEOUT: Duration = Duration::from_secs(2);
const HEALTH_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopTrayEvent {
    Activated { generation: u64 },
    Unavailable { generation: u64 },
}

#[derive(Debug)]
pub struct StopTrayOpenError {
    message: String,
    can_fallback: bool,
}

impl StopTrayOpenError {
    pub fn can_fallback(&self) -> bool {
        self.can_fallback
    }
}

impl std::fmt::Display for StopTrayOpenError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(formatter)
    }
}

impl std::error::Error for StopTrayOpenError {}

#[derive(Clone, Debug)]
pub struct StopTrayIcon {
    width: i32,
    height: i32,
    argb: Vec<u8>,
}

impl StopTrayIcon {
    pub fn from_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Self, String> {
        if width == 0 || width != height || width > 256 {
            return Err("The recording Stop icon must be square and at most 256 pixels".into());
        }
        let expected = width as usize * height as usize * 4;
        if rgba.len() != expected {
            return Err("The recording Stop icon has invalid pixel data".into());
        }
        let mut argb = Vec::with_capacity(expected);
        for pixel in rgba.chunks_exact(4) {
            argb.extend_from_slice(&[pixel[3], pixel[0], pixel[1], pixel[2]]);
        }
        Ok(Self {
            width: width as i32,
            height: height as i32,
            argb,
        })
    }
}

struct ActivationState {
    available: bool,
    activated_host: Option<String>,
}

struct StopItem {
    generation: u64,
    icon: StopTrayIcon,
    events: flume::Sender<StopTrayEvent>,
    state: Arc<Mutex<ActivationState>>,
}

impl StopItem {
    fn activate_for(&self, sender: Option<&str>) -> zbus::fdo::Result<()> {
        let sender = sender.ok_or_else(|| {
            zbus::fdo::Error::AccessDenied("The Stop activation has no bus sender".into())
        })?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| zbus::fdo::Error::Failed("Recording Stop state is unavailable".into()))?;
        if !state.available {
            return Err(zbus::fdo::Error::Failed(
                "The recording Stop control is no longer available".into(),
            ));
        }
        if state
            .activated_host
            .as_deref()
            .is_some_and(|host| host != sender)
        {
            return Err(zbus::fdo::Error::AccessDenied(
                "The recording Stop activation came from a different tray host".into(),
            ));
        }
        state.activated_host = Some(sender.to_owned());
        match self.events.try_send(StopTrayEvent::Activated {
            generation: self.generation,
        }) {
            Ok(()) | Err(flume::TrySendError::Full(_)) => Ok(()),
            Err(flume::TrySendError::Disconnected(_)) => Err(zbus::fdo::Error::Failed(
                "The recording Stop listener has closed".into(),
            )),
        }
    }
}

#[zbus::interface(name = "org.kde.StatusNotifierItem")]
impl StopItem {
    fn activate(
        &self,
        _x: i32,
        _y: i32,
        #[zbus(header)] header: Header<'_>,
    ) -> zbus::fdo::Result<()> {
        self.activate_for(header.sender().map(|sender| sender.as_str()))
    }

    fn secondary_activate(
        &self,
        _x: i32,
        _y: i32,
        #[zbus(header)] header: Header<'_>,
    ) -> zbus::fdo::Result<()> {
        self.activate_for(header.sender().map(|sender| sender.as_str()))
    }

    fn context_menu(
        &self,
        _x: i32,
        _y: i32,
        #[zbus(header)] header: Header<'_>,
    ) -> zbus::fdo::Result<()> {
        self.activate_for(header.sender().map(|sender| sender.as_str()))
    }

    fn scroll(&self, _delta: i32, _orientation: &str) {}

    #[zbus(property)]
    fn category(&self) -> &str {
        "ApplicationStatus"
    }

    #[zbus(property)]
    fn id(&self) -> &str {
        "cap-recording-stop"
    }

    #[zbus(property)]
    fn title(&self) -> &str {
        "Stop Cap recording"
    }

    #[zbus(property)]
    fn status(&self) -> &str {
        "Active"
    }

    #[zbus(property)]
    fn window_id(&self) -> u32 {
        0
    }

    #[zbus(property)]
    fn icon_name(&self) -> &str {
        ""
    }

    #[zbus(property)]
    fn icon_theme_path(&self) -> &str {
        ""
    }

    #[zbus(property)]
    fn icon_pixmap(&self) -> Vec<(i32, i32, Vec<u8>)> {
        vec![(self.icon.width, self.icon.height, self.icon.argb.clone())]
    }

    #[zbus(property)]
    fn overlay_icon_name(&self) -> &str {
        ""
    }

    #[zbus(property)]
    fn overlay_icon_pixmap(&self) -> Vec<(i32, i32, Vec<u8>)> {
        Vec::new()
    }

    #[zbus(property)]
    fn attention_icon_name(&self) -> &str {
        ""
    }

    #[zbus(property)]
    fn attention_icon_pixmap(&self) -> Vec<(i32, i32, Vec<u8>)> {
        Vec::new()
    }

    #[zbus(property)]
    fn attention_movie_name(&self) -> &str {
        ""
    }

    #[zbus(property)]
    fn item_is_menu(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn menu(&self) -> ObjectPath<'_> {
        ObjectPath::from_static_str_unchecked("/")
    }
}

pub struct StopTray {
    connection: Option<Connection>,
    monitor: Option<JoinHandle<()>>,
    events: flume::Receiver<StopTrayEvent>,
}

impl StopTray {
    pub async fn open(generation: u64, icon: StopTrayIcon) -> Result<Self, StopTrayOpenError> {
        let (sender, receiver) = flume::bounded(8);
        let state = Arc::new(Mutex::new(ActivationState {
            available: true,
            activated_host: None,
        }));
        let item = StopItem {
            generation,
            icon,
            events: sender.clone(),
            state: state.clone(),
        };
        let builder = zbus::connection::Builder::session()
            .and_then(|builder| builder.serve_at(ITEM_PATH, item))
            .map_err(|error| StopTrayOpenError {
                message: format!("Could not prepare the recording Stop tray: {error}"),
                can_fallback: true,
            })?;
        let connection = tokio::time::timeout(OPERATION_TIMEOUT, builder.build())
            .await
            .map_err(|_| StopTrayOpenError {
                message: "Connecting the recording Stop tray timed out; cleanup is unconfirmed"
                    .into(),
                can_fallback: false,
            })?
            .map_err(|error| StopTrayOpenError {
                message: format!("Could not connect the recording Stop tray: {error}"),
                can_fallback: false,
            })?;
        let setup = tokio::time::timeout(OPERATION_TIMEOUT, async {
            let watcher = watcher_proxy(&connection).await?;
            let bus = bus_proxy(&connection).await?;
            let owner: String = bus.call("GetNameOwner", &WATCHER).await?;
            if !watcher
                .get_property::<bool>("IsStatusNotifierHostRegistered")
                .await?
            {
                return Err(zbus::Error::Failure(
                    "No system tray host is available for the recording Stop control".into(),
                ));
            }
            watcher
                .call::<_, _, ()>("RegisterStatusNotifierItem", &ITEM_PATH)
                .await?;
            Ok::<_, zbus::Error>((watcher, bus, owner))
        })
        .await;
        let (watcher, bus, owner) = match setup {
            Ok(Ok(setup)) => setup,
            failure => {
                let mut message = match failure {
                    Ok(Err(error)) => {
                        format!("Could not register the recording Stop control: {error}")
                    }
                    Err(_) => "Registering the recording Stop control timed out".into(),
                    Ok(Ok(_)) => unreachable!(),
                };
                let can_fallback = match tokio::time::timeout(OPERATION_TIMEOUT, connection.close())
                    .await
                {
                    Ok(Ok(())) => true,
                    Ok(Err(error)) => {
                        message.push_str(&format!("; closing the Stop control failed: {error}"));
                        false
                    }
                    Err(_) => {
                        message.push_str("; closing the Stop control timed out");
                        false
                    }
                };
                return Err(StopTrayOpenError {
                    message,
                    can_fallback,
                });
            }
        };
        let monitor_connection = connection.clone();
        let monitor_receiver = receiver.clone();
        let monitor = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = monitor_connection.closed() => break,
                    _ = tokio::time::sleep(HEALTH_INTERVAL) => {}
                }
                let host = match state.lock() {
                    Ok(state) => state.activated_host.clone(),
                    Err(_) => break,
                };
                let healthy = tokio::time::timeout(OPERATION_TIMEOUT, async {
                    let current_owner: String = bus.call("GetNameOwner", &WATCHER).await?;
                    if current_owner != owner
                        || !watcher
                            .get_property::<bool>("IsStatusNotifierHostRegistered")
                            .await?
                    {
                        return Ok(false);
                    }
                    match host {
                        Some(host) => bus.call::<_, _, bool>("NameHasOwner", &host).await,
                        None => Ok(true),
                    }
                })
                .await;
                if !matches!(healthy, Ok(Ok(true))) {
                    break;
                }
            }
            report_unavailable(&state, &sender, &monitor_receiver, generation);
        });
        Ok(Self {
            connection: Some(connection),
            monitor: Some(monitor),
            events: receiver,
        })
    }

    pub fn events(&self) -> flume::Receiver<StopTrayEvent> {
        self.events.clone()
    }

    pub async fn close(mut self) -> Result<(), String> {
        let monitor_result = if let Some(monitor) = self.monitor.take() {
            monitor.abort();
            match monitor.await {
                Ok(()) => Ok(()),
                Err(error) if error.is_cancelled() => Ok(()),
                Err(error) => Err(format!("The recording Stop monitor failed: {error}")),
            }
        } else {
            Ok(())
        };
        if let Some(connection) = self.connection.take() {
            tokio::time::timeout(OPERATION_TIMEOUT, connection.close())
                .await
                .map_err(|_| "Closing the recording Stop control timed out".to_string())?
                .map_err(|error| format!("Could not close the recording Stop control: {error}"))?;
        }
        monitor_result
    }
}

impl Drop for StopTray {
    fn drop(&mut self) {
        if let Some(monitor) = self.monitor.take() {
            monitor.abort();
        }
    }
}

async fn watcher_proxy(connection: &Connection) -> zbus::Result<Proxy<'static>> {
    zbus::proxy::Builder::new(connection)
        .destination(WATCHER)?
        .path(WATCHER_PATH)?
        .interface(WATCHER)?
        .cache_properties(CacheProperties::No)
        .build()
        .await
}

async fn bus_proxy(connection: &Connection) -> zbus::Result<Proxy<'static>> {
    Proxy::new_owned(
        connection.clone(),
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
    )
    .await
}

fn report_unavailable(
    state: &Mutex<ActivationState>,
    sender: &flume::Sender<StopTrayEvent>,
    receiver: &flume::Receiver<StopTrayEvent>,
    generation: u64,
) {
    let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
    state.available = false;
    while receiver.try_recv().is_ok() {}
    let _ = sender.try_send(StopTrayEvent::Unavailable { generation });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item() -> (StopItem, flume::Receiver<StopTrayEvent>) {
        let (events, receiver) = flume::bounded(8);
        (
            StopItem {
                generation: 42,
                icon: StopTrayIcon::from_rgba(1, 1, &[10, 20, 30, 255]).unwrap(),
                events,
                state: Arc::new(Mutex::new(ActivationState {
                    available: true,
                    activated_host: None,
                })),
            },
            receiver,
        )
    }

    #[test]
    fn stop_icon_uses_exact_network_argb_and_rejects_invalid_dimensions() {
        let icon = StopTrayIcon::from_rgba(1, 1, &[10, 20, 30, 40]).unwrap();
        assert_eq!(icon.argb, [40, 10, 20, 30]);
        for (width, height, data) in [
            (0, 0, &[][..]),
            (1, 2, &[0; 8]),
            (257, 257, &[]),
            (1, 1, &[0; 3]),
        ] {
            assert!(StopTrayIcon::from_rgba(width, height, data).is_err());
        }
    }

    #[test]
    fn stop_activation_is_bound_to_its_generation_and_first_host() {
        let (item, receiver) = item();
        assert!(item.activate_for(None).is_err());
        item.activate_for(Some(":1.42")).unwrap();
        assert_eq!(
            receiver.recv().unwrap(),
            StopTrayEvent::Activated { generation: 42 }
        );
        assert!(item.activate_for(Some(":1.43")).is_err());
        assert!(receiver.is_empty());
        item.activate_for(Some(":1.42")).unwrap();
        assert_eq!(
            receiver.recv().unwrap(),
            StopTrayEvent::Activated { generation: 42 }
        );
    }

    #[test]
    fn loss_invalidates_queued_activation_and_prevents_further_events() {
        let (item, receiver) = item();
        for _ in 0..16 {
            item.activate_for(Some(":1.42")).unwrap();
        }
        assert_eq!(receiver.len(), 8);
        report_unavailable(&item.state, &item.events, &receiver, item.generation);
        assert_eq!(
            receiver.recv().unwrap(),
            StopTrayEvent::Unavailable { generation: 42 }
        );
        assert!(item.activate_for(Some(":1.42")).is_err());
        assert!(receiver.is_empty());
    }

    #[test]
    fn stop_control_has_no_popup_menu_or_scroll_action() {
        let (item, receiver) = item();
        assert!(!item.item_is_menu());
        assert_eq!(item.menu().as_str(), "/");
        item.scroll(1, "vertical");
        assert!(receiver.is_empty());
        assert_eq!(item.icon_pixmap(), vec![(1, 1, vec![255, 10, 20, 30])]);
    }
}
