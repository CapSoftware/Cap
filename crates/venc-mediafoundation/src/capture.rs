use std::sync::mpsc::{Receiver, Sender, channel};

use scap_direct3d::Capturer;
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
        Graphics::{
            Direct3D11::{ID3D11Device, ID3D11DeviceContext},
            Gdi::HMONITOR,
        },
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
    sender: Sender<Option<Direct3D11CaptureFrame>>,
    receiver: Receiver<Option<Direct3D11CaptureFrame>>,
    capturer: scap_direct3d::Capturer,
}

impl CaptureFrameGenerator {
    pub fn new(
        d3d_device: ID3D11Device,
        d3d_context: ID3D11DeviceContext,
        item: GraphicsCaptureItem,
    ) -> Result<Self> {
        let (sender, receiver) = channel();

        Ok(Self {
            _d3d_device: d3d_device.clone(),
            _item: item.clone(),
            sender: sender.clone(),
            receiver,
            capturer: Capturer::new(
                item,
                scap_direct3d::Settings {
                    pixel_format: scap_direct3d::PixelFormat::B8G8R8A8Unorm,
                    ..Default::default()
                },
                move |frame| {
                    dbg!(frame.width(), frame.height());
                    let _ = sender.send(Some(frame.inner().clone()));
                    Ok(())
                },
                || Ok(()),
                Some((d3d_device, d3d_context)),
            )
            .unwrap(),
        })
    }

    pub fn session(&self) -> &GraphicsCaptureSession {
        self.capturer.session()
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
        self.capturer.session().Close().unwrap();
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
