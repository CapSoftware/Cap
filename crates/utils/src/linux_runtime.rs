use std::num::NonZeroUsize;

pub fn llvmpipe_thread_count() -> Option<usize> {
    select_llvmpipe_thread_count(
        std::env::var_os("LP_NUM_THREADS").is_some(),
        std::thread::available_parallelism().ok(),
    )
}

fn select_llvmpipe_thread_count(
    override_present: bool,
    available_threads: Option<NonZeroUsize>,
) -> Option<usize> {
    if override_present {
        return None;
    }

    available_threads.map(|count| count.get().min(32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn software_rendering_respects_available_cpu_capacity() {
        for count in [1, 2, 4, 8, 16, 32] {
            assert_eq!(
                select_llvmpipe_thread_count(false, NonZeroUsize::new(count)),
                Some(count)
            );
        }
    }

    #[test]
    fn software_rendering_preserves_explicit_thread_overrides() {
        assert_eq!(
            select_llvmpipe_thread_count(true, NonZeroUsize::new(4)),
            None
        );
    }

    #[test]
    fn software_rendering_does_not_exceed_mesas_default_thread_limit() {
        assert_eq!(
            select_llvmpipe_thread_count(false, NonZeroUsize::new(128)),
            Some(32)
        );
    }

    #[test]
    fn unknown_cpu_capacity_keeps_the_driver_default() {
        assert_eq!(select_llvmpipe_thread_count(false, None), None);
    }
}
