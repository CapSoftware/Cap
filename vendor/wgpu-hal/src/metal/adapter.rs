use metal::{MTLFeatureSet, MTLGPUFamily, MTLLanguageVersion, MTLReadWriteTextureTier};
use objc::{class, msg_send, sel, sel_impl};
use parking_lot::Mutex;
use wgt::{AstcBlock, AstcChannel};

use std::{sync::Arc, thread};

use super::TimestampQuerySupport;

const MAX_COMMAND_BUFFERS: u64 = 2048;

unsafe impl Send for super::Adapter {}
unsafe impl Sync for super::Adapter {}

impl super::Adapter {
    pub(super) fn new(shared: Arc<super::AdapterShared>) -> Self {
        Self { shared }
    }
}

impl crate::Adapter for super::Adapter {
    type A = super::Api;

    unsafe fn open(
        &self,
        features: wgt::Features,
        _limits: &wgt::Limits,
        _memory_hints: &wgt::MemoryHints,
    ) -> Result<crate::OpenDevice<super::Api>, crate::DeviceError> {
        let queue = self
            .shared
            .device
            .lock()
            .new_command_queue_with_max_command_buffer_count(MAX_COMMAND_BUFFERS);

        // Acquiring the meaning of timestamp ticks is hard with Metal!
        // The only thing there is is a method correlating cpu & gpu timestamps (`device.sample_timestamps`).
        // Users are supposed to call this method twice and calculate the difference,
        // see "Converting GPU Timestamps into CPU Time":
        // https://developer.apple.com/documentation/metal/gpu_counters_and_counter_sample_buffers/converting_gpu_timestamps_into_cpu_time
        // Not only does this mean we get an approximate value, this is as also *very slow*!
        // Chromium opted to solve this using a linear regression that they stop at some point
        // https://source.chromium.org/chromium/chromium/src/+/refs/heads/main:third_party/dawn/src/dawn/native/metal/DeviceMTL.mm;drc=76be2f9f117654f3fe4faa477b0445114fccedda;bpv=0;bpt=1;l=46
        // Generally, the assumption is that timestamp values aren't changing over time, after all all other APIs provide stable values.
        //
        // We should do as Chromium does for the general case, but this requires quite some state tracking
        // and doesn't even provide perfectly accurate values, especially at the start of the application when
        // we didn't have the chance to sample a lot of values just yet.
        //
        // So instead, we're doing the dangerous but easy thing and use our "knowledge" of timestamps
        // conversions on different devices, after all Metal isn't supported on that many ;)
        // Based on:
        // * https://github.com/gfx-rs/wgpu/pull/2528
        // * https://github.com/gpuweb/gpuweb/issues/1325#issuecomment-761041326
        let timestamp_period = if self.shared.device.lock().name().starts_with("Intel") {
            83.333
        } else {
            // Known for Apple Silicon (at least M1 & M2, iPad Pro 2018) and AMD GPUs.
            1.0
        };

        Ok(crate::OpenDevice {
            device: super::Device {
                shared: Arc::clone(&self.shared),
                features,
                counters: Default::default(),
            },
            queue: super::Queue {
                raw: Arc::new(Mutex::new(queue)),
                timestamp_period,
            },
        })
    }

    unsafe fn texture_format_capabilities(
        &self,
        format: wgt::TextureFormat,
    ) -> crate::TextureFormatCapabilities {
        use crate::TextureFormatCapabilities as Tfc;
        use wgt::TextureFormat as Tf;

        let pc = &self.shared.private_caps;
        // Affected formats documented at:
        // https://developer.apple.com/documentation/metal/mtlreadwritetexturetier/mtlreadwritetexturetier1?language=objc
        // https://developer.apple.com/documentation/metal/mtlreadwritetexturetier/mtlreadwritetexturetier2?language=objc
        let (read_write_tier1_if, read_write_tier2_if) = match pc.read_write_texture_tier {
            MTLReadWriteTextureTier::TierNone => (Tfc::empty(), Tfc::empty()),
            MTLReadWriteTextureTier::Tier1 => (Tfc::STORAGE_READ_WRITE, Tfc::empty()),
            MTLReadWriteTextureTier::Tier2 => (Tfc::STORAGE_READ_WRITE, Tfc::STORAGE_READ_WRITE),
        };
        let msaa_count = pc.sample_count_mask;

        let msaa_resolve_desktop_if = if pc.msaa_desktop {
            Tfc::MULTISAMPLE_RESOLVE
        } else {
            Tfc::empty()
        };
        let msaa_resolve_apple3x_if = if pc.msaa_desktop | pc.msaa_apple3 {
            Tfc::MULTISAMPLE_RESOLVE
        } else {
            Tfc::empty()
        };
        let is_not_apple1x = super::PrivateCapabilities::supports_any(
            self.shared.device.lock().as_ref(),
            &[
                MTLFeatureSet::iOS_GPUFamily2_v1,
                MTLFeatureSet::macOS_GPUFamily1_v1,
                MTLFeatureSet::tvOS_GPUFamily1_v1,
            ],
        );

        let image_atomic_if = if pc.msl_version >= MTLLanguageVersion::V3_1 {
            Tfc::STORAGE_ATOMIC
        } else {
            Tfc::empty()
        };

        let image_64_atomic_if = if pc.int64_atomics {
            Tfc::STORAGE_ATOMIC
        } else {
            Tfc::empty()
        };

        // Metal defined pixel format capabilities
        let all_caps = Tfc::SAMPLED_LINEAR
            | Tfc::STORAGE_WRITE_ONLY
            | Tfc::COLOR_ATTACHMENT
            | Tfc::COLOR_ATTACHMENT_BLEND
            | msaa_count
            | Tfc::MULTISAMPLE_RESOLVE;

        let extra = match format {
            Tf::R8Unorm | Tf::R16Float | Tf::Rgba8Unorm | Tf::Rgba16Float => {
                read_write_tier2_if | all_caps
            }
            Tf::R8Snorm | Tf::Rg8Snorm | Tf::Rgba8Snorm => {
                let mut flags = all_caps;
                flags.set(Tfc::MULTISAMPLE_RESOLVE, is_not_apple1x);
                flags
            }
            Tf::R8Uint
            | Tf::R8Sint
            | Tf::R16Uint
            | Tf::R16Sint
            | Tf::Rgba8Uint
            | Tf::Rgba8Sint
            | Tf::Rgba16Uint
            | Tf::Rgba16Sint => {
                read_write_tier2_if | Tfc::STORAGE_WRITE_ONLY | Tfc::COLOR_ATTACHMENT | msaa_count
            }
            Tf::R16Unorm
            | Tf::R16Snorm
            | Tf::Rg16Unorm
            | Tf::Rg16Snorm
            | Tf::Rgba16Unorm
            | Tf::Rgba16Snorm => {
                Tfc::SAMPLED_LINEAR
                    | Tfc::STORAGE_WRITE_ONLY
                    | Tfc::COLOR_ATTACHMENT
                    | Tfc::COLOR_ATTACHMENT_BLEND
                    | msaa_count
                    | msaa_resolve_desktop_if
            }
            Tf::Rg8Unorm | Tf::Rg16Float | Tf::Bgra8Unorm => all_caps,
            Tf::Rg8Uint | Tf::Rg8Sint => {
                Tfc::STORAGE_WRITE_ONLY | Tfc::COLOR_ATTACHMENT | msaa_count
            }
            Tf::R32Uint | Tf::R32Sint => {
                read_write_tier1_if
                    | Tfc::STORAGE_WRITE_ONLY
                    | Tfc::COLOR_ATTACHMENT
                    | msaa_count
                    | image_atomic_if
            }
            Tf::R32Float => {
                let flags = if pc.format_r32float_all {
                    all_caps
                } else {
                    Tfc::STORAGE_WRITE_ONLY
                        | Tfc::COLOR_ATTACHMENT
                        | Tfc::COLOR_ATTACHMENT_BLEND
                        | msaa_count
                };
                read_write_tier1_if | flags
            }
            Tf::Rg16Uint | Tf::Rg16Sint => {
                Tfc::STORAGE_WRITE_ONLY | Tfc::COLOR_ATTACHMENT | msaa_count
            }
            Tf::Rgba8UnormSrgb | Tf::Bgra8UnormSrgb => {
                let mut flags = all_caps;
                flags.set(Tfc::STORAGE_WRITE_ONLY, pc.format_rgba8_srgb_all);
                flags
            }
            Tf::Rgb10a2Uint => {
                let mut flags = Tfc::COLOR_ATTACHMENT | msaa_count;
                flags.set(Tfc::STORAGE_WRITE_ONLY, pc.format_rgb10a2_uint_write);
                flags
            }
            Tf::Rgb10a2Unorm => {
                let mut flags = all_caps;
                flags.set(Tfc::STORAGE_WRITE_ONLY, pc.format_rgb10a2_unorm_all);
                flags
            }
            Tf::Rg11b10Ufloat => {
                let mut flags = all_caps;
                flags.set(Tfc::STORAGE_WRITE_ONLY, pc.format_rg11b10_all);
                flags
            }
            Tf::R64Uint => {
                Tfc::COLOR_ATTACHMENT
                    | Tfc::STORAGE_WRITE_ONLY
                    | image_64_atomic_if
                    | read_write_tier1_if
            }
            Tf::Rg32Uint | Tf::Rg32Sint => {
                Tfc::COLOR_ATTACHMENT | Tfc::STORAGE_WRITE_ONLY | msaa_count
            }
            Tf::Rg32Float => {
                if pc.format_rg32float_all {
                    all_caps
                } else {
                    Tfc::STORAGE_WRITE_ONLY
                        | Tfc::COLOR_ATTACHMENT
                        | Tfc::COLOR_ATTACHMENT_BLEND
                        | msaa_count
                }
            }
            Tf::Rgba32Uint | Tf::Rgba32Sint => {
                read_write_tier2_if | Tfc::STORAGE_WRITE_ONLY | Tfc::COLOR_ATTACHMENT | msaa_count
            }
            Tf::Rgba32Float => {
                let mut flags =
                    read_write_tier2_if | Tfc::STORAGE_WRITE_ONLY | Tfc::COLOR_ATTACHMENT;
                if pc.format_rgba32float_all {
                    flags |= all_caps
                } else if pc.msaa_apple7 {
                    flags |= msaa_count
                };
                flags
            }
            Tf::Stencil8 => {
                all_caps | Tfc::DEPTH_STENCIL_ATTACHMENT | msaa_count | msaa_resolve_apple3x_if
            }
            Tf::Depth16Unorm => {
                let mut flags =
                    Tfc::DEPTH_STENCIL_ATTACHMENT | msaa_count | msaa_resolve_apple3x_if;
                if pc.format_depth16unorm {
                    flags |= Tfc::SAMPLED_LINEAR
                }
                flags
            }
            Tf::Depth32Float | Tf::Depth32FloatStencil8 => {
                let mut flags =
                    Tfc::DEPTH_STENCIL_ATTACHMENT | msaa_count | msaa_resolve_apple3x_if;
                if pc.format_depth32float_filter {
                    flags |= Tfc::SAMPLED_LINEAR
                }
                flags
            }
            Tf::Depth24Plus | Tf::Depth24PlusStencil8 => {
                let mut flags = Tfc::DEPTH_STENCIL_ATTACHMENT | msaa_count;
                if pc.format_depth24_stencil8 {
                    flags |= Tfc::SAMPLED_LINEAR | Tfc::MULTISAMPLE_RESOLVE
                } else {
                    flags |= msaa_resolve_apple3x_if;
                    if pc.format_depth32float_filter {
                        flags |= Tfc::SAMPLED_LINEAR
                    }
                }
                flags
            }
            Tf::NV12 => return Tfc::empty(),
            Tf::Rgb9e5Ufloat => {
                if pc.msaa_apple3 {
                    all_caps
                } else if pc.msaa_desktop {
                    Tfc::SAMPLED_LINEAR
                } else {
                    Tfc::SAMPLED_LINEAR
                        | Tfc::COLOR_ATTACHMENT
                        | Tfc::COLOR_ATTACHMENT_BLEND
                        | msaa_count
                        | Tfc::MULTISAMPLE_RESOLVE
                }
            }
            Tf::Bc1RgbaUnorm
            | Tf::Bc1RgbaUnormSrgb
            | Tf::Bc2RgbaUnorm
            | Tf::Bc2RgbaUnormSrgb
            | Tf::Bc3RgbaUnorm
            | Tf::Bc3RgbaUnormSrgb
            | Tf::Bc4RUnorm
            | Tf::Bc4RSnorm
            | Tf::Bc5RgUnorm
            | Tf::Bc5RgSnorm
            | Tf::Bc6hRgbUfloat
            | Tf::Bc6hRgbFloat
            | Tf::Bc7RgbaUnorm
            | Tf::Bc7RgbaUnormSrgb => {
                if pc.format_bc {
                    Tfc::SAMPLED_LINEAR
                } else {
                    Tfc::empty()
                }
            }
            Tf::Etc2Rgb8Unorm
            | Tf::Etc2Rgb8UnormSrgb
            | Tf::Etc2Rgb8A1Unorm
            | Tf::Etc2Rgb8A1UnormSrgb
            | Tf::Etc2Rgba8Unorm
            | Tf::Etc2Rgba8UnormSrgb
            | Tf::EacR11Unorm
            | Tf::EacR11Snorm
            | Tf::EacRg11Unorm
            | Tf::EacRg11Snorm => {
                if pc.format_eac_etc {
                    Tfc::SAMPLED_LINEAR
                } else {
                    Tfc::empty()
                }
            }
            Tf::Astc {
                block: _,
                channel: _,
            } => {
                if pc.format_astc || pc.format_astc_hdr {
                    Tfc::SAMPLED_LINEAR
                } else {
                    Tfc::empty()
                }
            }
        };

        Tfc::COPY_SRC | Tfc::COPY_DST | Tfc::SAMPLED | Tfc::STORAGE_READ_ONLY | extra
    }

    unsafe fn surface_capabilities(
        &self,
        surface: &super::Surface,
    ) -> Option<crate::SurfaceCapabilities> {
        let current_extent = if surface.main_thread_id == thread::current().id() {
            Some(surface.dimensions())
        } else {
            log::warn!("Unable to get the current view dimensions on a non-main thread");
            None
        };

        let mut formats = vec![
            wgt::TextureFormat::Bgra8Unorm,
            wgt::TextureFormat::Bgra8UnormSrgb,
            wgt::TextureFormat::Rgba16Float,
        ];
        if self.shared.private_caps.format_rgb10a2_unorm_all {
            formats.push(wgt::TextureFormat::Rgb10a2Unorm);
        }

        let pc = &self.shared.private_caps;
        Some(crate::SurfaceCapabilities {
            formats,
            // We use this here to govern the maximum number of drawables + 1.
            // See https://developer.apple.com/documentation/quartzcore/cametallayer/2938720-maximumdrawablecount
            maximum_frame_latency: if pc.can_set_maximum_drawables_count {
                1..=2
            } else {
                // 3 is the default value for maximum drawables in `CAMetalLayer` documentation
                // iOS 10.3 was tested to use 3 on iphone5s
                2..=2
            },
            present_modes: if pc.can_set_display_sync {
                vec![wgt::PresentMode::Fifo, wgt::PresentMode::Immediate]
            } else {
                vec![wgt::PresentMode::Fifo]
            },
            composite_alpha_modes: vec![
                wgt::CompositeAlphaMode::Opaque,
                wgt::CompositeAlphaMode::PostMultiplied,
            ],

            current_extent,
            usage: wgt::TextureUses::COLOR_TARGET
                | wgt::TextureUses::COPY_SRC
                | wgt::TextureUses::COPY_DST
                | wgt::TextureUses::STORAGE_READ_ONLY
                | wgt::TextureUses::STORAGE_WRITE_ONLY
                | wgt::TextureUses::STORAGE_READ_WRITE,
        })
    }

    unsafe fn get_presentation_timestamp(&self) -> wgt::PresentationTimestamp {
        let timestamp = self.shared.presentation_timer.get_timestamp_ns();

        wgt::PresentationTimestamp(timestamp)
    }
}

const RESOURCE_HEAP_SUPPORT: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily1_v3,
    MTLFeatureSet::tvOS_GPUFamily1_v2,
    MTLFeatureSet::macOS_GPUFamily1_v3,
];

const MUTABLE_COMPARISON_SAMPLER_SUPPORT: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily3_v1,
    MTLFeatureSet::macOS_GPUFamily1_v1,
];

const SAMPLER_CLAMP_TO_BORDER_SUPPORT: &[MTLFeatureSet] = &[MTLFeatureSet::macOS_GPUFamily1_v2];

const ASTC_PIXEL_FORMAT_FEATURES: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily2_v1,
    MTLFeatureSet::tvOS_GPUFamily1_v1,
];

const ANY8_UNORM_SRGB_ALL: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily2_v3,
    MTLFeatureSet::tvOS_GPUFamily1_v2,
];

const ANY8_SNORM_RESOLVE: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily2_v1,
    MTLFeatureSet::tvOS_GPUFamily1_v1,
    MTLFeatureSet::macOS_GPUFamily1_v1,
];

const RGBA8_SRGB: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily2_v3,
    MTLFeatureSet::tvOS_GPUFamily1_v2,
];

const RGB10A2UNORM_ALL: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily3_v1,
    MTLFeatureSet::tvOS_GPUFamily2_v1,
    MTLFeatureSet::macOS_GPUFamily1_v1,
];

const RGB10A2UINT_WRITE: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily3_v1,
    MTLFeatureSet::tvOS_GPUFamily2_v1,
    MTLFeatureSet::macOS_GPUFamily1_v1,
];

const RG11B10FLOAT_ALL: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily3_v1,
    MTLFeatureSet::tvOS_GPUFamily2_v1,
    MTLFeatureSet::macOS_GPUFamily1_v1,
];

const RGB9E5FLOAT_ALL: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily3_v1,
    MTLFeatureSet::tvOS_GPUFamily2_v1,
];

const BGR10A2_ALL: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily1_v4,
    MTLFeatureSet::tvOS_GPUFamily1_v3,
    MTLFeatureSet::macOS_GPUFamily2_v1,
];

/// "Indirect draw & dispatch arguments" in the Metal feature set tables
const INDIRECT_DRAW_DISPATCH_SUPPORT: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily3_v1,
    MTLFeatureSet::tvOS_GPUFamily2_v1,
    MTLFeatureSet::macOS_GPUFamily1_v1,
];

/// "Base vertex/instance drawing" in the Metal feature set tables
///
/// in our terms, `base_vertex` and `first_instance` must be 0
const BASE_VERTEX_FIRST_INSTANCE_SUPPORT: &[MTLFeatureSet] = INDIRECT_DRAW_DISPATCH_SUPPORT;

const TEXTURE_CUBE_ARRAY_SUPPORT: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily4_v1,
    MTLFeatureSet::tvOS_GPUFamily1_v2,
    MTLFeatureSet::macOS_GPUFamily1_v1,
];

const DUAL_SOURCE_BLEND_SUPPORT: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily1_v4,
    MTLFeatureSet::tvOS_GPUFamily1_v3,
    MTLFeatureSet::macOS_GPUFamily1_v2,
];

const LAYERED_RENDERING_SUPPORT: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily5_v1,
    MTLFeatureSet::macOS_GPUFamily1_v1,
    MTLFeatureSet::macOS_GPUFamily2_v1,
];

const FUNCTION_SPECIALIZATION_SUPPORT: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily1_v3,
    MTLFeatureSet::tvOS_GPUFamily1_v2,
    MTLFeatureSet::macOS_GPUFamily1_v2,
];

const DEPTH_CLIP_MODE: &[MTLFeatureSet] = &[
    MTLFeatureSet::iOS_GPUFamily4_v1,
    MTLFeatureSet::tvOS_GPUFamily1_v3,
    MTLFeatureSet::macOS_GPUFamily1_v1,
];

const OS_NOT_SUPPORT: (usize, usize) = (10000, 0);

impl super::PrivateCapabilities {
    fn supports_any(raw: &metal::DeviceRef, features_sets: &[MTLFeatureSet]) -> bool {
        features_sets
            .iter()
            .cloned()
            .any(|x| raw.supports_feature_set(x))
    }

    pub fn new(device: &metal::Device) -> Self {
        #[repr(C)]
        #[derive(Clone, Copy, Debug)]
        #[allow(clippy::upper_case_acronyms)]
        struct NSOperatingSystemVersion {
            major: usize,
            minor: usize,
            patch: usize,
        }

        impl NSOperatingSystemVersion {
            fn at_least(
                &self,
                mac_version: (usize, usize),
                ios_version: (usize, usize),
                is_mac: bool,
            ) -> bool {
                if is_mac {
                    self.major > mac_version.0
                        || (self.major == mac_version.0 && self.minor >= mac_version.1)
                } else {
                    self.major > ios_version.0
                        || (self.major == ios_version.0 && self.minor >= ios_version.1)
                }
            }
        }

        let version: NSOperatingSystemVersion = unsafe {
            let process_info: *mut objc::runtime::Object =
                msg_send![class!(NSProcessInfo), processInfo];
            msg_send![process_info, operatingSystemVersion]
        };

        let os_is_mac = device.supports_feature_set(MTLFeatureSet::macOS_GPUFamily1_v1);
        // Metal was first introduced in OS X 10.11 and iOS 8. The current version number of visionOS is 1.0.0. Additionally,
        // on the Simulator, Apple only provides the Apple2 GPU capability, and the Apple2+ GPU capability covers the capabilities of Apple2.
        // Therefore, the following conditions can be used to determine if it is visionOS.
        // https://developer.apple.com/documentation/metal/developing_metal_apps_that_run_in_simulator
        let os_is_xr = version.major < 8 && device.supports_family(MTLGPUFamily::Apple2);
        let family_check = os_is_xr || version.at_least((10, 15), (13, 0), os_is_mac);

        let mut sample_count_mask = crate::TextureFormatCapabilities::MULTISAMPLE_X4; // 1 and 4 samples are supported on all devices
        if device.supports_texture_sample_count(2) {
            sample_count_mask |= crate::TextureFormatCapabilities::MULTISAMPLE_X2;
        }
        if device.supports_texture_sample_count(8) {
            sample_count_mask |= crate::TextureFormatCapabilities::MULTISAMPLE_X8;
        }
        if device.supports_texture_sample_count(16) {
            sample_count_mask |= crate::TextureFormatCapabilities::MULTISAMPLE_X16;
        }

        let rw_texture_tier = if version.at_least((10, 13), (11, 0), os_is_mac) {
            device.read_write_texture_support()
        } else if version.at_least((10, 12), OS_NOT_SUPPORT, os_is_mac) {
            if Self::supports_any(device, &[MTLFeatureSet::macOS_ReadWriteTextureTier2]) {
                MTLReadWriteTextureTier::Tier2
            } else {
                MTLReadWriteTextureTier::Tier1
            }
        } else {
            MTLReadWriteTextureTier::TierNone
        };

        let mut timestamp_query_support = TimestampQuerySupport::empty();
        if version.at_least((11, 0), (14, 0), os_is_mac)
            && device.supports_counter_sampling(metal::MTLCounterSamplingPoint::AtStageBoundary)
        {
            // If we don't support at stage boundary, don't support anything else.
            timestamp_query_support.insert(TimestampQuerySupport::STAGE_BOUNDARIES);

            if device.supports_counter_sampling(metal::MTLCounterSamplingPoint::AtDrawBoundary) {
                timestamp_query_support.insert(TimestampQuerySupport::ON_RENDER_ENCODER);
            }
            if device.supports_counter_sampling(metal::MTLCounterSamplingPoint::AtDispatchBoundary)
            {
                timestamp_query_support.insert(TimestampQuerySupport::ON_COMPUTE_ENCODER);
            }
            if device.supports_counter_sampling(metal::MTLCounterSamplingPoint::AtBlitBoundary) {
                timestamp_query_support.insert(TimestampQuerySupport::ON_BLIT_ENCODER);
            }
            // `TimestampQuerySupport::INSIDE_WGPU_PASSES` emerges from the other flags.
        }

        let argument_buffers = device.argument_buffers_support();

        Self {
            family_check,
            msl_version: if os_is_xr || version.at_least((14, 0), (17, 0), os_is_mac) {
                MTLLanguageVersion::V3_1
            } else if version.at_least((13, 0), (16, 0), os_is_mac) {
                MTLLanguageVersion::V3_0
            } else if version.at_least((12, 0), (15, 0), os_is_mac) {
                MTLLanguageVersion::V2_4
            } else if version.at_least((11, 0), (14, 0), os_is_mac) {
                MTLLanguageVersion::V2_3
            } else if version.at_least((10, 15), (13, 0), os_is_mac) {
                MTLLanguageVersion::V2_2
            } else if version.at_least((10, 14), (12, 0), os_is_mac) {
                MTLLanguageVersion::V2_1
            } else if version.at_least((10, 13), (11, 0), os_is_mac) {
                MTLLanguageVersion::V2_0
            } else if version.at_least((10, 12), (10, 0), os_is_mac) {
                MTLLanguageVersion::V1_2
            } else if version.at_least((10, 11), (9, 0), os_is_mac) {
                MTLLanguageVersion::V1_1
            } else {
                MTLLanguageVersion::V1_0
            },
            // macOS 10.11 doesn't support read-write resources
            fragment_rw_storage: version.at_least((10, 12), (8, 0), os_is_mac),
            read_write_texture_tier: rw_texture_tier,
            msaa_desktop: os_is_mac,
            msaa_apple3: if family_check {
                device.supports_family(MTLGPUFamily::Apple3)
            } else {
                device.supports_feature_set(MTLFeatureSet::iOS_GPUFamily3_v4)
            },
            msaa_apple7: family_check && device.supports_family(MTLGPUFamily::Apple7),
            resource_heaps: Self::supports_any(device, RESOURCE_HEAP_SUPPORT),
            argument_buffers,
            shared_textures: !os_is_mac,
            mutable_comparison_samplers: Self::supports_any(
                device,
                MUTABLE_COMPARISON_SAMPLER_SUPPORT,
            ),
            sampler_clamp_to_border: Self::supports_any(device, SAMPLER_CLAMP_TO_BORDER_SUPPORT),
            indirect_draw_dispatch: Self::supports_any(device, INDIRECT_DRAW_DISPATCH_SUPPORT),
            base_vertex_first_instance_drawing: Self::supports_any(
                device,
                BASE_VERTEX_FIRST_INSTANCE_SUPPORT,
            ),
            dual_source_blending: Self::supports_any(device, DUAL_SOURCE_BLEND_SUPPORT),
            low_power: !os_is_mac || device.is_low_power(),
            headless: os_is_mac && device.is_headless(),
            layered_rendering: Self::supports_any(device, LAYERED_RENDERING_SUPPORT),
            function_specialization: Self::supports_any(device, FUNCTION_SPECIALIZATION_SUPPORT),
            depth_clip_mode: Self::supports_any(device, DEPTH_CLIP_MODE),
            texture_cube_array: Self::supports_any(device, TEXTURE_CUBE_ARRAY_SUPPORT),
            supports_float_filtering: os_is_mac
                || (version.at_least((11, 0), (14, 0), os_is_mac)
                    && device.supports_32bit_float_filtering()),
            format_depth24_stencil8: os_is_mac && device.d24_s8_supported(),
            format_depth32_stencil8_filter: os_is_mac,
            format_depth32_stencil8_none: !os_is_mac,
            format_min_srgb_channels: if os_is_mac { 4 } else { 1 },
            format_b5: !os_is_mac,
            format_bc: os_is_mac,
            format_eac_etc: !os_is_mac
                // M1 in macOS supports EAC/ETC2
                || (family_check && device.supports_family(MTLGPUFamily::Apple7)),
            // A8(Apple2) and later always support ASTC pixel formats
            format_astc: (family_check && device.supports_family(MTLGPUFamily::Apple2))
                || Self::supports_any(device, ASTC_PIXEL_FORMAT_FEATURES),
            // A13(Apple6) M1(Apple7) and later always support HDR ASTC pixel formats
            format_astc_hdr: family_check && device.supports_family(MTLGPUFamily::Apple6),
            format_any8_unorm_srgb_all: Self::supports_any(device, ANY8_UNORM_SRGB_ALL),
            format_any8_unorm_srgb_no_write: !Self::supports_any(device, ANY8_UNORM_SRGB_ALL)
                && !os_is_mac,
            format_any8_snorm_all: Self::supports_any(device, ANY8_SNORM_RESOLVE),
            format_r16_norm_all: os_is_mac,
            // No devices support r32's all capabilities
            format_r32_all: false,
            // All devices support r32's write capability
            format_r32_no_write: false,
            // iOS support r32float's write capability, macOS support r32float's all capabilities
            format_r32float_no_write_no_filter: false,
            // Only iOS doesn't support r32float's filter  capability
            format_r32float_no_filter: !os_is_mac,
            format_r32float_all: os_is_mac,
            format_rgba8_srgb_all: Self::supports_any(device, RGBA8_SRGB),
            format_rgba8_srgb_no_write: !Self::supports_any(device, RGBA8_SRGB),
            format_rgb10a2_unorm_all: Self::supports_any(device, RGB10A2UNORM_ALL),
            format_rgb10a2_unorm_no_write: !Self::supports_any(device, RGB10A2UNORM_ALL),
            format_rgb10a2_uint_write: Self::supports_any(device, RGB10A2UINT_WRITE),
            format_rg11b10_all: Self::supports_any(device, RG11B10FLOAT_ALL),
            format_rg11b10_no_write: !Self::supports_any(device, RG11B10FLOAT_ALL),
            format_rgb9e5_all: Self::supports_any(device, RGB9E5FLOAT_ALL),
            format_rgb9e5_no_write: !Self::supports_any(device, RGB9E5FLOAT_ALL) && !os_is_mac,
            format_rgb9e5_filter_only: os_is_mac,
            format_rg32_color: true,
            format_rg32_color_write: true,
            // Only macOS support rg32float's all capabilities
            format_rg32float_all: os_is_mac,
            // All devices support rg32float's color + blend capabilities
            format_rg32float_color_blend: true,
            // Only iOS doesn't support rg32float's filter
            format_rg32float_no_filter: !os_is_mac,
            format_rgba32int_color: true,
            // All devices support rgba32uint and rgba32sint's color + write capabilities
            format_rgba32int_color_write: true,
            format_rgba32float_color: true,
            // All devices support rgba32float's color + write capabilities
            format_rgba32float_color_write: true,
            // Only macOS support rgba32float's all capabilities
            format_rgba32float_all: os_is_mac,
            format_depth16unorm: Self::supports_any(
                device,
                &[
                    MTLFeatureSet::iOS_GPUFamily3_v3,
                    MTLFeatureSet::macOS_GPUFamily1_v2,
                ],
            ),
            format_depth32float_filter: os_is_mac,
            format_depth32float_none: !os_is_mac,
            format_bgr10a2_all: Self::supports_any(device, BGR10A2_ALL),
            format_bgr10a2_no_write: !Self::supports_any(device, BGR10A2_ALL),
            max_buffers_per_stage: 31,
            max_vertex_buffers: 31.min(crate::MAX_VERTEX_BUFFERS as u32),
            max_textures_per_stage: if os_is_mac
                || (family_check && device.supports_family(MTLGPUFamily::Apple6))
            {
                128
            } else if family_check && device.supports_family(MTLGPUFamily::Apple4) {
                96
            } else {
                31
            },
            max_samplers_per_stage: 16,
            max_binding_array_elements: if argument_buffers == metal::MTLArgumentBuffersTier::Tier2
            {
                1_000_000
            } else if family_check && device.supports_family(MTLGPUFamily::Apple4) {
                96
            } else {
                31
            },
            max_sampler_binding_array_elements: if family_check
                && device.supports_family(MTLGPUFamily::Apple9)
            {
                500_000
            } else if family_check
                && (device.supports_family(MTLGPUFamily::Apple7)
                    || device.supports_family(MTLGPUFamily::Mac2))
            {
                1000
            } else if family_check && device.supports_family(MTLGPUFamily::Apple6) {
                128
            } else {
                16
            },
            buffer_alignment: if os_is_mac || os_is_xr { 256 } else { 64 },
            max_buffer_size: if version.at_least((10, 14), (12, 0), os_is_mac) {
                // maxBufferLength available on macOS 10.14+ and iOS 12.0+
                let buffer_size: metal::NSInteger =
                    unsafe { msg_send![device.as_ref(), maxBufferLength] };
                buffer_size as _
            } else if os_is_mac {
                1 << 30 // 1GB on macOS 10.11 and up
            } else {
                1 << 28 // 256MB on iOS 8.0+
            },
            max_texture_size: if Self::supports_any(
                device,
                &[
                    MTLFeatureSet::iOS_GPUFamily3_v1,
                    MTLFeatureSet::tvOS_GPUFamily2_v1,
                    MTLFeatureSet::macOS_GPUFamily1_v1,
                ],
            ) {
                16384
            } else {
                8192
            },
            max_texture_3d_size: 2048,
            max_texture_layers: 2048,
            max_fragment_input_components: if os_is_mac
                || device.supports_feature_set(MTLFeatureSet::iOS_GPUFamily4_v1)
            {
                124
            } else {
                60
            },
            max_color_render_targets: if Self::supports_any(
                device,
                &[
                    MTLFeatureSet::iOS_GPUFamily2_v1,
                    MTLFeatureSet::tvOS_GPUFamily1_v1,
                    MTLFeatureSet::macOS_GPUFamily1_v1,
                ],
            ) {
                8
            } else {
                4
            },
            // Per https://developer.apple.com/metal/Metal-Feature-Set-Tables.pdf
            max_color_attachment_bytes_per_sample: if family_check
                && device.supports_family(MTLGPUFamily::Apple4)
            {
                64
            } else {
                32
            },
            max_varying_components: if device
                .supports_feature_set(MTLFeatureSet::macOS_GPUFamily1_v1)
            {
                124
            } else {
                60
            },
            max_threads_per_group: if Self::supports_any(
                device,
                &[
                    MTLFeatureSet::iOS_GPUFamily4_v2,
                    MTLFeatureSet::macOS_GPUFamily1_v1,
                ],
            ) {
                1024
            } else {
                512
            },
            max_total_threadgroup_memory: if Self::supports_any(
                device,
                &[
                    MTLFeatureSet::iOS_GPUFamily4_v1,
                    MTLFeatureSet::macOS_GPUFamily1_v2,
                ],
            ) {
                32 << 10
            } else {
                16 << 10
            },
            sample_count_mask,
            supports_debug_markers: Self::supports_any(
                device,
                &[
                    MTLFeatureSet::macOS_GPUFamily1_v2,
                    MTLFeatureSet::iOS_GPUFamily1_v3,
                    MTLFeatureSet::tvOS_GPUFamily1_v2,
                ],
            ),
            supports_binary_archives: family_check
                && (device.supports_family(MTLGPUFamily::Apple3)
                    || device.supports_family(MTLGPUFamily::Mac1)),
            supports_capture_manager: version.at_least((10, 13), (11, 0), os_is_mac),
            can_set_maximum_drawables_count: version.at_least((10, 14), (11, 2), os_is_mac),
            can_set_display_sync: version.at_least((10, 13), OS_NOT_SUPPORT, os_is_mac),
            can_set_next_drawable_timeout: version.at_least((10, 13), (11, 0), os_is_mac),
            supports_arrays_of_textures: Self::supports_any(
                device,
                &[
                    MTLFeatureSet::iOS_GPUFamily3_v2,
                    MTLFeatureSet::tvOS_GPUFamily2_v1,
                    MTLFeatureSet::macOS_GPUFamily1_v3,
                ],
            ),
            supports_arrays_of_textures_write: family_check
                && (device.supports_family(MTLGPUFamily::Apple6)
                    || device.supports_family(MTLGPUFamily::Mac1)
                    || device.supports_family(MTLGPUFamily::MacCatalyst1)),
            supports_mutability: version.at_least((10, 13), (11, 0), os_is_mac),
            //Depth clipping is supported on all macOS GPU families and iOS family 4 and later
            supports_depth_clip_control: os_is_mac
                || device.supports_feature_set(MTLFeatureSet::iOS_GPUFamily4_v1),
            supports_preserve_invariance: version.at_least((11, 0), (13, 0), os_is_mac),
            // Metal 2.2 on mac, 2.3 on iOS.
            supports_shader_primitive_index: version.at_least((10, 15), (14, 0), os_is_mac),
            has_unified_memory: if version.at_least((10, 15), (13, 0), os_is_mac) {
                Some(device.has_unified_memory())
            } else {
                None
            },
            timestamp_query_support,
            supports_simd_scoped_operations: family_check
                && (device.supports_family(MTLGPUFamily::Metal3)
                    || device.supports_family(MTLGPUFamily::Mac2)
                    || device.supports_family(MTLGPUFamily::Apple7)),
            // https://developer.apple.com/metal/Metal-Feature-Set-Tables.pdf#page=5
            int64: family_check
                && (device.supports_family(MTLGPUFamily::Apple3)
                    || device.supports_family(MTLGPUFamily::Metal3)),
            // https://developer.apple.com/metal/Metal-Feature-Set-Tables.pdf#page=6
            int64_atomics: family_check
                && ((device.supports_family(MTLGPUFamily::Apple8)
                    && device.supports_family(MTLGPUFamily::Mac2))
                    || device.supports_family(MTLGPUFamily::Apple9)),
            // https://developer.apple.com/metal/Metal-Feature-Set-Tables.pdf#page=6
            float_atomics: family_check
                && (device.supports_family(MTLGPUFamily::Apple7)
                    || device.supports_family(MTLGPUFamily::Mac2)),
            supports_shared_event: version.at_least((10, 14), (12, 0), os_is_mac),
        }
    }

    pub fn device_type(&self) -> wgt::DeviceType {
        if self.has_unified_memory.unwrap_or(self.low_power) {
            wgt::DeviceType::IntegratedGpu
        } else {
            wgt::DeviceType::DiscreteGpu
        }
    }

    pub fn features(&self) -> wgt::Features {
        use wgt::Features as F;

        let mut features = F::empty()
            | F::MSL_SHADER_PASSTHROUGH
            | F::MAPPABLE_PRIMARY_BUFFERS
            | F::VERTEX_WRITABLE_STORAGE
            | F::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES
            | F::PUSH_CONSTANTS
            | F::POLYGON_MODE_LINE
            | F::CLEAR_TEXTURE
            | F::TEXTURE_FORMAT_16BIT_NORM
            | F::SHADER_F16
            | F::DEPTH32FLOAT_STENCIL8
            | F::BGRA8UNORM_STORAGE;

        features.set(F::FLOAT32_FILTERABLE, self.supports_float_filtering);
        features.set(
            F::INDIRECT_FIRST_INSTANCE | F::MULTI_DRAW_INDIRECT,
            self.indirect_draw_dispatch,
        );
        features.set(
            F::TIMESTAMP_QUERY | F::TIMESTAMP_QUERY_INSIDE_ENCODERS,
            self.timestamp_query_support
                .contains(TimestampQuerySupport::STAGE_BOUNDARIES),
        );
        features.set(
            F::TIMESTAMP_QUERY_INSIDE_PASSES,
            self.timestamp_query_support
                .contains(TimestampQuerySupport::INSIDE_WGPU_PASSES),
        );
        features.set(
            F::DUAL_SOURCE_BLENDING,
            self.msl_version >= MTLLanguageVersion::V1_2 && self.dual_source_blending,
        );
        features.set(F::TEXTURE_COMPRESSION_ASTC, self.format_astc);
        features.set(F::TEXTURE_COMPRESSION_ASTC_HDR, self.format_astc_hdr);
        features.set(F::TEXTURE_COMPRESSION_BC, self.format_bc);
        features.set(F::TEXTURE_COMPRESSION_BC_SLICED_3D, self.format_bc); // BC guarantees Sliced 3D
        features.set(F::TEXTURE_COMPRESSION_ETC2, self.format_eac_etc);

        features.set(F::DEPTH_CLIP_CONTROL, self.supports_depth_clip_control);
        features.set(
            F::SHADER_PRIMITIVE_INDEX,
            self.supports_shader_primitive_index,
        );

        features.set(
            F::TEXTURE_BINDING_ARRAY
                | F::SAMPLED_TEXTURE_AND_STORAGE_BUFFER_ARRAY_NON_UNIFORM_INDEXING
                | F::STORAGE_TEXTURE_ARRAY_NON_UNIFORM_INDEXING
                | F::PARTIALLY_BOUND_BINDING_ARRAY,
            self.msl_version >= MTLLanguageVersion::V3_0
                && self.supports_arrays_of_textures
                && self.argument_buffers as u64 >= metal::MTLArgumentBuffersTier::Tier2 as u64,
        );
        features.set(
            F::SHADER_INT64,
            self.int64 && self.msl_version >= MTLLanguageVersion::V2_3,
        );
        features.set(
            F::SHADER_INT64_ATOMIC_MIN_MAX,
            self.int64_atomics && self.msl_version >= MTLLanguageVersion::V2_4,
        );
        features.set(
            F::TEXTURE_INT64_ATOMIC,
            self.int64_atomics && self.msl_version >= MTLLanguageVersion::V3_1,
        );
        features.set(
            F::TEXTURE_ATOMIC,
            self.msl_version >= MTLLanguageVersion::V3_1,
        );
        features.set(
            F::SHADER_FLOAT32_ATOMIC,
            self.float_atomics && self.msl_version >= MTLLanguageVersion::V3_0,
        );

        features.set(
            F::ADDRESS_MODE_CLAMP_TO_BORDER,
            self.sampler_clamp_to_border,
        );
        features.set(F::ADDRESS_MODE_CLAMP_TO_ZERO, true);

        features.set(F::RG11B10UFLOAT_RENDERABLE, self.format_rg11b10_all);

        if self.supports_simd_scoped_operations {
            features.insert(F::SUBGROUP | F::SUBGROUP_BARRIER);
        }

        features
    }

    pub fn capabilities(&self) -> crate::Capabilities {
        let mut downlevel = wgt::DownlevelCapabilities::default();
        downlevel.flags.set(
            wgt::DownlevelFlags::FRAGMENT_WRITABLE_STORAGE,
            self.fragment_rw_storage,
        );
        downlevel.flags.set(
            wgt::DownlevelFlags::CUBE_ARRAY_TEXTURES,
            self.texture_cube_array,
        );
        // TODO: separate the mutable comparisons from immutable ones
        downlevel.flags.set(
            wgt::DownlevelFlags::COMPARISON_SAMPLERS,
            self.mutable_comparison_samplers,
        );
        downlevel.flags.set(
            wgt::DownlevelFlags::INDIRECT_EXECUTION,
            self.indirect_draw_dispatch,
        );
        // TODO: add another flag for `first_instance`
        downlevel.flags.set(
            wgt::DownlevelFlags::BASE_VERTEX,
            self.base_vertex_first_instance_drawing,
        );
        downlevel
            .flags
            .set(wgt::DownlevelFlags::ANISOTROPIC_FILTERING, true);

        let base = wgt::Limits::default();
        crate::Capabilities {
            limits: wgt::Limits {
                max_texture_dimension_1d: self.max_texture_size as u32,
                max_texture_dimension_2d: self.max_texture_size as u32,
                max_texture_dimension_3d: self.max_texture_3d_size as u32,
                max_texture_array_layers: self.max_texture_layers as u32,
                max_bind_groups: 8,
                max_bindings_per_bind_group: 65535,
                max_dynamic_uniform_buffers_per_pipeline_layout: base
                    .max_dynamic_uniform_buffers_per_pipeline_layout,
                max_dynamic_storage_buffers_per_pipeline_layout: base
                    .max_dynamic_storage_buffers_per_pipeline_layout,
                max_sampled_textures_per_shader_stage: self.max_textures_per_stage,
                max_samplers_per_shader_stage: self.max_samplers_per_stage,
                max_storage_buffers_per_shader_stage: self.max_buffers_per_stage,
                max_storage_textures_per_shader_stage: self.max_textures_per_stage,
                max_uniform_buffers_per_shader_stage: self.max_buffers_per_stage,
                max_binding_array_elements_per_shader_stage: self.max_binding_array_elements,
                max_binding_array_sampler_elements_per_shader_stage: self
                    .max_sampler_binding_array_elements,
                max_uniform_buffer_binding_size: self.max_buffer_size.min(!0u32 as u64) as u32,
                max_storage_buffer_binding_size: self.max_buffer_size.min(!0u32 as u64) as u32,
                max_vertex_buffers: self.max_vertex_buffers,
                max_vertex_attributes: 31,
                max_vertex_buffer_array_stride: base.max_vertex_buffer_array_stride,
                min_subgroup_size: 4,
                max_subgroup_size: 64,
                max_push_constant_size: 0x1000,
                min_uniform_buffer_offset_alignment: self.buffer_alignment as u32,
                min_storage_buffer_offset_alignment: self.buffer_alignment as u32,
                max_inter_stage_shader_components: self.max_varying_components,
                max_color_attachments: (self.max_color_render_targets as u32)
                    .min(crate::MAX_COLOR_ATTACHMENTS as u32),
                max_color_attachment_bytes_per_sample: self.max_color_attachment_bytes_per_sample
                    as u32,
                max_compute_workgroup_storage_size: self.max_total_threadgroup_memory,
                max_compute_invocations_per_workgroup: self.max_threads_per_group,
                max_compute_workgroup_size_x: self.max_threads_per_group,
                max_compute_workgroup_size_y: self.max_threads_per_group,
                max_compute_workgroup_size_z: self.max_threads_per_group,
                max_compute_workgroups_per_dimension: 0xFFFF,
                max_buffer_size: self.max_buffer_size,
                max_non_sampler_bindings: u32::MAX,
            },
            alignments: crate::Alignments {
                buffer_copy_offset: wgt::BufferSize::new(self.buffer_alignment).unwrap(),
                buffer_copy_pitch: wgt::BufferSize::new(4).unwrap(),
                // This backend has Naga incorporate bounds checks into the
                // Metal Shading Language it generates, so from `wgpu_hal`'s
                // users' point of view, references are tightly checked.
                uniform_bounds_check_alignment: wgt::BufferSize::new(1).unwrap(),
                raw_tlas_instance_size: 0,
                ray_tracing_scratch_buffer_alignment: 0,
            },
            downlevel,
        }
    }

    pub fn map_format(&self, format: wgt::TextureFormat) -> metal::MTLPixelFormat {
        use metal::MTLPixelFormat::*;
        use wgt::TextureFormat as Tf;
        match format {
            Tf::R8Unorm => R8Unorm,
            Tf::R8Snorm => R8Snorm,
            Tf::R8Uint => R8Uint,
            Tf::R8Sint => R8Sint,
            Tf::R16Uint => R16Uint,
            Tf::R16Sint => R16Sint,
            Tf::R16Unorm => R16Unorm,
            Tf::R16Snorm => R16Snorm,
            Tf::R16Float => R16Float,
            Tf::Rg8Unorm => RG8Unorm,
            Tf::Rg8Snorm => RG8Snorm,
            Tf::Rg8Uint => RG8Uint,
            Tf::Rg8Sint => RG8Sint,
            Tf::Rg16Unorm => RG16Unorm,
            Tf::Rg16Snorm => RG16Snorm,
            Tf::R32Uint => R32Uint,
            Tf::R32Sint => R32Sint,
            Tf::R32Float => R32Float,
            Tf::Rg16Uint => RG16Uint,
            Tf::Rg16Sint => RG16Sint,
            Tf::Rg16Float => RG16Float,
            Tf::Rgba8Unorm => RGBA8Unorm,
            Tf::Rgba8UnormSrgb => RGBA8Unorm_sRGB,
            Tf::Bgra8UnormSrgb => BGRA8Unorm_sRGB,
            Tf::Rgba8Snorm => RGBA8Snorm,
            Tf::Bgra8Unorm => BGRA8Unorm,
            Tf::Rgba8Uint => RGBA8Uint,
            Tf::Rgba8Sint => RGBA8Sint,
            Tf::Rgb10a2Uint => RGB10A2Uint,
            Tf::Rgb10a2Unorm => RGB10A2Unorm,
            Tf::Rg11b10Ufloat => RG11B10Float,
            // Ruint64 textures are emulated on metal
            Tf::R64Uint => RG32Uint,
            Tf::Rg32Uint => RG32Uint,
            Tf::Rg32Sint => RG32Sint,
            Tf::Rg32Float => RG32Float,
            Tf::Rgba16Uint => RGBA16Uint,
            Tf::Rgba16Sint => RGBA16Sint,
            Tf::Rgba16Unorm => RGBA16Unorm,
            Tf::Rgba16Snorm => RGBA16Snorm,
            Tf::Rgba16Float => RGBA16Float,
            Tf::Rgba32Uint => RGBA32Uint,
            Tf::Rgba32Sint => RGBA32Sint,
            Tf::Rgba32Float => RGBA32Float,
            Tf::Stencil8 => Stencil8,
            Tf::Depth16Unorm => Depth16Unorm,
            Tf::Depth32Float => Depth32Float,
            Tf::Depth32FloatStencil8 => Depth32Float_Stencil8,
            Tf::Depth24Plus => {
                if self.format_depth24_stencil8 {
                    Depth24Unorm_Stencil8
                } else {
                    Depth32Float
                }
            }
            Tf::Depth24PlusStencil8 => {
                if self.format_depth24_stencil8 {
                    Depth24Unorm_Stencil8
                } else {
                    Depth32Float_Stencil8
                }
            }
            Tf::NV12 => unreachable!(),
            Tf::Rgb9e5Ufloat => RGB9E5Float,
            Tf::Bc1RgbaUnorm => BC1_RGBA,
            Tf::Bc1RgbaUnormSrgb => BC1_RGBA_sRGB,
            Tf::Bc2RgbaUnorm => BC2_RGBA,
            Tf::Bc2RgbaUnormSrgb => BC2_RGBA_sRGB,
            Tf::Bc3RgbaUnorm => BC3_RGBA,
            Tf::Bc3RgbaUnormSrgb => BC3_RGBA_sRGB,
            Tf::Bc4RUnorm => BC4_RUnorm,
            Tf::Bc4RSnorm => BC4_RSnorm,
            Tf::Bc5RgUnorm => BC5_RGUnorm,
            Tf::Bc5RgSnorm => BC5_RGSnorm,
            Tf::Bc6hRgbFloat => BC6H_RGBFloat,
            Tf::Bc6hRgbUfloat => BC6H_RGBUfloat,
            Tf::Bc7RgbaUnorm => BC7_RGBAUnorm,
            Tf::Bc7RgbaUnormSrgb => BC7_RGBAUnorm_sRGB,
            Tf::Etc2Rgb8Unorm => ETC2_RGB8,
            Tf::Etc2Rgb8UnormSrgb => ETC2_RGB8_sRGB,
            Tf::Etc2Rgb8A1Unorm => ETC2_RGB8A1,
            Tf::Etc2Rgb8A1UnormSrgb => ETC2_RGB8A1_sRGB,
            Tf::Etc2Rgba8Unorm => EAC_RGBA8,
            Tf::Etc2Rgba8UnormSrgb => EAC_RGBA8_sRGB,
            Tf::EacR11Unorm => EAC_R11Unorm,
            Tf::EacR11Snorm => EAC_R11Snorm,
            Tf::EacRg11Unorm => EAC_RG11Unorm,
            Tf::EacRg11Snorm => EAC_RG11Snorm,
            Tf::Astc { block, channel } => match channel {
                AstcChannel::Unorm => match block {
                    AstcBlock::B4x4 => ASTC_4x4_LDR,
                    AstcBlock::B5x4 => ASTC_5x4_LDR,
                    AstcBlock::B5x5 => ASTC_5x5_LDR,
                    AstcBlock::B6x5 => ASTC_6x5_LDR,
                    AstcBlock::B6x6 => ASTC_6x6_LDR,
                    AstcBlock::B8x5 => ASTC_8x5_LDR,
                    AstcBlock::B8x6 => ASTC_8x6_LDR,
                    AstcBlock::B8x8 => ASTC_8x8_LDR,
                    AstcBlock::B10x5 => ASTC_10x5_LDR,
                    AstcBlock::B10x6 => ASTC_10x6_LDR,
                    AstcBlock::B10x8 => ASTC_10x8_LDR,
                    AstcBlock::B10x10 => ASTC_10x10_LDR,
                    AstcBlock::B12x10 => ASTC_12x10_LDR,
                    AstcBlock::B12x12 => ASTC_12x12_LDR,
                },
                AstcChannel::UnormSrgb => match block {
                    AstcBlock::B4x4 => ASTC_4x4_sRGB,
                    AstcBlock::B5x4 => ASTC_5x4_sRGB,
                    AstcBlock::B5x5 => ASTC_5x5_sRGB,
                    AstcBlock::B6x5 => ASTC_6x5_sRGB,
                    AstcBlock::B6x6 => ASTC_6x6_sRGB,
                    AstcBlock::B8x5 => ASTC_8x5_sRGB,
                    AstcBlock::B8x6 => ASTC_8x6_sRGB,
                    AstcBlock::B8x8 => ASTC_8x8_sRGB,
                    AstcBlock::B10x5 => ASTC_10x5_sRGB,
                    AstcBlock::B10x6 => ASTC_10x6_sRGB,
                    AstcBlock::B10x8 => ASTC_10x8_sRGB,
                    AstcBlock::B10x10 => ASTC_10x10_sRGB,
                    AstcBlock::B12x10 => ASTC_12x10_sRGB,
                    AstcBlock::B12x12 => ASTC_12x12_sRGB,
                },
                AstcChannel::Hdr => match block {
                    AstcBlock::B4x4 => ASTC_4x4_HDR,
                    AstcBlock::B5x4 => ASTC_5x4_HDR,
                    AstcBlock::B5x5 => ASTC_5x5_HDR,
                    AstcBlock::B6x5 => ASTC_6x5_HDR,
                    AstcBlock::B6x6 => ASTC_6x6_HDR,
                    AstcBlock::B8x5 => ASTC_8x5_HDR,
                    AstcBlock::B8x6 => ASTC_8x6_HDR,
                    AstcBlock::B8x8 => ASTC_8x8_HDR,
                    AstcBlock::B10x5 => ASTC_10x5_HDR,
                    AstcBlock::B10x6 => ASTC_10x6_HDR,
                    AstcBlock::B10x8 => ASTC_10x8_HDR,
                    AstcBlock::B10x10 => ASTC_10x10_HDR,
                    AstcBlock::B12x10 => ASTC_12x10_HDR,
                    AstcBlock::B12x12 => ASTC_12x12_HDR,
                },
            },
        }
    }

    pub fn map_view_format(
        &self,
        format: wgt::TextureFormat,
        aspects: crate::FormatAspects,
    ) -> metal::MTLPixelFormat {
        use crate::FormatAspects as Fa;
        use metal::MTLPixelFormat::*;
        use wgt::TextureFormat as Tf;
        match (format, aspects) {
            // map combined depth-stencil format to their stencil-only format
            // see https://developer.apple.com/library/archive/documentation/Miscellaneous/Conceptual/MetalProgrammingGuide/WhatsNewiniOS10tvOS10andOSX1012/WhatsNewiniOS10tvOS10andOSX1012.html#//apple_ref/doc/uid/TP40014221-CH14-DontLinkElementID_77
            (Tf::Depth24PlusStencil8, Fa::STENCIL) => {
                if self.format_depth24_stencil8 {
                    X24_Stencil8
                } else {
                    X32_Stencil8
                }
            }
            (Tf::Depth32FloatStencil8, Fa::STENCIL) => X32_Stencil8,

            _ => self.map_format(format),
        }
    }
}

impl super::PrivateDisabilities {
    pub fn new(device: &metal::Device) -> Self {
        let is_intel = device.name().starts_with("Intel");
        Self {
            broken_viewport_near_depth: is_intel
                && !device.supports_feature_set(MTLFeatureSet::macOS_GPUFamily1_v4),
            broken_layered_clear_image: is_intel,
        }
    }
}
