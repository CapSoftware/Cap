//! Windows: what the computer plays, for a meeting with a separate
//! communications device.
//!
//! A common setup has the speakers as the default device and a headset as
//! the default communications device, and Teams and Zoom play to the
//! latter: looping back the default output alone recorded such a call as
//! silence. When the two defaults are different devices, both are looped
//! back and mixed sample by sample. With one device for both (most
//! computers) the meeting keeps its existing capture; see
//! [`separate_comms_output`].

use crate::mix_gate::MixGate;
use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        Media::Audio::{
            AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, ERole,
            IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
            WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVEFORMATEXTENSIBLE_0, eCommunications, eConsole,
            eRender,
        },
        System::{
            Com::{
                CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
                CoUninitialize,
            },
            Threading::{CreateEventW, WaitForSingleObject},
        },
    },
    core::PCWSTR,
};

/// What every leg is asked for (the audio engine converts): 48 kHz float stereo.
pub const LOOPBACK_RATE: u32 = 48_000;
const CHANNELS: usize = 2;
/// No packets this long (nothing plays) and the leg is filled with silence.
const IDLE_FILL: Duration = Duration::from_millis(100);
/// One leg running ahead of the other by more than this drops the excess
/// (two devices' clocks drift apart).
const MAX_SKEW: usize = (LOOPBACK_RATE / 5) as usize;
const DEVICE_CHECK: Duration = Duration::from_secs(2);

#[derive(Debug, Default)]
pub struct LoopbackCounters {
    pub callbacks: AtomicU64,
    pub restarts: AtomicU64,
}

/// Mono samples at [`LOOPBACK_RATE`]. While the outputs answer, a stretch
/// where nothing played arrives as silence: the capture is alive.
pub struct LoopbackChunk<'a> {
    pub samples: &'a [f32],
}

/// Whether the default communications output is another device than the
/// default output, the setup where a call can play where the default's
/// loopback does not hear it.
pub fn separate_comms_output() -> bool {
    let _com = ComGuard::init();
    let enumerator: windows::core::Result<IMMDeviceEnumerator> =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) };
    let Ok(enumerator) = enumerator else {
        return false;
    };
    default_ids(&enumerator).len() > 1
}

/// The default output's and the default communications output's ids (one
/// when they are the same device).
pub fn default_outputs() -> Vec<String> {
    let _com = ComGuard::init();
    let enumerator: windows::core::Result<IMMDeviceEnumerator> =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) };
    enumerator.map(|e| default_ids(&e)).unwrap_or_default()
}

pub struct SystemLoopback {
    stop: Arc<AtomicBool>,
    rebuild: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    counters: Arc<LoopbackCounters>,
}

impl SystemLoopback {
    /// Starts looping back the default and communications outputs. Fails
    /// only when no output can be opened at all.
    pub fn start(mut sink: impl FnMut(LoopbackChunk<'_>) + Send + 'static) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let rebuild = Arc::new(AtomicBool::new(false));
        let counters = Arc::new(LoopbackCounters::default());
        let (ready_tx, ready_rx) = flume::bounded::<Result<(), String>>(1);
        let thread = std::thread::Builder::new()
            .name("cap-meeting-loopback".into())
            .spawn({
                let (stop, rebuild, counters) = (stop.clone(), rebuild.clone(), counters.clone());
                move || {
                    let _com = ComGuard::init();
                    let mut ready = Some(ready_tx);
                    while !stop.load(Ordering::Acquire) {
                        match open() {
                            Ok(mut legs) => {
                                tracing::info!(devices = ?legs.ids, "meeting computer audio follows the default and communications outputs");
                                if let Some(ready) = ready.take() {
                                    let _ = ready.send(Ok(()));
                                }
                                rebuild.store(false, Ordering::Release);
                                if let Err(error) = run(&mut legs, &stop, &rebuild, &counters, &mut sink) {
                                    tracing::warn!(%error, "meeting computer audio capture stopped; opening it again");
                                }
                                legs.close();
                            }
                            Err(error) => {
                                if let Some(ready) = ready.take() {
                                    let _ = ready.send(Err(error.clone()));
                                    return;
                                }
                                tracing::warn!(%error, "meeting computer audio capture could not open again");
                            }
                        }
                        if stop.load(Ordering::Acquire) {
                            break;
                        }
                        counters.restarts.fetch_add(1, Ordering::Relaxed);
                        std::thread::park_timeout(Duration::from_secs(1));
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Ok(Ok(())) | Err(_) => Ok(Self {
                stop,
                rebuild,
                thread: Some(thread),
                counters,
            }),
        }
    }

    pub fn callbacks(&self) -> u64 {
        self.counters.callbacks.load(Ordering::Relaxed)
    }

    pub fn restarts(&self) -> u64 {
        self.counters.restarts.load(Ordering::Relaxed)
    }

    /// Opens the capture again (it stopped delivering).
    pub fn restart(&self) {
        self.rebuild.store(true, Ordering::Release);
    }
}

impl Drop for SystemLoopback {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.thread().unpark();
            let _ = thread.join();
        }
    }
}

struct ComGuard(bool);

impl ComGuard {
    fn init() -> Self {
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

struct Leg {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    fifo: VecDeque<f32>,
    last: Instant,
}

struct Legs {
    legs: Vec<Leg>,
    ids: Vec<String>,
    event: HANDLE,
    enumerator: IMMDeviceEnumerator,
    /// Two outputs carrying the same sound are kept once.
    gate: MixGate,
    /// What each output hands the mix, reused.
    pair: [Vec<f32>; 2],
}

impl Legs {
    fn close(&mut self) {
        if self.gate.switches() > 0 {
            tracing::info!(
                switches = self.gate.switches(),
                "meeting computer audio: times the outputs went between the same sound and different ones"
            );
        }
        for leg in &self.legs {
            let _ = unsafe { leg.client.Stop() };
        }
        self.legs.clear();
        if !self.event.is_invalid() {
            let _ = unsafe { CloseHandle(self.event) };
            self.event = HANDLE::default();
        }
    }
}

fn open() -> Result<Legs, String> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| e.to_string())?;
    let event =
        unsafe { CreateEventW(None, false, false, PCWSTR::null()) }.map_err(|e| e.to_string())?;
    let mut legs = Legs {
        legs: Vec::new(),
        ids: Vec::new(),
        event,
        enumerator,
        gate: MixGate::default(),
        pair: [
            Vec::with_capacity(LOOPBACK_RATE as usize / 10),
            Vec::with_capacity(LOOPBACK_RATE as usize / 10),
        ],
    };
    for role in [eConsole, eCommunications] {
        let Ok((_, id)) = device_client(&legs.enumerator, role) else {
            continue;
        };
        if legs.ids.contains(&id) {
            continue;
        }
        let enumerator = legs.enumerator.clone();
        let make = move || {
            device_client(&enumerator, role)
                .map(|(client, _)| client)
                .map_err(|e| e.to_string())
        };
        match start_leg(make, event) {
            Ok(leg) => {
                legs.legs.push(leg);
                legs.ids.push(id);
            }
            Err(error) => tracing::warn!(%error, ?role, "could not loop back an output"),
        }
    }
    if legs.legs.is_empty() {
        legs.close();
        return Err("no audio output device is available".into());
    }
    Ok(legs)
}

fn device_client(
    enumerator: &IMMDeviceEnumerator,
    role: ERole,
) -> windows::core::Result<(IAudioClient, String)> {
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, role) }?;
    let id = unsafe { device.GetId() }?;
    let name = unsafe { id.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(id.0 as *const _)) };
    let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }?;
    Ok((client, name))
}

fn default_ids(enumerator: &IMMDeviceEnumerator) -> Vec<String> {
    let mut ids = Vec::new();
    for role in [eConsole, eCommunications] {
        if let Ok(device) = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, role) }
            && let Ok(id) = unsafe { device.GetId() }
        {
            let name = unsafe { id.to_string() }.unwrap_or_default();
            unsafe { CoTaskMemFree(Some(id.0 as *const _)) };
            if !ids.contains(&name) {
                ids.push(name);
            }
        }
    }
    ids
}

/// 48 kHz float stereo, as the extensible format the audio engine converts
/// to without a question.
fn capture_format() -> WAVEFORMATEXTENSIBLE {
    WAVEFORMATEXTENSIBLE {
        Format: WAVEFORMATEX {
            wFormatTag: 0xFFFE, // WAVE_FORMAT_EXTENSIBLE
            nChannels: CHANNELS as u16,
            nSamplesPerSec: LOOPBACK_RATE,
            nAvgBytesPerSec: LOOPBACK_RATE * (CHANNELS as u32) * 4,
            nBlockAlign: (CHANNELS * 4) as u16,
            wBitsPerSample: 32,
            cbSize: 22,
        },
        Samples: WAVEFORMATEXTENSIBLE_0 {
            wValidBitsPerSample: 32,
        },
        dwChannelMask: 0x3, // front left and right
        // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
        SubFormat: windows::core::GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71),
    }
}

/// Opens a leg on a client from `make`. A client whose Initialize failed is
/// never initialised again: the second try, without conversion, gets a new
/// client.
fn start_leg(
    make: impl Fn() -> Result<IAudioClient, String>,
    event: HANDLE,
) -> Result<Leg, String> {
    let format = capture_format();
    let pformat = &format as *const WAVEFORMATEXTENSIBLE as *const WAVEFORMATEX;
    let flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
    let mut client = make()?;
    let converted = unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            flags | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            1_000_000,
            0,
            pformat,
            None,
        )
    };
    let converted_ok = converted.is_ok();
    if let Err(error) = converted {
        tracing::debug!(%error, "loopback refused conversion; asking a new client for the format as is");
        client = make()?;
        unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 1_000_000, 0, pformat, None) }
            .map_err(|e| e.to_string())?;
    }
    unsafe { client.SetEventHandle(event) }.map_err(|e| e.to_string())?;
    let capture: IAudioCaptureClient = unsafe { client.GetService() }.map_err(|e| e.to_string())?;
    unsafe { client.Start() }.map_err(|e| e.to_string())?;
    tracing::debug!(converted = converted_ok, "loopback leg started");
    Ok(Leg {
        client,
        capture,
        fifo: VecDeque::new(),
        last: Instant::now(),
    })
}

fn drain(leg: &mut Leg) -> windows::core::Result<bool> {
    let mut got = false;
    loop {
        let frames = unsafe { leg.capture.GetNextPacketSize() }?;
        if frames == 0 {
            return Ok(got);
        }
        let mut data = std::ptr::null_mut();
        let mut count = 0u32;
        let mut flags = 0u32;
        unsafe {
            leg.capture
                .GetBuffer(&mut data, &mut count, &mut flags, None, None)
        }?;
        let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
        if silent || data.is_null() {
            leg.fifo.extend(std::iter::repeat_n(0.0, count as usize));
        } else {
            let samples = unsafe {
                std::slice::from_raw_parts(data as *const f32, count as usize * CHANNELS)
            };
            leg.fifo.extend(
                samples
                    .chunks_exact(CHANNELS)
                    .map(|frame| frame.iter().sum::<f32>() / CHANNELS as f32)
                    // A device can hand over a packet of garbage (NaN, infinity)
                    // as it starts; it never reaches the recording. Every other
                    // sample is left exactly as it came.
                    .map(finite),
            );
        }
        unsafe { leg.capture.ReleaseBuffer(count) }?;
        got = true;
    }
}

/// A sample as captured, or silence if it is not a number.
pub(crate) fn finite(sample: f32) -> f32 {
    if sample.is_finite() { sample } else { 0.0 }
}

/// Mixes what the legs have in common and hands it on; a leg that ran
/// further ahead than [`MAX_SKEW`] loses its oldest excess. One output
/// passes through untouched; two are summed (clipped at full scale), or only
/// the louder kept while both carry the same sound ([`MixGate`]).
pub(crate) fn mix(
    fifos: &mut [&mut VecDeque<f32>],
    gate: &mut MixGate,
    pair: &mut [Vec<f32>; 2],
    out: &mut Vec<f32>,
) {
    out.clear();
    let Some(shortest) = fifos.iter().map(|f| f.len()).min() else {
        return;
    };
    if let [only] = fifos {
        out.extend(only.drain(..shortest));
        return;
    }
    for (fifo, taken) in fifos.iter_mut().zip(pair.iter_mut()) {
        taken.clear();
        taken.extend(fifo.drain(..shortest));
        if fifo.len() > MAX_SKEW {
            let excess = fifo.len() - MAX_SKEW;
            fifo.drain(..excess);
        }
    }
    gate.mix(&pair[0], &pair[1], out);
}

fn run(
    legs: &mut Legs,
    stop: &AtomicBool,
    rebuild: &AtomicBool,
    counters: &LoopbackCounters,
    sink: &mut impl FnMut(LoopbackChunk<'_>),
) -> Result<(), String> {
    let mut checked = Instant::now();
    let mut mixed = Vec::new();
    while !stop.load(Ordering::Acquire) {
        if rebuild.load(Ordering::Acquire) {
            return Err("asked to start again".into());
        }
        unsafe { WaitForSingleObject(legs.event, 10) };
        let now = Instant::now();
        for leg in legs.legs.iter_mut() {
            if drain(leg).map_err(|e| e.to_string())? {
                leg.last = now;
            } else if now.duration_since(leg.last) >= IDLE_FILL {
                let fill = (now.duration_since(leg.last).as_secs_f64() * f64::from(LOOPBACK_RATE))
                    as usize;
                leg.fifo.extend(std::iter::repeat_n(0.0, fill));
                leg.last = now;
            }
        }
        let Legs {
            legs: list,
            gate,
            pair,
            ..
        } = &mut *legs;
        match list.as_mut_slice() {
            [only] => mix(&mut [&mut only.fifo], gate, pair, &mut mixed),
            [first, second, ..] => mix(
                &mut [&mut first.fifo, &mut second.fifo],
                gate,
                pair,
                &mut mixed,
            ),
            [] => mixed.clear(),
        }
        if !mixed.is_empty() {
            counters.callbacks.fetch_add(1, Ordering::Relaxed);
            sink(LoopbackChunk { samples: &mixed });
        }
        if now.duration_since(checked) >= DEVICE_CHECK {
            checked = now;
            if default_ids(&legs.enumerator) != legs.ids {
                return Err("the default outputs changed".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_outputs_mix_sample_by_sample() {
        let mut speakers: VecDeque<f32> = [0.1, 0.2, 0.3].into_iter().collect();
        let mut headset: VecDeque<f32> = [0.5, 0.5].into_iter().collect();
        let mut out = Vec::new();
        mix(
            &mut [&mut speakers, &mut headset],
            &mut MixGate::default(),
            &mut Default::default(),
            &mut out,
        );
        assert_eq!(out, vec![0.6, 0.7]);
        assert_eq!(
            speakers.len(),
            1,
            "the extra sample waits for the other output"
        );
        assert!(headset.is_empty());
    }

    #[test]
    fn the_capture_format_is_48k_float_stereo_extensible() {
        let format = capture_format();
        let base = format.Format;
        assert_eq!(
            { base.wFormatTag },
            0xFFFE,
            "extensible, as the engine converts to without a question"
        );
        assert_eq!(
            { base.cbSize } as usize,
            std::mem::size_of::<WAVEFORMATEXTENSIBLE>() - std::mem::size_of::<WAVEFORMATEX>()
        );
        assert_eq!({ base.nBlockAlign }, 8);
        assert_eq!({ base.nAvgBytesPerSec }, 48_000 * 8);
    }

    #[test]
    fn one_output_passes_through_and_loud_mixes_clip() {
        let samples = [0.25, -0.5, 1.5, -1.25, f32::MIN_POSITIVE, 0.123_456_79];
        let mut only: VecDeque<f32> = samples.into_iter().collect();
        let mut out = Vec::new();
        mix(
            &mut [&mut only],
            &mut MixGate::default(),
            &mut Default::default(),
            &mut out,
        );
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(
            bits(&out),
            bits(&samples),
            "one output is bit for bit what was captured"
        );
        let mut a: VecDeque<f32> = [0.8].into_iter().collect();
        let mut b: VecDeque<f32> = [0.8].into_iter().collect();
        mix(
            &mut [&mut a, &mut b],
            &mut MixGate::default(),
            &mut Default::default(),
            &mut out,
        );
        assert_eq!(out, vec![1.0]);
    }

    #[test]
    fn only_samples_that_are_not_numbers_are_replaced() {
        for x in [
            0.0f32,
            -0.0,
            0.5,
            -1.0,
            1.0,
            1.5,
            -7.25,
            f32::MAX,
            f32::MIN,
            f32::EPSILON,
        ] {
            assert_eq!(finite(x).to_bits(), x.to_bits());
        }
        assert_eq!(finite(f32::NAN), 0.0);
        assert_eq!(finite(f32::INFINITY), 0.0);
        assert_eq!(finite(f32::NEG_INFINITY), 0.0);
    }

    #[test]
    fn an_output_running_ahead_is_kept_within_the_skew() {
        let mut fast: VecDeque<f32> = std::iter::repeat_n(0.0, MAX_SKEW * 3).collect();
        let mut slow: VecDeque<f32> = std::iter::repeat_n(0.0, 10).collect();
        let mut out = Vec::new();
        mix(
            &mut [&mut fast, &mut slow],
            &mut MixGate::default(),
            &mut Default::default(),
            &mut out,
        );
        assert_eq!(out.len(), 10);
        assert_eq!(fast.len(), MAX_SKEW);
    }
}
