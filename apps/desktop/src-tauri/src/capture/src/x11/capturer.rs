use libc;
use std::{io, ptr, slice};
use super::Display;
use super::ffi::*;

pub struct Capturer {
    display: Display,
    shmid: i32,
    xcbid: u32,
    buffer: *const u8,

    request: xcb_shm_get_image_cookie_t,
    loading: usize,
    size: usize
}

impl Capturer {
    pub fn new(
        display: Display
    ) -> io::Result<Capturer> {
        // Calculate dimensions.

        let pixel_width = 4;
        let rect = display.rect();
        let size = (rect.w as usize) * (rect.h as usize) * pixel_width;

        // Create a shared memory segment.

        let shmid = unsafe {
            libc::shmget(
                libc::IPC_PRIVATE,
                size * 2,
                // Everyone can do anything.
                libc::IPC_CREAT | 0o777
            )
        };

        if shmid == -1 {
            return Err(io::Error::last_os_error());
        }

        // Attach the segment to a readable address.

        let buffer = unsafe {
            libc::shmat(
                shmid,
                ptr::null(),
                libc::SHM_RDONLY
            )
        } as *mut u8;

        if buffer as isize == -1 {
            return Err(io::Error::last_os_error());
        }

        // Attach the segment to XCB.

        let server = display.server().raw();
        let xcbid = unsafe { xcb_generate_id(server) };
        unsafe {
            xcb_shm_attach(
                server,
                xcbid,
                shmid as u32,
                0 // False, i.e. not read-only.
            );
        }

        // Start the first screenshot early.

        let request = unsafe {
            xcb_shm_get_image_unchecked(
                server,
                display.root(),
                rect.x, rect.y,
                rect.w, rect.h,
                !0, // Plane mask.
                XCB_IMAGE_FORMAT_Z_PIXMAP,
                xcbid,
                0 // Byte offset.
            )
        };

        // Return!

        Ok(Capturer {
            display, shmid, xcbid, buffer,
            request, loading: 0, size
        })
    }

    pub fn display(&self) -> &Display {
        &self.display
    }

    pub fn frame<'b>(&'b mut self) -> &'b [u8] {
        // Get the return value.

        let result = unsafe {
            let off = self.loading & self.size;
            slice::from_raw_parts(
                self.buffer.offset(off as isize),
                self.size
            )
        };

        // Block for response.

        unsafe {
            self.handle_response();
        }

        // Start next request.

        let rect = self.display.rect();

        self.loading ^= !0;
        self.request = unsafe {
            xcb_shm_get_image_unchecked(
                self.display.server().raw(),
                self.display.root(),
                rect.x, rect.y,
                rect.w, rect.h,
                !0,
                XCB_IMAGE_FORMAT_Z_PIXMAP,
                self.xcbid,
                (self.loading & self.size) as u32
            )
        };

        // Return!

        result
    }

    unsafe fn handle_response(&self) {
        let response = xcb_shm_get_image_reply(
            self.display.server().raw(),
            self.request,
            ptr::null_mut()
        );

        libc::free(response as *mut _);
    }
}

impl Drop for Capturer {
    fn drop(&mut self) {
        unsafe {
            // Process pending request.
            self.handle_response();
            // Detach segment from XCB.
            xcb_shm_detach(self.display.server().raw(), self.xcbid);
            // Detach segment from our space.
            libc::shmdt(self.buffer as *mut _);
            // Destroy the shared memory segment.
            libc::shmctl(self.shmid, libc::IPC_RMID, ptr::null_mut());
        }
    }
}
