use crate::config::DisplayInputConfig;
use cap_media_info::VideoInfo;
use cap_recording::output_pipeline::{SetupCtx, VideoSource};
use anyhow::{Context, anyhow};
use futures::channel::mpsc;
use futures::future::BoxFuture;
use futures::FutureExt;
use std::sync::{
    Arc,
    atomic::{self, AtomicBool},
};


#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows::*;

pub struct Display {
    inner: PlatformVideoSource,
    capturer: Capturer,
}

impl VideoSource for Display {
    type Config = DisplayInputConfig;
    type Frame = VideoFrame;

    async fn setup(
        config: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let (video_source, capturer, mut error_rx) = setup_platform_capture(&config, video_tx).await?;

        ctx.tasks().spawn("display-capture-error", async move {
            if let Ok(err) = error_rx.recv().await {
                return Err(anyhow!("Capture error: {err}"));
            }
            Ok(())
        });

        Ok(Self {
            inner: video_source,
            capturer,
        })
    }

    fn video_info(&self) -> VideoInfo {
        self.inner.video_info()
    }

    fn start(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        async move {
            self.capturer.start().await?;
            Ok(())
        }
        .boxed()
    }

    fn stop(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        async move {
            self.capturer.stop().await?;
            Ok(())
        }
        .boxed()
    }
}

struct Capturer {
    started: Arc<AtomicBool>,
    inner: Arc<PlatformCapturer>,
}

impl Clone for Capturer {
    fn clone(&self) -> Self {
        Self {
            started: self.started.clone(),
            inner: self.inner.clone(),
        }
    }
}

impl Capturer {
    fn new(inner: Arc<PlatformCapturer>) -> Self {
        Self {
            started: Arc::new(AtomicBool::new(false)),
            inner,
        }
    }

    async fn start(&mut self) -> anyhow::Result<()> {
        if !self.started.fetch_xor(true, atomic::Ordering::Relaxed) {
            self.inner.start().await?;
        }
        Ok(())
    }

    async fn stop(&mut self) -> anyhow::Result<()> {
        if self.started.fetch_xor(true, atomic::Ordering::Relaxed) {
            self.inner.stop().await.context("capturer_stop")?;
        }
        Ok(())
    }
}
