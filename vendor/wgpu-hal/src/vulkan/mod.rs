/*!
# Vulkan API internals.

## Stack memory

Ash expects slices, which we don't generally have available.
We cope with this requirement by the combination of the following ways:
  - temporarily allocating `Vec` on heap, where overhead is permitted
  - growing temporary local storage

## Framebuffers and Render passes

Render passes are cached on the device and kept forever.

Framebuffers are also cached on the device, but they are removed when
any of the image views (they have) gets removed.
If Vulkan supports image-less framebuffers,
then the actual views are excluded from the framebuffer key.

## Fences

If timeline semaphores are available, they are used 1:1 with wgpu-hal fences.
Otherwise, we manage a pool of `VkFence` objects behind each `hal::Fence`.

!*/

#![allow(clippy::std_instead_of_alloc, clippy::std_instead_of_core)]

mod adapter;
mod command;
mod conv;
mod device;
mod drm;
mod instance;
mod sampler;

use std::{
    borrow::Borrow,
    boxed::Box,
    ffi::{CStr, CString},
    fmt, mem,
    num::NonZeroU32,
    ops::DerefMut,
    sync::Arc,
    vec::Vec,
};

use arrayvec::ArrayVec;
use ash::{ext, khr, vk};
use bytemuck::{Pod, Zeroable};
use hashbrown::HashSet;
use parking_lot::{Mutex, RwLock};

use naga::FastHashMap;
use wgt::InternalCounter;

const MILLIS_TO_NANOS: u64 = 1_000_000;
const MAX_TOTAL_ATTACHMENTS: usize = crate::MAX_COLOR_ATTACHMENTS * 2 + 1;

#[derive(Clone, Debug)]
pub struct Api;

impl crate::Api for Api {
    type Instance = Instance;
    type Surface = Surface;
    type Adapter = Adapter;
    type Device = Device;

    type Queue = Queue;
    type CommandEncoder = CommandEncoder;
    type CommandBuffer = CommandBuffer;

    type Buffer = Buffer;
    type Texture = Texture;
    type SurfaceTexture = SurfaceTexture;
    type TextureView = TextureView;
    type Sampler = Sampler;
    type QuerySet = QuerySet;
    type Fence = Fence;
    type AccelerationStructure = AccelerationStructure;
    type PipelineCache = PipelineCache;

    type BindGroupLayout = BindGroupLayout;
    type BindGroup = BindGroup;
    type PipelineLayout = PipelineLayout;
    type ShaderModule = ShaderModule;
    type RenderPipeline = RenderPipeline;
    type ComputePipeline = ComputePipeline;
}

crate::impl_dyn_resource!(
    Adapter,
    AccelerationStructure,
    BindGroup,
    BindGroupLayout,
    Buffer,
    CommandBuffer,
    CommandEncoder,
    ComputePipeline,
    Device,
    Fence,
    Instance,
    PipelineCache,
    PipelineLayout,
    QuerySet,
    Queue,
    RenderPipeline,
    Sampler,
    ShaderModule,
    Surface,
    SurfaceTexture,
    Texture,
    TextureView
);

struct DebugUtils {
    extension: ext::debug_utils::Instance,
    messenger: vk::DebugUtilsMessengerEXT,

    /// Owning pointer to the debug messenger callback user data.
    ///
    /// `InstanceShared::drop` destroys the debug messenger before
    /// dropping this, so the callback should never receive a dangling
    /// user data pointer.
    #[allow(dead_code)]
    callback_data: Box<DebugUtilsMessengerUserData>,
}

pub struct DebugUtilsCreateInfo {
    severity: vk::DebugUtilsMessageSeverityFlagsEXT,
    message_type: vk::DebugUtilsMessageTypeFlagsEXT,
    callback_data: Box<DebugUtilsMessengerUserData>,
}

#[derive(Debug)]
/// The properties related to the validation layer needed for the
/// DebugUtilsMessenger for their workarounds
struct ValidationLayerProperties {
    /// Validation layer description, from `vk::LayerProperties`.
    layer_description: CString,

    /// Validation layer specification version, from `vk::LayerProperties`.
    layer_spec_version: u32,
}

/// User data needed by `instance::debug_utils_messenger_callback`.
///
/// When we create the [`vk::DebugUtilsMessengerEXT`], the `pUserData`
/// pointer refers to one of these values.
#[derive(Debug)]
pub struct DebugUtilsMessengerUserData {
    /// The properties related to the validation layer, if present
    validation_layer_properties: Option<ValidationLayerProperties>,

    /// If the OBS layer is present. OBS never increments the version of their layer,
    /// so there's no reason to have the version.
    has_obs_layer: bool,
}

pub struct InstanceShared {
    raw: ash::Instance,
    extensions: Vec<&'static CStr>,
    drop_guard: Option<crate::DropGuard>,
    flags: wgt::InstanceFlags,
    debug_utils: Option<DebugUtils>,
    get_physical_device_properties: Option<khr::get_physical_device_properties2::Instance>,
    entry: ash::Entry,
    has_nv_optimus: bool,
    android_sdk_version: u32,
    /// The instance API version.
    ///
    /// Which is the version of Vulkan supported for instance-level functionality.
    ///
    /// It is associated with a `VkInstance` and its children,
    /// except for a `VkPhysicalDevice` and its children.
    instance_api_version: u32,
}

pub struct Instance {
    shared: Arc<InstanceShared>,
}

/// The semaphores needed to use one image in a swapchain.
#[derive(Debug)]
struct SwapchainImageSemaphores {
    /// A semaphore that is signaled when this image is safe for us to modify.
    ///
    /// When [`vkAcquireNextImageKHR`] returns the index of the next swapchain
    /// image that we should use, that image may actually still be in use by the
    /// presentation engine, and is not yet safe to modify. However, that
    /// function does accept a semaphore that it will signal when the image is
    /// indeed safe to begin messing with.
    ///
    /// This semaphore is:
    ///
    /// - waited for by the first queue submission to operate on this image
    ///   since it was acquired, and
    ///
    /// - signaled by [`vkAcquireNextImageKHR`] when the acquired image is ready
    ///   for us to use.
    ///
    /// [`vkAcquireNextImageKHR`]: https://registry.khronos.org/vulkan/specs/1.3-extensions/html/vkspec.html#vkAcquireNextImageKHR
    acquire: vk::Semaphore,

    /// True if the next command submission operating on this image should wait
    /// for [`acquire`].
    ///
    /// We must wait for `acquire` before drawing to this swapchain image, but
    /// because `wgpu-hal` queue submissions are always strongly ordered, only
    /// the first submission that works with a swapchain image actually needs to
    /// wait. We set this flag when this image is acquired, and clear it the
    /// first time it's passed to [`Queue::submit`] as a surface texture.
    ///
    /// [`acquire`]: SwapchainImageSemaphores::acquire
    /// [`Queue::submit`]: crate::Queue::submit
    should_wait_for_acquire: bool,

    /// A pool of semaphores for ordering presentation after drawing.
    ///
    /// The first [`present_index`] semaphores in this vector are:
    ///
    /// - all waited on by the call to [`vkQueuePresentKHR`] that presents this
    ///   image, and
    ///
    /// - each signaled by some [`vkQueueSubmit`] queue submission that draws to
    ///   this image, when the submission finishes execution.
    ///
    /// This vector accumulates one semaphore per submission that writes to this
    /// image. This is awkward, but hard to avoid: [`vkQueuePresentKHR`]
    /// requires a semaphore to order it with respect to drawing commands, and
    /// we can't attach new completion semaphores to a command submission after
    /// it's been submitted. This means that, at submission time, we must create
    /// the semaphore we might need if the caller's next action is to enqueue a
    /// presentation of this image.
    ///
    /// An alternative strategy would be for presentation to enqueue an empty
    /// submit, ordered relative to other submits in the usual way, and
    /// signaling a single presentation semaphore. But we suspect that submits
    /// are usually expensive enough, and semaphores usually cheap enough, that
    /// performance-sensitive users will avoid making many submits, so that the
    /// cost of accumulated semaphores will usually be less than the cost of an
    /// additional submit.
    ///
    /// Only the first [`present_index`] semaphores in the vector are actually
    /// going to be signalled by submitted commands, and need to be waited for
    /// by the next present call. Any semaphores beyond that index were created
    /// for prior presents and are simply being retained for recycling.
    ///
    /// [`present_index`]: SwapchainImageSemaphores::present_index
    /// [`vkQueuePresentKHR`]: https://registry.khronos.org/vulkan/specs/1.3-extensions/html/vkspec.html#vkQueuePresentKHR
    /// [`vkQueueSubmit`]: https://registry.khronos.org/vulkan/specs/1.3-extensions/html/vkspec.html#vkQueueSubmit
    present: Vec<vk::Semaphore>,

    /// The number of semaphores in [`present`] to be signalled for this submission.
    ///
    /// [`present`]: SwapchainImageSemaphores::present
    present_index: usize,

    /// The fence value of the last command submission that wrote to this image.
    ///
    /// The next time we try to acquire this image, we'll block until
    /// this submission finishes, proving that [`acquire`] is ready to
    /// pass to `vkAcquireNextImageKHR` again.
    ///
    /// [`acquire`]: SwapchainImageSemaphores::acquire
    previously_used_submission_index: crate::FenceValue,
}

impl SwapchainImageSemaphores {
    fn new(device: &DeviceShared) -> Result<Self, crate::DeviceError> {
        Ok(Self {
            acquire: device.new_binary_semaphore()?,
            should_wait_for_acquire: true,
            present: Vec::new(),
            present_index: 0,
            previously_used_submission_index: 0,
        })
    }

    fn set_used_fence_value(&mut self, value: crate::FenceValue) {
        self.previously_used_submission_index = value;
    }

    /// Return the semaphore that commands drawing to this image should wait for, if any.
    ///
    /// This only returns `Some` once per acquisition; see
    /// [`SwapchainImageSemaphores::should_wait_for_acquire`] for details.
    fn get_acquire_wait_semaphore(&mut self) -> Option<vk::Semaphore> {
        if self.should_wait_for_acquire {
            self.should_wait_for_acquire = false;
            Some(self.acquire)
        } else {
            None
        }
    }

    /// Return a semaphore that a submission that writes to this image should
    /// signal when it's done.
    ///
    /// See [`SwapchainImageSemaphores::present`] for details.
    fn get_submit_signal_semaphore(
        &mut self,
        device: &DeviceShared,
    ) -> Result<vk::Semaphore, crate::DeviceError> {
        // Try to recycle a semaphore we created for a previous presentation.
        let sem = match self.present.get(self.present_index) {
            Some(sem) => *sem,
            None => {
                let sem = device.new_binary_semaphore()?;
                self.present.push(sem);
                sem
            }
        };

        self.present_index += 1;

        Ok(sem)
    }

    /// Return the semaphores that a presentation of this image should wait on.
    ///
    /// Return a slice of semaphores that the call to [`vkQueueSubmit`] that
    /// ends this image's acquisition should wait for. See
    /// [`SwapchainImageSemaphores::present`] for details.
    ///
    /// Reset `self` to be ready for the next acquisition cycle.
    ///
    /// [`vkQueueSubmit`]: https://registry.khronos.org/vulkan/specs/1.3-extensions/html/vkspec.html#vkQueueSubmit
    fn get_present_wait_semaphores(&mut self) -> &[vk::Semaphore] {
        let old_index = self.present_index;

        // Since this marks the end of this acquire/draw/present cycle, take the
        // opportunity to reset `self` in preparation for the next acquisition.
        self.present_index = 0;
        self.should_wait_for_acquire = true;

        &self.present[0..old_index]
    }

    unsafe fn destroy(&self, device: &ash::Device) {
        unsafe {
            device.destroy_semaphore(self.acquire, None);
            for sem in &self.present {
                device.destroy_semaphore(*sem, None);
            }
        }
    }
}

struct Swapchain {
    raw: vk::SwapchainKHR,
    raw_flags: vk::SwapchainCreateFlagsKHR,
    functor: khr::swapchain::Device,
    device: Arc<DeviceShared>,
    images: Vec<vk::Image>,
    config: crate::SurfaceConfiguration,
    view_formats: Vec<wgt::TextureFormat>,
    /// One wait semaphore per swapchain image. This will be associated with the
    /// surface texture, and later collected during submission.
    ///
    /// We need this to be `Arc<Mutex<>>` because we need to be able to pass this
    /// data into the surface texture, so submit/present can use it.
    surface_semaphores: Vec<Arc<Mutex<SwapchainImageSemaphores>>>,
    /// The index of the next semaphore to use. Ideally we would use the same
    /// index as the image index, but we need to specify the semaphore as an argument
    /// to the acquire_next_image function which is what tells us which image to use.
    next_semaphore_index: usize,
    /// The present timing information which will be set in the next call to [`present()`](crate::Queue::present()).
    ///
    /// # Safety
    ///
    /// This must only be set if [`wgt::Features::VULKAN_GOOGLE_DISPLAY_TIMING`] is enabled, and
    /// so the VK_GOOGLE_display_timing extension is present.
    next_present_time: Option<vk::PresentTimeGOOGLE>,
}

impl Swapchain {
    fn advance_surface_semaphores(&mut self) {
        let semaphore_count = self.surface_semaphores.len();
        self.next_semaphore_index = (self.next_semaphore_index + 1) % semaphore_count;
    }

    fn get_surface_semaphores(&self) -> Arc<Mutex<SwapchainImageSemaphores>> {
        self.surface_semaphores[self.next_semaphore_index].clone()
    }
}

pub struct Surface {
    raw: vk::SurfaceKHR,
    functor: khr::surface::Instance,
    instance: Arc<InstanceShared>,
    swapchain: RwLock<Option<Swapchain>>,
}

impl Surface {
    /// Get the raw Vulkan swapchain associated with this surface.
    ///
    /// Returns [`None`] if the surface is not configured.
    pub fn raw_swapchain(&self) -> Option<vk::SwapchainKHR> {
        let read = self.swapchain.read();
        read.as_ref().map(|it| it.raw)
    }

    /// Set the present timing information which will be used for the next [presentation](crate::Queue::present()) of this surface,
    /// using [VK_GOOGLE_display_timing].
    ///
    /// This can be used to give an id to presentations, for future use of [`vk::PastPresentationTimingGOOGLE`].
    /// Note that `wgpu-hal` does *not* provide a way to use that API - you should manually access this through [`ash`].
    ///
    /// This can also be used to add a "not before" timestamp to the presentation.
    ///
    /// The exact semantics of the fields are also documented in the [specification](https://registry.khronos.org/vulkan/specs/1.3-extensions/man/html/VkPresentTimeGOOGLE.html) for the extension.
    ///
    /// # Panics
    ///
    /// - If the surface hasn't been configured.
    /// - If the device doesn't [support present timing](wgt::Features::VULKAN_GOOGLE_DISPLAY_TIMING).
    ///
    /// [VK_GOOGLE_display_timing]: https://registry.khronos.org/vulkan/specs/1.3-extensions/man/html/VK_GOOGLE_display_timing.html
    #[track_caller]
    pub fn set_next_present_time(&self, present_timing: vk::PresentTimeGOOGLE) {
        let mut swapchain = self.swapchain.write();
        let swapchain = swapchain
            .as_mut()
            .expect("Surface should have been configured");
        let features = wgt::Features::VULKAN_GOOGLE_DISPLAY_TIMING;
        if swapchain.device.features.contains(features) {
            swapchain.next_present_time = Some(present_timing);
        } else {
            // Ideally we'd use something like `device.required_features` here, but that's in `wgpu-core`, which we are a dependency of
            panic!(
                concat!(
                    "Tried to set display timing properties ",
                    "without the corresponding feature ({:?}) enabled."
                ),
                features
            );
        }
    }
}

#[derive(Debug)]
pub struct SurfaceTexture {
    index: u32,
    texture: Texture,
    surface_semaphores: Arc<Mutex<SwapchainImageSemaphores>>,
}

impl crate::DynSurfaceTexture for SurfaceTexture {}

impl Borrow<Texture> for SurfaceTexture {
    fn borrow(&self) -> &Texture {
        &self.texture
    }
}

impl Borrow<dyn crate::DynTexture> for SurfaceTexture {
    fn borrow(&self) -> &dyn crate::DynTexture {
        &self.texture
    }
}

pub struct Adapter {
    raw: vk::PhysicalDevice,
    instance: Arc<InstanceShared>,
    //queue_families: Vec<vk::QueueFamilyProperties>,
    known_memory_flags: vk::MemoryPropertyFlags,
    phd_capabilities: adapter::PhysicalDeviceProperties,
    phd_features: adapter::PhysicalDeviceFeatures,
    downlevel_flags: wgt::DownlevelFlags,
    private_caps: PrivateCapabilities,
    workarounds: Workarounds,
}

// TODO there's no reason why this can't be unified--the function pointers should all be the same--it's not clear how to do this with `ash`.
enum ExtensionFn<T> {
    /// The loaded function pointer struct for an extension.
    Extension(T),
    /// The extension was promoted to a core version of Vulkan and the functions on `ash`'s `DeviceV1_x` traits should be used.
    Promoted,
}

struct DeviceExtensionFunctions {
    debug_utils: Option<ext::debug_utils::Device>,
    draw_indirect_count: Option<khr::draw_indirect_count::Device>,
    timeline_semaphore: Option<ExtensionFn<khr::timeline_semaphore::Device>>,
    ray_tracing: Option<RayTracingDeviceExtensionFunctions>,
    mesh_shading: Option<ext::mesh_shader::Device>,
}

struct RayTracingDeviceExtensionFunctions {
    acceleration_structure: khr::acceleration_structure::Device,
    buffer_device_address: khr::buffer_device_address::Device,
}

/// Set of internal capabilities, which don't show up in the exposed
/// device geometry, but affect the code paths taken internally.
#[derive(Clone, Debug)]
struct PrivateCapabilities {
    /// Y-flipping is implemented with either `VK_AMD_negative_viewport_height` or `VK_KHR_maintenance1`/1.1+. The AMD extension for negative viewport height does not require a Y shift.
    ///
    /// This flag is `true` if the device has `VK_KHR_maintenance1`/1.1+ and `false` otherwise (i.e. in the case of `VK_AMD_negative_viewport_height`).
    flip_y_requires_shift: bool,
    imageless_framebuffers: bool,
    image_view_usage: bool,
    timeline_semaphores: bool,
    texture_d24: bool,
    texture_d24_s8: bool,
    texture_s8: bool,
    /// Ability to present contents to any screen. Only needed to work around broken platform configurations.
    can_present: bool,
    non_coherent_map_mask: wgt::BufferAddress,

    /// True if this adapter advertises the [`robustBufferAccess`][vrba] feature.
    ///
    /// Note that Vulkan's `robustBufferAccess` is not sufficient to implement
    /// `wgpu_hal`'s guarantee that shaders will not access buffer contents via
    /// a given bindgroup binding outside that binding's [accessible
    /// region][ar]. Enabling `robustBufferAccess` does ensure that
    /// out-of-bounds reads and writes are not undefined behavior (that's good),
    /// but still permits out-of-bounds reads to return data from anywhere
    /// within the buffer, not just the accessible region.
    ///
    /// [ar]: ../struct.BufferBinding.html#accessible-region
    /// [vrba]: https://registry.khronos.org/vulkan/specs/1.3-extensions/html/vkspec.html#features-robustBufferAccess
    robust_buffer_access: bool,

    robust_image_access: bool,

    /// True if this adapter supports the [`VK_EXT_robustness2`] extension's
    /// [`robustBufferAccess2`] feature.
    ///
    /// This is sufficient to implement `wgpu_hal`'s [required bounds-checking][ar] of
    /// shader accesses to buffer contents. If this feature is not available,
    /// this backend must have Naga inject bounds checks in the generated
    /// SPIR-V.
    ///
    /// [`VK_EXT_robustness2`]: https://registry.khronos.org/vulkan/specs/1.3-extensions/man/html/VK_EXT_robustness2.html
    /// [`robustBufferAccess2`]: https://registry.khronos.org/vulkan/specs/1.3-extensions/man/html/VkPhysicalDeviceRobustness2FeaturesEXT.html#features-robustBufferAccess2
    /// [ar]: ../struct.BufferBinding.html#accessible-region
    robust_buffer_access2: bool,

    robust_image_access2: bool,
    zero_initialize_workgroup_memory: bool,
    image_format_list: bool,
    maximum_samplers: u32,
}

bitflags::bitflags!(
    /// Workaround flags.
    #[derive(Debug, Copy, Clone, PartialEq, Eq, Hash)]
    pub struct Workarounds: u32 {
        /// Only generate SPIR-V for one entry point at a time.
        const SEPARATE_ENTRY_POINTS = 0x1;
        /// Qualcomm OOMs when there are zero color attachments but a non-null pointer
        /// to a subpass resolve attachment array. This nulls out that pointer in that case.
        const EMPTY_RESOLVE_ATTACHMENT_LISTS = 0x2;
        /// If the following code returns false, then nvidia will end up filling the wrong range.
        ///
        /// ```skip
        /// fn nvidia_succeeds() -> bool {
        ///   # let (copy_length, start_offset) = (0, 0);
        ///     if copy_length >= 4096 {
        ///         if start_offset % 16 != 0 {
        ///             if copy_length == 4096 {
        ///                 return true;
        ///             }
        ///             if copy_length % 16 == 0 {
        ///                 return false;
        ///             }
        ///         }
        ///     }
        ///     true
        /// }
        /// ```
        ///
        /// As such, we need to make sure all calls to vkCmdFillBuffer are aligned to 16 bytes
        /// if they cover a range of 4096 bytes or more.
        const FORCE_FILL_BUFFER_WITH_SIZE_GREATER_4096_ALIGNED_OFFSET_16 = 0x4;
    }
);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct AttachmentKey {
    format: vk::Format,
    layout: vk::ImageLayout,
    ops: crate::AttachmentOps,
}

impl AttachmentKey {
    /// Returns an attachment key for a compatible attachment.
    fn compatible(format: vk::Format, layout: vk::ImageLayout) -> Self {
        Self {
            format,
            layout,
            ops: crate::AttachmentOps::all(),
        }
    }
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct ColorAttachmentKey {
    base: AttachmentKey,
    resolve: Option<AttachmentKey>,
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct DepthStencilAttachmentKey {
    base: AttachmentKey,
    stencil_ops: crate::AttachmentOps,
}

#[derive(Clone, Eq, Default, Hash, PartialEq)]
struct RenderPassKey {
    colors: ArrayVec<Option<ColorAttachmentKey>, { crate::MAX_COLOR_ATTACHMENTS }>,
    depth_stencil: Option<DepthStencilAttachmentKey>,
    sample_count: u32,
    multiview: Option<NonZeroU32>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct FramebufferAttachment {
    /// Can be NULL if the framebuffer is image-less
    raw: vk::ImageView,
    raw_image_flags: vk::ImageCreateFlags,
    view_usage: wgt::TextureUses,
    view_format: wgt::TextureFormat,
    raw_view_formats: Vec<vk::Format>,
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct FramebufferKey {
    attachments: ArrayVec<FramebufferAttachment, { MAX_TOTAL_ATTACHMENTS }>,
    extent: wgt::Extent3d,
    sample_count: u32,
}

struct DeviceShared {
    raw: ash::Device,
    family_index: u32,
    queue_index: u32,
    raw_queue: vk::Queue,
    drop_guard: Option<crate::DropGuard>,
    instance: Arc<InstanceShared>,
    physical_device: vk::PhysicalDevice,
    enabled_extensions: Vec<&'static CStr>,
    extension_fns: DeviceExtensionFunctions,
    vendor_id: u32,
    pipeline_cache_validation_key: [u8; 16],
    timestamp_period: f32,
    private_caps: PrivateCapabilities,
    workarounds: Workarounds,
    features: wgt::Features,
    render_passes: Mutex<FastHashMap<RenderPassKey, vk::RenderPass>>,
    framebuffers: Mutex<FastHashMap<FramebufferKey, vk::Framebuffer>>,
    sampler_cache: Mutex<sampler::SamplerCache>,
    memory_allocations_counter: InternalCounter,
}

impl Drop for DeviceShared {
    fn drop(&mut self) {
        for &raw in self.render_passes.lock().values() {
            unsafe { self.raw.destroy_render_pass(raw, None) };
        }
        for &raw in self.framebuffers.lock().values() {
            unsafe { self.raw.destroy_framebuffer(raw, None) };
        }
        if self.drop_guard.is_none() {
            unsafe { self.raw.destroy_device(None) };
        }
    }
}

pub struct Device {
    shared: Arc<DeviceShared>,
    mem_allocator: Mutex<gpu_alloc::GpuAllocator<vk::DeviceMemory>>,
    desc_allocator:
        Mutex<gpu_descriptor::DescriptorAllocator<vk::DescriptorPool, vk::DescriptorSet>>,
    valid_ash_memory_types: u32,
    naga_options: naga::back::spv::Options<'static>,
    #[cfg(feature = "renderdoc")]
    render_doc: crate::auxil::renderdoc::RenderDoc,
    counters: Arc<wgt::HalCounters>,
}

impl Drop for Device {
    fn drop(&mut self) {
        unsafe { self.mem_allocator.lock().cleanup(&*self.shared) };
        unsafe { self.desc_allocator.lock().cleanup(&*self.shared) };
    }
}

/// Semaphores for forcing queue submissions to run in order.
///
/// The [`wgpu_hal::Queue`] trait promises that if two calls to [`submit`] are
/// ordered, then the first submission will finish on the GPU before the second
/// submission begins. To get this behavior on Vulkan we need to pass semaphores
/// to [`vkQueueSubmit`] for the commands to wait on before beginning execution,
/// and to signal when their execution is done.
///
/// Normally this can be done with a single semaphore, waited on and then
/// signalled for each submission. At any given time there's exactly one
/// submission that would signal the semaphore, and exactly one waiting on it,
/// as Vulkan requires.
///
/// However, as of Oct 2021, bug [#5508] in the Mesa ANV drivers caused them to
/// hang if we use a single semaphore. The workaround is to alternate between
/// two semaphores. The bug has been fixed in Mesa, but we should probably keep
/// the workaround until, say, Oct 2026.
///
/// [`wgpu_hal::Queue`]: crate::Queue
/// [`submit`]: crate::Queue::submit
/// [`vkQueueSubmit`]: https://registry.khronos.org/vulkan/specs/1.3-extensions/html/vkspec.html#vkQueueSubmit
/// [#5508]: https://gitlab.freedesktop.org/mesa/mesa/-/issues/5508
#[derive(Clone)]
struct RelaySemaphores {
    /// The semaphore the next submission should wait on before beginning
    /// execution on the GPU. This is `None` for the first submission, which
    /// should not wait on anything at all.
    wait: Option<vk::Semaphore>,

    /// The semaphore the next submission should signal when it has finished
    /// execution on the GPU.
    signal: vk::Semaphore,
}

impl RelaySemaphores {
    fn new(device: &DeviceShared) -> Result<Self, crate::DeviceError> {
        Ok(Self {
            wait: None,
            signal: device.new_binary_semaphore()?,
        })
    }

    /// Advances the semaphores, returning the semaphores that should be used for a submission.
    fn advance(&mut self, device: &DeviceShared) -> Result<Self, crate::DeviceError> {
        let old = self.clone();

        // Build the state for the next submission.
        match self.wait {
            None => {
                // The `old` values describe the first submission to this queue.
                // The second submission should wait on `old.signal`, and then
                // signal a new semaphore which we'll create now.
                self.wait = Some(old.signal);
                self.signal = device.new_binary_semaphore()?;
            }
            Some(ref mut wait) => {
                // What this submission signals, the next should wait.
                mem::swap(wait, &mut self.signal);
            }
        };

        Ok(old)
    }

    /// Destroys the semaphores.
    unsafe fn destroy(&self, device: &ash::Device) {
        unsafe {
            if let Some(wait) = self.wait {
                device.destroy_semaphore(wait, None);
            }
            device.destroy_semaphore(self.signal, None);
        }
    }
}

pub struct Queue {
    raw: vk::Queue,
    swapchain_fn: khr::swapchain::Device,
    device: Arc<DeviceShared>,
    family_index: u32,
    relay_semaphores: Mutex<RelaySemaphores>,
    signal_semaphores: Mutex<(Vec<vk::Semaphore>, Vec<u64>)>,
}

impl Queue {
    pub fn as_raw(&self) -> vk::Queue {
        self.raw
    }
}

impl Drop for Queue {
    fn drop(&mut self) {
        unsafe { self.relay_semaphores.lock().destroy(&self.device.raw) };
    }
}

#[derive(Debug)]
pub struct Buffer {
    raw: vk::Buffer,
    block: Option<Mutex<gpu_alloc::MemoryBlock<vk::DeviceMemory>>>,
}

impl crate::DynBuffer for Buffer {}

#[derive(Debug)]
pub struct AccelerationStructure {
    raw: vk::AccelerationStructureKHR,
    buffer: vk::Buffer,
    block: Mutex<gpu_alloc::MemoryBlock<vk::DeviceMemory>>,
    compacted_size_query: Option<vk::QueryPool>,
}

impl crate::DynAccelerationStructure for AccelerationStructure {}

#[derive(Debug)]
pub struct Texture {
    raw: vk::Image,
    drop_guard: Option<crate::DropGuard>,
    external_memory: Option<vk::DeviceMemory>,
    block: Option<gpu_alloc::MemoryBlock<vk::DeviceMemory>>,
    usage: wgt::TextureUses,
    format: wgt::TextureFormat,
    raw_flags: vk::ImageCreateFlags,
    copy_size: crate::CopyExtent,
    view_formats: Vec<wgt::TextureFormat>,
}

impl crate::DynTexture for Texture {}

impl Texture {
    /// # Safety
    ///
    /// - The image handle must not be manually destroyed
    pub unsafe fn raw_handle(&self) -> vk::Image {
        self.raw
    }
}

#[derive(Debug)]
pub struct TextureView {
    raw: vk::ImageView,
    layers: NonZeroU32,
    attachment: FramebufferAttachment,
}

impl crate::DynTextureView for TextureView {}

impl TextureView {
    /// # Safety
    ///
    /// - The image view handle must not be manually destroyed
    pub unsafe fn raw_handle(&self) -> vk::ImageView {
        self.raw
    }
}

#[derive(Debug)]
pub struct Sampler {
    raw: vk::Sampler,
    create_info: vk::SamplerCreateInfo<'static>,
}

impl crate::DynSampler for Sampler {}

#[derive(Debug)]
pub struct BindGroupLayout {
    raw: vk::DescriptorSetLayout,
    desc_count: gpu_descriptor::DescriptorTotalCount,
    types: Box<[(vk::DescriptorType, u32)]>,
    /// Map of binding index to size,
    binding_arrays: Vec<(u32, NonZeroU32)>,
}

impl crate::DynBindGroupLayout for BindGroupLayout {}

#[derive(Debug)]
pub struct PipelineLayout {
    raw: vk::PipelineLayout,
    binding_arrays: naga::back::spv::BindingMap,
}

impl crate::DynPipelineLayout for PipelineLayout {}

#[derive(Debug)]
pub struct BindGroup {
    set: gpu_descriptor::DescriptorSet<vk::DescriptorSet>,
}

impl crate::DynBindGroup for BindGroup {}

/// Miscellaneous allocation recycling pool for `CommandAllocator`.
#[derive(Default)]
struct Temp {
    marker: Vec<u8>,
    buffer_barriers: Vec<vk::BufferMemoryBarrier<'static>>,
    image_barriers: Vec<vk::ImageMemoryBarrier<'static>>,
}

impl Temp {
    fn clear(&mut self) {
        self.marker.clear();
        self.buffer_barriers.clear();
        self.image_barriers.clear();
    }

    fn make_c_str(&mut self, name: &str) -> &CStr {
        self.marker.clear();
        self.marker.extend_from_slice(name.as_bytes());
        self.marker.push(0);
        unsafe { CStr::from_bytes_with_nul_unchecked(&self.marker) }
    }
}

pub struct CommandEncoder {
    raw: vk::CommandPool,
    device: Arc<DeviceShared>,

    /// The current command buffer, if `self` is in the ["recording"]
    /// state.
    ///
    /// ["recording"]: crate::CommandEncoder
    ///
    /// If non-`null`, the buffer is in the Vulkan "recording" state.
    active: vk::CommandBuffer,

    /// What kind of pass we are currently within: compute or render.
    bind_point: vk::PipelineBindPoint,

    /// Allocation recycling pool for this encoder.
    temp: Temp,

    /// A pool of available command buffers.
    ///
    /// These are all in the Vulkan "initial" state.
    free: Vec<vk::CommandBuffer>,

    /// A pool of discarded command buffers.
    ///
    /// These could be in any Vulkan state except "pending".
    discarded: Vec<vk::CommandBuffer>,

    /// If this is true, the active renderpass enabled a debug span,
    /// and needs to be disabled on renderpass close.
    rpass_debug_marker_active: bool,

    /// If set, the end of the next render/compute pass will write a timestamp at
    /// the given pool & location.
    end_of_pass_timer_query: Option<(vk::QueryPool, u32)>,

    counters: Arc<wgt::HalCounters>,
}

impl Drop for CommandEncoder {
    fn drop(&mut self) {
        // SAFETY:
        //
        // VUID-vkDestroyCommandPool-commandPool-00041: wgpu_hal requires that a
        // `CommandBuffer` must live until its execution is complete, and that a
        // `CommandBuffer` must not outlive the `CommandEncoder` that built it.
        // Thus, we know that none of our `CommandBuffers` are in the "pending"
        // state.
        //
        // The other VUIDs are pretty obvious.
        unsafe {
            // `vkDestroyCommandPool` also frees any command buffers allocated
            // from that pool, so there's no need to explicitly call
            // `vkFreeCommandBuffers` on `cmd_encoder`'s `free` and `discarded`
            // fields.
            self.device.raw.destroy_command_pool(self.raw, None);
        }
        self.counters.command_encoders.sub(1);
    }
}

impl CommandEncoder {
    /// # Safety
    ///
    /// - The command buffer handle must not be manually destroyed
    pub unsafe fn raw_handle(&self) -> vk::CommandBuffer {
        self.active
    }
}

impl fmt::Debug for CommandEncoder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CommandEncoder")
            .field("raw", &self.raw)
            .finish()
    }
}

#[derive(Debug)]
pub struct CommandBuffer {
    raw: vk::CommandBuffer,
}

impl crate::DynCommandBuffer for CommandBuffer {}

#[derive(Debug)]
#[allow(clippy::large_enum_variant)]
pub enum ShaderModule {
    Raw(vk::ShaderModule),
    Intermediate {
        naga_shader: crate::NagaShader,
        runtime_checks: wgt::ShaderRuntimeChecks,
    },
}

impl crate::DynShaderModule for ShaderModule {}

#[derive(Debug)]
pub struct RenderPipeline {
    raw: vk::Pipeline,
}

impl crate::DynRenderPipeline for RenderPipeline {}

#[derive(Debug)]
pub struct ComputePipeline {
    raw: vk::Pipeline,
}

impl crate::DynComputePipeline for ComputePipeline {}

#[derive(Debug)]
pub struct PipelineCache {
    raw: vk::PipelineCache,
}

impl crate::DynPipelineCache for PipelineCache {}

#[derive(Debug)]
pub struct QuerySet {
    raw: vk::QueryPool,
}

impl crate::DynQuerySet for QuerySet {}

/// The [`Api::Fence`] type for [`vulkan::Api`].
///
/// This is an `enum` because there are two possible implementations of
/// `wgpu-hal` fences on Vulkan: Vulkan fences, which work on any version of
/// Vulkan, and Vulkan timeline semaphores, which are easier and cheaper but
/// require non-1.0 features.
///
/// [`Device::create_fence`] returns a [`TimelineSemaphore`] if
/// [`VK_KHR_timeline_semaphore`] is available and enabled, and a [`FencePool`]
/// otherwise.
///
/// [`Api::Fence`]: crate::Api::Fence
/// [`vulkan::Api`]: Api
/// [`Device::create_fence`]: crate::Device::create_fence
/// [`TimelineSemaphore`]: Fence::TimelineSemaphore
/// [`VK_KHR_timeline_semaphore`]: https://registry.khronos.org/vulkan/specs/1.3-extensions/html/vkspec.html#VK_KHR_timeline_semaphore
/// [`FencePool`]: Fence::FencePool
#[derive(Debug)]
pub enum Fence {
    /// A Vulkan [timeline semaphore].
    ///
    /// These are simpler to use than Vulkan fences, since timeline semaphores
    /// work exactly the way [`wpgu_hal::Api::Fence`] is specified to work.
    ///
    /// [timeline semaphore]: https://registry.khronos.org/vulkan/specs/1.3-extensions/html/vkspec.html#synchronization-semaphores
    /// [`wpgu_hal::Api::Fence`]: crate::Api::Fence
    TimelineSemaphore(vk::Semaphore),

    /// A collection of Vulkan [fence]s, each associated with a [`FenceValue`].
    ///
    /// The effective [`FenceValue`] of this variant is the greater of
    /// `last_completed` and the maximum value associated with a signalled fence
    /// in `active`.
    ///
    /// Fences are available in all versions of Vulkan, but since they only have
    /// two states, "signaled" and "unsignaled", we need to use a separate fence
    /// for each queue submission we might want to wait for, and remember which
    /// [`FenceValue`] each one represents.
    ///
    /// [fence]: https://registry.khronos.org/vulkan/specs/1.3-extensions/html/vkspec.html#synchronization-fences
    /// [`FenceValue`]: crate::FenceValue
    FencePool {
        last_completed: crate::FenceValue,
        /// The pending fence values have to be ascending.
        active: Vec<(crate::FenceValue, vk::Fence)>,
        free: Vec<vk::Fence>,
    },
}

impl crate::DynFence for Fence {}

impl Fence {
    /// Return the highest [`FenceValue`] among the signalled fences in `active`.
    ///
    /// As an optimization, assume that we already know that the fence has
    /// reached `last_completed`, and don't bother checking fences whose values
    /// are less than that: those fences remain in the `active` array only
    /// because we haven't called `maintain` yet to clean them up.
    ///
    /// [`FenceValue`]: crate::FenceValue
    fn check_active(
        device: &ash::Device,
        mut last_completed: crate::FenceValue,
        active: &[(crate::FenceValue, vk::Fence)],
    ) -> Result<crate::FenceValue, crate::DeviceError> {
        for &(value, raw) in active.iter() {
            unsafe {
                if value > last_completed
                    && device
                        .get_fence_status(raw)
                        .map_err(map_host_device_oom_and_lost_err)?
                {
                    last_completed = value;
                }
            }
        }
        Ok(last_completed)
    }

    /// Return the highest signalled [`FenceValue`] for `self`.
    ///
    /// [`FenceValue`]: crate::FenceValue
    fn get_latest(
        &self,
        device: &ash::Device,
        extension: Option<&ExtensionFn<khr::timeline_semaphore::Device>>,
    ) -> Result<crate::FenceValue, crate::DeviceError> {
        match *self {
            Self::TimelineSemaphore(raw) => unsafe {
                Ok(match *extension.unwrap() {
                    ExtensionFn::Extension(ref ext) => ext
                        .get_semaphore_counter_value(raw)
                        .map_err(map_host_device_oom_and_lost_err)?,
                    ExtensionFn::Promoted => device
                        .get_semaphore_counter_value(raw)
                        .map_err(map_host_device_oom_and_lost_err)?,
                })
            },
            Self::FencePool {
                last_completed,
                ref active,
                free: _,
            } => Self::check_active(device, last_completed, active),
        }
    }

    /// Trim the internal state of this [`Fence`].
    ///
    /// This function has no externally visible effect, but you should call it
    /// periodically to keep this fence's resource consumption under control.
    ///
    /// For fences using the [`FencePool`] implementation, this function
    /// recycles fences that have been signaled. If you don't call this,
    /// [`Queue::submit`] will just keep allocating a new Vulkan fence every
    /// time it's called.
    ///
    /// [`FencePool`]: Fence::FencePool
    /// [`Queue::submit`]: crate::Queue::submit
    fn maintain(&mut self, device: &ash::Device) -> Result<(), crate::DeviceError> {
        match *self {
            Self::TimelineSemaphore(_) => {}
            Self::FencePool {
                ref mut last_completed,
                ref mut active,
                ref mut free,
            } => {
                let latest = Self::check_active(device, *last_completed, active)?;
                let base_free = free.len();
                for &(value, raw) in active.iter() {
                    if value <= latest {
                        free.push(raw);
                    }
                }
                if free.len() != base_free {
                    active.retain(|&(value, _)| value > latest);
                    unsafe { device.reset_fences(&free[base_free..]) }
                        .map_err(map_device_oom_err)?
                }
                *last_completed = latest;
            }
        }
        Ok(())
    }
}

impl crate::Queue for Queue {
    type A = Api;

    unsafe fn submit(
        &self,
        command_buffers: &[&CommandBuffer],
        surface_textures: &[&SurfaceTexture],
        (signal_fence, signal_value): (&mut Fence, crate::FenceValue),
    ) -> Result<(), crate::DeviceError> {
        let mut fence_raw = vk::Fence::null();

        let mut wait_stage_masks = Vec::new();
        let mut wait_semaphores = Vec::new();
        let mut signal_semaphores = Vec::new();
        let mut signal_values = Vec::new();

        // Double check that the same swapchain image isn't being given to us multiple times,
        // as that will deadlock when we try to lock them all.
        debug_assert!(
            {
                let mut check = HashSet::with_capacity(surface_textures.len());
                // We compare the Arcs by pointer, as Eq isn't well defined for SurfaceSemaphores.
                for st in surface_textures {
                    check.insert(Arc::as_ptr(&st.surface_semaphores));
                }
                check.len() == surface_textures.len()
            },
            "More than one surface texture is being used from the same swapchain. This will cause a deadlock in release."
        );

        let locked_swapchain_semaphores = surface_textures
            .iter()
            .map(|st| {
                st.surface_semaphores
                    .try_lock()
                    .expect("Failed to lock surface semaphore.")
            })
            .collect::<Vec<_>>();

        for mut swapchain_semaphore in locked_swapchain_semaphores {
            swapchain_semaphore.set_used_fence_value(signal_value);

            // If we're the first submission to operate on this image, wait on
            // its acquire semaphore, to make sure the presentation engine is
            // done with it.
            if let Some(sem) = swapchain_semaphore.get_acquire_wait_semaphore() {
                wait_stage_masks.push(vk::PipelineStageFlags::TOP_OF_PIPE);
                wait_semaphores.push(sem);
            }

            // Get a semaphore to signal when we're done writing to this surface
            // image. Presentation of this image will wait for this.
            let signal_semaphore = swapchain_semaphore.get_submit_signal_semaphore(&self.device)?;
            signal_semaphores.push(signal_semaphore);
            signal_values.push(!0);
        }

        let mut guards = self.signal_semaphores.lock();
        let (ref mut pending_signal_semaphores, ref mut pending_signal_semaphore_values) =
            guards.deref_mut();
        assert!(pending_signal_semaphores.len() == pending_signal_semaphore_values.len());
        if !pending_signal_semaphores.is_empty() {
            signal_semaphores.append(pending_signal_semaphores);
            signal_values.append(pending_signal_semaphore_values);
        }

        // In order for submissions to be strictly ordered, we encode a dependency between each submission
        // using a pair of semaphores. This adds a wait if it is needed, and signals the next semaphore.
        let semaphore_state = self.relay_semaphores.lock().advance(&self.device)?;

        if let Some(sem) = semaphore_state.wait {
            wait_stage_masks.push(vk::PipelineStageFlags::TOP_OF_PIPE);
            wait_semaphores.push(sem);
        }

        signal_semaphores.push(semaphore_state.signal);
        signal_values.push(!0);

        // We need to signal our wgpu::Fence if we have one, this adds it to the signal list.
        signal_fence.maintain(&self.device.raw)?;
        match *signal_fence {
            Fence::TimelineSemaphore(raw) => {
                signal_semaphores.push(raw);
                signal_values.push(signal_value);
            }
            Fence::FencePool {
                ref mut active,
                ref mut free,
                ..
            } => {
                fence_raw = match free.pop() {
                    Some(raw) => raw,
                    None => unsafe {
                        self.device
                            .raw
                            .create_fence(&vk::FenceCreateInfo::default(), None)
                            .map_err(map_host_device_oom_err)?
                    },
                };
                active.push((signal_value, fence_raw));
            }
        }

        let vk_cmd_buffers = command_buffers
            .iter()
            .map(|cmd| cmd.raw)
            .collect::<Vec<_>>();

        let mut vk_info = vk::SubmitInfo::default().command_buffers(&vk_cmd_buffers);

        vk_info = vk_info
            .wait_semaphores(&wait_semaphores)
            .wait_dst_stage_mask(&wait_stage_masks)
            .signal_semaphores(&signal_semaphores);

        let mut vk_timeline_info;

        if self.device.private_caps.timeline_semaphores {
            vk_timeline_info =
                vk::TimelineSemaphoreSubmitInfo::default().signal_semaphore_values(&signal_values);
            vk_info = vk_info.push_next(&mut vk_timeline_info);
        }

        profiling::scope!("vkQueueSubmit");
        unsafe {
            self.device
                .raw
                .queue_submit(self.raw, &[vk_info], fence_raw)
                .map_err(map_host_device_oom_and_lost_err)?
        };
        Ok(())
    }

    unsafe fn present(
        &self,
        surface: &Surface,
        texture: SurfaceTexture,
    ) -> Result<(), crate::SurfaceError> {
        let mut swapchain = surface.swapchain.write();
        let ssc = swapchain.as_mut().unwrap();
        let mut swapchain_semaphores = texture.surface_semaphores.lock();

        let swapchains = [ssc.raw];
        let image_indices = [texture.index];
        let vk_info = vk::PresentInfoKHR::default()
            .swapchains(&swapchains)
            .image_indices(&image_indices)
            .wait_semaphores(swapchain_semaphores.get_present_wait_semaphores());

        let mut display_timing;
        let present_times;
        let vk_info = if let Some(present_time) = ssc.next_present_time.take() {
            debug_assert!(
                ssc.device
                    .features
                    .contains(wgt::Features::VULKAN_GOOGLE_DISPLAY_TIMING),
                "`next_present_time` should only be set if `VULKAN_GOOGLE_DISPLAY_TIMING` is enabled"
            );
            present_times = [present_time];
            display_timing = vk::PresentTimesInfoGOOGLE::default().times(&present_times);
            // SAFETY: We know that VK_GOOGLE_display_timing is present because of the safety contract on `next_present_time`.
            vk_info.push_next(&mut display_timing)
        } else {
            vk_info
        };

        let suboptimal = {
            profiling::scope!("vkQueuePresentKHR");
            unsafe { self.swapchain_fn.queue_present(self.raw, &vk_info) }.map_err(|error| {
                match error {
                    vk::Result::ERROR_OUT_OF_DATE_KHR => crate::SurfaceError::Outdated,
                    vk::Result::ERROR_SURFACE_LOST_KHR => crate::SurfaceError::Lost,
                    // We don't use VK_EXT_full_screen_exclusive
                    // VK_ERROR_FULL_SCREEN_EXCLUSIVE_MODE_LOST_EXT
                    _ => map_host_device_oom_and_lost_err(error).into(),
                }
            })?
        };
        if suboptimal {
            // We treat `VK_SUBOPTIMAL_KHR` as `VK_SUCCESS` on Android.
            // On Android 10+, libvulkan's `vkQueuePresentKHR` implementation returns `VK_SUBOPTIMAL_KHR` if not doing pre-rotation
            // (i.e `VkSwapchainCreateInfoKHR::preTransform` not being equal to the current device orientation).
            // This is always the case when the device orientation is anything other than the identity one, as we unconditionally use `VK_SURFACE_TRANSFORM_IDENTITY_BIT_KHR`.
            #[cfg(not(target_os = "android"))]
            log::warn!("Suboptimal present of frame {}", texture.index);
        }
        Ok(())
    }

    unsafe fn get_timestamp_period(&self) -> f32 {
        self.device.timestamp_period
    }
}

impl Queue {
    pub fn raw_device(&self) -> &ash::Device {
        &self.device.raw
    }

    pub fn add_signal_semaphore(&self, semaphore: vk::Semaphore, semaphore_value: Option<u64>) {
        let mut guards = self.signal_semaphores.lock();
        let (ref mut semaphores, ref mut semaphore_values) = guards.deref_mut();
        semaphores.push(semaphore);
        semaphore_values.push(semaphore_value.unwrap_or(!0));
    }
}

/// Maps
///
/// - VK_ERROR_OUT_OF_HOST_MEMORY
/// - VK_ERROR_OUT_OF_DEVICE_MEMORY
fn map_host_device_oom_err(err: vk::Result) -> crate::DeviceError {
    match err {
        vk::Result::ERROR_OUT_OF_HOST_MEMORY | vk::Result::ERROR_OUT_OF_DEVICE_MEMORY => {
            get_oom_err(err)
        }
        e => get_unexpected_err(e),
    }
}

/// Maps
///
/// - VK_ERROR_OUT_OF_HOST_MEMORY
/// - VK_ERROR_OUT_OF_DEVICE_MEMORY
/// - VK_ERROR_DEVICE_LOST
fn map_host_device_oom_and_lost_err(err: vk::Result) -> crate::DeviceError {
    match err {
        vk::Result::ERROR_DEVICE_LOST => get_lost_err(),
        other => map_host_device_oom_err(other),
    }
}

/// Maps
///
/// - VK_ERROR_OUT_OF_HOST_MEMORY
/// - VK_ERROR_OUT_OF_DEVICE_MEMORY
/// - VK_ERROR_INVALID_OPAQUE_CAPTURE_ADDRESS_KHR
fn map_host_device_oom_and_ioca_err(err: vk::Result) -> crate::DeviceError {
    // We don't use VK_KHR_buffer_device_address
    // VK_ERROR_INVALID_OPAQUE_CAPTURE_ADDRESS_KHR
    map_host_device_oom_err(err)
}

/// Maps
///
/// - VK_ERROR_OUT_OF_HOST_MEMORY
fn map_host_oom_err(err: vk::Result) -> crate::DeviceError {
    match err {
        vk::Result::ERROR_OUT_OF_HOST_MEMORY => get_oom_err(err),
        e => get_unexpected_err(e),
    }
}

/// Maps
///
/// - VK_ERROR_OUT_OF_DEVICE_MEMORY
fn map_device_oom_err(err: vk::Result) -> crate::DeviceError {
    match err {
        vk::Result::ERROR_OUT_OF_DEVICE_MEMORY => get_oom_err(err),
        e => get_unexpected_err(e),
    }
}

/// Maps
///
/// - VK_ERROR_OUT_OF_HOST_MEMORY
/// - VK_ERROR_INVALID_OPAQUE_CAPTURE_ADDRESS_KHR
fn map_host_oom_and_ioca_err(err: vk::Result) -> crate::DeviceError {
    // We don't use VK_KHR_buffer_device_address
    // VK_ERROR_INVALID_OPAQUE_CAPTURE_ADDRESS_KHR
    map_host_oom_err(err)
}

/// Maps
///
/// - VK_ERROR_OUT_OF_HOST_MEMORY
/// - VK_ERROR_OUT_OF_DEVICE_MEMORY
/// - VK_PIPELINE_COMPILE_REQUIRED_EXT
/// - VK_ERROR_INVALID_SHADER_NV
fn map_pipeline_err(err: vk::Result) -> crate::DeviceError {
    // We don't use VK_EXT_pipeline_creation_cache_control
    // VK_PIPELINE_COMPILE_REQUIRED_EXT
    // We don't use VK_NV_glsl_shader
    // VK_ERROR_INVALID_SHADER_NV
    map_host_device_oom_err(err)
}

/// Returns [`crate::DeviceError::Unexpected`] or panics if the `internal_error_panic`
/// feature flag is enabled.
fn get_unexpected_err(_err: vk::Result) -> crate::DeviceError {
    #[cfg(feature = "internal_error_panic")]
    panic!("Unexpected Vulkan error: {_err:?}");

    #[allow(unreachable_code)]
    crate::DeviceError::Unexpected
}

/// Returns [`crate::DeviceError::OutOfMemory`] or panics if the `oom_panic`
/// feature flag is enabled.
fn get_oom_err(_err: vk::Result) -> crate::DeviceError {
    #[cfg(feature = "oom_panic")]
    panic!("Out of memory ({_err:?})");

    #[allow(unreachable_code)]
    crate::DeviceError::OutOfMemory
}

/// Returns [`crate::DeviceError::Lost`] or panics if the `device_lost_panic`
/// feature flag is enabled.
fn get_lost_err() -> crate::DeviceError {
    #[cfg(feature = "device_lost_panic")]
    panic!("Device lost");

    #[allow(unreachable_code)]
    crate::DeviceError::Lost
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
struct RawTlasInstance {
    transform: [f32; 12],
    custom_data_and_mask: u32,
    shader_binding_table_record_offset_and_flags: u32,
    acceleration_structure_reference: u64,
}
