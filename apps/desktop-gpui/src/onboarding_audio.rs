use std::{
    io::Cursor,
    sync::mpsc::{self, Receiver, Sender},
    thread::JoinHandle,
};

use gpui::{App, AssetSource, BackgroundExecutor};

enum Command {
    Mute(bool),
    Stop,
}

pub struct OnboardingAudio {
    sender: Sender<Command>,
    worker: Option<JoinHandle<()>>,
    executor: BackgroundExecutor,
}

impl OnboardingAudio {
    pub fn new(muted: bool, cx: &App) -> Self {
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("onboarding-audio".into())
            .spawn(move || {
                if let Err(error) = play(muted, receiver) {
                    tracing::debug!("onboarding audio unavailable: {error:#}");
                }
            })
            .map_err(|error| tracing::debug!("onboarding audio worker unavailable: {error}"))
            .ok();
        Self {
            sender,
            worker,
            executor: cx.background_executor().clone(),
        }
    }

    pub fn set_muted(&self, muted: bool) {
        let _ = self.sender.send(Command::Mute(muted));
    }
}

impl Drop for OnboardingAudio {
    fn drop(&mut self) {
        let _ = self.sender.send(Command::Stop);
        if let Some(worker) = self.worker.take() {
            self.executor
                .spawn(async move {
                    if worker.join().is_err() {
                        tracing::debug!("onboarding audio worker panicked");
                    }
                })
                .detach();
        }
    }
}

fn play(mut muted: bool, receiver: Receiver<Command>) -> anyhow::Result<()> {
    while let Ok(command) = receiver.try_recv() {
        match command {
            Command::Mute(value) => muted = value,
            Command::Stop => return Ok(()),
        }
    }
    while muted {
        match receiver.recv() {
            Ok(Command::Mute(value)) => muted = value,
            Ok(Command::Stop) | Err(_) => return Ok(()),
        }
    }
    let bytes = crate::assets::Assets
        .load("onboarding/music.mp3")?
        .ok_or_else(|| anyhow::anyhow!("missing onboarding music"))?;
    let (_stream, handle) = rodio::OutputStream::try_default()?;
    let sink = rodio::Sink::try_new(&handle)?;
    sink.pause();
    sink.append(rodio::Decoder::new(Cursor::new(bytes))?);
    while let Ok(command) = receiver.try_recv() {
        match command {
            Command::Mute(value) => muted = value,
            Command::Stop => return Ok(()),
        }
    }
    sink.set_volume(if muted { 0. } else { 1. });
    sink.play();
    while let Ok(command) = receiver.recv() {
        match command {
            Command::Mute(true) => sink.set_volume(0.),
            Command::Mute(false) => {
                sink.set_volume(1.);
                if sink.empty() {
                    let bytes = crate::assets::Assets
                        .load("onboarding/music.mp3")?
                        .ok_or_else(|| anyhow::anyhow!("missing onboarding music"))?;
                    sink.append(rodio::Decoder::new(Cursor::new(bytes))?);
                }
                sink.play();
            }
            Command::Stop => break,
        }
    }
    sink.stop();
    Ok(())
}
