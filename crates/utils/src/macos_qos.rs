use libc::qos_class_t::{QOS_CLASS_USER_INITIATED, QOS_CLASS_USER_INTERACTIVE};

#[derive(Clone, Copy, Debug)]
pub enum MacOsQosClass {
    UserInteractive,
    UserInitiated,
}

impl MacOsQosClass {
    fn as_raw(self) -> libc::qos_class_t {
        match self {
            Self::UserInteractive => QOS_CLASS_USER_INTERACTIVE,
            Self::UserInitiated => QOS_CLASS_USER_INITIATED,
        }
    }
}

pub fn set_current_thread_qos(qos_class: MacOsQosClass) -> i32 {
    unsafe { libc::pthread_set_qos_class_self_np(qos_class.as_raw(), 0) }
}
