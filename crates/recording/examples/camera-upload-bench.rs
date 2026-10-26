#[cfg(windows)]
fn main() -> anyhow::Result<()> {
    use cap_camera_ffmpeg::with_media_buffer_data;
    use cap_camera_windows::PixelFormat;
    use cap_mediafoundation_utils::IMFMediaBufferExt;
    use cap_recording::{
        CameraBuffer, CameraBuffers, NativeCameraFrame, create_d3d_device,
        upload_mf_buffer_to_texture,
    };
    use cap_timestamp::Timestamp;
    use std::time::Instant;
    use windows::Win32::{
        Graphics::{
            Direct3D11::{
                D3D11_BIND_SHADER_RESOURCE, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC,
                D3D11_USAGE_DEFAULT,
            },
            Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC},
        },
        Media::MediaFoundation::MFCreate2DMediaBuffer,
    };

    const WIDTH: usize = 1920;
    const HEIGHT: usize = 1080;
    const ITERATIONS: usize = 500;

    cap_mediafoundation_utils::thread_init();
    let device = create_d3d_device()?;
    let buffer = unsafe {
        MFCreate2DMediaBuffer(
            WIDTH as u32,
            HEIGHT as u32,
            u32::from_le_bytes(*b"NV12"),
            false,
        )
    }?;

    {
        let mut lock = buffer.lock_for_write()?;
        for (index, byte) in lock.iter_mut().enumerate() {
            *byte = (index * 17) as u8;
        }
    }

    let frame = NativeCameraFrame {
        buffer: CameraBuffer::new(buffer),
        pixel_format: PixelFormat::NV12,
        width: WIDTH as u32,
        height: HEIGHT as u32,
        is_bottom_up: false,
        timestamp: Timestamp::Instant(Instant::now()),
    };
    let mut buffers = CameraBuffers::new();

    for _ in 0..20 {
        let texture = upload_mf_buffer_to_texture(&device, &frame, &mut buffers)?;
        std::hint::black_box(texture);
    }

    let start = Instant::now();
    for _ in 0..ITERATIONS {
        let texture = upload_mf_buffer_to_texture(&device, &frame, &mut buffers)?;
        std::hint::black_box(texture);
    }
    let elapsed = start.elapsed();

    let texture_desc = D3D11_TEXTURE2D_DESC {
        Width: WIDTH as u32,
        Height: HEIGHT as u32,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };

    let start = Instant::now();
    with_media_buffer_data(
        frame.buffer.get(),
        PixelFormat::NV12,
        WIDTH,
        HEIGHT,
        |data, pitch, _| {
            for _ in 0..ITERATIONS {
                let subresource = D3D11_SUBRESOURCE_DATA {
                    pSysMem: data.as_ptr() as *const _,
                    SysMemPitch: pitch as u32,
                    SysMemSlicePitch: 0,
                };
                let mut texture = None;
                unsafe {
                    device.CreateTexture2D(
                        &texture_desc,
                        Some(&subresource),
                        Some(&mut texture),
                    )?;
                }
                std::hint::black_box(texture);
            }

            Ok::<_, windows::core::Error>(())
        },
    )
    .expect("locked data")?;
    let uncached = start.elapsed();

    println!(
        "cached upload:   {:.3} ms/frame ({:.1} fps)",
        elapsed.as_secs_f64() * 1000.0 / ITERATIONS as f64,
        ITERATIONS as f64 / elapsed.as_secs_f64()
    );
    println!(
        "uncached upload: {:.3} ms/frame ({:.1} fps)",
        uncached.as_secs_f64() * 1000.0 / ITERATIONS as f64,
        ITERATIONS as f64 / uncached.as_secs_f64()
    );

    Ok(())
}

#[cfg(not(windows))]
fn main() {
    println!("camera-upload-bench requires Windows");
}
