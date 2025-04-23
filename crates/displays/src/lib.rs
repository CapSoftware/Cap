mod platform;

pub use platform::DisplayImpl;

#[derive(Clone, Copy)]
pub struct Display(DisplayImpl);

impl Display {
    pub fn primary() -> Self {
        Self(DisplayImpl::primary())
    }

    pub fn list() -> Vec<Self> {
        DisplayImpl::list().into_iter().map(Self).collect()
    }

    pub fn raw_handle(&self) -> &DisplayImpl {
        &self.0
    }
}
