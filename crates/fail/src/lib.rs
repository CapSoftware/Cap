use std::collections::BTreeMap;
use std::sync::LazyLock;
use std::sync::{Arc, RwLock};

#[derive(Debug)]
pub struct Fail {
    pub name: &'static str,
}

inventory::collect!(Fail);

static FAILS: LazyLock<Arc<RwLock<BTreeMap<String, bool>>>> = LazyLock::new(|| {
    Arc::new(RwLock::new(if cfg!(debug_assertions) {
        BTreeMap::from_iter(inventory::iter::<Fail>().map(|fail| (fail.name.to_string(), false)))
    } else {
        BTreeMap::new()
    }))
});

#[macro_export]
macro_rules! fail {
    ($name:literal) => {
        #[cfg(debug_assertions)]
        {
            $crate::private::inventory::submit! {
                $crate::Fail { name: $name }
            }

            let name: &str = $name;
            let should_fail = $crate::private::should_fail(name);

            if should_fail {
                panic!("Purposely panicked at '{name}'")
            }
        }
    };
}

#[macro_export]
macro_rules! fail_err {
    ($name:literal, $value:expr) => {
        #[cfg(debug_assertions)]
        {
            $crate::private::inventory::submit! {
                $crate::Fail { name: $name }
            }

            let name: &str = $name;
            let should_fail = $crate::private::should_fail(name);

            if should_fail {
                eprintln!("Purposely Err'd at '{name}'");
                Err($value)?;
            }
        }
    };
}

#[doc(hidden)]
pub mod private {
    use super::*;

    pub use inventory;

    pub fn should_fail(name: &str) -> bool {
        FAILS.read().unwrap().get(name).cloned().unwrap_or_default()
    }
}

pub fn get_state() -> BTreeMap<String, bool> {
    FAILS.read().unwrap().clone()
}

pub fn set_fail(name: impl Into<String>, should_fail: bool) {
    FAILS.write().unwrap().insert(name.into(), should_fail);
}
