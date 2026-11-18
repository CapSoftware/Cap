use std::sync::atomic::{AtomicUsize, Ordering};

static EXPORTS_RUNNING: AtomicUsize = AtomicUsize::new(0);

/// Held for as long as an export runs, so background work in the same
/// process (hover analysis) can step aside instead of slowing the export.
pub struct ExportActivity(());

impl ExportActivity {
    pub fn begin() -> Self {
        EXPORTS_RUNNING.fetch_add(1, Ordering::AcqRel);
        Self(())
    }

    pub fn any_running() -> bool {
        EXPORTS_RUNNING.load(Ordering::Acquire) > 0
    }
}

impl Drop for ExportActivity {
    fn drop(&mut self) {
        EXPORTS_RUNNING.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_while_any_export_is_held() {
        let before = ExportActivity::any_running();
        let first = ExportActivity::begin();
        let second = ExportActivity::begin();
        assert!(ExportActivity::any_running());
        drop(first);
        assert!(ExportActivity::any_running());
        drop(second);
        assert_eq!(ExportActivity::any_running(), before);
    }
}
