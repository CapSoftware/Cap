use std::sync::atomic::{AtomicU64, Ordering};

pub const NAMES: [&str; 16] = [
    "bgra_frames",
    "prepare_ns",
    "layers_render_ns",
    "encode_ns",
    "submit_ns",
    "wait_ns",
    "dec_reader_new",
    "dec_idle_teardown",
    "dec_reset",
    "dec_frames_iterated",
    "dec_below_floor",
    "dec_requests",
    "dec_decode_loops",
    "dec_stale_after_loop",
    "dec_reader_new_ns",
    "dec_reset_ns",
];

pub const BGRA_FRAMES: usize = 0;
pub const PREPARE_NS: usize = 1;
pub const LAYERS_RENDER_NS: usize = 2;
pub const ENCODE_NS: usize = 3;
pub const SUBMIT_NS: usize = 4;
pub const WAIT_NS: usize = 5;
pub const DEC_READER_NEW: usize = 6;
pub const DEC_IDLE_TEARDOWN: usize = 7;
pub const DEC_RESET: usize = 8;
pub const DEC_FRAMES_ITERATED: usize = 9;
pub const DEC_BELOW_FLOOR: usize = 10;
pub const DEC_REQUESTS: usize = 11;
pub const DEC_DECODE_LOOPS: usize = 12;
pub const DEC_STALE_AFTER_LOOP: usize = 13;
pub const DEC_READER_NEW_NS: usize = 14;
pub const DEC_RESET_NS: usize = 15;

static COUNTERS: [AtomicU64; 16] = [const { AtomicU64::new(0) }; 16];

pub fn add(index: usize, value: u64) {
    COUNTERS[index].fetch_add(value, Ordering::Relaxed);
}

pub fn add_since(index: usize, started: std::time::Instant) {
    add(index, started.elapsed().as_nanos() as u64);
}

pub fn snapshot() -> [u64; 16] {
    std::array::from_fn(|index| COUNTERS[index].load(Ordering::Relaxed))
}
