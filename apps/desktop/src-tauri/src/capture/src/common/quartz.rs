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

