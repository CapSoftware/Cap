use std::{
    collections::BTreeMap,
    env,
    os::unix::net::UnixStream,
    path::PathBuf,
    time::{Duration, Instant},
};

use rustix::event::{PollFd, PollFlags, Timespec, poll};
use wayland_client::{
    Connection, Dispatch, EventQueue, QueueHandle, WEnum,
    protocol::{wl_callback, wl_output, wl_registry},
};
use wayland_protocols::xdg::xdg_output::zv1::client::{zxdg_output_manager_v1, zxdg_output_v1};

use super::{DisplayImpl, LogicalBounds, LogicalPosition, LogicalSize};

#[derive(Clone, Copy, Default)]
struct OutputGeometry {
    position: (i32, i32),
    mode: Option<(i32, i32, i32)>,
    scale: i32,
    rotated: bool,
    uuid: Option<uuid::Uuid>,
}

#[derive(Clone, Copy, Default)]
struct LogicalGeometry {
    position: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
    uuid: Option<uuid::Uuid>,
}

#[derive(Default)]
struct OutputState {
    pending: OutputGeometry,
    committed: Option<OutputGeometry>,
    logical_pending: LogicalGeometry,
    logical_committed: Option<LogicalGeometry>,
    xdg_version: Option<u32>,
}

impl OutputState {
    fn commit_output(&mut self) {
        self.committed = Some(self.pending);
        if self.xdg_version.is_some_and(|version| version >= 3) {
            self.logical_committed = Some(self.logical_pending);
        }
    }

    fn display(&self, id: u32) -> Option<DisplayImpl> {
        let geometry = self.committed?;
        let (mut width, mut height, refresh) = geometry.mode?;
        if width <= 0 || height <= 0 {
            return None;
        }
        if geometry.rotated {
            std::mem::swap(&mut width, &mut height);
        }
        let (position, size) = if self.xdg_version.is_some() {
            let logical = self.logical_committed?;
            (logical.position?, logical.size?)
        } else {
            let scale = geometry.scale.max(1);
            (geometry.position, (width / scale, height / scale))
        };
        if size.0 <= 0 || size.1 <= 0 {
            return None;
        }
        Some(DisplayImpl {
            id,
            x: position.0,
            y: position.1,
            width: width as u32,
            height: height as u32,
            refresh_rate: if refresh > 0 {
                f64::from(refresh) / 1000.0
            } else {
                60.0
            },
            wayland_uuid: geometry
                .uuid
                .or_else(|| self.logical_committed.and_then(|logical| logical.uuid)),
            logical_bounds: Some(LogicalBounds::new(
                LogicalPosition::new(position.0.into(), position.1.into()),
                LogicalSize::new(size.0.into(), size.1.into()),
            )),
        })
    }
}

#[derive(Default)]
struct State {
    globals: BTreeMap<u32, (String, u32)>,
    outputs: BTreeMap<u32, OutputState>,
    synced: bool,
}

pub(super) fn displays() -> Option<Vec<DisplayImpl>> {
    let display = PathBuf::from(env::var_os("WAYLAND_DISPLAY")?);
    let socket = if display.is_absolute() {
        display
    } else {
        let runtime = PathBuf::from(env::var_os("XDG_RUNTIME_DIR")?);
        if !runtime.is_absolute() {
            return None;
        }
        runtime.join(display)
    };
    let connection = Connection::from_socket(UnixStream::connect(socket).ok()?).ok()?;
    query(&connection, Duration::from_millis(250))
}

fn output_uuid(name: &str) -> Option<uuid::Uuid> {
    (!name.is_empty()).then(|| uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_DNS, name.as_bytes()))
}

fn query(connection: &Connection, timeout: Duration) -> Option<Vec<DisplayImpl>> {
    let deadline = Instant::now() + timeout;
    let mut queue = connection.new_event_queue::<State>();
    let handle = queue.handle();
    let registry = connection.display().get_registry(&handle, ());
    let mut state = State::default();
    roundtrip(connection, &mut queue, &mut state, deadline)?;

    let manager = state
        .globals
        .iter()
        .find(|(_, (interface, _))| interface == "zxdg_output_manager_v1")
        .map(|(&name, (_, version))| {
            let version = (*version).min(3);
            (
                registry.bind::<zxdg_output_manager_v1::ZxdgOutputManagerV1, _, _>(
                    name,
                    version,
                    &handle,
                    (),
                ),
                version,
            )
        });
    let mut legacy_outputs = Vec::new();
    for (&name, (interface, version)) in &state.globals {
        if interface != "wl_output" {
            continue;
        }
        let version = (*version).min(4);
        let output = registry.bind::<wl_output::WlOutput, _, _>(name, version, &handle, name);
        let mut output_state = OutputState::default();
        if let Some((manager, manager_version)) = &manager {
            // XDG v3 batches geometry through wl_output.done, unavailable on wl_output v1.
            if version >= 2 || *manager_version < 3 {
                let _xdg_output = manager.get_xdg_output(&output, &handle, name);
                output_state.xdg_version = Some(*manager_version);
            }
        }
        if version < 2 {
            legacy_outputs.push(name);
        }
        state.outputs.insert(name, output_state);
    }
    roundtrip(connection, &mut queue, &mut state, deadline)?;
    for name in legacy_outputs {
        if let Some(output) = state.outputs.get_mut(&name) {
            output.commit_output();
        }
    }
    Some(
        state
            .outputs
            .values()
            .enumerate()
            .filter_map(|(index, output)| output.display(index as u32))
            .collect(),
    )
}

fn roundtrip(
    connection: &Connection,
    queue: &mut EventQueue<State>,
    state: &mut State,
    deadline: Instant,
) -> Option<()> {
    state.synced = false;
    let _callback = connection.display().sync(&queue.handle(), ());
    loop {
        queue.dispatch_pending(state).ok()?;
        if state.synced {
            return Some(());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        connection.flush().ok()?;
        let Some(guard) = queue.prepare_read() else {
            continue;
        };
        let mut fds = [PollFd::new(connection, PollFlags::IN)];
        let timeout = Timespec::try_from(remaining).ok()?;
        match poll(&mut fds, Some(&timeout)) {
            Ok(0) => return None,
            Ok(_) if fds[0].revents().contains(PollFlags::IN) => {
                guard.read().ok()?;
            }
            Err(rustix::io::Errno::INTR) => continue,
            _ => return None,
        }
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for State {
    fn event(
        state: &mut Self,
        _: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } => {
                state.globals.insert(name, (interface, version));
            }
            wl_registry::Event::GlobalRemove { name } => {
                state.globals.remove(&name);
                state.outputs.remove(&name);
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_callback::WlCallback, ()> for State {
    fn event(
        state: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        state.synced = true;
    }
}

impl Dispatch<wl_output::WlOutput, u32> for State {
    fn event(
        state: &mut Self,
        _: &wl_output::WlOutput,
        event: wl_output::Event,
        name: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(output) = state.outputs.get_mut(name) else {
            return;
        };
        match event {
            wl_output::Event::Geometry {
                x, y, transform, ..
            } => {
                output.pending.position = (x, y);
                output.pending.rotated = matches!(
                    transform,
                    WEnum::Value(
                        wl_output::Transform::_90
                            | wl_output::Transform::_270
                            | wl_output::Transform::Flipped90
                            | wl_output::Transform::Flipped270
                    )
                );
            }
            wl_output::Event::Mode {
                flags: WEnum::Value(flags),
                width,
                height,
                refresh,
            } if flags.contains(wl_output::Mode::Current) => {
                output.pending.mode = Some((width, height, refresh));
            }
            wl_output::Event::Name { name } => output.pending.uuid = output_uuid(&name),
            wl_output::Event::Scale { factor } => output.pending.scale = factor,
            wl_output::Event::Done => output.commit_output(),
            _ => {}
        }
    }
}

impl Dispatch<zxdg_output_manager_v1::ZxdgOutputManagerV1, ()> for State {
    fn event(
        _: &mut Self,
        _: &zxdg_output_manager_v1::ZxdgOutputManagerV1,
        _: zxdg_output_manager_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<zxdg_output_v1::ZxdgOutputV1, u32> for State {
    fn event(
        state: &mut Self,
        _: &zxdg_output_v1::ZxdgOutputV1,
        event: zxdg_output_v1::Event,
        name: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(output) = state.outputs.get_mut(name) else {
            return;
        };
        match event {
            zxdg_output_v1::Event::LogicalPosition { x, y } => {
                output.logical_pending.position = Some((x, y));
            }
            zxdg_output_v1::Event::LogicalSize { width, height } => {
                output.logical_pending.size = Some((width, height));
            }
            zxdg_output_v1::Event::Name { name } => {
                output.logical_pending.uuid = output_uuid(&name);
            }
            zxdg_output_v1::Event::Done => {
                output.logical_committed = Some(output.logical_pending);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scaled_output() -> OutputState {
        let mut output = OutputState {
            pending: OutputGeometry {
                mode: Some((1920, 1080, 59940)),
                scale: 2,
                ..Default::default()
            },
            xdg_version: Some(3),
            logical_pending: LogicalGeometry {
                position: Some((-960, 120)),
                size: Some((960, 540)),
                ..Default::default()
            },
            ..Default::default()
        };
        output.commit_output();
        output
    }

    #[test]
    fn output_uuid_matches_gpui_name_identity_and_ignores_persisted_index() {
        let mut output = scaled_output();
        output.pending.uuid = output_uuid("HEADLESS-2");
        output.commit_output();
        let first = output.display(0).unwrap();
        let second = output.display(8).unwrap();
        let expected = uuid::Uuid::parse_str("db1cfde6-a307-5263-bfaa-7643e0b07250").unwrap();
        assert_eq!(first.wayland_uuid(), Some(expected));
        assert_eq!(second.wayland_uuid(), Some(expected));
        assert_ne!(first.raw_id(), second.raw_id());
        assert_ne!(output_uuid("HEADLESS-1"), output_uuid("HEADLESS-2"));
    }

    #[test]
    fn output_uuid_uses_committed_core_name_then_xdg_fallback() {
        let mut output = scaled_output();
        output.logical_pending.uuid = output_uuid("HEADLESS-2");
        assert_eq!(output.display(0).unwrap().wayland_uuid(), None);
        output.commit_output();
        assert_eq!(
            output.display(0).unwrap().wayland_uuid(),
            output_uuid("HEADLESS-2")
        );
        output.pending.uuid = output_uuid("HEADLESS-1");
        assert_eq!(
            output.display(0).unwrap().wayland_uuid(),
            output_uuid("HEADLESS-2")
        );
        output.commit_output();
        assert_eq!(
            output.display(0).unwrap().wayland_uuid(),
            output_uuid("HEADLESS-1")
        );
    }

    #[test]
    fn unnamed_output_has_no_uuid() {
        assert_eq!(output_uuid(""), None);
        assert_eq!(scaled_output().display(0).unwrap().wayland_uuid(), None);
    }

    #[test]
    fn scaled_output_preserves_logical_and_physical_geometry() {
        let display = scaled_output().display(0).unwrap();
        assert_eq!(display.physical_size().unwrap().width(), 1920.0);
        assert_eq!(display.logical_size().unwrap().width(), 960.0);
        assert_eq!(display.logical_bounds().unwrap().position().x(), -960.0);
        assert_eq!(display.logical_bounds().unwrap().position().y(), 120.0);
        assert_eq!(display.refresh_rate(), 59.94);
    }

    #[test]
    fn fractional_and_rotated_outputs_use_completed_xdg_geometry() {
        let mut output = scaled_output();
        output.pending.rotated = true;
        output.logical_pending.size = Some((720, 1280));
        assert_eq!(
            output.display(0).unwrap().logical_size().unwrap().width(),
            960.0
        );
        output.commit_output();
        let display = output.display(0).unwrap();
        assert_eq!(display.physical_size().unwrap().width(), 1080.0);
        assert_eq!(display.physical_size().unwrap().height(), 1920.0);
        assert_eq!(display.logical_size().unwrap().width(), 720.0);
        assert_eq!(display.logical_size().unwrap().height(), 1280.0);
    }

    #[test]
    fn incomplete_and_invalid_geometry_is_not_reported() {
        assert!(OutputState::default().display(0).is_none());
        let mut output = scaled_output();
        output.logical_pending.size = Some((0, 540));
        output.commit_output();
        assert!(output.display(0).is_none());
    }

    #[test]
    fn core_output_scale_is_used_without_xdg_output() {
        let mut output = scaled_output();
        output.xdg_version = None;
        assert_eq!(
            output.display(0).unwrap().logical_size().unwrap().width(),
            960.0
        );
    }

    #[test]
    fn stalled_compositor_query_times_out() {
        let (client, _server) = UnixStream::pair().unwrap();
        let connection = Connection::from_socket(client).unwrap();
        let started = Instant::now();
        assert!(query(&connection, Duration::from_millis(20)).is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn wayland_session_does_not_use_xwayland_dimensions() {
        assert!(super::super::prefers_wayland_environment(
            true,
            true,
            Some("wayland")
        ));
        assert!(super::super::prefers_wayland_environment(true, false, None));
        assert!(!super::super::prefers_wayland_environment(
            true,
            true,
            Some("x11")
        ));
        assert!(!super::super::prefers_wayland_environment(
            false, true, None
        ));
    }
}
