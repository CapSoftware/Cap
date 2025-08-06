use windows::{
    Foundation::TypedEventHandler,
    Graphics::{
        Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem},
        DirectX::DirectXPixelFormat,
    },
    Win32::{
        Foundation::{HMODULE, POINT},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            Direct3D11::{
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11CreateDevice,
                ID3D11Device, ID3D11DeviceContext,
            },
            Dxgi::IDXGIDevice,
            Gdi::{MONITOR_DEFAULTTONULL, MonitorFromPoint},
        },
        System::{
            Com::{CoInitialize, CoInitializeEx},
            WinRT::{
                Direct3D11::CreateDirect3D11DeviceFromDXGIDevice,
                Graphics::Capture::IGraphicsCaptureItemInterop,
            },
        },
    },
    core::IInspectable,
};

fn main() {
    unsafe {
        CoInitialize(None);

        let mut d3d_device = None;
        let mut d3d_context = None;

        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            Default::default(),
            None,
            D3D11_SDK_VERSION,
            Some(&mut d3d_device),
            None,
            Some(&mut d3d_context),
        )
        .expect("Failed to create Direct3D device");

        let d3d_device = d3d_device.unwrap();
        let d3d_context = d3d_context.unwrap();

        let dxgi_device = d3d_device.cast::<IDXGIDevice>().unwrap();
        let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device)? };
        let direct3d_device = inspectable.cast::<IDirect3DDevice>().unwrap();

        let primary_monitor = {
            let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTONULL);
            if monitor.is_invalid() {
                panic!("Primary monitor not found");
            }
            monitor
        };

        let item: GraphicsCaptureItem = {
            let interop =
                windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
                    .unwrap();
            interop.CreateForMonitor(primary_monitor).unwrap()
        };

        let frame_pool = Direct3D11CaptureFramePool::Create(
            &direct3d_device,
            DirectXPixelFormat::R8G8B8A8UIntNormalized,
            1,
            item.Size().unwrap(),
        )
        .unwrap();

        let session = frame_pool.CreateCaptureSession(&item).unwrap();

        frame_pool
            .FrameArrived(
                &TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(
                    |frame_pool, _| {
                        let frame = frame_pool
                            .as_ref()
                            .expect("FrameArrived parameter was None")
                            .TryGetNextFrame()?;

                        dbg!(frame);
                    },
                ),
            )
            .unwrap();

        session.StartCapture().unwrap();
    };
}
