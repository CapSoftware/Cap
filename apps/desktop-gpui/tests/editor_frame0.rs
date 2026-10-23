//! E0 — editor dependency reconciliation, proved by rendering a real frame.
//!
//! This is the dependency spike for the editor units: it links the same stack
//! the editor window will (`cap-editor` → `cap-rendering` → wgpu 25 + ffmpeg)
//! and drives it end to end, headlessly, with no gpui window and no Tauri.
//!
//! What it exercises is the *production* seam, not a shortcut:
//!
//! * `EditorInstance::new_with_audio_output` — the real constructor, with the
//!   headless audio sink substituted for the cpal output so a test machine
//!   (or CI) never opens a device.
//! * `preview_tx` — the scrub channel. **`seek_to` renders nothing**; it only
//!   moves `state.playhead_position`. Frames come from this channel, through
//!   the preview renderer, out of the `frame_cb`. Getting that wrong is the
//!   classic "the editor opened but the canvas is black" bug.
//! * `frame_cb` — `Box<dyn FnMut(EditorFrameOutput, FrameLayout) + Send>`, the
//!   plain Rust callback the Tauri app wraps in a websocket and gpui will not.
//! * `RenderedFrame` un-padding — the buffer is row-padded to wgpu's 256-byte
//!   `COPY_BYTES_PER_ROW_ALIGNMENT`, so `data.len() != width * height * 4` and
//!   a naive `from_raw` gives a skewed image.
//!
//! The project is opened from a **copy**: `EditorInstance::new` writes
//! `project-config.json` back when the timeline or the clip offsets need
//! synthesising, so pointing it at a user's library would mutate it.
//!
//! Run: `cargo test --test editor_frame0 -- --nocapture`
//! Skips (rather than fails) when no studio `.cap` is available, so a checkout
//! without a recordings library still gets a green `cargo test`.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use cap_editor::{AudioOutput, EditorFrameOutput, EditorInstance};
use cap_project::{RecordingMeta, RecordingMetaInner, XY};
use cap_rendering::{FrameLayout, ProjectUniforms, RenderedFrame};

/// The Tauri editor's own preview numbers, so the smoke renders at exactly the
/// size the editor window will: `EDITOR_PREVIEW_FPS` / `EDITOR_OUTPUT_SIZE` at
/// the default 65 % preview scale, width aligned to 4 and height to 2
/// (`apps/desktop/src-tauri/src/lib.rs:146-157`).
const PREVIEW_FPS: u32 = 60;
const OUTPUT_SIZE: XY<u32> = XY { x: 1920, y: 1080 };
const PREVIEW_SCALE: f32 = 0.65;

fn preview_resolution_base() -> XY<u32> {
    let width = ((OUTPUT_SIZE.x as f32 * PREVIEW_SCALE).round() as u32).div_ceil(4) * 4;
    let height = ((OUTPUT_SIZE.y as f32 * PREVIEW_SCALE).round() as u32).div_ceil(2) * 2;
    XY::new(width, height)
}

/// Both tests decode the same source bundle; running them concurrently makes
/// AVAssetReader fail to open the file it is already reading in the other
/// test, so they take turns.
static E0_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A studio `.cap` to render. `CAP_GPUI_E0_PROJECT` wins; otherwise the newest
/// bundle on the Desktop that has a baked `screenshots/display.jpg` (i.e. one
/// the shipping app finished normally) and parses as a studio recording.
fn locate_project() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("CAP_GPUI_E0_PROJECT") {
        let path = PathBuf::from(explicit);
        return path.is_dir().then_some(path);
    }

    let desktop = PathBuf::from(std::env::var_os("HOME")?).join("Desktop");
    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(desktop)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().is_some_and(|ext| ext == "cap")
                && path.join("screenshots/display.jpg").is_file()
                && is_studio(path)
        })
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok()?;
            Some((meta.created().or_else(|_| meta.modified()).ok()?, path))
        })
        .collect();

    candidates.sort_by_key(|(created, _)| std::cmp::Reverse(*created));
    candidates.into_iter().next().map(|(_, path)| path)
}

/// The editor rejects anything that is not `RecordingMetaInner::Studio`
/// (`crates/editor/src/editor_instance.rs:145-147`), so filter here rather
/// than picking an instant recording and reporting it as a failure.
fn is_studio(path: &Path) -> bool {
    RecordingMeta::load_for_project(path)
        .is_ok_and(|meta| matches!(meta.inner, RecordingMetaInner::Studio(_)))
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// `RenderedFrame.data` is row-padded to wgpu's 256-byte copy alignment. Walk
/// it a padded row at a time and keep `width * 4` bytes of each, which is what
/// every consumer in the repo does (`crates/export/src/preview.rs:224-232`).
fn unpad(frame: &RenderedFrame) -> Vec<u8> {
    let row_bytes = frame.width as usize * 4;
    let mut tight = Vec::with_capacity(row_bytes * frame.height as usize);
    for row in frame.data.chunks(frame.padded_bytes_per_row as usize) {
        tight.extend_from_slice(&row[..row_bytes]);
    }
    tight
}

#[test]
fn renders_frame_zero_of_a_real_studio_project() {
    let _serial = E0_SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .try_init();

    let Some(source) = locate_project() else {
        eprintln!(
            "skipping: no studio .cap with screenshots/display.jpg found \
             (set CAP_GPUI_E0_PROJECT to point at one)"
        );
        return;
    };

    let out_dir = std::env::var_os("CAP_GPUI_E0_OUT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_TARGET_TMPDIR")));
    std::fs::create_dir_all(&out_dir).expect("create output dir");
    let png_path = out_dir.join("e0-frame0.png");

    // Work on a copy: instance construction persists a synthesised timeline and
    // clip offsets into the bundle.
    let work_dir = out_dir.join("e0-project.cap");
    let _ = std::fs::remove_dir_all(&work_dir);
    copy_dir(&source, &work_dir).expect("copy .cap bundle");

    eprintln!("e0: source project {}", source.display());
    eprintln!("e0: working copy   {}", work_dir.display());

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    let resolution_base = preview_resolution_base();
    assert_eq!(
        (resolution_base.x, resolution_base.y),
        (1248, 702),
        "preview resolution base must match the Tauri editor's default"
    );

    let (frame_tx, frame_rx) = flume::unbounded::<(RenderedFrame, FrameLayout)>();

    let (frame, layout, expected_size, project_duration) = runtime.block_on(async move {
        // The headless sink keeps the real audio pipeline running (mixing,
        // timing) while never touching an output device.
        let audio_output = Arc::new(AudioOutput::new_headless(Box::new(|_samples, _at| {})));

        let instance = EditorInstance::new_with_audio_output(
            work_dir.clone(),
            |_state| {},
            Box::new(move |output, layout| {
                if let EditorFrameOutput::Rgba(frame) = output {
                    let _ = frame_tx.send((frame, layout));
                }
            }),
            // `None` = let cap-rendering create its own wgpu device. gpui on
            // macOS is Metal-direct and exposes no wgpu device to share, so
            // two GPU contexts in-process is the expected shape (the Tauri app
            // has the same two).
            None,
            audio_output,
        )
        .await
        .expect("EditorInstance::new");

        let config = instance.project_config.1.borrow().clone();
        let expected_size = ProjectUniforms::get_output_size(
            &instance.render_constants.options,
            &config,
            resolution_base,
        );
        let duration = config.timeline.as_ref().map_or(0.0, |t| t.duration());

        // The one call that actually produces a picture. `seek_to` /
        // `set_playhead_position` would move the playhead and render nothing.
        instance
            .preview_tx
            .send_modify(|v| *v = Some((0, PREVIEW_FPS, resolution_base)));

        let (frame, layout) = tokio::time::timeout(Duration::from_secs(180), frame_rx.recv_async())
            .await
            .expect("timed out waiting for frame 0")
            .expect("frame channel closed before a frame arrived");

        instance.dispose().await;

        (frame, layout, expected_size, duration)
    });

    eprintln!(
        "e0: frame {} — {}x{} padded_bytes_per_row={} data={} bytes, layout display={:?} camera={:?} output_size={:?}, timeline duration {:.3}s",
        frame.frame_number,
        frame.width,
        frame.height,
        frame.padded_bytes_per_row,
        frame.data.len(),
        layout.display,
        layout.camera,
        layout.output_size,
        project_duration,
    );

    assert_eq!(
        (frame.width, frame.height),
        expected_size,
        "rendered size must be ProjectUniforms::get_output_size for this project's config"
    );
    assert_eq!(
        layout.output_size,
        [frame.width, frame.height],
        "FrameLayout must describe the frame it arrived with"
    );
    assert!(
        frame.padded_bytes_per_row >= frame.width * 4,
        "padded stride must cover a full row"
    );
    assert_eq!(
        frame.data.len(),
        frame.padded_bytes_per_row as usize * frame.height as usize,
        "buffer must be exactly height padded rows"
    );

    let pixels = unpad(&frame);
    assert_eq!(
        pixels.len(),
        frame.width as usize * frame.height as usize * 4
    );

    let image = image::RgbaImage::from_raw(frame.width, frame.height, pixels)
        .expect("frame buffer into RgbaImage");
    image.save(&png_path).expect("write PNG");
    eprintln!("e0: wrote {}", png_path.display());

    // Non-uniform content: a stuck pipeline (no decode, cleared target, all
    // alpha) produces a single flat colour, which every dimension check above
    // would still pass.
    let mut min = [255u8; 3];
    let mut max = [0u8; 3];
    let mut distinct = std::collections::HashSet::new();
    for px in image.pixels() {
        for c in 0..3 {
            min[c] = min[c].min(px.0[c]);
            max[c] = max[c].max(px.0[c]);
        }
        if distinct.len() < 4096 {
            distinct.insert([px.0[0], px.0[1], px.0[2]]);
        }
    }
    let spread: u16 = (0..3).map(|c| (max[c] - min[c]) as u16).sum();
    eprintln!(
        "e0: channel min {min:?} max {max:?}, {}+ distinct colours",
        distinct.len()
    );

    assert!(
        spread > 30,
        "frame is near-uniform (min {min:?}, max {max:?}) — the render produced a flat fill"
    );
    assert!(
        distinct.len() > 64,
        "only {} distinct colours — not a real decoded frame",
        distinct.len()
    );
}

/// The zero-copy preview path: render frame 0 once through the CPU `Rgba`
/// readback and once through `BgraSurface` (the wgpu blit into an
/// IOSurface-backed CVPixelBuffer that gpui paints directly), and require the
/// pixels to agree. The blit is a plain copy — the BGRA byte order is handled
/// by the texture unit — so any real divergence means the surface path is
/// rendering something other than what the editor produces.
#[cfg(target_os = "macos")]
#[test]
fn the_bgra_surface_frame_matches_the_rgba_render() {
    use cap_editor::EditorFrameFormat;
    use cap_rendering::SurfaceFrame;
    use cidre::cv::pixel_buffer::LockFlags;

    let _serial = E0_SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .try_init();

    let Some(source) = locate_project() else {
        eprintln!(
            "skipping: no studio .cap with screenshots/display.jpg found \
             (set CAP_GPUI_E0_PROJECT to point at one)"
        );
        return;
    };

    let out_dir = std::env::var_os("CAP_GPUI_E0_OUT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_TARGET_TMPDIR")));
    std::fs::create_dir_all(&out_dir).expect("create output dir");
    let work_dir = out_dir.join("e0-bgra-project.cap");
    let _ = std::fs::remove_dir_all(&work_dir);
    copy_dir(&source, &work_dir).expect("copy .cap bundle");

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let resolution_base = preview_resolution_base();

    let rgba_frame = {
        let (frame_tx, frame_rx) = flume::unbounded::<RenderedFrame>();
        let work_dir = work_dir.clone();
        runtime.block_on(async move {
            let audio_output = Arc::new(AudioOutput::new_headless(Box::new(|_samples, _at| {})));
            let instance = EditorInstance::new_with_audio_output(
                work_dir,
                |_state| {},
                Box::new(move |output, _layout| {
                    if let EditorFrameOutput::Rgba(frame) = output {
                        let _ = frame_tx.send(frame);
                    }
                }),
                None,
                audio_output,
            )
            .await
            .expect("EditorInstance::new (rgba)");
            instance
                .preview_tx
                .send_modify(|v| *v = Some((0, PREVIEW_FPS, resolution_base)));
            let frame = tokio::time::timeout(Duration::from_secs(180), frame_rx.recv_async())
                .await
                .expect("timed out waiting for the RGBA frame")
                .expect("rgba frame channel closed");
            instance.dispose().await;
            frame
        })
    };

    let mut surface_frame = {
        let (frame_tx, frame_rx) = flume::unbounded::<SurfaceFrame>();
        let work_dir = work_dir.clone();
        runtime.block_on(async move {
            let audio_output = Arc::new(AudioOutput::new_headless(Box::new(|_samples, _at| {})));
            let instance = EditorInstance::new_with_audio_output_and_frame_format(
                work_dir,
                |_state| {},
                Box::new(move |output, _layout| {
                    if let EditorFrameOutput::Surface(frame) = output {
                        let _ = frame_tx.send(frame);
                    }
                }),
                None,
                EditorFrameFormat::BgraSurface,
                audio_output,
            )
            .await
            .expect("EditorInstance::new (bgra surface)");
            instance
                .preview_tx
                .send_modify(|v| *v = Some((0, PREVIEW_FPS, resolution_base)));
            let frame = tokio::time::timeout(Duration::from_secs(180), frame_rx.recv_async())
                .await
                .expect("timed out waiting for the BGRA surface frame")
                .expect("surface frame channel closed");
            instance.dispose().await;
            frame
        })
    };

    assert_eq!(
        (surface_frame.width, surface_frame.height),
        (rgba_frame.width, rgba_frame.height),
        "both paths must render the same output size"
    );
    assert_eq!(surface_frame.frame_number, rgba_frame.frame_number);

    let width = surface_frame.width as usize;
    let height = surface_frame.height as usize;
    let pixel_buffer = &mut surface_frame.pixel_buffer;
    assert_eq!(
        pixel_buffer.pixel_format(),
        cidre::cv::PixelFormat::_32_BGRA,
        "the surface path must hand gpui a 32BGRA pixel buffer"
    );
    unsafe {
        pixel_buffer
            .lock_base_addr(LockFlags::READ_ONLY)
            .result()
            .expect("lock pixel buffer");
    }
    let stride = pixel_buffer.plane_bytes_per_row(0);
    let bgra =
        unsafe { std::slice::from_raw_parts(pixel_buffer.plane_base_address(0), stride * height) };
    let mut surface_rgba = Vec::with_capacity(width * height * 4);
    for row in bgra.chunks(stride).take(height) {
        for px in row[..width * 4].chunks_exact(4) {
            surface_rgba.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
    }
    unsafe {
        pixel_buffer.unlock_lock_base_addr(LockFlags::READ_ONLY);
    }

    let rgba = unpad(&rgba_frame);
    assert_eq!(surface_rgba.len(), rgba.len());

    let mut max_delta = 0u8;
    let mut differing_pixels = 0usize;
    for (surface_px, rgba_px) in surface_rgba.chunks_exact(4).zip(rgba.chunks_exact(4)) {
        let mut differs = false;
        for c in 0..3 {
            let delta = surface_px[c].abs_diff(rgba_px[c]);
            max_delta = max_delta.max(delta);
            differs |= delta != 0;
        }
        differing_pixels += usize::from(differs);
    }
    eprintln!(
        "e0-bgra: {width}x{height}, max channel delta {max_delta}, \
         {differing_pixels}/{} pixels differ",
        width * height
    );

    // The blit is an exact copy of the same render, but the two frames come
    // from two independently constructed GPU pipelines, so allow rounding-off
    // noise while still catching swizzle, stride and colour-matrix mistakes
    // (the old NV12 path diverged by 10+ per channel on saturated edges).
    assert!(
        max_delta <= 2,
        "surface pixels diverge from the RGBA render (max channel delta {max_delta})"
    );
}
