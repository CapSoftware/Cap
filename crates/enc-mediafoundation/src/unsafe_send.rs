use std::{fmt::Display, ops::Deref};

#[derive(Debug)]
pub struct UnsafeSend<T>(pub T);

unsafe impl<T> Send for UnsafeSend<T> {}
unsafe impl<T> Sync for UnsafeSend<T> {}

impl<T> Deref for UnsafeSend<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<T> From<T> for UnsafeSend<T> {
    fn from(inner: T) -> Self {
        Self(inner)
    }
}

impl<T> Clone for UnsafeSend<T>
where
    T: Clone,
{
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T> Display for UnsafeSend<T>
where
    T: std::fmt::Debug,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
