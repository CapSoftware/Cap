use std::sync::mpsc::{Receiver, Sender, channel};

use windows::{
    Foundation::TypedEventHandler,
    Graphics::{
        Capture::{
            Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem,
            GraphicsCaptureSession,
        },
        DirectX::DirectXPixelFormat,
        SizeInt32,
    },
    Win32::{
        Graphics::{Direct3D11::ID3D11Device, Gdi::HMONITOR},
        System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop,
    },
    core::{IInspectable, Result},
};

use crate::d3d::create_direct3d_device;

pub fn create_capture_item_for_monitor(monitor_handle: HMONITOR) -> Result<GraphicsCaptureItem> {
    let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    unsafe { interop.CreateForMonitor(monitor_handle) }
}

pub struct CaptureFrameGenerator {
    _d3d_device: ID3D11Device,
    _item: GraphicsCaptureItem,
    frame_pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    sender: Sender<Option<Direct3D11CaptureFrame>>,
    receiver: Receiver<Option<Direct3D11CaptureFrame>>,
}

impl CaptureFrameGenerator {
    pub fn new(
        d3d_device: ID3D11Device,
        item: GraphicsCaptureItem,
        size: SizeInt32,
    ) -> Result<Self> {
        let device = create_direct3d_device(&d3d_device)?;
        let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        )?;
        let session = frame_pool.CreateCaptureSession(&item)?;

        let (sender, receiver) = channel();
        frame_pool.FrameArrived(
            &TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new({
                let session = session.clone();
                let sender = sender.clone();
                move |frame_pool, _| {
                    let frame_pool = frame_pool.as_ref().unwrap();
                    let frame = frame_pool.TryGetNextFrame()?;
                    if sender.send(Some(frame)).is_err() {
                        frame_pool.Close()?;
                        session.Close()?;
                    }
                    Ok(())
                }
            }),
        )?;

        Ok(Self {
            _d3d_device: d3d_device,
            _item: item,
            frame_pool,
            session,
            sender,
            receiver,
        })
    }

    pub fn session(&self) -> &GraphicsCaptureSession {
        &self.session
    }

    pub fn try_get_next_frame(&mut self) -> Result<Option<Direct3D11CaptureFrame>> {
        if let Some(frame) = self.receiver.recv().unwrap() {
            Ok(Some(frame))
        } else {
            Ok(None)
        }
    }

    pub fn stop_capture(&mut self) -> Result<()> {
        self.sender.send(None).unwrap();
        Ok(())
    }

    pub fn stop_signal(&self) -> CaptureFrameGeneratorStopSignal {
        CaptureFrameGeneratorStopSignal::new(self.sender.clone())
    }
}

impl Drop for CaptureFrameGenerator {
    fn drop(&mut self) {
        self.session.Close().unwrap();
        self.frame_pool.Close().unwrap();
    }
}

pub struct CaptureFrameGeneratorStopSignal {
    sender: Sender<Option<Direct3D11CaptureFrame>>,
}

impl CaptureFrameGeneratorStopSignal {
    fn new(sender: Sender<Option<Direct3D11CaptureFrame>>) -> Self {
        Self { sender }
    }

    pub fn signal(&self) {
        let _ = self.sender.send(None);
    }
}
