//! The libc surface the vendored RNNoise C code links against on
//! wasm32-unknown-unknown, which has no C runtime. `memcpy`, `memmove` and
//! `memset` come from Rust's compiler builtins.

use std::{
    alloc::{Layout, alloc, alloc_zeroed, dealloc, realloc as grow},
    ffi::{c_char, c_int, c_long, c_void},
};

const HEADER: usize = 16;

fn layout(size: usize) -> Option<Layout> {
    Layout::from_size_align(size.checked_add(HEADER)?, HEADER).ok()
}

unsafe fn finish(base: *mut u8, size: usize) -> *mut c_void {
    if base.is_null() {
        return std::ptr::null_mut();
    }
    unsafe {
        base.cast::<usize>().write(size);
        base.add(HEADER).cast()
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn malloc(size: usize) -> *mut c_void {
    let Some(layout) = layout(size) else {
        return std::ptr::null_mut();
    };
    unsafe { finish(alloc(layout), size) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn calloc(count: usize, size: usize) -> *mut c_void {
    let Some(size) = count.checked_mul(size) else {
        return std::ptr::null_mut();
    };
    let Some(layout) = layout(size) else {
        return std::ptr::null_mut();
    };
    unsafe { finish(alloc_zeroed(layout), size) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn free(pointer: *mut c_void) {
    if pointer.is_null() {
        return;
    }
    unsafe {
        let base = pointer.cast::<u8>().sub(HEADER);
        let size = base.cast::<usize>().read();
        if let Some(layout) = layout(size) {
            dealloc(base, layout);
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn realloc(pointer: *mut c_void, size: usize) -> *mut c_void {
    if pointer.is_null() {
        return unsafe { malloc(size) };
    }
    unsafe {
        let base = pointer.cast::<u8>().sub(HEADER);
        let old = base.cast::<usize>().read();
        let (Some(old_layout), Some(_)) = (layout(old), layout(size)) else {
            return std::ptr::null_mut();
        };
        finish(grow(base, old_layout, size + HEADER), size)
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn abs(value: c_int) -> c_int {
    value.wrapping_abs()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn strcmp(a: *const c_char, b: *const c_char) -> c_int {
    let mut index = 0;
    loop {
        let (left, right) = unsafe { (*a.add(index) as u8, *b.add(index) as u8) };
        if left != right || left == 0 {
            return c_int::from(left) - c_int::from(right);
        }
        index += 1;
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn sqrt(x: f64) -> f64 {
    libm::sqrt(x)
}

#[unsafe(no_mangle)]
pub extern "C" fn floor(x: f64) -> f64 {
    libm::floor(x)
}

#[unsafe(no_mangle)]
pub extern "C" fn cos(x: f64) -> f64 {
    libm::cos(x)
}

#[unsafe(no_mangle)]
pub extern "C" fn sin(x: f64) -> f64 {
    libm::sin(x)
}

#[unsafe(no_mangle)]
pub extern "C" fn log10(x: f64) -> f64 {
    libm::log10(x)
}

// Model files are never loaded by path in the browser; the bundled weights
// are passed by buffer.
#[unsafe(no_mangle)]
pub extern "C" fn fopen(_path: *const c_char, _mode: *const c_char) -> *mut c_void {
    std::ptr::null_mut()
}

#[unsafe(no_mangle)]
pub extern "C" fn fread(
    _ptr: *mut c_void,
    _size: usize,
    _count: usize,
    _file: *mut c_void,
) -> usize {
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn fclose(_file: *mut c_void) -> c_int {
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn fseek(_file: *mut c_void, _offset: c_long, _whence: c_int) -> c_int {
    -1
}

#[unsafe(no_mangle)]
pub extern "C" fn ftell(_file: *mut c_void) -> c_long {
    -1
}
