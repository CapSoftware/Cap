use flume::{Receiver, Sender, TryRecvError};
use indexmap::IndexMap;
use tracing::debug;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Play,
    Shutdown,
}

pub struct PipelineControlSignal {
    pub last_value: Option<Control>,
    pub receiver: Receiver<Control>,
}

impl PipelineControlSignal {
    pub fn last(&mut self) -> Option<Control> {
        self.blocking_last_if(false)
    }

    pub fn blocking_last(&mut self) -> Option<Control> {
        self.blocking_last_if(true)
    }

    pub fn blocking_last_if(&mut self, should_block: bool) -> Option<Control> {
        match self.last_value {
            Some(Control::Play) if !should_block => {
                // Only peek for a new signal, else relinquish control to the caller
                match self.receiver.try_recv() {
                    Ok(control) => {
                        debug!("Received new signal: {control:?}");
                        self.last_value = Some(control)
                    }
                    Err(TryRecvError::Empty) => {}
                    Err(TryRecvError::Disconnected) => self.last_value = None,
                };

                self.last_value
            }
            _ => {
                // For all else, block until a signal is sent.
                // TODO: Maybe also spin down until the signal is different from the last value we have?
                self.last_value = self.receiver.recv().ok();

                self.last_value
            }
        }
    }
}

/// An extremely naive broadcast channel. Sends values synchronously to all receivers,
/// might block if one receiver takes too long to receive value.
#[derive(Debug, Default, Clone)]
pub(super) struct ControlBroadcast {
    listeners: IndexMap<String, Sender<Control>>,
}

impl ControlBroadcast {
    pub fn add_listener(&mut self, name: String) -> PipelineControlSignal {
        let (sender, receiver) = flume::bounded(1);
        self.listeners.insert(name, sender);
        PipelineControlSignal {
            last_value: None,
            receiver,
        }
    }

    pub async fn broadcast(&mut self, value: Control) {
        for (_, listener) in self.listeners.iter() {
            let _ = listener.send_async(value).await;
        }
    }
}
