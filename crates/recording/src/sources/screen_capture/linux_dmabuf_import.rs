//! Reads DMA-BUF screencast frames whose modifier a CPU cannot read directly.
//!
//! A compositor that shares only DMA-BUFs allocates them on its GPU with a
//! modifier both sides accept. On NVIDIA no LINEAR buffer can be rendered to
//! (`eglQueryDmaBufModifiersEXT` lists LINEAR as external only), so niri
//! offers only NVIDIA's block-linear modifiers. Those frames are imported into
//! EGL as images, attached to a framebuffer and read back as plain RGBA.

use anyhow::{Context as _, anyhow, bail};
use glow::HasContext as _;
use khronos_egl as egl;
use std::ffi::c_void;
use std::os::fd::RawFd;

const EGL_PLATFORM_DEVICE_EXT: egl::Enum = 0x313F;
const EGL_DRM_RENDER_NODE_FILE_EXT: egl::Int = 0x3377;
const EGL_LINUX_DMA_BUF_EXT: egl::Enum = 0x3270;
const EGL_LINUX_DRM_FOURCC_EXT: egl::Attrib = 0x3271;
const EGL_DMA_BUF_PLANE0_FD_EXT: egl::Attrib = 0x3272;
const EGL_DMA_BUF_PLANE0_OFFSET_EXT: egl::Attrib = 0x3273;
const EGL_DMA_BUF_PLANE0_PITCH_EXT: egl::Attrib = 0x3274;
const EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT: egl::Attrib = 0x3443;
const EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT: egl::Attrib = 0x3444;
const EGL_NO_CONTEXT: egl::EGLContext = std::ptr::null_mut();

pub(super) const DRM_FORMAT_MOD_LINEAR: u64 = 0;
pub(super) const DRM_FORMAT_MOD_INVALID: u64 = 0x00ff_ffff_ffff_ffff;

type QueryDevices = unsafe extern "C" fn(egl::Int, *mut *mut c_void, *mut egl::Int) -> egl::Boolean;
type QueryDeviceString = unsafe extern "C" fn(*mut c_void, egl::Int) -> *const std::ffi::c_char;
type GetPlatformDisplay =
    unsafe extern "C" fn(egl::Enum, *mut c_void, *const egl::Int) -> egl::EGLDisplay;
type QueryDmaBufModifiers = unsafe extern "C" fn(
    egl::EGLDisplay,
    egl::Int,
    egl::Int,
    *mut u64,
    *mut egl::Boolean,
    *mut egl::Int,
) -> egl::Boolean;
type ImageTargetTexture = unsafe extern "C" fn(u32, *mut c_void);

/// The DRM fourcc for a PipeWire raw video format.
pub(super) fn drm_fourcc(format: pipewire::spa::param::video::VideoFormat) -> Option<u32> {
    use pipewire::spa::param::video::VideoFormat;
    let code = |s: &[u8; 4]| u32::from_le_bytes(*s);
    if format == VideoFormat::BGRx {
        Some(code(b"XR24"))
    } else if format == VideoFormat::BGRA {
        Some(code(b"AR24"))
    } else if format == VideoFormat::RGBx {
        Some(code(b"XB24"))
    } else if format == VideoFormat::RGBA {
        Some(code(b"AB24"))
    } else {
        None
    }
}

/// One GPU's EGL device, with a context that can read its imports back.
struct GpuImporter {
    egl: egl::DynamicInstance<egl::EGL1_5>,
    display: egl::Display,
    context: egl::Context,
    gl: Option<glow::Context>,
    image_target_texture: ImageTargetTexture,
    query_modifiers: QueryDmaBufModifiers,
    framebuffer: Option<glow::Framebuffer>,
    texture: Option<glow::Texture>,
    /// The kernel driver of the GPU's render node (`amdgpu`, `nvidia`, ...).
    driver: Option<String>,
    /// The GPU's render node, which identifies it between recordings.
    node: Option<String>,
}

// The EGL context is made current on whichever single thread uses the
// importer, and released before it moves.
unsafe impl Send for GpuImporter {}

/// Every GPU that can import screencast DMA-BUFs. The compositor allocates
/// on whichever GPU it renders with, and a hybrid laptop's first GPU is often
/// not that one, so modifiers are offered from all of them and each frame
/// goes to a GPU that lists its modifier.
pub(super) struct DmaBufImporter {
    gpus: Vec<GpuImporter>,
    supported: Vec<std::collections::HashMap<u32, Vec<u64>>>,
    last: usize,
    remembered: bool,
}

/// The render node of the GPU that last read a screencast frame, kept for the
/// rest of the session.
static LAST_IMPORT_NODE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn remembered_gpu(nodes: &[Option<&str>], remembered: Option<&str>) -> usize {
    remembered
        .and_then(|remembered| nodes.iter().position(|node| *node == Some(remembered)))
        .unwrap_or(0)
}

impl DmaBufImporter {
    pub(super) fn new() -> anyhow::Result<Self> {
        let mut gpus = Vec::new();
        let mut last_error = None;
        for index in 0..16 {
            match GpuImporter::open(index) {
                Ok(Some(gpu)) => gpus.push(gpu),
                Ok(None) => break,
                Err(error) => {
                    tracing::debug!(index, %error, "EGL device cannot import DMA-BUFs");
                    last_error = Some(error);
                }
            }
        }
        if gpus.is_empty() {
            return Err(last_error.unwrap_or_else(|| anyhow!("EGL lists no devices")));
        }
        let supported = gpus.iter().map(|_| Default::default()).collect();
        // Several GPUs of one vendor can't be told apart by the frame's
        // exporter; the one that read the previous recording is tried first.
        let last = remembered_gpu(
            &gpus
                .iter()
                .map(|gpu| gpu.node.as_deref())
                .collect::<Vec<_>>(),
            LAST_IMPORT_NODE
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_deref(),
        );
        Ok(Self {
            gpus,
            supported,
            last,
            remembered: false,
        })
    }

    fn supported(&mut self, gpu: usize, fourcc: u32) -> &[u64] {
        let gpus = &self.gpus;
        self.supported[gpu]
            .entry(fourcc)
            .or_insert_with(|| gpus[gpu].modifiers(fourcc))
    }

    /// The modifiers some GPU can import `fourcc` with and read back.
    pub(super) fn modifiers(&mut self, fourcc: u32) -> Vec<u64> {
        let mut all = Vec::new();
        for gpu in 0..self.gpus.len() {
            for &modifier in self.supported(gpu, fourcc) {
                if !all.contains(&modifier) {
                    all.push(modifier);
                }
            }
        }
        all
    }

    /// Reads one single-plane DMA-BUF into `out` as tightly packed RGBA,
    /// starting with the GPU that read the last frame.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn read_rgba(
        &mut self,
        fd: RawFd,
        fourcc: u32,
        modifier: u64,
        width: u32,
        height: u32,
        offset: u32,
        stride: u32,
        out: &mut [u8],
    ) -> anyhow::Result<()> {
        let exporter = dma_buf_exporter(fd);
        let drivers = self
            .gpus
            .iter()
            .map(|gpu| gpu.driver.as_deref())
            .collect::<Vec<_>>();
        let order = import_order(&drivers, exporter.as_deref(), self.last);
        let mut last_error = None;
        for gpu in order {
            if !self.supported(gpu, fourcc).contains(&modifier) {
                continue;
            }
            match self.gpus[gpu].read_rgba(fd, fourcc, modifier, width, height, offset, stride, out)
            {
                Ok(()) => {
                    if self.last != gpu || !self.remembered {
                        *LAST_IMPORT_NODE
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) =
                            self.gpus[gpu].node.clone();
                        self.remembered = true;
                    }
                    self.last = gpu;
                    return Ok(());
                }
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error
            .unwrap_or_else(|| anyhow!("no GPU imports modifier {modifier:#x} for {fourcc:#x}")))
    }
}

impl GpuImporter {
    /// The `index`th GPU EGL lists, or `None` past the last.
    fn open(index: usize) -> anyhow::Result<Option<Self>> {
        let egl = unsafe {
            egl::DynamicInstance::<egl::EGL1_5>::load_required_from_filename("libEGL.so.1")
        }
        .map_err(|error| anyhow!("load libEGL: {error}"))?;
        let proc = |name: &str| {
            egl.get_proc_address(name)
                .map(|f| f as *const c_void)
                .ok_or_else(|| anyhow!("EGL has no {name}"))
        };
        let query_devices: QueryDevices =
            unsafe { std::mem::transmute(proc("eglQueryDevicesEXT")?) };
        let query_device_string: QueryDeviceString =
            unsafe { std::mem::transmute(proc("eglQueryDeviceStringEXT")?) };
        let get_platform_display: GetPlatformDisplay =
            unsafe { std::mem::transmute(proc("eglGetPlatformDisplayEXT")?) };
        let query_modifiers: QueryDmaBufModifiers =
            unsafe { std::mem::transmute(proc("eglQueryDmaBufModifiersEXT")?) };
        let image_target_texture: ImageTargetTexture =
            unsafe { std::mem::transmute(proc("glEGLImageTargetTexture2DOES")?) };

        let mut devices = [std::ptr::null_mut(); 16];
        let mut count = 0;
        if unsafe { query_devices(devices.len() as egl::Int, devices.as_mut_ptr(), &mut count) }
            == egl::FALSE
        {
            bail!("eglQueryDevicesEXT failed");
        }
        // A GPU (a device with a render node) can import what a GPU
        // allocated; without one, the devices EGL has are all there is.
        let devices = &devices[..count.max(0) as usize];
        let device_string = |device: *mut c_void, name: egl::Int| {
            let value = unsafe { query_device_string(device, name) };
            (!value.is_null()).then(|| {
                unsafe { std::ffi::CStr::from_ptr(value) }
                    .to_string_lossy()
                    .into_owned()
            })
        };
        let gpus = devices
            .iter()
            .filter_map(|&device| {
                let node = device_string(device, EGL_DRM_RENDER_NODE_FILE_EXT)?;
                let driver = render_node_driver(&node);
                let extensions = device_string(device, egl::EXTENSIONS).unwrap_or_default();
                // Opening a device no EGL vendor can drive only logs errors.
                drivable(driver.as_deref(), &extensions).then_some((device, driver, Some(node)))
            })
            .collect::<Vec<_>>();
        let candidates = if gpus.is_empty() {
            devices.iter().map(|&device| (device, None, None)).collect()
        } else {
            gpus
        };
        let Some((device, driver, node)) = candidates.get(index).cloned() else {
            return Ok(None);
        };
        let raw =
            unsafe { get_platform_display(EGL_PLATFORM_DEVICE_EXT, device, std::ptr::null()) };
        if raw.is_null() {
            bail!("no EGL display for the device");
        }
        let display = unsafe { egl::Display::from_ptr(raw) };
        egl.initialize(display).context("initialize EGL")?;
        let extensions = egl
            .query_string(Some(display), egl::EXTENSIONS)
            .context("query EGL extensions")?
            .to_string_lossy()
            .into_owned();
        for wanted in [
            "EGL_EXT_image_dma_buf_import_modifiers",
            "EGL_KHR_surfaceless_context",
        ] {
            if !extensions.split(' ').any(|extension| extension == wanted) {
                bail!("EGL has no {wanted}");
            }
        }
        egl.bind_api(egl::OPENGL_ES_API).context("bind GLES")?;
        let config = egl
            .choose_first_config(
                display,
                // Surfaceless: any surface type. The default asks for window
                // surfaces, which a GPU's EGL device (NVIDIA's) never has.
                &[
                    egl::SURFACE_TYPE,
                    0,
                    egl::RENDERABLE_TYPE,
                    egl::OPENGL_ES2_BIT,
                    egl::NONE,
                ],
            )
            .context("choose an EGL config")?
            .ok_or_else(|| anyhow!("no GLES EGL config"))?;
        let context = egl
            .create_context(
                display,
                config,
                None,
                &[egl::CONTEXT_CLIENT_VERSION, 2, egl::NONE],
            )
            .context("create a GLES context")?;
        let mut importer = Self {
            egl,
            display,
            context,
            gl: None,
            image_target_texture,
            query_modifiers,
            framebuffer: None,
            texture: None,
            driver,
            node,
        };
        importer.make_current()?;
        importer.release();
        Ok(Some(importer))
    }

    fn make_current(&mut self) -> anyhow::Result<()> {
        self.egl
            .make_current(self.display, None, None, Some(self.context))
            .context("make the EGL context current")?;
        if self.gl.is_none() {
            let egl = &self.egl;
            let gl = unsafe {
                glow::Context::from_loader_function(|name| {
                    egl.get_proc_address(name)
                        .map_or(std::ptr::null(), |f| f as *const c_void)
                })
            };
            self.gl = Some(gl);
        }
        Ok(())
    }

    /// Lets another thread make the context current.
    pub(super) fn release(&self) {
        let _ = self.egl.make_current(self.display, None, None, None);
    }

    /// The modifiers this GPU can import `fourcc` with and render to, so a
    /// framebuffer can read them back.
    pub(super) fn modifiers(&self, fourcc: u32) -> Vec<u64> {
        let mut modifiers = vec![0u64; 64];
        let mut external = vec![egl::FALSE; 64];
        let mut count = 0;
        let ok = unsafe {
            (self.query_modifiers)(
                self.display.as_ptr(),
                fourcc as egl::Int,
                modifiers.len() as egl::Int,
                modifiers.as_mut_ptr(),
                external.as_mut_ptr(),
                &mut count,
            )
        };
        if ok == egl::FALSE {
            return Vec::new();
        }
        modifiers
            .into_iter()
            .zip(external)
            .take(count.max(0) as usize)
            .filter(|(modifier, external)| {
                *external == egl::FALSE && *modifier != DRM_FORMAT_MOD_INVALID
            })
            .map(|(modifier, _)| modifier)
            .collect()
    }

    /// Reads one single-plane DMA-BUF into `out` as tightly packed RGBA.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn read_rgba(
        &mut self,
        fd: RawFd,
        fourcc: u32,
        modifier: u64,
        width: u32,
        height: u32,
        offset: u32,
        stride: u32,
        out: &mut [u8],
    ) -> anyhow::Result<()> {
        let needed = width as usize * height as usize * 4;
        if out.len() < needed {
            bail!(
                "RGBA readback buffer holds {} bytes, needs {needed}",
                out.len()
            );
        }
        self.make_current()?;
        let attributes = [
            egl::WIDTH as egl::Attrib,
            width as egl::Attrib,
            egl::HEIGHT as egl::Attrib,
            height as egl::Attrib,
            EGL_LINUX_DRM_FOURCC_EXT,
            fourcc as egl::Attrib,
            EGL_DMA_BUF_PLANE0_FD_EXT,
            fd as egl::Attrib,
            EGL_DMA_BUF_PLANE0_OFFSET_EXT,
            offset as egl::Attrib,
            EGL_DMA_BUF_PLANE0_PITCH_EXT,
            stride as egl::Attrib,
            EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT,
            (modifier & 0xffff_ffff) as egl::Attrib,
            EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT,
            (modifier >> 32) as egl::Attrib,
            egl::ATTRIB_NONE,
        ];
        let image = self
            .egl
            .create_image(
                self.display,
                unsafe { egl::Context::from_ptr(EGL_NO_CONTEXT) },
                EGL_LINUX_DMA_BUF_EXT,
                unsafe { egl::ClientBuffer::from_ptr(std::ptr::null_mut()) },
                &attributes,
            )
            .context("import the DMA-BUF into EGL")?;
        let result = self.read_image(&image, width, height, &mut out[..needed]);
        let _ = self.egl.destroy_image(self.display, image);
        self.release();
        result
    }

    fn read_image(
        &mut self,
        image: &egl::Image,
        width: u32,
        height: u32,
        out: &mut [u8],
    ) -> anyhow::Result<()> {
        let gl = self.gl.as_ref().expect("GL loaded with the context");
        unsafe {
            let texture = match self.texture {
                Some(texture) => texture,
                None => {
                    let texture = gl.create_texture().map_err(|error| anyhow!(error))?;
                    self.texture = Some(texture);
                    texture
                }
            };
            gl.bind_texture(glow::TEXTURE_2D, Some(texture));
            (self.image_target_texture)(glow::TEXTURE_2D, image.as_ptr());
            let framebuffer = match self.framebuffer {
                Some(framebuffer) => framebuffer,
                None => {
                    let framebuffer = gl.create_framebuffer().map_err(|error| anyhow!(error))?;
                    self.framebuffer = Some(framebuffer);
                    framebuffer
                }
            };
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(framebuffer));
            gl.framebuffer_texture_2d(
                glow::FRAMEBUFFER,
                glow::COLOR_ATTACHMENT0,
                glow::TEXTURE_2D,
                Some(texture),
                0,
            );
            let status = gl.check_framebuffer_status(glow::FRAMEBUFFER);
            if status != glow::FRAMEBUFFER_COMPLETE {
                bail!("the imported DMA-BUF is not readable (framebuffer status {status:#x})");
            }
            gl.pixel_store_i32(glow::PACK_ALIGNMENT, 1);
            gl.read_pixels(
                0,
                0,
                width as i32,
                height as i32,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                glow::PixelPackData::Slice(Some(out)),
            );
            let error = gl.get_error();
            if error != glow::NO_ERROR {
                bail!("reading the imported DMA-BUF failed (GL error {error:#x})");
            }
        }
        Ok(())
    }
}

impl Drop for GpuImporter {
    fn drop(&mut self) {
        if self.make_current().is_ok() {
            if let Some(gl) = &self.gl {
                unsafe {
                    if let Some(framebuffer) = self.framebuffer.take() {
                        gl.delete_framebuffer(framebuffer);
                    }
                    if let Some(texture) = self.texture.take() {
                        gl.delete_texture(texture);
                    }
                }
            }
            self.release();
        }
        let _ = self.egl.destroy_context(self.display, self.context);
    }
}

/// The kernel driver bound to a DRM node, from sysfs.
fn render_node_driver(node: &str) -> Option<String> {
    let name = std::path::Path::new(node).file_name()?;
    let link = std::fs::read_link(
        std::path::Path::new("/sys/class/drm")
            .join(name)
            .join("device/driver"),
    )
    .ok()?;
    Some(link.file_name()?.to_string_lossy().into_owned())
}

/// Whether an EGL device can be initialized at all. vgem and vkms have no
/// GPU behind them, and Mesa lists NVIDIA's nodes but only NVIDIA's own EGL
/// (the one with `EGL_NV_device_cuda`) drives them.
fn drivable(driver: Option<&str>, extensions: &str) -> bool {
    match driver {
        Some("vgem" | "vkms") => false,
        Some(driver) if driver.starts_with("nvidia") => extensions
            .split_ascii_whitespace()
            .any(|extension| extension == "EGL_NV_device_cuda"),
        _ => true,
    }
}

/// The driver that exported a DMA-BUF (`exp_name` in its fdinfo).
fn dma_buf_exporter(fd: RawFd) -> Option<String> {
    let info = std::fs::read_to_string(format!("/proc/self/fdinfo/{fd}")).ok()?;
    info.lines()
        .find_map(|line| line.strip_prefix("exp_name:"))
        .map(|name| name.trim().to_string())
}

/// GPUs to try a frame on: those whose driver exported it, then the rest,
/// each starting from the GPU that read the last frame.
fn import_order(drivers: &[Option<&str>], exporter: Option<&str>, last: usize) -> Vec<usize> {
    let count = drivers.len();
    let rotated = (0..count).map(|step| (last + step) % count);
    let exported_by = |gpu: usize| {
        matches!((drivers[gpu], exporter), (Some(driver), Some(exporter))
            if exporter.starts_with(driver) || driver.starts_with(exporter))
    };
    let (mut order, rest): (Vec<_>, Vec<_>) = rotated.partition(|&gpu| exported_by(gpu));
    order.extend(rest);
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_without_a_driver_for_them_are_not_opened() {
        assert!(!drivable(Some("vgem"), "EGL_EXT_device_drm"));
        assert!(!drivable(Some("vkms"), ""));
        assert!(!drivable(
            Some("nvidia"),
            "EGL_EXT_device_drm EGL_EXT_device_drm_render_node"
        ));
        assert!(drivable(
            Some("nvidia"),
            "EGL_NV_device_cuda EGL_EXT_device_drm"
        ));
        assert!(drivable(Some("amdgpu"), "EGL_EXT_device_drm"));
        assert!(drivable(None, ""));
    }

    #[test]
    fn the_gpu_that_read_the_last_recording_is_tried_first() {
        let nodes = [
            Some("/dev/dri/renderD128"),
            Some("/dev/dri/renderD129"),
            Some("/dev/dri/renderD131"),
        ];
        assert_eq!(remembered_gpu(&nodes, Some("/dev/dri/renderD131")), 2);
        assert_eq!(remembered_gpu(&nodes, None), 0);
        // A GPU that has gone since (unplugged, driver reloaded) is ignored.
        assert_eq!(remembered_gpu(&nodes, Some("/dev/dri/renderD130")), 0);
    }

    #[test]
    fn a_frame_goes_first_to_the_gpu_whose_driver_exported_it() {
        // An Intel and NVIDIA laptop: niri renders on NVIDIA, EGL lists Intel first.
        let drivers = [Some("i915"), Some("nvidia")];
        assert_eq!(import_order(&drivers, Some("nvidia-drm"), 0), vec![1, 0]);
        assert_eq!(import_order(&drivers, Some("i915"), 1), vec![0, 1]);
        // Unknown exporter: the GPU that read the last frame first.
        assert_eq!(import_order(&drivers, None, 1), vec![1, 0]);
        // Several GPUs of one vendor keep the last one first among them.
        let same = [Some("nvidia"), Some("nvidia"), Some("nvidia")];
        assert_eq!(import_order(&same, Some("nvidia-drm"), 2), vec![2, 0, 1]);
        assert!(import_order(&[], None, 0).is_empty());
    }
}
