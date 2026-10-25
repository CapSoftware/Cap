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

pub(super) struct DmaBufImporter {
    egl: egl::DynamicInstance<egl::EGL1_5>,
    display: egl::Display,
    context: egl::Context,
    gl: Option<glow::Context>,
    image_target_texture: ImageTargetTexture,
    query_modifiers: QueryDmaBufModifiers,
    framebuffer: Option<glow::Framebuffer>,
    texture: Option<glow::Texture>,
}

// The EGL context is made current on whichever single thread uses the
// importer, and released before it moves.
unsafe impl Send for DmaBufImporter {}

impl DmaBufImporter {
    pub(super) fn new() -> anyhow::Result<Self> {
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
        // A GPU (one with a render node) can import what a GPU allocated.
        let devices = &devices[..count.max(0) as usize];
        let device = devices
            .iter()
            .copied()
            .find(|device| {
                !unsafe { query_device_string(*device, EGL_DRM_RENDER_NODE_FILE_EXT) }.is_null()
            })
            .or_else(|| devices.first().copied())
            .ok_or_else(|| anyhow!("EGL lists no devices"))?;
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
        };
        importer.make_current()?;
        importer.release();
        Ok(importer)
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

impl Drop for DmaBufImporter {
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
