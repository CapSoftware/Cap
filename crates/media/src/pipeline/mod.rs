use indexmap::IndexMap;
use std::thread::JoinHandle;

pub mod builder;
pub mod clock;
pub mod control;
pub mod task;

use crate::MediaError;

use builder::PipelineBuilder;
use clock::PipelineClock;
use control::{Control, ControlBroadcast, PipelineControlSignal};

pub struct Pipeline<T: PipelineClock> {
    clock: T,
    control: ControlBroadcast,
    task_handles: IndexMap<String, JoinHandle<()>>,
}

impl<T: PipelineClock> Pipeline<T> {
    pub fn builder(clock: T) -> PipelineBuilder<T> {
        PipelineBuilder::new(clock)
    }

    pub async fn play(&mut self) -> Result<(), MediaError> {
        tracing::info!("Starting pipeline execution");
        self.clock.start();
        self.control.broadcast(Control::Play).await
    }

    pub async fn pause(&mut self) -> Result<(), MediaError> {
        tracing::info!("Pausing pipeline execution");
        self.clock.stop();
        self.control.broadcast(Control::Pause).await
    }

    pub async fn shutdown(self) -> Result<(), MediaError> {
        tracing::info!("Shutting down pipeline execution");
        let Self {
            mut control,
            task_handles,
            ..
        } = self;

        let _ = control.broadcast(Control::Shutdown).await;
        for task in task_handles.into_values() {
            let _ = task.join();
        }
        tracing::info!("Pipeline has been stopped.");
        // TODO: Collect shutdown errors?
        Ok(())
    }
}
