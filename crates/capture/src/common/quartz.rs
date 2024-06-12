use quartz;
use std::{io, ops, mem};
use std::marker::PhantomData;
use std::sync::{Arc, Mutex, TryLockError};

pub struct Capturer {
    inner: quartz::Capturer,
    frame: Arc<Mutex<Option<quartz::Frame>>>
}

impl Capturer {
    pub fn new(display: Display, width: usize, height: usize) -> io::Result<Capturer> {
        let frame = Arc::new(Mutex::new(None));

        let f = frame.clone();
        let inner = quartz::Capturer::new(
            display.0,
            width,
            height,
            quartz::PixelFormat::Argb8888,
            Default::default(),
            move |inner| {
                if let Ok(mut f) = f.lock() {
                    *f = Some(inner);
                }
            }
        ).map_err(|_| io::Error::from(io::ErrorKind::Other))?;

        Ok(Capturer { inner, frame })
    }

    pub fn width(&self) -> usize {
        self.inner.width()
    }

    pub fn height(&self) -> usize {
        self.inner.height()
    }

    pub fn frame(&mut self) -> io::Result<Frame> {
        let mut handle = self.frame.try_lock().map_err(|e| match e {
            TryLockError::WouldBlock => io::ErrorKind::WouldBlock,
            TryLockError::Poisoned(_) => io::ErrorKind::Other,
        })?;
    
        handle.take().map(|frame| Frame(frame, PhantomData))
            .ok_or_else(|| io::ErrorKind::WouldBlock.into())
    }
}

pub struct Frame<'a>(
    quartz::Frame,
    PhantomData<&'a [u8]>
);

impl Frame <'_> {
    pub fn stride_override(&self) -> Option<usize> {
        // On Macs, CoreGraphics strives to ensure that pixel buffers (such as this framedata) are
        // aligned to squeeze the best performance out of the underlying hardware; in other words,
        // each row/scanline has to be cleanly divisible by a hardware-specific byte length so that
        // the buffer can be read in chunks without running into overlapping rows in a single chunk.
        // This behaviour is only referred to fairly obliquely in documentation - for instance on
        // [this page](https://developer.apple.com/library/archive/qa/qa1829/_index.html).
        //
        // This means that certain Mac configurations can end up with pixel buffers that contain
        // more bytes per row than would be expected from just the row width and the image format.
        // Thankfully, the Core Graphics API exposes methods for obtaining what the stride in use
        // actually is, so we can retrieve and use it here.

        Some(unsafe { self.0.bytes_per_row() })
    }
}

impl<'a> ops::Deref for Frame<'a> {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &*self.0
    }
}

pub struct Display(quartz::Display);

impl Display {
    pub fn primary() -> io::Result<Display> {
        Ok(Display(quartz::Display::primary()))
    }

    pub fn all() -> io::Result<Vec<Display>> {
        Ok(
            quartz::Display::online()
                .map_err(|_| io::Error::from(io::ErrorKind::Other))?
                .into_iter()
                .map(Display)
                .collect()
        )
    }

    pub fn width(&self) -> usize {
        self.0.width()
    }

    pub fn height(&self) -> usize {
        self.0.height()
    }

    pub fn bytes_per_row(&self) -> usize {
        self.0.bytes_per_row()
    }

    pub fn bits_per_pixel(&self) -> usize {
        self.0.bits_per_pixel()
    }

    pub fn bits_per_sample(&self) -> usize {
        self.0.bits_per_sample()
    }

    pub fn samples_per_pixel(&self) -> usize {
        self.0.samples_per_pixel()
    }
}

