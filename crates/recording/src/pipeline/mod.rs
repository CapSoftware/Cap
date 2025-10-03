use indexmap::IndexMap;
use std::thread::JoinHandle;
use tracing::{info, trace};

pub mod audio_buffer;
pub mod builder;
pub mod control;
pub mod task;

use crate::MediaError;

use builder::PipelineBuilder;
use control::{Control, ControlBroadcast, PipelineControlSignal};

pub struct Pipeline {
    control: ControlBroadcast,
    task_handles: IndexMap<String, JoinHandle<()>>,
    is_shutdown: bool,
}

impl Pipeline {
    pub fn builder() -> PipelineBuilder {
        PipelineBuilder::default()
    }

    pub async fn play(&mut self) -> Result<(), MediaError> {
        if self.is_shutdown {
            return Err(MediaError::ShutdownPipeline);
        };

        self.control.broadcast(Control::Play).await;

        Ok(())
    }

    pub async fn shutdown(&mut self) -> Result<(), MediaError> {
        if self.is_shutdown {
            return Err(MediaError::ShutdownPipeline);
        };

        trace!("Shutting down pipeline");
        self.control.broadcast(Control::Shutdown).await;
        for (_name, task) in self.task_handles.drain(..) {
            let _ = task.join();
        }
        info!("Pipeline stopped");
        // TODO: Collect shutdown errors?
        Ok(())
    }
}
