//! Windows: finds the output a call plays to when it is not the default
//! ([`CallOutputWatch`], the rule is `crate::call_output::choose`) and loops
//! back that one output ([`EndpointLoopback`]). The default output keeps its
//! own capture; nothing here runs on it.

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};

use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE, S_OK},
        Media::Audio::{
            AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            AudioSessionStateActive, DEVICE_STATE_ACTIVE, EDataFlow,
            Endpoints::IAudioMeterInformation, IAudioCaptureClient, IAudioClient,
            IAudioSessionControl2, IAudioSessionManager2, IMMDevice, IMMDeviceEnumerator,
            MMDeviceEnumerator, WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVEFORMATEXTENSIBLE_0,
            eCapture, eConsole, eRender,
        },
        System::{
            Com::{
                CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
                CoUninitialize,
            },
            Threading::{CreateEventW, WaitForSingleObject},
        },
    },
    core::{Interface, PCWSTR},
};

use crate::call_output::{Chooser, Followed, Meant, Session, followed, meant_audible};

pub(crate) struct ComGuard(bool);

impl ComGuard {
    /// As [`ComGuard::init`], also giving what CoInitializeEx answered.
    pub(crate) fn init_reporting() -> (Self, windows::core::HRESULT) {
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        (Self(result.is_ok()), result)
    }

    pub(crate) fn init() -> Self {
        Self(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn device_id(device: &IMMDevice) -> Option<String> {
    let id = unsafe { device.GetId() }.ok()?;
    let text = unsafe { id.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(id.0 as *const _)) };
    text
}

fn active_endpoints(enumerator: &IMMDeviceEnumerator, flow: EDataFlow) -> Vec<(String, IMMDevice)> {
    let Ok(list) = (unsafe { enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) }) else {
        return Vec::new();
    };
    let count = unsafe { list.GetCount() }.unwrap_or(0);
    (0..count)
        .filter_map(|i| unsafe { list.Item(i) }.ok())
        .filter_map(|device| Some((device_id(&device)?, device)))
        .collect()
}

/// A session is heard when its peak is above this (about -60 dBFS): a
/// silent stream kept open plays exact zeros.
const AUDIBLE_PEAK: f32 = 0.001;

/// For how many looks a session counts as heard after its last sound. The
/// peak is read at each look, so pauses between words are bridged.
const HEARD_LOOKS: u64 = 3;

/// The audio sessions of every endpoint looked at, by endpoint id. A
/// session manager is kept for as long as its endpoint is there.
#[derive(Default)]
struct Managers {
    managers: HashMap<String, IAudioSessionManager2>,
    /// The look a playing session (endpoint, process) was last heard in.
    heard: HashMap<(String, u32), u64>,
    looks: u64,
}

impl Managers {
    /// Starts a look: sessions not heard for a while are forgotten.
    fn next_look(&mut self) {
        self.looks += 1;
        let now = self.looks;
        self.heard.retain(|_, at| now - *at < HEARD_LOOKS);
    }

    /// The sessions of one endpoint. `meter`: whether to read how loud
    /// they are (playing sessions; a recording session's level is not used).
    fn sessions(&mut self, id: &str, device: &IMMDevice, meter: bool, out: &mut Vec<Session>) {
        let manager = match self.managers.get(id) {
            Some(manager) => manager.clone(),
            None => {
                let Ok(manager) =
                    (unsafe { device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) })
                else {
                    return;
                };
                self.managers.insert(id.to_string(), manager.clone());
                manager
            }
        };
        let Ok(list) = (unsafe { manager.GetSessionEnumerator() }) else {
            // The endpoint went away under its manager: ask again next time.
            self.managers.remove(id);
            return;
        };
        let count = unsafe { list.GetCount() }.unwrap_or(0);
        for i in 0..count {
            let Ok(control) = (unsafe { list.GetSession(i) }) else {
                continue;
            };
            let Ok(control) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };
            if unsafe { control.IsSystemSoundsSession() } == S_OK {
                continue;
            }
            // A session shared by several processes has no one process.
            let Ok(pid) = (unsafe { control.GetProcessId() }) else {
                continue;
            };
            let active = unsafe { control.GetState() }.is_ok_and(|s| s == AudioSessionStateActive);
            let key = (id.to_string(), pid);
            if meter
                && active
                && control
                    .cast::<IAudioMeterInformation>()
                    .and_then(|m| unsafe { m.GetPeakValue() })
                    .is_ok_and(|peak| peak > AUDIBLE_PEAK)
            {
                self.heard.insert(key.clone(), self.looks);
            }
            let heard = meter && self.heard.contains_key(&key);
            out.push(Session {
                endpoint: key.0,
                pid,
                active,
                heard,
            });
        }
    }

    fn keep_only(&mut self, ids: &[&str]) {
        self.managers.retain(|id, _| ids.contains(&id.as_str()));
    }
}

/// One look: the output a call plays to, or `None` for the default output,
/// and what plays there. Cheap unless another program is playing to an
/// output other than the default: only then are the microphone's users and
/// the process list read.
fn look(
    enumerator: &IMMDeviceEnumerator,
    managers: &mut Managers,
    chooser: &mut Chooser,
) -> (Option<String>, Option<Followed>) {
    managers.next_look();
    let outputs = active_endpoints(enumerator, eRender);
    let ids: Vec<&str> = outputs.iter().map(|(id, _)| id.as_str()).collect();
    managers.keep_only(&ids);
    if outputs.len() < 2 {
        chooser.reset();
        return (None, None);
    }
    let default = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .ok()
        .and_then(|device| device_id(&device));
    let ours = std::process::id();
    let mut playing = Vec::new();
    for (id, device) in outputs
        .iter()
        .filter(|(id, _)| Some(id) != default.as_ref())
    {
        managers.sessions(id, device, true, &mut playing);
    }
    let elsewhere = |s: &Session| s.active && s.pid != 0 && s.pid != ours;
    if !playing.iter().any(elsewhere) {
        chooser.reset();
        return (None, None);
    }
    if let Some((id, device)) = outputs.iter().find(|(id, _)| Some(id) == default.as_ref()) {
        managers.sessions(id, device, true, &mut playing);
    }
    let mut recording = Vec::new();
    for (id, device) in active_endpoints(enumerator, eCapture) {
        managers.sessions(&id, &device, false, &mut recording);
    }
    // Only when a program plays but does not itself record is the process
    // tree needed (a call app's helper playing for it).
    let helpers = playing
        .iter()
        .filter(|s| elsewhere(s))
        .any(|s| !recording.iter().any(|r| r.active && r.pid == s.pid));
    let procs = if helpers {
        super::procs::tree()
    } else {
        HashMap::new()
    };
    let choice = chooser.choose(default.as_deref(), &playing, &recording, &procs, ours);
    // What plays on the output read: the followed one, or the default.
    let there = choice
        .as_deref()
        .or(default.as_deref())
        .map(|id| followed(id, &playing, &recording, &procs, ours));
    (choice, there)
}

/// Looks for the output a call plays to every `every`, on its own thread,
/// and sends each change (`None`: the default output), or that output again
/// when what plays there changes. The first look is sent at once.
pub struct CallOutputWatch {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    followed: Arc<std::sync::Mutex<Option<Followed>>>,
    meter: Arc<std::sync::Mutex<Option<Meant>>>,
    audible: Arc<AtomicU64>,
}

/// Whether the sessions `meant` reads are heard in this look, on any output.
fn audible(enumerator: &IMMDeviceEnumerator, managers: &mut Managers, meant: Meant) -> bool {
    let mut sessions = Vec::new();
    for (id, device) in active_endpoints(enumerator, eRender) {
        managers.sessions(&id, &device, true, &mut sessions);
    }
    let ours = std::process::id();
    let look = managers.looks;
    let heard: Vec<u32> = sessions
        .iter()
        .filter(|s| {
            s.pid != 0
                && s.pid != ours
                && managers.heard.get(&(s.endpoint.clone(), s.pid)) == Some(&look)
        })
        .map(|s| s.pid)
        .collect();
    meant_audible(&heard, meant, super::procs::tree)
}

impl CallOutputWatch {
    pub fn start(every: Duration, changes: flume::Sender<Option<String>>) -> std::io::Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let there = Arc::new(std::sync::Mutex::new(None));
        let meter = Arc::new(std::sync::Mutex::new(None));
        let audible_looks = Arc::new(AtomicU64::new(0));
        let thread = std::thread::Builder::new()
            .name("cap-meeting-call-output".into())
            .spawn({
                let stop = stop.clone();
                let there = there.clone();
                let meter = meter.clone();
                let audible_looks = audible_looks.clone();
                move || {
                    let _com = ComGuard::init();
                    let enumerator: windows::core::Result<IMMDeviceEnumerator> =
                        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) };
                    let Ok(enumerator) = enumerator else {
                        let _ = changes.send(None);
                        return;
                    };
                    let mut managers = Managers::default();
                    let mut chooser = Chooser::default();
                    let mut last: Option<Option<String>> = None;
                    let mut last_seen: Option<Option<Followed>> = None;
                    while !stop.load(Ordering::Acquire) {
                        let (now, seen) = look(&enumerator, &mut managers, &mut chooser);
                        // What plays there changing is sent too (the same
                        // output again), so the reader acts on it at once.
                        let moved = last_seen.as_ref() != Some(&seen);
                        if let Ok(mut slot) = there.lock() {
                            *slot = seen.clone();
                        }
                        last_seen = Some(seen);
                        let meant = meter.lock().ok().and_then(|meant| *meant);
                        if let Some(meant) = meant
                            && audible(&enumerator, &mut managers, meant)
                        {
                            audible_looks.fetch_add(1, Ordering::Relaxed);
                        }
                        if last.as_ref() != Some(&now) || moved {
                            if changes.send(now.clone()).is_err() {
                                return;
                            }
                            last = Some(now);
                        }
                        std::thread::park_timeout(every);
                    }
                }
            })?;
        Ok(Self {
            stop,
            thread: Some(thread),
            followed: there,
            meter,
            audible: audible_looks,
        })
    }

    /// What plays on the followed output, as the latest look saw it.
    pub fn followed(&self) -> Arc<std::sync::Mutex<Option<Followed>>> {
        self.followed.clone()
    }

    /// What a running process loopback reads (`None`: none runs). While set,
    /// each look counts whether any of it was heard ([`Self::audible_looks`]).
    pub fn meter(&self) -> Arc<std::sync::Mutex<Option<Meant>>> {
        self.meter.clone()
    }

    /// How many looks heard what [`Self::meter`] names, so far.
    pub fn audible_looks(&self) -> Arc<AtomicU64> {
        self.audible.clone()
    }
}

impl Drop for CallOutputWatch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.thread().unpark();
            let _ = thread.join();
        }
    }
}

/// What the loopback asks for (the audio engine converts): 48 kHz float stereo.
const RATE: u32 = 48_000;
const CHANNELS: u16 = 2;

pub(crate) fn wanted_format() -> WAVEFORMATEXTENSIBLE {
    WAVEFORMATEXTENSIBLE {
        Format: WAVEFORMATEX {
            wFormatTag: 0xFFFE, // WAVE_FORMAT_EXTENSIBLE
            nChannels: CHANNELS,
            nSamplesPerSec: RATE,
            nAvgBytesPerSec: RATE * u32::from(CHANNELS) * 4,
            nBlockAlign: CHANNELS * 4,
            wBitsPerSample: 32,
            cbSize: 22,
        },
        Samples: WAVEFORMATEXTENSIBLE_0 {
            wValidBitsPerSample: 32,
        },
        dwChannelMask: 0x3, // front left and right
        SubFormat: FLOAT,
    }
}

// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
const FLOAT: windows::core::GUID =
    windows::core::GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

/// Whether a format is 32-bit float, the only one read here.
fn is_float32(format: &WAVEFORMATEX) -> bool {
    let tag = format.wFormatTag;
    let bits = format.wBitsPerSample;
    if bits != 32 {
        return false;
    }
    match tag {
        3 => true, // WAVE_FORMAT_IEEE_FLOAT
        0xFFFE if format.cbSize >= 22 => {
            let ext = unsafe { &*(format as *const WAVEFORMATEX as *const WAVEFORMATEXTENSIBLE) };
            let sub = ext.SubFormat;
            sub == FLOAT
        }
        _ => false,
    }
}

pub(crate) struct Stream {
    pub(crate) client: IAudioClient,
    pub(crate) capture: IAudioCaptureClient,
    pub(crate) event: HANDLE,
    pub(crate) channels: usize,
    pub(crate) rate: u32,
}

impl Drop for Stream {
    fn drop(&mut self) {
        let _ = unsafe { self.client.Stop() };
        if !self.event.is_invalid() {
            let _ = unsafe { CloseHandle(self.event) };
        }
    }
}

fn open(id: &str) -> Result<Stream, String> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| e.to_string())?;
    let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
    let device =
        unsafe { enumerator.GetDevice(PCWSTR(wide.as_ptr())) }.map_err(|e| e.to_string())?;
    let make =
        || unsafe { device.Activate::<IAudioClient>(CLSCTX_ALL, None) }.map_err(|e| e.to_string());
    let flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
    let wanted = wanted_format();
    let mut client = make()?;
    let converted = unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            flags | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            1_000_000,
            0,
            &wanted as *const WAVEFORMATEXTENSIBLE as *const WAVEFORMATEX,
            None,
        )
    };
    let (channels, rate) = match converted {
        Ok(()) => (usize::from(CHANNELS), RATE),
        Err(error) => {
            // A client whose Initialize failed is never initialised again:
            // a new one takes the output's own format.
            tracing::debug!(%error, "loopback refused conversion; reading the output's own format");
            client = make()?;
            let mix = unsafe { client.GetMixFormat() }.map_err(|e| e.to_string())?;
            let format = unsafe { &*mix };
            let usable = is_float32(format);
            let (channels, rate) = (usize::from(format.nChannels.max(1)), format.nSamplesPerSec);
            let started = usable.then(|| unsafe {
                client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 1_000_000, 0, mix, None)
            });
            unsafe { CoTaskMemFree(Some(mix as *const _)) };
            match started {
                Some(Ok(())) => (channels, rate),
                Some(Err(error)) => return Err(error.to_string()),
                None => return Err("the output's format is not float".into()),
            }
        }
    };
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
            channels,
            rate,
        }),
        Err(error) => {
            let _ = unsafe { CloseHandle(event) };
            Err(error)
        }
    }
}

/// A sample as captured, or silence if it is not a number (a device can
/// hand over a packet of garbage as it starts).
fn finite(sample: f32) -> f32 {
    if sample.is_finite() { sample } else { 0.0 }
}

/// Downmixes everything waiting into `mono`. False when nothing was waiting.
pub(crate) fn drain(stream: &Stream, mono: &mut Vec<f32>) -> windows::core::Result<bool> {
    let mut got = false;
    loop {
        let frames = unsafe { stream.capture.GetNextPacketSize() }?;
        if frames == 0 {
            return Ok(got);
        }
        let mut data = std::ptr::null_mut();
        let mut count = 0u32;
        let mut flags = 0u32;
        unsafe {
            stream
                .capture
                .GetBuffer(&mut data, &mut count, &mut flags, None, None)
        }?;
        let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
        if silent || data.is_null() {
            mono.extend(std::iter::repeat_n(0.0, count as usize));
        } else {
            let samples = unsafe {
                std::slice::from_raw_parts(data as *const f32, count as usize * stream.channels)
            };
            let scale = 1.0 / stream.channels as f32;
            mono.extend(
                samples
                    .chunks_exact(stream.channels)
                    .map(|frame| finite(frame.iter().sum::<f32>() * scale)),
            );
        }
        unsafe { stream.capture.ReleaseBuffer(count) }?;
        got = true;
    }
}

/// Loops back one output, by endpoint id. Mono float chunks go to the sink
/// with their sample rate. When the output fails (unplugged, taken over),
/// `failed` is set and the loopback ends; the owner decides what is next.
pub struct EndpointLoopback {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl EndpointLoopback {
    pub fn start(
        id: String,
        mut sink: impl FnMut(&[f32], u32) + Send + 'static,
        failed: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = flume::bounded::<Result<(), String>>(1);
        let thread = std::thread::Builder::new()
            .name("cap-meeting-call-loopback".into())
            .spawn({
                let stop = stop.clone();
                move || {
                    let _com = ComGuard::init();
                    let stream = match open(&id) {
                        Ok(stream) => {
                            let _ = ready_tx.send(Ok(()));
                            stream
                        }
                        Err(error) => {
                            let _ = ready_tx.send(Err(error));
                            return;
                        }
                    };
                    let mut mono = Vec::with_capacity(stream.rate as usize / 10);
                    while !stop.load(Ordering::Acquire) {
                        // The buffer holds 100 ms; the wait is short in case
                        // the event is not signalled for a loopback stream.
                        unsafe { WaitForSingleObject(stream.event, 20) };
                        mono.clear();
                        match drain(&stream, &mut mono) {
                            Ok(_) if !mono.is_empty() => sink(&mono, stream.rate),
                            Ok(_) => {}
                            Err(error) => {
                                tracing::warn!(%error, "the call's output stopped");
                                failed.store(true, Ordering::Release);
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(())) => Ok(Self {
                stop,
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                stop.store(true, Ordering::Release);
                Err("the call's output did not open in time".into())
            }
        }
    }
}

impl Drop for EndpointLoopback {
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

    #[test]
    fn the_wanted_format_is_48k_float_stereo_extensible() {
        let format = wanted_format();
        let base = format.Format;
        assert_eq!({ base.wFormatTag }, 0xFFFE);
        assert_eq!(
            { base.cbSize } as usize,
            size_of::<WAVEFORMATEXTENSIBLE>() - size_of::<WAVEFORMATEX>()
        );
        assert_eq!({ base.nBlockAlign }, 8);
        assert_eq!({ base.nAvgBytesPerSec }, 48_000 * 8);
        assert!(is_float32(&format.Format));
        let pcm = WAVEFORMATEX {
            wFormatTag: 1,
            wBitsPerSample: 16,
            ..format.Format
        };
        assert!(!is_float32(&pcm));
    }

    #[test]
    fn only_samples_that_are_not_numbers_are_replaced() {
        for x in [
            0.0f32,
            -0.0,
            0.5,
            -1.0,
            1.5,
            f32::MAX,
            f32::MIN,
            f32::EPSILON,
        ] {
            assert_eq!(finite(x).to_bits(), x.to_bits());
        }
        assert_eq!(finite(f32::NAN), 0.0);
        assert_eq!(finite(f32::INFINITY), 0.0);
    }

    /// Runs on any Windows machine: a look never fails and never picks an
    /// output with nothing playing.
    #[test]
    fn a_look_on_this_machine_answers() {
        let _com = ComGuard::init();
        let enumerator: windows::core::Result<IMMDeviceEnumerator> =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) };
        let Ok(enumerator) = enumerator else {
            return;
        };
        let mut managers = Managers::default();
        let mut chooser = Chooser::default();
        let _ = look(&enumerator, &mut managers, &mut chooser);
        let _ = look(&enumerator, &mut managers, &mut chooser);
    }
}
