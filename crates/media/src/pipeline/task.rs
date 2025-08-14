use flume::Sender;

use crate::pipeline::{MediaError, PipelineControlSignal};

const DEFAULT_QUEUE_SIZE: usize = 2048;

pub type PipelineReadySignal = Sender<Result<(), MediaError>>;

pub trait PipelineSourceTask: Send {
    type Clock;

    fn run(
        &mut self,
        ready_signal: PipelineReadySignal,
        control_signal: PipelineControlSignal,
    ) -> Result<(), String>;

    fn queue_size(&self) -> usize {
        DEFAULT_QUEUE_SIZE
    }
}
