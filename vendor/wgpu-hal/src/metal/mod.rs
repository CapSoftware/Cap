/*!
# Metal API internals.

## Pipeline Layout

In Metal, push constants, vertex buffers, and resources in the bind groups
are all placed together in the native resource bindings, which work similarly to D3D11:
there are tables of textures, buffers, and samplers.

We put push constants first (if any) in the table, followed by bind group 0
resources, followed by other bind groups. The vertex buffers are bound at the very
end of the VS buffer table.

!*/

#![allow(clippy::std_instead_of_alloc, clippy::std_instead_of_core)]

// `MTLFeatureSet` is superseded by `MTLGpuFamily`.
// However, `MTLGpuFamily` is only supported starting MacOS 10.15, whereas our minimum target is MacOS 10.13,
// See https://github.com/gpuweb/gpuweb/issues/1069 for minimum spec.
// TODO: Eventually all deprecated features should be abstracted and use new api when available.
#[allow(deprecated)]
mod adapter;
mod command;
mod conv;
mod device;
mod layer_observer;
mod surface;
mod time;

use std::{
    borrow::ToOwned as _,
    fmt, iter, ops,
    ptr::NonNull,
    string::String,
    sync::{atomic, Arc},
    thread,
    vec::Vec,
};

use arrayvec::ArrayVec;
use bitflags::bitflags;
use hashbrown::HashMap;
use metal::foreign_types::ForeignTypeRef as _;
use naga::FastHashMap;
use parking_lot::{Mutex, RwLock};

#[derive(Clone, Debug)]
pub struct Api;

type ResourceIndex = u32;

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

    type BindGroupLayout = BindGroupLayout;
    type BindGroup = BindGroup;
    type PipelineLayout = PipelineLayout;
    type ShaderModule = ShaderModule;
    type RenderPipeline = RenderPipeline;
    type ComputePipeline = ComputePipeline;
    type PipelineCache = PipelineCache;

    type AccelerationStructure = AccelerationStructure;
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

pub struct Instance {}

impl Instance {
    pub fn create_surface_from_layer(&self, layer: &metal::MetalLayerRef) -> Surface {
        unsafe { Surface::from_layer(layer) }
    }
}

impl crate::Instance for Instance {
    type A = Api;

    unsafe fn init(_desc: &crate::InstanceDescriptor) -> Result<Self, crate::InstanceError> {
        profiling::scope!("Init Metal Backend");
        // We do not enable metal validation based on the validation flags as it affects the entire
        // process. Instead, we enable the validation inside the test harness itself in tests/src/native.rs.
        Ok(Instance {})
    }

    unsafe fn create_surface(
        &self,
        _display_handle: raw_window_handle::RawDisplayHandle,
        window_handle: raw_window_handle::RawWindowHandle,
    ) -> Result<Surface, crate::InstanceError> {
        match window_handle {
            #[cfg(any(target_os = "ios", target_os = "visionos"))]
            raw_window_handle::RawWindowHandle::UiKit(handle) => {
                Ok(unsafe { Surface::from_view(handle.ui_view.cast()) })
            }
            #[cfg(target_os = "macos")]
            raw_window_handle::RawWindowHandle::AppKit(handle) => {
                Ok(unsafe { Surface::from_view(handle.ns_view.cast()) })
            }
            _ => Err(crate::InstanceError::new(format!(
                "window handle {window_handle:?} is not a Metal-compatible handle"
            ))),
        }
    }

    unsafe fn enumerate_adapters(
        &self,
        _surface_hint: Option<&Surface>,
    ) -> Vec<crate::ExposedAdapter<Api>> {
        let devices = metal::Device::all();
        let mut adapters: Vec<crate::ExposedAdapter<Api>> = devices
            .into_iter()
            .map(|dev| {
                let name = dev.name().into();
                let shared = AdapterShared::new(dev);
                crate::ExposedAdapter {
                    info: wgt::AdapterInfo {
                        name,
                        vendor: 0,
                        device: 0,
                        device_type: shared.private_caps.device_type(),
                        driver: String::new(),
                        driver_info: String::new(),
                        backend: wgt::Backend::Metal,
                    },
                    features: shared.private_caps.features(),
                    capabilities: shared.private_caps.capabilities(),
                    adapter: Adapter::new(Arc::new(shared)),
                }
            })
            .collect();
        adapters.sort_by_key(|ad| {
            (
                ad.adapter.shared.private_caps.low_power,
                ad.adapter.shared.private_caps.headless,
            )
        });
        adapters
    }
}

bitflags!(
    /// Similar to `MTLCounterSamplingPoint`, but a bit higher abstracted for our purposes.
    #[derive(Debug, Copy, Clone)]
    pub struct TimestampQuerySupport: u32 {
        /// On creating Metal encoders.
        const STAGE_BOUNDARIES = 1 << 1;
        /// Within existing draw encoders.
        const ON_RENDER_ENCODER = Self::STAGE_BOUNDARIES.bits() | (1 << 2);
        /// Within existing dispatch encoders.
        const ON_COMPUTE_ENCODER = Self::STAGE_BOUNDARIES.bits() | (1 << 3);
        /// Within existing blit encoders.
        const ON_BLIT_ENCODER = Self::STAGE_BOUNDARIES.bits() | (1 << 4);

        /// Within any wgpu render/compute pass.
        const INSIDE_WGPU_PASSES = Self::ON_RENDER_ENCODER.bits() | Self::ON_COMPUTE_ENCODER.bits();
    }
);

#[allow(dead_code)]
#[derive(Clone, Debug)]
struct PrivateCapabilities {
    family_check: bool,
    msl_version: metal::MTLLanguageVersion,
    fragment_rw_storage: bool,
    read_write_texture_tier: metal::MTLReadWriteTextureTier,
    msaa_desktop: bool,
    msaa_apple3: bool,
    msaa_apple7: bool,
    resource_heaps: bool,
    argument_buffers: metal::MTLArgumentBuffersTier,
    shared_textures: bool,
    mutable_comparison_samplers: bool,
    sampler_clamp_to_border: bool,
    indirect_draw_dispatch: bool,
    base_vertex_first_instance_drawing: bool,
    dual_source_blending: bool,
    low_power: bool,
    headless: bool,
    layered_rendering: bool,
    function_specialization: bool,
    depth_clip_mode: bool,
    texture_cube_array: bool,
    supports_float_filtering: bool,
    format_depth24_stencil8: bool,
    format_depth32_stencil8_filter: bool,
    format_depth32_stencil8_none: bool,
    format_min_srgb_channels: u8,
    format_b5: bool,
    format_bc: bool,
    format_eac_etc: bool,
    format_astc: bool,
    format_astc_hdr: bool,
    format_any8_unorm_srgb_all: bool,
    format_any8_unorm_srgb_no_write: bool,
    format_any8_snorm_all: bool,
    format_r16_norm_all: bool,
    format_r32_all: bool,
    format_r32_no_write: bool,
    format_r32float_no_write_no_filter: bool,
    format_r32float_no_filter: bool,
    format_r32float_all: bool,
    format_rgba8_srgb_all: bool,
    format_rgba8_srgb_no_write: bool,
    format_rgb10a2_unorm_all: bool,
    format_rgb10a2_unorm_no_write: bool,
    format_rgb10a2_uint_write: bool,
    format_rg11b10_all: bool,
    format_rg11b10_no_write: bool,
    format_rgb9e5_all: bool,
    format_rgb9e5_no_write: bool,
    format_rgb9e5_filter_only: bool,
    format_rg32_color: bool,
    format_rg32_color_write: bool,
    format_rg32float_all: bool,
    format_rg32float_color_blend: bool,
    format_rg32float_no_filter: bool,
    format_rgba32int_color: bool,
    format_rgba32int_color_write: bool,
    format_rgba32float_color: bool,
    format_rgba32float_color_write: bool,
    format_rgba32float_all: bool,
    format_depth16unorm: bool,
    format_depth32float_filter: bool,
    format_depth32float_none: bool,
    format_bgr10a2_all: bool,
    format_bgr10a2_no_write: bool,
    max_buffers_per_stage: ResourceIndex,
    max_vertex_buffers: ResourceIndex,
    max_textures_per_stage: ResourceIndex,
    max_samplers_per_stage: ResourceIndex,
    max_binding_array_elements: ResourceIndex,
    max_sampler_binding_array_elements: ResourceIndex,
    buffer_alignment: u64,
    max_buffer_size: u64,
    max_texture_size: u64,
    max_texture_3d_size: u64,
    max_texture_layers: u64,
    max_fragment_input_components: u64,
    max_color_render_targets: u8,
    max_color_attachment_bytes_per_sample: u8,
    max_varying_components: u32,
    max_threads_per_group: u32,
    max_total_threadgroup_memory: u32,
    sample_count_mask: crate::TextureFormatCapabilities,
    supports_debug_markers: bool,
    supports_binary_archives: bool,
    supports_capture_manager: bool,
    can_set_maximum_drawables_count: bool,
    can_set_display_sync: bool,
    can_set_next_drawable_timeout: bool,
    supports_arrays_of_textures: bool,
    supports_arrays_of_textures_write: bool,
    supports_mutability: bool,
    supports_depth_clip_control: bool,
    supports_preserve_invariance: bool,
    supports_shader_primitive_index: bool,
    has_unified_memory: Option<bool>,
    timestamp_query_support: TimestampQuerySupport,
    supports_simd_scoped_operations: bool,
    int64: bool,
    int64_atomics: bool,
    float_atomics: bool,
    supports_shared_event: bool,
}

#[derive(Clone, Debug)]
struct PrivateDisabilities {
    /// Near depth is not respected properly on some Intel GPUs.
    broken_viewport_near_depth: bool,
    /// Multi-target clears don't appear to work properly on Intel GPUs.
    #[allow(dead_code)]
    broken_layered_clear_image: bool,
}

#[derive(Debug, Default)]
struct Settings {
    retain_command_buffer_references: bool,
}

struct AdapterShared {
    device: Mutex<metal::Device>,
    disabilities: PrivateDisabilities,
    private_caps: PrivateCapabilities,
    settings: Settings,
    presentation_timer: time::PresentationTimer,
}

unsafe impl Send for AdapterShared {}
unsafe impl Sync for AdapterShared {}

impl AdapterShared {
    fn new(device: metal::Device) -> Self {
        let private_caps = PrivateCapabilities::new(&device);
        log::debug!("{:#?}", private_caps);

        Self {
            disabilities: PrivateDisabilities::new(&device),
            private_caps,
            device: Mutex::new(device),
            settings: Settings::default(),
            presentation_timer: time::PresentationTimer::new(),
        }
    }
}

pub struct Adapter {
    shared: Arc<AdapterShared>,
}

pub struct Queue {
    raw: Arc<Mutex<metal::CommandQueue>>,
    timestamp_period: f32,
}

unsafe impl Send for Queue {}
unsafe impl Sync for Queue {}

impl Queue {
    pub unsafe fn queue_from_raw(raw: metal::CommandQueue, timestamp_period: f32) -> Self {
        Self {
            raw: Arc::new(Mutex::new(raw)),
            timestamp_period,
        }
    }

    pub fn as_raw(&self) -> &Arc<Mutex<metal::CommandQueue>> {
        &self.raw
    }
}

pub struct Device {
    shared: Arc<AdapterShared>,
    features: wgt::Features,
    counters: Arc<wgt::HalCounters>,
}

pub struct Surface {
    render_layer: Mutex<metal::MetalLayer>,
    swapchain_format: RwLock<Option<wgt::TextureFormat>>,
    extent: RwLock<wgt::Extent3d>,
    main_thread_id: thread::ThreadId,
    // Useful for UI-intensive applications that are sensitive to
    // window resizing.
    pub present_with_transaction: bool,
}

unsafe impl Send for Surface {}
unsafe impl Sync for Surface {}

#[derive(Debug)]
pub struct SurfaceTexture {
    texture: Texture,
    drawable: metal::MetalDrawable,
    present_with_transaction: bool,
}

impl crate::DynSurfaceTexture for SurfaceTexture {}

impl std::borrow::Borrow<Texture> for SurfaceTexture {
    fn borrow(&self) -> &Texture {
        &self.texture
    }
}

impl std::borrow::Borrow<dyn crate::DynTexture> for SurfaceTexture {
    fn borrow(&self) -> &dyn crate::DynTexture {
        &self.texture
    }
}

unsafe impl Send for SurfaceTexture {}
unsafe impl Sync for SurfaceTexture {}

impl crate::Queue for Queue {
    type A = Api;

    unsafe fn submit(
        &self,
        command_buffers: &[&CommandBuffer],
        _surface_textures: &[&SurfaceTexture],
        (signal_fence, signal_value): (&mut Fence, crate::FenceValue),
    ) -> Result<(), crate::DeviceError> {
        objc::rc::autoreleasepool(|| {
            let extra_command_buffer = {
                let completed_value = Arc::clone(&signal_fence.completed_value);
                let block = block::ConcreteBlock::new(move |_cmd_buf| {
                    completed_value.store(signal_value, atomic::Ordering::Release);
                })
                .copy();

                let raw = match command_buffers.last() {
                    Some(&cmd_buf) => cmd_buf.raw.to_owned(),
                    None => {
                        let queue = self.raw.lock();
                        queue
                            .new_command_buffer_with_unretained_references()
                            .to_owned()
                    }
                };
                raw.set_label("(wgpu internal) Signal");
                raw.add_completed_handler(&block);

                signal_fence.maintain();
                signal_fence
                    .pending_command_buffers
                    .push((signal_value, raw.to_owned()));

                if let Some(shared_event) = signal_fence.shared_event.as_ref() {
                    raw.encode_signal_event(shared_event, signal_value);
                }
                // only return an extra one if it's extra
                match command_buffers.last() {
                    Some(_) => None,
                    None => Some(raw),
                }
            };

            for cmd_buffer in command_buffers {
                cmd_buffer.raw.commit();
            }

            if let Some(raw) = extra_command_buffer {
                raw.commit();
            }
        });
        Ok(())
    }
    unsafe fn present(
        &self,
        _surface: &Surface,
        texture: SurfaceTexture,
    ) -> Result<(), crate::SurfaceError> {
        let queue = &self.raw.lock();
        objc::rc::autoreleasepool(|| {
            let command_buffer = queue.new_command_buffer();
            command_buffer.set_label("(wgpu internal) Present");

            // https://developer.apple.com/documentation/quartzcore/cametallayer/1478157-presentswithtransaction?language=objc
            if !texture.present_with_transaction {
                command_buffer.present_drawable(&texture.drawable);
            }

            command_buffer.commit();

            if texture.present_with_transaction {
                command_buffer.wait_until_scheduled();
                texture.drawable.present();
            }
        });
        Ok(())
    }

    unsafe fn get_timestamp_period(&self) -> f32 {
        self.timestamp_period
    }
}

#[derive(Debug)]
pub struct Buffer {
    raw: metal::Buffer,
    size: wgt::BufferAddress,
}

unsafe impl Send for Buffer {}
unsafe impl Sync for Buffer {}

impl crate::DynBuffer for Buffer {}

impl Buffer {
    fn as_raw(&self) -> BufferPtr {
        unsafe { NonNull::new_unchecked(self.raw.as_ptr()) }
    }
}

impl crate::BufferBinding<'_, Buffer> {
    fn resolve_size(&self) -> wgt::BufferAddress {
        match self.size {
            Some(size) => size.get(),
            None => self.buffer.size - self.offset,
        }
    }
}

#[derive(Debug)]
pub struct Texture {
    raw: metal::Texture,
    format: wgt::TextureFormat,
    raw_type: metal::MTLTextureType,
    array_layers: u32,
    mip_levels: u32,
    copy_size: crate::CopyExtent,
}

impl Texture {
    /// # Safety
    ///
    /// - The texture handle must not be manually destroyed
    pub unsafe fn raw_handle(&self) -> &metal::Texture {
        &self.raw
    }
}

impl crate::DynTexture for Texture {}

unsafe impl Send for Texture {}
unsafe impl Sync for Texture {}

#[derive(Debug)]
pub struct TextureView {
    raw: metal::Texture,
    aspects: crate::FormatAspects,
}

impl crate::DynTextureView for TextureView {}

unsafe impl Send for TextureView {}
unsafe impl Sync for TextureView {}

impl TextureView {
    fn as_raw(&self) -> TexturePtr {
        unsafe { NonNull::new_unchecked(self.raw.as_ptr()) }
    }
}

#[derive(Debug)]
pub struct Sampler {
    raw: metal::SamplerState,
}

impl crate::DynSampler for Sampler {}

unsafe impl Send for Sampler {}
unsafe impl Sync for Sampler {}

impl Sampler {
    fn as_raw(&self) -> SamplerPtr {
        unsafe { NonNull::new_unchecked(self.raw.as_ptr()) }
    }
}

#[derive(Debug)]
pub struct BindGroupLayout {
    /// Sorted list of BGL entries.
    entries: Arc<[wgt::BindGroupLayoutEntry]>,
}

impl crate::DynBindGroupLayout for BindGroupLayout {}

#[derive(Clone, Debug, Default)]
struct ResourceData<T> {
    buffers: T,
    textures: T,
    samplers: T,
}

#[derive(Clone, Debug, Default)]
struct MultiStageData<T> {
    vs: T,
    fs: T,
    cs: T,
}

const NAGA_STAGES: MultiStageData<naga::ShaderStage> = MultiStageData {
    vs: naga::ShaderStage::Vertex,
    fs: naga::ShaderStage::Fragment,
    cs: naga::ShaderStage::Compute,
};

impl<T> ops::Index<naga::ShaderStage> for MultiStageData<T> {
    type Output = T;
    fn index(&self, stage: naga::ShaderStage) -> &T {
        match stage {
            naga::ShaderStage::Vertex => &self.vs,
            naga::ShaderStage::Fragment => &self.fs,
            naga::ShaderStage::Compute => &self.cs,
            naga::ShaderStage::Task | naga::ShaderStage::Mesh => unreachable!(),
        }
    }
}

impl<T> MultiStageData<T> {
    fn map_ref<Y>(&self, fun: impl Fn(&T) -> Y) -> MultiStageData<Y> {
        MultiStageData {
            vs: fun(&self.vs),
            fs: fun(&self.fs),
            cs: fun(&self.cs),
        }
    }
    fn map<Y>(self, fun: impl Fn(T) -> Y) -> MultiStageData<Y> {
        MultiStageData {
            vs: fun(self.vs),
            fs: fun(self.fs),
            cs: fun(self.cs),
        }
    }
    fn iter<'a>(&'a self) -> impl Iterator<Item = &'a T> {
        iter::once(&self.vs)
            .chain(iter::once(&self.fs))
            .chain(iter::once(&self.cs))
    }
    fn iter_mut<'a>(&'a mut self) -> impl Iterator<Item = &'a mut T> {
        iter::once(&mut self.vs)
            .chain(iter::once(&mut self.fs))
            .chain(iter::once(&mut self.cs))
    }
}

type MultiStageResourceCounters = MultiStageData<ResourceData<ResourceIndex>>;
type MultiStageResources = MultiStageData<naga::back::msl::EntryPointResources>;

#[derive(Debug)]
struct BindGroupLayoutInfo {
    base_resource_indices: MultiStageResourceCounters,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
struct PushConstantsInfo {
    count: u32,
    buffer_index: ResourceIndex,
}

#[derive(Debug)]
pub struct PipelineLayout {
    bind_group_infos: ArrayVec<BindGroupLayoutInfo, { crate::MAX_BIND_GROUPS }>,
    push_constants_infos: MultiStageData<Option<PushConstantsInfo>>,
    total_counters: MultiStageResourceCounters,
    total_push_constants: u32,
    per_stage_map: MultiStageResources,
}

impl crate::DynPipelineLayout for PipelineLayout {}

trait AsNative {
    type Native;
    fn from(native: &Self::Native) -> Self;
    fn as_native(&self) -> &Self::Native;
}

type ResourcePtr = NonNull<metal::MTLResource>;
type BufferPtr = NonNull<metal::MTLBuffer>;
type TexturePtr = NonNull<metal::MTLTexture>;
type SamplerPtr = NonNull<metal::MTLSamplerState>;

impl AsNative for ResourcePtr {
    type Native = metal::ResourceRef;
    #[inline]
    fn from(native: &Self::Native) -> Self {
        unsafe { NonNull::new_unchecked(native.as_ptr()) }
    }
    #[inline]
    fn as_native(&self) -> &Self::Native {
        unsafe { Self::Native::from_ptr(self.as_ptr()) }
    }
}

impl AsNative for BufferPtr {
    type Native = metal::BufferRef;
    #[inline]
    fn from(native: &Self::Native) -> Self {
        unsafe { NonNull::new_unchecked(native.as_ptr()) }
    }
    #[inline]
    fn as_native(&self) -> &Self::Native {
        unsafe { Self::Native::from_ptr(self.as_ptr()) }
    }
}

impl AsNative for TexturePtr {
    type Native = metal::TextureRef;
    #[inline]
    fn from(native: &Self::Native) -> Self {
        unsafe { NonNull::new_unchecked(native.as_ptr()) }
    }
    #[inline]
    fn as_native(&self) -> &Self::Native {
        unsafe { Self::Native::from_ptr(self.as_ptr()) }
    }
}

impl AsNative for SamplerPtr {
    type Native = metal::SamplerStateRef;
    #[inline]
    fn from(native: &Self::Native) -> Self {
        unsafe { NonNull::new_unchecked(native.as_ptr()) }
    }
    #[inline]
    fn as_native(&self) -> &Self::Native {
        unsafe { Self::Native::from_ptr(self.as_ptr()) }
    }
}

#[derive(Debug)]
struct BufferResource {
    ptr: BufferPtr,
    offset: wgt::BufferAddress,
    dynamic_index: Option<u32>,

    /// The buffer's size, if it is a [`Storage`] binding. Otherwise `None`.
    ///
    /// Buffers with the [`wgt::BufferBindingType::Storage`] binding type can
    /// hold WGSL runtime-sized arrays. When one does, we must pass its size to
    /// shader entry points to implement bounds checks and WGSL's `arrayLength`
    /// function. See `device::CompiledShader::sized_bindings` for details.
    ///
    /// [`Storage`]: wgt::BufferBindingType::Storage
    binding_size: Option<wgt::BufferSize>,

    binding_location: u32,
}

#[derive(Debug)]
struct UseResourceInfo {
    uses: metal::MTLResourceUsage,
    stages: metal::MTLRenderStages,
    visible_in_compute: bool,
}

impl Default for UseResourceInfo {
    fn default() -> Self {
        Self {
            uses: metal::MTLResourceUsage::empty(),
            stages: metal::MTLRenderStages::empty(),
            visible_in_compute: false,
        }
    }
}

#[derive(Debug, Default)]
pub struct BindGroup {
    counters: MultiStageResourceCounters,
    buffers: Vec<BufferResource>,
    samplers: Vec<SamplerPtr>,
    textures: Vec<TexturePtr>,

    argument_buffers: Vec<metal::Buffer>,
    resources_to_use: HashMap<ResourcePtr, UseResourceInfo>,
}

impl crate::DynBindGroup for BindGroup {}

unsafe impl Send for BindGroup {}
unsafe impl Sync for BindGroup {}

#[derive(Debug)]
pub enum ShaderModuleSource {
    Naga(crate::NagaShader),
    Passthrough(PassthroughShader),
}

#[derive(Debug)]
pub struct PassthroughShader {
    pub library: metal::Library,
    pub function: metal::Function,
    pub entry_point: String,
    pub num_workgroups: (u32, u32, u32),
}

#[derive(Debug)]
pub struct ShaderModule {
    source: ShaderModuleSource,
    bounds_checks: wgt::ShaderRuntimeChecks,
}

impl crate::DynShaderModule for ShaderModule {}

#[derive(Debug, Default)]
struct PipelineStageInfo {
    push_constants: Option<PushConstantsInfo>,

    /// The buffer argument table index at which we pass runtime-sized arrays' buffer sizes.
    ///
    /// See `device::CompiledShader::sized_bindings` for more details.
    sizes_slot: Option<naga::back::msl::Slot>,

    /// Bindings of all WGSL `storage` globals that contain runtime-sized arrays.
    ///
    /// See `device::CompiledShader::sized_bindings` for more details.
    sized_bindings: Vec<naga::ResourceBinding>,

    /// Info on all bound vertex buffers.
    vertex_buffer_mappings: Vec<naga::back::msl::VertexBufferMapping>,
}

impl PipelineStageInfo {
    fn clear(&mut self) {
        self.push_constants = None;
        self.sizes_slot = None;
        self.sized_bindings.clear();
        self.vertex_buffer_mappings.clear();
    }

    fn assign_from(&mut self, other: &Self) {
        self.push_constants = other.push_constants;
        self.sizes_slot = other.sizes_slot;
        self.sized_bindings.clear();
        self.sized_bindings.extend_from_slice(&other.sized_bindings);
        self.vertex_buffer_mappings.clear();
        self.vertex_buffer_mappings
            .extend_from_slice(&other.vertex_buffer_mappings);
    }
}

#[derive(Debug)]
pub struct RenderPipeline {
    raw: metal::RenderPipelineState,
    #[allow(dead_code)]
    vs_lib: metal::Library,
    #[allow(dead_code)]
    fs_lib: Option<metal::Library>,
    vs_info: PipelineStageInfo,
    fs_info: Option<PipelineStageInfo>,
    raw_primitive_type: metal::MTLPrimitiveType,
    raw_triangle_fill_mode: metal::MTLTriangleFillMode,
    raw_front_winding: metal::MTLWinding,
    raw_cull_mode: metal::MTLCullMode,
    raw_depth_clip_mode: Option<metal::MTLDepthClipMode>,
    depth_stencil: Option<(metal::DepthStencilState, wgt::DepthBiasState)>,
}

unsafe impl Send for RenderPipeline {}
unsafe impl Sync for RenderPipeline {}

impl crate::DynRenderPipeline for RenderPipeline {}

#[derive(Debug)]
pub struct ComputePipeline {
    raw: metal::ComputePipelineState,
    #[allow(dead_code)]
    cs_lib: metal::Library,
    cs_info: PipelineStageInfo,
    work_group_size: metal::MTLSize,
    work_group_memory_sizes: Vec<u32>,
}

unsafe impl Send for ComputePipeline {}
unsafe impl Sync for ComputePipeline {}

impl crate::DynComputePipeline for ComputePipeline {}

#[derive(Debug, Clone)]
pub struct QuerySet {
    raw_buffer: metal::Buffer,
    //Metal has a custom buffer for counters.
    counter_sample_buffer: Option<metal::CounterSampleBuffer>,
    ty: wgt::QueryType,
}

impl crate::DynQuerySet for QuerySet {}

unsafe impl Send for QuerySet {}
unsafe impl Sync for QuerySet {}

#[derive(Debug)]
pub struct Fence {
    completed_value: Arc<atomic::AtomicU64>,
    /// The pending fence values have to be ascending.
    pending_command_buffers: Vec<(crate::FenceValue, metal::CommandBuffer)>,
    shared_event: Option<metal::SharedEvent>,
}

impl crate::DynFence for Fence {}

unsafe impl Send for Fence {}
unsafe impl Sync for Fence {}

impl Fence {
    fn get_latest(&self) -> crate::FenceValue {
        let mut max_value = self.completed_value.load(atomic::Ordering::Acquire);
        for &(value, ref cmd_buf) in self.pending_command_buffers.iter() {
            if cmd_buf.status() == metal::MTLCommandBufferStatus::Completed {
                max_value = value;
            }
        }
        max_value
    }

    fn maintain(&mut self) {
        let latest = self.get_latest();
        self.pending_command_buffers
            .retain(|&(value, _)| value > latest);
    }

    pub fn raw_shared_event(&self) -> Option<&metal::SharedEvent> {
        self.shared_event.as_ref()
    }
}

struct IndexState {
    buffer_ptr: BufferPtr,
    offset: wgt::BufferAddress,
    stride: wgt::BufferAddress,
    raw_type: metal::MTLIndexType,
}

#[derive(Default)]
struct Temp {
    binding_sizes: Vec<u32>,
}

struct CommandState {
    blit: Option<metal::BlitCommandEncoder>,
    render: Option<metal::RenderCommandEncoder>,
    compute: Option<metal::ComputeCommandEncoder>,
    raw_primitive_type: metal::MTLPrimitiveType,
    index: Option<IndexState>,
    raw_wg_size: metal::MTLSize,
    stage_infos: MultiStageData<PipelineStageInfo>,

    /// Sizes of currently bound [`wgt::BufferBindingType::Storage`] buffers.
    ///
    /// Specifically:
    ///
    /// - The keys are [`ResourceBinding`] values (that is, the WGSL `@group`
    ///   and `@binding` attributes) for `var<storage>` global variables in the
    ///   current module that contain runtime-sized arrays.
    ///
    /// - The values are the actual sizes of the buffers currently bound to
    ///   provide those globals' contents, which are needed to implement bounds
    ///   checks and the WGSL `arrayLength` function.
    ///
    /// For each stage `S` in `stage_infos`, we consult this to find the sizes
    /// of the buffers listed in [`stage_infos.S.sized_bindings`], which we must
    /// pass to the entry point.
    ///
    /// See `device::CompiledShader::sized_bindings` for more details.
    ///
    /// [`ResourceBinding`]: naga::ResourceBinding
    storage_buffer_length_map: FastHashMap<naga::ResourceBinding, wgt::BufferSize>,

    vertex_buffer_size_map: FastHashMap<u64, wgt::BufferSize>,

    work_group_memory_sizes: Vec<u32>,
    push_constants: Vec<u32>,

    /// Timer query that should be executed when the next pass starts.
    pending_timer_queries: Vec<(QuerySet, u32)>,
}

pub struct CommandEncoder {
    shared: Arc<AdapterShared>,
    raw_queue: Arc<Mutex<metal::CommandQueue>>,
    raw_cmd_buf: Option<metal::CommandBuffer>,
    state: CommandState,
    temp: Temp,
    counters: Arc<wgt::HalCounters>,
}

impl fmt::Debug for CommandEncoder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CommandEncoder")
            .field("raw_queue", &self.raw_queue)
            .field("raw_cmd_buf", &self.raw_cmd_buf)
            .finish()
    }
}

unsafe impl Send for CommandEncoder {}
unsafe impl Sync for CommandEncoder {}

#[derive(Debug)]
pub struct CommandBuffer {
    raw: metal::CommandBuffer,
}

impl crate::DynCommandBuffer for CommandBuffer {}

unsafe impl Send for CommandBuffer {}
unsafe impl Sync for CommandBuffer {}

#[derive(Debug)]
pub struct PipelineCache;

impl crate::DynPipelineCache for PipelineCache {}

#[derive(Debug)]
pub struct AccelerationStructure;

impl crate::DynAccelerationStructure for AccelerationStructure {}
