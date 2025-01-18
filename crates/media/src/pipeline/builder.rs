use flume::Receiver;
use indexmap::IndexMap;
use std::thread::{self, JoinHandle};
use tracing::Instrument;

use crate::pipeline::{
    clock::CloneFrom,
    control::ControlBroadcast,
    task::{PipelinePipeTask, PipelineReadySignal, PipelineSinkTask, PipelineSourceTask},
    MediaError, Pipeline, PipelineClock,
};

struct Task {
    ready_signal: Receiver<Result<(), MediaError>>,
    join_handle: JoinHandle<()>,
}

pub struct PipelineBuilder<T> {
    clock: T,
    control: ControlBroadcast,
    tasks: IndexMap<String, Task>,
}

impl<T> PipelineBuilder<T> {
    pub fn new(clock: T) -> Self {
        Self {
            clock,
            control: ControlBroadcast::default(),
            tasks: IndexMap::new(),
        }
    }

    pub fn source<O: Send + 'static, C: CloneFrom<T> + Send + 'static>(
        mut self,
        name: impl Into<String>,
        mut task: impl PipelineSourceTask<Output = O, Clock = C> + 'static,
    ) -> PipelinePathBuilder<T, O> {
        let name = name.into();
        let (output, next_input) = flume::bounded(task.queue_size());
        let clock = C::clone_from(&self.clock);
        let control_signal = self.control.add_listener(name.clone());

        self.spawn_task(name, move |ready_signal| {
            task.run(clock, ready_signal, control_signal, output);
        });

        PipelinePathBuilder {
            pipeline: self,
            next_input,
        }
    }

    fn spawn_task(
        &mut self,
        name: String,
        launch: impl FnOnce(PipelineReadySignal) + Send + 'static,
    ) {
        if self.tasks.contains_key(&name) {
            panic!("A task with the name {name} has already been added to the pipeline");
        }

        let (ready_sender, ready_signal) = flume::bounded(1);

        let dispatcher = tracing::dispatcher::get_default(|d| d.clone());
        let span = tracing::error_span!("pipeline", task = &name);
        let join_handle = thread::spawn(move || {
            tracing::dispatcher::with_default(&dispatcher, || {
                span.in_scope(|| {
                    launch(ready_sender);
                })
            })
        });
        self.tasks.insert(
            name,
            Task {
                ready_signal,
                join_handle,
            },
        );
    }
}

impl<T: PipelineClock> PipelineBuilder<T> {
    pub async fn build(self) -> Result<Pipeline<T>, MediaError> {
        let Self {
            clock,
            control,
            tasks,
        } = self;

        if tasks.is_empty() {
            return Err(MediaError::EmptyPipeline);
        }

        let mut task_handles = IndexMap::new();

        // TODO: Shut down tasks if launch failed.
        for (name, task) in tasks.into_iter() {
            // TODO: Wait for these in parallel?
            task.ready_signal
                .recv_async()
                .await
                .map_err(|_| MediaError::TaskLaunch(name.clone()))??;

            task_handles.insert(name, task.join_handle);
        }

        Ok(Pipeline {
            clock,
            control,
            task_handles,
            is_shutdown: false,
        })
    }
}

pub struct PipelinePathBuilder<Clock, PreviousOutput: Send> {
    pipeline: PipelineBuilder<Clock>,
    next_input: Receiver<PreviousOutput>,
}

impl<Clock, PreviousOutput: Send + 'static> PipelinePathBuilder<Clock, PreviousOutput> {
    pub fn pipe<Output: Send + 'static>(
        self,
        name: impl Into<String>,
        mut task: impl PipelinePipeTask<Input = PreviousOutput, Output = Output> + 'static,
    ) -> PipelinePathBuilder<Clock, Output> {
        let Self {
            mut pipeline,
            next_input: input,
        } = self;

        let (output, next_input) = flume::bounded(task.queue_size());

        pipeline.spawn_task(name.into(), move |ready_signal| {
            task.run(ready_signal, input, output);
        });

        PipelinePathBuilder {
            pipeline,
            next_input,
        }
    }

    pub fn sink(
        self,
        name: impl Into<String>,
        mut task: impl PipelineSinkTask<Input = PreviousOutput> + 'static,
    ) -> PipelineBuilder<Clock> {
        let Self {
            mut pipeline,
            next_input: input,
        } = self;

        pipeline.spawn_task(name.into(), move |ready_signal| {
            task.run(ready_signal, input);
        });

        pipeline
    }
}
