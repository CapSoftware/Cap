use flume::Receiver;
use indexmap::IndexMap;
use std::{
    thread::{self, JoinHandle},
    time::Duration,
};
use tokio::sync::oneshot;
use tracing::{info, trace};

use crate::pipeline::{
    clock::CloneFrom,
    control::ControlBroadcast,
    task::{PipelinePipeTask, PipelineReadySignal, PipelineSinkTask, PipelineSourceTask},
    MediaError, Pipeline, PipelineClock,
};

struct Task {
    ready_signal: Receiver<Result<(), MediaError>>,
    join_handle: JoinHandle<()>,
    done_rx: tokio::sync::oneshot::Receiver<()>,
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

        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();

        let join_handle = thread::spawn(move || {
            tracing::dispatcher::with_default(&dispatcher, || {
                span.in_scope(|| {
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        launch(ready_sender);
                    }))
                    .ok();
                });
                done_tx.send(()).ok();
            });
        });

        self.tasks.insert(
            name,
            Task {
                ready_signal,
                join_handle,
                done_rx,
            },
        );
    }
}

impl<T: PipelineClock> PipelineBuilder<T> {
    pub async fn build(self) -> Result<(Pipeline<T>, oneshot::Receiver<()>), MediaError> {
        let Self {
            clock,
            control,
            tasks,
        } = self;

        if tasks.is_empty() {
            return Err(MediaError::EmptyPipeline);
        }

        let mut task_handles = IndexMap::new();

        let mut stop_rx = vec![];

        // TODO: Shut down tasks if launch failed.
        for (name, task) in tasks.into_iter() {
            // TODO: Wait for these in parallel?
            task.ready_signal
                .recv_async()
                .await
                .map_err(|_| MediaError::TaskLaunch(name.clone()))??;

            task_handles.insert(name, task.join_handle);
            stop_rx.push(task.done_rx);
        }

        tokio::time::sleep(Duration::from_millis(10)).await;

        let (done_tx, done_rx) = oneshot::channel::<()>();

        tokio::spawn({
            let mut control = control.clone();
            async move {
                futures::future::select_all(stop_rx).await.0.ok();
                control
                    .broadcast(super::control::Control::Shutdown)
                    .await
                    .ok();
                done_tx.send(()).ok();
            }
        });

        Ok((
            Pipeline {
                clock,
                control,
                task_handles,
                is_shutdown: false,
            },
            done_rx,
        ))
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
            trace!("Pipe starting");
            task.run(ready_signal, input, output);
            info!("Pipe stopped");
        });

        PipelinePathBuilder {
            pipeline,
            next_input,
        }
    }

    pub fn sink(
        self,
        name: impl Into<String>,
        mut task: impl PipelineSinkTask<PreviousOutput> + 'static,
    ) -> PipelineBuilder<Clock> {
        let Self {
            mut pipeline,
            next_input: input,
        } = self;

        pipeline.spawn_task(name.into(), move |ready_signal| {
            trace!("Sink starting");
            task.run(ready_signal, &input);
            info!("Sink stopped running");
            task.finish();
            info!("Sink stopped");
        });

        pipeline
    }
}
