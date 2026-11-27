use windows::{
    Win32::Graphics::{
        Direct3D11::ID3D11Device,
        Dxgi::{
            Common::DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020, CreateDXGIFactory1,
            DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIAdapter1, IDXGIDevice, IDXGIFactory1, IDXGIOutput6,
        },
        Gdi::HMONITOR,
    },
    core::Interface,
};

/// What a capture device's adapter is and how it relates to the captured
/// monitor. Every field is `None` when its query failed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AdapterFacts {
    pub vendor_id: Option<u32>,
    pub software: Option<bool>,
    /// The device's own adapter drives the monitor's output.
    pub drives_monitor: Option<bool>,
    /// The monitor's output is in an HDR colour space.
    pub hdr: Option<bool>,
}

pub fn adapter_facts(device: &ID3D11Device, monitor: HMONITOR) -> AdapterFacts {
    let mut facts = AdapterFacts::default();
    let Some(adapter) = device
        .cast::<IDXGIDevice>()
        .and_then(|device| unsafe { device.GetAdapter() })
        .and_then(|adapter| adapter.cast::<IDXGIAdapter1>())
        .ok()
    else {
        return facts;
    };
    let Ok(desc) = (unsafe { adapter.GetDesc1() }) else {
        return facts;
    };
    facts.vendor_id = Some(desc.VendorId);
    facts.software = Some(desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0);

    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
        return facts;
    };
    for adapter_index in 0..32 {
        let Ok(candidate) = (unsafe { factory.EnumAdapters1(adapter_index) }) else {
            break;
        };
        let Ok(candidate_desc) = (unsafe { candidate.GetDesc1() }) else {
            return facts;
        };
        for output_index in 0..32 {
            let Ok(output) = (unsafe { candidate.EnumOutputs(output_index) }) else {
                break;
            };
            let Ok(output_desc) = (unsafe { output.GetDesc() }) else {
                return facts;
            };
            if output_desc.Monitor != monitor {
                continue;
            }
            facts.drives_monitor = Some(
                candidate_desc.AdapterLuid.LowPart == desc.AdapterLuid.LowPart
                    && candidate_desc.AdapterLuid.HighPart == desc.AdapterLuid.HighPart,
            );
            facts.hdr = output
                .cast::<IDXGIOutput6>()
                .and_then(|output| unsafe { output.GetDesc1() })
                .ok()
                .map(|desc| desc.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020);
            return facts;
        }
    }
    facts
}
