//! This example shows interop with raw GLES contexts -
//! the ability to hook up wgpu-hal to an existing context and draw into it.
//!
//! Emscripten build:
//! 1. install emsdk
//! 2. build this example with cargo:
//!    EMCC_CFLAGS="-g -s ERROR_ON_UNDEFINED_SYMBOLS=0 --no-entry -s FULL_ES3=1" cargo build --example raw-gles --target wasm32-unknown-emscripten
//! 3. copy raw-gles.em.html into target directory and open it in browser:
//!    cp wgpu-hal/examples/raw-gles.em.html target/wasm32-unknown-emscripten/debug/examples

extern crate wgpu_hal as hal;

#[cfg(not(any(target_arch = "wasm32", target_os = "ios", target_os = "visionos")))]
fn main() {
    use std::{ffi::CString, num::NonZeroU32};

    use glutin::{
        config::GlConfig as _,
        context::{NotCurrentGlContext as _, PossiblyCurrentGlContext as _, Version},
        display::{GetGlDisplay as _, GlDisplay as _},
        surface::GlSurface as _,
    };
    use glutin_winit::GlWindow as _;
    use rwh_05::HasRawWindowHandle as _;

    env_logger::init();
    println!("Initializing external GL context");

    let event_loop = winit::event_loop::EventLoop::new().unwrap();
    // Only Windows requires the window to be present before creating the display.
    // Other platforms don't really need one.
    let window_builder = cfg!(windows).then(|| {
        winit::window::WindowBuilder::new()
            .with_title("WGPU raw GLES example (press Escape to exit)")
    });

    // The template will match only the configurations supporting rendering
    // to Windows.
    let template = glutin::config::ConfigTemplateBuilder::new();

    let display_builder = glutin_winit::DisplayBuilder::new().with_window_builder(window_builder);

    // Find the config with the maximum number of samples, so our triangle will be
    // smooth.
    pub fn gl_config_picker(
        configs: Box<dyn Iterator<Item = glutin::config::Config> + '_>,
    ) -> glutin::config::Config {
        configs
            .reduce(|accum, config| {
                if config.num_samples() > accum.num_samples() {
                    config
                } else {
                    accum
                }
            })
            .expect("Failed to find a matching config")
    }

    let (mut window, gl_config) = display_builder
        .build(&event_loop, template, gl_config_picker)
        .expect("Failed to build window and config from display");

    println!("Picked a config with {} samples", gl_config.num_samples());

    let raw_window_handle = window.as_ref().map(|window| window.raw_window_handle());

    // XXX The display could be obtained from any object created by it, so we can
    // query it from the config.
    let gl_display = gl_config.display();

    // Glutin tries to create an OpenGL context by default.  Force it to use any version of GLES.
    let context_attributes = glutin::context::ContextAttributesBuilder::new()
        // WGPU expects GLES 3.0+.
        .with_context_api(glutin::context::ContextApi::Gles(Some(Version::new(3, 0))))
        .build(raw_window_handle);

    let mut not_current_gl_context = Some(unsafe {
        gl_display
            .create_context(&gl_config, &context_attributes)
            .expect("failed to create context")
    });

    let mut state = None;

    // Only needs to be loaded once
    let mut exposed = None;

    event_loop
        .run(move |event, window_target| {
            use winit::{
                event::{Event, KeyEvent, WindowEvent},
                event_loop::ControlFlow,
                keyboard::{Key, NamedKey},
            };
            window_target.set_control_flow(ControlFlow::Wait);

            match event {
                // Event::LoopExiting => (),
                Event::WindowEvent {
                    window_id: _,
                    event:
                        WindowEvent::CloseRequested
                        | WindowEvent::KeyboardInput {
                            event:
                                KeyEvent {
                                    logical_key: Key::Named(NamedKey::Escape),
                                    ..
                                },
                            ..
                        },
                } => window_target.exit(),
                Event::Resumed => {
                    let window = window.take().unwrap_or_else(|| {
                        let window_builder = winit::window::WindowBuilder::new()
                            .with_title("WGPU raw GLES example (press Escape to exit)");
                        glutin_winit::finalize_window(window_target, window_builder, &gl_config)
                            .unwrap()
                    });

                    let attrs = window.build_surface_attributes(Default::default());
                    let gl_surface = unsafe {
                        gl_config
                            .display()
                            .create_window_surface(&gl_config, &attrs)
                            .expect("Cannot create GL WindowSurface")
                    };

                    // Make it current.
                    let gl_context = not_current_gl_context
                        .take()
                        .unwrap()
                        .make_current(&gl_surface)
                        .expect("GL context cannot be made current with WindowSurface");

                    // The context needs to be current for the Renderer to set up shaders and
                    // buffers. It also performs function loading, which needs a current context on
                    // WGL.
                    println!("Hooking up to wgpu-hal");
                    exposed.get_or_insert_with(|| {
                        unsafe {
                            <hal::api::Gles as hal::Api>::Adapter::new_external(
                                |name| {
                                    // XXX: On WGL this should only be called after the context was made current
                                    gl_config
                                        .display()
                                        .get_proc_address(&CString::new(name).expect(name))
                                },
                                wgpu_types::GlBackendOptions::default(),
                            )
                        }
                        .expect("GL adapter can't be initialized")
                    });

                    assert!(state.replace((gl_context, gl_surface, window)).is_none());
                }
                Event::Suspended => {
                    // This event is only raised on Android, where the backing NativeWindow for a GL
                    // Surface can appear and disappear at any moment.
                    println!("Android window removed");

                    // Destroy the GL Surface and un-current the GL Context before ndk-glue releases
                    // the window back to the system.
                    let (gl_context, ..) = state.take().unwrap();
                    assert!(not_current_gl_context
                        .replace(gl_context.make_not_current().unwrap())
                        .is_none());
                }
                Event::WindowEvent {
                    window_id: _,
                    event: WindowEvent::Resized(size),
                } => {
                    if size.width != 0 && size.height != 0 {
                        // Some platforms like EGL require resizing GL surface to update the size
                        // Notable platforms here are Wayland and macOS, other don't require it
                        // and the function is no-op, but it's wise to resize it for portability
                        // reasons.
                        if let Some((gl_context, gl_surface, _)) = &state {
                            gl_surface.resize(
                                gl_context,
                                NonZeroU32::new(size.width).unwrap(),
                                NonZeroU32::new(size.height).unwrap(),
                            );
                            // XXX: If there's a state for fill_screen(), this would need to be updated too.
                        }
                    }
                }
                Event::WindowEvent {
                    window_id: _,
                    event: WindowEvent::RedrawRequested,
                } => {
                    if let (Some(exposed), Some((gl_context, gl_surface, window))) =
                        (&exposed, &state)
                    {
                        let inner_size = window.inner_size();

                        fill_screen(exposed, inner_size.width, inner_size.height);

                        println!("Showing the window");
                        gl_surface
                            .swap_buffers(gl_context)
                            .expect("Failed to swap buffers");
                    }
                }
                _ => (),
            }
        })
        .expect("Couldn't run event loop");
}

#[cfg(target_os = "emscripten")]
fn main() {
    env_logger::init();

    println!("Initializing external GL context");
    let egl = khronos_egl::Instance::new(khronos_egl::Static);
    let display = unsafe { egl.get_display(khronos_egl::DEFAULT_DISPLAY) }.unwrap();
    egl.initialize(display)
        .expect("unable to initialize display");

    let attributes = [
        khronos_egl::RED_SIZE,
        8,
        khronos_egl::GREEN_SIZE,
        8,
        khronos_egl::BLUE_SIZE,
        8,
        khronos_egl::NONE,
    ];

    let config = egl
        .choose_first_config(display, &attributes)
        .unwrap()
        .expect("unable to choose config");
    let surface = unsafe {
        let window = std::ptr::null_mut::<std::ffi::c_void>();
        egl.create_window_surface(display, config, window, None)
    }
    .expect("unable to create surface");

    let context_attributes = [khronos_egl::CONTEXT_CLIENT_VERSION, 3, khronos_egl::NONE];

    let gl_context = egl
        .create_context(display, config, None, &context_attributes)
        .expect("unable to create context");
    egl.make_current(display, Some(surface), Some(surface), Some(gl_context))
        .expect("can't make context current");

    println!("Hooking up to wgpu-hal");
    let exposed = unsafe {
        <hal::api::Gles as hal::Api>::Adapter::new_external(|name| {
            egl.get_proc_address(name)
                .map_or(std::ptr::null(), |p| p as *const _)
        })
    }
    .expect("GL adapter can't be initialized");

    fill_screen(&exposed, 640, 400);
}

#[cfg(any(
    all(target_arch = "wasm32", not(target_os = "emscripten")),
    target_os = "ios",
    target_os = "visionos"
))]
fn main() {
    eprintln!("This example is not supported on Windows and non-emscripten wasm32")
}

#[cfg(not(any(
    all(target_arch = "wasm32", not(target_os = "emscripten")),
    target_os = "ios",
    target_os = "visionos"
)))]
fn fill_screen(exposed: &hal::ExposedAdapter<hal::api::Gles>, width: u32, height: u32) {
    use hal::{Adapter as _, CommandEncoder as _, Device as _, Queue as _};

    let od = unsafe {
        exposed.adapter.open(
            wgpu_types::Features::empty(),
            &wgpu_types::Limits::downlevel_defaults(),
            &wgpu_types::MemoryHints::default(),
        )
    }
    .unwrap();

    let format = wgpu_types::TextureFormat::Rgba8UnormSrgb;
    let texture = <hal::api::Gles as hal::Api>::Texture::default_framebuffer(format);
    let view = unsafe {
        od.device
            .create_texture_view(
                &texture,
                &hal::TextureViewDescriptor {
                    label: None,
                    format,
                    dimension: wgpu_types::TextureViewDimension::D2,
                    usage: wgpu_types::TextureUses::COLOR_TARGET,
                    range: wgpu_types::ImageSubresourceRange::default(),
                },
            )
            .unwrap()
    };

    println!("Filling the screen");
    let mut encoder = unsafe {
        od.device
            .create_command_encoder(&hal::CommandEncoderDescriptor {
                label: None,
                queue: &od.queue,
            })
            .unwrap()
    };
    let mut fence = unsafe { od.device.create_fence().unwrap() };
    let rp_desc = hal::RenderPassDescriptor {
        label: None,
        extent: wgpu_types::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        sample_count: 1,
        color_attachments: &[Some(hal::ColorAttachment {
            target: hal::Attachment {
                view: &view,
                usage: wgpu_types::TextureUses::COLOR_TARGET,
            },
            resolve_target: None,
            ops: hal::AttachmentOps::STORE,
            clear_value: wgpu_types::Color::BLUE,
        })],
        depth_stencil_attachment: None,
        multiview: None,
        timestamp_writes: None,
        occlusion_query_set: None,
    };
    unsafe {
        encoder.begin_encoding(None).unwrap();
        encoder.begin_render_pass(&rp_desc);
        encoder.end_render_pass();
        let cmd_buf = encoder.end_encoding().unwrap();
        od.queue.submit(&[&cmd_buf], &[], (&mut fence, 0)).unwrap();
    }
}
