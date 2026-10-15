#![cfg(target_os = "macos")]

use cap_rendering::{create_wgpu_instance_sync, yuv_converter::YuvToRgbaConverter};
use cidre::{arc, cf, cv};

const SIZE: u32 = 16;
const ROW_BYTES: u32 = 256;
const FRAME_BYTES: u64 = (ROW_BYTES * SIZE) as u64;

fn pool() -> arc::R<cv::PixelBufPool> {
    let format = cv::PixelFormat::_420V.to_cf_number();
    let dimension = cf::Number::from_usize(SIZE as usize);
    let surface = cf::Dictionary::new();
    let keys: [&cf::Type; 5] = [
        cv::pixel_buffer::keys::pixel_format().as_ref(),
        cv::pixel_buffer::keys::width().as_ref(),
        cv::pixel_buffer::keys::height().as_ref(),
        cv::pixel_buffer::keys::io_surf_props().as_ref(),
        cv::pixel_buffer::keys::metal_compatibility().as_ref(),
    ];
    let values: [&cf::Type; 5] = [
        format.as_ref(),
        dimension.as_ref(),
        dimension.as_ref(),
        surface.as_ref(),
        cf::Boolean::value_true().as_ref(),
    ];
    let attributes = cf::Dictionary::with_keys_values(&keys, &values).unwrap();
    cv::PixelBufPool::new(None, Some(attributes.as_ref())).unwrap()
}

fn fill(buffer: &mut cv::PixelBuf, luma: u8) {
    unsafe {
        buffer
            .lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
            .result()
            .unwrap();
        for plane in 0..2 {
            let length = buffer.plane_bytes_per_row(plane) * buffer.plane_height(plane);
            std::ptr::write_bytes(
                buffer.plane_base_address(plane) as *mut u8,
                if plane == 0 { luma } else { 128 },
                length,
            );
        }
        buffer.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT);
    }
}

#[test]
fn conversions_keep_recycled_pixel_buffers_until_submission() {
    let instance = create_wgpu_instance_sync();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::LowPower,
        force_fallback_adapter: false,
        compatible_surface: None,
    }))
    .unwrap();
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).unwrap();
    let mut converter = YuvToRgbaConverter::new(&device);
    let pool = pool();
    let lumas = [32, 80, 128, 200];
    let output = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("IOSurface lifetime readback"),
        size: FRAME_BYTES * lumas.len() as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    for (index, luma) in lumas.into_iter().enumerate() {
        let mut source = pool.pixel_buf().unwrap();
        fill(&mut source, luma);
        converter
            .convert_nv12_from_iosurface_to_encoder(&device, &mut encoder, &source)
            .unwrap();
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: converter.output_texture().unwrap(),
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &output,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: index as u64 * FRAME_BYTES,
                    bytes_per_row: Some(ROW_BYTES),
                    rows_per_image: Some(SIZE),
                },
            },
            wgpu::Extent3d {
                width: SIZE,
                height: SIZE,
                depth_or_array_layers: 1,
            },
        );
    }
    let mut next = pool.pixel_buf().unwrap();
    fill(&mut next, 235);
    queue.submit([encoder.finish()]);
    let (sender, receiver) = std::sync::mpsc::channel();
    output
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            sender.send(result).unwrap();
        });
    device.poll(wgpu::PollType::Wait).unwrap();
    receiver.recv().unwrap().unwrap();
    let bytes = output.slice(..).get_mapped_range();
    let mut wrong = Vec::new();
    for (index, luma) in lumas.into_iter().enumerate() {
        let expected = (f32::from(luma) - 16.0) * 255.0 / 219.0;
        let start = index * FRAME_BYTES as usize;
        let bad = (0..SIZE as usize)
            .flat_map(|row| {
                let row = start + row * ROW_BYTES as usize;
                bytes[row..row + SIZE as usize * 4].chunks_exact(4)
            })
            .find(|pixel| {
                pixel[3] != 255
                    || pixel[..3]
                        .iter()
                        .any(|&channel| (f32::from(channel) - expected).abs() >= 3.0)
            });
        if let Some(pixel) = bad {
            wrong.push(format!(
                "source {index} (luma {luma}, expected grey {expected:.1}) rendered {pixel:?}"
            ));
        }
    }
    drop(bytes);
    settle(&wrong);
}

const CASE: &str = "native/rendering/iosurface-source-lifetime/recycled-pool";
const CLASS: &str = "recycled-source";
const EXPECTATIONS: &str = "crates/rendering/tests/expectations.toml";

/// Judges the result against the strict expectations file and writes the
/// case record, like every engine verification suite.
fn settle(wrong: &[String]) {
    use cap_verify_expect::{Observed, Outcome, Ran, Record, judge, load, platform};
    let xfails =
        load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/expectations.toml"));
    let ran = Ran::from([(CASE.to_string(), None)]);
    let mut observed = Observed::new();
    if !wrong.is_empty() {
        observed.insert((CASE.to_string(), CLASS.to_string()), Default::default());
    }
    let verdict = judge(&xfails, platform(), &ran, &observed);
    let outcome = if !verdict.unexpected.is_empty() {
        Outcome::Fail
    } else if !verdict.fixed.is_empty() {
        Outcome::Xpass
    } else if !wrong.is_empty() {
        Outcome::Xfail
    } else {
        Outcome::Pass
    };
    let summary = if wrong.is_empty() {
        "every source rendered its own picture after the pool recycled it".to_string()
    } else {
        format!(
            "pool recycled a source before the GPU sampled it: {}",
            wrong.join("; ")
        )
    };
    let repro =
        "cargo test -p cap-rendering --test iosurface-source-lifetime -- --nocapture".to_string();
    let record = Record {
        suite: "cap-rendering-native".into(),
        expectations: EXPECTATIONS.into(),
        case: CASE.into(),
        platform: platform().into(),
        tier: std::env::var("CAP_VERIFY_TIER").unwrap_or_else(|_| "fast".into()),
        outcome,
        failures: observed
            .keys()
            .map(|(_, class)| (class.clone(), Default::default()))
            .collect(),
        seeds_ran: None,
        unobserved: Default::default(),
        problems: if wrong.is_empty() {
            Default::default()
        } else {
            [(CLASS.to_string(), summary.clone())].into()
        },
        summary: summary.clone(),
        repro: repro.clone(),
        seconds: 0.0,
    };
    cap_verify_expect::write_records(&[(record, serde_json::json!({}))]);
    eprintln!("[cap-verify] {outcome:?} {CASE}: {summary}");
    if let Some(fixed) = verdict.fixed.first() {
        panic!("{}\n  repro: {repro}", fixed.message(EXPECTATIONS));
    }
    assert!(
        verdict.unexpected.is_empty(),
        "{CASE} failed ({CLASS}): {summary}\n  repro: {repro}"
    );
}
