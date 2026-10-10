use anyhow::Context;
use cidre::{arc, cf, cv, define_obj_type, ns, objc, vn};
use std::sync::mpsc;
use std::thread;

use crate::mask_refinement::MaskRefiner;

/// Largest frame handed to Vision. Its balanced person segmentation runs a
/// fixed-size network, and on webcam footage a 960x540 input produces the
/// same mask as the full 1080p frame while halving the readback.
pub const MAX_INPUT_DIMENSIONS: (u32, u32) = (960, 540);

unsafe extern "C" {
    fn CVPixelBufferGetBaseAddress(pixel_buffer: &cv::PixelBuf) -> *mut u8;
    fn CVPixelBufferGetBytesPerRow(pixel_buffer: &cv::PixelBuf) -> usize;
}

/// A BGRA camera frame handed to Vision without copying it. CF objects have
/// atomic refcounts, so the retain can cross to the segmentation thread.
pub struct SharedPixelBuffer(pub arc::R<cv::PixelBuf>);
unsafe impl Send for SharedPixelBuffer {}

/// A finished mask: one byte per sample, and its width and height.
pub type VisionMask<'a> = (&'a [u8], (u32, u32));

/// Apple Vision person segmentation (`VNGeneratePersonSegmentationRequest`).
///
/// Runs on the Neural Engine and is far more accurate than the bundled ONNX
/// selfie model: it keeps desks, chairs, pillows and background people out
/// of the mask. Segmentation is asynchronous: a frame is submitted, the
/// caller keeps rendering with the previous mask, and the finished mask is
/// collected on a later frame. The thread also owns the autorelease pool
/// every Vision call needs, the stateful request's temporal smoothing, and
/// the mask cleanup, so none of that CPU work lands on the render thread.
pub struct VisionSegmenter {
    requests: Option<mpsc::Sender<Message>>,
    results: mpsc::Receiver<VisionJob>,
    idle: Option<VisionJob>,
    in_flight: bool,
    generation: u64,
    worker: Option<thread::JoinHandle<()>>,
}

enum Message {
    Segment(VisionJob),
    Reset,
}

enum VisionInput {
    None,
    Pixels,
    PixelBuffer(SharedPixelBuffer),
}

struct VisionJob {
    input: VisionInput,
    bgra: Vec<u8>,
    dimensions: (u32, u32),
    generation: u64,
    mask: Vec<u8>,
    mask_dimensions: (u32, u32),
    result: Result<(), String>,
}

impl VisionJob {
    fn new() -> Self {
        Self {
            input: VisionInput::None,
            bgra: Vec::new(),
            dimensions: (0, 0),
            generation: 0,
            mask: Vec::new(),
            mask_dimensions: (0, 0),
            result: Ok(()),
        }
    }
}

define_obj_type!(
    #[doc(alias = "VNGeneratePersonInstanceMaskRequest")]
    PersonInstanceMaskRequest(vn::Request)
);

define_obj_type!(
    #[doc(alias = "VNInstanceMaskObservation")]
    InstanceMaskObservation(vn::Observation)
);

impl PersonInstanceMaskRequest {
    /// macOS 14+. Looked up at runtime so older systems fall back to plain
    /// person segmentation.
    fn new() -> Option<arc::R<Self>> {
        let class =
            unsafe { objc::objc_getClass(c"VNGeneratePersonInstanceMaskRequest".as_ptr().cast()) }?;
        let class: &objc::Class<Self> = unsafe { std::mem::transmute(class) };
        Some(unsafe { class.new() })
    }

    #[objc::msg_send(results)]
    fn results(&self) -> Option<arc::R<ns::Array<InstanceMaskObservation>>>;
}

impl InstanceMaskObservation {
    /// One byte per sample: 0 is background, 1..n the person instances.
    #[objc::msg_send(instanceMask)]
    fn instance_mask(&self) -> &cv::PixelBuf;

    #[objc::msg_send(generateMaskForInstances:error:)]
    unsafe fn generate_mask_err<'ear>(
        &self,
        instances: &ns::IndexSet,
        error: *mut Option<&'ear ns::Error>,
    ) -> Option<&'ear cv::PixelBuf>;
}

/// Person instance masks separate everyone in frame, so only the presenter
/// is kept: people walking behind, other passengers and their chairs never
/// enter the cutout. They are also cheaper than balanced segmentation (~7ms
/// against ~10ms). Plain segmentation is the macOS 12-13 fallback.
enum Request {
    Instances(arc::R<PersonInstanceMaskRequest>),
    Segmentation(arc::R<vn::GenPersonSegmentationRequest>),
}

impl Request {
    fn new() -> Self {
        if std::env::var("CAP_CAMERA_SEGMENTATION").as_deref() != Ok("vision-segmentation")
            && let Some(request) = PersonInstanceMaskRequest::new()
        {
            return Self::Instances(request);
        }
        Self::Segmentation(create_request())
    }

    fn as_request(&self) -> &vn::Request {
        match self {
            Self::Instances(request) => request.as_ref(),
            Self::Segmentation(request) => request.as_ref(),
        }
    }
}

struct Session {
    handler: arc::R<vn::SequenceRequestHandler>,
    request: Request,
    input: Option<arc::R<cv::PixelBuf>>,
    cleanup: Cleanup,
    instance_areas: Vec<usize>,
}

/// Drops Vision's low-confidence blobs (pillows, chair backs) that are
/// detached from the person, and settles still regions over time while
/// following motion immediately.
#[derive(Default)]
struct Cleanup {
    refiner: Option<((u32, u32), MaskRefiner)>,
    mask: Vec<f32>,
    previous: Vec<f32>,
    motion: Vec<u8>,
}

fn create_request() -> arc::R<vn::GenPersonSegmentationRequest> {
    let mut request = vn::GenPersonSegmentationRequest::new();
    // Fast (256x192) loses arms and keeps pillows even after the guided
    // filter; accurate costs 50ms+ a frame. Balanced is the only level that
    // holds up at camera rate.
    request.set_quality_level(vn::GenPersonSegmentationRequestQualityLevel::Balanced);
    request
}

impl Session {
    fn new() -> Self {
        Self {
            handler: vn::SequenceRequestHandler::new(),
            request: Request::new(),
            input: None,
            cleanup: Cleanup::default(),
            instance_areas: Vec::new(),
        }
    }

    fn reset(&mut self) {
        self.handler = vn::SequenceRequestHandler::new();
        self.request = Request::new();
        self.cleanup.previous.clear();
    }

    fn segment(&mut self, job: &mut VisionJob) -> Result<(), String> {
        let input = match &job.input {
            VisionInput::PixelBuffer(buffer) => buffer.0.clone(),
            VisionInput::Pixels => {
                let (width, height) = (job.dimensions.0 as usize, job.dimensions.1 as usize);
                if job.bgra.len() < width * height * 4 || width == 0 || height == 0 {
                    return Err("invalid segmentation input".into());
                }
                let input = match &mut self.input {
                    Some(input) if input.width() == width && input.height() == height => input,
                    slot => slot.insert(create_input(width, height)?),
                };
                write_bgra(input, &job.bgra, width, height)?;
                input.clone()
            }
            VisionInput::None => return Err("missing segmentation input".into()),
        };

        let requests = ns::Array::<vn::Request>::from_slice(&[self.request.as_request()]);
        self.handler
            .perform_on_cv_pixel_buf(&requests, &input)
            .map_err(|error| format!("Vision person segmentation failed: {error:?}"))?;
        match &self.request {
            Request::Segmentation(request) => {
                let results = request.results().ok_or("Vision returned no segmentation")?;
                let observation = results
                    .get(0)
                    .map_err(|_| "Vision returned no segmentation".to_string())?;
                read_mask(
                    observation.pixel_buffer(),
                    &mut self.cleanup.mask,
                    &mut job.mask_dimensions,
                )?;
            }
            Request::Instances(request) => {
                let observation = request.results().and_then(|results| {
                    results
                        .get(0)
                        .ok()
                        .map(|observation| observation.retained())
                });
                match observation {
                    Some(observation) => primary_person_mask(
                        &observation,
                        &mut self.instance_areas,
                        &mut self.cleanup.mask,
                        &mut job.mask_dimensions,
                    )?,
                    None => {
                        // Nobody in frame: an empty mask at the last size.
                        if job.mask_dimensions == (0, 0) {
                            job.mask_dimensions = (512, 384);
                        }
                        let (width, height) = job.mask_dimensions;
                        self.cleanup.mask.clear();
                        self.cleanup.mask.resize((width * height) as usize, 0.0);
                    }
                }
            }
        }
        self.cleanup.motion_frame(&input, job.mask_dimensions)?;
        self.cleanup.finish(job.mask_dimensions, &mut job.mask);
        Ok(())
    }
}

impl Cleanup {
    /// Samples the analysed frame on the mask's grid, which is what the
    /// motion-adaptive smoothing compares between frames.
    fn motion_frame(
        &mut self,
        frame: &cv::PixelBuf,
        (width, height): (u32, u32),
    ) -> Result<(), String> {
        let (source_width, source_height) = (frame.width(), frame.height());
        let motion = &mut self.motion;
        motion.clear();
        with_locked_base(
            &mut frame.retained(),
            cv::pixel_buffer::LockFlags::READ_ONLY,
            |base, stride| {
                if stride < source_width * 4 {
                    return Err("segmentation frame is not addressable".into());
                }
                for y in 0..height as usize {
                    let row = unsafe { base.add(y * source_height / height as usize * stride) };
                    for x in 0..width as usize {
                        let pixel = unsafe {
                            std::slice::from_raw_parts(
                                row.add(x * source_width / width as usize * 4),
                                4,
                            )
                        };
                        motion.extend_from_slice(pixel);
                    }
                }
                Ok(())
            },
        )
    }

    fn finish(&mut self, dimensions: (u32, u32), output: &mut Vec<u8>) {
        let (refiner, resized) = match &mut self.refiner {
            Some((current, refiner)) if *current == dimensions => (refiner, false),
            slot => (
                &mut slot
                    .insert((
                        dimensions,
                        MaskRefiner::new(dimensions.0 as usize, dimensions.1 as usize),
                    ))
                    .1,
                true,
            ),
        };
        // Pockets up to 0.75% of the frame: logos, glare, jewellery.
        let max_hole = self.mask.len() * 3 / 400;
        refiner.fill_holes(&mut self.mask, max_hole);
        let smooth = !resized && self.previous.len() == self.mask.len();
        refiner.refine(&mut self.mask, &self.previous, &mut self.motion, smooth);
        self.previous.clear();
        self.previous.extend_from_slice(&self.mask);
        output.clear();
        output.extend(self.mask.iter().map(|value| (value * 255.0).round() as u8));
    }
}

fn create_input(width: usize, height: usize) -> Result<arc::R<cv::PixelBuf>, String> {
    let properties = cf::Dictionary::new();
    let attributes = cf::Dictionary::with_keys_values(
        &[cv::pixel_buffer::keys::io_surf_props().as_ref()],
        &[properties.as_ref()],
    )
    .ok_or("segmentation input attributes")?;
    cv::PixelBuf::new(width, height, cv::PixelFormat::_32_BGRA, Some(&attributes))
        .map_err(|error| format!("segmentation input buffer: {error:?}"))
}

fn write_bgra(
    buffer: &mut cv::PixelBuf,
    bgra: &[u8],
    width: usize,
    height: usize,
) -> Result<(), String> {
    let row = width * 4;
    with_locked_base(
        buffer,
        cv::pixel_buffer::LockFlags::DEFAULT,
        |base, stride| {
            if stride < row {
                return Err("segmentation input is not addressable".into());
            }
            for (y, source) in bgra.chunks_exact(row).take(height).enumerate() {
                unsafe {
                    std::ptr::copy_nonoverlapping(source.as_ptr(), base.add(y * stride), row)
                };
            }
            Ok(())
        },
    )
}

/// The soft mask of the largest person, which for a camera bubble is the
/// presenter.
fn primary_person_mask(
    observation: &InstanceMaskObservation,
    areas: &mut Vec<usize>,
    output: &mut Vec<f32>,
    dimensions: &mut (u32, u32),
) -> Result<(), String> {
    let labels = observation.instance_mask();
    let (width, height) = (labels.width(), labels.height());
    areas.clear();
    areas.resize(256, 0);
    with_locked_base(
        &mut labels.retained(),
        cv::pixel_buffer::LockFlags::READ_ONLY,
        |base, stride| {
            if stride < width {
                return Err("Vision instance mask is not addressable".into());
            }
            for y in 0..height {
                let row = unsafe { std::slice::from_raw_parts(base.add(y * stride), width) };
                for &label in row {
                    areas[usize::from(label)] += 1;
                }
            }
            Ok(())
        },
    )?;
    let Some(primary) = (1..areas.len())
        .filter(|&label| areas[label] > 0)
        .max_by_key(|&label| areas[label])
    else {
        output.clear();
        output.resize(width * height, 0.0);
        *dimensions = (width as u32, height as u32);
        return Ok(());
    };
    let instances = ns::IndexSet::with_index(primary);
    let mut error = None;
    let mask = unsafe { observation.generate_mask_err(&instances, &mut error) }
        .ok_or_else(|| format!("Vision instance mask failed: {error:?}"))?;
    read_mask(mask, output, dimensions)
}

fn read_mask(
    mask: &cv::PixelBuf,
    output: &mut Vec<f32>,
    dimensions: &mut (u32, u32),
) -> Result<(), String> {
    let format = mask.pixel_format();
    let bytes_per_sample = if format == cv::PixelFormat::ONE_COMPONENT_8 {
        1
    } else if format == cv::PixelFormat::ONE_COMPONENT_F32 {
        4
    } else {
        return Err(format!("unexpected Vision mask format {format:?}"));
    };
    let (width, height) = (mask.width(), mask.height());
    output.clear();
    with_locked_base(
        &mut mask.retained(),
        cv::pixel_buffer::LockFlags::READ_ONLY,
        |base, stride| {
            if stride < width * bytes_per_sample {
                return Err("Vision mask is not addressable".into());
            }
            for y in 0..height {
                let row = unsafe { base.add(y * stride) };
                if bytes_per_sample == 1 {
                    let row = unsafe { std::slice::from_raw_parts(row, width) };
                    output.extend(row.iter().map(|&value| f32::from(value) / 255.0));
                } else {
                    let row = unsafe { std::slice::from_raw_parts(row.cast::<f32>(), width) };
                    output.extend(row.iter().map(|value| value.clamp(0.0, 1.0)));
                }
            }
            Ok(())
        },
    )?;
    *dimensions = (width as u32, height as u32);
    Ok(())
}

fn with_locked_base<R>(
    buffer: &mut cv::PixelBuf,
    flags: cv::pixel_buffer::LockFlags,
    body: impl FnOnce(*mut u8, usize) -> Result<R, String>,
) -> Result<R, String> {
    unsafe {
        buffer
            .lock_base_addr(flags)
            .result()
            .map_err(|error| format!("lock pixel buffer: {error:?}"))?;
        let base = CVPixelBufferGetBaseAddress(buffer);
        let stride = CVPixelBufferGetBytesPerRow(buffer);
        let result = if base.is_null() {
            Err("pixel buffer has no base address".into())
        } else {
            body(base, stride)
        };
        let _ = buffer.unlock_lock_base_addr(flags);
        result
    }
}

impl VisionSegmenter {
    pub fn new() -> anyhow::Result<Self> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (requests, request_rx) = mpsc::channel::<Message>();
        let (result_tx, results) = mpsc::channel::<VisionJob>();

        let worker = thread::Builder::new()
            .name("cap-vision-segmentation".into())
            .spawn(move || {
                // A frame is waiting on every mask: keep this thread on the
                // performance cores rather than letting it drift to the
                // efficiency cores at default QoS.
                unsafe {
                    libc::pthread_set_qos_class_self_np(
                        libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE,
                        0,
                    );
                }
                // Probe once so an unavailable request fails construction and
                // the caller falls back to ONNX instead of failing every frame.
                let mut session = Session::new();
                let mut probe = VisionJob::new();
                probe.input = VisionInput::Pixels;
                probe.bgra = vec![0; 64 * 64 * 4];
                probe.dimensions = (64, 64);
                if let Err(error) = objc::ar_pool(|| session.segment(&mut probe)) {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
                session.reset();
                let _ = ready_tx.send(Ok(()));
                while let Ok(message) = request_rx.recv() {
                    match message {
                        Message::Reset => session.reset(),
                        Message::Segment(mut job) => {
                            job.result = objc::ar_pool(|| session.segment(&mut job));
                            job.input = VisionInput::None;
                            if result_tx.send(job).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
            .context("Failed to start the Vision segmentation thread")?;

        match ready_rx.recv() {
            Ok(Ok(())) => {
                tracing::info!("Camera background segmentation: Apple Vision person segmentation");
                Ok(Self {
                    requests: Some(requests),
                    results,
                    idle: Some(VisionJob::new()),
                    in_flight: false,
                    generation: 0,
                    worker: Some(worker),
                })
            }
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(anyhow::anyhow!(error))
            }
            Err(_) => {
                let _ = worker.join();
                Err(anyhow::anyhow!(
                    "Vision segmentation thread exited during startup"
                ))
            }
        }
    }

    /// Clears temporal state so a seek or a new camera does not blend into
    /// the previous scene. A mask still in flight is discarded on arrival.
    pub fn reset(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        if let Some(requests) = &self.requests {
            let _ = requests.send(Message::Reset);
        }
    }

    pub fn is_busy(&self) -> bool {
        self.in_flight
    }

    pub fn submit_pixels(&mut self, bgra: &[u8], dimensions: (u32, u32)) -> anyhow::Result<()> {
        let mut job = self.take_idle()?;
        job.bgra.clear();
        job.bgra.extend_from_slice(bgra);
        job.dimensions = dimensions;
        job.input = VisionInput::Pixels;
        self.send(job)
    }

    pub fn submit_pixel_buffer(&mut self, buffer: SharedPixelBuffer) -> anyhow::Result<()> {
        let mut job = self.take_idle()?;
        job.dimensions = (buffer.0.width() as u32, buffer.0.height() as u32);
        job.input = VisionInput::PixelBuffer(buffer);
        self.send(job)
    }

    /// The finished mask and its dimensions, if one has arrived. `wait`
    /// blocks until the in-flight frame completes.
    pub fn collect(&mut self, wait: bool) -> Option<anyhow::Result<VisionMask<'_>>> {
        if !self.in_flight {
            return None;
        }
        let job = if wait {
            match self.results.recv() {
                Ok(job) => job,
                Err(_) => {
                    self.in_flight = false;
                    return Some(Err(anyhow::anyhow!("Vision segmentation thread stopped")));
                }
            }
        } else {
            match self.results.try_recv() {
                Ok(job) => job,
                Err(mpsc::TryRecvError::Empty) => return None,
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.in_flight = false;
                    return Some(Err(anyhow::anyhow!("Vision segmentation thread stopped")));
                }
            }
        };
        self.in_flight = false;
        let stale = job.generation != self.generation;
        let job = self.idle.insert(job);
        if stale {
            return None;
        }
        Some(match std::mem::replace(&mut job.result, Ok(())) {
            Ok(()) => Ok((&job.mask, job.mask_dimensions)),
            Err(error) => Err(anyhow::anyhow!(error)),
        })
    }

    fn take_idle(&mut self) -> anyhow::Result<VisionJob> {
        anyhow::ensure!(!self.in_flight, "Vision segmentation is busy");
        Ok(self.idle.take().unwrap_or_else(VisionJob::new))
    }

    fn send(&mut self, mut job: VisionJob) -> anyhow::Result<()> {
        job.generation = self.generation;
        self.requests
            .as_ref()
            .context("Vision segmentation thread stopped")?
            .send(Message::Segment(job))
            .map_err(|_| anyhow::anyhow!("Vision segmentation thread stopped"))?;
        self.in_flight = true;
        Ok(())
    }
}

impl Drop for VisionSegmenter {
    fn drop(&mut self) {
        self.requests = None;
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub fn input_dimensions(width: u32, height: u32) -> (u32, u32) {
    let (max_width, max_height) = MAX_INPUT_DIMENSIONS;
    let (long, short) = if width >= height {
        (max_width, max_height)
    } else {
        (max_height, max_width)
    };
    let scale = (f64::from(long) / f64::from(width.max(1)))
        .min(f64::from(short) / f64::from(height.max(1)))
        .min(1.0);
    (
        ((f64::from(width) * scale).round() as u32).max(1),
        ((f64::from(height) * scale).round() as u32).max(1),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_is_bounded_and_keeps_aspect() {
        assert_eq!(input_dimensions(1920, 1080), (960, 540));
        assert_eq!(input_dimensions(3840, 2160), (960, 540));
        assert_eq!(input_dimensions(1080, 1920), (540, 960));
        assert_eq!(input_dimensions(640, 480), (640, 480));
        assert_eq!(input_dimensions(1440, 1080), (720, 540));
    }

    #[test]
    #[ignore = "requires macOS Vision"]
    fn segments_asynchronously_and_discards_masks_from_before_a_reset() {
        let mut segmenter = VisionSegmenter::new().unwrap();
        let frame = vec![128; 320 * 180 * 4];
        segmenter.submit_pixels(&frame, (320, 180)).unwrap();
        assert!(segmenter.is_busy());
        assert!(segmenter.submit_pixels(&frame, (320, 180)).is_err());
        let (mask, (width, height)) = segmenter.collect(true).unwrap().unwrap();
        assert_eq!(mask.len(), (width * height) as usize);
        assert!(!segmenter.is_busy());

        segmenter.submit_pixels(&frame, (320, 180)).unwrap();
        segmenter.reset();
        assert!(segmenter.collect(true).is_none());
        assert!(!segmenter.is_busy());
    }
}
