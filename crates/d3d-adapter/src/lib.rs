// Pinned-adapter selection for D3D11 / MediaFoundation pipelines.
//
// Background: `D3D11CreateDevice(NULL, D3D_DRIVER_TYPE_HARDWARE, ...)` lets Windows pick
// the first DXGI adapter it enumerates. On machines with virtual-display drivers installed
// (most prominently Parsec, but also DisplayLink, Splashtop, Synergy) that "first" adapter
// can be a virtual one whose underlying user-mode driver does not safely support the
// `D3D11_CREATE_DEVICE_VIDEO_SUPPORT` workloads MediaFoundation issues. The observed
// failure mode in production was Cap.exe being terminated silently by an SEH exception
// originating in `msmpeg2vdec.dll_unloaded` after the virtual driver tore down its D3D11
// device underneath us. Forcing a real physical adapter eliminates the failure mode
// entirely while having no behavioural impact on machines without virtual displays.

#![cfg(target_os = "windows")]

use tracing::{info, warn};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIAdapter, IDXGIAdapter1, IDXGIFactory1,
};
use windows::core::Interface;

const VIRTUAL_ADAPTER_MARKERS: &[&str] = &[
    "Parsec",
    "DisplayLink",
    "Splashtop",
    "Synergy",
    "Virtual Display",
    "Microsoft Basic Render",
    "Microsoft Basic",
    "WARP",
];

#[derive(Clone)]
pub struct SelectedAdapter {
    pub adapter: IDXGIAdapter,
    pub description: String,
    pub vendor_id: u32,
    pub dedicated_vram_bytes: u64,
    pub luid_low: u32,
    pub luid_high: i32,
}

/// Selects a physical hardware DXGI adapter, optionally preferring one whose LUID
/// matches `preferred_luid` (low, high). Skips:
/// - Software adapters (`DXGI_ADAPTER_FLAG_SOFTWARE`).
/// - Virtual-display drivers identified by description fragments.
///
/// If `preferred_luid` matches a hardware adapter, that one is returned. Otherwise
/// the hardware adapter with the most dedicated VRAM is returned.
///
/// Returns `Err` only when the system advertises **zero** physical hardware adapters,
/// in which case callers should fall back to WARP if they need a software path.
pub fn select_capture_adapter(
    preferred_luid: Option<(u32, i32)>,
) -> Result<SelectedAdapter, String> {
    unsafe {
        let factory: IDXGIFactory1 =
            CreateDXGIFactory1().map_err(|e| format!("CreateDXGIFactory1 failed: {e:?}"))?;

        let mut best: Option<SelectedAdapter> = None;
        let mut preferred: Option<SelectedAdapter> = None;
        let mut idx = 0u32;

        loop {
            let adapter1: IDXGIAdapter1 = match factory.EnumAdapters1(idx) {
                Ok(a) => a,
                Err(_) => break,
            };
            idx += 1;

            let desc1 = match adapter1.GetDesc1() {
                Ok(d) => d,
                Err(e) => {
                    warn!(error = ?e, "Failed to read DXGI adapter description; skipping");
                    continue;
                }
            };

            let len = desc1.Description.iter().take_while(|&&c| c != 0).count();
            let description = String::from_utf16_lossy(&desc1.Description[..len]);
            let is_software = desc1.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0;
            let is_virtual = VIRTUAL_ADAPTER_MARKERS
                .iter()
                .any(|marker| description.contains(marker));

            if is_software || is_virtual {
                info!(
                    adapter = %description,
                    vendor_id = format!("0x{:04X}", desc1.VendorId),
                    is_software,
                    is_virtual,
                    "Skipping non-physical DXGI adapter"
                );
                continue;
            }

            let adapter: IDXGIAdapter = match adapter1.cast() {
                Ok(a) => a,
                Err(e) => {
                    warn!(error = ?e, adapter = %description, "Failed to obtain IDXGIAdapter for hardware adapter; skipping");
                    continue;
                }
            };

            let candidate = SelectedAdapter {
                adapter: adapter.clone(),
                description: description.clone(),
                vendor_id: desc1.VendorId,
                dedicated_vram_bytes: desc1.DedicatedVideoMemory as u64,
                luid_low: desc1.AdapterLuid.LowPart,
                luid_high: desc1.AdapterLuid.HighPart,
            };

            if let Some((wanted_low, wanted_high)) = preferred_luid
                && desc1.AdapterLuid.LowPart == wanted_low
                && desc1.AdapterLuid.HighPart == wanted_high
                && preferred.is_none()
            {
                preferred = Some(candidate.clone());
            }

            best = match best {
                None => Some(candidate),
                Some(b) if candidate.dedicated_vram_bytes > b.dedicated_vram_bytes => {
                    Some(candidate)
                }
                Some(b) => Some(b),
            };
        }

        if let Some(p) = preferred {
            info!(
                adapter = %p.description,
                vendor_id = format!("0x{:04X}", p.vendor_id),
                vram_mb = p.dedicated_vram_bytes / (1024 * 1024),
                "Selected DXGI adapter by preferred LUID"
            );
            return Ok(p);
        }

        let best = best.ok_or_else(|| {
			"No physical hardware DXGI adapter available (all enumerated adapters were virtual or software)"
				.to_string()
		})?;

        info!(
            adapter = %best.description,
            vendor_id = format!("0x{:04X}", best.vendor_id),
            vram_mb = best.dedicated_vram_bytes / (1024 * 1024),
            "Selected DXGI adapter by VRAM"
        );
        Ok(best)
    }
}
