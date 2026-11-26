//! Windows: while a screen reader runs, the meeting reads what the computer
//! plays through process loopback with the reader's process tree left out,
//! so its speech never reaches the meeting's computer audio
//! ([`ReaderFreeLoopback`]). Nothing here runs while no reader does.

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};

use windows::{
    Win32::{
        Media::Audio::{
            AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
            AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
            AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
            ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
            IActivateAudioInterfaceCompletionHandler,
            IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
            PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
        },
        System::{
            Com::{BLOB, StructuredStorage::PROPVARIANT},
            Threading::{CreateEventW, WaitForSingleObject},
            Variant::VT_BLOB,
        },
    },
    core::{IUnknown, Interface, PCWSTR, implement},
};

use super::follow::{ComGuard, Stream, drain, wanted_format};

/// Screen readers whose speech never belongs in a meeting's computer audio,
/// by executable (lowercase): Narrator, NVDA and JAWS. Narrator and NVDA play
/// their speech from their own process (measured: the audio session belongs
/// to Narrator.exe, and to nvda.exe with its eSpeak NG voice); the loopback
/// leaves out the whole process tree, so a speech helper a reader starts is
/// left out too.
const READERS: &[&str] = &["narrator.exe", "nvda.exe", "jfw.exe"];

/// The process id of a running screen reader, if one runs.
pub fn running_reader() -> Option<u32> {
    let found = super::procs::processes_for(READERS);
    READERS.iter().find_map(|name| found.get(*name).copied())
}

/// Test builds only: `CAP_GPUI_TEST_READER_EXCLUDE_FAIL` makes every reader
/// loopback fail to open, to prove the fallback.
fn refused_for_test() -> bool {
    cfg!(debug_assertions) && std::env::var_os("CAP_GPUI_TEST_READER_EXCLUDE_FAIL").is_some()
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Activated(flume::Sender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(
        &self,
        _operation: windows::core::Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let _ = self.0.try_send(());
        Ok(())
    }
}

/// A loopback of everything the computer plays except `reader`'s process
/// tree, as 48 kHz float stereo.
fn open_excluding(reader: u32) -> Result<Stream, String> {
    if refused_for_test() {
        return Err("refused for the test".into());
    }
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: reader,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    // A blob that points at `params`, which outlives the activation. Never
    // dropped: PROPVARIANT's destructor would free the blob, which is ours.
    let mut activation = std::mem::ManuallyDrop::new(PROPVARIANT::default());
    unsafe {
        let inner = &mut *activation.Anonymous.Anonymous;
        inner.vt = VT_BLOB;
        inner.Anonymous.blob = BLOB {
            cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            pBlobData: &params as *const AUDIOCLIENT_ACTIVATION_PARAMS as *mut u8,
        };
    }
    let (done_tx, done_rx) = flume::bounded::<()>(1);
    let handler: IActivateAudioInterfaceCompletionHandler = Activated(done_tx).into();
    let operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&*activation),
            &handler,
        )
    }
    .map_err(|e| format!("activate: {e}"))?;
    done_rx
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| "the reader-free loopback did not activate in time".to_string())?;
    let mut result = windows::core::HRESULT(0);
    let mut activated: Option<IUnknown> = None;
    unsafe { operation.GetActivateResult(&mut result, &mut activated) }
        .map_err(|e| format!("activation result: {e}"))?;
    result.ok().map_err(|e| format!("activation: {e}"))?;
    let client: IAudioClient = activated
        .ok_or_else(|| "the reader-free loopback gave no client".to_string())?
        .cast()
        .map_err(|e| e.to_string())?;
    let wanted = wanted_format();
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK
                | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            200_000,
            0,
            &wanted as *const WAVEFORMATEXTENSIBLE as *const WAVEFORMATEX,
            None,
        )
    }
    .map_err(|e| format!("initialize: {e}"))?;
    let event =
        unsafe { CreateEventW(None, false, false, PCWSTR::null()) }.map_err(|e| e.to_string())?;
    let capture: Result<IAudioCaptureClient, String> = (|| {
        unsafe { client.SetEventHandle(event) }.map_err(|e| e.to_string())?;
        let capture: IAudioCaptureClient =
            unsafe { client.GetService() }.map_err(|e| e.to_string())?;
        unsafe { client.Start() }.map_err(|e| e.to_string())?;
        Ok(capture)
    })();
    match capture {
        Ok(capture) => Ok(Stream {
            client,
            capture,
            event,
            channels: usize::from(wanted.Format.nChannels),
            rate: wanted.Format.nSamplesPerSec,
        }),
        Err(error) => {
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(event) };
            Err(error)
        }
    }
}

/// Everything the computer plays except a screen reader's speech. Mono
/// float chunks go to the sink with their sample rate. When the stream
/// fails, `failed` is set and the loopback ends; the owner decides what is
/// next.
pub struct ReaderFreeLoopback {
    reader: u32,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ReaderFreeLoopback {
    /// Opens the loopback, trying a few times: its activation is
    /// occasionally refused at once and accepted a moment later.
    pub fn start(
        reader: u32,
        sink: impl FnMut(&[f32], u32) + Send + 'static,
        failed: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let sink = Arc::new(std::sync::Mutex::new(sink));
        let mut last = String::new();
        for attempt in 0..3 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(150));
            }
            let sink = sink.clone();
            match Self::open(
                reader,
                move |samples: &[f32], rate: u32| {
                    if let Ok(mut sink) = sink.lock() {
                        sink(samples, rate);
                    }
                },
                failed.clone(),
            ) {
                Ok(loopback) => return Ok(loopback),
                Err(error) => last = error,
            }
        }
        Err(last)
    }

    fn open(
        reader: u32,
        mut sink: impl FnMut(&[f32], u32) + Send + 'static,
        failed: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = flume::bounded::<Result<(), String>>(1);
        let thread = std::thread::Builder::new()
            .name("cap-meeting-reader-free-loopback".into())
            .spawn({
                let stop = stop.clone();
                move || {
                    // A thread of its own, in the multithreaded apartment,
                    // alive until the activation completes. What COM answered
                    // for it goes with any refusal.
                    let (_com, apartment) = ComGuard::init_reporting();
                    let stream = match open_excluding(reader) {
                        Ok(stream) => {
                            let _ = ready_tx.send(Ok(()));
                            stream
                        }
                        Err(error) => {
                            let _ = ready_tx.send(Err(format!(
                                "{error} (COM init on its thread: {apartment:?})"
                            )));
                            return;
                        }
                    };
                    let mut mono = Vec::with_capacity(stream.rate as usize / 10);
                    while !stop.load(Ordering::Acquire) {
                        unsafe { WaitForSingleObject(stream.event, 20) };
                        mono.clear();
                        match drain(&stream, &mut mono) {
                            Ok(_) if !mono.is_empty() => sink(&mono, stream.rate),
                            Ok(_) => {}
                            Err(error) => {
                                tracing::warn!(%error, "the reader-free loopback stopped");
                                failed.store(true, Ordering::Release);
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(Duration::from_secs(4)) {
            Ok(Ok(())) => Ok(Self {
                reader,
                stop,
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                stop.store(true, Ordering::Release);
                Err("the reader-free loopback did not open in time".into())
            }
        }
    }

    /// The screen reader this loopback leaves out.
    pub fn reader(&self) -> u32 {
        self.reader
    }
}

impl Drop for ReaderFreeLoopback {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    /// Runs on any Windows machine with an output: a reader-free loopback
    /// (leaving this test's own process out) opens, delivers and stops.
    #[test]
    fn a_reader_free_loopback_opens_and_stops() {
        let failed = Arc::new(AtomicBool::new(false));
        let frames = Arc::new(AtomicU64::new(0));
        let counted = frames.clone();
        match ReaderFreeLoopback::start(
            std::process::id(),
            move |samples, _| {
                counted.fetch_add(samples.len() as u64, Ordering::Relaxed);
            },
            failed.clone(),
        ) {
            Ok(loopback) => {
                std::thread::sleep(Duration::from_millis(500));
                drop(loopback);
                eprintln!(
                    "reader-free loopback delivered {} frames",
                    frames.load(Ordering::Relaxed)
                );
                assert!(!failed.load(Ordering::Relaxed));
            }
            Err(error) => eprintln!("reader-free loopback did not open: {error}"),
        }
    }
}
