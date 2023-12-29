use quartz;
use std::{io, ops, mem};
use std::marker::PhantomData;
use std::sync::{Arc, Mutex, TryLockError};

pub struct Capturer {
    inner: quartz::Capturer,
    frame: Arc<Mutex<Option<quartz::Frame>>>
}

impl Capturer {
    pub fn new(display: Display) -> io::Result<Capturer> {
        let frame = Arc::new(Mutex::new(None));

        let f = frame.clone();
        let inner = quartz::Capturer::new(
            display.0,
            display.width(),
            display.height(),
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

    pub fn frame<'a>(&'a mut self) -> io::Result<Frame<'a>> {
        match self.frame.try_lock() {
            Ok(mut handle) => {
                let mut frame = None;
                mem::swap(&mut frame, &mut handle);

                match frame {
                    Some(frame) =>
                        Ok(Frame(frame, PhantomData)),

                    None =>
                        Err(io::ErrorKind::WouldBlock.into())
                }
            }

            Err(TryLockError::WouldBlock) =>
                Err(io::ErrorKind::WouldBlock.into()),

            Err(TryLockError::Poisoned(..)) =>
                Err(io::ErrorKind::Other.into())
        }
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
}
