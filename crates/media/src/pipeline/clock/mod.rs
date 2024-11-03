mod real_time;
mod recorded;

pub use real_time::*;
pub use recorded::*;

pub trait PipelineClock: Clone + Send + 'static {
    fn start(&mut self);

    fn stop(&mut self);

    fn running(&self) -> bool;
}

// TODO: Move to utils mod?
pub trait CloneFrom<T> {
    fn clone_from(value: &T) -> Self;
}

pub trait CloneInto<T> {
    fn clone_into(&self) -> T;
}

impl<S, T> CloneFrom<T> for S
where
    T: CloneInto<S>,
{
    fn clone_from(value: &T) -> Self {
        value.clone_into()
    }
}
