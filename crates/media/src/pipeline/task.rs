use flume::{Receiver, Sender};

use crate::pipeline::{MediaError, PipelineControlSignal};

const DEFAULT_QUEUE_SIZE: usize = 2048;

pub type PipelineReadySignal = Sender<Result<(), MediaError>>;

pub trait PipelineSourceTask: Send {
    type Output;
    type Clock;

    fn run(
        &mut self,
        clock: Self::Clock,
        ready_signal: PipelineReadySignal,
        control_signal: PipelineControlSignal,
        output: Sender<Self::Output>,
    );

    fn queue_size(&self) -> usize {
        DEFAULT_QUEUE_SIZE
    }
}

pub trait PipelinePipeTask: Send {
    type Input;
    type Output;

    fn run(
        &mut self,
        ready_signal: PipelineReadySignal,
        input: Receiver<Self::Input>,
        output: Sender<Self::Output>,
    );

    fn queue_size(&self) -> usize {
        DEFAULT_QUEUE_SIZE
    }
}

pub trait PipelineSinkTask: Send {
    type Input;

    fn run(&mut self, ready_signal: PipelineReadySignal, input: &Receiver<Self::Input>);

    fn finish(&mut self);
}
