//! GPU-resident frames on Linux + NVIDIA (render farm workers).
//!
//! With `CAP_LINUX_GPU_FRAMES=1` decoded frames stay in CUDA memory (NVDEC),
//! reach the compositor through Vulkan buffers that CUDA imports, and the
//! NV12 output goes back to CUDA for NVENC the same way. Every hop is a
//! device-to-device copy: no frame crosses PCIe to the CPU. CUDA is loaded at
//! runtime, so builds without an NVIDIA driver are unaffected.

use ash::vk;
use std::{
    ffi::c_void,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};

static INTEROP_FAILURES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn note_interop_failure() {
    INTEROP_FAILURES.fetch_add(1, Ordering::Relaxed);
}

/// CUDA frames that failed to reach the compositor since the last call.
pub fn take_interop_failures() -> u64 {
    INTEROP_FAILURES.swap(0, Ordering::Relaxed)
}

pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("CAP_LINUX_GPU_FRAMES").as_deref() == Ok("1"))
}

type CuResult = i32;
pub type CuDevicePtr = u64;
type CuContext = *mut c_void;
type CuStream = *mut c_void;
type CuExternalMemory = *mut c_void;

#[repr(C)]
struct CudaMemcpy2d {
    src_x_in_bytes: usize,
    src_y: usize,
    src_memory_type: u32,
    src_host: *const c_void,
    src_device: CuDevicePtr,
    src_array: *mut c_void,
    src_pitch: usize,
    dst_x_in_bytes: usize,
    dst_y: usize,
    dst_memory_type: u32,
    dst_host: *mut c_void,
    dst_device: CuDevicePtr,
    dst_array: *mut c_void,
    dst_pitch: usize,
    width_in_bytes: usize,
    height: usize,
}

#[repr(C)]
struct ExternalMemoryHandleDesc {
    kind: u32,
    _pad: u32,
    fd: i32,
    _union_rest: [u8; 12],
    size: u64,
    flags: u32,
    reserved: [u32; 16],
}

#[repr(C)]
struct ExternalMemoryBufferDesc {
    offset: u64,
    size: u64,
    flags: u32,
    reserved: [u32; 16],
}

const CU_MEMORYTYPE_DEVICE: u32 = 2;
const CU_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD: u32 = 1;
const CUDA_EXTERNAL_MEMORY_DEDICATED: u32 = 1;

struct Cuda {
    _library: libloading::Library,
    context: CuContext,
    ctx_push: unsafe extern "C" fn(CuContext) -> CuResult,
    ctx_pop: unsafe extern "C" fn(*mut CuContext) -> CuResult,
    memcpy_2d_async: unsafe extern "C" fn(*const CudaMemcpy2d, CuStream) -> CuResult,
    stream_create: unsafe extern "C" fn(*mut CuStream, u32) -> CuResult,
    stream_synchronize: unsafe extern "C" fn(CuStream) -> CuResult,
    stream_destroy: unsafe extern "C" fn(CuStream) -> CuResult,
    mem_get_info: unsafe extern "C" fn(*mut usize, *mut usize) -> CuResult,
    import_external_memory:
        unsafe extern "C" fn(*mut CuExternalMemory, *const ExternalMemoryHandleDesc) -> CuResult,
    external_memory_mapped_buffer: unsafe extern "C" fn(
        *mut CuDevicePtr,
        CuExternalMemory,
        *const ExternalMemoryBufferDesc,
    ) -> CuResult,
}

unsafe impl Send for Cuda {}
unsafe impl Sync for Cuda {}

fn check(result: CuResult, what: &str) -> Result<(), String> {
    if result == 0 {
        Ok(())
    } else {
        Err(format!("{what} failed with CUDA error {result}"))
    }
}

impl Cuda {
    fn load() -> Result<Self, String> {
        unsafe {
            let library = libloading::Library::new("libcuda.so.1")
                .map_err(|error| format!("libcuda: {error}"))?;
            macro_rules! symbol {
                ($name:literal) => {
                    *library
                        .get($name)
                        .map_err(|error| format!("{}: {error}", String::from_utf8_lossy($name)))?
                };
            }
            let init: unsafe extern "C" fn(u32) -> CuResult = symbol!(b"cuInit\0");
            let device_get: unsafe extern "C" fn(*mut i32, i32) -> CuResult =
                symbol!(b"cuDeviceGet\0");
            let primary_retain: unsafe extern "C" fn(*mut CuContext, i32) -> CuResult =
                symbol!(b"cuDevicePrimaryCtxRetain\0");
            check(init(0), "cuInit")?;
            let mut device = 0;
            check(device_get(&mut device, 0), "cuDeviceGet")?;
            // ffmpeg's CUDA hwcontext (primary_ctx=1) insists on blocking-sync
            // scheduling and refuses to attach to an active primary context
            // with other flags, so activate it the way ffmpeg would.
            let set_flags: unsafe extern "C" fn(i32, u32) -> CuResult =
                symbol!(b"cuDevicePrimaryCtxSetFlags_v2\0");
            const CU_CTX_SCHED_BLOCKING_SYNC: u32 = 0x04;
            let _ = set_flags(device, CU_CTX_SCHED_BLOCKING_SYNC);
            let mut context = std::ptr::null_mut();
            // The primary context is shared with ffmpeg's CUDA hwaccel and
            // NVENC (primary_ctx=1), so device pointers are valid everywhere.
            check(
                primary_retain(&mut context, device),
                "cuDevicePrimaryCtxRetain",
            )?;
            Ok(Self {
                ctx_push: symbol!(b"cuCtxPushCurrent_v2\0"),
                ctx_pop: symbol!(b"cuCtxPopCurrent_v2\0"),
                memcpy_2d_async: symbol!(b"cuMemcpy2DAsync_v2\0"),
                stream_create: symbol!(b"cuStreamCreate\0"),
                stream_synchronize: symbol!(b"cuStreamSynchronize\0"),
                stream_destroy: symbol!(b"cuStreamDestroy_v2\0"),
                mem_get_info: symbol!(b"cuMemGetInfo_v2\0"),
                import_external_memory: symbol!(b"cuImportExternalMemory\0"),
                external_memory_mapped_buffer: symbol!(b"cuExternalMemoryGetMappedBuffer\0"),
                context,
                _library: library,
            })
        }
    }

    fn with_context<T>(&self, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        unsafe {
            check((self.ctx_push)(self.context), "cuCtxPushCurrent")?;
            let result = f();
            let mut popped = std::ptr::null_mut();
            (self.ctx_pop)(&mut popped);
            result
        }
    }
}

fn cuda() -> Result<&'static Cuda, String> {
    static CUDA: OnceLock<Result<Cuda, String>> = OnceLock::new();
    CUDA.get_or_init(Cuda::load).as_ref().map_err(Clone::clone)
}

/// Device-to-device copy of a pitched plane (synchronous).
pub fn copy_plane(
    src: CuDevicePtr,
    src_pitch: usize,
    dst: CuDevicePtr,
    dst_pitch: usize,
    width_bytes: usize,
    rows: usize,
) -> Result<(), String> {
    let cuda = cuda()?;
    let copy = CudaMemcpy2d {
        src_x_in_bytes: 0,
        src_y: 0,
        src_memory_type: CU_MEMORYTYPE_DEVICE,
        src_host: std::ptr::null(),
        src_device: src,
        src_array: std::ptr::null_mut(),
        src_pitch,
        dst_x_in_bytes: 0,
        dst_y: 0,
        dst_memory_type: CU_MEMORYTYPE_DEVICE,
        dst_host: std::ptr::null_mut(),
        dst_device: dst,
        dst_array: std::ptr::null_mut(),
        dst_pitch,
        width_in_bytes: width_bytes,
        height: rows,
    };
    cuda.with_context(|| unsafe {
        check(
            (cuda.memcpy_2d_async)(&copy, thread_stream(cuda)?),
            "cuMemcpy2DAsync",
        )
    })
}

/// One blocking stream per thread: it orders after NVDEC's writes on the
/// legacy stream, and waiting on it waits only for this thread's copies.
/// Encoder threads are created per chunk; destroying the stream with the
/// thread keeps a long-lived engine from leaking one per chunk.
struct ThreadStream(std::cell::Cell<CuStream>);

impl Drop for ThreadStream {
    fn drop(&mut self) {
        let stream = self.0.get();
        if stream.is_null() {
            return;
        }
        if let Ok(driver) = cuda() {
            let _ = driver.with_context(|| unsafe {
                check((driver.stream_destroy)(stream), "cuStreamDestroy")
            });
        }
    }
}

fn thread_stream(cuda: &Cuda) -> Result<CuStream, String> {
    thread_local! {
        static STREAM: ThreadStream = const { ThreadStream(std::cell::Cell::new(std::ptr::null_mut())) };
    }
    STREAM.with(|slot| {
        if slot.0.get().is_null() {
            let mut stream = std::ptr::null_mut();
            check(
                unsafe { (cuda.stream_create)(&mut stream, 0) },
                "cuStreamCreate",
            )?;
            slot.0.set(stream);
        }
        Ok(slot.0.get())
    })
}

/// Retains the primary context with the scheduling flags ffmpeg wants, before
/// any decoder or encoder exists. Otherwise two ffmpeg device inits can race
/// on cuDevicePrimaryCtxSetFlags (CUDA_ERROR_PRIMARY_CONTEXT_ACTIVE) and one
/// decoder silently falls back to software decode.
pub fn init() -> Result<(), String> {
    cuda().map(|_| ())
}

/// Waits for this thread's queued copies. Device-to-device copies never
/// block the host, so without this Vulkan (or NVENC) can read a shared
/// buffer before the copy lands, and a ring slot can be recycled mid-copy:
/// green (zeroed) or stale frames.
pub fn synchronize() -> Result<(), String> {
    let cuda = cuda()?;
    cuda.with_context(|| unsafe {
        check(
            (cuda.stream_synchronize)(thread_stream(cuda)?),
            "cuStreamSynchronize",
        )
    })
}

/// A device-local Vulkan buffer that wgpu can copy to/from and CUDA can
/// address directly.
pub struct SharedBuffer {
    pub buffer: wgpu::Buffer,
    pub size: u64,
    pub cuda_ptr: CuDevicePtr,
    _memory: vk::DeviceMemory,
}

impl SharedBuffer {
    pub fn new(device: &wgpu::Device, size: u64, label: &str) -> Result<Self, String> {
        let cuda = cuda()?;
        let size = size.next_multiple_of(4096);
        let (raw_buffer, memory, allocation_size, fd) = unsafe {
            device.as_hal::<wgpu_hal::api::Vulkan, _, _>(|hal| {
                let hal = hal.ok_or("wgpu device is not Vulkan")?;
                let raw = hal.raw_device();
                let instance = hal.shared_instance().raw_instance();
                let mut external_info = vk::ExternalMemoryBufferCreateInfo::default()
                    .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
                let buffer_info = vk::BufferCreateInfo::default()
                    .size(size)
                    .usage(
                        vk::BufferUsageFlags::TRANSFER_SRC
                            | vk::BufferUsageFlags::TRANSFER_DST
                            | vk::BufferUsageFlags::STORAGE_BUFFER,
                    )
                    .sharing_mode(vk::SharingMode::EXCLUSIVE)
                    .push_next(&mut external_info);
                let buffer = raw
                    .create_buffer(&buffer_info, None)
                    .map_err(|error| format!("vkCreateBuffer: {error}"))?;
                let requirements = raw.get_buffer_memory_requirements(buffer);
                let properties =
                    instance.get_physical_device_memory_properties(hal.raw_physical_device());
                let memory_type = (0..properties.memory_type_count)
                    .find(|&index| {
                        requirements.memory_type_bits & (1 << index) != 0
                            && properties.memory_types[index as usize]
                                .property_flags
                                .contains(vk::MemoryPropertyFlags::DEVICE_LOCAL)
                    })
                    .ok_or("no device-local memory type")?;
                let mut export_info = vk::ExportMemoryAllocateInfo::default()
                    .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
                let mut dedicated = vk::MemoryDedicatedAllocateInfo::default().buffer(buffer);
                let allocate = vk::MemoryAllocateInfo::default()
                    .allocation_size(requirements.size)
                    .memory_type_index(memory_type)
                    .push_next(&mut export_info)
                    .push_next(&mut dedicated);
                let memory = raw
                    .allocate_memory(&allocate, None)
                    .map_err(|error| format!("vkAllocateMemory: {error}"))?;
                raw.bind_buffer_memory(buffer, memory, 0)
                    .map_err(|error| format!("vkBindBufferMemory: {error}"))?;
                let fd_loader = ash::khr::external_memory_fd::Device::new(instance, raw);
                let fd = fd_loader
                    .get_memory_fd(
                        &vk::MemoryGetFdInfoKHR::default()
                            .memory(memory)
                            .handle_type(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD),
                    )
                    .map_err(|error| format!("vkGetMemoryFdKHR: {error}"))?;
                Ok::<_, String>((buffer, memory, requirements.size, fd))
            })?
        };

        let cuda_ptr = cuda.with_context(|| unsafe {
            let handle = ExternalMemoryHandleDesc {
                kind: CU_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD,
                _pad: 0,
                fd,
                _union_rest: [0; 12],
                size: allocation_size,
                flags: CUDA_EXTERNAL_MEMORY_DEDICATED,
                reserved: [0; 16],
            };
            let mut external = std::ptr::null_mut();
            check(
                (cuda.import_external_memory)(&mut external, &handle),
                "cuImportExternalMemory",
            )?;
            let mapping = ExternalMemoryBufferDesc {
                offset: 0,
                size,
                flags: 0,
                reserved: [0; 16],
            };
            let mut pointer = 0;
            check(
                (cuda.external_memory_mapped_buffer)(&mut pointer, external, &mapping),
                "cuExternalMemoryGetMappedBuffer",
            )?;
            Ok(pointer)
        })?;

        let buffer = unsafe {
            let hal_buffer = wgpu_hal::vulkan::Device::buffer_from_raw(raw_buffer);
            device.create_buffer_from_hal::<wgpu_hal::api::Vulkan>(
                hal_buffer,
                &wgpu::BufferDescriptor {
                    label: Some(label),
                    size,
                    usage: wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                },
            )
        };

        Ok(Self {
            buffer,
            size,
            cuda_ptr,
            _memory: memory,
        })
    }
}

/// A fixed ring of shared buffers. A slot is free again once the GPU work
/// that reads it has completed (input) or its consumer dropped it (output).
pub struct SharedRing {
    slots: Vec<Arc<RingSlot>>,
    next: usize,
}

pub struct RingSlot {
    pub shared: std::mem::ManuallyDrop<SharedBuffer>,
    busy: AtomicBool,
    device: wgpu::Device,
}

// Every field is already `Send + Sync` (wgpu handles, atomics and raw
// Vulkan/CUDA handles). Stating it here stops auto-trait inference at these
// types: otherwise a `Send` check on a rendered frame walks wgpu-core's
// object graph and overflows the recursion limit in downstream crates.
unsafe impl Send for SharedBuffer {}
unsafe impl Sync for SharedBuffer {}
unsafe impl Send for RingSlot {}
unsafe impl Sync for RingSlot {}

impl RingSlot {
    pub fn release(&self) {
        self.busy.store(false, Ordering::Release);
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }
}

/// Shared buffers are never freed individually (their Vulkan memory and CUDA
/// import outlive wgpu's deferred buffer destruction), so rings hand them back
/// here and later rings on the same device reuse them. With a device that
/// lives for the whole process this bounds memory to one set per size;
/// allocating fresh per render leaked ~250 MB per 4K chunk until NVDEC hit
/// CUDA_ERROR_OUT_OF_MEMORY.
static POOL: std::sync::Mutex<Vec<(wgpu::Device, SharedBuffer)>> =
    std::sync::Mutex::new(Vec::new());

static ALLOCATED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// (shared buffers ever allocated, buffers idle in the pool, CUDA free MiB).
pub fn memory_stats() -> (usize, usize, u64) {
    let pooled = POOL.lock().map_or(0, |pool| pool.len());
    let free = cuda()
        .and_then(|cuda| {
            cuda.with_context(|| {
                let (mut free, mut total) = (0usize, 0usize);
                check(
                    unsafe { (cuda.mem_get_info)(&mut free, &mut total) },
                    "cuMemGetInfo",
                )?;
                Ok(free as u64 >> 20)
            })
        })
        .unwrap_or(0);
    (ALLOCATED.load(Ordering::Relaxed), pooled, free)
}

/// Pool buffers come in power-of-two sizes: every source resolution and
/// output size would otherwise add its own set of buffers that the pool keeps
/// forever, while callers only need a buffer at least as large as asked.
fn pool_size_class(size: u64) -> u64 {
    size.max(4096).next_power_of_two()
}

fn pooled_buffer(device: &wgpu::Device, size: u64, label: &str) -> Result<SharedBuffer, String> {
    let class = pool_size_class(size);
    if let Ok(mut pool) = POOL.lock()
        && let Some(index) = pool
            .iter()
            .position(|(owner, buffer)| owner == device && buffer.size == class)
    {
        return Ok(pool.swap_remove(index).1);
    }
    ALLOCATED.fetch_add(1, Ordering::Relaxed);
    SharedBuffer::new(device, class, label)
}

/// The buffer goes back to the pool when the slot's last reference drops:
/// output frames can outlive their ring (the encoder drains its queue after
/// the renderer returns), so the ring itself cannot hand them back.
impl Drop for RingSlot {
    fn drop(&mut self) {
        // SAFETY: `shared` is not touched again after this.
        let shared = unsafe { std::mem::ManuallyDrop::take(&mut self.shared) };
        if let Ok(mut pool) = POOL.lock() {
            pool.push((self.device.clone(), shared));
        }
    }
}

impl SharedRing {
    pub fn new(
        device: &wgpu::Device,
        count: usize,
        size: u64,
        label: &str,
    ) -> Result<Self, String> {
        let slots = (0..count)
            .map(|_| {
                pooled_buffer(device, size, label).map(|shared| {
                    Arc::new(RingSlot {
                        shared: std::mem::ManuallyDrop::new(shared),
                        busy: AtomicBool::new(false),
                        device: device.clone(),
                    })
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { slots, next: 0 })
    }

    pub fn size(&self) -> u64 {
        self.slots.first().map_or(0, |slot| slot.shared.size)
    }

    /// Next free slot, polling the device until one frees up. `None` after
    /// 10 s: every slot is held by a frame nobody is consuming.
    pub fn acquire(&mut self, device: &wgpu::Device) -> Option<Arc<RingSlot>> {
        let started = std::time::Instant::now();
        loop {
            for offset in 0..self.slots.len() {
                let index = (self.next + offset) % self.slots.len();
                let slot = &self.slots[index];
                if !slot.is_busy() {
                    slot.busy.store(true, Ordering::Release);
                    self.next = (index + 1) % self.slots.len();
                    return Some(Arc::clone(slot));
                }
            }
            if started.elapsed() > std::time::Duration::from_secs(10) {
                return None;
            }
            let _ = device.poll(wgpu::PollType::Poll);
            if started.elapsed() > std::time::Duration::from_millis(2) {
                std::thread::sleep(std::time::Duration::from_micros(200));
            }
        }
    }
}

/// A decoded NV12 frame resident in CUDA memory (an ffmpeg CUDA AVFrame,
/// kept alive by holding a reference to it).
pub struct CudaNv12Frame {
    pub y: CuDevicePtr,
    pub uv: CuDevicePtr,
    pub y_pitch: usize,
    pub uv_pitch: usize,
    pub width: u32,
    pub height: u32,
    _owner: Mutex<Box<dyn Send>>,
}

impl CudaNv12Frame {
    /// # Safety
    /// `y`/`uv` must be device pointers kept valid by `owner`.
    #[allow(clippy::too_many_arguments)]
    pub unsafe fn new(
        y: CuDevicePtr,
        uv: CuDevicePtr,
        y_pitch: usize,
        uv_pitch: usize,
        width: u32,
        height: u32,
        owner: Box<dyn Send>,
    ) -> Self {
        Self {
            y,
            uv,
            y_pitch,
            uv_pitch,
            width,
            height,
            _owner: Mutex::new(owner),
        }
    }
}

/// Rendered NV12 output resident in a shared buffer. Dropping it hands the
/// slot back to the renderer.
pub struct GpuNv12Output {
    pub slot: Arc<RingSlot>,
    pub y_stride: u32,
    pub uv_offset: u64,
    pub uv_stride: u32,
}

impl GpuNv12Output {
    pub fn cuda_ptr(&self) -> CuDevicePtr {
        self.slot.shared.cuda_ptr
    }
}

impl Drop for GpuNv12Output {
    fn drop(&mut self) {
        self.slot.release();
    }
}

#[cfg(test)]
mod tests {
    use super::pool_size_class;

    #[test]
    fn pool_sizes_collapse_into_power_of_two_classes() {
        assert_eq!(pool_size_class(1), 4096);
        assert_eq!(pool_size_class(3_110_400), 4 << 20);
        assert_eq!(pool_size_class(12_441_600), 16 << 20);
        assert_eq!(pool_size_class(16 << 20), 16 << 20);
        assert!((3_000_000..4_000_000).all(|size| pool_size_class(size) == 4 << 20));
    }
}
