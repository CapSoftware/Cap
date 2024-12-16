use indexmap::IndexMap;
use std::thread::JoinHandle;

pub mod audio_buffer;
pub mod builder;
pub mod clock;
pub mod control;
pub mod task;

use crate::MediaError;

use builder::PipelineBuilder;
pub use clock::*;
use control::{Control, ControlBroadcast, PipelineControlSignal};

pub struct Pipeline<T: PipelineClock> {
    clock: T,
    control: ControlBroadcast,
    task_handles: IndexMap<String, JoinHandle<()>>,
    is_shutdown: bool,
}

impl<T: PipelineClock> Pipeline<T> {
    pub fn builder(clock: T) -> PipelineBuilder<T> {
        PipelineBuilder::new(clock)
    }

    pub async fn play(&mut self) -> Result<(), MediaError> {
        if self.is_shutdown {
            return Err(MediaError::ShutdownPipeline);
        };

        println!("Starting pipeline execution");
        self.clock.start();
        self.control.broadcast(Control::Play).await
    }

    pub async fn pause(&mut self) -> Result<(), MediaError> {
        if self.is_shutdown {
            return Err(MediaError::ShutdownPipeline);
        };

        println!("Pausing pipeline execution");
        self.clock.stop();
        self.control.broadcast(Control::Pause).await
    }

    pub async fn shutdown(&mut self) -> Result<(), MediaError> {
        if self.is_shutdown {
            return Err(MediaError::ShutdownPipeline);
        };

        println!("Shutting down pipeline execution");
        let _ = self.control.broadcast(Control::Shutdown).await;
        for (_name, task) in self.task_handles.drain(..) {
            let _ = task.join();
        }
        println!("Pipeline has been stopped.");
        // TODO: Collect shutdown errors?
        Ok(())
    }
}
