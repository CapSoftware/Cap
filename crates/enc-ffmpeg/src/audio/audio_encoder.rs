use ffmpeg::{format, frame};

pub trait AudioEncoder {
    fn boxed(self) -> Box<dyn AudioEncoder + Send + 'static>
    where
        Self: Send + Sized + 'static,
    {
        Box::new(self)
    }

    fn queue_frame(&mut self, frame: frame::Audio, output: &mut format::context::Output);
    fn finish(&mut self, output: &mut format::context::Output);
}
