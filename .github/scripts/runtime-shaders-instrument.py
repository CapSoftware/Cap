import pathlib
import sys

zed = pathlib.Path(sys.argv[1])
app_main = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None


def sub(text, old, new, label):
    if text.count(old) < 1:
        sys.exit(f"anchor missing: {label}")
    return text.replace(old, new, 1)


renderer = zed / "crates/gpui_macos/src/metal_renderer.rs"
t = renderer.read_text()
t = sub(
    t,
    "const PATH_SAMPLE_COUNT: u32 = 4;\n",
    "const PATH_SAMPLE_COUNT: u32 = 4;\n"
    "static CAP_RENDERER_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);\n"
    "thread_local! { static CAP_OPEN_T0: std::cell::Cell<Option<std::time::Instant>> = const { std::cell::Cell::new(None) }; }\n"
    "fn cap_epoch_ms() -> u128 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0) }\n",
    "const",
)
t = sub(
    t,
    "        transparent: bool,\n    ) -> Result<Self> {\n        let device = Self::create_device()?;\n",
    "        transparent: bool,\n    ) -> Result<Self> {\n        CAP_OPEN_T0.with(|c| c.set(Some(std::time::Instant::now())));\n        let device = Self::create_device()?;\n",
    "new",
)
t = sub(
    t,
    "        let library = build_shader_library(&device)?;\n\n        fn to_float2_bits",
    "        let cap_t0 = std::time::Instant::now();\n"
    "        let cap_open = CAP_OPEN_T0.with(|c| c.take()).unwrap_or(cap_t0);\n"
    "        let cap_device_ms = (cap_t0 - cap_open).as_secs_f64() * 1000.0;\n"
    "        let library = build_shader_library(&device)?;\n"
    "        let cap_lib_ms = cap_t0.elapsed().as_secs_f64() * 1000.0;\n\n        fn to_float2_bits",
    "library",
)
t = sub(
    t,
    "        let command_queue = device.new_command_queue();\n        let sprite_atlas",
    "        let cap_pipe_ms = cap_t0.elapsed().as_secs_f64() * 1000.0 - cap_lib_ms;\n"
    "        let cap_seq = CAP_RENDERER_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);\n"
    "        eprintln!(\"CAPSHADER renderer seq={cap_seq} device_ms={cap_device_ms:.3} lib_ms={cap_lib_ms:.3} pipelines_ms={cap_pipe_ms:.3} epoch_ms={}\", cap_epoch_ms());\n"
    "        let command_queue = device.new_command_queue();\n        let sprite_atlas",
    "pipelines",
)
t = sub(
    t,
    "    bgra_surfaces_pipeline_state: metal::RenderPipelineState,\n",
    "    bgra_surfaces_pipeline_state: metal::RenderPipelineState,\n"
    "    cap_seq: usize,\n    cap_created: std::time::Instant,\n    cap_first_drawn: bool,\n",
    "field",
)
t = sub(
    t,
    "            bgra_surfaces_pipeline_state,\n",
    "            bgra_surfaces_pipeline_state,\n            cap_seq,\n            cap_created: cap_open,\n            cap_first_drawn: false,\n",
    "init",
)
old_draw = (
    "                    command_buffer.add_completed_handler(&block);\n\n"
    "                    if self.presents_with_transaction {\n"
)
new_draw = (
    "                    command_buffer.add_completed_handler(&block);\n"
    "                    let cap_first = !self.cap_first_drawn;\n"
    "                    if cap_first {\n"
    "                        let seq = self.cap_seq;\n"
    "                        let created = self.cap_created;\n"
    "                        let done = ConcreteBlock::new(move |_| {\n"
    "                            eprintln!(\"CAPSHADER first_draw_completed seq={seq} open_to_gpu_done_ms={:.3} epoch_ms={}\", created.elapsed().as_secs_f64() * 1000.0, cap_epoch_ms());\n"
    "                        });\n"
    "                        let done = done.copy();\n"
    "                        command_buffer.add_completed_handler(&done);\n"
    "                    }\n\n"
    "                    if self.presents_with_transaction {\n"
)
t = sub(t, old_draw, new_draw, "draw")
t = sub(
    t,
    "                        command_buffer.present_drawable(drawable);\n                        command_buffer.commit();\n                    }\n                    return;\n",
    "                        command_buffer.present_drawable(drawable);\n                        command_buffer.commit();\n                    }\n"
    "                    if cap_first {\n"
    "                        self.cap_first_drawn = true;\n"
    "                        eprintln!(\"CAPSHADER first_draw_submitted seq={} open_to_submit_ms={:.3} epoch_ms={}\", self.cap_seq, self.cap_created.elapsed().as_secs_f64() * 1000.0, cap_epoch_ms());\n"
    "                    }\n"
    "                    return;\n",
    "submitted",
)
renderer.write_text(t)

window = zed / "crates/gpui_macos/src/window.rs"
w = window.read_text()
w = sub(
    w,
    "        let renderer =\n            objc::rc::autoreleasepool(|| renderer::new_renderer(renderer_context, false))?;\n",
    "        eprintln!(\"CAPSHADER window_open title={:?} kind={:?} size={:?} epoch_ms={}\", titlebar.as_ref().and_then(|t| t.title.clone()), kind, bounds.size, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));\n"
    "        let renderer =\n            objc::rc::autoreleasepool(|| renderer::new_renderer(renderer_context, false))?;\n",
    "window",
)
window.write_text(w)

if app_main:
    m = app_main.read_text()
    m = sub(
        m,
        "                settings_window::Page::from_slug(&page).unwrap_or(settings_window::Page::General);\n            app_windows::open_settings(page, cx);\n",
        "                settings_window::Page::from_slug(&page).unwrap_or(settings_window::Page::General);\n"
        "            cx.spawn(async move |cx| {\n"
        "                cx.background_executor().timer(std::time::Duration::from_secs(6)).await;\n"
        "                cx.update(|cx| {\n"
        "                    app_windows::open_settings(page, cx);\n"
        "                });\n"
        "            })\n"
        "            .detach();\n",
        "settings",
    )
    app_main.write_text(m)
print("instrumented")
