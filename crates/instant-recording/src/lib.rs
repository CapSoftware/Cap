use std::time::{Instant, SystemTime};

struct MultiSourceTimestamp {
    instant: Instant,
    system_time: SystemTime,
}

impl MultiSourceTimestamp {
    pub fn now() -> Self {
        Self {
            instant: Instant::now(),
            system_time: SystemTime::now(),
        }
    }
}
