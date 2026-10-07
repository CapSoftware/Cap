use device_query::Keycode;
use parking_lot::RwLock;
use std::collections::HashSet;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

const EV_KEY: u16 = 1;
const BTN_LEFT: u16 = 0x110;
const BTN_RIGHT: u16 = 0x111;
const BTN_MIDDLE: u16 = 0x112;
const BTN_SIDE: u16 = 0x113;
const BTN_EXTRA: u16 = 0x114;
const BTN_FORWARD: u16 = 0x115;
const BTN_BACK: u16 = 0x116;
const BTN_TASK: u16 = 0x117;

// EVIOCGBIT(EV_KEY, 96) from linux/input.h
const EVIOCGBIT_KEY_96: libc::c_ulong = 0x80604521;

#[derive(Clone, Copy)]
#[repr(C)]
struct InputEvent {
    time: libc::timeval,
    type_: u16,
    code: u16,
    value: i32,
}

impl InputEvent {
    const fn zero() -> Self {
        Self {
            time: libc::timeval {
                tv_sec: 0,
                tv_usec: 0,
            },
            type_: 0,
            code: 0,
            value: 0,
        }
    }
}

pub struct EvdevInputListener {
    buttons: Arc<RwLock<[bool; 6]>>,
    keys: Arc<RwLock<HashSet<Keycode>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl EvdevInputListener {
    pub fn new() -> Option<Self> {
        let mut fds = Vec::new();
        for i in 0..64 {
            let path = format!("/dev/input/event{i}");
            if !Path::new(&path).exists() {
                continue;
            }
            let c_path = match std::ffi::CString::new(path) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let fd = unsafe {
                libc::open(
                    c_path.as_ptr(),
                    libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                continue;
            }

            let mut key_bits = [0u8; 96];
            let res = unsafe { libc::ioctl(fd, EVIOCGBIT_KEY_96, key_bits.as_mut_ptr()) };
            if res >= 0 {
                let has_btn_left = (key_bits[BTN_LEFT as usize / 8] & (1 << (BTN_LEFT % 8))) != 0;
                let has_key_a = (key_bits[30 / 8] & (1 << (30 % 8))) != 0;
                if has_btn_left || has_key_a {
                    unsafe {
                        fds.push(OwnedFd::from_raw_fd(fd));
                    }
                    continue;
                }
            }
            unsafe {
                libc::close(fd);
            }
        }

        if fds.is_empty() {
            tracing::debug!("evdev: no accessible input devices found in /dev/input/event*");
            return None;
        }

        tracing::info!(
            count = fds.len(),
            "evdev: listening to hardware input devices"
        );

        let buttons = Arc::new(RwLock::new([false; 6]));
        let keys = Arc::new(RwLock::new(HashSet::new()));
        let stop = Arc::new(AtomicBool::new(false));

        let thread_buttons = buttons.clone();
        let thread_keys = keys.clone();
        let thread_stop = stop.clone();

        let thread = std::thread::spawn(move || {
            let raw_fds: Vec<libc::c_int> = fds.iter().map(|f| f.as_raw_fd()).collect();
            let mut poll_fds: Vec<libc::pollfd> = raw_fds
                .iter()
                .map(|&fd| libc::pollfd {
                    fd,
                    events: libc::POLLIN,
                    revents: 0,
                })
                .collect();

            let mut buf = [InputEvent::zero(); 16];

            while !thread_stop.load(Ordering::Relaxed) {
                let ret = unsafe {
                    libc::poll(poll_fds.as_mut_ptr(), poll_fds.len() as libc::nfds_t, 16)
                };
                if ret <= 0 {
                    continue;
                }

                for pfd in &poll_fds {
                    if (pfd.revents & libc::POLLIN) == 0 {
                        continue;
                    }
                    loop {
                        let bytes_read = unsafe {
                            libc::read(
                                pfd.fd,
                                buf.as_mut_ptr() as *mut libc::c_void,
                                std::mem::size_of_val(&buf),
                            )
                        };
                        if bytes_read <= 0 {
                            break;
                        }
                        let num_events = bytes_read as usize / std::mem::size_of::<InputEvent>();
                        for event in &buf[..num_events] {
                            if event.type_ == EV_KEY {
                                let pressed = event.value != 0;
                                match event.code {
                                    BTN_LEFT => {
                                        thread_buttons.write()[0] = pressed;
                                    }
                                    BTN_MIDDLE => {
                                        thread_buttons.write()[1] = pressed;
                                    }
                                    BTN_RIGHT => {
                                        thread_buttons.write()[2] = pressed;
                                    }
                                    BTN_SIDE | BTN_BACK => {
                                        thread_buttons.write()[3] = pressed;
                                    }
                                    BTN_EXTRA | BTN_FORWARD => {
                                        thread_buttons.write()[4] = pressed;
                                    }
                                    BTN_TASK => {
                                        thread_buttons.write()[5] = pressed;
                                    }
                                    code => {
                                        if let Some(kc) = evdev_code_to_keycode(code) {
                                            if pressed {
                                                thread_keys.write().insert(kc);
                                            } else {
                                                thread_keys.write().remove(&kc);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        Some(Self {
            buttons,
            keys,
            stop,
            thread: Some(thread),
        })
    }

    pub fn get_buttons(&self) -> [bool; 6] {
        *self.buttons.read()
    }

    pub fn get_keys(&self) -> Vec<Keycode> {
        self.keys.read().iter().copied().collect()
    }
}

impl Drop for EvdevInputListener {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn evdev_code_to_keycode(code: u16) -> Option<Keycode> {
    match code {
        1 => Some(Keycode::Escape),
        2 => Some(Keycode::Key1),
        3 => Some(Keycode::Key2),
        4 => Some(Keycode::Key3),
        5 => Some(Keycode::Key4),
        6 => Some(Keycode::Key5),
        7 => Some(Keycode::Key6),
        8 => Some(Keycode::Key7),
        9 => Some(Keycode::Key8),
        10 => Some(Keycode::Key9),
        11 => Some(Keycode::Key0),
        12 => Some(Keycode::Minus),
        13 => Some(Keycode::Equal),
        14 => Some(Keycode::Backspace),
        15 => Some(Keycode::Tab),
        16 => Some(Keycode::Q),
        17 => Some(Keycode::W),
        18 => Some(Keycode::E),
        19 => Some(Keycode::R),
        20 => Some(Keycode::T),
        21 => Some(Keycode::Y),
        22 => Some(Keycode::U),
        23 => Some(Keycode::I),
        24 => Some(Keycode::O),
        25 => Some(Keycode::P),
        26 => Some(Keycode::LeftBracket),
        27 => Some(Keycode::RightBracket),
        28 => Some(Keycode::Enter),
        29 => Some(Keycode::LControl),
        30 => Some(Keycode::A),
        31 => Some(Keycode::S),
        32 => Some(Keycode::D),
        33 => Some(Keycode::F),
        34 => Some(Keycode::G),
        35 => Some(Keycode::H),
        36 => Some(Keycode::J),
        37 => Some(Keycode::K),
        38 => Some(Keycode::L),
        39 => Some(Keycode::Semicolon),
        40 => Some(Keycode::Apostrophe),
        41 => Some(Keycode::Grave),
        42 => Some(Keycode::LShift),
        43 => Some(Keycode::BackSlash),
        44 => Some(Keycode::Z),
        45 => Some(Keycode::X),
        46 => Some(Keycode::C),
        47 => Some(Keycode::V),
        48 => Some(Keycode::B),
        49 => Some(Keycode::N),
        50 => Some(Keycode::M),
        51 => Some(Keycode::Comma),
        52 => Some(Keycode::Dot),
        53 => Some(Keycode::Slash),
        54 => Some(Keycode::RShift),
        56 => Some(Keycode::LAlt),
        57 => Some(Keycode::Space),
        58 => Some(Keycode::CapsLock),
        59 => Some(Keycode::F1),
        60 => Some(Keycode::F2),
        61 => Some(Keycode::F3),
        62 => Some(Keycode::F4),
        63 => Some(Keycode::F5),
        64 => Some(Keycode::F6),
        65 => Some(Keycode::F7),
        66 => Some(Keycode::F8),
        67 => Some(Keycode::F9),
        68 => Some(Keycode::F10),
        87 => Some(Keycode::F11),
        88 => Some(Keycode::F12),
        96 => Some(Keycode::NumpadEnter),
        97 => Some(Keycode::RControl),
        98 => Some(Keycode::NumpadDivide),
        100 => Some(Keycode::RAlt),
        102 => Some(Keycode::Home),
        103 => Some(Keycode::Up),
        104 => Some(Keycode::PageUp),
        105 => Some(Keycode::Left),
        106 => Some(Keycode::Right),
        107 => Some(Keycode::End),
        108 => Some(Keycode::Down),
        109 => Some(Keycode::PageDown),
        110 => Some(Keycode::Insert),
        111 => Some(Keycode::Delete),
        125 => Some(Keycode::LMeta),
        126 => Some(Keycode::RMeta),
        _ => None,
    }
}
