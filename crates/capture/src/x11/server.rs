use std::ptr;
use std::rc::Rc;
use super::DisplayIter;
use super::ffi::*;

#[derive(Debug)]
pub struct Server {
    raw: *mut xcb_connection_t,
    screenp: i32,
    setup: *const xcb_setup_t
}

impl Server {
    pub fn displays(slf: Rc<Server>) -> DisplayIter {
        unsafe {
            DisplayIter::new(slf)
        }
    }

    pub fn default() -> Result<Server, Error> {
        Server::connect(ptr::null())
    }

    pub fn connect(addr: *const i8) -> Result<Server, Error> {
        unsafe {
            let mut screenp = 0;
            let raw = xcb_connect(addr, &mut screenp);

            let error = xcb_connection_has_error(raw);
            if error != 0 {
                xcb_disconnect(raw);
                Err(Error::from(error))
            } else {
                let setup = xcb_get_setup(raw);
                Ok(Server { raw, screenp, setup })
            }
        }
    }

    pub fn raw(&self) -> *mut xcb_connection_t { self.raw }
    pub fn screenp(&self) -> i32 { self.screenp }
    pub fn setup(&self) -> *const xcb_setup_t { self.setup }
}

impl Drop for Server {
    fn drop(&mut self) {
        unsafe {
            xcb_disconnect(self.raw);
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Error {
    Generic,
    UnsupportedExtension,
    InsufficientMemory,
    RequestTooLong,
    ParseError,
    InvalidScreen
}

impl From<i32> for Error {
    fn from(x: i32) -> Error {
        use self::Error::*;
        match x {
            2 => UnsupportedExtension,
            3 => InsufficientMemory,
            4 => RequestTooLong,
            5 => ParseError,
            6 => InvalidScreen,
            _ => Generic
        }
    }
}
