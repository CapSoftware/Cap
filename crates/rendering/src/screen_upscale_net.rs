use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

const CHANNELS: usize = 8;
const SUBPIXELS: usize = 4;
const _: () = assert!(CHANNELS == 8, "the shader is written for 8 channels");

/// The two networks: a deeper one where the screen is magnified 1.8x
/// or more, and a shallower one below that, where the visible source (and so
/// the work) is larger and depth adds little.
const DEEP_LAYERS: usize = 5;
const SHALLOW_LAYERS: usize = 3;
const DEEP_WEIGHTS: &[u8] = include_bytes!("models/screen-upscale.bin");
const SHALLOW_WEIGHTS: &[u8] = include_bytes!("models/screen-upscale-shallow.bin");
const _: () = assert!(DEEP_WEIGHTS.len() == parameters(DEEP_LAYERS) * 4);
const _: () = assert!(SHALLOW_WEIGHTS.len() == parameters(SHALLOW_LAYERS) * 4);
// The first and last layers run as separate passes.
const _: () = assert!(SHALLOW_LAYERS >= 2 && DEEP_LAYERS >= 2);
pub const DEEP_FROM_MAGNIFICATION: f32 = 1.8;

const fn parameters(layers: usize) -> usize {
    (3 * CHANNELS * 9 + CHANNELS)
        + (layers - 1) * (2 * CHANNELS * CHANNELS * 9 + CHANNELS)
        + (2 * CHANNELS * layers * SUBPIXELS + SUBPIXELS)
}

/// Texels each side of an output texel that the deeper network reads.
/// Stripes overlap by this much so they join without seams.
pub const HALO: u32 = DEEP_LAYERS as u32;
/// Texels in one stripe's buffers (the halo rows included). Each texel takes
/// two feature buffers of eight f16 values and four f16 residuals: 40 bytes.
const MAX_STRIPE_TEXELS: u64 = 1 << 20;
const FEATURE_BYTES: u64 = 16;
const RESIDUAL_BYTES: u64 = 8;
const TILE: [u32; 2] = [16, 8];
/// Source range (8-bit levels) at or below which a tile keeps the plain
/// bilinear result. The 2x2 clamp already pins such tiles to their range.
const FLAT_RANGE: f32 = 4.0 / 255.0;

#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
struct Params {
    size: [u32; 2],
    source_origin: [i32; 2],
    source_max: [i32; 2],
    write_rows: [u32; 2],
    out_origin: [i32; 2],
    tiles: [u32; 2],
    flat_range: f32,
    reach: i32,
    layer: u32,
    pad: u32,
}

struct Weights {
    convs: Vec<(wgpu::Buffer, wgpu::Buffer)>,
    readout: wgpu::Buffer,
}

impl Weights {
    fn layers(&self) -> usize {
        self.convs.len()
    }
}

/// Buffer rows for a stripe of a `width`-texel rect: as many as fit `budget`
/// texels, at least enough for a tile row plus the halo, at most the whole
/// rect.
fn buffer_rows(width: u32, height: u32, budget: u64) -> u32 {
    let fitting = (budget / u64::from(width)).min(u64::from(u32::MAX)) as u32;
    (height + 2 * HALO).min(fitting.max(2 * HALO + TILE[1]))
}

/// Stripe buffers, sized in texels and tiles rather than by shape: the
/// shaders index by the current stripe's own width, so any stripe whose
/// texel and tile counts fit can reuse them.
struct Stripes {
    texels: u64,
    tiles: u64,
    features: [wgpu::Buffer; 2],
    residual: wgpu::Buffer,
    flat_tiles: wgpu::Buffer,
}

/// A 2x upscaler for screen content: 3x3 convolutions at the source
/// resolution with a readout over every layer that predicts one residual per
/// 2x2 output sub-pixel, added to a bilinear 2x upscale.
pub struct ScreenUpscaleNet {
    classify: wgpu::ComputePipeline,
    first: wgpu::ComputePipeline,
    body: wgpu::ComputePipeline,
    last: wgpu::ComputePipeline,
    deep: Weights,
    shallow: Weights,
    stripes: Option<Stripes>,
    max_stripe_texels: u64,
    flat_range: f32,
}

/// Packs a `[out][in][taps]` convolution into the shader's layout: one
/// column-major 4x4 block per (output group, input group, tap), so
/// `block * input` adds that tap's contribution to four output channels.
fn pack(weights: &[f32], inputs: usize, outputs: usize, taps: usize) -> Vec<f32> {
    let in_groups = inputs.div_ceil(4);
    let out_groups = outputs.div_ceil(4);
    let mut blocks = vec![0.0; out_groups * in_groups * taps * 16];
    for out_group in 0..out_groups {
        for in_group in 0..in_groups {
            for tap in 0..taps {
                let block = ((out_group * in_groups + in_group) * taps + tap) * 16;
                for column in 0..4 {
                    let input = in_group * 4 + column;
                    for row in 0..4 {
                        let output = out_group * 4 + row;
                        if input < inputs && output < outputs {
                            blocks[block + column * 4 + row] =
                                weights[(output * inputs + input) * taps + tap];
                        }
                    }
                }
            }
        }
    }
    blocks
}

fn decode_weights(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        .collect()
}

/// The tensors in file order: each convolution's weights and bias,
/// then the readout's weights (`[subpixel][layer][positive, negative][channel]`)
/// and bias.
struct Tensors {
    convs: Vec<(Vec<f32>, Vec<f32>)>,
    readout: Vec<f32>,
    readout_bias: Vec<f32>,
}

fn tensors(bytes: &[u8], layers: usize) -> Tensors {
    let all = decode_weights(bytes);
    assert_eq!(all.len(), parameters(layers), "weights for {layers} layers");
    let mut cursor = 0;
    let mut take = |count: usize| {
        let slice = all[cursor..cursor + count].to_vec();
        cursor += count;
        slice
    };
    let mut convs = vec![(take(CHANNELS * 3 * 9), take(CHANNELS))];
    for _ in 1..layers {
        convs.push((take(CHANNELS * 2 * CHANNELS * 9), take(CHANNELS)));
    }
    let readout = take(SUBPIXELS * 2 * CHANNELS * layers);
    let readout_bias = take(SUBPIXELS);
    Tensors {
        convs,
        readout,
        readout_bias,
    }
}

impl ScreenUpscaleNet {
    pub fn new(device: &wgpu::Device) -> Self {
        let module =
            device.create_shader_module(wgpu::include_wgsl!("shaders/screen-upscale-net.wgsl"));
        let pipeline = |entry_point: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry_point),
                layout: None,
                module: &module,
                entry_point: Some(entry_point),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let buffer = |label: &str, data: &[f32]| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::cast_slice(data),
                usage: wgpu::BufferUsages::STORAGE,
            })
        };

        let weights = |bytes: &[u8], layers: usize| {
            let tensors = tensors(bytes, layers);
            let convs = tensors
                .convs
                .iter()
                .enumerate()
                .map(|(index, (weights, bias))| {
                    let inputs = if index == 0 { 3 } else { 2 * CHANNELS };
                    let mut bias = bias.clone();
                    if index == 0 {
                        bias.extend_from_slice(&tensors.readout_bias);
                    }
                    (
                        buffer(
                            "Screen upscale weights",
                            &pack(weights, inputs, CHANNELS, 9),
                        ),
                        buffer("Screen upscale bias", &bias),
                    )
                })
                .collect();
            let per_layer = 2 * CHANNELS;
            let readout: Vec<f32> = (0..layers)
                .flat_map(|layer| {
                    let slice: Vec<f32> = (0..SUBPIXELS)
                        .flat_map(|subpixel| {
                            let start = (subpixel * layers + layer) * per_layer;
                            tensors.readout[start..start + per_layer].to_vec()
                        })
                        .collect();
                    pack(&slice, per_layer, SUBPIXELS, 1)
                })
                .collect();
            Weights {
                convs,
                readout: buffer("Screen upscale readout", &readout),
            }
        };

        Self {
            classify: pipeline("classify"),
            first: pipeline("first"),
            body: pipeline("body"),
            last: pipeline("last"),
            deep: weights(DEEP_WEIGHTS, DEEP_LAYERS),
            shallow: weights(SHALLOW_WEIGHTS, SHALLOW_LAYERS),
            stripes: None,
            max_stripe_texels: MAX_STRIPE_TEXELS,
            flat_range: FLAT_RANGE,
        }
    }

    fn ensure_stripes(&mut self, device: &wgpu::Device, width: u32, rows: u32) {
        let texels = u64::from(width) * u64::from(rows);
        let tiles = u64::from(width.div_ceil(TILE[0])) * u64::from(rows.div_ceil(TILE[1]));
        if self
            .stripes
            .as_ref()
            .is_some_and(|stripes| stripes.texels >= texels && stripes.tiles >= tiles)
        {
            return;
        }
        let buffer = |label: &str, bytes: u64| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: bytes.max(16),
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            })
        };
        self.stripes = Some(Stripes {
            texels,
            tiles,
            features: [
                buffer("Screen upscale features", texels * FEATURE_BYTES),
                buffer("Screen upscale features", texels * FEATURE_BYTES),
            ],
            residual: buffer("Screen upscale residual", texels * RESIDUAL_BYTES),
            flat_tiles: buffer("Screen upscale flat tiles", tiles * 4),
        });
    }

    /// Records the network over the source texels `rect` (`[x0, y0, x1, y1]`)
    /// of `source` (a view and its size), writing the 2x result to `target`
    /// from its origin. `target` must be a storage-bindable `Rgba8Unorm`
    /// texture of at least twice `rect`'s size. `deep` picks the deeper
    /// network.
    pub fn encode(
        &mut self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        (source, source_size): (&wgpu::TextureView, [u32; 2]),
        rect: [u32; 4],
        target: &wgpu::TextureView,
        deep: bool,
    ) {
        let width = rect[2].saturating_sub(rect[0]);
        let height = rect[3].saturating_sub(rect[1]);
        if width == 0 || height == 0 || source_size[0] == 0 || source_size[1] == 0 {
            return;
        }
        let buffer_rows = buffer_rows(width, height, self.max_stripe_texels);
        let stripe_rows = buffer_rows - 2 * HALO;
        self.ensure_stripes(device, width, buffer_rows);
        let Some(stripes) = &self.stripes else {
            return;
        };
        let weights = if deep { &self.deep } else { &self.shallow };
        let reach = weights.layers() as i32;

        let texture_group =
            |pipeline: &wgpu::ComputePipeline, binding: u32, view: &wgpu::TextureView| {
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Screen upscale textures"),
                    layout: &pipeline.get_bind_group_layout(1),
                    entries: &[wgpu::BindGroupEntry {
                        binding,
                        resource: wgpu::BindingResource::TextureView(view),
                    }],
                })
            };
        let classify_textures = texture_group(&self.classify, 0, source);
        let first_textures = texture_group(&self.first, 0, source);
        let finish_textures = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Screen upscale textures"),
            layout: &self.last.get_bind_group_layout(1),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(source),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(target),
                },
            ],
        });

        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("Screen upscale network"),
            timestamp_writes: None,
        });
        let mut start = rect[1];
        while start < rect[3] {
            let end = (start + stripe_rows).min(rect[3]);
            let buffer_start = start.saturating_sub(HALO).max(rect[1]);
            let buffer_end = (end + HALO).min(rect[3]);
            let rows = buffer_end - buffer_start;
            let tiles = [width.div_ceil(TILE[0]), rows.div_ceil(TILE[1])];
            let params = |layer: usize| {
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Screen upscale params"),
                    contents: bytemuck::bytes_of(&Params {
                        size: [width, rows],
                        source_origin: [rect[0] as i32, buffer_start as i32],
                        source_max: [source_size[0] as i32 - 1, source_size[1] as i32 - 1],
                        write_rows: [start - buffer_start, end - buffer_start],
                        out_origin: [0, (buffer_start - rect[1]) as i32],
                        tiles,
                        flat_range: self.flat_range,
                        reach,
                        layer: layer as u32,
                        pad: 0,
                    }),
                    usage: wgpu::BufferUsages::UNIFORM,
                })
            };
            let group = |pipeline: &wgpu::ComputePipeline, entries: &[(u32, &wgpu::Buffer)]| {
                let entries: Vec<_> = entries
                    .iter()
                    .map(|(binding, buffer)| wgpu::BindGroupEntry {
                        binding: *binding,
                        resource: buffer.as_entire_binding(),
                    })
                    .collect();
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Screen upscale pass"),
                    layout: &pipeline.get_bind_group_layout(0),
                    entries: &entries,
                })
            };
            let mut dispatch = |pipeline: &wgpu::ComputePipeline,
                                group: &wgpu::BindGroup,
                                textures: Option<&wgpu::BindGroup>| {
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, group, &[]);
                if let Some(textures) = textures {
                    pass.set_bind_group(1, textures, &[]);
                }
                pass.dispatch_workgroups(tiles[0], tiles[1], 1);
            };

            let shared = params(0);
            dispatch(
                &self.classify,
                &group(&self.classify, &[(0, &shared), (7, &stripes.flat_tiles)]),
                Some(&classify_textures),
            );
            let mut input: Option<&wgpu::Buffer> = None;
            let count = weights.convs.len();
            for (layer, (layer_weights, bias)) in weights.convs.iter().enumerate() {
                let output = &stripes.features[layer % 2];
                let layer_params = params(layer);
                let last = layer + 1 == count;
                let pipeline = if layer == 0 {
                    &self.first
                } else if last {
                    &self.last
                } else {
                    &self.body
                };
                let mut entries = vec![
                    (0, &layer_params),
                    (1, layer_weights),
                    (2, bias),
                    (5, &weights.readout),
                    (6, &stripes.residual),
                    (7, &stripes.flat_tiles),
                ];
                if !last {
                    entries.push((4, output));
                }
                if let Some(input) = input {
                    entries.push((3, input));
                }
                let bind = group(pipeline, &entries);
                let textures = if layer == 0 {
                    Some(&first_textures)
                } else if last {
                    Some(&finish_textures)
                } else {
                    None
                };
                dispatch(pipeline, &bind, textures);
                input = Some(output);
            }
            start = end;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upscale(
        stripe_texels: u64,
        flat_range: f32,
        pixels: &[u8],
        size: [u32; 2],
        deep: bool,
    ) -> Option<Vec<u8>> {
        let instance = crate::create_wgpu_instance_sync();
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            force_fallback_adapter: crate::force_software_wgpu_adapter(),
            ..Default::default()
        }))
        .ok()?;
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()?;
        let extent = |width, height| wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let source = device.create_texture_with_data(
            &queue,
            &wgpu::TextureDescriptor {
                label: None,
                size: extent(size[0], size[1]),
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            pixels,
        );
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: extent(size[0] * 2, size[1] * 2),
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let row_bytes = size[0] * 2 * 4;
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: u64::from(row_bytes * size[1] * 2),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut net = ScreenUpscaleNet::new(&device);
        net.max_stripe_texels = stripe_texels;
        net.flat_range = flat_range;
        let mut encoder = device.create_command_encoder(&Default::default());
        net.encode(
            &device,
            &mut encoder,
            (&source.create_view(&Default::default()), size),
            [0, 0, size[0], size[1]],
            &target.create_view(&Default::default()),
            deep,
        );
        encoder.copy_texture_to_buffer(
            target.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row_bytes),
                    rows_per_image: None,
                },
            },
            extent(size[0] * 2, size[1] * 2),
        );
        queue.submit([encoder.finish()]);
        let slice = readback.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::PollType::Wait).ok()?;
        let data = slice.get_mapped_range().to_vec();
        Some(data)
    }

    fn pattern(size: [u32; 2]) -> Vec<u8> {
        (0..size[0] * size[1])
            .flat_map(|i| {
                let (x, y) = (i % size[0], i / size[0]);
                let text = ((x / 3 + y / 4) % 5 == 0) as u8 * 200;
                let flat = x < size[0] / 3;
                if flat {
                    [40, 44, 52, 255]
                } else {
                    [text, (x * 4) as u8, (y * 3) as u8 ^ text, 255]
                }
            })
            .collect()
    }

    fn cpu_network(pixels: &[u8], size: [u32; 2], bytes: &[u8], layers: usize) -> Vec<f32> {
        let (w, h) = (size[0] as i32, size[1] as i32);
        let at = |x: i32, y: i32| (y.clamp(0, h - 1) * w + x.clamp(0, w - 1)) as usize;
        let image: Vec<[f32; 3]> = pixels
            .chunks(4)
            .map(|p| {
                [
                    p[0] as f32 / 255.0,
                    p[1] as f32 / 255.0,
                    p[2] as f32 / 255.0,
                ]
            })
            .collect();
        let tensors = tensors(bytes, layers);
        let conv =
            |input: &dyn Fn(usize, usize) -> f32, inputs: usize, weights: &[f32], bias: &[f32]| {
                let mut out = vec![0.0f32; (w * h) as usize * CHANNELS];
                for y in 0..h {
                    for x in 0..w {
                        for (o, &b) in bias.iter().enumerate() {
                            let mut acc = b;
                            for i in 0..inputs {
                                for tap in 0..9 {
                                    let (sx, sy) = (x + tap as i32 % 3 - 1, y + tap as i32 / 3 - 1);
                                    if sx >= 0 && sy >= 0 && sx < w && sy < h {
                                        acc += weights[(o * inputs + i) * 9 + tap]
                                            * input((sy * w + sx) as usize, i);
                                    }
                                }
                            }
                            out[(y * w + x) as usize * CHANNELS + o] = acc;
                        }
                    }
                }
                out
            };
        let crelu = |features: &[f32], texel: usize, i: usize| {
            let v = features[texel * CHANNELS + i % CHANNELS];
            if i < CHANNELS {
                v.max(0.0)
            } else {
                (-v).max(0.0)
            }
        };
        let mut outputs = vec![conv(
            &|texel, i| image[texel][i],
            3,
            &tensors.convs[0].0,
            &tensors.convs[0].1,
        )];
        for (weights, bias) in &tensors.convs[1..] {
            let previous = outputs.last().expect("layer").clone();
            outputs.push(conv(
                &|texel, i| crelu(&previous, texel, i),
                2 * CHANNELS,
                weights,
                bias,
            ));
        }
        let mut out = vec![0.0f32; (w * h * 4 * 3) as usize];
        for y in 0..h {
            for x in 0..w {
                let texel = (y * w + x) as usize;
                for (s, &readout_bias) in tensors.readout_bias.iter().enumerate() {
                    let mut r = readout_bias;
                    for (layer, features) in outputs.iter().enumerate() {
                        for i in 0..2 * CHANNELS {
                            r += tensors.readout[(s * layers + layer) * 2 * CHANNELS + i]
                                * crelu(features, texel, i);
                        }
                    }
                    let (dx, dy) = ((s & 1) as i32 * 2 - 1, (s >> 1) as i32 * 2 - 1);
                    let taps = [at(x, y), at(x + dx, y), at(x, y + dy), at(x + dx, y + dy)];
                    let weights = [0.5625, 0.1875, 0.1875, 0.0625];
                    let (ox, oy) = (2 * x + (s & 1) as i32, 2 * y + (s >> 1) as i32);
                    let first = ((oy * 2 * w + ox) * 3) as usize;
                    for (c, slot) in out[first..first + 3].iter_mut().enumerate() {
                        let values = taps.map(|t| image[t][c]);
                        let base: f32 = values.iter().zip(weights).map(|(v, k)| v * k).sum();
                        let lo = values.iter().copied().fold(1.0f32, f32::min);
                        let hi = values.iter().copied().fold(0.0f32, f32::max);
                        *slot = (base + r).clamp(lo, hi);
                    }
                }
            }
        }
        out
    }

    #[test]
    fn gpu_matches_both_networks() {
        for (deep, bytes, layers) in [
            (true, DEEP_WEIGHTS, DEEP_LAYERS),
            (false, SHALLOW_WEIGHTS, SHALLOW_LAYERS),
        ] {
            gpu_matches(deep, bytes, layers);
        }
    }

    fn gpu_matches(deep: bool, bytes: &[u8], layers: usize) {
        let size = [64u32, 24];
        let pixels = pattern(size);
        let Some(gpu) = upscale(u64::MAX, -1.0, &pixels, size, deep) else {
            return;
        };
        let expected = cpu_network(&pixels, size, bytes, layers);
        let worst = gpu
            .chunks(4)
            .zip(expected.chunks(3))
            .flat_map(|(g, e)| (0..3).map(move |c| (g[c] as f32 / 255.0 - e[c]).abs()))
            .fold(0.0f32, f32::max);
        assert!(worst <= 1.0 / 255.0 + 1e-4, "worst difference {worst}");
    }

    #[test]
    fn stripe_buffers_stay_within_budget_across_shapes() {
        let instance = crate::create_wgpu_instance_sync();
        let Ok(adapter) =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                force_fallback_adapter: crate::force_software_wgpu_adapter(),
                ..Default::default()
            }))
        else {
            return;
        };
        let Ok((device, _queue)) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
        else {
            return;
        };
        let mut net = ScreenUpscaleNet::new(&device);
        for (width, height) in [(512u32, 1800u32), (3000, 512), (512, 1800)] {
            let rows = buffer_rows(width, height, MAX_STRIPE_TEXELS);
            net.ensure_stripes(&device, width, rows);
            let stripes = net.stripes.as_ref().expect("stripes");
            assert!(
                stripes.features[0].size() <= MAX_STRIPE_TEXELS * FEATURE_BYTES,
                "{width}x{height}"
            );
            assert!(stripes.texels >= u64::from(width) * u64::from(rows));
        }
    }

    #[test]
    fn stripes_join_without_seams() {
        let size = [64u32, 72];
        let pixels = pattern(size);
        let Some(whole) = upscale(u64::MAX, FLAT_RANGE, &pixels, size, true) else {
            return;
        };
        let striped = upscale(1, FLAT_RANGE, &pixels, size, true).expect("second render");
        assert_eq!(whole.len(), (size[0] * size[1] * 16) as usize);
        assert_eq!(whole, striped);
    }

    #[test]
    fn flat_tiles_keep_the_flat_colour() {
        let size = [64u32, 32];
        let pixels = pattern(size);
        let Some(out) = upscale(u64::MAX, FLAT_RANGE, &pixels, size, false) else {
            return;
        };
        for y in 0..size[1] * 2 {
            for x in 0..8 {
                let i = ((y * size[0] * 2 + x) * 4) as usize;
                assert_eq!(&out[i..i + 3], &[40, 44, 52], "texel {x},{y}");
            }
        }
    }

    #[test]
    fn weights_cover_every_layer() {
        for (bytes, layers) in [
            (DEEP_WEIGHTS, DEEP_LAYERS),
            (SHALLOW_WEIGHTS, SHALLOW_LAYERS),
        ] {
            let tensors = tensors(bytes, layers);
            assert_eq!(tensors.convs.len(), layers);
            assert_eq!(tensors.readout_bias.len(), SUBPIXELS);
            assert!(decode_weights(bytes).iter().all(|w| w.is_finite()));
        }
    }

    #[test]
    fn packing_places_each_weight_in_its_block() {
        let (inputs, outputs, taps) = (3, 6, 9);
        let weights: Vec<f32> = (0..inputs * outputs * taps).map(|i| i as f32).collect();
        let blocks = pack(&weights, inputs, outputs, taps);
        assert_eq!(blocks.len(), 2 * taps * 16);
        for output in 0..outputs {
            for input in 0..inputs {
                for tap in 0..taps {
                    let block = ((output / 4) * taps + tap) * 16;
                    assert_eq!(
                        blocks[block + input * 4 + output % 4],
                        weights[(output * inputs + input) * taps + tap]
                    );
                }
            }
        }
    }
}
