use std::{borrow::ToOwned as _, collections::BTreeMap, ffi::CStr, sync::Arc, vec::Vec};

use ash::{amd, ext, google, khr, vk};
use parking_lot::Mutex;

use super::conv;

fn depth_stencil_required_flags() -> vk::FormatFeatureFlags {
    vk::FormatFeatureFlags::SAMPLED_IMAGE | vk::FormatFeatureFlags::DEPTH_STENCIL_ATTACHMENT
}

const INDEXING_FEATURES: wgt::Features = wgt::Features::TEXTURE_BINDING_ARRAY
    .union(wgt::Features::BUFFER_BINDING_ARRAY)
    .union(wgt::Features::STORAGE_RESOURCE_BINDING_ARRAY)
    .union(wgt::Features::SAMPLED_TEXTURE_AND_STORAGE_BUFFER_ARRAY_NON_UNIFORM_INDEXING)
    .union(wgt::Features::STORAGE_TEXTURE_ARRAY_NON_UNIFORM_INDEXING)
    .union(wgt::Features::UNIFORM_BUFFER_BINDING_ARRAYS)
    .union(wgt::Features::PARTIALLY_BOUND_BINDING_ARRAY);

/// Features supported by a [`vk::PhysicalDevice`] and its extensions.
///
/// This is used in two phases:
///
/// - When enumerating adapters, this represents the features offered by the
///   adapter. [`Instance::expose_adapter`] calls `vkGetPhysicalDeviceFeatures2`
///   (or `vkGetPhysicalDeviceFeatures` if that is not available) to collect
///   this information about the `VkPhysicalDevice` represented by the
///   `wgpu_hal::ExposedAdapter`.
///
/// - When opening a device, this represents the features we would like to
///   enable. At `wgpu_hal::Device` construction time,
///   [`PhysicalDeviceFeatures::from_extensions_and_requested_features`]
///   constructs an value of this type indicating which Vulkan features to
///   enable, based on the `wgpu_types::Features` requested.
///
/// [`Instance::expose_adapter`]: super::Instance::expose_adapter
#[derive(Debug, Default)]
pub struct PhysicalDeviceFeatures {
    /// Basic Vulkan 1.0 features.
    core: vk::PhysicalDeviceFeatures,

    /// Features provided by `VK_EXT_descriptor_indexing`, promoted to Vulkan 1.2.
    pub(super) descriptor_indexing:
        Option<vk::PhysicalDeviceDescriptorIndexingFeaturesEXT<'static>>,

    /// Features provided by `VK_KHR_imageless_framebuffer`, promoted to Vulkan 1.2.
    imageless_framebuffer: Option<vk::PhysicalDeviceImagelessFramebufferFeaturesKHR<'static>>,

    /// Features provided by `VK_KHR_timeline_semaphore`, promoted to Vulkan 1.2
    timeline_semaphore: Option<vk::PhysicalDeviceTimelineSemaphoreFeaturesKHR<'static>>,

    /// Features provided by `VK_EXT_image_robustness`, promoted to Vulkan 1.3
    image_robustness: Option<vk::PhysicalDeviceImageRobustnessFeaturesEXT<'static>>,

    /// Features provided by `VK_EXT_robustness2`.
    robustness2: Option<vk::PhysicalDeviceRobustness2FeaturesEXT<'static>>,

    /// Features provided by `VK_KHR_multiview`, promoted to Vulkan 1.1.
    multiview: Option<vk::PhysicalDeviceMultiviewFeaturesKHR<'static>>,

    /// Features provided by `VK_KHR_sampler_ycbcr_conversion`, promoted to Vulkan 1.1.
    sampler_ycbcr_conversion: Option<vk::PhysicalDeviceSamplerYcbcrConversionFeatures<'static>>,

    /// Features provided by `VK_EXT_texture_compression_astc_hdr`, promoted to Vulkan 1.3.
    astc_hdr: Option<vk::PhysicalDeviceTextureCompressionASTCHDRFeaturesEXT<'static>>,

    /// Features provided by `VK_KHR_shader_float16_int8` (promoted to Vulkan
    /// 1.2) and `VK_KHR_16bit_storage` (promoted to Vulkan 1.1). We use these
    /// features together, or not at all.
    shader_float16: Option<(
        vk::PhysicalDeviceShaderFloat16Int8Features<'static>,
        vk::PhysicalDevice16BitStorageFeatures<'static>,
    )>,

    /// Features provided by `VK_KHR_acceleration_structure`.
    acceleration_structure: Option<vk::PhysicalDeviceAccelerationStructureFeaturesKHR<'static>>,

    /// Features provided by `VK_KHR_buffer_device_address`, promoted to Vulkan 1.2.
    ///
    /// We only use this feature for
    /// [`Features::EXPERIMENTAL_RAY_TRACING_ACCELERATION_STRUCTURE`], which requires
    /// `VK_KHR_acceleration_structure`, which depends on
    /// `VK_KHR_buffer_device_address`, so [`Instance::expose_adapter`] only
    /// bothers to check if `VK_KHR_acceleration_structure` is available,
    /// leaving this `None`.
    ///
    /// However, we do populate this when creating a device if
    /// [`Features::EXPERIMENTAL_RAY_TRACING_ACCELERATION_STRUCTURE`] is requested.
    ///
    /// [`Instance::expose_adapter`]: super::Instance::expose_adapter
    /// [`Features::EXPERIMENTAL_RAY_TRACING_ACCELERATION_STRUCTURE`]: wgt::Features::EXPERIMENTAL_RAY_TRACING_ACCELERATION_STRUCTURE
    buffer_device_address: Option<vk::PhysicalDeviceBufferDeviceAddressFeaturesKHR<'static>>,

    /// Features provided by `VK_KHR_ray_query`,
    ///
    /// Vulkan requires that the feature be present if the `VK_KHR_ray_query`
    /// extension is present, so [`Instance::expose_adapter`] doesn't bother retrieving
    /// this from `vkGetPhysicalDeviceFeatures2`.
    ///
    /// However, we do populate this when creating a device if ray tracing is requested.
    ///
    /// [`Instance::expose_adapter`]: super::Instance::expose_adapter
    ray_query: Option<vk::PhysicalDeviceRayQueryFeaturesKHR<'static>>,

    /// Features provided by `VK_KHR_zero_initialize_workgroup_memory`, promoted
    /// to Vulkan 1.3.
    zero_initialize_workgroup_memory:
        Option<vk::PhysicalDeviceZeroInitializeWorkgroupMemoryFeatures<'static>>,
    position_fetch: Option<vk::PhysicalDeviceRayTracingPositionFetchFeaturesKHR<'static>>,

    /// Features provided by `VK_KHR_shader_atomic_int64`, promoted to Vulkan 1.2.
    shader_atomic_int64: Option<vk::PhysicalDeviceShaderAtomicInt64Features<'static>>,

    /// Features provided by `VK_EXT_shader_image_atomic_int64`
    shader_image_atomic_int64: Option<vk::PhysicalDeviceShaderImageAtomicInt64FeaturesEXT<'static>>,

    /// Features provided by `VK_EXT_shader_atomic_float`.
    shader_atomic_float: Option<vk::PhysicalDeviceShaderAtomicFloatFeaturesEXT<'static>>,

    /// Features provided by `VK_EXT_subgroup_size_control`, promoted to Vulkan 1.3.
    subgroup_size_control: Option<vk::PhysicalDeviceSubgroupSizeControlFeatures<'static>>,

    /// Features proved by `VK_KHR_maintenance4`, needed for mesh shaders
    maintenance4: Option<vk::PhysicalDeviceMaintenance4FeaturesKHR<'static>>,

    /// Features proved by `VK_EXT_mesh_shader`
    mesh_shader: Option<vk::PhysicalDeviceMeshShaderFeaturesEXT<'static>>,
}

impl PhysicalDeviceFeatures {
    /// Add the members of `self` into `info.enabled_features` and its `p_next` chain.
    pub fn add_to_device_create<'a>(
        &'a mut self,
        mut info: vk::DeviceCreateInfo<'a>,
    ) -> vk::DeviceCreateInfo<'a> {
        info = info.enabled_features(&self.core);
        if let Some(ref mut feature) = self.descriptor_indexing {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.imageless_framebuffer {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.timeline_semaphore {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.image_robustness {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.robustness2 {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.multiview {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.astc_hdr {
            info = info.push_next(feature);
        }
        if let Some((ref mut f16_i8_feature, ref mut _16bit_feature)) = self.shader_float16 {
            info = info.push_next(f16_i8_feature);
            info = info.push_next(_16bit_feature);
        }
        if let Some(ref mut feature) = self.zero_initialize_workgroup_memory {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.acceleration_structure {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.buffer_device_address {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.ray_query {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.shader_atomic_int64 {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.position_fetch {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.shader_image_atomic_int64 {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.shader_atomic_float {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.subgroup_size_control {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.maintenance4 {
            info = info.push_next(feature);
        }
        if let Some(ref mut feature) = self.mesh_shader {
            info = info.push_next(feature);
        }
        info
    }

    /// Create a `PhysicalDeviceFeatures` that can be used to create a logical
    /// device.
    ///
    /// Return a `PhysicalDeviceFeatures` value capturing all the Vulkan
    /// features needed for the given [`Features`], [`DownlevelFlags`], and
    /// [`PrivateCapabilities`]. You can use the returned value's
    /// [`add_to_device_create`] method to configure a
    /// [`vk::DeviceCreateInfo`] to build a logical device providing those
    /// features.
    ///
    /// To ensure that the returned value is able to select all the Vulkan
    /// features needed to express `requested_features`, `downlevel_flags`, and
    /// `private_caps`:
    ///
    /// - The given `enabled_extensions` set must include all the extensions
    ///   selected by [`Adapter::required_device_extensions`] when passed
    ///   `features`.
    ///
    /// - The given `device_api_version` must be the Vulkan API version of the
    ///   physical device we will use to create the logical device.
    ///
    /// [`Features`]: wgt::Features
    /// [`DownlevelFlags`]: wgt::DownlevelFlags
    /// [`PrivateCapabilities`]: super::PrivateCapabilities
    /// [`add_to_device_create`]: PhysicalDeviceFeatures::add_to_device_create
    /// [`Adapter::required_device_extensions`]: super::Adapter::required_device_extensions
    fn from_extensions_and_requested_features(
        phd_capabilities: &PhysicalDeviceProperties,
        _phd_features: &PhysicalDeviceFeatures,
        enabled_extensions: &[&'static CStr],
        requested_features: wgt::Features,
        downlevel_flags: wgt::DownlevelFlags,
        private_caps: &super::PrivateCapabilities,
    ) -> Self {
        let device_api_version = phd_capabilities.device_api_version;
        let needs_bindless = requested_features.intersects(
            wgt::Features::TEXTURE_BINDING_ARRAY
                | wgt::Features::BUFFER_BINDING_ARRAY
                | wgt::Features::STORAGE_RESOURCE_BINDING_ARRAY
                | wgt::Features::STORAGE_TEXTURE_ARRAY_NON_UNIFORM_INDEXING
                | wgt::Features::SAMPLED_TEXTURE_AND_STORAGE_BUFFER_ARRAY_NON_UNIFORM_INDEXING,
        );
        let needs_partially_bound =
            requested_features.intersects(wgt::Features::PARTIALLY_BOUND_BINDING_ARRAY);

        Self {
            // vk::PhysicalDeviceFeatures is a struct composed of Bool32's while
            // Features is a bitfield so we need to map everything manually
            core: vk::PhysicalDeviceFeatures::default()
                .robust_buffer_access(private_caps.robust_buffer_access)
                .independent_blend(downlevel_flags.contains(wgt::DownlevelFlags::INDEPENDENT_BLEND))
                .sample_rate_shading(
                    downlevel_flags.contains(wgt::DownlevelFlags::MULTISAMPLED_SHADING),
                )
                .image_cube_array(
                    downlevel_flags.contains(wgt::DownlevelFlags::CUBE_ARRAY_TEXTURES),
                )
                .draw_indirect_first_instance(
                    requested_features.contains(wgt::Features::INDIRECT_FIRST_INSTANCE),
                )
                //.dual_src_blend(requested_features.contains(wgt::Features::DUAL_SRC_BLENDING))
                .multi_draw_indirect(
                    requested_features.contains(wgt::Features::MULTI_DRAW_INDIRECT),
                )
                .fill_mode_non_solid(requested_features.intersects(
                    wgt::Features::POLYGON_MODE_LINE | wgt::Features::POLYGON_MODE_POINT,
                ))
                //.depth_bounds(requested_features.contains(wgt::Features::DEPTH_BOUNDS))
                //.alpha_to_one(requested_features.contains(wgt::Features::ALPHA_TO_ONE))
                //.multi_viewport(requested_features.contains(wgt::Features::MULTI_VIEWPORTS))
                .sampler_anisotropy(
                    downlevel_flags.contains(wgt::DownlevelFlags::ANISOTROPIC_FILTERING),
                )
                .texture_compression_etc2(
                    requested_features.contains(wgt::Features::TEXTURE_COMPRESSION_ETC2),
                )
                .texture_compression_astc_ldr(
                    requested_features.contains(wgt::Features::TEXTURE_COMPRESSION_ASTC),
                )
                .texture_compression_bc(
                    requested_features.contains(wgt::Features::TEXTURE_COMPRESSION_BC),
                    // BC provides formats for Sliced 3D
                )
                //.occlusion_query_precise(requested_features.contains(wgt::Features::PRECISE_OCCLUSION_QUERY))
                .pipeline_statistics_query(
                    requested_features.contains(wgt::Features::PIPELINE_STATISTICS_QUERY),
                )
                .vertex_pipeline_stores_and_atomics(
                    requested_features.contains(wgt::Features::VERTEX_WRITABLE_STORAGE),
                )
                .fragment_stores_and_atomics(
                    downlevel_flags.contains(wgt::DownlevelFlags::FRAGMENT_WRITABLE_STORAGE),
                )
                //.shader_image_gather_extended(
                //.shader_storage_image_extended_formats(
                .shader_uniform_buffer_array_dynamic_indexing(
                    requested_features.contains(wgt::Features::BUFFER_BINDING_ARRAY),
                )
                .shader_storage_buffer_array_dynamic_indexing(requested_features.contains(
                    wgt::Features::BUFFER_BINDING_ARRAY
                        | wgt::Features::STORAGE_RESOURCE_BINDING_ARRAY,
                ))
                .shader_sampled_image_array_dynamic_indexing(
                    requested_features.contains(wgt::Features::TEXTURE_BINDING_ARRAY),
                )
                .shader_storage_buffer_array_dynamic_indexing(requested_features.contains(
                    wgt::Features::TEXTURE_BINDING_ARRAY
                        | wgt::Features::STORAGE_RESOURCE_BINDING_ARRAY,
                ))
                //.shader_storage_image_array_dynamic_indexing(
                //.shader_clip_distance(requested_features.contains(wgt::Features::SHADER_CLIP_DISTANCE))
                //.shader_cull_distance(requested_features.contains(wgt::Features::SHADER_CULL_DISTANCE))
                .shader_float64(requested_features.contains(wgt::Features::SHADER_F64))
                .shader_int64(requested_features.contains(wgt::Features::SHADER_INT64))
                .shader_int16(requested_features.contains(wgt::Features::SHADER_I16))
                //.shader_resource_residency(requested_features.contains(wgt::Features::SHADER_RESOURCE_RESIDENCY))
                .geometry_shader(requested_features.contains(wgt::Features::SHADER_PRIMITIVE_INDEX))
                .depth_clamp(requested_features.contains(wgt::Features::DEPTH_CLIP_CONTROL))
                .dual_src_blend(requested_features.contains(wgt::Features::DUAL_SOURCE_BLENDING)),
            descriptor_indexing: if requested_features.intersects(INDEXING_FEATURES) {
                Some(
                    vk::PhysicalDeviceDescriptorIndexingFeaturesEXT::default()
                        .shader_sampled_image_array_non_uniform_indexing(needs_bindless)
                        .shader_storage_image_array_non_uniform_indexing(needs_bindless)
                        .shader_storage_buffer_array_non_uniform_indexing(needs_bindless)
                        .descriptor_binding_sampled_image_update_after_bind(needs_bindless)
                        .descriptor_binding_storage_image_update_after_bind(needs_bindless)
                        .descriptor_binding_storage_buffer_update_after_bind(needs_bindless)
                        .descriptor_binding_partially_bound(needs_partially_bound),
                )
            } else {
                None
            },
            imageless_framebuffer: if device_api_version >= vk::API_VERSION_1_2
                || enabled_extensions.contains(&khr::imageless_framebuffer::NAME)
            {
                Some(
                    vk::PhysicalDeviceImagelessFramebufferFeaturesKHR::default()
                        .imageless_framebuffer(private_caps.imageless_framebuffers),
                )
            } else {
                None
            },
            timeline_semaphore: if device_api_version >= vk::API_VERSION_1_2
                || enabled_extensions.contains(&khr::timeline_semaphore::NAME)
            {
                Some(
                    vk::PhysicalDeviceTimelineSemaphoreFeaturesKHR::default()
                        .timeline_semaphore(private_caps.timeline_semaphores),
                )
            } else {
                None
            },
            image_robustness: if device_api_version >= vk::API_VERSION_1_3
                || enabled_extensions.contains(&ext::image_robustness::NAME)
            {
                Some(
                    vk::PhysicalDeviceImageRobustnessFeaturesEXT::default()
                        .robust_image_access(private_caps.robust_image_access),
                )
            } else {
                None
            },
            robustness2: if enabled_extensions.contains(&ext::robustness2::NAME) {
                Some(
                    vk::PhysicalDeviceRobustness2FeaturesEXT::default()
                        .robust_buffer_access2(private_caps.robust_buffer_access2)
                        .robust_image_access2(private_caps.robust_image_access2),
                )
            } else {
                None
            },
            multiview: if device_api_version >= vk::API_VERSION_1_1
                || enabled_extensions.contains(&khr::multiview::NAME)
            {
                Some(
                    vk::PhysicalDeviceMultiviewFeatures::default()
                        .multiview(requested_features.contains(wgt::Features::MULTIVIEW)),
                )
            } else {
                None
            },
            sampler_ycbcr_conversion: if device_api_version >= vk::API_VERSION_1_1
                || enabled_extensions.contains(&khr::sampler_ycbcr_conversion::NAME)
            {
                Some(
                    vk::PhysicalDeviceSamplerYcbcrConversionFeatures::default(), // .sampler_ycbcr_conversion(requested_features.contains(wgt::Features::TEXTURE_FORMAT_NV12))
                )
            } else {
                None
            },
            astc_hdr: if enabled_extensions.contains(&ext::texture_compression_astc_hdr::NAME) {
                Some(
                    vk::PhysicalDeviceTextureCompressionASTCHDRFeaturesEXT::default()
                        .texture_compression_astc_hdr(true),
                )
            } else {
                None
            },
            shader_float16: if requested_features.contains(wgt::Features::SHADER_F16) {
                Some((
                    vk::PhysicalDeviceShaderFloat16Int8Features::default().shader_float16(true),
                    vk::PhysicalDevice16BitStorageFeatures::default()
                        .storage_buffer16_bit_access(true)
                        .storage_input_output16(true)
                        .uniform_and_storage_buffer16_bit_access(true),
                ))
            } else {
                None
            },
            acceleration_structure: if enabled_extensions
                .contains(&khr::acceleration_structure::NAME)
            {
                Some(
                    vk::PhysicalDeviceAccelerationStructureFeaturesKHR::default()
                        .acceleration_structure(true),
                )
            } else {
                None
            },
            buffer_device_address: if enabled_extensions.contains(&khr::buffer_device_address::NAME)
            {
                Some(
                    vk::PhysicalDeviceBufferDeviceAddressFeaturesKHR::default()
                        .buffer_device_address(true),
                )
            } else {
                None
            },
            ray_query: if enabled_extensions.contains(&khr::ray_query::NAME) {
                Some(vk::PhysicalDeviceRayQueryFeaturesKHR::default().ray_query(true))
            } else {
                None
            },
            zero_initialize_workgroup_memory: if device_api_version >= vk::API_VERSION_1_3
                || enabled_extensions.contains(&khr::zero_initialize_workgroup_memory::NAME)
            {
                Some(
                    vk::PhysicalDeviceZeroInitializeWorkgroupMemoryFeatures::default()
                        .shader_zero_initialize_workgroup_memory(
                            private_caps.zero_initialize_workgroup_memory,
                        ),
                )
            } else {
                None
            },
            shader_atomic_int64: if device_api_version >= vk::API_VERSION_1_2
                || enabled_extensions.contains(&khr::shader_atomic_int64::NAME)
            {
                let needed = requested_features.intersects(
                    wgt::Features::SHADER_INT64_ATOMIC_ALL_OPS
                        | wgt::Features::SHADER_INT64_ATOMIC_MIN_MAX,
                );
                Some(
                    vk::PhysicalDeviceShaderAtomicInt64Features::default()
                        .shader_buffer_int64_atomics(needed)
                        .shader_shared_int64_atomics(needed),
                )
            } else {
                None
            },
            shader_image_atomic_int64: if enabled_extensions
                .contains(&ext::shader_image_atomic_int64::NAME)
            {
                let needed = requested_features.intersects(wgt::Features::TEXTURE_INT64_ATOMIC);
                Some(
                    vk::PhysicalDeviceShaderImageAtomicInt64FeaturesEXT::default()
                        .shader_image_int64_atomics(needed),
                )
            } else {
                None
            },
            shader_atomic_float: if enabled_extensions.contains(&ext::shader_atomic_float::NAME) {
                let needed = requested_features.contains(wgt::Features::SHADER_FLOAT32_ATOMIC);
                Some(
                    vk::PhysicalDeviceShaderAtomicFloatFeaturesEXT::default()
                        .shader_buffer_float32_atomics(needed)
                        .shader_buffer_float32_atomic_add(needed),
                )
            } else {
                None
            },
            subgroup_size_control: if device_api_version >= vk::API_VERSION_1_3
                || enabled_extensions.contains(&ext::subgroup_size_control::NAME)
            {
                Some(
                    vk::PhysicalDeviceSubgroupSizeControlFeatures::default()
                        .subgroup_size_control(true),
                )
            } else {
                None
            },
            position_fetch: if enabled_extensions.contains(&khr::ray_tracing_position_fetch::NAME) {
                Some(
                    vk::PhysicalDeviceRayTracingPositionFetchFeaturesKHR::default()
                        .ray_tracing_position_fetch(true),
                )
            } else {
                None
            },
            mesh_shader: if enabled_extensions.contains(&ext::mesh_shader::NAME) {
                let needed = requested_features.contains(wgt::Features::EXPERIMENTAL_MESH_SHADER);
                let multiview_needed =
                    requested_features.contains(wgt::Features::EXPERIMENTAL_MESH_SHADER_MULTIVIEW);
                Some(
                    vk::PhysicalDeviceMeshShaderFeaturesEXT::default()
                        .mesh_shader(needed)
                        .task_shader(needed)
                        .multiview_mesh_shader(multiview_needed),
                )
            } else {
                None
            },
            maintenance4: if enabled_extensions.contains(&khr::maintenance4::NAME) {
                let needed = requested_features.contains(wgt::Features::EXPERIMENTAL_MESH_SHADER);
                Some(vk::PhysicalDeviceMaintenance4FeaturesKHR::default().maintenance4(needed))
            } else {
                None
            },
        }
    }

    /// Compute the wgpu [`Features`] and [`DownlevelFlags`] supported by a physical device.
    ///
    /// Given `self`, together with the instance and physical device it was
    /// built from, and a `caps` also built from those, determine which wgpu
    /// features and downlevel flags the device can support.
    ///
    /// [`Features`]: wgt::Features
    /// [`DownlevelFlags`]: wgt::DownlevelFlags
    fn to_wgpu(
        &self,
        instance: &ash::Instance,
        phd: vk::PhysicalDevice,
        caps: &PhysicalDeviceProperties,
    ) -> (wgt::Features, wgt::DownlevelFlags) {
        use wgt::{DownlevelFlags as Df, Features as F};
        let mut features = F::empty()
            | F::SPIRV_SHADER_PASSTHROUGH
            | F::MAPPABLE_PRIMARY_BUFFERS
            | F::PUSH_CONSTANTS
            | F::ADDRESS_MODE_CLAMP_TO_BORDER
            | F::ADDRESS_MODE_CLAMP_TO_ZERO
            | F::TIMESTAMP_QUERY
            | F::TIMESTAMP_QUERY_INSIDE_ENCODERS
            | F::TIMESTAMP_QUERY_INSIDE_PASSES
            | F::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES
            | F::CLEAR_TEXTURE
            | F::PIPELINE_CACHE
            | F::TEXTURE_ATOMIC;

        let mut dl_flags = Df::COMPUTE_SHADERS
            | Df::BASE_VERTEX
            | Df::READ_ONLY_DEPTH_STENCIL
            | Df::NON_POWER_OF_TWO_MIPMAPPED_TEXTURES
            | Df::COMPARISON_SAMPLERS
            | Df::VERTEX_STORAGE
            | Df::FRAGMENT_STORAGE
            | Df::DEPTH_TEXTURE_AND_BUFFER_COPIES
            | Df::BUFFER_BINDINGS_NOT_16_BYTE_ALIGNED
            | Df::UNRESTRICTED_INDEX_BUFFER
            | Df::INDIRECT_EXECUTION
            | Df::VIEW_FORMATS
            | Df::UNRESTRICTED_EXTERNAL_TEXTURE_COPIES
            | Df::NONBLOCKING_QUERY_RESOLVE
            | Df::VERTEX_AND_INSTANCE_INDEX_RESPECTS_RESPECTIVE_FIRST_VALUE_IN_INDIRECT_DRAW;

        dl_flags.set(
            Df::SURFACE_VIEW_FORMATS,
            caps.supports_extension(khr::swapchain_mutable_format::NAME),
        );
        dl_flags.set(Df::CUBE_ARRAY_TEXTURES, self.core.image_cube_array != 0);
        dl_flags.set(Df::ANISOTROPIC_FILTERING, self.core.sampler_anisotropy != 0);
        dl_flags.set(
            Df::FRAGMENT_WRITABLE_STORAGE,
            self.core.fragment_stores_and_atomics != 0,
        );
        dl_flags.set(Df::MULTISAMPLED_SHADING, self.core.sample_rate_shading != 0);
        dl_flags.set(Df::INDEPENDENT_BLEND, self.core.independent_blend != 0);
        dl_flags.set(
            Df::FULL_DRAW_INDEX_UINT32,
            self.core.full_draw_index_uint32 != 0,
        );
        dl_flags.set(Df::DEPTH_BIAS_CLAMP, self.core.depth_bias_clamp != 0);

        features.set(
            F::INDIRECT_FIRST_INSTANCE,
            self.core.draw_indirect_first_instance != 0,
        );
        //if self.core.dual_src_blend != 0
        features.set(F::MULTI_DRAW_INDIRECT, self.core.multi_draw_indirect != 0);
        features.set(F::POLYGON_MODE_LINE, self.core.fill_mode_non_solid != 0);
        features.set(F::POLYGON_MODE_POINT, self.core.fill_mode_non_solid != 0);
        //if self.core.depth_bounds != 0 {
        //if self.core.alpha_to_one != 0 {
        //if self.core.multi_viewport != 0 {
        features.set(
            F::TEXTURE_COMPRESSION_ETC2,
            self.core.texture_compression_etc2 != 0,
        );
        features.set(
            F::TEXTURE_COMPRESSION_ASTC,
            self.core.texture_compression_astc_ldr != 0,
        );
        features.set(
            F::TEXTURE_COMPRESSION_BC,
            self.core.texture_compression_bc != 0,
        );
        features.set(
            F::TEXTURE_COMPRESSION_BC_SLICED_3D,
            self.core.texture_compression_bc != 0, // BC guarantees Sliced 3D
        );
        features.set(
            F::PIPELINE_STATISTICS_QUERY,
            self.core.pipeline_statistics_query != 0,
        );
        features.set(
            F::VERTEX_WRITABLE_STORAGE,
            self.core.vertex_pipeline_stores_and_atomics != 0,
        );

        features.set(F::SHADER_F64, self.core.shader_float64 != 0);
        features.set(F::SHADER_INT64, self.core.shader_int64 != 0);
        features.set(F::SHADER_I16, self.core.shader_int16 != 0);

        features.set(F::SHADER_PRIMITIVE_INDEX, self.core.geometry_shader != 0);

        if let Some(ref shader_atomic_int64) = self.shader_atomic_int64 {
            features.set(
                F::SHADER_INT64_ATOMIC_ALL_OPS | F::SHADER_INT64_ATOMIC_MIN_MAX,
                shader_atomic_int64.shader_buffer_int64_atomics != 0
                    && shader_atomic_int64.shader_shared_int64_atomics != 0,
            );
        }

        if let Some(ref shader_image_atomic_int64) = self.shader_image_atomic_int64 {
            features.set(
                F::TEXTURE_INT64_ATOMIC,
                shader_image_atomic_int64
                    .shader_image_int64_atomics(true)
                    .shader_image_int64_atomics
                    != 0,
            );
        }

        if let Some(ref shader_atomic_float) = self.shader_atomic_float {
            features.set(
                F::SHADER_FLOAT32_ATOMIC,
                shader_atomic_float.shader_buffer_float32_atomics != 0
                    && shader_atomic_float.shader_buffer_float32_atomic_add != 0,
            );
        }

        //if caps.supports_extension(khr::sampler_mirror_clamp_to_edge::NAME) {
        //if caps.supports_extension(ext::sampler_filter_minmax::NAME) {
        features.set(
            F::MULTI_DRAW_INDIRECT_COUNT,
            caps.supports_extension(khr::draw_indirect_count::NAME),
        );
        features.set(
            F::CONSERVATIVE_RASTERIZATION,
            caps.supports_extension(ext::conservative_rasterization::NAME),
        );
        features.set(
            F::EXPERIMENTAL_RAY_HIT_VERTEX_RETURN,
            caps.supports_extension(khr::ray_tracing_position_fetch::NAME),
        );

        if let Some(ref descriptor_indexing) = self.descriptor_indexing {
            // We use update-after-bind descriptors for all bind groups containing binding arrays.
            //
            // In those bind groups, we allow all binding types except uniform buffers to be present.
            //
            // As we can only switch between update-after-bind and not on a per bind group basis,
            // all supported binding types need to be able to be marked update after bind.
            //
            // As such, we enable all features as a whole, rather individually.
            let supports_descriptor_indexing =
                // Sampled Images
                descriptor_indexing.shader_sampled_image_array_non_uniform_indexing != 0
                    && descriptor_indexing.descriptor_binding_sampled_image_update_after_bind != 0
                    // Storage Images
                    && descriptor_indexing.shader_storage_image_array_non_uniform_indexing != 0
                    && descriptor_indexing.descriptor_binding_storage_image_update_after_bind != 0
                    // Storage Buffers
                    && descriptor_indexing.shader_storage_buffer_array_non_uniform_indexing != 0
                    && descriptor_indexing.descriptor_binding_storage_buffer_update_after_bind != 0;

            let descriptor_indexing_features = F::BUFFER_BINDING_ARRAY
                | F::TEXTURE_BINDING_ARRAY
                | F::STORAGE_RESOURCE_BINDING_ARRAY
                | F::SAMPLED_TEXTURE_AND_STORAGE_BUFFER_ARRAY_NON_UNIFORM_INDEXING
                | F::STORAGE_TEXTURE_ARRAY_NON_UNIFORM_INDEXING;

            features.set(descriptor_indexing_features, supports_descriptor_indexing);

            let supports_partially_bound =
                descriptor_indexing.descriptor_binding_partially_bound != 0;

            features.set(F::PARTIALLY_BOUND_BINDING_ARRAY, supports_partially_bound);
        }

        features.set(F::DEPTH_CLIP_CONTROL, self.core.depth_clamp != 0);
        features.set(F::DUAL_SOURCE_BLENDING, self.core.dual_src_blend != 0);

        if let Some(ref multiview) = self.multiview {
            features.set(F::MULTIVIEW, multiview.multiview != 0);
        }

        features.set(
            F::TEXTURE_FORMAT_16BIT_NORM,
            is_format_16bit_norm_supported(instance, phd),
        );

        if let Some(ref astc_hdr) = self.astc_hdr {
            features.set(
                F::TEXTURE_COMPRESSION_ASTC_HDR,
                astc_hdr.texture_compression_astc_hdr != 0,
            );
        }

        if let Some((ref f16_i8, ref bit16)) = self.shader_float16 {
            features.set(
                F::SHADER_F16,
                f16_i8.shader_float16 != 0
                    && bit16.storage_buffer16_bit_access != 0
                    && bit16.uniform_and_storage_buffer16_bit_access != 0
                    && bit16.storage_input_output16 != 0,
            );
        }

        if let Some(ref subgroup) = caps.subgroup {
            if (caps.device_api_version >= vk::API_VERSION_1_3
                || caps.supports_extension(ext::subgroup_size_control::NAME))
                && subgroup.supported_operations.contains(
                    vk::SubgroupFeatureFlags::BASIC
                        | vk::SubgroupFeatureFlags::VOTE
                        | vk::SubgroupFeatureFlags::ARITHMETIC
                        | vk::SubgroupFeatureFlags::BALLOT
                        | vk::SubgroupFeatureFlags::SHUFFLE
                        | vk::SubgroupFeatureFlags::SHUFFLE_RELATIVE,
                )
            {
                features.set(
                    F::SUBGROUP,
                    subgroup
                        .supported_stages
                        .contains(vk::ShaderStageFlags::COMPUTE | vk::ShaderStageFlags::FRAGMENT),
                );
                features.set(
                    F::SUBGROUP_VERTEX,
                    subgroup
                        .supported_stages
                        .contains(vk::ShaderStageFlags::VERTEX),
                );
                features.insert(F::SUBGROUP_BARRIER);
            }
        }

        let supports_depth_format = |format| {
            supports_format(
                instance,
                phd,
                format,
                vk::ImageTiling::OPTIMAL,
                depth_stencil_required_flags(),
            )
        };

        let texture_s8 = supports_depth_format(vk::Format::S8_UINT);
        let texture_d32 = supports_depth_format(vk::Format::D32_SFLOAT);
        let texture_d24_s8 = supports_depth_format(vk::Format::D24_UNORM_S8_UINT);
        let texture_d32_s8 = supports_depth_format(vk::Format::D32_SFLOAT_S8_UINT);

        let stencil8 = texture_s8 || texture_d24_s8;
        let depth24_plus_stencil8 = texture_d24_s8 || texture_d32_s8;

        dl_flags.set(
            Df::WEBGPU_TEXTURE_FORMAT_SUPPORT,
            stencil8 && depth24_plus_stencil8 && texture_d32,
        );

        features.set(F::DEPTH32FLOAT_STENCIL8, texture_d32_s8);

        features.set(
            F::EXPERIMENTAL_RAY_TRACING_ACCELERATION_STRUCTURE,
            caps.supports_extension(khr::deferred_host_operations::NAME)
                && caps.supports_extension(khr::acceleration_structure::NAME)
                && caps.supports_extension(khr::buffer_device_address::NAME),
        );

        features.set(
            F::EXPERIMENTAL_RAY_QUERY,
            caps.supports_extension(khr::ray_query::NAME),
        );

        let rg11b10ufloat_renderable = supports_format(
            instance,
            phd,
            vk::Format::B10G11R11_UFLOAT_PACK32,
            vk::ImageTiling::OPTIMAL,
            vk::FormatFeatureFlags::COLOR_ATTACHMENT
                | vk::FormatFeatureFlags::COLOR_ATTACHMENT_BLEND,
        );
        features.set(F::RG11B10UFLOAT_RENDERABLE, rg11b10ufloat_renderable);

        features.set(
            F::BGRA8UNORM_STORAGE,
            supports_bgra8unorm_storage(instance, phd, caps.device_api_version),
        );

        features.set(
            F::FLOAT32_FILTERABLE,
            is_float32_filterable_supported(instance, phd),
        );

        if let Some(ref _sampler_ycbcr_conversion) = self.sampler_ycbcr_conversion {
            features.set(
                F::TEXTURE_FORMAT_NV12,
                supports_format(
                    instance,
                    phd,
                    vk::Format::G8_B8R8_2PLANE_420_UNORM,
                    vk::ImageTiling::OPTIMAL,
                    vk::FormatFeatureFlags::SAMPLED_IMAGE
                        | vk::FormatFeatureFlags::TRANSFER_SRC
                        | vk::FormatFeatureFlags::TRANSFER_DST,
                ) && !caps
                    .driver
                    .map(|driver| driver.driver_id == vk::DriverId::MOLTENVK)
                    .unwrap_or_default(),
            );
        }

        features.set(
            F::VULKAN_GOOGLE_DISPLAY_TIMING,
            caps.supports_extension(google::display_timing::NAME),
        );

        features.set(
            F::VULKAN_EXTERNAL_MEMORY_WIN32,
            caps.supports_extension(khr::external_memory_win32::NAME),
        );
        features.set(
            F::EXPERIMENTAL_MESH_SHADER,
            caps.supports_extension(ext::mesh_shader::NAME),
        );
        if let Some(ref mesh_shader) = self.mesh_shader {
            features.set(
                F::EXPERIMENTAL_MESH_SHADER_MULTIVIEW,
                mesh_shader.multiview_mesh_shader != 0,
            );
        }
        (features, dl_flags)
    }
}

/// Vulkan "properties" structures gathered about a physical device.
///
/// This structure holds the properties of a [`vk::PhysicalDevice`]:
/// - the standard Vulkan device properties
/// - the `VkExtensionProperties` structs for all available extensions, and
/// - the per-extension properties structures for the available extensions that
///   `wgpu` cares about.
///
/// Generally, if you get it from any of these functions, it's stored
/// here:
/// - `vkEnumerateDeviceExtensionProperties`
/// - `vkGetPhysicalDeviceProperties`
/// - `vkGetPhysicalDeviceProperties2`
///
/// This also includes a copy of the device API version, since we can
/// use that as a shortcut for searching for an extension, if the
/// extension has been promoted to core in the current version.
///
/// This does not include device features; for those, see
/// [`PhysicalDeviceFeatures`].
#[derive(Default, Debug)]
pub struct PhysicalDeviceProperties {
    /// Extensions supported by the `vk::PhysicalDevice`,
    /// as returned by `vkEnumerateDeviceExtensionProperties`.
    supported_extensions: Vec<vk::ExtensionProperties>,

    /// Properties of the `vk::PhysicalDevice`, as returned by
    /// `vkGetPhysicalDeviceProperties`.
    properties: vk::PhysicalDeviceProperties,

    /// Additional `vk::PhysicalDevice` properties from the
    /// `VK_KHR_maintenance3` extension, promoted to Vulkan 1.1.
    maintenance_3: Option<vk::PhysicalDeviceMaintenance3Properties<'static>>,

    /// Additional `vk::PhysicalDevice` properties from the
    /// `VK_EXT_descriptor_indexing` extension, promoted to Vulkan 1.2.
    descriptor_indexing: Option<vk::PhysicalDeviceDescriptorIndexingPropertiesEXT<'static>>,

    /// Additional `vk::PhysicalDevice` properties from the
    /// `VK_KHR_acceleration_structure` extension.
    acceleration_structure: Option<vk::PhysicalDeviceAccelerationStructurePropertiesKHR<'static>>,

    /// Additional `vk::PhysicalDevice` properties from the
    /// `VK_KHR_driver_properties` extension, promoted to Vulkan 1.2.
    driver: Option<vk::PhysicalDeviceDriverPropertiesKHR<'static>>,

    /// Additional `vk::PhysicalDevice` properties from Vulkan 1.1.
    subgroup: Option<vk::PhysicalDeviceSubgroupProperties<'static>>,

    /// Additional `vk::PhysicalDevice` properties from the
    /// `VK_EXT_subgroup_size_control` extension, promoted to Vulkan 1.3.
    subgroup_size_control: Option<vk::PhysicalDeviceSubgroupSizeControlProperties<'static>>,

    /// Additional `vk::PhysicalDevice` properties from the
    /// `VK_EXT_robustness2` extension.
    robustness2: Option<vk::PhysicalDeviceRobustness2PropertiesEXT<'static>>,

    /// Additional `vk::PhysicalDevice` properties from the
    /// `VK_EXT_mesh_shader` extension.
    _mesh_shader: Option<vk::PhysicalDeviceMeshShaderPropertiesEXT<'static>>,

    /// The device API version.
    ///
    /// Which is the version of Vulkan supported for device-level functionality.
    ///
    /// It is associated with a `VkPhysicalDevice` and its children.
    device_api_version: u32,
}

impl PhysicalDeviceProperties {
    pub fn properties(&self) -> vk::PhysicalDeviceProperties {
        self.properties
    }

    pub fn supports_extension(&self, extension: &CStr) -> bool {
        self.supported_extensions
            .iter()
            .any(|ep| ep.extension_name_as_c_str() == Ok(extension))
    }

    /// Map `requested_features` to the list of Vulkan extension strings required to create the logical device.
    fn get_required_extensions(&self, requested_features: wgt::Features) -> Vec<&'static CStr> {
        let mut extensions = Vec::new();

        // Note that quite a few extensions depend on the `VK_KHR_get_physical_device_properties2` instance extension.
        // We enable `VK_KHR_get_physical_device_properties2` unconditionally (if available).

        // Require `VK_KHR_swapchain`
        extensions.push(khr::swapchain::NAME);

        if self.device_api_version < vk::API_VERSION_1_1 {
            // Require either `VK_KHR_maintenance1` or `VK_AMD_negative_viewport_height`
            if self.supports_extension(khr::maintenance1::NAME) {
                extensions.push(khr::maintenance1::NAME);
            } else {
                // `VK_AMD_negative_viewport_height` is obsoleted by `VK_KHR_maintenance1` and must not be enabled alongside it
                extensions.push(amd::negative_viewport_height::NAME);
            }

            // Optional `VK_KHR_maintenance2`
            if self.supports_extension(khr::maintenance2::NAME) {
                extensions.push(khr::maintenance2::NAME);
            }

            // Optional `VK_KHR_maintenance3`
            if self.supports_extension(khr::maintenance3::NAME) {
                extensions.push(khr::maintenance3::NAME);
            }

            // Require `VK_KHR_storage_buffer_storage_class`
            extensions.push(khr::storage_buffer_storage_class::NAME);

            // Require `VK_KHR_multiview` if the associated feature was requested
            if requested_features.contains(wgt::Features::MULTIVIEW) {
                extensions.push(khr::multiview::NAME);
            }

            // Require `VK_KHR_sampler_ycbcr_conversion` if the associated feature was requested
            if requested_features.contains(wgt::Features::TEXTURE_FORMAT_NV12) {
                extensions.push(khr::sampler_ycbcr_conversion::NAME);
            }
        }

        if self.device_api_version < vk::API_VERSION_1_2 {
            // Optional `VK_KHR_image_format_list`
            if self.supports_extension(khr::image_format_list::NAME) {
                extensions.push(khr::image_format_list::NAME);
            }

            // Optional `VK_KHR_imageless_framebuffer`
            if self.supports_extension(khr::imageless_framebuffer::NAME) {
                extensions.push(khr::imageless_framebuffer::NAME);
                // Require `VK_KHR_maintenance2` due to it being a dependency
                if self.device_api_version < vk::API_VERSION_1_1 {
                    extensions.push(khr::maintenance2::NAME);
                }
            }

            // Optional `VK_KHR_driver_properties`
            if self.supports_extension(khr::driver_properties::NAME) {
                extensions.push(khr::driver_properties::NAME);
            }

            // Optional `VK_KHR_timeline_semaphore`
            if self.supports_extension(khr::timeline_semaphore::NAME) {
                extensions.push(khr::timeline_semaphore::NAME);
            }

            // Require `VK_EXT_descriptor_indexing` if one of the associated features was requested
            if requested_features.intersects(INDEXING_FEATURES) {
                extensions.push(ext::descriptor_indexing::NAME);
            }

            // Require `VK_KHR_shader_float16_int8` and `VK_KHR_16bit_storage` if the associated feature was requested
            if requested_features.contains(wgt::Features::SHADER_F16) {
                extensions.push(khr::shader_float16_int8::NAME);
                // `VK_KHR_16bit_storage` requires `VK_KHR_storage_buffer_storage_class`, however we require that one already
                if self.device_api_version < vk::API_VERSION_1_1 {
                    extensions.push(khr::_16bit_storage::NAME);
                }
            }

            if requested_features.intersects(wgt::Features::EXPERIMENTAL_MESH_SHADER) {
                extensions.push(khr::spirv_1_4::NAME);
            }

            //extensions.push(khr::sampler_mirror_clamp_to_edge::NAME);
            //extensions.push(ext::sampler_filter_minmax::NAME);
        }

        if self.device_api_version < vk::API_VERSION_1_3 {
            // Optional `VK_EXT_image_robustness`
            if self.supports_extension(ext::image_robustness::NAME) {
                extensions.push(ext::image_robustness::NAME);
            }

            // Require `VK_EXT_subgroup_size_control` if the associated feature was requested
            if requested_features.contains(wgt::Features::SUBGROUP) {
                extensions.push(ext::subgroup_size_control::NAME);
            }

            if requested_features.intersects(wgt::Features::EXPERIMENTAL_MESH_SHADER) {
                extensions.push(khr::maintenance4::NAME);
            }
        }

        // Optional `VK_KHR_swapchain_mutable_format`
        if self.supports_extension(khr::swapchain_mutable_format::NAME) {
            extensions.push(khr::swapchain_mutable_format::NAME);
        }

        // Optional `VK_EXT_robustness2`
        if self.supports_extension(ext::robustness2::NAME) {
            extensions.push(ext::robustness2::NAME);
        }

        // Optional `VK_KHR_external_memory_win32`
        if self.supports_extension(khr::external_memory_win32::NAME) {
            extensions.push(khr::external_memory_win32::NAME);
        }

        // Optional `VK_KHR_external_memory_fd`
        if self.supports_extension(khr::external_memory_fd::NAME) {
            extensions.push(khr::external_memory_fd::NAME);
        }

        // Optional `VK_EXT_external_memory_dma`
        if self.supports_extension(ext::external_memory_dma_buf::NAME) {
            extensions.push(ext::external_memory_dma_buf::NAME);
        }

        // Require `VK_KHR_draw_indirect_count` if the associated feature was requested
        // Even though Vulkan 1.2 has promoted the extension to core, we must require the extension to avoid
        // large amounts of spaghetti involved with using PhysicalDeviceVulkan12Features.
        if requested_features.contains(wgt::Features::MULTI_DRAW_INDIRECT_COUNT) {
            extensions.push(khr::draw_indirect_count::NAME);
        }

        // Require `VK_KHR_deferred_host_operations`, `VK_KHR_acceleration_structure` and `VK_KHR_buffer_device_address` if the feature `RAY_TRACING` was requested
        if requested_features
            .contains(wgt::Features::EXPERIMENTAL_RAY_TRACING_ACCELERATION_STRUCTURE)
        {
            extensions.push(khr::deferred_host_operations::NAME);
            extensions.push(khr::acceleration_structure::NAME);
            extensions.push(khr::buffer_device_address::NAME);
        }

        // Require `VK_KHR_ray_query` if the associated feature was requested
        if requested_features.contains(wgt::Features::EXPERIMENTAL_RAY_QUERY) {
            extensions.push(khr::ray_query::NAME);
        }

        if requested_features.contains(wgt::Features::EXPERIMENTAL_RAY_HIT_VERTEX_RETURN) {
            extensions.push(khr::ray_tracing_position_fetch::NAME)
        }

        // Require `VK_EXT_conservative_rasterization` if the associated feature was requested
        if requested_features.contains(wgt::Features::CONSERVATIVE_RASTERIZATION) {
            extensions.push(ext::conservative_rasterization::NAME);
        }

        // Require `VK_KHR_portability_subset` on macOS/iOS
        #[cfg(target_vendor = "apple")]
        extensions.push(khr::portability_subset::NAME);

        // Require `VK_EXT_texture_compression_astc_hdr` if the associated feature was requested
        if requested_features.contains(wgt::Features::TEXTURE_COMPRESSION_ASTC_HDR) {
            extensions.push(ext::texture_compression_astc_hdr::NAME);
        }

        // Require `VK_KHR_shader_atomic_int64` if the associated feature was requested
        if requested_features.intersects(
            wgt::Features::SHADER_INT64_ATOMIC_ALL_OPS | wgt::Features::SHADER_INT64_ATOMIC_MIN_MAX,
        ) {
            extensions.push(khr::shader_atomic_int64::NAME);
        }

        // Require `VK_EXT_shader_image_atomic_int64` if the associated feature was requested
        if requested_features.intersects(wgt::Features::TEXTURE_INT64_ATOMIC) {
            extensions.push(ext::shader_image_atomic_int64::NAME);
        }

        // Require `VK_EXT_shader_atomic_float` if the associated feature was requested
        if requested_features.contains(wgt::Features::SHADER_FLOAT32_ATOMIC) {
            extensions.push(ext::shader_atomic_float::NAME);
        }

        // Require VK_GOOGLE_display_timing if the associated feature was requested
        if requested_features.contains(wgt::Features::VULKAN_GOOGLE_DISPLAY_TIMING) {
            extensions.push(google::display_timing::NAME);
        }

        if requested_features.contains(wgt::Features::EXPERIMENTAL_MESH_SHADER) {
            extensions.push(ext::mesh_shader::NAME);
        }

        extensions
    }

    fn to_wgpu_limits(&self) -> wgt::Limits {
        let limits = &self.properties.limits;

        let max_compute_workgroup_sizes = limits.max_compute_work_group_size;
        let max_compute_workgroups_per_dimension = limits.max_compute_work_group_count[0]
            .min(limits.max_compute_work_group_count[1])
            .min(limits.max_compute_work_group_count[2]);

        // Prevent very large buffers on mesa and most android devices.
        let is_nvidia = self.properties.vendor_id == crate::auxil::db::nvidia::VENDOR;
        let max_buffer_size =
            if (cfg!(target_os = "linux") || cfg!(target_os = "android")) && !is_nvidia {
                i32::MAX as u64
            } else {
                u64::MAX
            };

        let mut max_binding_array_elements = 0;
        let mut max_sampler_binding_array_elements = 0;
        if let Some(ref descriptor_indexing) = self.descriptor_indexing {
            max_binding_array_elements = descriptor_indexing
                .max_descriptor_set_update_after_bind_sampled_images
                .min(descriptor_indexing.max_descriptor_set_update_after_bind_storage_images)
                .min(descriptor_indexing.max_descriptor_set_update_after_bind_storage_buffers)
                .min(descriptor_indexing.max_per_stage_descriptor_update_after_bind_sampled_images)
                .min(descriptor_indexing.max_per_stage_descriptor_update_after_bind_storage_images)
                .min(
                    descriptor_indexing.max_per_stage_descriptor_update_after_bind_storage_buffers,
                );

            max_sampler_binding_array_elements = descriptor_indexing
                .max_descriptor_set_update_after_bind_samplers
                .min(descriptor_indexing.max_per_stage_descriptor_update_after_bind_samplers);
        }

        // TODO: programmatically determine this, if possible. It's unclear whether we can
        // as of https://github.com/gpuweb/gpuweb/issues/2965#issuecomment-1361315447.
        //
        // In theory some tilers may not support this much. We can't tell however, and
        // the driver will throw a DEVICE_REMOVED if it goes too high in usage. This is fine.
        //
        // 16 bytes per sample is the maximum size for a color attachment.
        let max_color_attachment_bytes_per_sample =
            limits.max_color_attachments * wgt::TextureFormat::MAX_TARGET_PIXEL_BYTE_COST;

        wgt::Limits {
            max_texture_dimension_1d: limits.max_image_dimension1_d,
            max_texture_dimension_2d: limits.max_image_dimension2_d,
            max_texture_dimension_3d: limits.max_image_dimension3_d,
            max_texture_array_layers: limits.max_image_array_layers,
            max_bind_groups: limits
                .max_bound_descriptor_sets
                .min(crate::MAX_BIND_GROUPS as u32),
            max_bindings_per_bind_group: wgt::Limits::default().max_bindings_per_bind_group,
            max_dynamic_uniform_buffers_per_pipeline_layout: limits
                .max_descriptor_set_uniform_buffers_dynamic,
            max_dynamic_storage_buffers_per_pipeline_layout: limits
                .max_descriptor_set_storage_buffers_dynamic,
            max_sampled_textures_per_shader_stage: limits.max_per_stage_descriptor_sampled_images,
            max_samplers_per_shader_stage: limits.max_per_stage_descriptor_samplers,
            max_storage_buffers_per_shader_stage: limits.max_per_stage_descriptor_storage_buffers,
            max_storage_textures_per_shader_stage: limits.max_per_stage_descriptor_storage_images,
            max_uniform_buffers_per_shader_stage: limits.max_per_stage_descriptor_uniform_buffers,
            max_binding_array_elements_per_shader_stage: max_binding_array_elements,
            max_binding_array_sampler_elements_per_shader_stage: max_sampler_binding_array_elements,
            max_uniform_buffer_binding_size: limits
                .max_uniform_buffer_range
                .min(crate::auxil::MAX_I32_BINDING_SIZE),
            max_storage_buffer_binding_size: limits
                .max_storage_buffer_range
                .min(crate::auxil::MAX_I32_BINDING_SIZE),
            max_vertex_buffers: limits
                .max_vertex_input_bindings
                .min(crate::MAX_VERTEX_BUFFERS as u32),
            max_vertex_attributes: limits.max_vertex_input_attributes,
            max_vertex_buffer_array_stride: limits.max_vertex_input_binding_stride,
            min_subgroup_size: self
                .subgroup_size_control
                .map(|subgroup_size| subgroup_size.min_subgroup_size)
                .unwrap_or(0),
            max_subgroup_size: self
                .subgroup_size_control
                .map(|subgroup_size| subgroup_size.max_subgroup_size)
                .unwrap_or(0),
            max_push_constant_size: limits.max_push_constants_size,
            min_uniform_buffer_offset_alignment: limits.min_uniform_buffer_offset_alignment as u32,
            min_storage_buffer_offset_alignment: limits.min_storage_buffer_offset_alignment as u32,
            max_inter_stage_shader_components: limits
                .max_vertex_output_components
                .min(limits.max_fragment_input_components),
            max_color_attachments: limits
                .max_color_attachments
                .min(crate::MAX_COLOR_ATTACHMENTS as u32),
            max_color_attachment_bytes_per_sample,
            max_compute_workgroup_storage_size: limits.max_compute_shared_memory_size,
            max_compute_invocations_per_workgroup: limits.max_compute_work_group_invocations,
            max_compute_workgroup_size_x: max_compute_workgroup_sizes[0],
            max_compute_workgroup_size_y: max_compute_workgroup_sizes[1],
            max_compute_workgroup_size_z: max_compute_workgroup_sizes[2],
            max_compute_workgroups_per_dimension,
            max_buffer_size,
            max_non_sampler_bindings: u32::MAX,
        }
    }

    /// Return a `wgpu_hal::Alignments` structure describing this adapter.
    ///
    /// The `using_robustness2` argument says how this adapter will implement
    /// `wgpu_hal`'s guarantee that shaders can only read the [accessible
    /// region][ar] of bindgroup's buffer bindings:
    ///
    /// - If this adapter will depend on `VK_EXT_robustness2`'s
    ///   `robustBufferAccess2` feature to apply bounds checks to shader buffer
    ///   access, `using_robustness2` must be `true`.
    ///
    /// - Otherwise, this adapter must use Naga to inject bounds checks on
    ///   buffer accesses, and `using_robustness2` must be `false`.
    ///
    /// [ar]: ../../struct.BufferBinding.html#accessible-region
    fn to_hal_alignments(&self, using_robustness2: bool) -> crate::Alignments {
        let limits = &self.properties.limits;
        crate::Alignments {
            buffer_copy_offset: wgt::BufferSize::new(limits.optimal_buffer_copy_offset_alignment)
                .unwrap(),
            buffer_copy_pitch: wgt::BufferSize::new(limits.optimal_buffer_copy_row_pitch_alignment)
                .unwrap(),
            uniform_bounds_check_alignment: {
                let alignment = if using_robustness2 {
                    self.robustness2
                        .unwrap() // if we're using it, we should have its properties
                        .robust_uniform_buffer_access_size_alignment
                } else {
                    // If the `robustness2` properties are unavailable, then `robustness2` is not available either Naga-injected bounds checks are precise.
                    1
                };
                wgt::BufferSize::new(alignment).unwrap()
            },
            raw_tlas_instance_size: 64,
            ray_tracing_scratch_buffer_alignment: self.acceleration_structure.map_or(
                0,
                |acceleration_structure| {
                    acceleration_structure.min_acceleration_structure_scratch_offset_alignment
                },
            ),
        }
    }
}

impl super::InstanceShared {
    fn inspect(
        &self,
        phd: vk::PhysicalDevice,
    ) -> (PhysicalDeviceProperties, PhysicalDeviceFeatures) {
        let capabilities = {
            let mut capabilities = PhysicalDeviceProperties::default();
            capabilities.supported_extensions =
                unsafe { self.raw.enumerate_device_extension_properties(phd).unwrap() };
            capabilities.properties = unsafe { self.raw.get_physical_device_properties(phd) };
            capabilities.device_api_version = capabilities.properties.api_version;

            if let Some(ref get_device_properties) = self.get_physical_device_properties {
                // Get these now to avoid borrowing conflicts later
                let supports_maintenance3 = capabilities.device_api_version >= vk::API_VERSION_1_1
                    || capabilities.supports_extension(khr::maintenance3::NAME);
                let supports_descriptor_indexing = capabilities.device_api_version
                    >= vk::API_VERSION_1_2
                    || capabilities.supports_extension(ext::descriptor_indexing::NAME);
                let supports_driver_properties = capabilities.device_api_version
                    >= vk::API_VERSION_1_2
                    || capabilities.supports_extension(khr::driver_properties::NAME);
                let supports_subgroup_size_control = capabilities.device_api_version
                    >= vk::API_VERSION_1_3
                    || capabilities.supports_extension(ext::subgroup_size_control::NAME);
                let supports_robustness2 = capabilities.supports_extension(ext::robustness2::NAME);

                let supports_acceleration_structure =
                    capabilities.supports_extension(khr::acceleration_structure::NAME);

                let supports_mesh_shader = capabilities.supports_extension(ext::mesh_shader::NAME);

                let mut properties2 = vk::PhysicalDeviceProperties2KHR::default();
                if supports_maintenance3 {
                    let next = capabilities
                        .maintenance_3
                        .insert(vk::PhysicalDeviceMaintenance3Properties::default());
                    properties2 = properties2.push_next(next);
                }

                if supports_descriptor_indexing {
                    let next = capabilities
                        .descriptor_indexing
                        .insert(vk::PhysicalDeviceDescriptorIndexingPropertiesEXT::default());
                    properties2 = properties2.push_next(next);
                }

                if supports_acceleration_structure {
                    let next = capabilities
                        .acceleration_structure
                        .insert(vk::PhysicalDeviceAccelerationStructurePropertiesKHR::default());
                    properties2 = properties2.push_next(next);
                }

                if supports_driver_properties {
                    let next = capabilities
                        .driver
                        .insert(vk::PhysicalDeviceDriverPropertiesKHR::default());
                    properties2 = properties2.push_next(next);
                }

                if capabilities.device_api_version >= vk::API_VERSION_1_1 {
                    let next = capabilities
                        .subgroup
                        .insert(vk::PhysicalDeviceSubgroupProperties::default());
                    properties2 = properties2.push_next(next);
                }

                if supports_subgroup_size_control {
                    let next = capabilities
                        .subgroup_size_control
                        .insert(vk::PhysicalDeviceSubgroupSizeControlProperties::default());
                    properties2 = properties2.push_next(next);
                }

                if supports_robustness2 {
                    let next = capabilities
                        .robustness2
                        .insert(vk::PhysicalDeviceRobustness2PropertiesEXT::default());
                    properties2 = properties2.push_next(next);
                }

                if supports_mesh_shader {
                    let next = capabilities
                        ._mesh_shader
                        .insert(vk::PhysicalDeviceMeshShaderPropertiesEXT::default());
                    properties2 = properties2.push_next(next);
                }

                unsafe {
                    get_device_properties.get_physical_device_properties2(phd, &mut properties2)
                };

                if is_intel_igpu_outdated_for_robustness2(
                    capabilities.properties,
                    capabilities.driver,
                ) {
                    capabilities
                        .supported_extensions
                        .retain(|&x| x.extension_name_as_c_str() != Ok(ext::robustness2::NAME));
                    capabilities.robustness2 = None;
                }
            };
            capabilities
        };

        let mut features = PhysicalDeviceFeatures::default();
        features.core = if let Some(ref get_device_properties) = self.get_physical_device_properties
        {
            let core = vk::PhysicalDeviceFeatures::default();
            let mut features2 = vk::PhysicalDeviceFeatures2KHR::default().features(core);

            // `VK_KHR_multiview` is promoted to 1.1
            if capabilities.device_api_version >= vk::API_VERSION_1_1
                || capabilities.supports_extension(khr::multiview::NAME)
            {
                let next = features
                    .multiview
                    .insert(vk::PhysicalDeviceMultiviewFeatures::default());
                features2 = features2.push_next(next);
            }

            // `VK_KHR_sampler_ycbcr_conversion` is promoted to 1.1
            if capabilities.device_api_version >= vk::API_VERSION_1_1
                || capabilities.supports_extension(khr::sampler_ycbcr_conversion::NAME)
            {
                let next = features
                    .sampler_ycbcr_conversion
                    .insert(vk::PhysicalDeviceSamplerYcbcrConversionFeatures::default());
                features2 = features2.push_next(next);
            }

            if capabilities.supports_extension(ext::descriptor_indexing::NAME) {
                let next = features
                    .descriptor_indexing
                    .insert(vk::PhysicalDeviceDescriptorIndexingFeaturesEXT::default());
                features2 = features2.push_next(next);
            }

            // `VK_KHR_imageless_framebuffer` is promoted to 1.2, but has no
            // changes, so we can keep using the extension unconditionally.
            if capabilities.supports_extension(khr::imageless_framebuffer::NAME) {
                let next = features
                    .imageless_framebuffer
                    .insert(vk::PhysicalDeviceImagelessFramebufferFeaturesKHR::default());
                features2 = features2.push_next(next);
            }

            // `VK_KHR_timeline_semaphore` is promoted to 1.2, but has no
            // changes, so we can keep using the extension unconditionally.
            if capabilities.supports_extension(khr::timeline_semaphore::NAME) {
                let next = features
                    .timeline_semaphore
                    .insert(vk::PhysicalDeviceTimelineSemaphoreFeaturesKHR::default());
                features2 = features2.push_next(next);
            }

            // `VK_KHR_shader_atomic_int64` is promoted to 1.2, but has no
            // changes, so we can keep using the extension unconditionally.
            if capabilities.device_api_version >= vk::API_VERSION_1_2
                || capabilities.supports_extension(khr::shader_atomic_int64::NAME)
            {
                let next = features
                    .shader_atomic_int64
                    .insert(vk::PhysicalDeviceShaderAtomicInt64Features::default());
                features2 = features2.push_next(next);
            }

            if capabilities.supports_extension(ext::shader_image_atomic_int64::NAME) {
                let next = features
                    .shader_image_atomic_int64
                    .insert(vk::PhysicalDeviceShaderImageAtomicInt64FeaturesEXT::default());
                features2 = features2.push_next(next);
            }
            if capabilities.supports_extension(ext::shader_atomic_float::NAME) {
                let next = features
                    .shader_atomic_float
                    .insert(vk::PhysicalDeviceShaderAtomicFloatFeaturesEXT::default());
                features2 = features2.push_next(next);
            }
            if capabilities.supports_extension(ext::image_robustness::NAME) {
                let next = features
                    .image_robustness
                    .insert(vk::PhysicalDeviceImageRobustnessFeaturesEXT::default());
                features2 = features2.push_next(next);
            }
            if capabilities.supports_extension(ext::robustness2::NAME) {
                let next = features
                    .robustness2
                    .insert(vk::PhysicalDeviceRobustness2FeaturesEXT::default());
                features2 = features2.push_next(next);
            }
            if capabilities.supports_extension(ext::texture_compression_astc_hdr::NAME) {
                let next = features
                    .astc_hdr
                    .insert(vk::PhysicalDeviceTextureCompressionASTCHDRFeaturesEXT::default());
                features2 = features2.push_next(next);
            }
            if capabilities.supports_extension(khr::shader_float16_int8::NAME)
                && capabilities.supports_extension(khr::_16bit_storage::NAME)
            {
                let next = features.shader_float16.insert((
                    vk::PhysicalDeviceShaderFloat16Int8FeaturesKHR::default(),
                    vk::PhysicalDevice16BitStorageFeaturesKHR::default(),
                ));
                features2 = features2.push_next(&mut next.0);
                features2 = features2.push_next(&mut next.1);
            }
            if capabilities.supports_extension(khr::acceleration_structure::NAME) {
                let next = features
                    .acceleration_structure
                    .insert(vk::PhysicalDeviceAccelerationStructureFeaturesKHR::default());
                features2 = features2.push_next(next);
            }

            if capabilities.supports_extension(khr::ray_tracing_position_fetch::NAME) {
                let next = features
                    .position_fetch
                    .insert(vk::PhysicalDeviceRayTracingPositionFetchFeaturesKHR::default());
                features2 = features2.push_next(next);
            }

            // `VK_KHR_zero_initialize_workgroup_memory` is promoted to 1.3
            if capabilities.device_api_version >= vk::API_VERSION_1_3
                || capabilities.supports_extension(khr::zero_initialize_workgroup_memory::NAME)
            {
                let next = features
                    .zero_initialize_workgroup_memory
                    .insert(vk::PhysicalDeviceZeroInitializeWorkgroupMemoryFeatures::default());
                features2 = features2.push_next(next);
            }

            // `VK_EXT_subgroup_size_control` is promoted to 1.3
            if capabilities.device_api_version >= vk::API_VERSION_1_3
                || capabilities.supports_extension(ext::subgroup_size_control::NAME)
            {
                let next = features
                    .subgroup_size_control
                    .insert(vk::PhysicalDeviceSubgroupSizeControlFeatures::default());
                features2 = features2.push_next(next);
            }

            if capabilities.supports_extension(ext::mesh_shader::NAME) {
                let next = features
                    .mesh_shader
                    .insert(vk::PhysicalDeviceMeshShaderFeaturesEXT::default());
                features2 = features2.push_next(next);
            }

            unsafe { get_device_properties.get_physical_device_features2(phd, &mut features2) };
            features2.features
        } else {
            unsafe { self.raw.get_physical_device_features(phd) }
        };

        (capabilities, features)
    }
}

impl super::Instance {
    pub fn expose_adapter(
        &self,
        phd: vk::PhysicalDevice,
    ) -> Option<crate::ExposedAdapter<super::Api>> {
        use crate::auxil::db;

        let (phd_capabilities, phd_features) = self.shared.inspect(phd);

        let info = wgt::AdapterInfo {
            name: {
                phd_capabilities
                    .properties
                    .device_name_as_c_str()
                    .ok()
                    .and_then(|name| name.to_str().ok())
                    .unwrap_or("?")
                    .to_owned()
            },
            vendor: phd_capabilities.properties.vendor_id,
            device: phd_capabilities.properties.device_id,
            device_type: match phd_capabilities.properties.device_type {
                vk::PhysicalDeviceType::OTHER => wgt::DeviceType::Other,
                vk::PhysicalDeviceType::INTEGRATED_GPU => wgt::DeviceType::IntegratedGpu,
                vk::PhysicalDeviceType::DISCRETE_GPU => wgt::DeviceType::DiscreteGpu,
                vk::PhysicalDeviceType::VIRTUAL_GPU => wgt::DeviceType::VirtualGpu,
                vk::PhysicalDeviceType::CPU => wgt::DeviceType::Cpu,
                _ => wgt::DeviceType::Other,
            },
            driver: {
                phd_capabilities
                    .driver
                    .as_ref()
                    .and_then(|driver| driver.driver_name_as_c_str().ok())
                    .and_then(|name| name.to_str().ok())
                    .unwrap_or("?")
                    .to_owned()
            },
            driver_info: {
                phd_capabilities
                    .driver
                    .as_ref()
                    .and_then(|driver| driver.driver_info_as_c_str().ok())
                    .and_then(|name| name.to_str().ok())
                    .unwrap_or("?")
                    .to_owned()
            },
            backend: wgt::Backend::Vulkan,
        };
        let (available_features, downlevel_flags) =
            phd_features.to_wgpu(&self.shared.raw, phd, &phd_capabilities);
        let mut workarounds = super::Workarounds::empty();
        {
            // TODO: only enable for particular devices
            workarounds |= super::Workarounds::SEPARATE_ENTRY_POINTS;
            workarounds.set(
                super::Workarounds::EMPTY_RESOLVE_ATTACHMENT_LISTS,
                phd_capabilities.properties.vendor_id == db::qualcomm::VENDOR,
            );
            workarounds.set(
                super::Workarounds::FORCE_FILL_BUFFER_WITH_SIZE_GREATER_4096_ALIGNED_OFFSET_16,
                phd_capabilities.properties.vendor_id == db::nvidia::VENDOR,
            );
        };

        if let Some(driver) = phd_capabilities.driver {
            if driver.conformance_version.major == 0 {
                if driver.driver_id == vk::DriverId::MOLTENVK {
                    log::debug!("Adapter is not Vulkan compliant, but is MoltenVK, continuing");
                } else if self
                    .shared
                    .flags
                    .contains(wgt::InstanceFlags::ALLOW_UNDERLYING_NONCOMPLIANT_ADAPTER)
                {
                    log::warn!("Adapter is not Vulkan compliant: {}", info.name);
                } else {
                    log::warn!(
                        "Adapter is not Vulkan compliant, hiding adapter: {}",
                        info.name
                    );
                    return None;
                }
            }
        }
        if phd_capabilities.device_api_version == vk::API_VERSION_1_0
            && !phd_capabilities.supports_extension(khr::storage_buffer_storage_class::NAME)
        {
            log::warn!(
                "SPIR-V storage buffer class is not supported, hiding adapter: {}",
                info.name
            );
            return None;
        }
        if !phd_capabilities.supports_extension(amd::negative_viewport_height::NAME)
            && !phd_capabilities.supports_extension(khr::maintenance1::NAME)
            && phd_capabilities.device_api_version < vk::API_VERSION_1_1
        {
            log::warn!(
                "viewport Y-flip is not supported, hiding adapter: {}",
                info.name
            );
            return None;
        }

        let queue_families = unsafe {
            self.shared
                .raw
                .get_physical_device_queue_family_properties(phd)
        };
        let queue_flags = queue_families.first()?.queue_flags;
        if !queue_flags.contains(vk::QueueFlags::GRAPHICS) {
            log::warn!("The first queue only exposes {:?}", queue_flags);
            return None;
        }

        let private_caps = super::PrivateCapabilities {
            flip_y_requires_shift: phd_capabilities.device_api_version >= vk::API_VERSION_1_1
                || phd_capabilities.supports_extension(khr::maintenance1::NAME),
            imageless_framebuffers: match phd_features.imageless_framebuffer {
                Some(features) => features.imageless_framebuffer == vk::TRUE,
                None => phd_features
                    .imageless_framebuffer
                    .is_some_and(|ext| ext.imageless_framebuffer != 0),
            },
            image_view_usage: phd_capabilities.device_api_version >= vk::API_VERSION_1_1
                || phd_capabilities.supports_extension(khr::maintenance2::NAME),
            timeline_semaphores: match phd_features.timeline_semaphore {
                Some(features) => features.timeline_semaphore == vk::TRUE,
                None => phd_features
                    .timeline_semaphore
                    .is_some_and(|ext| ext.timeline_semaphore != 0),
            },
            texture_d24: supports_format(
                &self.shared.raw,
                phd,
                vk::Format::X8_D24_UNORM_PACK32,
                vk::ImageTiling::OPTIMAL,
                depth_stencil_required_flags(),
            ),
            texture_d24_s8: supports_format(
                &self.shared.raw,
                phd,
                vk::Format::D24_UNORM_S8_UINT,
                vk::ImageTiling::OPTIMAL,
                depth_stencil_required_flags(),
            ),
            texture_s8: supports_format(
                &self.shared.raw,
                phd,
                vk::Format::S8_UINT,
                vk::ImageTiling::OPTIMAL,
                depth_stencil_required_flags(),
            ),
            non_coherent_map_mask: phd_capabilities.properties.limits.non_coherent_atom_size - 1,
            can_present: true,
            //TODO: make configurable
            robust_buffer_access: phd_features.core.robust_buffer_access != 0,
            robust_image_access: match phd_features.robustness2 {
                Some(ref f) => f.robust_image_access2 != 0,
                None => phd_features
                    .image_robustness
                    .is_some_and(|ext| ext.robust_image_access != 0),
            },
            robust_buffer_access2: phd_features
                .robustness2
                .as_ref()
                .map(|r| r.robust_buffer_access2 == 1)
                .unwrap_or_default(),
            robust_image_access2: phd_features
                .robustness2
                .as_ref()
                .map(|r| r.robust_image_access2 == 1)
                .unwrap_or_default(),
            zero_initialize_workgroup_memory: phd_features
                .zero_initialize_workgroup_memory
                .is_some_and(|ext| ext.shader_zero_initialize_workgroup_memory == vk::TRUE),
            image_format_list: phd_capabilities.device_api_version >= vk::API_VERSION_1_2
                || phd_capabilities.supports_extension(khr::image_format_list::NAME),
            maximum_samplers: phd_capabilities
                .properties
                .limits
                .max_sampler_allocation_count,
        };
        let capabilities = crate::Capabilities {
            limits: phd_capabilities.to_wgpu_limits(),
            alignments: phd_capabilities.to_hal_alignments(private_caps.robust_buffer_access2),
            downlevel: wgt::DownlevelCapabilities {
                flags: downlevel_flags,
                limits: wgt::DownlevelLimits {},
                shader_model: wgt::ShaderModel::Sm5, //TODO?
            },
        };

        let adapter = super::Adapter {
            raw: phd,
            instance: Arc::clone(&self.shared),
            //queue_families,
            known_memory_flags: vk::MemoryPropertyFlags::DEVICE_LOCAL
                | vk::MemoryPropertyFlags::HOST_VISIBLE
                | vk::MemoryPropertyFlags::HOST_COHERENT
                | vk::MemoryPropertyFlags::HOST_CACHED
                | vk::MemoryPropertyFlags::LAZILY_ALLOCATED,
            phd_capabilities,
            phd_features,
            downlevel_flags,
            private_caps,
            workarounds,
        };

        Some(crate::ExposedAdapter {
            adapter,
            info,
            features: available_features,
            capabilities,
        })
    }
}

impl super::Adapter {
    pub fn raw_physical_device(&self) -> vk::PhysicalDevice {
        self.raw
    }

    pub fn physical_device_capabilities(&self) -> &PhysicalDeviceProperties {
        &self.phd_capabilities
    }

    pub fn shared_instance(&self) -> &super::InstanceShared {
        &self.instance
    }

    pub fn required_device_extensions(&self, features: wgt::Features) -> Vec<&'static CStr> {
        let (supported_extensions, unsupported_extensions) = self
            .phd_capabilities
            .get_required_extensions(features)
            .iter()
            .partition::<Vec<&CStr>, _>(|&&extension| {
                self.phd_capabilities.supports_extension(extension)
            });

        if !unsupported_extensions.is_empty() {
            log::warn!("Missing extensions: {:?}", unsupported_extensions);
        }

        log::debug!("Supported extensions: {:?}", supported_extensions);
        supported_extensions
    }

    /// Create a `PhysicalDeviceFeatures` for opening a logical device with
    /// `features` from this adapter.
    ///
    /// The given `enabled_extensions` set must include all the extensions
    /// selected by [`required_device_extensions`] when passed `features`.
    /// Otherwise, the `PhysicalDeviceFeatures` value may not be able to select
    /// all the Vulkan features needed to represent `features` and this
    /// adapter's characteristics.
    ///
    /// Typically, you'd simply call `required_device_extensions`, and then pass
    /// its return value and the feature set you gave it directly to this
    /// function. But it's fine to add more extensions to the list.
    ///
    /// [`required_device_extensions`]: Self::required_device_extensions
    pub fn physical_device_features(
        &self,
        enabled_extensions: &[&'static CStr],
        features: wgt::Features,
    ) -> PhysicalDeviceFeatures {
        PhysicalDeviceFeatures::from_extensions_and_requested_features(
            &self.phd_capabilities,
            &self.phd_features,
            enabled_extensions,
            features,
            self.downlevel_flags,
            &self.private_caps,
        )
    }

    /// # Safety
    ///
    /// - `raw_device` must be created from this adapter.
    /// - `raw_device` must be created using `family_index`, `enabled_extensions` and `physical_device_features()`
    /// - `enabled_extensions` must be a superset of `required_device_extensions()`.
    /// - If `drop_callback` is [`None`], wgpu-hal will take ownership of `raw_device`. If
    ///   `drop_callback` is [`Some`], `raw_device` must be valid until the callback is called.
    #[allow(clippy::too_many_arguments)]
    pub unsafe fn device_from_raw(
        &self,
        raw_device: ash::Device,
        drop_callback: Option<crate::DropCallback>,
        enabled_extensions: &[&'static CStr],
        features: wgt::Features,
        memory_hints: &wgt::MemoryHints,
        family_index: u32,
        queue_index: u32,
    ) -> Result<crate::OpenDevice<super::Api>, crate::DeviceError> {
        let mem_properties = {
            profiling::scope!("vkGetPhysicalDeviceMemoryProperties");
            unsafe {
                self.instance
                    .raw
                    .get_physical_device_memory_properties(self.raw)
            }
        };
        let memory_types = &mem_properties.memory_types_as_slice();
        let valid_ash_memory_types = memory_types.iter().enumerate().fold(0, |u, (i, mem)| {
            if self.known_memory_flags.contains(mem.property_flags) {
                u | (1 << i)
            } else {
                u
            }
        });

        let swapchain_fn = khr::swapchain::Device::new(&self.instance.raw, &raw_device);

        // Note that VK_EXT_debug_utils is an instance extension (enabled at the instance
        // level) but contains a few functions that can be loaded directly on the Device for a
        // dispatch-table-less pointer.
        let debug_utils_fn = if self.instance.extensions.contains(&ext::debug_utils::NAME) {
            Some(ext::debug_utils::Device::new(
                &self.instance.raw,
                &raw_device,
            ))
        } else {
            None
        };
        let indirect_count_fn = if enabled_extensions.contains(&khr::draw_indirect_count::NAME) {
            Some(khr::draw_indirect_count::Device::new(
                &self.instance.raw,
                &raw_device,
            ))
        } else {
            None
        };
        let timeline_semaphore_fn = if enabled_extensions.contains(&khr::timeline_semaphore::NAME) {
            Some(super::ExtensionFn::Extension(
                khr::timeline_semaphore::Device::new(&self.instance.raw, &raw_device),
            ))
        } else if self.phd_capabilities.device_api_version >= vk::API_VERSION_1_2 {
            Some(super::ExtensionFn::Promoted)
        } else {
            None
        };
        let ray_tracing_fns = if enabled_extensions.contains(&khr::acceleration_structure::NAME)
            && enabled_extensions.contains(&khr::buffer_device_address::NAME)
        {
            Some(super::RayTracingDeviceExtensionFunctions {
                acceleration_structure: khr::acceleration_structure::Device::new(
                    &self.instance.raw,
                    &raw_device,
                ),
                buffer_device_address: khr::buffer_device_address::Device::new(
                    &self.instance.raw,
                    &raw_device,
                ),
            })
        } else {
            None
        };
        let mesh_shading_fns = if enabled_extensions.contains(&ext::mesh_shader::NAME) {
            Some(ext::mesh_shader::Device::new(
                &self.instance.raw,
                &raw_device,
            ))
        } else {
            None
        };

        let naga_options = {
            use naga::back::spv;

            // The following capabilities are always available
            // see https://registry.khronos.org/vulkan/specs/1.3-extensions/html/chap52.html#spirvenv-capabilities
            let mut capabilities = vec![
                spv::Capability::Shader,
                spv::Capability::Matrix,
                spv::Capability::Sampled1D,
                spv::Capability::Image1D,
                spv::Capability::ImageQuery,
                spv::Capability::DerivativeControl,
                spv::Capability::StorageImageExtendedFormats,
            ];

            if self
                .downlevel_flags
                .contains(wgt::DownlevelFlags::CUBE_ARRAY_TEXTURES)
            {
                capabilities.push(spv::Capability::SampledCubeArray);
            }

            if self
                .downlevel_flags
                .contains(wgt::DownlevelFlags::MULTISAMPLED_SHADING)
            {
                capabilities.push(spv::Capability::SampleRateShading);
            }

            if features.contains(wgt::Features::MULTIVIEW) {
                capabilities.push(spv::Capability::MultiView);
            }

            if features.contains(wgt::Features::SHADER_PRIMITIVE_INDEX) {
                capabilities.push(spv::Capability::Geometry);
            }

            if features.intersects(wgt::Features::SUBGROUP | wgt::Features::SUBGROUP_VERTEX) {
                capabilities.push(spv::Capability::GroupNonUniform);
                capabilities.push(spv::Capability::GroupNonUniformVote);
                capabilities.push(spv::Capability::GroupNonUniformArithmetic);
                capabilities.push(spv::Capability::GroupNonUniformBallot);
                capabilities.push(spv::Capability::GroupNonUniformShuffle);
                capabilities.push(spv::Capability::GroupNonUniformShuffleRelative);
            }

            if features.intersects(
                wgt::Features::SAMPLED_TEXTURE_AND_STORAGE_BUFFER_ARRAY_NON_UNIFORM_INDEXING
                    | wgt::Features::STORAGE_TEXTURE_ARRAY_NON_UNIFORM_INDEXING
                    | wgt::Features::UNIFORM_BUFFER_BINDING_ARRAYS,
            ) {
                capabilities.push(spv::Capability::ShaderNonUniform);
            }
            if features.contains(wgt::Features::BGRA8UNORM_STORAGE) {
                capabilities.push(spv::Capability::StorageImageWriteWithoutFormat);
            }

            if features.contains(wgt::Features::EXPERIMENTAL_RAY_QUERY) {
                capabilities.push(spv::Capability::RayQueryKHR);
            }

            if features.contains(wgt::Features::SHADER_INT64) {
                capabilities.push(spv::Capability::Int64);
            }

            if features.contains(wgt::Features::SHADER_F16) {
                capabilities.push(spv::Capability::Float16);
            }

            if features.intersects(
                wgt::Features::SHADER_INT64_ATOMIC_ALL_OPS
                    | wgt::Features::SHADER_INT64_ATOMIC_MIN_MAX
                    | wgt::Features::TEXTURE_INT64_ATOMIC,
            ) {
                capabilities.push(spv::Capability::Int64Atomics);
            }

            if features.intersects(wgt::Features::TEXTURE_INT64_ATOMIC) {
                capabilities.push(spv::Capability::Int64ImageEXT);
            }

            if features.contains(wgt::Features::SHADER_FLOAT32_ATOMIC) {
                capabilities.push(spv::Capability::AtomicFloat32AddEXT);
            }

            let mut flags = spv::WriterFlags::empty();
            flags.set(
                spv::WriterFlags::DEBUG,
                self.instance.flags.contains(wgt::InstanceFlags::DEBUG),
            );
            flags.set(
                spv::WriterFlags::LABEL_VARYINGS,
                self.phd_capabilities.properties.vendor_id != crate::auxil::db::qualcomm::VENDOR,
            );
            flags.set(
                spv::WriterFlags::FORCE_POINT_SIZE,
                //Note: we could technically disable this when we are compiling separate entry points,
                // and we know exactly that the primitive topology is not `PointList`.
                // But this requires cloning the `spv::Options` struct, which has heap allocations.
                true, // could check `super::Workarounds::SEPARATE_ENTRY_POINTS`
            );
            if features.contains(wgt::Features::EXPERIMENTAL_RAY_QUERY) {
                capabilities.push(spv::Capability::RayQueryKHR);
            }
            if features.contains(wgt::Features::EXPERIMENTAL_RAY_HIT_VERTEX_RETURN) {
                capabilities.push(spv::Capability::RayQueryPositionFetchKHR)
            }
            spv::Options {
                lang_version: if features
                    .intersects(wgt::Features::SUBGROUP | wgt::Features::SUBGROUP_VERTEX)
                {
                    (1, 3)
                } else {
                    (1, 0)
                },
                flags,
                capabilities: Some(capabilities.iter().cloned().collect()),
                bounds_check_policies: naga::proc::BoundsCheckPolicies {
                    index: naga::proc::BoundsCheckPolicy::Restrict,
                    buffer: if self.private_caps.robust_buffer_access2 {
                        naga::proc::BoundsCheckPolicy::Unchecked
                    } else {
                        naga::proc::BoundsCheckPolicy::Restrict
                    },
                    image_load: if self.private_caps.robust_image_access {
                        naga::proc::BoundsCheckPolicy::Unchecked
                    } else {
                        naga::proc::BoundsCheckPolicy::Restrict
                    },
                    // TODO: support bounds checks on binding arrays
                    binding_array: naga::proc::BoundsCheckPolicy::Unchecked,
                },
                zero_initialize_workgroup_memory: if self
                    .private_caps
                    .zero_initialize_workgroup_memory
                {
                    spv::ZeroInitializeWorkgroupMemoryMode::Native
                } else {
                    spv::ZeroInitializeWorkgroupMemoryMode::Polyfill
                },
                force_loop_bounding: true,
                // We need to build this separately for each invocation, so just default it out here
                binding_map: BTreeMap::default(),
                debug_info: None,
            }
        };

        let raw_queue = {
            profiling::scope!("vkGetDeviceQueue");
            unsafe { raw_device.get_device_queue(family_index, queue_index) }
        };

        let driver_version = self
            .phd_capabilities
            .properties
            .driver_version
            .to_be_bytes();
        #[rustfmt::skip]
        let pipeline_cache_validation_key = [
            driver_version[0], driver_version[1], driver_version[2], driver_version[3],
            0, 0, 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 0,
        ];

        let drop_guard = crate::DropGuard::from_option(drop_callback);

        let shared = Arc::new(super::DeviceShared {
            raw: raw_device,
            family_index,
            queue_index,
            raw_queue,
            drop_guard,
            instance: Arc::clone(&self.instance),
            physical_device: self.raw,
            enabled_extensions: enabled_extensions.into(),
            extension_fns: super::DeviceExtensionFunctions {
                debug_utils: debug_utils_fn,
                draw_indirect_count: indirect_count_fn,
                timeline_semaphore: timeline_semaphore_fn,
                ray_tracing: ray_tracing_fns,
                mesh_shading: mesh_shading_fns,
            },
            pipeline_cache_validation_key,
            vendor_id: self.phd_capabilities.properties.vendor_id,
            timestamp_period: self.phd_capabilities.properties.limits.timestamp_period,
            private_caps: self.private_caps.clone(),
            features,
            workarounds: self.workarounds,
            render_passes: Mutex::new(Default::default()),
            framebuffers: Mutex::new(Default::default()),
            sampler_cache: Mutex::new(super::sampler::SamplerCache::new(
                self.private_caps.maximum_samplers,
            )),
            memory_allocations_counter: Default::default(),
        });

        let relay_semaphores = super::RelaySemaphores::new(&shared)?;

        let queue = super::Queue {
            raw: raw_queue,
            swapchain_fn,
            device: Arc::clone(&shared),
            family_index,
            relay_semaphores: Mutex::new(relay_semaphores),
            signal_semaphores: Mutex::new((Vec::new(), Vec::new())),
        };

        let mem_allocator = {
            let limits = self.phd_capabilities.properties.limits;

            // Note: the parameters here are not set in stone nor where they picked with
            // strong confidence.
            // `final_free_list_chunk` should be bigger than starting_free_list_chunk if
            // we want the behavior of starting with smaller block sizes and using larger
            // ones only after we observe that the small ones aren't enough, which I think
            // is a good "I don't know what the workload is going to be like" approach.
            //
            // For reference, `VMA`, and `gpu_allocator` both start with 256 MB blocks
            // (then VMA doubles the block size each time it needs a new block).
            // At some point it would be good to experiment with real workloads
            //
            // TODO(#5925): The plan is to switch the Vulkan backend from `gpu_alloc` to
            // `gpu_allocator` which has a different (simpler) set of configuration options.
            //
            // TODO: These parameters should take hardware capabilities into account.
            let mb = 1024 * 1024;
            let perf_cfg = gpu_alloc::Config {
                starting_free_list_chunk: 128 * mb,
                final_free_list_chunk: 512 * mb,
                minimal_buddy_size: 1,
                initial_buddy_dedicated_size: 8 * mb,
                dedicated_threshold: 32 * mb,
                preferred_dedicated_threshold: mb,
                transient_dedicated_threshold: 128 * mb,
            };
            let mem_usage_cfg = gpu_alloc::Config {
                starting_free_list_chunk: 8 * mb,
                final_free_list_chunk: 64 * mb,
                minimal_buddy_size: 1,
                initial_buddy_dedicated_size: 8 * mb,
                dedicated_threshold: 8 * mb,
                preferred_dedicated_threshold: mb,
                transient_dedicated_threshold: 16 * mb,
            };
            let config = match memory_hints {
                wgt::MemoryHints::Performance => perf_cfg,
                wgt::MemoryHints::MemoryUsage => mem_usage_cfg,
                wgt::MemoryHints::Manual {
                    suballocated_device_memory_block_size,
                } => gpu_alloc::Config {
                    starting_free_list_chunk: suballocated_device_memory_block_size.start,
                    final_free_list_chunk: suballocated_device_memory_block_size.end,
                    initial_buddy_dedicated_size: suballocated_device_memory_block_size.start,
                    ..perf_cfg
                },
            };

            let max_memory_allocation_size =
                if let Some(maintenance_3) = self.phd_capabilities.maintenance_3 {
                    maintenance_3.max_memory_allocation_size
                } else {
                    u64::MAX
                };
            let properties = gpu_alloc::DeviceProperties {
                max_memory_allocation_count: limits.max_memory_allocation_count,
                max_memory_allocation_size,
                non_coherent_atom_size: limits.non_coherent_atom_size,
                memory_types: memory_types
                    .iter()
                    .map(|memory_type| gpu_alloc::MemoryType {
                        props: gpu_alloc::MemoryPropertyFlags::from_bits_truncate(
                            memory_type.property_flags.as_raw() as u8,
                        ),
                        heap: memory_type.heap_index,
                    })
                    .collect(),
                memory_heaps: mem_properties
                    .memory_heaps_as_slice()
                    .iter()
                    .map(|&memory_heap| gpu_alloc::MemoryHeap {
                        size: memory_heap.size,
                    })
                    .collect(),
                buffer_device_address: enabled_extensions
                    .contains(&khr::buffer_device_address::NAME),
            };
            gpu_alloc::GpuAllocator::new(config, properties)
        };
        let desc_allocator = gpu_descriptor::DescriptorAllocator::new(
            if let Some(di) = self.phd_capabilities.descriptor_indexing {
                di.max_update_after_bind_descriptors_in_all_pools
            } else {
                0
            },
        );

        let device = super::Device {
            shared,
            mem_allocator: Mutex::new(mem_allocator),
            desc_allocator: Mutex::new(desc_allocator),
            valid_ash_memory_types,
            naga_options,
            #[cfg(feature = "renderdoc")]
            render_doc: Default::default(),
            counters: Default::default(),
        };

        Ok(crate::OpenDevice { device, queue })
    }

    pub fn texture_format_as_raw(&self, texture_format: wgt::TextureFormat) -> vk::Format {
        self.private_caps.map_texture_format(texture_format)
    }
}

impl crate::Adapter for super::Adapter {
    type A = super::Api;

    unsafe fn open(
        &self,
        features: wgt::Features,
        _limits: &wgt::Limits,
        memory_hints: &wgt::MemoryHints,
    ) -> Result<crate::OpenDevice<super::Api>, crate::DeviceError> {
        let enabled_extensions = self.required_device_extensions(features);
        let mut enabled_phd_features = self.physical_device_features(&enabled_extensions, features);

        let family_index = 0; //TODO
        let family_info = vk::DeviceQueueCreateInfo::default()
            .queue_family_index(family_index)
            .queue_priorities(&[1.0]);
        let family_infos = [family_info];

        let str_pointers = enabled_extensions
            .iter()
            .map(|&s| {
                // Safe because `enabled_extensions` entries have static lifetime.
                s.as_ptr()
            })
            .collect::<Vec<_>>();

        let pre_info = vk::DeviceCreateInfo::default()
            .queue_create_infos(&family_infos)
            .enabled_extension_names(&str_pointers);
        let info = enabled_phd_features.add_to_device_create(pre_info);
        let raw_device = {
            profiling::scope!("vkCreateDevice");
            unsafe {
                self.instance
                    .raw
                    .create_device(self.raw, &info, None)
                    .map_err(map_err)?
            }
        };
        fn map_err(err: vk::Result) -> crate::DeviceError {
            match err {
                vk::Result::ERROR_TOO_MANY_OBJECTS => crate::DeviceError::OutOfMemory,
                vk::Result::ERROR_INITIALIZATION_FAILED => crate::DeviceError::Lost,
                vk::Result::ERROR_EXTENSION_NOT_PRESENT | vk::Result::ERROR_FEATURE_NOT_PRESENT => {
                    crate::hal_usage_error(err)
                }
                other => super::map_host_device_oom_and_lost_err(other),
            }
        }

        unsafe {
            self.device_from_raw(
                raw_device,
                None,
                &enabled_extensions,
                features,
                memory_hints,
                family_info.queue_family_index,
                0,
            )
        }
    }

    unsafe fn texture_format_capabilities(
        &self,
        format: wgt::TextureFormat,
    ) -> crate::TextureFormatCapabilities {
        use crate::TextureFormatCapabilities as Tfc;

        let vk_format = self.private_caps.map_texture_format(format);
        let properties = unsafe {
            self.instance
                .raw
                .get_physical_device_format_properties(self.raw, vk_format)
        };
        let features = properties.optimal_tiling_features;

        let mut flags = Tfc::empty();
        flags.set(
            Tfc::SAMPLED,
            features.contains(vk::FormatFeatureFlags::SAMPLED_IMAGE),
        );
        flags.set(
            Tfc::SAMPLED_LINEAR,
            features.contains(vk::FormatFeatureFlags::SAMPLED_IMAGE_FILTER_LINEAR),
        );
        // flags.set(
        //     Tfc::SAMPLED_MINMAX,
        //     features.contains(vk::FormatFeatureFlags::SAMPLED_IMAGE_FILTER_MINMAX),
        // );
        flags.set(
            Tfc::STORAGE_READ_WRITE
                | Tfc::STORAGE_WRITE_ONLY
                | Tfc::STORAGE_READ_ONLY
                | Tfc::STORAGE_ATOMIC,
            features.contains(vk::FormatFeatureFlags::STORAGE_IMAGE),
        );
        flags.set(
            Tfc::STORAGE_ATOMIC,
            features.contains(vk::FormatFeatureFlags::STORAGE_IMAGE_ATOMIC),
        );
        flags.set(
            Tfc::COLOR_ATTACHMENT,
            features.contains(vk::FormatFeatureFlags::COLOR_ATTACHMENT),
        );
        flags.set(
            Tfc::COLOR_ATTACHMENT_BLEND,
            features.contains(vk::FormatFeatureFlags::COLOR_ATTACHMENT_BLEND),
        );
        flags.set(
            Tfc::DEPTH_STENCIL_ATTACHMENT,
            features.contains(vk::FormatFeatureFlags::DEPTH_STENCIL_ATTACHMENT),
        );
        flags.set(
            Tfc::COPY_SRC,
            features.intersects(vk::FormatFeatureFlags::TRANSFER_SRC),
        );
        flags.set(
            Tfc::COPY_DST,
            features.intersects(vk::FormatFeatureFlags::TRANSFER_DST),
        );
        flags.set(
            Tfc::STORAGE_ATOMIC,
            features.intersects(vk::FormatFeatureFlags::STORAGE_IMAGE_ATOMIC),
        );
        // Vulkan is very permissive about MSAA
        flags.set(Tfc::MULTISAMPLE_RESOLVE, !format.is_compressed());

        // get the supported sample counts
        let format_aspect = crate::FormatAspects::from(format);
        let limits = self.phd_capabilities.properties.limits;

        let sample_flags = if format_aspect.contains(crate::FormatAspects::DEPTH) {
            limits
                .framebuffer_depth_sample_counts
                .min(limits.sampled_image_depth_sample_counts)
        } else if format_aspect.contains(crate::FormatAspects::STENCIL) {
            limits
                .framebuffer_stencil_sample_counts
                .min(limits.sampled_image_stencil_sample_counts)
        } else {
            let first_aspect = format_aspect
                .iter()
                .next()
                .expect("All texture should at least one aspect")
                .map();

            // We should never get depth or stencil out of this, due to the above.
            assert_ne!(first_aspect, wgt::TextureAspect::DepthOnly);
            assert_ne!(first_aspect, wgt::TextureAspect::StencilOnly);

            match format.sample_type(Some(first_aspect), None).unwrap() {
                wgt::TextureSampleType::Float { .. } => limits
                    .framebuffer_color_sample_counts
                    .min(limits.sampled_image_color_sample_counts),
                wgt::TextureSampleType::Sint | wgt::TextureSampleType::Uint => {
                    limits.sampled_image_integer_sample_counts
                }
                _ => unreachable!(),
            }
        };

        flags.set(
            Tfc::MULTISAMPLE_X2,
            sample_flags.contains(vk::SampleCountFlags::TYPE_2),
        );
        flags.set(
            Tfc::MULTISAMPLE_X4,
            sample_flags.contains(vk::SampleCountFlags::TYPE_4),
        );
        flags.set(
            Tfc::MULTISAMPLE_X8,
            sample_flags.contains(vk::SampleCountFlags::TYPE_8),
        );
        flags.set(
            Tfc::MULTISAMPLE_X16,
            sample_flags.contains(vk::SampleCountFlags::TYPE_16),
        );

        flags
    }

    unsafe fn surface_capabilities(
        &self,
        surface: &super::Surface,
    ) -> Option<crate::SurfaceCapabilities> {
        if !self.private_caps.can_present {
            return None;
        }
        let queue_family_index = 0; //TODO
        {
            profiling::scope!("vkGetPhysicalDeviceSurfaceSupportKHR");
            match unsafe {
                surface.functor.get_physical_device_surface_support(
                    self.raw,
                    queue_family_index,
                    surface.raw,
                )
            } {
                Ok(true) => (),
                Ok(false) => return None,
                Err(e) => {
                    log::error!("get_physical_device_surface_support: {}", e);
                    return None;
                }
            }
        }

        let caps = {
            profiling::scope!("vkGetPhysicalDeviceSurfaceCapabilitiesKHR");
            match unsafe {
                surface
                    .functor
                    .get_physical_device_surface_capabilities(self.raw, surface.raw)
            } {
                Ok(caps) => caps,
                Err(e) => {
                    log::error!("get_physical_device_surface_capabilities: {}", e);
                    return None;
                }
            }
        };

        // If image count is 0, the support number of images is unlimited.
        let max_image_count = if caps.max_image_count == 0 {
            !0
        } else {
            caps.max_image_count
        };

        // `0xFFFFFFFF` indicates that the extent depends on the created swapchain.
        let current_extent = if caps.current_extent.width != !0 && caps.current_extent.height != !0
        {
            Some(wgt::Extent3d {
                width: caps.current_extent.width,
                height: caps.current_extent.height,
                depth_or_array_layers: 1,
            })
        } else {
            None
        };

        let raw_present_modes = {
            profiling::scope!("vkGetPhysicalDeviceSurfacePresentModesKHR");
            match unsafe {
                surface
                    .functor
                    .get_physical_device_surface_present_modes(self.raw, surface.raw)
            } {
                Ok(present_modes) => present_modes,
                Err(e) => {
                    log::error!("get_physical_device_surface_present_modes: {}", e);
                    // Per definition of `SurfaceCapabilities`, there must be at least one present mode.
                    return None;
                }
            }
        };

        let raw_surface_formats = {
            profiling::scope!("vkGetPhysicalDeviceSurfaceFormatsKHR");
            match unsafe {
                surface
                    .functor
                    .get_physical_device_surface_formats(self.raw, surface.raw)
            } {
                Ok(formats) => formats,
                Err(e) => {
                    log::error!("get_physical_device_surface_formats: {}", e);
                    // Per definition of `SurfaceCapabilities`, there must be at least one present format.
                    return None;
                }
            }
        };

        let formats = raw_surface_formats
            .into_iter()
            .filter_map(conv::map_vk_surface_formats)
            .collect();
        Some(crate::SurfaceCapabilities {
            formats,
            // TODO: Right now we're always trunkating the swap chain
            // (presumably - we're actually setting the min image count which isn't necessarily the swap chain size)
            // Instead, we should use extensions when available to wait in present.
            // See https://github.com/gfx-rs/wgpu/issues/2869
            maximum_frame_latency: (caps.min_image_count - 1)..=(max_image_count - 1), // Note this can't underflow since both `min_image_count` is at least one and we already patched `max_image_count`.
            current_extent,
            usage: conv::map_vk_image_usage(caps.supported_usage_flags),
            present_modes: raw_present_modes
                .into_iter()
                .flat_map(conv::map_vk_present_mode)
                .collect(),
            composite_alpha_modes: conv::map_vk_composite_alpha(caps.supported_composite_alpha),
        })
    }

    unsafe fn get_presentation_timestamp(&self) -> wgt::PresentationTimestamp {
        // VK_GOOGLE_display_timing is the only way to get presentation
        // timestamps on vulkan right now and it is only ever available
        // on android and linux. This includes mac, but there's no alternative
        // on mac, so this is fine.
        #[cfg(unix)]
        {
            let mut timespec = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            unsafe {
                libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut timespec);
            }

            wgt::PresentationTimestamp(
                timespec.tv_sec as u128 * 1_000_000_000 + timespec.tv_nsec as u128,
            )
        }
        #[cfg(not(unix))]
        {
            wgt::PresentationTimestamp::INVALID_TIMESTAMP
        }
    }
}

fn is_format_16bit_norm_supported(instance: &ash::Instance, phd: vk::PhysicalDevice) -> bool {
    let tiling = vk::ImageTiling::OPTIMAL;
    let features = vk::FormatFeatureFlags::SAMPLED_IMAGE
        | vk::FormatFeatureFlags::STORAGE_IMAGE
        | vk::FormatFeatureFlags::TRANSFER_SRC
        | vk::FormatFeatureFlags::TRANSFER_DST;
    let r16unorm = supports_format(instance, phd, vk::Format::R16_UNORM, tiling, features);
    let r16snorm = supports_format(instance, phd, vk::Format::R16_SNORM, tiling, features);
    let rg16unorm = supports_format(instance, phd, vk::Format::R16G16_UNORM, tiling, features);
    let rg16snorm = supports_format(instance, phd, vk::Format::R16G16_SNORM, tiling, features);
    let rgba16unorm = supports_format(
        instance,
        phd,
        vk::Format::R16G16B16A16_UNORM,
        tiling,
        features,
    );
    let rgba16snorm = supports_format(
        instance,
        phd,
        vk::Format::R16G16B16A16_SNORM,
        tiling,
        features,
    );

    r16unorm && r16snorm && rg16unorm && rg16snorm && rgba16unorm && rgba16snorm
}

fn is_float32_filterable_supported(instance: &ash::Instance, phd: vk::PhysicalDevice) -> bool {
    let tiling = vk::ImageTiling::OPTIMAL;
    let features = vk::FormatFeatureFlags::SAMPLED_IMAGE_FILTER_LINEAR;
    let r_float = supports_format(instance, phd, vk::Format::R32_SFLOAT, tiling, features);
    let rg_float = supports_format(instance, phd, vk::Format::R32G32_SFLOAT, tiling, features);
    let rgba_float = supports_format(
        instance,
        phd,
        vk::Format::R32G32B32A32_SFLOAT,
        tiling,
        features,
    );
    r_float && rg_float && rgba_float
}

fn supports_format(
    instance: &ash::Instance,
    phd: vk::PhysicalDevice,
    format: vk::Format,
    tiling: vk::ImageTiling,
    features: vk::FormatFeatureFlags,
) -> bool {
    let properties = unsafe { instance.get_physical_device_format_properties(phd, format) };
    match tiling {
        vk::ImageTiling::LINEAR => properties.linear_tiling_features.contains(features),
        vk::ImageTiling::OPTIMAL => properties.optimal_tiling_features.contains(features),
        _ => false,
    }
}

fn supports_bgra8unorm_storage(
    instance: &ash::Instance,
    phd: vk::PhysicalDevice,
    device_api_version: u32,
) -> bool {
    // See https://github.com/KhronosGroup/Vulkan-Docs/issues/2027#issuecomment-1380608011

    // This check gates the function call and structures used below.
    // TODO: check for (`VK_KHR_get_physical_device_properties2` or VK1.1) and (`VK_KHR_format_feature_flags2` or VK1.3).
    // Right now we only check for VK1.3.
    if device_api_version < vk::API_VERSION_1_3 {
        return false;
    }

    unsafe {
        let mut properties3 = vk::FormatProperties3::default();
        let mut properties2 = vk::FormatProperties2::default().push_next(&mut properties3);

        instance.get_physical_device_format_properties2(
            phd,
            vk::Format::B8G8R8A8_UNORM,
            &mut properties2,
        );

        let features2 = properties2.format_properties.optimal_tiling_features;
        let features3 = properties3.optimal_tiling_features;

        features2.contains(vk::FormatFeatureFlags::STORAGE_IMAGE)
            && features3.contains(vk::FormatFeatureFlags2::STORAGE_WRITE_WITHOUT_FORMAT)
    }
}

// For https://github.com/gfx-rs/wgpu/issues/4599
// Intel iGPUs with outdated drivers can break rendering if `VK_EXT_robustness2` is used.
// Driver version 31.0.101.2115 works, but there's probably an earlier functional version.
fn is_intel_igpu_outdated_for_robustness2(
    props: vk::PhysicalDeviceProperties,
    driver: Option<vk::PhysicalDeviceDriverPropertiesKHR>,
) -> bool {
    const DRIVER_VERSION_WORKING: u32 = (101 << 14) | 2115; // X.X.101.2115

    let is_outdated = props.vendor_id == crate::auxil::db::intel::VENDOR
        && props.device_type == vk::PhysicalDeviceType::INTEGRATED_GPU
        && props.driver_version < DRIVER_VERSION_WORKING
        && driver
            .map(|driver| driver.driver_id == vk::DriverId::INTEL_PROPRIETARY_WINDOWS)
            .unwrap_or_default();

    if is_outdated {
        log::warn!(
            "Disabling robustBufferAccess2 and robustImageAccess2: IntegratedGpu Intel Driver is outdated. Found with version 0x{:X}, less than the known good version 0x{:X} (31.0.101.2115)",
            props.driver_version,
            DRIVER_VERSION_WORKING
        );
    }
    is_outdated
}
