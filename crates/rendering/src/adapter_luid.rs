#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::LUID,
    Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1},
};

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug)]
pub struct AdapterLuid {
    pub low: u32,
    pub high: i32,
}

#[cfg(target_os = "windows")]
pub fn detect_adapter_luid_for_wgpu(adapter: &wgpu::Adapter) -> Option<AdapterLuid> {
    let info = adapter.get_info();

    unsafe {
        let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
            Ok(f) => f,
            Err(_) => return None,
        };

        let mut i = 0u32;
        loop {
            let dxgi_adapter: IDXGIAdapter = match factory.EnumAdapters(i) {
                Ok(a) => a,
                Err(_) => break,
            };

            let desc = match dxgi_adapter.GetDesc() {
                Ok(d) => d,
                Err(_) => {
                    i += 1;
                    continue;
                }
            };

            let vendor_id = desc.VendorId;
            let device_id = desc.DeviceId;

            if vendor_id == info.vendor && device_id == info.device {
                let LUID { LowPart, HighPart } = desc.AdapterLuid;
                return Some(AdapterLuid {
                    low: LowPart,
                    high: HighPart,
                });
            }

            i += 1;
        }
    }

    None
}

#[cfg(not(target_os = "windows"))]
#[derive(Clone, Copy, Debug)]
pub struct AdapterLuid {
    pub low: u32,
    pub high: i32,
}

#[cfg(not(target_os = "windows"))]
pub fn detect_adapter_luid_for_wgpu(_: &wgpu::Adapter) -> Option<AdapterLuid> {
    None
}
