use ffmpeg::{format, frame};

pub trait AudioEncoder {
    fn boxed(self) -> Box<dyn AudioEncoder + Send + 'static>
    where
        Self: Send + Sized + 'static,
    {
        Box::new(self)
    }

    fn send_frame(&mut self, frame: frame::Audio, output: &mut format::context::Output);
    fn flush(&mut self, output: &mut format::context::Output) -> Result<(), ffmpeg::Error>;
}
