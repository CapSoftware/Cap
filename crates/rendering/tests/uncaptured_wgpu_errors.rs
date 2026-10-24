//! An error no scope captured must not end the process. 0.6.0 editors died
//! with `wgpu error: Validation Error ... Parent device is lost` because
//! wgpu's default handler panics.

fn device() -> Option<wgpu::Device> {
    let instance = cap_rendering::create_wgpu_instance_sync();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        force_fallback_adapter: cap_rendering::force_software_wgpu_adapter(),
        ..Default::default()
    }))
    .ok()?;
    let (device, _queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()?;
    Some(device)
}

fn texture(device: &wgpu::Device) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Frame Composite texture"),
        size: wgpu::Extent3d {
            width: 64,
            height: 64,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    })
}

#[test]
fn validation_errors_on_a_lost_device_are_logged_not_fatal() {
    let Some(device) = device() else {
        eprintln!("no wgpu adapter; skipping");
        return;
    };
    cap_rendering::log_uncaptured_errors(&device, "test-device");

    let _invalid = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("read and write mapped"),
        size: 4,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::MAP_WRITE,
        mapped_at_creation: false,
    });

    device.destroy();
    for _ in 0..3 {
        let _ = texture(&device);
    }
    let _ = device.poll(wgpu::PollType::Wait);
}
