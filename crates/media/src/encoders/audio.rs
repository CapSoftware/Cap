use ffmpeg::format;

use crate::data::FFAudio;

pub trait AudioEncoder {
    fn boxed(self) -> Box<dyn AudioEncoder + Send + 'static>
    where
        Self: Send + Sized + 'static,
    {
        Box::new(self)
    }

    fn queue_frame(&mut self, frame: FFAudio, output: &mut format::context::Output);
    fn finish(&mut self, output: &mut format::context::Output);
}
