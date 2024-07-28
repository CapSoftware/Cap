use super::ffi::*;
use std::mem;

#[derive(PartialEq, Eq, Debug, Clone, Copy)]
#[repr(C)]
pub struct Display(u32);

impl Display {
    pub fn primary() -> Display {
        Display(unsafe { CGMainDisplayID() })
    }

    pub fn online() -> Result<Vec<Display>, CGError> {
        unsafe {
            let mut arr: [u32; 16] = mem::uninitialized();
            let mut len: u32 = 0;

            match CGGetOnlineDisplayList(16, arr.as_mut_ptr(), &mut len) {
                CGError::Success => (),
                x => return Err(x)
            }

            let mut res = Vec::with_capacity(16);
            for i in 0..len as usize {
                res.push(Display(*arr.get_unchecked(i)));
            }
            Ok(res)
        }
    }

    pub fn id(self) -> u32 {
        self.0
    }

    pub fn width(self) -> usize {
        unsafe {
            let display_mode = CGDisplayCopyDisplayMode(self.0);
            CGDisplayModeGetPixelWidth(display_mode)
        }
    }

    pub fn height(self) -> usize {
        unsafe {
            let display_mode = CGDisplayCopyDisplayMode(self.0);
            CGDisplayModeGetPixelHeight(display_mode)
        }
    }

    pub fn bytes_per_row(self) -> usize {
        unsafe {
            CGDisplayBytesPerRow(self.0) as usize
        }
    }

    pub fn bits_per_pixel(self) -> usize {
        unsafe { CGDisplayBitsPerPixel(self.0) as usize }
    }

    pub fn bits_per_sample(self) -> usize {
        unsafe { CGDisplayBitsPerSample(self.0) as usize }
    }

    pub fn samples_per_pixel(self) -> usize {
        unsafe { CGDisplaySamplesPerPixel(self.0) as usize }
    }

    pub fn is_builtin(self) -> bool {
        unsafe { CGDisplayIsBuiltin(self.0) != 0 }
    }

    pub fn is_primary(self) -> bool {
        unsafe { CGDisplayIsMain(self.0) != 0 }
    }

    pub fn is_active(self) -> bool {
        unsafe { CGDisplayIsActive(self.0) != 0 }
    }

    pub fn is_online(self) -> bool {
        unsafe { CGDisplayIsOnline(self.0) != 0 }
    }
}

