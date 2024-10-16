use flume::{Receiver, Sender, TryRecvError};
use indexmap::IndexMap;

use crate::pipeline::MediaError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Play,
    Pause,
    Shutdown,
}

pub struct PipelineControlSignal {
    last_value: Option<Control>,
    receiver: Receiver<Control>,
}

impl PipelineControlSignal {
    pub fn last(&mut self) -> Option<Control> {
        match self.last_value {
            Some(Control::Play) => {
                // Only peek for a new signal, else relinquish control to the caller
                match self.receiver.try_recv() {
                    Ok(control) => {
                        println!("Received new signal: {control:?}");
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
                self.blocking_last()
            }
        }
    }

    pub fn blocking_last(&mut self) -> Option<Control> {
        println!("Waiting for play signal...");
        self.last_value = self.receiver.recv().ok();

        self.last_value
    }
}

/// An extremely naive broadcast channel. Sends values synchronously to all receivers,
/// might block if one receiver takes too long to receive value.
#[derive(Debug, Default)]
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

    pub async fn broadcast(&mut self, value: Control) -> Result<(), MediaError> {
        let mut any_dropped = false;

        if self.listeners.is_empty() {
            eprintln!("Attempting to broadcast value without any listeners");
        }

        for (name, listener) in self.listeners.iter() {
            println!("Sending signal {value:?} to {name}");
            if let Err(_) = listener.send_async(value).await {
                eprintln!("{name} is unreachable!");
                any_dropped = true;
            }
        }

        match any_dropped {
            false => Ok(()),
            true => Err(MediaError::Any(
                "Attempted to broadcast value to a listener that has been dropped. Pipeline execution may be compromised.",
            )),
        }
    }
}
