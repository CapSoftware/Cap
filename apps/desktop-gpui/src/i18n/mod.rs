use std::sync::atomic::{AtomicU8, Ordering};

include!(concat!(env!("OUT_DIR"), "/i18n.rs"));

static CURRENT: AtomicU8 = AtomicU8::new(Locale::En as u8);

fn index() -> usize {
    CURRENT.load(Ordering::Relaxed) as usize
}

#[cfg(test)]
mod tests;
