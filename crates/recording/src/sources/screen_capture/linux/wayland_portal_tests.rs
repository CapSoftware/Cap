use super::{LinuxCaptureSource, WaylandPortalCapture, open_wayland_portal};
use crate::output_pipeline::PipelineBuildScope;
use ashpd::zbus::{
    self, Connection,
    message::Header,
    zvariant::{OwnedObjectPath, OwnedValue, Value},
};
use std::{
    collections::HashMap,
    io::Read as _,
    os::{fd::OwnedFd, unix::net::UnixStream},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

const CHILD_CASE: &str = "CAP_TEST_PRIVATE_SCREENCAST_PORTAL";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Behavior {
    Capture,
    PendingStart,
    RemoteUnavailable,
    CloseRejected,
    MissingObject,
    MissingMethod,
}

struct PortalSession {
    closes: Arc<AtomicUsize>,
    live: Arc<AtomicUsize>,
    behavior: Behavior,
    closed: Arc<tokio::sync::Notify>,
}
#[zbus::interface(name = "org.freedesktop.portal.Session", crate = "ashpd::zbus")]
impl PortalSession {
    fn close(&self) -> zbus::fdo::Result<()> {
        self.closes.fetch_add(1, Ordering::SeqCst);
        if self.behavior == Behavior::MissingObject {
            return Err(zbus::fdo::Error::UnknownObject(
                "fixture session already removed".into(),
            ));
        }
        if self.behavior == Behavior::MissingMethod {
            return Err(zbus::fdo::Error::UnknownMethod(
                "fixture session already removed".into(),
            ));
        }
        if self.behavior == Behavior::CloseRejected {
            return Err(zbus::fdo::Error::Failed("fixture close failed".into()));
        }
        self.live.fetch_sub(1, Ordering::SeqCst);
        self.closed.notify_one();
        Ok(())
    }
    #[zbus(property)]
    fn version(&self) -> u32 {
        1
    }
}
struct Portal {
    closes: Arc<AtomicUsize>,
    live: Arc<AtomicUsize>,
    peers: Arc<Mutex<Vec<UnixStream>>>,
    behavior: Behavior,
    started: Arc<tokio::sync::Notify>,
    closed: Arc<tokio::sync::Notify>,
}

fn request_path(header: &Header<'_>, token: &str, kind: &str) -> OwnedObjectPath {
    let sender = header
        .sender()
        .unwrap()
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    format!("/org/freedesktop/portal/desktop/{kind}/{sender}/{token}")
        .try_into()
        .unwrap()
}
async fn respond(
    connection: &Connection,
    header: &Header<'_>,
    token: &str,
    body: HashMap<&str, Value<'_>>,
) -> zbus::fdo::Result<OwnedObjectPath> {
    let path = request_path(header, token, "request");
    connection
        .emit_signal(
            header.sender().map(|sender| sender.as_str()),
            path.as_str(),
            "org.freedesktop.portal.Request",
            "Response",
            &(0_u32, body),
        )
        .await?;
    Ok(path)
}

#[zbus::interface(name = "org.freedesktop.portal.ScreenCast", crate = "ashpd::zbus")]
impl Portal {
    async fn create_session(
        &self,
        options: HashMap<String, OwnedValue>,
        #[zbus(connection)] connection: &Connection,
        #[zbus(header)] header: Header<'_>,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        let token = options["handle_token"].downcast_ref::<&str>().unwrap();
        let session_token = options["session_handle_token"]
            .downcast_ref::<&str>()
            .unwrap();
        let session_path = request_path(&header, session_token, "session");
        connection
            .object_server()
            .at(
                session_path.clone(),
                PortalSession {
                    closes: self.closes.clone(),
                    live: self.live.clone(),
                    behavior: self.behavior,
                    closed: self.closed.clone(),
                },
            )
            .await?;
        self.live.fetch_add(1, Ordering::SeqCst);
        respond(
            connection,
            &header,
            token,
            HashMap::from([("session_handle", Value::from(session_path.as_str()))]),
        )
        .await
    }
    async fn select_sources(
        &self,
        _session: OwnedObjectPath,
        options: HashMap<String, OwnedValue>,
        #[zbus(connection)] connection: &Connection,
        #[zbus(header)] header: Header<'_>,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        respond(
            connection,
            &header,
            options["handle_token"].downcast_ref::<&str>().unwrap(),
            HashMap::new(),
        )
        .await
    }
    async fn start(
        &self,
        _session: OwnedObjectPath,
        _parent: String,
        options: HashMap<String, OwnedValue>,
        #[zbus(connection)] connection: &Connection,
        #[zbus(header)] header: Header<'_>,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        if self.behavior == Behavior::PendingStart {
            self.started.notify_one();
            self.closed.notified().await;
        }
        let streams = vec![(
            42_u32,
            HashMap::from([
                ("size", Value::from((1920_i32, 1080_i32))),
                ("position", Value::from((0_i32, 0_i32))),
            ]),
        )];
        respond(
            connection,
            &header,
            options["handle_token"].downcast_ref::<&str>().unwrap(),
            HashMap::from([("streams", Value::from(streams))]),
        )
        .await
    }
    fn open_pipe_wire_remote(
        &self,
        _session: OwnedObjectPath,
        _options: HashMap<String, OwnedValue>,
    ) -> zbus::fdo::Result<zbus::zvariant::OwnedFd> {
        if self.behavior == Behavior::RemoteUnavailable {
            return Err(zbus::fdo::Error::Failed(
                "fixture remote unavailable".into(),
            ));
        }
        let (fd, peer) = UnixStream::pair().unwrap();
        self.peers.lock().unwrap().push(peer);
        Ok(OwnedFd::from(fd).into())
    }
    #[zbus(property)]
    fn version(&self) -> u32 {
        5
    }
    #[zbus(property)]
    fn available_source_types(&self) -> u32 {
        3
    }
    #[zbus(property)]
    fn available_cursor_modes(&self) -> u32 {
        3
    }
}

async fn probe(case: &str) -> anyhow::Result<()> {
    let behavior = match case {
        "cancel-start" => Behavior::PendingStart,
        "fd-error" => Behavior::RemoteUnavailable,
        "close-error" => Behavior::CloseRejected,
        "already-closed-object" => Behavior::MissingObject,
        "already-closed-method" => Behavior::MissingMethod,
        _ => Behavior::Capture,
    };
    let closes = Arc::new(AtomicUsize::new(0));
    let live = Arc::new(AtomicUsize::new(0));
    let peers = Arc::new(Mutex::new(Vec::new()));
    let started = Arc::new(tokio::sync::Notify::new());
    let closed = Arc::new(tokio::sync::Notify::new());
    let connection = zbus::connection::Builder::session()?
        .name("org.freedesktop.portal.Desktop")?
        .serve_at(
            "/org/freedesktop/portal/desktop",
            Portal {
                closes: closes.clone(),
                live: live.clone(),
                peers: peers.clone(),
                behavior,
                started: started.clone(),
                closed,
            },
        )?
        .build()
        .await?;
    if case == "cancel-start" {
        let scope = PipelineBuildScope::new_lifetime();
        scope.run(async {
            tokio::select! {
                result = open_wayland_portal(&LinuxCaptureSource::Display, false) => panic!("unexpected finished start: {:?}", result.err()),
                _ = started.notified() => {}
            }
        }).await;
        scope.cancel_and_join().await.map_err(anyhow::Error::msg)?;
        assert_eq!(
            live.load(Ordering::SeqCst),
            0,
            "cancelled startup must close its acquired session"
        );
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        return Ok(());
    }
    if case == "fd-error" {
        let scope = PipelineBuildScope::new_lifetime();
        let result = scope
            .run(open_wayland_portal(&LinuxCaptureSource::Display, false))
            .await;
        assert!(result.is_err());
        scope.cancel_and_join().await.map_err(anyhow::Error::msg)?;
        assert_eq!(
            live.load(Ordering::SeqCst),
            0,
            "failed startup must close its acquired session"
        );
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        return Ok(());
    }
    for _ in 1..=if case == "repeat-stop" { 2 } else { 1 } {
        let parent = PipelineBuildScope::new_lifetime();
        let scope = if case == "committed-stop" {
            parent.child_transaction()
        } else {
            parent.clone()
        };
        let capture = tokio::time::timeout(
            Duration::from_secs(3),
            scope.run(open_wayland_portal(&LinuxCaptureSource::Display, false)),
        )
        .await??;
        if case == "committed-stop" {
            assert!(
                scope.idle_report().is_none(),
                "session cleanup must be owned before commit"
            );
            assert!(scope.commit());
            assert!(
                parent.idle_report().is_none(),
                "the lifetime parent must retain ownership after commit"
            );
        }
        assert_eq!(capture.stream.pipe_wire_node_id(), 42);
        let WaylandPortalCapture {
            stream,
            fd,
            portal_session,
        } = capture;
        drop(stream);
        drop(fd);
        std::thread::spawn(move || drop(portal_session))
            .join()
            .unwrap();
        if behavior == Behavior::MissingObject || behavior == Behavior::MissingMethod {
            live.fetch_sub(1, Ordering::SeqCst);
        }
        let report = parent.cancel_and_join_report().await;
        let mut byte = [0_u8];
        let mut peer = peers.lock().unwrap().pop().unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(1)))?;
        assert_eq!(
            peer.read(&mut byte)?,
            0,
            "the capture PipeWire remote must have closed"
        );
        if case == "close-error" {
            assert!(
                !report.quiescent,
                "a portal close failure must not be reported as joined cleanup"
            );
            assert!(report.error.is_some_and(|error| {
                error.contains("close Wayland screen capture portal session")
            }));
            assert_eq!(live.load(Ordering::SeqCst), 1);
            return Ok(());
        }
        assert!(report.quiescent);
        assert!(report.error.is_none());
        if behavior == Behavior::MissingObject || behavior == Behavior::MissingMethod {
            assert_eq!(closes.load(Ordering::SeqCst), 1);
            return Ok(());
        }
    }
    assert_eq!(
        live.load(Ordering::SeqCst),
        0,
        "dropping captures must close the portal session"
    );
    assert_eq!(
        closes.load(Ordering::SeqCst),
        if case == "repeat-stop" { 2 } else { 1 }
    );
    drop(connection);
    Ok(())
}

#[test]
fn portal_sessions_end_with_capture() {
    if let Ok(case) = std::env::var(CHILD_CASE) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(8), probe(&case))
                .await
                .unwrap()
                .unwrap();
        });
        return;
    }
    let module = module_path!().split_once("::").unwrap().1;
    let test = format!("{module}::portal_sessions_end_with_capture");
    for case in [
        "repeat-stop",
        "committed-stop",
        "cancel-start",
        "fd-error",
        "close-error",
        "already-closed-object",
        "already-closed-method",
    ] {
        let output = Command::new("dbus-run-session")
            .arg("--")
            .arg(std::env::current_exe().unwrap())
            .args(["--exact", &test, "--nocapture", "--test-threads=1"])
            .env(CHILD_CASE, case)
            .output()
            .expect("the Wayland portal regression requires dbus-run-session");
        assert!(
            output.status.success(),
            "{case}: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
