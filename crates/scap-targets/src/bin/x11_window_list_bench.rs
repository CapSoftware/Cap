//! Refuses to run unless `CAP_X11_BENCH_ISOLATED=1`. It replaces
//! `_NET_CLIENT_LIST` and `_NET_CLIENT_LIST_STACKING` on the current `DISPLAY`
//! and warps the pointer. Start an isolated server first
//! (`Xvfb :99 -screen 0 1920x1080x24`), then run with
//! `CAP_X11_BENCH_ISOLATED=1 DISPLAY=:99`.

use std::process::ExitCode;

fn main() -> ExitCode {
    #[cfg(target_os = "linux")]
    {
        match linux::run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::from(1)
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("x11-window-list-bench runs on linux");
        ExitCode::from(1)
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::time::Instant;

    use x11rb::COPY_DEPTH_FROM_PARENT;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{
        AtomEnum, ConnectionExt, CreateWindowAux, PropMode, WindowClass,
    };

    use scap_targets::{Window, WindowImpl};

    pub fn run() -> Result<(), String> {
        ensure_isolated_display()?;
        let windows = arg_usize("windows", 40)?;
        let runs = arg_usize("runs", 11)?;
        if runs == 0 {
            return Err("runs must be at least 1".to_string());
        }
        let created = create_windows(windows)?;
        let old_rows = picker_rows_per_call();
        let new_rows = picker_rows_snapshot()?;
        if old_rows != new_rows {
            return Err(format!(
                "picker mismatch: per-call {} rows, snapshot {} rows",
                old_rows.len(),
                new_rows.len()
            ));
        }
        let old_hover = Window::get_topmost_at_cursor().map(|window| window.id().to_string());
        let new_hover = WindowImpl::topmost_x11_snapshot_at_cursor()
            .ok_or_else(|| "snapshot cursor probe unavailable".to_string())?
            .map(|snapshot| snapshot.window.id().to_string());
        if old_hover != new_hover {
            return Err(format!(
                "hover mismatch: per-call {old_hover:?}, snapshot {new_hover:?}"
            ));
        }

        let _ = std::hint::black_box(&old_rows);
        let picker_old = measure(runs, || Ok(picker_checksum_per_call()))?;
        let picker_new = measure(runs, picker_checksum_snapshot)?;
        let hover_old = measure(runs, || Ok(hover_checksum_per_call()))?;
        let hover_new = measure(runs, hover_checksum_snapshot)?;
        drop(created);

        println!("windows={windows}");
        println!("runs={runs}");
        println!("picker_rows={}", old_rows.len());
        println!(
            "hover_id={}",
            old_hover.unwrap_or_else(|| "none".to_string())
        );
        print_stats("picker_per_call_ms", &picker_old);
        print_stats("picker_snapshot_ms", &picker_new);
        print_stats("hover_per_call_ms", &hover_old);
        print_stats("hover_snapshot_ms", &hover_new);
        Ok(())
    }

    fn ensure_isolated_display() -> Result<(), String> {
        if std::env::var("CAP_X11_BENCH_ISOLATED").ok().as_deref() == Some("1") {
            return Ok(());
        }
        Err(
            "refusing to run: set CAP_X11_BENCH_ISOLATED=1. This bench replaces \
_NET_CLIENT_LIST and _NET_CLIENT_LIST_STACKING and warps the pointer on the \
current DISPLAY. Use an isolated server, for example: Xvfb :99 -screen 0 1920x1080x24"
                .to_string(),
        )
    }

    fn arg_usize(name: &str, default: usize) -> Result<usize, String> {
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            if arg == format!("--{name}") {
                let value = args
                    .next()
                    .ok_or_else(|| format!("missing value for --{name}"))?;
                return value
                    .parse::<usize>()
                    .map_err(|error| format!("invalid --{name}: {error}"));
            }
        }
        Ok(default)
    }

    struct CreatedWindows {
        conn: x11rb::rust_connection::RustConnection,
        windows: Vec<u32>,
    }

    impl Drop for CreatedWindows {
        fn drop(&mut self) {
            for window in &self.windows {
                if let Ok(cookie) = self.conn.destroy_window(*window) {
                    let _ = cookie.check();
                }
            }
            let _ = self.conn.flush();
        }
    }

    fn create_windows(count: usize) -> Result<CreatedWindows, String> {
        let (conn, screen_num) = x11rb::connect(None).map_err(|error| error.to_string())?;
        let screen = conn
            .setup()
            .roots
            .get(screen_num)
            .ok_or_else(|| "missing X screen".to_string())?;
        let root = screen.root;
        let white = screen.white_pixel;
        let mut windows = Vec::with_capacity(count);
        for index in 0..count {
            let window = conn.generate_id().map_err(|error| error.to_string())?;
            let column = index % 10;
            let row = index / 10;
            let x = i16::try_from(column * 120).map_err(|error| error.to_string())?;
            let y = i16::try_from(row * 90).map_err(|error| error.to_string())?;
            conn.create_window(
                COPY_DEPTH_FROM_PARENT,
                window,
                root,
                x,
                y,
                100,
                70,
                0,
                WindowClass::INPUT_OUTPUT,
                0,
                &CreateWindowAux::new().background_pixel(white),
            )
            .map_err(|error| error.to_string())?
            .check()
            .map_err(|error| error.to_string())?;
            let name = format!("bench-window-{index}");
            let class = format!("bench-{index}\0Bench\0");
            let pid = std::process::id().to_ne_bytes();
            let net_wm_name = intern(&conn, "_NET_WM_NAME")?;
            let net_wm_pid = intern(&conn, "_NET_WM_PID")?;
            replace_property(
                &conn,
                window,
                net_wm_name,
                AtomEnum::STRING,
                8,
                name.as_bytes(),
            )?;
            replace_property(
                &conn,
                window,
                AtomEnum::WM_NAME,
                AtomEnum::STRING,
                8,
                name.as_bytes(),
            )?;
            replace_property(
                &conn,
                window,
                AtomEnum::WM_CLASS,
                AtomEnum::STRING,
                8,
                class.as_bytes(),
            )?;
            replace_property(&conn, window, net_wm_pid, AtomEnum::CARDINAL, 32, &pid)?;
            conn.map_window(window)
                .map_err(|error| error.to_string())?
                .check()
                .map_err(|error| error.to_string())?;
            windows.push(window);
        }
        let stacking = intern(&conn, "_NET_CLIENT_LIST_STACKING")?;
        let client_list = intern(&conn, "_NET_CLIENT_LIST")?;
        let mut bytes = Vec::with_capacity(windows.len() * 4);
        for window in &windows {
            bytes.extend_from_slice(&window.to_ne_bytes());
        }
        replace_property(&conn, root, stacking, AtomEnum::WINDOW, 32, &bytes)?;
        replace_property(&conn, root, client_list, AtomEnum::WINDOW, 32, &bytes)?;
        if windows.is_empty() {
            return Err("no windows".to_string());
        }
        let column = (count - 1) % 10;
        let row = (count - 1) / 10;
        let cursor_x = i16::try_from(column * 120 + 50).map_err(|error| error.to_string())?;
        let cursor_y = i16::try_from(row * 90 + 35).map_err(|error| error.to_string())?;
        conn.warp_pointer(x11rb::NONE, root, 0, 0, 0, 0, cursor_x, cursor_y)
            .map_err(|error| error.to_string())?
            .check()
            .map_err(|error| error.to_string())?;
        conn.flush().map_err(|error| error.to_string())?;
        Ok(CreatedWindows { conn, windows })
    }

    fn intern(conn: &impl Connection, name: &str) -> Result<u32, String> {
        Ok(conn
            .intern_atom(false, name.as_bytes())
            .map_err(|error| error.to_string())?
            .reply()
            .map_err(|error| error.to_string())?
            .atom)
    }

    fn replace_property(
        conn: &impl Connection,
        window: u32,
        property: impl Into<u32>,
        type_: impl Into<u32>,
        format: u8,
        data: &[u8],
    ) -> Result<(), String> {
        let data_len = match format {
            8 => u32::try_from(data.len()).map_err(|error| error.to_string())?,
            32 => u32::try_from(data.len() / 4).map_err(|error| error.to_string())?,
            _ => return Err(format!("unsupported property format {format}")),
        };
        conn.change_property(
            PropMode::REPLACE,
            window,
            property.into(),
            type_.into(),
            format,
            data_len,
            data,
        )
        .map_err(|error| error.to_string())?
        .check()
        .map_err(|error| error.to_string())
    }

    #[derive(PartialEq)]
    struct PickerRow {
        id: String,
        label: String,
        app: String,
        size: Option<(u32, u32)>,
        position: Option<(u64, u64)>,
        refresh: Option<u64>,
    }

    fn bits(value: f64) -> u64 {
        value.to_bits()
    }

    fn picker_rows_per_call() -> Vec<PickerRow> {
        Window::list()
            .into_iter()
            .filter_map(|window| {
                let label = window.name().filter(|name| !name.trim().is_empty())?;
                let app = window.owner_name()?;
                if app == "Window Server" {
                    return None;
                }
                Some(PickerRow {
                    id: window.id().to_string(),
                    label,
                    app,
                    size: window.logical_size().map(|size| {
                        (
                            u32::try_from(size.width() as i64).unwrap_or(0),
                            u32::try_from(size.height() as i64).unwrap_or(0),
                        )
                    }),
                    position: window
                        .display_relative_logical_bounds()
                        .map(|bounds| (bits(bounds.position().x()), bits(bounds.position().y()))),
                    refresh: window.display().map(|display| bits(display.refresh_rate())),
                })
            })
            .collect()
    }

    fn picker_rows_snapshot() -> Result<Vec<PickerRow>, String> {
        let snapshots = WindowImpl::list_x11_snapshots()
            .ok_or_else(|| "snapshot listing unavailable".to_string())?;
        Ok(snapshots
            .into_iter()
            .filter_map(|snapshot| {
                let size = snapshot.logical_size();
                let position = snapshot
                    .display_relative_origin()
                    .map(|(x, y)| (bits(x), bits(y)));
                let refresh = bits(snapshot.refresh_rate());
                let id = snapshot.window.id().to_string();
                if snapshot.name.trim().is_empty() {
                    return None;
                }
                let app = snapshot.owner_name?;
                if app == "Window Server" {
                    return None;
                }
                Some(PickerRow {
                    id,
                    label: snapshot.name,
                    app,
                    size: Some((
                        u32::try_from(size.width() as i64).unwrap_or(0),
                        u32::try_from(size.height() as i64).unwrap_or(0),
                    )),
                    position,
                    refresh: Some(refresh),
                })
            })
            .collect())
    }

    fn picker_checksum_per_call() -> u64 {
        picker_rows_per_call().iter().fold(0u64, fold_row)
    }

    fn picker_checksum_snapshot() -> Result<u64, String> {
        Ok(picker_rows_snapshot()?.iter().fold(0u64, fold_row))
    }

    fn fold_row(checksum: u64, row: &PickerRow) -> u64 {
        checksum
            .wrapping_add(hash_str(&row.id))
            .wrapping_add(hash_str(&row.label))
            .wrapping_add(hash_str(&row.app))
    }

    fn hash_str(value: &str) -> u64 {
        value.bytes().fold(0u64, |acc, byte| {
            acc.wrapping_mul(31).wrapping_add(u64::from(byte))
        })
    }

    fn hover_checksum_per_call() -> u64 {
        Window::get_topmost_at_cursor().map_or(0, |window| hash_str(&window.id().to_string()))
    }

    fn hover_checksum_snapshot() -> Result<u64, String> {
        let found = WindowImpl::topmost_x11_snapshot_at_cursor()
            .ok_or_else(|| "snapshot cursor probe unavailable".to_string())?;
        Ok(found.map_or(0, |snapshot| hash_str(&snapshot.window.id().to_string())))
    }

    fn measure(
        runs: usize,
        mut sample: impl FnMut() -> Result<u64, String>,
    ) -> Result<Vec<f64>, String> {
        let _ = std::hint::black_box(sample()?);
        let mut samples = Vec::with_capacity(runs);
        for _ in 0..runs {
            let start = Instant::now();
            let value = std::hint::black_box(sample()?);
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            let _ = std::hint::black_box(value);
            samples.push(elapsed);
        }
        Ok(samples)
    }

    fn print_stats(label: &str, samples: &[f64]) {
        let mut ordered = samples.to_vec();
        ordered.sort_by(f64::total_cmp);
        let min = ordered.first().copied().unwrap_or(0.0);
        let max = ordered.last().copied().unwrap_or(0.0);
        let median = ordered.get(ordered.len() / 2).copied().unwrap_or(0.0);
        println!("{label} median={median:.3} min={min:.3} max={max:.3}");
    }
}
