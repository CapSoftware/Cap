use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

pub const EV_KEY: u16 = 1;
pub const BTN_LEFT: u16 = 0x110;
const BTN_TASK: u16 = 0x117;
const KEY_BITS: u32 = 96;
// spa_meta_cursor.flags bit 0. This spa header does not name it.
const CURSOR_HIDDEN: u32 = 1;

const fn ioc(dir: u32, ty: u32, nr: u32, size: u32) -> u64 {
    ((dir << 30) | (size << 16) | (ty << 8) | nr) as u64
}

const fn eviocgbit(ev: u32, len: u32) -> u64 {
    ioc(2, b'E' as u32, 0x20 + ev, len)
}

const fn eviocgkey(len: u32) -> u64 {
    ioc(2, b'E' as u32, 0x18, len)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointerButtonChange {
    pub cursor_num: u8,
    pub down: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PointerButtons {
    down: [bool; 8],
}

impl PointerButtons {
    pub fn observe(&mut self, type_: u16, code: u16, value: i32) -> Option<PointerButtonChange> {
        if type_ != EV_KEY || !(0..=1).contains(&value) {
            return None;
        }
        let index = code.checked_sub(BTN_LEFT)?;
        if index > BTN_TASK - BTN_LEFT {
            return None;
        }
        let index = usize::from(index);
        let down = value == 1;
        if self.down[index] == down {
            return None;
        }
        self.down[index] = down;
        Some(PointerButtonChange {
            cursor_num: (index as u8) + 1,
            down,
        })
    }

    pub fn changes_from_event_bytes(&mut self, bytes: &[u8]) -> Vec<PointerButtonChange> {
        let stride = std::mem::size_of::<libc::input_event>();
        let mut changes = Vec::new();
        for chunk in bytes.chunks_exact(stride) {
            let event =
                unsafe { std::ptr::read_unaligned(chunk.as_ptr().cast::<libc::input_event>()) };
            if let Some(change) = self.observe(event.type_, event.code, event.value) {
                changes.push(change);
            }
        }
        changes
    }

    fn absorb_bits(&mut self, bits: &[u8]) {
        for (index, down) in self.down.iter_mut().enumerate() {
            let code = BTN_LEFT + u16::try_from(index).unwrap_or(u16::MAX);
            if bit_is_set(bits, code) {
                *down = true;
            }
        }
    }
}

fn bit_is_set(bits: &[u8], code: u16) -> bool {
    let index = usize::from(code);
    bits.get(index / 8)
        .is_some_and(|byte| byte & (1 << (index % 8)) != 0)
}

fn has_left_button(bits: &[u8]) -> bool {
    bit_is_set(bits, BTN_LEFT)
}

fn is_event_node(name: &str) -> bool {
    let Some(index) = name.strip_prefix("event") else {
        return false;
    };
    !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CaptureRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CursorMetaUpdate {
    Unchanged,
    Hidden,
    At(Option<(f64, f64)>),
}

pub fn cursor_meta_update(
    id: u32,
    flags: u32,
    x: i32,
    y: i32,
    frame: CaptureRect,
) -> CursorMetaUpdate {
    if id == 0 {
        return CursorMetaUpdate::Unchanged;
    }
    if flags & CURSOR_HIDDEN != 0 {
        return CursorMetaUpdate::Hidden;
    }
    CursorMetaUpdate::At(normalize_pointer(x, y, frame))
}

pub fn normalize_pointer(x: i32, y: i32, frame: CaptureRect) -> Option<(f64, f64)> {
    if frame.width == 0 || frame.height == 0 {
        return None;
    }
    let dx = x.checked_sub(frame.x)?;
    let dy = y.checked_sub(frame.y)?;
    if dx < 0 || dy < 0 {
        return None;
    }
    let dx = dx as u32;
    let dy = dy as u32;
    if dx >= frame.width || dy >= frame.height {
        return None;
    }
    Some((
        f64::from(dx) / f64::from(frame.width),
        f64::from(dy) / f64::from(frame.height),
    ))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorPixelFormat {
    Rgba,
    Bgra,
    Argb,
    Abgr,
}

pub fn cursor_rgba(
    format: CursorPixelFormat,
    width: u32,
    height: u32,
    stride: i32,
    data: &[u8],
) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || stride < 0 {
        return None;
    }
    let row = usize::try_from(stride).ok()?;
    let minimum = usize::try_from(width).ok()?.checked_mul(4)?;
    if row < minimum {
        return None;
    }
    let rows = usize::try_from(height).ok()?;
    let needed = row.checked_mul(rows)?;
    if data.len() < needed {
        return None;
    }
    let mut rgba = Vec::with_capacity(minimum.checked_mul(rows)?);
    for y in 0..rows {
        let start = y * row;
        for pixel in data[start..start + minimum].chunks_exact(4) {
            let (r, g, b, a) = match format {
                CursorPixelFormat::Rgba => (pixel[0], pixel[1], pixel[2], pixel[3]),
                CursorPixelFormat::Bgra => (pixel[2], pixel[1], pixel[0], pixel[3]),
                CursorPixelFormat::Argb => (pixel[1], pixel[2], pixel[3], pixel[0]),
                CursorPixelFormat::Abgr => (pixel[3], pixel[2], pixel[1], pixel[0]),
            };
            rgba.extend_from_slice(&[r, g, b, a]);
        }
    }
    Some(rgba)
}

#[derive(Clone, Debug, PartialEq)]
pub struct WaylandCursorSprite {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    pub hotspot_x: f64,
    pub hotspot_y: f64,
    pub rgba: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PointerPlace {
    Pending,
    Hidden,
    Outside,
    At(f64, f64),
}

#[derive(Clone, Default)]
struct FeedState {
    place: PointerPlace,
    sprite: Option<Arc<WaylandCursorSprite>>,
}

impl Default for PointerPlace {
    fn default() -> Self {
        Self::Pending
    }
}

#[derive(Clone, Default)]
pub struct WaylandPointerFeed {
    state: Arc<Mutex<FeedState>>,
}

impl WaylandPointerFeed {
    pub fn publish_position(&self, update: CursorMetaUpdate) {
        let mut state = self.state.lock();
        state.place = match update {
            CursorMetaUpdate::Unchanged => return,
            CursorMetaUpdate::Hidden => PointerPlace::Hidden,
            CursorMetaUpdate::At(None) => PointerPlace::Outside,
            CursorMetaUpdate::At(Some((x, y))) => PointerPlace::At(x, y),
        };
    }

    pub fn publish_sprite(&self, sprite: Arc<WaylandCursorSprite>) {
        self.state.lock().sprite = Some(sprite);
    }

    pub fn place(&self) -> PointerPlace {
        self.state.lock().place
    }

    pub fn sprite(&self) -> Option<Arc<WaylandCursorSprite>> {
        self.state.lock().sprite.clone()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointerTick {
    pub moved_to: Option<(f64, f64)>,
    pub clicks: usize,
}

#[derive(Debug)]
pub struct PointerTrack {
    last: Option<(f64, f64)>,
    kept: Vec<PointerButtonChange>,
}

impl PointerTrack {
    pub fn new() -> Self {
        Self {
            last: None,
            kept: Vec::new(),
        }
    }

    pub fn tick(&mut self, place: PointerPlace, changes: &[PointerButtonChange]) -> PointerTick {
        self.kept.clear();
        let moved_to = match place {
            PointerPlace::At(x, y) => {
                self.kept.extend_from_slice(changes);
                (self.last != Some((x, y))).then_some((x, y))
            }
            PointerPlace::Pending => {
                self.kept.extend_from_slice(changes);
                None
            }
            PointerPlace::Hidden | PointerPlace::Outside => None,
        };
        if let PointerPlace::At(x, y) = place {
            self.last = Some((x, y));
        }
        PointerTick {
            moved_to,
            clicks: self.kept.len(),
        }
    }

    pub fn clicks(&self) -> &[PointerButtonChange] {
        &self.kept
    }
}

impl Default for PointerTrack {
    fn default() -> Self {
        Self::new()
    }
}

pub struct ClickSource {
    fds: Vec<OwnedFd>,
}

impl ClickSource {
    // Logind puts an ACL on the active session's seat input nodes, so the
    // desktop user can read them without the input group. Key codes stay out
    // of the recording: only BTN_LEFT through BTN_TASK become clicks.
    pub fn open() -> (Self, PointerButtons) {
        let mut buttons = PointerButtons::default();
        let mut nodes = Vec::new();
        if let Ok(entries) = std::fs::read_dir("/dev/input") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else {
                    continue;
                };
                if is_event_node(name) {
                    nodes.push(entry.path());
                }
            }
        }
        nodes.sort();
        let mut fds = Vec::new();
        for path in nodes {
            let Some(fd) = open_readonly(&path) else {
                continue;
            };
            let Some(bits) = read_key_bits(fd.as_raw_fd(), eviocgbit(u32::from(EV_KEY), KEY_BITS))
            else {
                continue;
            };
            if !has_left_button(&bits) {
                continue;
            }
            if let Some(held) = read_key_bits(fd.as_raw_fd(), eviocgkey(KEY_BITS)) {
                buttons.absorb_bits(&held);
            }
            fds.push(fd);
        }
        if fds.is_empty() {
            tracing::info!("Wayland click source has no pointer the session can read");
        } else {
            tracing::info!(pointers = fds.len(), "Wayland click source opened");
        }
        (Self { fds }, buttons)
    }

    pub fn is_empty(&self) -> bool {
        self.fds.is_empty()
    }

    pub(crate) fn push_reader(&mut self, fd: OwnedFd) {
        self.fds.push(fd);
    }

    pub fn poll(
        &mut self,
        buttons: &mut PointerButtons,
        timeout: Duration,
    ) -> Vec<PointerButtonChange> {
        if self.fds.is_empty() {
            return Vec::new();
        }
        let mut polls: Vec<libc::pollfd> = self
            .fds
            .iter()
            .map(|fd| libc::pollfd {
                fd: fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            })
            .collect();
        let millis = i32::try_from(timeout.as_millis()).unwrap_or(i32::MAX);
        let ready = unsafe { libc::poll(polls.as_mut_ptr(), polls.len() as libc::nfds_t, millis) };
        if ready <= 0 {
            return Vec::new();
        }
        let mut changes = Vec::new();
        let mut dead = Vec::new();
        for (index, poll) in polls.iter().enumerate() {
            if poll.revents & (libc::POLLIN | libc::POLLERR | libc::POLLHUP) == 0 {
                continue;
            }
            if poll.revents & libc::POLLIN == 0 {
                dead.push(index);
                continue;
            }
            match read_events(poll.fd) {
                Ok(bytes) => changes.extend(buttons.changes_from_event_bytes(&bytes)),
                Err(ReadEvents::Retry) => {}
                Err(ReadEvents::Closed) => dead.push(index),
            }
        }
        for index in dead.into_iter().rev() {
            self.fds.swap_remove(index);
        }
        changes
    }
}

enum ReadEvents {
    Retry,
    Closed,
}

fn open_readonly(path: &std::path::Path) -> Option<OwnedFd> {
    let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).ok()?;
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return None;
    }
    Some(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn read_key_bits(fd: std::os::fd::RawFd, request: u64) -> Option<[u8; KEY_BITS as usize]> {
    let mut bits = [0u8; KEY_BITS as usize];
    let result = unsafe { libc::ioctl(fd, request as libc::c_ulong, bits.as_mut_ptr()) };
    (result >= 0).then_some(bits)
}

fn read_events(fd: std::os::fd::RawFd) -> Result<Vec<u8>, ReadEvents> {
    let mut buffer = vec![0u8; std::mem::size_of::<libc::input_event>() * 16];
    let read = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
    if read < 0 {
        let error = std::io::Error::last_os_error();
        return Err(match error.raw_os_error() {
            Some(libc::EAGAIN | libc::EINTR) => ReadEvents::Retry,
            _ => ReadEvents::Closed,
        });
    }
    if read == 0 {
        return Err(ReadEvents::Closed);
    }
    let read = usize::try_from(read).map_err(|_| ReadEvents::Closed)?;
    buffer.truncate(read);
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::CursorClickEvent;
    use cap_project::auto_zoom::generate_auto_zoom_segments;

    fn press(buttons: &mut PointerButtons) -> PointerButtonChange {
        buttons.observe(EV_KEY, BTN_LEFT, 1).unwrap()
    }

    fn click(change: &PointerButtonChange, time_ms: f64) -> CursorClickEvent {
        CursorClickEvent {
            active_modifiers: Vec::new(),
            cursor_num: change.cursor_num,
            cursor_id: "0".to_string(),
            time_ms,
            down: change.down,
        }
    }

    fn event_bytes(type_: u16, code: u16, value: i32) -> Vec<u8> {
        let event = libc::input_event {
            time: libc::timeval {
                tv_sec: 0,
                tv_usec: 0,
            },
            type_,
            code,
            value,
        };
        let bytes = unsafe {
            std::slice::from_raw_parts(
                (&event as *const libc::input_event).cast::<u8>(),
                std::mem::size_of::<libc::input_event>(),
            )
        };
        bytes.to_vec()
    }

    #[test]
    fn cursor_mode_metadata_is_the_portal_bit() {
        use ashpd::desktop::screencast::CursorMode;
        assert_eq!(CursorMode::Hidden as u32, 1);
        assert_eq!(CursorMode::Embedded as u32, 2);
        assert_eq!(CursorMode::Metadata as u32, 4);
    }

    #[test]
    fn evdev_queries_match_linux_input_h() {
        assert_eq!(eviocgbit(u32::from(EV_KEY), KEY_BITS), 2_153_792_801);
        assert_eq!(eviocgkey(KEY_BITS), 2_153_792_792);
    }

    #[test]
    fn left_press_and_release_are_primary_clicks_and_keys_are_not() {
        let mut buttons = PointerButtons::default();
        let press = press(&mut buttons);
        assert_eq!(
            press,
            PointerButtonChange {
                cursor_num: 1,
                down: true
            }
        );
        assert!(buttons.observe(EV_KEY, BTN_LEFT, 2).is_none());
        assert!(buttons.observe(EV_KEY, 30, 1).is_none());
        assert!(buttons.observe(EV_KEY, 0x14a, 1).is_none());
        let release = buttons.observe(EV_KEY, BTN_LEFT, 0).unwrap();
        assert!(!release.down);
        assert!(buttons.observe(EV_KEY, BTN_LEFT, 0).is_none());
    }

    #[test]
    fn event_bytes_drive_the_same_decoder_the_device_reader_uses() {
        let mut buttons = PointerButtons::default();
        let mut bytes = event_bytes(EV_KEY, 30, 1);
        bytes.extend(event_bytes(EV_KEY, BTN_LEFT, 1));
        bytes.push(0);
        let changes = buttons.changes_from_event_bytes(&bytes);
        assert_eq!(changes.len(), 1);
        assert!(changes[0].down);
        let clicks = vec![click(&changes[0], 5_000.0)];
        assert!(!generate_auto_zoom_segments(&clicks, 20.0, 2.0).is_empty());
    }

    #[test]
    fn held_bits_seed_the_left_button_without_emitting_a_press() {
        let mut bits = [0u8; KEY_BITS as usize];
        assert!(!has_left_button(&bits));
        bits[usize::from(BTN_LEFT) / 8] |= 1 << (usize::from(BTN_LEFT) % 8);
        assert!(has_left_button(&bits));
        let mut buttons = PointerButtons::default();
        buttons.absorb_bits(&bits);
        assert!(buttons.observe(EV_KEY, BTN_LEFT, 1).is_none());
        assert!(!buttons.observe(EV_KEY, BTN_LEFT, 0).unwrap().down);
    }

    #[test]
    fn pointer_outside_the_capture_is_not_a_position() {
        let frame = CaptureRect {
            x: 10,
            y: 20,
            width: 100,
            height: 50,
        };
        assert_eq!(normalize_pointer(10, 20, frame), Some((0.0, 0.0)));
        assert_eq!(normalize_pointer(60, 45, frame), Some((0.5, 0.5)));
        assert_eq!(normalize_pointer(9, 20, frame), None);
        assert_eq!(normalize_pointer(110, 20, frame), None);
        assert_eq!(
            cursor_meta_update(0, 0, 60, 45, frame),
            CursorMetaUpdate::Unchanged
        );
        assert_eq!(
            cursor_meta_update(4, CURSOR_HIDDEN, 60, 45, frame),
            CursorMetaUpdate::Hidden
        );
        assert_eq!(
            cursor_meta_update(4, 0, 60, 45, frame),
            CursorMetaUpdate::At(Some((0.5, 0.5)))
        );
        assert_eq!(
            cursor_meta_update(4, 0, 9, 20, frame),
            CursorMetaUpdate::At(None)
        );
    }

    #[test]
    fn scripted_metadata_and_clicks_fill_auto_zoom_and_skip_other_monitors() {
        let frame = CaptureRect {
            x: 0,
            y: 0,
            width: 1000,
            height: 500,
        };
        let feed = WaylandPointerFeed::default();
        let mut buttons = PointerButtons::default();
        let mut track = PointerTrack::new();
        let early = press(&mut buttons);
        let before = track.tick(feed.place(), &[early]);
        assert_eq!(before.moved_to, None);
        assert_eq!(before.clicks, 1);
        feed.publish_position(cursor_meta_update(3, 0, 250, 100, frame));
        let release = buttons.observe(EV_KEY, BTN_LEFT, 0).unwrap();
        let inside = track.tick(feed.place(), &[release]);
        assert_eq!(inside.moved_to, Some((0.25, 0.2)));
        assert_eq!(track.clicks()[0].cursor_num, 1);
        feed.publish_position(cursor_meta_update(3, 0, -5, 10, frame));
        let outside_press = buttons.observe(EV_KEY, BTN_LEFT, 1).unwrap();
        let outside = track.tick(feed.place(), &[outside_press]);
        assert_eq!(outside.clicks, 0);
        let clicks = vec![click(&early, 5_000.0)];
        assert_eq!(generate_auto_zoom_segments(&clicks, 20.0, 2.0).len(), 1);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursor.json");
        let events = cap_project::CursorEvents {
            clicks,
            moves: vec![cap_project::CursorMoveEvent {
                active_modifiers: Vec::new(),
                cursor_id: "0".to_string(),
                time_ms: 5_000.0,
                x: 0.25,
                y: 0.2,
            }],
        };
        std::fs::write(&path, serde_json::to_vec_pretty(&events).unwrap()).unwrap();
        let loaded = cap_project::CursorEvents::load_from_file(&path).unwrap();
        assert_eq!(loaded.clicks[0].cursor_num, 1);
        assert_eq!(
            generate_auto_zoom_segments(&loaded.clicks, 20.0, 2.0).len(),
            1
        );
    }

    #[test]
    fn cursor_pixels_become_straight_rgba() {
        let rgba = cursor_rgba(CursorPixelFormat::Rgba, 1, 1, 4, &[1, 2, 3, 4]).unwrap();
        assert_eq!(rgba, [1, 2, 3, 4]);
        let bgra = cursor_rgba(CursorPixelFormat::Bgra, 1, 1, 4, &[1, 2, 3, 4]).unwrap();
        assert_eq!(bgra, [3, 2, 1, 4]);
        let argb = cursor_rgba(CursorPixelFormat::Argb, 1, 1, 4, &[4, 1, 2, 3]).unwrap();
        assert_eq!(argb, [1, 2, 3, 4]);
        assert!(cursor_rgba(CursorPixelFormat::Rgba, 1, 1, -4, &[1, 2, 3, 4]).is_none());
        assert!(cursor_rgba(CursorPixelFormat::Rgba, 2, 1, 4, &[0, 0, 0, 0]).is_none());
    }

    fn record(feed: &WaylandPointerFeed, bytes: &[u8]) -> crate::cursor::CursorActorResponse {
        let mut ends = [0; 2];
        assert_eq!(
            unsafe { libc::pipe2(ends.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) },
            0
        );
        let read = unsafe { OwnedFd::from_raw_fd(ends[0]) };
        let write = unsafe { OwnedFd::from_raw_fd(ends[1]) };
        let wrote = unsafe { libc::write(write.as_raw_fd(), bytes.as_ptr().cast(), bytes.len()) };
        assert_eq!(wrote, isize::try_from(bytes.len()).unwrap());
        let dir = tempfile::tempdir().unwrap();
        let mut actor = crate::cursor::spawn_wayland_cursor_recorder(
            dir.path().join("cursors"),
            Default::default(),
            0,
            cap_timestamp::Timestamps::now(),
            None,
            crate::cursor::IncrementalCaptureOutputs {
                cursor: None,
                keyboard: None,
            },
            Some(feed.clone()),
            vec![read],
        );
        actor.stop();
        drop(write);
        futures::executor::block_on(actor.rx).expect("cursor recorder response")
    }

    #[test]
    fn piped_clicks_reach_cursor_json_and_auto_zoom() {
        let frame = CaptureRect {
            x: 0,
            y: 0,
            width: 1000,
            height: 500,
        };
        let inside = WaylandPointerFeed::default();
        inside.publish_position(cursor_meta_update(7, 0, 250, 100, frame));
        let mut bytes = event_bytes(EV_KEY, 30, 1);
        bytes.extend(event_bytes(EV_KEY, BTN_LEFT, 1));
        let response = record(&inside, &bytes);
        assert!(response.keyboard_presses.is_empty());
        assert!(
            response
                .clicks
                .iter()
                .any(|click| click.cursor_num == 1 && click.down)
        );
        assert!(
            response
                .moves
                .iter()
                .any(|move_| move_.x == 0.25 && move_.y == 0.2)
        );
        let outside = WaylandPointerFeed::default();
        outside.publish_position(cursor_meta_update(8, 0, -20, 10, frame));
        let dropped = record(&outside, &event_bytes(EV_KEY, BTN_LEFT + 1, 1));
        assert!(dropped.clicks.is_empty());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursor.json");
        let events = cap_project::CursorEvents {
            clicks: response.clicks,
            moves: response.moves,
        };
        std::fs::write(&path, serde_json::to_vec_pretty(&events).unwrap()).unwrap();
        let loaded = cap_project::CursorEvents::load_from_file(&path).unwrap();
        assert!(!generate_auto_zoom_segments(&loaded.clicks, 20.0, 2.0).is_empty());
    }

    #[test]
    fn event_node_names_are_event_plus_digits() {
        assert!(is_event_node("event0"));
        assert!(is_event_node("event12"));
        assert!(!is_event_node("event"));
        assert!(!is_event_node("mouse0"));
        assert!(!is_event_node("event1a"));
    }
}
