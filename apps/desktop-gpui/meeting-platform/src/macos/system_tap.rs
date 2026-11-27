use std::{
    cell::UnsafeCell,
    ffi::c_void,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use cidre::{
    arc, cat, cf,
    core_audio::{
        self as ca, AggregateDevice, Device, DeviceIoProcId, Obj, Process, PropAddr, PropSelector,
        System, TapDesc, aggregate_device_keys as agg_keys, sub_device_keys as sub_keys,
    },
    ns, os,
};

const RING_FRAMES: usize = 1 << 18;
const DRAIN_INTERVAL: Duration = Duration::from_millis(20);
const STALL_THRESHOLD: Duration = Duration::from_millis(250);
const IDLE_INTERVAL: Duration = Duration::from_millis(100);
const REBUILD_SETTLE: Duration = Duration::from_millis(300);
const REBUILD_ATTEMPTS: u32 = 20;
/// How long a start waits for the tap. Making one can raise the system's
/// permission prompt and blocks until it is answered; a start that waits
/// longer returns, and computer audio begins once the person answers.
const READY_WAIT: Duration = Duration::from_secs(2);

type CreateTap = unsafe extern "C-unwind" fn(description: &TapDesc, tap: *mut Obj) -> os::Status;
type DestroyTap = unsafe extern "C-unwind" fn(tap: Obj) -> os::Status;

#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
    fn AudioDeviceDestroyIOProcID(device: u32, proc_id: *const c_void) -> i32;
    fn AudioDeviceStop(device: u32, proc_id: *const c_void) -> i32;
}

#[derive(Debug, thiserror::Error)]
pub enum TapError {
    #[error("system audio capture needs macOS 14.2 or later")]
    Unsupported,
    #[error("no audio output device is available")]
    NoOutputDevice,
    #[error("the system audio stream has an unexpected format")]
    Format,
    #[error("the audio system refused the request ({0})")]
    Os(i32),
    #[error("the capture thread could not start")]
    Thread,
}

impl From<os::Error> for TapError {
    fn from(error: os::Error) -> Self {
        Self::Os(error.0.get())
    }
}

pub struct TapChunk<'a> {
    pub samples: &'a [f32],
    pub sample_rate: u32,
    pub frame_offset: u64,
    pub synthetic: bool,
}

fn tap_functions() -> Option<(CreateTap, DestroyTap)> {
    let create = super::dynamic_symbol(c"AudioHardwareCreateProcessTap")?;
    let destroy = super::dynamic_symbol(c"AudioHardwareDestroyProcessTap")?;
    Some(unsafe {
        (
            std::mem::transmute::<*mut c_void, CreateTap>(create),
            std::mem::transmute::<*mut c_void, DestroyTap>(destroy),
        )
    })
}

/// Whether a process other than this one (or a screen reader, which the tap
/// leaves out) is playing audio right now, as Core Audio tracks each
/// process's output. `None` when it can't say.
pub fn others_playing() -> Option<bool> {
    let me = unsafe { libc::getpid() };
    let processes = System::processes().ok()?;
    // A screen reader the tap leaves out is not something it should hear.
    Some(processes.iter().any(|process| {
        process.pid().is_ok_and(|pid| pid != me)
            && process.is_running_output().unwrap_or(false)
            && !process
                .bundle_id()
                .is_ok_and(|id| READER_BUNDLES.contains(&id.to_string().as_str()))
    }))
}

pub fn system_tap_supported() -> bool {
    tap_functions().is_some()
        && ns::ProcessInfo::current().is_os_at_least_version(ns::OsVersion {
            major: 14,
            minor: 2,
            patch: 0,
        })
}

/// Screen readers whose speech never belongs in a meeting's computer audio.
/// VoiceOver plays its speech from its own process.
const READER_BUNDLES: &[&str] = &["com.apple.VoiceOver"];

/// The audio process objects of the screen readers running now, sorted.
fn reader_processes() -> Vec<u32> {
    let Ok(processes) = Process::list() else {
        return Vec::new();
    };
    let mut readers: Vec<u32> = processes
        .iter()
        .filter(|process| {
            process
                .bundle_id()
                .is_ok_and(|id| READER_BUNDLES.contains(&id.to_string().as_str()))
        })
        .map(|process| process.0.0)
        .collect();
    readers.sort_unstable();
    readers
}

/// Looks at the audio process list once, so the look a meeting's tap makes
/// before it starts is quick (the first look in a process takes ~25 ms, the
/// next ~1 ms). Call it off the main thread.
pub fn warm_screen_reader_lookup() {
    let _ = reader_processes();
}

/// The processes a tap leaves out: Cap itself (when asked) and any running
/// screen reader.
fn exclusion(own: Option<u32>, readers: &[u32]) -> arc::R<ns::Array<ns::Number>> {
    let numbers: Vec<arc::R<ns::Number>> = own
        .into_iter()
        .chain(readers.iter().copied())
        .map(ns::Number::with_u32)
        .collect();
    if numbers.is_empty() {
        return ns::Array::new();
    }
    let numbers: Vec<&ns::Number> = numbers.iter().map(|number| number.as_ref()).collect();
    ns::Array::from_slice(&numbers)
}

/// Test builds only: `CAP_GPUI_TEST_READER_EXCLUDE_FAIL` makes every attempt
/// to leave a screen reader out fail, to prove the fallback.
fn reader_exclusion_refused_for_test() -> bool {
    cfg!(debug_assertions) && std::env::var_os("CAP_GPUI_TEST_READER_EXCLUDE_FAIL").is_some()
}

struct Ring {
    data: Box<[UnsafeCell<f32>]>,
    write: AtomicUsize,
    read: AtomicUsize,
    dropped: AtomicU64,
}

unsafe impl Send for Ring {}
unsafe impl Sync for Ring {}

impl Ring {
    fn new(frames: usize) -> Self {
        Self {
            data: (0..frames).map(|_| UnsafeCell::new(0.0)).collect(),
            write: AtomicUsize::new(0),
            read: AtomicUsize::new(0),
            dropped: AtomicU64::new(0),
        }
    }

    fn push(&self, frames: impl ExactSizeIterator<Item = f32>) {
        let capacity = self.data.len();
        let write = self.write.load(Ordering::Relaxed);
        let read = self.read.load(Ordering::Acquire);
        let count = frames.len();
        if capacity - write.wrapping_sub(read) < count {
            self.dropped.fetch_add(count as u64, Ordering::Relaxed);
            return;
        }
        for (index, sample) in frames.enumerate() {
            unsafe { *self.data[write.wrapping_add(index) % capacity].get() = sample };
        }
        self.write
            .store(write.wrapping_add(count), Ordering::Release);
    }

    fn drain_into(&self, out: &mut Vec<f32>) {
        let capacity = self.data.len();
        let read = self.read.load(Ordering::Relaxed);
        let write = self.write.load(Ordering::Acquire);
        let count = write.wrapping_sub(read);
        out.reserve(count);
        for index in 0..count {
            out.push(unsafe { *self.data[read.wrapping_add(index) % capacity].get() });
        }
        self.read.store(write, Ordering::Release);
    }
}

#[derive(Default)]
struct Counters {
    callbacks: AtomicU64,
    empty_callbacks: AtomicU64,
    frames: AtomicU64,
    dropped: AtomicU64,
    restarts: AtomicU64,
    /// Asked from outside: the tap went quiet while a call was on.
    rebuild: AtomicBool,
    gave_up: AtomicBool,
    output_changes: AtomicU64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TapStats {
    pub callbacks: u64,
    pub empty_callbacks: u64,
    pub frames: u64,
    pub dropped: u64,
    pub restarts: u64,
    /// Every rebuild attempt failed; the tap is down until the next start.
    pub gave_up: bool,
    /// How many times the audio system said the default output changed.
    pub output_changes: u64,
}

struct IoContext {
    ring: Arc<Ring>,
    counters: Arc<Counters>,
    /// Buffers before the tap's: the aggregate lists its main device's own
    /// input first (a headset's microphone, a loopback device's input).
    skip: AtomicUsize,
}

/// How many of the aggregate's input streams come before the tap's. The
/// aggregate lists the input streams of its active sub-devices (the default
/// output's own input: a headset's microphone, a loopback device's input)
/// and then the tap's one mono stream. `None` when its input is not exactly
/// that, or CoreAudio does not say.
fn streams_before_tap(aggregate: &Device) -> Option<usize> {
    let inputs = |device: Obj| {
        device
            .prop_vec::<Obj>(
                &PropSelector::DEVICE_STREAMS.addr(ca::PropScope::INPUT, ca::PropElement::MAIN),
            )
            .map(|streams| streams.len())
            .ok()
    };
    let active: Vec<Obj> = aggregate
        .prop_vec(&PropSelector::AGGREGATE_DEVICE_ACTIVE_SUB_DEVICE_LIST.global_addr())
        .ok()?;
    let mut own = 0;
    for device in active {
        own += inputs(device)?;
    }
    (inputs(aggregate.0)? == own + 1).then_some(own)
}

/// Pushes what the tap delivered in one callback: the buffers after the
/// first `skip` (the main device's own input, never the computer's sound),
/// mono, or channels averaged. False for an empty callback.
fn push_tap(ring: &Ring, buffers: &[cat::AudioBuf], skip: usize) -> bool {
    let buffers = &buffers[skip.min(buffers.len())..];
    let Some(first) = buffers.first() else {
        return false;
    };
    if first.data.is_null() || first.data_bytes_size == 0 {
        return false;
    }

    if buffers.len() == 1 {
        let channels = first.number_channels.max(1) as usize;
        let samples = unsafe {
            std::slice::from_raw_parts(
                first.data.cast::<f32>().cast_const(),
                first.data_bytes_size as usize / size_of::<f32>(),
            )
        };
        if channels == 1 {
            ring.push(samples.iter().copied());
        } else {
            let scale = 1.0 / channels as f32;
            ring.push(
                samples
                    .chunks_exact(channels)
                    .map(|frame| frame.iter().sum::<f32>() * scale),
            );
        }
    } else {
        let frames = first.data_bytes_size as usize / size_of::<f32>();
        if buffers
            .iter()
            .any(|buffer| buffer.data.is_null() || (buffer.data_bytes_size as usize) < frames * 4)
        {
            return true;
        }
        let scale = 1.0 / buffers.len() as f32;
        ring.push((0..frames).map(|frame| {
            buffers
                .iter()
                .map(|buffer| unsafe { *buffer.data.cast::<f32>().add(frame) })
                .sum::<f32>()
                * scale
        }));
    }
    true
}

extern "C" fn io_proc(
    _device: Device,
    _now: &cat::AudioTimeStamp,
    input: &cat::AudioBufList<1>,
    _input_time: &cat::AudioTimeStamp,
    _output: &mut cat::AudioBufList<1>,
    _output_time: &cat::AudioTimeStamp,
    context: Option<&mut IoContext>,
) -> os::Status {
    let Some(context) = context else {
        return os::Status::NO_ERR;
    };
    context.counters.callbacks.fetch_add(1, Ordering::Relaxed);
    let count = input.number_buffers as usize;
    if count == 0 {
        context
            .counters
            .empty_callbacks
            .fetch_add(1, Ordering::Relaxed);
        return os::Status::NO_ERR;
    }
    let buffers = unsafe { std::slice::from_raw_parts(input.buffers.as_ptr(), count) };
    let skip = context.skip.load(Ordering::Relaxed);
    if !push_tap(&context.ring, buffers, skip) {
        context
            .counters
            .empty_callbacks
            .fetch_add(1, Ordering::Relaxed);
    }
    os::Status::NO_ERR
}

struct Session {
    started: Option<ca::hardware::StartedDevice<Device>>,
    aggregate: Option<AggregateDevice>,
    aggregate_id: u32,
    proc_id: DeviceIoProcId,
    tap: Obj,
    destroy_tap: DestroyTap,
    sample_rate: u32,
}

impl Session {
    fn start(
        context: &mut IoContext,
        exclude_own_audio: bool,
        readers: &[u32],
    ) -> Result<Self, TapError> {
        let mut session = Self::build(context, exclude_own_audio, readers)?;
        session.run()?;
        Ok(session)
    }

    /// Everything but starting the device: the tap, its aggregate and the
    /// IO proc. Nothing is delivered until [`Session::run`].
    fn build(
        context: &mut IoContext,
        exclude_own_audio: bool,
        readers: &[u32],
    ) -> Result<Self, TapError> {
        let _pool = cidre::objc::AutoreleasePoolPage::push();
        let (create_tap, destroy_tap) = tap_functions().ok_or(TapError::Unsupported)?;
        if !readers.is_empty() && reader_exclusion_refused_for_test() {
            return Err(TapError::Os(1));
        }

        let own = if exclude_own_audio {
            Process::with_pid(unsafe { libc::getpid() })
                .ok()
                .filter(|process| process.0 != Obj::UNKNOWN)
                .map(|process| process.0.0)
        } else {
            None
        };
        let excluded = exclusion(own, readers);

        // The `initMonoGlobalTapButExcludeProcesses:` convenience initializer
        // returns an over-retained object on macOS 27 (measured: retain count
        // 2 with no pending autorelease), leaking one description per start.
        let mut description = TapDesc::new();
        description.set_processes(&excluded);
        description.set_exclusive(true);
        description.set_mixdown(true);
        description.set_mono(true);
        description.set_private(true);
        description.set_name(Some(ns::str!(c"Cap meeting audio")));

        let mut tap = Obj::UNKNOWN;
        unsafe { create_tap(&description, &mut tap) }.result()?;
        let tap_guard = TapGuard {
            tap,
            destroy: destroy_tap,
        };

        let tap_uid: arc::R<cf::String> = tap.cf_prop(&PropSelector::TAP_UID.global_addr())?;
        let format: cat::AudioStreamBasicDesc =
            tap.prop(&PropSelector::TAP_FORMAT.global_addr())?;
        if format.format != cat::AudioFormat::LINEAR_PCM
            || !format
                .format_flags
                .contains(cat::AudioFormatFlags::IS_FLOAT)
            || format.bits_per_channel != 32
            || format.sample_rate < 8_000.0
        {
            return Err(TapError::Format);
        }

        let output = System::default_output_device().map_err(|_| TapError::NoOutputDevice)?;
        if output.0 == Obj::UNKNOWN {
            return Err(TapError::NoOutputDevice);
        }
        let output_uid = output.uid().map_err(|_| TapError::NoOutputDevice)?;

        let sub_device =
            cf::DictionaryOf::with_keys_values(&[sub_keys::uid()], &[output_uid.as_type_ref()]);
        let sub_tap = cf::DictionaryOf::with_keys_values(
            &[
                sub_keys::uid(),
                ca::hardware::sub_tap_keys::drift_compensation(),
            ],
            &[
                tap_uid.as_type_ref(),
                cf::Boolean::value_true().as_type_ref(),
            ],
        );
        let composition = cf::DictionaryOf::with_keys_values(
            &[
                agg_keys::is_private(),
                agg_keys::is_stacked(),
                agg_keys::tap_auto_start(),
                agg_keys::name(),
                agg_keys::main_sub_device(),
                agg_keys::uid(),
                agg_keys::sub_device_list(),
                agg_keys::tap_list(),
            ],
            &[
                cf::Boolean::value_true().as_type_ref(),
                cf::Boolean::value_false(),
                cf::Boolean::value_true(),
                cf::str!(c"Cap meeting audio"),
                &output_uid,
                &cf::Uuid::new().to_cf_string(),
                &cf::ArrayOf::from_slice(&[sub_device.as_ref()]),
                &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
            ],
        );

        let aggregate = AggregateDevice::with_desc(&composition)?;
        let aggregate_id = {
            let device: &Device = &aggregate;
            device.0.0
        };
        let skip = match streams_before_tap(&aggregate) {
            Some(skip) => {
                if skip > 0 {
                    tracing::info!(
                        skip,
                        "the output device has its own input; recording only what the computer plays"
                    );
                }
                skip
            }
            None => {
                tracing::warn!(
                    "unexpected system audio device layout; reading every input stream as before"
                );
                0
            }
        };
        context.skip.store(skip, Ordering::Relaxed);
        let proc_id = aggregate.create_io_proc_id(io_proc, Some(context))?;

        std::mem::forget(tap_guard);
        Ok(Self {
            started: None,
            aggregate: Some(aggregate),
            aggregate_id,
            proc_id,
            tap,
            destroy_tap,
            sample_rate: format.sample_rate.round() as u32,
        })
    }

    /// Starts delivering. A session dropped before it runs cleans up all the
    /// same.
    fn run(&mut self) -> Result<(), TapError> {
        let started = ca::device_start(Device(Obj(self.aggregate_id)), Some(self.proc_id))?;
        self.started = Some(started);
        Ok(())
    }
}

/// Starts the tap leaving running screen readers out. If that is refused,
/// starts it at once as before, with the readers' speech in it.
fn start_session(
    context: &mut IoContext,
    exclude_own_audio: bool,
    readers: &[u32],
) -> Result<Session, TapError> {
    if readers.is_empty() {
        return Session::start(context, exclude_own_audio, &[]);
    }
    match Session::start(context, exclude_own_audio, readers) {
        Ok(session) => {
            tracing::info!("a screen reader is running; its speech is left out of computer audio");
            Ok(session)
        }
        Err(error) => {
            tracing::warn!(%error, "could not leave the screen reader's speech out of computer audio; recording as before");
            Session::start(context, exclude_own_audio, &[])
        }
    }
}

extern "C-unwind" fn on_processes_changed(
    _obj: Obj,
    _count: u32,
    _addresses: *const PropAddr,
    signal: *mut flume::Sender<()>,
) -> os::Status {
    if let Some(tx) = unsafe { signal.as_ref() } {
        let _ = tx.try_send(());
    }
    os::Status::NO_ERR
}

impl Drop for Session {
    fn drop(&mut self) {
        // Stopped here, not by `StartedDevice`'s own drop: that one asserts
        // the stop worked, and when coreaudiod has just restarted it can't,
        // which would take the whole capture thread down with it.
        if let Some(started) = self.started.take() {
            let status = unsafe { AudioDeviceStop(self.aggregate_id, self.proc_id as *const c_void) };
            if status != 0 {
                tracing::warn!(status, "system audio device did not stop cleanly (audio service restarted?)");
            }
            std::mem::forget(started);
        }
        unsafe { AudioDeviceDestroyIOProcID(self.aggregate_id, self.proc_id as *const c_void) };
        self.aggregate.take();
        let _ = unsafe { (self.destroy_tap)(self.tap) }.result();
    }
}

struct TapGuard {
    tap: Obj,
    destroy: DestroyTap,
}

impl Drop for TapGuard {
    fn drop(&mut self) {
        let _ = unsafe { (self.destroy)(self.tap) }.result();
    }
}

struct OutputChanged {
    tx: flume::Sender<()>,
    counters: Arc<Counters>,
}

extern "C-unwind" fn on_output_changed(
    _obj: Obj,
    count: u32,
    addresses: *const PropAddr,
    signal: *mut OutputChanged,
) -> os::Status {
    if let Some(signal) = unsafe { signal.as_ref() } {
        let addresses = if addresses.is_null() {
            &[][..]
        } else {
            unsafe { std::slice::from_raw_parts(addresses, count as usize) }
        };
        let output = PropSelector::HW_DEFAULT_OUTPUT_DEVICE;
        if addresses
            .iter()
            .any(|address| address.selector.0 == output.0)
        {
            signal
                .counters
                .output_changes
                .fetch_add(1, Ordering::Relaxed);
        }
        let _ = signal.tx.try_send(());
    }
    os::Status::NO_ERR
}

pub struct SystemAudioTap {
    stop: Arc<AtomicBool>,
    counters: Arc<Counters>,
    thread: Option<JoinHandle<()>>,
    /// The tap's first build has returned (it can wait on a prompt).
    built: Arc<AtomicBool>,
}

/// What a start learned in the time it waits.
#[derive(Debug)]
enum Ready {
    Started,
    Failed(TapError),
    /// Still building, most likely behind the system's permission prompt.
    Pending,
    Gone,
}

fn wait_ready(ready: &flume::Receiver<Result<(), TapError>>, wait: Duration) -> Ready {
    match ready.recv_timeout(wait) {
        Ok(Ok(())) => Ready::Started,
        Ok(Err(error)) => Ready::Failed(error),
        Err(flume::RecvTimeoutError::Timeout) => Ready::Pending,
        Err(flume::RecvTimeoutError::Disconnected) => Ready::Gone,
    }
}

impl SystemAudioTap {
    pub fn start(
        exclude_own_audio: bool,
        mut sink: impl FnMut(TapChunk<'_>) + Send + 'static,
    ) -> Result<Self, TapError> {
        if !system_tap_supported() {
            return Err(TapError::Unsupported);
        }

        let stop = Arc::new(AtomicBool::new(false));
        let counters = Arc::new(Counters::default());
        let built = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = flume::bounded::<Result<(), TapError>>(1);
        let thread = std::thread::Builder::new()
            .name("cap-system-audio".into())
            .spawn({
                let stop = stop.clone();
                let counters = counters.clone();
                let built = built.clone();
                move || {
                    let ring = Arc::new(Ring::new(RING_FRAMES));
                    let mut context = Box::new(IoContext {
                        ring: ring.clone(),
                        counters: counters.clone(),
                        skip: AtomicUsize::new(0),
                    });
                    let mut readers = reader_processes();
                    let started = start_session(&mut context, exclude_own_audio, &readers);
                    built.store(true, Ordering::Release);
                    let mut session = match started {
                        Ok(session) => {
                            let _ = ready_tx.send(Ok(()));
                            // The start waited for any system prompt it raised;
                            // that answer does not reach this process by itself.
                            super::tcc::refresh_audio_capture_permission();
                            Some(session)
                        }
                        Err(error) => {
                            let _ = ready_tx.send(Err(error));
                            return;
                        }
                    };

                    let (changed_tx, changed_rx) = flume::bounded::<()>(1);
                    let signal = Box::into_raw(Box::new(OutputChanged {
                        tx: changed_tx,
                        counters: counters.clone(),
                    }));
                    let address = PropSelector::HW_DEFAULT_OUTPUT_DEVICE.global_addr();
                    let listening = System::OBJ
                        .add_prop_listener(&address, on_output_changed, signal)
                        .is_ok();
                    // The audio service restarted (kAudioHardwarePropertyServiceRestarted):
                    // every tap and aggregate device is gone, so build ours again.
                    let restarted = PropSelector(u32::from_be_bytes(*b"srst")).global_addr();
                    let restart_listening = System::OBJ
                        .add_prop_listener(&restarted, on_output_changed, signal)
                        .is_ok();
                    // A screen reader starting or quitting changes the audio
                    // process list; the tap's exclusions follow it.
                    let (processes_tx, processes_rx) = flume::bounded::<()>(1);
                    let processes_signal = Box::into_raw(Box::new(processes_tx));
                    let processes = PropSelector::HW_PROCESS_OBJ_LIST.global_addr();
                    let processes_listening = System::OBJ
                        .add_prop_listener(&processes, on_processes_changed, processes_signal)
                        .is_ok();

                    let mut samples = Vec::with_capacity(RING_FRAMES);
                    let mut silence = Vec::new();
                    let mut frame_offset = 0u64;
                    let origin = Instant::now();
                    let mut last_data = origin;
                    let mut sample_rate = session.as_ref().map_or(48_000, |s| s.sample_rate);
                    let mut rebuilds_left = 0u32;
                    let mut next_rebuild = origin;

                    let mut emit_silence =
                        |frames: u64,
                         sample_rate: u32,
                         frame_offset: &mut u64,
                         sink: &mut dyn FnMut(TapChunk<'_>)| {
                            let block = sample_rate as usize;
                            if silence.len() != block {
                                silence = vec![0.0; block];
                            }
                            let mut remaining = frames as usize;
                            while remaining > 0 {
                                let count = remaining.min(block);
                                sink(TapChunk {
                                    samples: &silence[..count],
                                    sample_rate,
                                    frame_offset: *frame_offset,
                                    synthetic: true,
                                });
                                *frame_offset += count as u64;
                                remaining -= count;
                            }
                        };

                    while !stop.load(Ordering::Acquire) {
                        if changed_rx.try_recv().is_ok()
                            || counters.rebuild.swap(false, Ordering::AcqRel)
                        {
                            session = None;
                            rebuilds_left = REBUILD_ATTEMPTS;
                            next_rebuild = Instant::now() + REBUILD_SETTLE;
                            counters.gave_up.store(false, Ordering::Relaxed);
                        }
                        if processes_rx.try_recv().is_ok() {
                            let now = reader_processes();
                            if now != readers {
                                // A running tap refuses a new description, so
                                // the next tap is built first, then the old one
                                // stops and the new one starts. If building is
                                // refused, the old tap goes on.
                                if let Some(active) = session.take() {
                                    match Session::build(&mut context, exclude_own_audio, &now) {
                                        Ok(mut next) => {
                                            drop(active);
                                            match next.run() {
                                                Ok(()) => {
                                                    counters.restarts.fetch_add(1, Ordering::Relaxed);
                                                    tracing::info!(
                                                        readers = now.len(),
                                                        "the screen readers computer audio leaves out changed"
                                                    );
                                                    session = Some(next);
                                                }
                                                Err(error) => {
                                                    tracing::warn!(%error, "could not change which screen readers computer audio leaves out; recording as before");
                                                    drop(next);
                                                    session = Session::start(&mut context, exclude_own_audio, &[]).ok();
                                                    if session.is_none() {
                                                        rebuilds_left = REBUILD_ATTEMPTS;
                                                    }
                                                }
                                            }
                                        }
                                        Err(error) => {
                                            tracing::warn!(%error, "could not change which screen readers computer audio leaves out; recording as before");
                                            session = Some(active);
                                        }
                                    }
                                }
                                readers = now;
                            }
                        }
                        if session.is_none() && rebuilds_left > 0 && Instant::now() >= next_rebuild
                        {
                            rebuilds_left -= 1;
                            readers = reader_processes();
                            match start_session(&mut context, exclude_own_audio, &readers) {
                                Ok(rebuilt) => {
                                    counters.restarts.fetch_add(1, Ordering::Relaxed);
                                    if rebuilt.sample_rate != sample_rate {
                                        frame_offset = frame_offset
                                            * u64::from(rebuilt.sample_rate)
                                            / u64::from(sample_rate.max(1));
                                        sample_rate = rebuilt.sample_rate;
                                    }
                                    session = Some(rebuilt);
                                }
                                Err(error) => {
                                    tracing::warn!(%error, "system audio capture restart failed");
                                    next_rebuild = Instant::now() + Duration::from_secs(1);
                                    if rebuilds_left == 0 {
                                        tracing::error!("system audio capture could not be rebuilt");
                                        counters.gave_up.store(true, Ordering::Relaxed);
                                    }
                                }
                            }
                        }

                        samples.clear();
                        ring.drain_into(&mut samples);
                        let dropped = ring.dropped.swap(0, Ordering::Relaxed);
                        counters.dropped.fetch_add(dropped, Ordering::Relaxed);
                        let now = Instant::now();
                        let mut interval = DRAIN_INTERVAL;
                        if !samples.is_empty() {
                            if dropped > 0 {
                                emit_silence(dropped, sample_rate, &mut frame_offset, &mut sink);
                            }
                            sink(TapChunk {
                                samples: &samples,
                                sample_rate,
                                frame_offset,
                                synthetic: false,
                            });
                            frame_offset += samples.len() as u64;
                            counters
                                .frames
                                .fetch_add(samples.len() as u64, Ordering::Relaxed);
                            last_data = now;
                        } else if now.duration_since(last_data) > STALL_THRESHOLD {
                            let rate = f64::from(sample_rate);
                            let target = (now.duration_since(origin).as_secs_f64() * rate) as u64;
                            let margin = (DRAIN_INTERVAL.as_secs_f64() * rate) as u64;
                            let missing =
                                target.saturating_sub(margin).saturating_sub(frame_offset);
                            if missing > 0 {
                                emit_silence(missing, sample_rate, &mut frame_offset, &mut sink);
                            }
                            interval = IDLE_INTERVAL;
                        }
                        std::thread::sleep(interval);
                    }

                    drop(session);
                    if listening {
                        let _ =
                            System::OBJ.remove_prop_listener(&address, on_output_changed, signal);
                    }
                    if restart_listening {
                        let _ = System::OBJ.remove_prop_listener(&restarted, on_output_changed, signal);
                    }
                    if processes_listening {
                        let _ = System::OBJ.remove_prop_listener(
                            &processes,
                            on_processes_changed,
                            processes_signal,
                        );
                    }
                    drop(unsafe { Box::from_raw(processes_signal) });
                    drop(unsafe { Box::from_raw(signal) });
                    drop(context);
                }
            })
            .map_err(|_| TapError::Thread)?;

        match wait_ready(&ready_rx, READY_WAIT) {
            Ready::Started => Ok(Self {
                stop,
                counters,
                thread: Some(thread),
                built,
            }),
            Ready::Pending => {
                tracing::info!(
                    "computer audio waits on the system's permission prompt; the meeting goes on"
                );
                Ok(Self {
                    stop,
                    counters,
                    thread: Some(thread),
                    built,
                })
            }
            Ready::Failed(error) => {
                let _ = thread.join();
                Err(error)
            }
            Ready::Gone => {
                let _ = thread.join();
                Err(TapError::Thread)
            }
        }
    }
}

impl SystemAudioTap {
    pub fn stats(&self) -> TapStats {
        TapStats {
            callbacks: self.counters.callbacks.load(Ordering::Relaxed),
            empty_callbacks: self.counters.empty_callbacks.load(Ordering::Relaxed),
            frames: self.counters.frames.load(Ordering::Relaxed),
            dropped: self.counters.dropped.load(Ordering::Relaxed),
            restarts: self.counters.restarts.load(Ordering::Relaxed),
            gave_up: self.counters.gave_up.load(Ordering::Relaxed),
            output_changes: self.counters.output_changes.load(Ordering::Relaxed),
        }
    }

    /// Whether the capture thread is still running (it ends only when
    /// stopped, unless something took it down).
    pub fn alive(&self) -> bool {
        self.thread.as_ref().is_some_and(|t| !t.is_finished())
    }

    /// Tears the tap down and builds it again (it stopped delivering).
    pub fn rebuild(&self) {
        self.counters.rebuild.store(true, Ordering::Release);
    }
}

impl Drop for SystemAudioTap {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            // A tap still waiting on the prompt cannot be joined without
            // waiting with it: it sees `stop` once the prompt is answered
            // and tears itself down.
            if self.built.load(Ordering::Acquire) {
                let _ = thread.join();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_start_behind_a_prompt_returns_instead_of_waiting() {
        let (_building, ready) = flume::bounded::<Result<(), TapError>>(1);
        let asked = Instant::now();
        assert!(matches!(
            wait_ready(&ready, Duration::from_millis(50)),
            Ready::Pending
        ));
        assert!(asked.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_quick_start_or_failure_is_seen_at_once() {
        let (tx, ready) = flume::bounded::<Result<(), TapError>>(1);
        tx.send(Ok(())).unwrap();
        assert!(matches!(wait_ready(&ready, READY_WAIT), Ready::Started));
        tx.send(Err(TapError::Thread)).unwrap();
        assert!(matches!(
            wait_ready(&ready, READY_WAIT),
            Ready::Failed(TapError::Thread)
        ));
        drop(tx);
        assert!(matches!(wait_ready(&ready, READY_WAIT), Ready::Gone));
    }

    fn buf(samples: &mut [f32], channels: u32) -> cat::AudioBuf {
        cat::AudioBuf {
            number_channels: channels,
            data_bytes_size: (samples.len() * size_of::<f32>()) as u32,
            data: samples.as_mut_ptr().cast(),
        }
    }

    fn pushed(buffers: &[cat::AudioBuf], skip: usize) -> Vec<f32> {
        let ring = Ring::new(4_096);
        push_tap(&ring, buffers, skip);
        let mut out = Vec::new();
        ring.drain_into(&mut out);
        out
    }

    /// What the aggregate hands over with BlackHole 2ch as the default
    /// output (measured on macOS 27): BlackHole's own stereo input first,
    /// then the tap's one mono stream.
    #[test]
    fn the_output_devices_own_input_is_skipped_for_the_tap() {
        let mut device_input = vec![0.0f32; 2 * 4];
        let mut tap = vec![0.1, 0.2, 0.3, 0.4];
        let buffers = [buf(&mut device_input, 2), buf(&mut tap, 1)];
        assert_eq!(pushed(&buffers, 1), vec![0.1, 0.2, 0.3, 0.4]);
        // Read as one list, the two sizes never matched: nothing was kept,
        // and the meeting recorded silence.
        assert!(pushed(&buffers, 0).is_empty());
    }

    /// A headset with a mono microphone as the default output: its input has
    /// the tap's size, and was averaged into the computer's audio.
    #[test]
    fn a_headsets_microphone_never_reaches_the_computer_audio() {
        let mut mic = vec![0.8f32; 4];
        let mut tap = vec![0.1, 0.2, 0.3, 0.4];
        let buffers = [buf(&mut mic, 1), buf(&mut tap, 1)];
        assert_eq!(pushed(&buffers, 1), vec![0.1, 0.2, 0.3, 0.4]);
    }

    #[test]
    fn a_tap_alone_passes_through_as_before() {
        let mut tap = vec![0.1, -0.2, 0.3];
        assert_eq!(pushed(&[buf(&mut tap, 1)], 0), vec![0.1, -0.2, 0.3]);
        let mut stereo = vec![0.2, 0.4, -0.2, -0.4];
        let got = pushed(&[buf(&mut stereo, 2)], 0);
        assert!(
            (got[0] - 0.3).abs() < 1e-6 && (got[1] + 0.3).abs() < 1e-6,
            "{got:?}"
        );
        // A skip past the end leaves nothing rather than reading the wrong
        // buffer.
        assert!(pushed(&[buf(&mut tap, 1)], 3).is_empty());
    }

    #[test]
    fn a_running_screen_reader_is_left_out_next_to_cap() {
        let numbers = |array: &ns::Array<ns::Number>| -> Vec<u32> {
            (0..array.len()).map(|i| array[i].as_u32()).collect()
        };
        // No reader: exactly what the tap left out before.
        assert_eq!(numbers(&exclusion(Some(7), &[])), vec![7]);
        assert!(numbers(&exclusion(None, &[])).is_empty());
        assert_eq!(numbers(&exclusion(Some(7), &[41, 52])), vec![7, 41, 52]);
        assert_eq!(numbers(&exclusion(None, &[41])), vec![41]);
    }
}
