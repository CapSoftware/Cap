use ffmpeg::format::Pixel;
use ffmpeg::frame;
use parking_lot::Mutex;
use std::ffi::c_void;

// Image bytes stay in this pool after the last AVFrame reference drops, so
// `convert` can hand out the same allocation again. Callers still receive an
// exclusively owned frame::Video.
const POOLED_PER_SIZE: usize = 16;

struct PooledBuffer {
    ptr: *mut u8,
    size: usize,
}

// Exclusive ownership of `ptr` moves with the value under OUTPUT_POOL.
unsafe impl Send for PooledBuffer {}

static OUTPUT_POOL: Mutex<Vec<PooledBuffer>> = Mutex::new(Vec::new());
static LAYOUTS: Mutex<Vec<FrameLayout>> = Mutex::new(Vec::new());

#[derive(Clone, Copy)]
struct FrameLayout {
    format: Pixel,
    width: u32,
    height: u32,
    linesize: [i32; 8],
    offset: [isize; 8],
    size: usize,
}

pub(crate) fn cached_output_frame(format: Pixel, width: u32, height: u32) -> frame::Video {
    if width == 0 || height == 0 {
        return frame::Video::new(format, width, height);
    }
    let Some(layout) = layout_for(format, width, height) else {
        return frame::Video::new(format, width, height);
    };
    assemble(&layout).unwrap_or_else(|| frame::Video::new(format, width, height))
}

fn layout_for(format: Pixel, width: u32, height: u32) -> Option<FrameLayout> {
    if let Some(layout) = find_layout(format, width, height) {
        return Some(layout);
    }
    let probe = frame::Video::new(format, width, height);
    let layout = capture(&probe)?;
    drop(probe);
    let mut layouts = LAYOUTS.lock();
    if let Some(existing) = layouts
        .iter()
        .copied()
        .find(|layout| layout.format == format && layout.width == width && layout.height == height)
    {
        return Some(existing);
    }
    layouts.push(layout);
    Some(layout)
}

fn find_layout(format: Pixel, width: u32, height: u32) -> Option<FrameLayout> {
    LAYOUTS
        .lock()
        .iter()
        .copied()
        .find(|layout| layout.format == format && layout.width == width && layout.height == height)
}

fn capture(frame: &frame::Video) -> Option<FrameLayout> {
    unsafe {
        let raw = frame.as_ptr();
        if raw.is_null() || (*raw).buf[0].is_null() {
            return None;
        }
        for index in 1..8 {
            if !(*raw).buf[index].is_null() {
                return None;
            }
        }
        let buf = (*raw).buf[0];
        let base = (*buf).data;
        let size = (*buf).size;
        if base.is_null() || size == 0 {
            return None;
        }
        let mut linesize = [0i32; 8];
        let mut offset = [-1isize; 8];
        for index in 0..8 {
            linesize[index] = (*raw).linesize[index];
            let plane = (*raw).data[index];
            if plane.is_null() {
                continue;
            }
            let off = (plane as usize).wrapping_sub(base as usize);
            if off >= size {
                return None;
            }
            offset[index] = off as isize;
        }
        if offset[0] < 0 {
            return None;
        }
        Some(FrameLayout {
            format: frame.format(),
            width: frame.width(),
            height: frame.height(),
            linesize,
            offset,
            size,
        })
    }
}

fn assemble(layout: &FrameLayout) -> Option<frame::Video> {
    let data = take_pooled(layout.size).or_else(|| malloc_zeroed(layout.size))?;
    let mut frame = frame::Video::empty();
    if unsafe { frame.as_ptr() }.is_null() {
        free_data(data);
        return None;
    }
    frame.set_format(layout.format);
    frame.set_width(layout.width);
    frame.set_height(layout.height);
    unsafe {
        let raw = frame.as_mut_ptr();
        let buf = ffmpeg::ffi::av_buffer_create(
            data,
            layout.size,
            Some(release_output_buffer),
            layout.size as *mut c_void,
            0,
        );
        if buf.is_null() {
            free_data(data);
            return None;
        }
        (*raw).buf[0] = buf;
        for index in 0..8 {
            (*raw).linesize[index] = layout.linesize[index];
            if layout.offset[index] >= 0 {
                (*raw).data[index] = data.offset(layout.offset[index]);
            }
        }
        (*raw).extended_data = (*raw).data.as_mut_ptr();
    }
    Some(frame)
}

fn take_pooled(size: usize) -> Option<*mut u8> {
    let mut pool = OUTPUT_POOL.lock();
    let index = pool.iter().rposition(|buf| buf.size == size)?;
    Some(pool.swap_remove(index).ptr)
}

fn malloc_zeroed(size: usize) -> Option<*mut u8> {
    if size == 0 {
        return None;
    }
    unsafe {
        let ptr = ffmpeg::ffi::av_malloc(size) as *mut u8;
        if ptr.is_null() {
            None
        } else {
            std::ptr::write_bytes(ptr, 0, size);
            Some(ptr)
        }
    }
}

fn free_data(ptr: *mut u8) {
    unsafe {
        ffmpeg::ffi::av_free(ptr.cast());
    }
}

unsafe extern "C" fn release_output_buffer(opaque: *mut c_void, data: *mut u8) {
    if data.is_null() {
        return;
    }
    let size = opaque as usize;
    if size == 0 {
        free_data(data);
        return;
    }
    let mut pool = OUTPUT_POOL.lock();
    let same_size = pool.iter().filter(|buf| buf.size == size).count();
    if same_size < POOLED_PER_SIZE {
        pool.push(PooledBuffer { ptr: data, size });
    } else {
        free_data(data);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Once;

    fn init_ffmpeg() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            ffmpeg::init().expect("ffmpeg init");
        });
    }

    fn plane_offset(frame: &frame::Video, plane: usize) -> usize {
        unsafe {
            let raw = frame.as_ptr();
            let base = (*(*raw).buf[0]).data as usize;
            (*raw).data[plane] as usize - base
        }
    }

    #[test]
    fn cached_frame_matches_ffmpeg_geometry() {
        init_ffmpeg();
        let mut cached = cached_output_frame(Pixel::NV12, 94, 46);
        let fresh = frame::Video::new(Pixel::NV12, 94, 46);
        assert_eq!(cached.format(), fresh.format());
        assert_eq!(cached.width(), fresh.width());
        assert_eq!(cached.height(), fresh.height());
        assert_eq!(cached.stride(0), fresh.stride(0));
        assert_eq!(cached.stride(1), fresh.stride(1));
        assert_eq!(cached.planes(), fresh.planes());
        assert_eq!(plane_offset(&cached, 0), plane_offset(&fresh, 0));
        assert_eq!(plane_offset(&cached, 1), plane_offset(&fresh, 1));
        unsafe {
            assert_eq!(ffmpeg::ffi::av_frame_is_writable(cached.as_mut_ptr()), 1);
        }
    }

    #[test]
    fn dropped_frame_returns_its_buffer() {
        init_ffmpeg();
        let first = cached_output_frame(Pixel::NV12, 95, 46);
        let ptr = unsafe { (*first.as_ptr()).data[0] };
        drop(first);
        let mut second = cached_output_frame(Pixel::NV12, 95, 46);
        let reused = unsafe { (*second.as_ptr()).data[0] };
        assert_eq!(reused, ptr);
        second.data_mut(0).fill(7);
        assert!(second.data(0).iter().all(|byte| *byte == 7));
    }

    #[test]
    fn live_reference_keeps_the_buffer_out_of_the_pool() {
        init_ffmpeg();
        let mut held = frame::Video::empty();
        let ptr = {
            let mut frame = cached_output_frame(Pixel::YUYV422, 96, 40);
            frame.data_mut(0).fill(19);
            unsafe {
                let status = ffmpeg::ffi::av_frame_ref(held.as_mut_ptr(), frame.as_ptr());
                assert!(status >= 0);
                (*frame.as_ptr()).data[0]
            }
        };
        let next = cached_output_frame(Pixel::YUYV422, 96, 40);
        let next_ptr = unsafe { (*next.as_ptr()).data[0] };
        assert_ne!(next_ptr, ptr);
        assert!(held.data(0).iter().all(|byte| *byte == 19));
        drop(held);
        let recycled = cached_output_frame(Pixel::YUYV422, 96, 40);
        let recycled_ptr = unsafe { (*recycled.as_ptr()).data[0] };
        assert_eq!(recycled_ptr, ptr);
        assert_ne!(next_ptr, recycled_ptr);
        drop(next);
    }
}
