#[tokio::main]
pub async fn main() {
    #[cfg(target_os = "macos")]
    mac::run().await;
    #[cfg(not(target_os = "macos"))]
    panic!("This example is only supported on macOS");
}

#[cfg(target_os = "macos")]
mod mac {
    use cap_video_decode::AVAssetReaderDecoder;
    use cidre::{cv, mtl};
    use metal::{MTLTextureType, foreign_types::ForeignTypeRef};
    use std::{
        path::PathBuf,
        time::{Duration, Instant},
    };
    use wgpu::{TextureUsages, wgc::api::Metal};

    pub(super) async fn run() {
        let handle = tokio::runtime::Handle::current();

        let path: PathBuf = std::env::args().collect::<Vec<_>>().swap_remove(1).into();

        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .unwrap();
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                required_features: wgpu::Features::MAPPABLE_PRIMARY_BUFFERS,
                ..Default::default()
            })
            .await
            .unwrap();

        let _ = std::thread::spawn(move || {
            let metal_device = mtl::Device::sys_default().unwrap();

            let texture_cache = cv::metal::TextureCache::create(None, &metal_device, None).unwrap();

            let mut decoder = AVAssetReaderDecoder::new(path, handle).unwrap();

            let mut times = vec![];

            let mut frames = decoder.frames();
            loop {
                let start = Instant::now();
                let Some(frame) = frames.next() else { break };
                times.push(dbg!(start.elapsed()));

                let Ok(frame) = frame else {
                    return;
                };

                let image_buf = frame.image_buf().unwrap();

                let texture = texture_cache
                    .texture(
                        frame.image_buf().unwrap(),
                        None,
                        mtl::PixelFormat::Bgra8UNorm,
                        image_buf.width(),
                        image_buf.height(),
                        0,
                    )
                    .unwrap();

                let width = image_buf.width();
                let height = image_buf.height();

                let size = wgpu::Extent3d {
                    width: width as u32,
                    height: height as u32,
                    depth_or_array_layers: 1,
                };
                let format = wgpu::TextureFormat::Bgra8Unorm;

                let texture = unsafe {
                    let texture =
                        <wgpu::hal::api::Metal as wgpu::hal::Api>::Device::texture_from_raw(
                            metal::TextureRef::from_ptr(
                                texture.as_type_ptr() as *const _ as *mut _
                            )
                            .to_owned(),
                            format,
                            MTLTextureType::D2,
                            1,
                            1,
                            wgpu::hal::CopyExtent {
                                width: width as u32,
                                height: height as u32,
                                depth: 1,
                            },
                        );

                    device.create_texture_from_hal::<Metal>(
                        texture,
                        &wgpu::TextureDescriptor {
                            label: None,
                            size,
                            mip_level_count: 1,
                            sample_count: 1,
                            dimension: wgpu::TextureDimension::D2,
                            format,
                            usage: TextureUsages::TEXTURE_BINDING,
                            view_formats: &[],
                        },
                    )
                };
            }

            dbg!(times.iter().min());
            dbg!(times.iter().max());
            dbg!(times.iter().sum::<Duration>() / times.len() as u32);
            dbg!(times.len());
        })
        .join();
    }

    // pub fn pts_to_frame(pts: i64, time_base: (f64, f64), fps: u32) -> u32 {
    //     (fps as f64 * ((pts as f64 * time_base.0) / (time_base.1))).round() as u32
    // }
}
