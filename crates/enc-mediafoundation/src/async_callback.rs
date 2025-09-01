use std::cell::Cell;

use windows::{
    Win32::{Foundation::E_NOTIMPL, Media::MediaFoundation::*},
    core::*,
};

#[implement(IMFAsyncCallback)]
pub struct AsyncCallback<F>
where
    F: Send + FnOnce(windows::core::Ref<'_, IMFAsyncResult>) + 'static,
{
    // generator: IMFMediaEventGenerator,
    on_invoke: Cell<Option<F>>,
    // tx: Cell<Option<oneshot::Sender<Result<UnsafeSend<IMFMediaEvent>>>>>,
}

impl<F> AsyncCallback<F>
where
    F: Send + FnOnce(windows::core::Ref<'_, IMFAsyncResult>) + 'static,
{
    pub fn new(on_invoke: F) -> Self {
        Self {
            on_invoke: Cell::new(Some(on_invoke)),
            // tx: Cell::new(None),
        }
    }
}

impl<F> IMFAsyncCallback_Impl for AsyncCallback_Impl<F>
where
    F: Send + FnOnce(windows::core::Ref<'_, IMFAsyncResult>),
{
    fn GetParameters(&self, _pdwflags: *mut u32, _pdwqueue: *mut u32) -> windows::core::Result<()> {
        Err(windows::core::Error::from_hresult(E_NOTIMPL))
    }

    fn Invoke(&self, result: windows::core::Ref<'_, IMFAsyncResult>) -> windows::core::Result<()> {
        if let Some(on_invoke) = self.on_invoke.take() {
            on_invoke(result);
        }
        Ok(())
    }
}
