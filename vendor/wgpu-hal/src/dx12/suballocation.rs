use gpu_allocator::{
    d3d12::{AllocationCreateDesc, Allocator},
    MemoryLocation,
};
use parking_lot::Mutex;
use windows::Win32::Graphics::Direct3D12;

use crate::{
    auxil::dxgi::{name::ObjectExt, result::HResult as _},
    dx12::conv,
};

#[derive(Debug)]
pub(crate) enum AllocationType {
    Buffer,
    Texture,
    AccelerationStructure,
}

#[derive(Debug)]
enum AllocationInner {
    /// This resource is suballocated from a heap.
    Placed {
        inner: gpu_allocator::d3d12::Allocation,
    },
    /// This resource is a committed resource and does not belong to a
    /// suballocated heap. We store an approximate size, so we can manage our counters
    /// correctly.
    ///
    /// This is only used for Intel Xe drivers, which have a bug that
    /// prevents suballocation from working correctly.
    Committed { size: u64 },
}

#[derive(Debug)]
pub(crate) struct Allocation {
    inner: AllocationInner,
    ty: AllocationType,
}

impl Allocation {
    pub fn placed(inner: gpu_allocator::d3d12::Allocation, ty: AllocationType) -> Self {
        Self {
            inner: AllocationInner::Placed { inner },
            ty,
        }
    }

    pub fn none(ty: AllocationType, size: u64) -> Self {
        Self {
            inner: AllocationInner::Committed { size },
            ty,
        }
    }

    pub fn size(&self) -> u64 {
        match self.inner {
            AllocationInner::Placed { ref inner } => inner.size(),
            AllocationInner::Committed { size } => size,
        }
    }
}

pub(crate) fn create_allocator(
    raw: &Direct3D12::ID3D12Device,
    memory_hints: &wgt::MemoryHints,
) -> Result<Mutex<Allocator>, crate::DeviceError> {
    // TODO: the allocator's configuration should take hardware capability into
    // account.
    let mb = 1024 * 1024;
    let allocation_sizes = match memory_hints {
        wgt::MemoryHints::Performance => gpu_allocator::AllocationSizes::default(),
        wgt::MemoryHints::MemoryUsage => gpu_allocator::AllocationSizes::new(8 * mb, 4 * mb),
        wgt::MemoryHints::Manual {
            suballocated_device_memory_block_size,
        } => {
            // TODO: Would it be useful to expose the host size in memory hints
            // instead of always using half of the device size?
            let device_size = suballocated_device_memory_block_size.start;
            let host_size = device_size / 2;
            gpu_allocator::AllocationSizes::new(device_size, host_size)
        }
    };

    match Allocator::new(&gpu_allocator::d3d12::AllocatorCreateDesc {
        device: gpu_allocator::d3d12::ID3D12DeviceVersion::Device(raw.clone()),
        debug_settings: Default::default(),
        allocation_sizes,
    }) {
        Ok(allocator) => Ok(Mutex::new(allocator)),
        Err(e) => {
            log::error!("Failed to create d3d12 allocator, error: {}", e);
            Err(e)?
        }
    }
}

/// To allow us to construct buffers from both a `Device` and `CommandEncoder`
/// without needing each function to take a million arguments, we create a
/// borrowed context struct that contains the relevant members.
pub(crate) struct DeviceAllocationContext<'a> {
    pub(crate) raw: &'a Direct3D12::ID3D12Device,
    pub(crate) shared: &'a super::DeviceShared,
    pub(crate) mem_allocator: &'a Mutex<Allocator>,
    pub(crate) counters: &'a wgt::HalCounters,
}

impl<'a> From<&'a super::Device> for DeviceAllocationContext<'a> {
    fn from(device: &'a super::Device) -> Self {
        Self {
            raw: &device.raw,
            shared: &device.shared,
            mem_allocator: &device.mem_allocator,
            counters: &device.counters,
        }
    }
}

impl<'a> From<&'a super::CommandEncoder> for DeviceAllocationContext<'a> {
    fn from(encoder: &'a super::CommandEncoder) -> Self {
        Self {
            raw: &encoder.device,
            shared: &encoder.shared,
            mem_allocator: &encoder.mem_allocator,
            counters: &encoder.counters,
        }
    }
}

impl<'a> DeviceAllocationContext<'a> {
    ///////////////////////
    // Resource Creation //
    ///////////////////////

    pub(crate) fn create_buffer(
        &self,
        desc: &crate::BufferDescriptor,
    ) -> Result<(Direct3D12::ID3D12Resource, Allocation), crate::DeviceError> {
        let is_cpu_read = desc.usage.contains(wgt::BufferUses::MAP_READ);
        let is_cpu_write = desc.usage.contains(wgt::BufferUses::MAP_WRITE);

        let location = match (is_cpu_read, is_cpu_write) {
            (true, true) => MemoryLocation::CpuToGpu,
            (true, false) => MemoryLocation::GpuToCpu,
            (false, true) => MemoryLocation::CpuToGpu,
            (false, false) => MemoryLocation::GpuOnly,
        };

        let (resource, allocation) = if self.shared.private_caps.suballocation_supported {
            self.create_placed_buffer(desc, location)?
        } else {
            self.create_committed_buffer(desc, location)?
        };

        if let Some(label) = desc.label {
            resource.set_name(label)?;
        }

        self.counters.buffer_memory.add(allocation.size() as isize);

        Ok((resource, allocation))
    }

    pub(crate) fn create_texture(
        &self,
        desc: &crate::TextureDescriptor,
        raw_desc: Direct3D12::D3D12_RESOURCE_DESC,
    ) -> Result<(Direct3D12::ID3D12Resource, Allocation), crate::DeviceError> {
        let (resource, allocation) = if self.shared.private_caps.suballocation_supported {
            self.create_placed_texture(desc, raw_desc)?
        } else {
            self.create_committed_texture(desc, raw_desc)?
        };

        if let Some(label) = desc.label {
            resource.set_name(label)?;
        }

        self.counters.texture_memory.add(allocation.size() as isize);

        Ok((resource, allocation))
    }

    pub(crate) fn create_acceleration_structure(
        &self,
        desc: &crate::AccelerationStructureDescriptor,
        raw_desc: Direct3D12::D3D12_RESOURCE_DESC,
    ) -> Result<(Direct3D12::ID3D12Resource, Allocation), crate::DeviceError> {
        let (resource, allocation) = if self.shared.private_caps.suballocation_supported {
            self.create_placed_acceleration_structure(desc, raw_desc)?
        } else {
            self.create_committed_acceleration_structure(desc, raw_desc)?
        };

        if let Some(label) = desc.label {
            resource.set_name(label)?;
        }

        self.counters
            .acceleration_structure_memory
            .add(allocation.size() as isize);

        Ok((resource, allocation))
    }

    //////////////////////////
    // Resource Destruction //
    //////////////////////////

    pub(crate) fn free_resource(
        &self,
        resource: Direct3D12::ID3D12Resource,
        allocation: Allocation,
    ) {
        // Make sure the resource is released before we free the allocation.
        drop(resource);

        let counter = match allocation.ty {
            AllocationType::Buffer => &self.counters.buffer_memory,
            AllocationType::Texture => &self.counters.texture_memory,
            AllocationType::AccelerationStructure => &self.counters.acceleration_structure_memory,
        };
        counter.sub(allocation.size() as isize);

        if let AllocationInner::Placed { inner } = allocation.inner {
            match self.mem_allocator.lock().free(inner) {
                Ok(_) => (),
                // TODO: Don't panic here
                Err(e) => panic!("Failed to destroy dx12 {:?}, {e}", allocation.ty),
            };
        }
    }

    ///////////////////////////////
    // Placed Resource Creation ///
    ///////////////////////////////

    fn create_placed_buffer(
        &self,
        desc: &crate::BufferDescriptor<'_>,
        location: MemoryLocation,
    ) -> Result<(Direct3D12::ID3D12Resource, Allocation), crate::DeviceError> {
        let raw_desc = conv::map_buffer_descriptor(desc);

        let name = desc.label.unwrap_or("Unlabeled buffer");

        let mut allocator = self.mem_allocator.lock();

        let allocation_desc = AllocationCreateDesc::from_d3d12_resource_desc(
            allocator.device(),
            &raw_desc,
            name,
            location,
        );

        let allocation = allocator.allocate(&allocation_desc)?;
        let mut resource = None;
        unsafe {
            self.raw.CreatePlacedResource(
                allocation.heap(),
                allocation.offset(),
                &raw_desc,
                Direct3D12::D3D12_RESOURCE_STATE_COMMON,
                None,
                &mut resource,
            )
        }
        .into_device_result("Placed buffer creation")?;

        let resource = resource.ok_or(crate::DeviceError::Unexpected)?;
        let wrapped_allocation = Allocation::placed(allocation, AllocationType::Buffer);

        Ok((resource, wrapped_allocation))
    }

    fn create_placed_texture(
        &self,
        desc: &crate::TextureDescriptor<'_>,
        raw_desc: Direct3D12::D3D12_RESOURCE_DESC,
    ) -> Result<(Direct3D12::ID3D12Resource, Allocation), crate::DeviceError> {
        let location = MemoryLocation::GpuOnly;

        let name = desc.label.unwrap_or("Unlabeled texture");

        let mut allocator = self.mem_allocator.lock();

        let allocation_desc = AllocationCreateDesc::from_d3d12_resource_desc(
            allocator.device(),
            &raw_desc,
            name,
            location,
        );

        let allocation = allocator.allocate(&allocation_desc)?;
        let mut resource = None;
        unsafe {
            self.raw.CreatePlacedResource(
                allocation.heap(),
                allocation.offset(),
                &raw_desc,
                Direct3D12::D3D12_RESOURCE_STATE_COMMON,
                None, // clear value
                &mut resource,
            )
        }
        .into_device_result("Placed texture creation")?;

        let resource = resource.ok_or(crate::DeviceError::Unexpected)?;
        let wrapped_allocation = Allocation::placed(allocation, AllocationType::Texture);

        Ok((resource, wrapped_allocation))
    }

    fn create_placed_acceleration_structure(
        &self,
        desc: &crate::AccelerationStructureDescriptor<'_>,
        raw_desc: Direct3D12::D3D12_RESOURCE_DESC,
    ) -> Result<(Direct3D12::ID3D12Resource, Allocation), crate::DeviceError> {
        let location = MemoryLocation::GpuOnly;

        let name = desc.label.unwrap_or("Unlabeled acceleration structure");

        let mut allocator = self.mem_allocator.lock();

        let allocation_desc = AllocationCreateDesc::from_d3d12_resource_desc(
            allocator.device(),
            &raw_desc,
            name,
            location,
        );

        let allocation = allocator.allocate(&allocation_desc)?;
        let mut resource = None;
        unsafe {
            self.raw.CreatePlacedResource(
                allocation.heap(),
                allocation.offset(),
                &raw_desc,
                Direct3D12::D3D12_RESOURCE_STATE_RAYTRACING_ACCELERATION_STRUCTURE,
                None,
                &mut resource,
            )
        }
        .into_device_result("Placed acceleration structure creation")?;

        let resource = resource.ok_or(crate::DeviceError::Unexpected)?;
        let wrapped_allocation =
            Allocation::placed(allocation, AllocationType::AccelerationStructure);

        Ok((resource, wrapped_allocation))
    }

    /////////////////////////////////
    // Committed Resource Creation //
    /////////////////////////////////

    fn create_committed_buffer(
        &self,
        desc: &crate::BufferDescriptor,
        location: MemoryLocation,
    ) -> Result<(Direct3D12::ID3D12Resource, Allocation), crate::DeviceError> {
        let raw_desc = conv::map_buffer_descriptor(desc);

        let is_uma = matches!(
            self.shared.private_caps.memory_architecture,
            crate::dx12::MemoryArchitecture::Unified { .. }
        );

        let heap_properties = Direct3D12::D3D12_HEAP_PROPERTIES {
            Type: Direct3D12::D3D12_HEAP_TYPE_CUSTOM,
            CPUPageProperty: match location {
                MemoryLocation::GpuOnly => Direct3D12::D3D12_CPU_PAGE_PROPERTY_NOT_AVAILABLE,
                MemoryLocation::CpuToGpu => Direct3D12::D3D12_CPU_PAGE_PROPERTY_WRITE_COMBINE,
                MemoryLocation::GpuToCpu => Direct3D12::D3D12_CPU_PAGE_PROPERTY_WRITE_BACK,
                _ => unreachable!(),
            },
            MemoryPoolPreference: match (is_uma, location) {
                // On dedicated GPUs, we only use L1 for GPU-only allocations.
                (false, MemoryLocation::GpuOnly) => Direct3D12::D3D12_MEMORY_POOL_L1,
                (_, _) => Direct3D12::D3D12_MEMORY_POOL_L0,
            },
            CreationNodeMask: 0,
            VisibleNodeMask: 0,
        };

        let mut resource = None;

        unsafe {
            self.raw.CreateCommittedResource(
                &heap_properties,
                if self.shared.private_caps.heap_create_not_zeroed {
                    Direct3D12::D3D12_HEAP_FLAG_CREATE_NOT_ZEROED
                } else {
                    Direct3D12::D3D12_HEAP_FLAG_NONE
                },
                &raw_desc,
                Direct3D12::D3D12_RESOURCE_STATE_COMMON,
                None,
                &mut resource,
            )
        }
        .into_device_result("Committed buffer creation")?;

        let resource = resource.ok_or(crate::DeviceError::Unexpected)?;
        let wrapped_allocation = Allocation::none(AllocationType::Buffer, desc.size);

        Ok((resource, wrapped_allocation))
    }

    fn create_committed_texture(
        &self,
        desc: &crate::TextureDescriptor,
        raw_desc: Direct3D12::D3D12_RESOURCE_DESC,
    ) -> Result<(Direct3D12::ID3D12Resource, Allocation), crate::DeviceError> {
        let heap_properties = Direct3D12::D3D12_HEAP_PROPERTIES {
            Type: Direct3D12::D3D12_HEAP_TYPE_CUSTOM,
            CPUPageProperty: Direct3D12::D3D12_CPU_PAGE_PROPERTY_NOT_AVAILABLE,
            MemoryPoolPreference: match self.shared.private_caps.memory_architecture {
                crate::dx12::MemoryArchitecture::NonUnified => Direct3D12::D3D12_MEMORY_POOL_L1,
                crate::dx12::MemoryArchitecture::Unified { .. } => Direct3D12::D3D12_MEMORY_POOL_L0,
            },
            CreationNodeMask: 0,
            VisibleNodeMask: 0,
        };

        let mut resource = None;

        unsafe {
            self.raw.CreateCommittedResource(
                &heap_properties,
                if self.shared.private_caps.heap_create_not_zeroed {
                    Direct3D12::D3D12_HEAP_FLAG_CREATE_NOT_ZEROED
                } else {
                    Direct3D12::D3D12_HEAP_FLAG_NONE
                },
                &raw_desc,
                Direct3D12::D3D12_RESOURCE_STATE_COMMON,
                None, // clear value
                &mut resource,
            )
        }
        .into_device_result("Committed texture creation")?;

        let resource = resource.ok_or(crate::DeviceError::Unexpected)?;
        let wrapped_allocation = Allocation::none(
            AllocationType::Texture,
            desc.format.theoretical_memory_footprint(desc.size),
        );

        Ok((resource, wrapped_allocation))
    }

    fn create_committed_acceleration_structure(
        &self,
        desc: &crate::AccelerationStructureDescriptor,
        raw_desc: Direct3D12::D3D12_RESOURCE_DESC,
    ) -> Result<(Direct3D12::ID3D12Resource, Allocation), crate::DeviceError> {
        let heap_properties = Direct3D12::D3D12_HEAP_PROPERTIES {
            Type: Direct3D12::D3D12_HEAP_TYPE_CUSTOM,
            CPUPageProperty: Direct3D12::D3D12_CPU_PAGE_PROPERTY_NOT_AVAILABLE,
            MemoryPoolPreference: match self.shared.private_caps.memory_architecture {
                crate::dx12::MemoryArchitecture::NonUnified => Direct3D12::D3D12_MEMORY_POOL_L1,
                crate::dx12::MemoryArchitecture::Unified { .. } => Direct3D12::D3D12_MEMORY_POOL_L0,
            },
            CreationNodeMask: 0,
            VisibleNodeMask: 0,
        };

        let mut resource = None;

        unsafe {
            self.raw.CreateCommittedResource(
                &heap_properties,
                if self.shared.private_caps.heap_create_not_zeroed {
                    Direct3D12::D3D12_HEAP_FLAG_CREATE_NOT_ZEROED
                } else {
                    Direct3D12::D3D12_HEAP_FLAG_NONE
                },
                &raw_desc,
                Direct3D12::D3D12_RESOURCE_STATE_RAYTRACING_ACCELERATION_STRUCTURE,
                None,
                &mut resource,
            )
        }
        .into_device_result("Committed acceleration structure creation")?;

        let resource = resource.ok_or(crate::DeviceError::Unexpected)?;
        let wrapped_allocation = Allocation::none(AllocationType::AccelerationStructure, desc.size);

        Ok((resource, wrapped_allocation))
    }
}

impl From<gpu_allocator::AllocationError> for crate::DeviceError {
    fn from(result: gpu_allocator::AllocationError) -> Self {
        match result {
            gpu_allocator::AllocationError::OutOfMemory => Self::OutOfMemory,
            gpu_allocator::AllocationError::FailedToMap(e) => {
                log::error!("DX12 gpu-allocator: Failed to map: {}", e);
                Self::Lost
            }
            gpu_allocator::AllocationError::NoCompatibleMemoryTypeFound => {
                log::error!("DX12 gpu-allocator: No Compatible Memory Type Found");
                Self::Lost
            }
            gpu_allocator::AllocationError::InvalidAllocationCreateDesc => {
                log::error!("DX12 gpu-allocator: Invalid Allocation Creation Description");
                Self::Lost
            }
            gpu_allocator::AllocationError::InvalidAllocatorCreateDesc(e) => {
                log::error!(
                    "DX12 gpu-allocator: Invalid Allocator Creation Description: {}",
                    e
                );
                Self::Lost
            }

            gpu_allocator::AllocationError::Internal(e) => {
                log::error!("DX12 gpu-allocator: Internal Error: {}", e);
                Self::Lost
            }
            gpu_allocator::AllocationError::BarrierLayoutNeedsDevice10
            | gpu_allocator::AllocationError::CastableFormatsRequiresEnhancedBarriers
            | gpu_allocator::AllocationError::CastableFormatsRequiresAtLeastDevice12 => {
                unreachable!()
            }
        }
    }
}
