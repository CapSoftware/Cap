pub mod camera;
pub mod microphone;

/// Outcome of a synthetic device's hand-off. Device callbacks never wait for
/// a feed: they `try_send` and the frame is lost when the feed's mailbox is
/// full or the feed has stopped. Test-only sources hand over the same way so
/// a feed that cannot keep up is visible as a rejection, not as a late
/// source.
#[cfg(any(test, feature = "test-utils"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    Accepted,
    Full,
    Closed,
}

#[cfg(any(test, feature = "test-utils"))]
impl Admission {
    fn of<M, E>(result: Result<(), kameo::error::SendError<M, E>>) -> Self {
        match result {
            Ok(()) => Self::Accepted,
            Err(kameo::error::SendError::MailboxFull(_)) => Self::Full,
            Err(_) => Self::Closed,
        }
    }
}

/// Test-only slow consumer: the feed actor handles nothing else for the
/// given time, as a feed blocked on a downstream consumer would.
#[cfg(any(test, feature = "test-utils"))]
pub struct Stall(pub std::time::Duration);
