use std::ffi::c_void;

use cidre::{arc, cv, ns, objc, vn};

use crate::FacePose;

pub struct FaceTracker {
    landmarks_request: arc::R<vn::Request>,
}

impl FaceTracker {
    pub fn new() -> Self {
        let landmarks_request = create_landmarks_request();
        Self { landmarks_request }
    }

    pub fn track(&mut self, rgba_data: &[u8], width: u32, height: u32) -> FacePose {
        match self.track_inner(rgba_data, width, height) {
            Some(pose) => pose,
            None => FacePose::default(),
        }
    }

    fn track_inner(&mut self, rgba_data: &[u8], width: u32, height: u32) -> Option<FacePose> {
        let w = width as usize;
        let h = height as usize;
        let src_row_bytes = w * 4;
        let expected_len = src_row_bytes * h;
        if rgba_data.len() < expected_len {
            tracing::warn!(
                "RGBA data too small: {} < {}",
                rgba_data.len(),
                expected_len
            );
            return None;
        }

        let mut pixel_buf = cv::PixelBuf::new(w, h, cv::PixelFormat::_32_BGRA, None).ok()?;

        unsafe {
            pixel_buf
                .lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
                .result()
                .ok()?;
        }

        let dst_base = unsafe { CVPixelBufferGetBaseAddress(&pixel_buf) };
        let dst_row_bytes = unsafe { CVPixelBufferGetBytesPerRow(&pixel_buf) };

        if dst_base.is_null() {
            unsafe {
                pixel_buf.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT);
            }
            return None;
        }

        unsafe {
            rgba_to_bgra_copy(
                rgba_data,
                dst_base as *mut u8,
                w,
                h,
                src_row_bytes,
                dst_row_bytes,
            );
        }

        unsafe {
            pixel_buf.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT);
        }

        let handler = vn::ImageRequestHandler::with_cv_pixel_buf(&pixel_buf, None)?;

        let mut rect_request = vn::DetectFaceRectanglesRequest::new();
        rect_request.set_revision(vn::DetectFaceRectanglesRequest::REVISION_3);

        let requests =
            ns::Array::<vn::Request>::from_slice(&[&rect_request, &self.landmarks_request]);
        if handler.perform(&requests).is_err() {
            return None;
        }

        let landmarks_results: Option<arc::R<ns::Array<vn::FaceObservation>>> = unsafe {
            let raw: *const vn::Request = &*self.landmarks_request;
            let face_req: &vn::DetectFaceRectanglesRequest =
                &*(raw as *const vn::DetectFaceRectanglesRequest);
            face_req.results()
        };

        let face_obs = landmarks_results
            .as_ref()
            .filter(|r| !r.is_empty())
            .and_then(|r| r.get(0).ok());

        let face_obs = match face_obs {
            Some(obs) => obs,
            None => {
                let results = rect_request.results()?;
                if results.is_empty() {
                    return None;
                }
                results.get(0).ok()?
            }
        };

        let head_roll = face_obs.roll().map(|n| n.as_f32()).unwrap_or(0.0);
        let head_yaw = face_obs.yaw().map(|n| n.as_f32()).unwrap_or(0.0);
        let head_pitch = face_obs.pitch().map(|n| n.as_f32()).unwrap_or(0.0);
        let confidence = face_obs.confidence();

        let (mouth_open, left_eye_open, right_eye_open) = extract_landmark_features(&face_obs);

        Some(FacePose {
            head_pitch,
            head_yaw,
            head_roll,
            mouth_open,
            left_eye_open,
            right_eye_open,
            confidence,
        })
    }
}

fn create_landmarks_request() -> arc::R<vn::Request> {
    unsafe {
        let cls = objc::objc_getClass(b"VNDetectFaceLandmarksRequest\0".as_ptr());
        match cls {
            Some(cls) => {
                let cls: &objc::Class<vn::Request> = std::mem::transmute(cls);
                cls.new()
            }
            None => {
                tracing::warn!(
                    "VNDetectFaceLandmarksRequest not found, falling back to rectangles"
                );
                let req = vn::DetectFaceRectanglesRequest::new();
                std::mem::transmute(req)
            }
        }
    }
}

fn extract_landmark_features(face: &vn::FaceObservation) -> (f32, f32, f32) {
    let landmarks = match face.landmarks() {
        Some(l) => l,
        None => return (0.0, 1.0, 1.0),
    };

    let mouth_open = compute_mouth_openness(&landmarks);
    let left_eye_open = compute_eye_openness(landmarks.left_eye());
    let right_eye_open = compute_eye_openness(landmarks.right_eye());

    (mouth_open, left_eye_open, right_eye_open)
}

fn compute_mouth_openness(landmarks: &vn::FaceLandmarks2d) -> f32 {
    let inner_lips = match landmarks.inner_lips() {
        Some(region) => region,
        None => return 0.0,
    };

    let points = inner_lips.normalized_points();
    if points.len() < 6 {
        return 0.0;
    }

    let top = points[2];
    let bottom = points[points.len() - 2];
    let vertical = (top.y - bottom.y).abs() as f32;

    let left = points[0];
    let right = points[points.len() / 2];
    let horizontal = (right.x - left.x).abs() as f32;

    if horizontal < 1e-6 {
        return 0.0;
    }

    let ratio = vertical / horizontal;
    (ratio * 3.0).clamp(0.0, 1.0)
}

fn compute_eye_openness(eye_region: Option<arc::R<vn::FaceLandmarkRegion2d>>) -> f32 {
    let region = match eye_region {
        Some(r) => r,
        None => return 1.0,
    };

    let points = region.normalized_points();
    if points.len() < 6 {
        return 1.0;
    }

    let half = points.len() / 2;
    let top = points[half / 2];
    let bottom = points[half + half / 2];
    let vertical = (top.y - bottom.y).abs() as f32;

    let left = points[0];
    let right = points[half];
    let horizontal = (right.x - left.x).abs() as f32;

    if horizontal < 1e-6 {
        return 1.0;
    }

    let ratio = vertical / horizontal;
    (ratio * 4.0).clamp(0.0, 1.0)
}

unsafe fn rgba_to_bgra_copy(
    src: &[u8],
    dst: *mut u8,
    width: usize,
    height: usize,
    src_row_bytes: usize,
    dst_row_bytes: usize,
) {
    for y in 0..height {
        let src_row = &src[y * src_row_bytes..];
        let dst_row = unsafe { dst.add(y * dst_row_bytes) };
        for x in 0..width {
            let si = x * 4;
            let di = x * 4;
            let r = src_row[si];
            let g = src_row[si + 1];
            let b = src_row[si + 2];
            let a = src_row[si + 3];
            unsafe {
                *dst_row.add(di) = b;
                *dst_row.add(di + 1) = g;
                *dst_row.add(di + 2) = r;
                *dst_row.add(di + 3) = a;
            }
        }
    }
}

unsafe extern "C-unwind" {
    fn CVPixelBufferGetBaseAddress(pixel_buffer: &cv::PixelBuf) -> *mut c_void;
    fn CVPixelBufferGetBytesPerRow(pixel_buffer: &cv::PixelBuf) -> usize;
}
