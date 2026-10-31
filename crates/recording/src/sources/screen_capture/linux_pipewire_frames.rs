//! Linear PipeWire frames borrowed until the encoder is finished.
//!
//! A screencast buffer is a read-only view of the producer's memory. The
//! view stays alive until the last frame reference is dropped: the encoder
//! reads it, and the muxer also holds the latest frame so a static tail can
//! be repeated. DMA-BUF and memfd mappings are cached and replaced only when
//! the fd, the map offset, or the mapped size changes.
//!
//! Two paths still allocate a private writable copy:
//! - Instant mode with a camera. The alias is created with
//!   `AV_BUFFER_FLAG_READONLY`, so `av_frame_make_writable` copies before the
//!   camera is blended. Writing the alias would paint into the PipeWire buffer.
//! - The negotiated pool has no spare buffer (`pool < 2` or every buffer but
//!   one is already borrowed). The muxer keeps the latest frame borrowed, so a
//!   two-buffer pool copies in the steady state instead of stalling the
//!   producer. A crop whose lines would make FFmpeg's line window extend past
//!   the mapping is copied for the same reason.

use std::{
    collections::HashMap,
    os::fd::RawFd,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicPtr, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, anyhow, bail};
use parking_lot::{Condvar, Mutex};
use pipewire as pw;

const DMA_BUF_IOCTL_SYNC: libc::c_ulong = 0x4008_6200;
const DMA_BUF_SYNC_READ: u64 = 1;
const DMA_BUF_SYNC_END: u64 = 1 << 2;

/// Leave at least one buffer with the producer. The muxer borrows the latest
/// frame until the next one replaces it, so a pool of two copies in the
/// steady state and a pool of one always copies.
pub(super) fn spare_buffer(pool: usize, inflight: usize) -> bool {
    pool >= 2 && inflight + 1 < pool
}

pub(super) struct SourcePlane {
    /// Producer pointer when PipeWire already mapped a MemPtr. Null when this
    /// plane is read through [`Self::fd`].
    pub data: *mut u8,
    pub data_len: usize,
    /// Negative when the plane has no fd of its own.
    pub fd: i32,
    /// `spa_data.mapoffset` for an fd plane. Chunk offsets are relative to
    /// this byte of the file, which is where the producer's mapping starts.
    /// Zero when [`Self::data`] is already that mapping.
    pub map_offset: usize,
    pub sync_dma_buf: bool,
    /// `pw_buffer` address, queued back when the last frame reference drops.
    /// Zero in tests that have no PipeWire buffer.
    pub pw_buffer: usize,
}

#[derive(Clone, Copy)]
pub(super) struct LinearGeometry {
    pub pixel_format: ffmpeg::format::Pixel,
    pub bytes_per_pixel: usize,
    pub source_stride: usize,
    pub crop_x: usize,
    pub crop_y: usize,
    pub crop_width: usize,
    pub crop_height: usize,
    pub offset: usize,
    /// Exclusive readable end. `None` uses the whole mapping.
    pub limit: Option<usize>,
}

struct MappedBuffer {
    /// Producer fd. PipeWire may close it while an alias is still borrowed.
    fd: RawFd,
    /// `spa_data.mapoffset` this mapping was established at.
    map_offset: usize,
    /// Dup of `fd`, used for mmap and the read fence so that close cannot
    /// recycle the descriptor under the encoder.
    owned: RawFd,
    len: usize,
    pointer: usize,
    in_use: bool,
    retire: bool,
}

struct DmaBufCache {
    maps: Vec<MappedBuffer>,
    map_calls: usize,
    unmap_calls: usize,
}

impl DmaBufCache {
    fn map(
        &mut self,
        fd: RawFd,
        map_offset: usize,
        minimum_len: usize,
    ) -> anyhow::Result<(*mut u8, usize)> {
        let len = mapped_len(fd, map_offset, minimum_len)?;
        if let Some(index) = self
            .maps
            .iter()
            .position(|map| map.fd == fd && map.map_offset == map_offset && !map.retire)
        {
            if self.maps[index].len == len {
                return Ok((self.maps[index].pointer as *mut u8, len));
            }
            self.maps[index].retire = true;
            self.unmap_retired();
        }
        let owned = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        if owned < 0 {
            return Err(std::io::Error::last_os_error())
                .context("dup the PipeWire screen capture DMA-BUF");
        }
        let offset = libc::off_t::try_from(map_offset).map_err(|_| {
            anyhow!("PipeWire screen capture map offset does not fit in a file offset")
        })?;
        let pointer = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ,
                libc::MAP_SHARED,
                owned,
                offset,
            )
        };
        if pointer == libc::MAP_FAILED {
            unsafe {
                libc::close(owned);
            }
            return Err(std::io::Error::last_os_error())
                .context("map the PipeWire screen capture DMA-BUF");
        }
        let pointer = pointer as usize;
        self.map_calls += 1;
        self.maps.push(MappedBuffer {
            fd,
            map_offset,
            owned,
            len,
            pointer,
            in_use: false,
            retire: false,
        });
        Ok((pointer as *mut u8, len))
    }

    fn owned_fd(&self, pointer: *mut u8) -> Option<RawFd> {
        let pointer = pointer as usize;
        self.maps
            .iter()
            .find(|map| map.pointer == pointer)
            .map(|map| map.owned)
    }

    fn lease(&mut self, pointer: *mut u8) {
        let pointer = pointer as usize;
        if let Some(map) = self.maps.iter_mut().find(|map| map.pointer == pointer) {
            map.in_use = true;
        }
    }

    fn release(&mut self, pointer: usize) {
        if pointer == 0 {
            return;
        }
        let Some(index) = self.maps.iter().position(|map| map.pointer == pointer) else {
            return;
        };
        self.maps[index].in_use = false;
        if self.maps[index].retire {
            self.unmap_at(index);
        }
    }

    #[cfg(test)]
    fn unmap_idle(&mut self) {
        let mut index = 0;
        while index < self.maps.len() {
            if self.maps[index].in_use {
                index += 1;
            } else {
                self.unmap_at(index);
            }
        }
    }

    fn retire_fd(&mut self, fd: RawFd) {
        if fd < 0 {
            return;
        }
        for map in &mut self.maps {
            if map.fd == fd {
                map.retire = true;
            }
        }
        self.unmap_retired();
    }

    fn retire_all(&mut self) {
        for map in &mut self.maps {
            map.retire = true;
        }
        self.unmap_retired();
    }

    fn unmap_retired(&mut self) {
        let mut index = 0;
        while index < self.maps.len() {
            if self.maps[index].retire && !self.maps[index].in_use {
                self.unmap_at(index);
            } else {
                index += 1;
            }
        }
    }

    fn unmap_at(&mut self, index: usize) {
        let map = self.maps.remove(index);
        unsafe {
            libc::munmap(map.pointer as *mut libc::c_void, map.len);
            libc::close(map.owned);
        }
        self.unmap_calls += 1;
    }

    #[cfg(test)]
    fn contains(&self, pointer: usize) -> bool {
        self.maps.iter().any(|map| map.pointer == pointer)
    }

    #[cfg(test)]
    fn base_for(&self, fd: RawFd) -> Option<*const u8> {
        self.maps
            .iter()
            .find(|map| map.fd == fd && !map.retire)
            .map(|map| map.pointer as *const u8)
    }
}

impl Drop for DmaBufCache {
    fn drop(&mut self) {
        while !self.maps.is_empty() {
            self.unmap_at(0);
        }
    }
}

struct Inner {
    cache: Mutex<DmaBufCache>,
    requeue: Mutex<Option<pw::channel::Sender<BufferRelease>>>,
    buffers: Mutex<HashMap<usize, Arc<AtomicBool>>>,
    stream: AtomicPtr<pw::sys::pw_stream>,
    pool: AtomicUsize,
    inflight: AtomicUsize,
    inflight_lock: Mutex<()>,
    inflight_cv: Condvar,
    releases: AtomicUsize,
    requeues: AtomicUsize,
}

struct AliasedBuffer {
    frames: Arc<Inner>,
    release: Option<BufferRelease>,
    fd: i32,
    map_base: usize,
    end_sync: bool,
}

#[derive(Clone)]
pub(super) struct BufferRelease {
    address: usize,
    active: Arc<AtomicBool>,
}

impl BufferRelease {
    fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
}

/// Shared owner of cached DMA-BUF mappings and the in-flight alias count.
#[derive(Clone)]
pub(super) struct PipewireFrames {
    inner: Arc<Inner>,
}

impl PipewireFrames {
    pub(super) fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                cache: Mutex::new(DmaBufCache {
                    maps: Vec::new(),
                    map_calls: 0,
                    unmap_calls: 0,
                }),
                requeue: Mutex::new(None),
                buffers: Mutex::new(HashMap::new()),
                stream: AtomicPtr::new(std::ptr::null_mut()),
                pool: AtomicUsize::new(0),
                inflight: AtomicUsize::new(0),
                inflight_lock: Mutex::new(()),
                inflight_cv: Condvar::new(),
                releases: AtomicUsize::new(0),
                requeues: AtomicUsize::new(0),
            }),
        }
    }

    pub(super) fn set_requeue_sender(&self, sender: pw::channel::Sender<BufferRelease>) {
        *self.inner.requeue.lock() = Some(sender);
    }

    pub(super) fn set_stream(&self, stream: *mut pw::sys::pw_stream) {
        self.inner.stream.store(stream, Ordering::Release);
    }

    /// `pw_stream_queue_buffer` is single-producer. Releases are validated on
    /// the same loop as remove_buffer, including releases already in the channel.
    pub(super) fn queue_released_buffer(&self, buffer: BufferRelease) {
        if !buffer.is_active() {
            return;
        }
        let stream = self.inner.stream.load(Ordering::Acquire);
        if stream.is_null() {
            return;
        }
        unsafe {
            pw::sys::pw_stream_queue_buffer(stream, buffer.address as *mut pw::sys::pw_buffer);
        }
    }

    pub(super) fn add_pool_buffer(&self, buffer: *mut pw::sys::pw_buffer) {
        if buffer.is_null() {
            return;
        }
        let previous = self
            .inner
            .buffers
            .lock()
            .insert(buffer as usize, Arc::new(AtomicBool::new(true)));
        if let Some(previous) = previous {
            previous.store(false, Ordering::Release);
        } else {
            self.inner.pool.fetch_add(1, Ordering::AcqRel);
        }
    }

    pub(super) fn remove_pool_buffer(&self, buffer: *mut pw::sys::pw_buffer) {
        let Some(active) = self.inner.buffers.lock().remove(&(buffer as usize)) else {
            return;
        };
        active.store(false, Ordering::Release);
        let mut current = self.inner.pool.load(Ordering::Acquire);
        while current > 0 {
            match self.inner.pool.compare_exchange_weak(
                current,
                current - 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(observed) => current = observed,
            }
        }
        let fd = unsafe { first_data_fd(buffer) };
        self.inner.cache.lock().retire_fd(fd);
    }

    pub(super) fn retire_all(&self) {
        self.inner.cache.lock().retire_all();
    }

    pub(super) fn can_lease(&self) -> bool {
        spare_buffer(
            self.inner.pool.load(Ordering::Acquire),
            self.inner.inflight.load(Ordering::Acquire),
        )
    }

    pub(super) fn wait_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut guard = self.inner.inflight_lock.lock();
        loop {
            if self.inner.inflight.load(Ordering::Acquire) == 0 {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            self.inner
                .inflight_cv
                .wait_for(&mut guard, deadline.saturating_duration_since(now));
        }
    }

    #[cfg(test)]
    pub(super) fn inflight(&self) -> usize {
        self.inner.inflight.load(Ordering::Acquire)
    }

    #[cfg(test)]
    fn unmap_idle(&self) {
        self.inner.cache.lock().unmap_idle();
    }

    fn begin_inflight(&self) {
        let _guard = self.inner.inflight_lock.lock();
        self.inner.inflight.fetch_add(1, Ordering::AcqRel);
    }

    fn end_inflight(&self) {
        let _guard = self.inner.inflight_lock.lock();
        let previous = self.inner.inflight.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0);
        if previous == 1 {
            self.inner.inflight_cv.notify_all();
        }
    }
}

impl Inner {
    fn complete(&self, aliased: &AliasedBuffer) {
        if aliased.end_sync && aliased.fd >= 0 {
            if let Err(error) = dma_buf_sync(aliased.fd, DMA_BUF_SYNC_READ | DMA_BUF_SYNC_END) {
                tracing::warn!(
                    %error,
                    "ending the PipeWire screen capture DMA-BUF read failed"
                );
            }
        }
        self.cache.lock().release(aliased.map_base);
        self.releases.fetch_add(1, Ordering::Release);
        if let Some(buffer) = &aliased.release
            && buffer.is_active()
        {
            self.requeues.fetch_add(1, Ordering::Release);
            if let Some(sender) = self.requeue.lock().as_ref() {
                let _ = sender.send(buffer.clone());
            }
        }
    }
}

unsafe extern "C" fn release_aliased_pipewire_frame(opaque: *mut libc::c_void, _data: *mut u8) {
    if opaque.is_null() {
        return;
    }
    let aliased = unsafe { Box::from_raw(opaque.cast::<AliasedBuffer>()) };
    aliased.frames.complete(&aliased);
    aliased.frames.end_borrow();
}

impl Inner {
    fn end_borrow(&self) {
        let _guard = self.inflight_lock.lock();
        let previous = self.inflight.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0);
        if previous == 1 {
            self.inflight_cv.notify_all();
        }
    }
}

/// Read one linear plane. `lease` borrows the producer buffer when the crop
/// fits in the mapping; otherwise the returned frame owns a private copy and
/// the caller queues the PipeWire buffer immediately.
pub(super) fn linear_frame(
    frames: &PipewireFrames,
    source: &SourcePlane,
    geometry: &LinearGeometry,
    lease: bool,
) -> anyhow::Result<(ffmpeg::frame::Video, bool)> {
    let LinearGeometry {
        pixel_format: _,
        bytes_per_pixel,
        source_stride,
        crop_x,
        crop_y,
        crop_width,
        crop_height,
        offset,
        limit,
    } = *geometry;
    if source_stride == 0 || crop_width == 0 || crop_height == 0 || bytes_per_pixel == 0 {
        bail!("PipeWire screen capture frame had an empty stride");
    }
    let row_bytes = crop_width
        .checked_mul(bytes_per_pixel)
        .ok_or_else(|| anyhow!("PipeWire screen capture frame size overflowed"))?;
    if source_stride < row_bytes {
        bail!(
            "PipeWire screen capture frame stride was too small: {source_stride} for {crop_width}"
        );
    }
    let frame_bytes = frame_byte_end(
        offset,
        source_stride,
        crop_x,
        crop_y,
        crop_height,
        bytes_per_pixel,
        row_bytes,
    )?;

    let (base, len, sync_fd) = if source.data.is_null() && source.fd < 0 {
        bail!("PipeWire screen capture buffer was not memory-mapped");
    } else if source.data.is_null() {
        let (base, len) =
            frames
                .inner
                .cache
                .lock()
                .map(source.fd, source.map_offset, frame_bytes)?;
        let sync_fd = if source.sync_dma_buf {
            frames
                .inner
                .cache
                .lock()
                .owned_fd(base)
                .unwrap_or(source.fd)
        } else {
            -1
        };
        (base, len, sync_fd)
    } else if source.data_len < frame_bytes {
        bail!(
            "PipeWire screen capture frame was too small: {} bytes for the crop",
            source.data_len
        );
    } else {
        let sync_fd = if source.sync_dma_buf { source.fd } else { -1 };
        (source.data, source.data_len, sync_fd)
    };
    let readable = limit.unwrap_or(len).min(len);
    if frame_bytes > readable {
        bail!("PipeWire screen capture frame was too small: {readable} bytes for the crop");
    }

    if sync_fd >= 0 {
        dma_buf_sync(sync_fd, DMA_BUF_SYNC_READ)
            .context("sync the PipeWire screen capture DMA-BUF for reading")?;
    }

    let start = offset + crop_y * source_stride + crop_x * bytes_per_pixel;
    // MemPtr storage can disappear when remove_buffer returns. Only our owned
    // fd mappings keep an encoder's outstanding frame alive across renegotiation.
    if lease
        && source.data.is_null()
        && alias_window_fits(start, source_stride, crop_height, readable)
        && let Some(frame) = alias_frame(
            frames,
            source,
            geometry,
            PlaneWindow {
                base,
                len,
                start,
                row_bytes,
                sync_fd,
            },
        )?
    {
        return Ok((frame, true));
    }

    let copied = match copy_linear_frame(
        unsafe { std::slice::from_raw_parts(base, len) },
        geometry,
        readable,
        row_bytes,
    ) {
        Ok(frame) => frame,
        Err(error) => {
            end_dma_read(sync_fd);
            return Err(error);
        }
    };
    end_dma_read(sync_fd);
    Ok((copied, false))
}

fn end_dma_read(sync_fd: RawFd) {
    if sync_fd < 0 {
        return;
    }
    if let Err(error) = dma_buf_sync(sync_fd, DMA_BUF_SYNC_READ | DMA_BUF_SYNC_END) {
        tracing::warn!(
            %error,
            "ending the PipeWire screen capture DMA-BUF read failed"
        );
    }
}

struct PlaneWindow {
    base: *mut u8,
    len: usize,
    start: usize,
    row_bytes: usize,
    sync_fd: RawFd,
}

fn alias_frame(
    frames: &PipewireFrames,
    source: &SourcePlane,
    geometry: &LinearGeometry,
    plane: PlaneWindow,
) -> anyhow::Result<Option<ffmpeg::frame::Video>> {
    let Ok(linesize) = i32::try_from(geometry.source_stride) else {
        return Ok(None);
    };
    if linesize as usize != geometry.source_stride || geometry.source_stride < plane.row_bytes {
        return Ok(None);
    }
    let map_base = if source.fd >= 0 {
        plane.base as usize
    } else {
        0
    };
    let release = if source.pw_buffer == 0 {
        None
    } else {
        let Some(active) = frames.inner.buffers.lock().get(&source.pw_buffer).cloned() else {
            return Ok(None);
        };
        Some(BufferRelease {
            address: source.pw_buffer,
            active,
        })
    };
    frames.begin_inflight();
    let aliased = Box::new(AliasedBuffer {
        frames: Arc::clone(&frames.inner),
        release,
        fd: plane.sync_fd,
        map_base,
        end_sync: plane.sync_fd >= 0,
    });
    let opaque = Box::into_raw(aliased);
    let buffer = unsafe {
        ffmpeg::sys::av_buffer_create(
            plane.base,
            plane.len,
            Some(release_aliased_pipewire_frame),
            opaque.cast(),
            ffmpeg::sys::AV_BUFFER_FLAG_READONLY as libc::c_int,
        )
    };
    if buffer.is_null() {
        drop(unsafe { Box::from_raw(opaque) });
        frames.end_inflight();
        return Ok(None);
    }
    if map_base != 0 {
        frames.inner.cache.lock().lease(plane.base);
    }
    let mut frame = ffmpeg::frame::Video::empty();
    frame.set_format(geometry.pixel_format);
    frame.set_width(geometry.crop_width as u32);
    frame.set_height(geometry.crop_height as u32);
    unsafe {
        let raw = frame.as_mut_ptr();
        (*raw).data[0] = plane.base.add(plane.start);
        (*raw).linesize[0] = linesize;
        (*raw).buf[0] = buffer;
    }
    Ok(Some(frame))
}

fn copy_linear_frame(
    source: &[u8],
    geometry: &LinearGeometry,
    readable: usize,
    row_bytes: usize,
) -> anyhow::Result<ffmpeg::frame::Video> {
    let mut frame = ffmpeg::frame::Video::new(
        geometry.pixel_format,
        geometry.crop_width as u32,
        geometry.crop_height as u32,
    );
    let target_stride = frame.stride(0);
    if target_stride < row_bytes {
        bail!(
            "PipeWire target frame stride was too small: {} for {}x{}",
            target_stride,
            geometry.crop_width,
            geometry.crop_height
        );
    }
    for y in 0..geometry.crop_height {
        let source_start = geometry.offset
            + (geometry.crop_y + y) * geometry.source_stride
            + geometry.crop_x * geometry.bytes_per_pixel;
        let source_end = source_start + row_bytes;
        if source_end > readable || source_end > source.len() {
            bail!(
                "PipeWire screen capture frame was too small: {} bytes for the crop",
                source.len()
            );
        }
        let target_start = y * target_stride;
        frame.data_mut(0)[target_start..target_start + row_bytes]
            .copy_from_slice(&source[source_start..source_end]);
    }
    Ok(frame)
}

fn frame_byte_end(
    offset: usize,
    stride: usize,
    crop_x: usize,
    crop_y: usize,
    crop_height: usize,
    bytes_per_pixel: usize,
    row_bytes: usize,
) -> anyhow::Result<usize> {
    let last_row = crop_y
        .checked_add(crop_height - 1)
        .ok_or_else(|| anyhow!("PipeWire screen capture frame size overflowed"))?;
    offset
        .checked_add(
            last_row
                .checked_mul(stride)
                .ok_or_else(|| anyhow!("PipeWire screen capture frame size overflowed"))?,
        )
        .and_then(|start| start.checked_add(crop_x * bytes_per_pixel))
        .and_then(|start| start.checked_add(row_bytes))
        .ok_or_else(|| anyhow!("PipeWire screen capture frame size overflowed"))
}

fn alias_window_fits(start: usize, stride: usize, height: usize, limit: usize) -> bool {
    stride
        .checked_mul(height)
        .and_then(|bytes| start.checked_add(bytes))
        .is_some_and(|end| end <= limit)
}

fn mapped_len(fd: RawFd, map_offset: usize, minimum_len: usize) -> anyhow::Result<usize> {
    if fd < 0 {
        bail!("PipeWire screen capture DMA-BUF had no file descriptor");
    }
    let len = match file_len(fd) {
        Ok(len) if len > 0 => len.checked_sub(map_offset).ok_or_else(|| {
            anyhow!("PipeWire screen capture map offset {map_offset} is past the end of the buffer")
        })?,
        _ => minimum_len,
    };
    if len < minimum_len {
        bail!("PipeWire screen capture DMA-BUF holds {len} bytes, the frame needs {minimum_len}");
    }
    Ok(len)
}

fn file_len(fd: RawFd) -> std::io::Result<usize> {
    let current = unsafe { libc::lseek(fd, 0, libc::SEEK_CUR) };
    let size = unsafe { libc::lseek(fd, 0, libc::SEEK_END) };
    if current >= 0 {
        unsafe {
            libc::lseek(fd, current, libc::SEEK_SET);
        }
    }
    if size < 0 {
        return Err(std::io::Error::last_os_error());
    }
    usize::try_from(size).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "PipeWire DMA-BUF length")
    })
}

fn dma_buf_sync(fd: RawFd, flags: u64) -> std::io::Result<()> {
    let sync = flags;
    loop {
        let result = unsafe { libc::ioctl(fd, DMA_BUF_IOCTL_SYNC, &sync as *const u64) };
        if result == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::EINTR | libc::EAGAIN) => continue,
            Some(libc::ENOTTY) => return Ok(()),
            _ => return Err(error),
        }
    }
}

unsafe fn first_data_fd(buffer: *mut pw::sys::pw_buffer) -> i32 {
    if buffer.is_null() {
        return -1;
    }
    let spa = unsafe { (*buffer).buffer };
    if spa.is_null() || unsafe { (*spa).datas.is_null() || (*spa).n_datas == 0 } {
        return -1;
    }
    let fd = unsafe { (*(*spa).datas).fd };
    i32::try_from(fd).unwrap_or(-1)
}

#[cfg(test)]
mod tests {
    use std::os::fd::AsRawFd;

    use super::*;

    fn geometry(
        _width: usize,
        _height: usize,
        stride: usize,
        crop_x: usize,
        crop_y: usize,
        crop_width: usize,
        crop_height: usize,
    ) -> LinearGeometry {
        LinearGeometry {
            pixel_format: ffmpeg::format::Pixel::BGRA,
            bytes_per_pixel: 4,
            source_stride: stride,
            crop_x,
            crop_y,
            crop_width,
            crop_height,
            offset: 0,
            limit: None,
        }
    }

    fn memptr_plane(bytes: &mut [u8]) -> SourcePlane {
        SourcePlane {
            data: bytes.as_mut_ptr(),
            data_len: bytes.len(),
            fd: -1,
            map_offset: 0,
            sync_dma_buf: false,
            pw_buffer: 0,
        }
    }

    fn memfd_plane(file: &std::fs::File) -> SourcePlane {
        SourcePlane {
            data: std::ptr::null_mut(),
            data_len: 0,
            fd: file.as_raw_fd(),
            map_offset: 0,
            sync_dma_buf: false,
            pw_buffer: 0,
        }
    }

    #[test]
    fn spare_pool_keeps_one_buffer_for_the_producer() {
        assert!(!spare_buffer(0, 0));
        assert!(!spare_buffer(1, 0));
        assert!(spare_buffer(2, 0));
        assert!(!spare_buffer(2, 1));
        assert!(spare_buffer(8, 1));
        assert!(spare_buffer(8, 6));
        assert!(!spare_buffer(8, 7));
    }

    #[test]
    fn memptr_is_copied_before_the_producer_storage_is_removed() {
        ffmpeg::init().expect("ffmpeg");
        let mut bytes = vec![0u8; 8 * 4];
        for (index, pixel) in bytes.chunks_exact_mut(4).enumerate() {
            pixel.copy_from_slice(&[index as u8, 2, 3, 4]);
        }
        let frames = PipewireFrames::new();
        let plane = memptr_plane(&mut bytes);
        let (frame, leased) =
            linear_frame(&frames, &plane, &geometry(2, 2, 8, 0, 0, 2, 2), true).unwrap();
        assert!(!leased);
        assert_ne!(frame.data(0).as_ptr(), bytes.as_ptr());
        drop(bytes);
        assert_eq!(&frame.data(0)[..8], &[0, 2, 3, 4, 1, 2, 3, 4]);
        assert_eq!(frames.inflight(), 0);
    }

    #[test]
    fn readonly_alias_is_copied_before_it_can_be_written() {
        ffmpeg::init().expect("ffmpeg");
        let bytes = [7u8, 8, 9, 10, 0, 0, 0, 0];
        let mut file = tempfile::tempfile().unwrap();
        std::io::Write::write_all(&mut file, &bytes).unwrap();
        let frames = PipewireFrames::new();
        let plane = memfd_plane(&file);
        let (mut frame, leased) =
            linear_frame(&frames, &plane, &geometry(1, 1, 8, 0, 0, 1, 1), true).unwrap();
        assert!(leased);
        let source = frame.data(0).as_ptr();
        let status = unsafe { ffmpeg::sys::av_frame_make_writable(frame.as_mut_ptr()) };
        assert!(status >= 0, "make_writable status {status}");
        assert_ne!(frame.data(0).as_ptr(), source);
        assert_eq!(&frame.data(0)[..4], &[7, 8, 9, 10]);
        assert_eq!(frames.inner.releases.load(Ordering::Acquire), 1);
        assert_eq!(frames.inflight(), 0);
        std::os::unix::fs::FileExt::write_at(&file, &[99], 0).unwrap();
        assert_eq!(frame.data(0)[0], 7);
    }

    #[test]
    fn dmabuf_mapping_is_reused_until_size_changes_and_not_unmapped_while_borrowed() {
        ffmpeg::init().expect("ffmpeg");
        let (width, height, stride) = (4usize, 2usize, 16usize);
        let mut bytes = vec![0u8; stride * height];
        for y in 0..height {
            for x in 0..width {
                bytes[y * stride + x * 4] = (y * 10 + x) as u8;
            }
        }
        let mut file = tempfile::tempfile().unwrap();
        std::io::Write::write_all(&mut file, &bytes).unwrap();
        let fd = file.as_raw_fd();
        let frames = PipewireFrames::new();
        let plane = SourcePlane {
            data: std::ptr::null_mut(),
            data_len: 0,
            fd,
            map_offset: 0,
            sync_dma_buf: true,
            pw_buffer: 0,
        };
        let (first, leased) = linear_frame(
            &frames,
            &plane,
            &geometry(width, height, stride, 0, 0, width, height),
            true,
        )
        .unwrap();
        assert!(leased);
        let pointer = first.data(0).as_ptr();
        assert_eq!(frames.inner.cache.lock().base_for(fd), Some(pointer));
        assert_eq!(frames.inner.cache.lock().map_calls, 1);
        assert_eq!(&first.data(0)[..4], &bytes[..4]);

        frames.unmap_idle();
        assert!(frames.inner.cache.lock().contains(pointer as usize));
        assert_eq!(first.data(0)[0], bytes[0]);

        drop(first);
        let (second, _) = linear_frame(
            &frames,
            &plane,
            &geometry(width, height, stride, 0, 0, width, height),
            true,
        )
        .unwrap();
        assert_eq!(second.data(0).as_ptr(), pointer);
        assert_eq!(frames.inner.cache.lock().map_calls, 1);

        file.set_len((stride * height * 2) as u64).unwrap();
        let (grown, _) = linear_frame(
            &frames,
            &plane,
            &geometry(width, height, stride, 0, 0, width, height),
            true,
        )
        .unwrap();
        assert_ne!(grown.data(0).as_ptr(), pointer);
        assert_eq!(second.data(0)[0], bytes[0]);
        assert!(frames.inner.cache.lock().contains(pointer as usize));
        drop(second);
        assert!(!frames.inner.cache.lock().contains(pointer as usize));
        assert_eq!(grown.data(0)[0], bytes[0]);
        drop(grown);
    }

    #[test]
    fn a_crop_that_does_not_fit_the_line_window_is_copied() {
        ffmpeg::init().expect("ffmpeg");
        let mut bytes = vec![0u8; 16 * 2];
        bytes[4] = 42;
        let frames = PipewireFrames::new();
        let plane = memptr_plane(&mut bytes);
        let (frame, leased) =
            linear_frame(&frames, &plane, &geometry(4, 2, 16, 1, 0, 1, 2), true).unwrap();
        assert!(!leased);
        let copied = frame.data(0).as_ptr() as usize;
        let origin = bytes.as_ptr() as usize;
        assert!(copied < origin || copied >= origin + bytes.len());
        assert_eq!(frame.data(0)[0], 42);
        assert_eq!(frames.inflight(), 0);
        assert_eq!(frames.inner.requeues.load(Ordering::Acquire), 0);
    }

    #[test]
    fn a_borrowed_pipewire_buffer_is_returned_once_on_the_last_drop() {
        ffmpeg::init().expect("ffmpeg");
        let mut file = tempfile::tempfile().unwrap();
        std::io::Write::write_all(&mut file, &[1u8, 2, 3, 4]).unwrap();
        let frames = PipewireFrames::new();
        frames.add_pool_buffer(0x51ce as *mut pw::sys::pw_buffer);
        frames.add_pool_buffer(0x51cf as *mut pw::sys::pw_buffer);
        frames.add_pool_buffer(0x51d0 as *mut pw::sys::pw_buffer);
        let mut plane = memfd_plane(&file);
        plane.pw_buffer = 0x51ce;
        let (frame, leased) =
            linear_frame(&frames, &plane, &geometry(1, 1, 4, 0, 0, 1, 1), true).unwrap();
        assert!(leased);
        assert!(frames.can_lease());
        let mut duplicate = ffmpeg::frame::Video::empty();
        let status = unsafe { ffmpeg::sys::av_frame_ref(duplicate.as_mut_ptr(), frame.as_ptr()) };
        assert!(status >= 0);
        drop(frame);
        assert_eq!(frames.inner.requeues.load(Ordering::Acquire), 0);
        drop(duplicate);
        assert_eq!(frames.inner.requeues.load(Ordering::Acquire), 1);
        assert_eq!(frames.inflight(), 0);
    }

    #[test]
    fn removing_a_borrowed_buffer_keeps_pixels_alive_without_requeueing_it() {
        ffmpeg::init().expect("ffmpeg");
        let mut file = tempfile::tempfile().unwrap();
        std::io::Write::write_all(&mut file, &[1u8, 2, 3, 4]).unwrap();
        let mut buffer = Box::new(unsafe { std::mem::zeroed::<pw::sys::pw_buffer>() });
        let address = &mut *buffer as *mut pw::sys::pw_buffer;
        let frames = PipewireFrames::new();
        frames.add_pool_buffer(address);
        let mut plane = memfd_plane(&file);
        plane.pw_buffer = address as usize;
        let (frame, leased) =
            linear_frame(&frames, &plane, &geometry(1, 1, 4, 0, 0, 1, 1), true).unwrap();
        assert!(leased);

        frames.remove_pool_buffer(address);
        frames.retire_all();
        drop(buffer);
        drop(file);
        assert_eq!(&frame.data(0)[..4], &[1, 2, 3, 4]);
        assert_eq!(frames.inner.pool.load(Ordering::Acquire), 0);
        drop(frame);
        assert_eq!(frames.inflight(), 0);
        assert_eq!(frames.inner.releases.load(Ordering::Acquire), 1);
        assert_eq!(frames.inner.requeues.load(Ordering::Acquire), 0);
        assert_eq!(frames.inner.cache.lock().unmap_calls, 1);
    }

    #[test]
    fn removal_cancels_queued_releases_even_when_the_buffer_address_is_reused() {
        ffmpeg::init().expect("ffmpeg");
        let mut file = tempfile::tempfile().unwrap();
        std::io::Write::write_all(&mut file, &[5u8, 6, 7, 8]).unwrap();
        let mut buffer = Box::new(unsafe { std::mem::zeroed::<pw::sys::pw_buffer>() });
        let address = &mut *buffer as *mut pw::sys::pw_buffer;
        let frames = PipewireFrames::new();
        frames.add_pool_buffer(address);
        let mut plane = memfd_plane(&file);
        plane.pw_buffer = address as usize;
        let (frame, leased) =
            linear_frame(&frames, &plane, &geometry(1, 1, 4, 0, 0, 1, 1), true).unwrap();
        assert!(leased);
        let queued = BufferRelease {
            address: address as usize,
            active: frames.inner.buffers.lock()[&(address as usize)].clone(),
        };
        drop(frame);
        assert_eq!(frames.inner.requeues.load(Ordering::Acquire), 1);
        assert!(queued.is_active());

        frames.remove_pool_buffer(address);
        frames.add_pool_buffer(address);
        assert!(!queued.is_active());
        let replacement = frames.inner.buffers.lock()[&(address as usize)].clone();
        assert!(!Arc::ptr_eq(&queued.active, &replacement));
        assert!(replacement.load(Ordering::Acquire));
        frames.queue_released_buffer(queued);
        let (frame, leased) =
            linear_frame(&frames, &plane, &geometry(1, 1, 4, 0, 0, 1, 1), true).unwrap();
        assert!(leased);
        assert_eq!(&frame.data(0)[..4], &[5, 6, 7, 8]);
        drop(frame);
        assert_eq!(frames.inner.requeues.load(Ordering::Acquire), 2);
        assert_eq!(frames.inflight(), 0);
    }

    #[test]
    fn memfd_map_offset_selects_the_producer_region_and_cache_entry() {
        ffmpeg::init().expect("ffmpeg");
        let page = page_size();
        let (width, height, stride) = (4usize, 2usize, 16usize);
        let chunk_offset = 16usize;
        let mut bytes = vec![0u8; page * 2];
        bytes[..page].fill(0xA1);
        bytes[page..].fill(0xB2);
        bytes[chunk_offset] = 0x10;
        bytes[page + chunk_offset] = 0x20;
        let mut file = tempfile::tempfile().unwrap();
        std::io::Write::write_all(&mut file, &bytes).unwrap();
        let fd = file.as_raw_fd();
        let frames = PipewireFrames::new();
        let mut geometry = geometry(width, height, stride, 0, 0, width, height);
        geometry.offset = chunk_offset;
        let plane = |map_offset| SourcePlane {
            data: std::ptr::null_mut(),
            data_len: 0,
            fd,
            map_offset,
            sync_dma_buf: false,
            pw_buffer: 0,
        };

        let (borrowed, leased) = linear_frame(&frames, &plane(page), &geometry, true).unwrap();
        assert!(leased);
        assert_eq!(borrowed.data(0)[0], 0x20);
        let (copied, leased) = linear_frame(&frames, &plane(page), &geometry, false).unwrap();
        assert!(!leased);
        assert_eq!(copied.data(0)[0], 0x20);
        assert_ne!(copied.data(0).as_ptr(), borrowed.data(0).as_ptr());

        let (region_a, _) = linear_frame(&frames, &plane(0), &geometry, true).unwrap();
        assert_eq!(region_a.data(0)[0], 0x10);
        assert_eq!(borrowed.data(0)[0], 0x20);
        assert_eq!(frames.inner.cache.lock().map_calls, 2);

        drop(borrowed);
        drop(copied);
        drop(region_a);
        let (again, _) = linear_frame(&frames, &plane(page), &geometry, true).unwrap();
        assert_eq!(again.data(0)[0], 0x20);
        assert_eq!(frames.inner.cache.lock().map_calls, 2);
    }

    #[test]
    fn four_k_bgra_alias_avoids_the_row_copy_and_keeps_the_mapping() {
        ffmpeg::init().expect("ffmpeg");
        const WIDTH: usize = 3840;
        const HEIGHT: usize = 2160;
        const STRIDE: usize = WIDTH * 4;
        let mut bytes = vec![0u8; STRIDE * HEIGHT];
        bytes[0] = 11;
        bytes[STRIDE * HEIGHT - 1] = 22;
        let frames = PipewireFrames::new();
        let geometry = geometry(WIDTH, HEIGHT, STRIDE, 0, 0, WIDTH, HEIGHT);

        let mut source = tempfile::tempfile().unwrap();
        std::io::Write::write_all(&mut source, &bytes).unwrap();
        let plane = memfd_plane(&source);
        let (frame, leased) = linear_frame(&frames, &plane, &geometry, true).unwrap();
        assert!(leased);
        let pointer = frame.data(0).as_ptr();
        assert_eq!(
            frames.inner.cache.lock().base_for(source.as_raw_fd()),
            Some(pointer)
        );
        assert_eq!(frame.data(0)[0], 11);
        assert_eq!(frame.data(0)[frame.data(0).len() - 1], 22);
        drop(frame);

        let copied_plane = SourcePlane {
            data: bytes.as_mut_ptr(),
            data_len: bytes.len(),
            fd: -1,
            map_offset: 0,
            sync_dma_buf: false,
            pw_buffer: 1,
        };
        let (copied, leased) = linear_frame(&frames, &copied_plane, &geometry, false).unwrap();
        assert!(!leased);
        assert_ne!(copied.data(0).as_ptr(), bytes.as_ptr());
        assert_eq!(copied.data(0)[0], 11);
        assert_eq!(copied.data(0)[copied.data(0).len() - 1], 22);

        let file = tempfile::tempfile().unwrap();
        file.set_len((STRIDE * HEIGHT) as u64).unwrap();
        let fd = file.as_raw_fd();
        let cached = PipewireFrames::new();
        let mapped = SourcePlane {
            data: std::ptr::null_mut(),
            data_len: 0,
            fd,
            map_offset: 0,
            sync_dma_buf: true,
            pw_buffer: 0,
        };
        let (first, leased) = linear_frame(&cached, &mapped, &geometry, true).unwrap();
        assert!(leased);
        let pointer = first.data(0).as_ptr();
        drop(first);
        let (second, _) = linear_frame(&cached, &mapped, &geometry, true).unwrap();
        assert_eq!(second.data(0).as_ptr(), pointer);
        assert_eq!(cached.inner.cache.lock().map_calls, 1);
    }

    #[test]
    #[ignore = "scheduler-sensitive timing; pointer and map-count checks stay in four_k_bgra_alias_avoids_the_row_copy_and_keeps_the_mapping"]
    fn four_k_bgra_alias_is_faster_than_the_row_copy() {
        ffmpeg::init().expect("ffmpeg");
        const WIDTH: usize = 3840;
        const HEIGHT: usize = 2160;
        const STRIDE: usize = WIDTH * 4;
        let mut bytes = vec![0u8; STRIDE * HEIGHT];
        bytes[0] = 11;
        bytes[STRIDE * HEIGHT - 1] = 22;
        let frames = PipewireFrames::new();
        let geometry = geometry(WIDTH, HEIGHT, STRIDE, 0, 0, WIDTH, HEIGHT);

        let copy_ms = median_ms(|| {
            let plane = SourcePlane {
                data: bytes.as_mut_ptr(),
                data_len: bytes.len(),
                fd: -1,
                map_offset: 0,
                sync_dma_buf: false,
                pw_buffer: 1,
            };
            let (frame, leased) = linear_frame(&frames, &plane, &geometry, false).unwrap();
            assert!(!leased);
            std::hint::black_box(frame.data(0)[0]);
            std::hint::black_box(frame.data(0)[frame.data(0).len() - 1]);
            drop(frame);
        });
        let mut alias_file = tempfile::tempfile().unwrap();
        std::io::Write::write_all(&mut alias_file, &bytes).unwrap();
        let alias_plane = memfd_plane(&alias_file);
        let (warm, _) = linear_frame(&frames, &alias_plane, &geometry, true).unwrap();
        let pointer = warm.data(0).as_ptr();
        drop(warm);
        let alias_ms = median_ms(|| {
            let (frame, leased) = linear_frame(&frames, &alias_plane, &geometry, true).unwrap();
            assert!(leased);
            assert_eq!(frame.data(0).as_ptr(), pointer);
            std::hint::black_box(frame.data(0)[0]);
            drop(frame);
        });

        let file = tempfile::tempfile().unwrap();
        file.set_len((STRIDE * HEIGHT) as u64).unwrap();
        let fd = file.as_raw_fd();
        let map_ms = median_ms(|| {
            let mapped = PipewireFrames::new();
            let plane = SourcePlane {
                data: std::ptr::null_mut(),
                data_len: 0,
                fd,
                map_offset: 0,
                sync_dma_buf: true,
                pw_buffer: 0,
            };
            let (frame, leased) = linear_frame(&mapped, &plane, &geometry, true).unwrap();
            assert!(leased);
            std::hint::black_box(frame.data(0).as_ptr());
            drop(frame);
            drop(mapped);
        });
        let cached = PipewireFrames::new();
        let plane = SourcePlane {
            data: std::ptr::null_mut(),
            data_len: 0,
            fd,
            map_offset: 0,
            sync_dma_buf: true,
            pw_buffer: 0,
        };
        let (warm, _) = linear_frame(&cached, &plane, &geometry, true).unwrap();
        drop(warm);
        let cached_ms = median_ms(|| {
            let (frame, _) = linear_frame(&cached, &plane, &geometry, true).unwrap();
            std::hint::black_box(frame.data(0).as_ptr());
            drop(frame);
        });
        assert_eq!(cached.inner.cache.lock().map_calls, 1);

        let profile = if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        };
        let report = format!(
            "profile {profile}\n4K BGRA {WIDTH}x{HEIGHT}\nrow-copy median_ms {copy_ms:.4}\nalias setup+release median_ms {alias_ms:.4}\ntempfile mmap+munmap median_ms {map_ms:.4}\ncached remap median_ms {cached_ms:.4}\nmap_calls 1\nnote tempfile is not a GPU dma-buf: DMA_BUF_IOCTL_SYNC returns ENOTTY and the mapping is not a scanned-out framebuffer, so this mmap time is not the ~1.1 ms GPU map/unmap.\n"
        );
        eprintln!("{report}");
        let _ = std::fs::create_dir_all("/opt/cursor/artifacts");
        let _ = std::fs::write("/opt/cursor/artifacts/pipewire-alias-4k.log", &report);
        assert!(copy_ms.is_finite() && alias_ms.is_finite());
        assert!(alias_ms < copy_ms);
    }

    fn page_size() -> usize {
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        usize::try_from(page).expect("page size")
    }

    fn median_ms(mut measure: impl FnMut()) -> f64 {
        for _ in 0..2 {
            measure();
        }
        let mut samples = Vec::with_capacity(9);
        for _ in 0..9 {
            let start = Instant::now();
            measure();
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(|left, right| left.partial_cmp(right).unwrap());
        samples[samples.len() / 2]
    }
}
