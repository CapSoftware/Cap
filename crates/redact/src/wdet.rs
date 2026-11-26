//! WGSL text-line detector (the drops' det.onnx network, BatchNorm folded)
//! for wgpu. The probability map comes out at half the tile resolution:
//! pixel (x, y) covers tile pixels (2x..2x+2, 2y..2y+2). Pixels of a tile
//! outside the source texture contribute zero, as the convolution's own
//! padding of the normalised input does. One `encode` per tile per submit.
use std::collections::HashMap;

use wgpu::util::DeviceExt as _;

#[repr(C)]
#[derive(Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct P {
    cin_a: u32,
    cin_b: u32,
    cin_c: u32,
    cout: u32,
    in_w: u32,
    in_h: u32,
    out_w: u32,
    out_h: u32,
    w_off: u32,
    b_off: u32,
    stride: u32,
    flags: u32,
    u_shift: u32,
    b_shift: u32,
    c_shift: u32,
    cout8: u32,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
}

const RELU: u32 = 1;
const SIGMOID: u32 = 2;
const HAS_U: u32 = 4;
const U_BILINEAR: u32 = 8;
const HAS_R: u32 = 16;
const BGR: u32 = 32;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Precision {
    /// f32 activations: matches PyTorch / ORT to ~1e-6.
    F32,
    /// f16 activations packed in u32 (pack2x16float), f32 math; no SHADER_F16 feature needed. ~2e-3 max abs vs f32.
    F16Packed,
}

#[derive(Clone, Debug)]
struct LayerW {
    cout: usize,
    cin: usize,
    k: usize,
    stride: u32,
    relu: bool,
    w_off: usize,
    b_off: usize,
}

/// Folded (BatchNorm merged) detector weights: det.wgsl.json (layer list) + det.wgsl.bin (f32 little endian).
pub struct Weights {
    layers: HashMap<String, LayerW>,
    raw: Vec<f32>,
}

impl Weights {
    pub fn load(
        json: impl AsRef<std::path::Path>,
        bin: impl AsRef<std::path::Path>,
    ) -> Result<Self, String> {
        let j = std::fs::read(json.as_ref()).map_err(|e| e.to_string())?;
        let b = std::fs::read(bin.as_ref()).map_err(|e| e.to_string())?;
        Self::from_bytes(&j, &b)
    }

    pub fn from_bytes(json: &[u8], bin: &[u8]) -> Result<Self, String> {
        let v: serde_json::Value = serde_json::from_slice(json).map_err(|e| e.to_string())?;
        let list = match &v {
            serde_json::Value::Array(a) => a.clone(),
            o => o["layers"].as_array().cloned().ok_or("layers missing")?,
        };
        let mut layers = HashMap::new();
        for m in list {
            let s: Vec<usize> = m["shape"]
                .as_array()
                .ok_or("shape")?
                .iter()
                .map(|x| x.as_u64().unwrap_or(0) as usize)
                .collect();
            layers.insert(
                m["name"].as_str().ok_or("name")?.to_string(),
                LayerW {
                    cout: s[0],
                    cin: s[1],
                    k: s[2],
                    stride: m["stride"].as_u64().unwrap_or(1) as u32,
                    relu: m["relu"].as_bool().unwrap_or(false),
                    w_off: m["offset_w"].as_u64().ok_or("offset_w")? as usize,
                    b_off: m["offset_b"].as_u64().ok_or("offset_b")? as usize,
                },
            );
        }
        if bin.len() % 4 != 0 {
            return Err("weights.bin length".into());
        }
        let raw = bin
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        for need in [
            "stem", "l0", "l1", "l2", "l3", "fuse.0", "fuse.1", "head_a.0", "head_a.1", "head2.0",
            "head2.1", "head2.2",
        ] {
            if !layers.contains_key(need) {
                return Err(format!(
                    "layer {need} missing: not a TinyDet stride-2 lite graph"
                ));
            }
        }
        Ok(Self { layers, raw })
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Stem,
    Pw,
    Dw,
    ToF32,
}

struct Op {
    kind: Kind,
    p: P,
    a: Option<usize>,
    b: Option<usize>,
    c: Option<usize>,
    u: Option<usize>,
    r: Option<usize>,
    out: usize,
    gy: u32,
}

struct Tensor {
    c: u32,
    w: u32,
    h: u32,
}

/// Pipelines + weights for one device. Create once; make one [`Tile`] per ROI size.
pub struct Detector {
    precision: Precision,
    bgl: wgpu::BindGroupLayout,
    stem: wgpu::ComputePipeline,
    pw: wgpu::ComputePipeline,
    dw: wgpu::ComputePipeline,
    to_f32: wgpu::ComputePipeline,
    w4: wgpu::Buffer,
    scalar_base: u32,
    dummy: wgpu::Buffer,
    dummy_rw: wgpu::Buffer,
    dummy_tex: wgpu::TextureView,
    layers: HashMap<String, LayerW>,
    /// vec4 offsets (w, b) of each 1x1 / stem layer inside `w4`
    w4_off: HashMap<String, (u32, u32, u32)>,
}

/// Activation buffers, bind groups and uniforms for one fixed ROI size.
pub struct Tile {
    ops: Vec<Op>,
    bufs: Vec<wgpu::Buffer>,
    /// The buffer in `bufs` each tensor lives in.
    slot_of: Vec<usize>,
    uniforms: Vec<wgpu::Buffer>,
    groups: Vec<Option<wgpu::BindGroup>>,
    prob: wgpu::Buffer,
    readback: wgpu::Buffer,
}

fn prelude(precision: Precision) -> String {
    let names = ["src_a", "src_b", "src_c", "add_u", "res_r"];
    let mut s = String::new();
    match precision {
        Precision::F32 => {
            s += "alias V4 = vec4<f32>;\n";
            for n in names {
                s += &format!(
                    "fn ld4_{n}(i: u32) -> vec4<f32> {{ return {n}[i]; }}\nfn ld1_{n}(i: u32) -> f32 {{ return {n}[i >> 2u][i & 3u]; }}\n"
                );
            }
            s += "fn st4_dst(i: u32, v: vec4<f32>) { dst[i] = v; }\n";
        }
        Precision::F16Packed => {
            s += "alias V4 = vec2<u32>;\n";
            for n in names {
                s += &format!(
                    "fn ld4_{n}(i: u32) -> vec4<f32> {{ let v = {n}[i]; return vec4<f32>(unpack2x16float(v.x), unpack2x16float(v.y)); }}\n\
                     fn ld1_{n}(i: u32) -> f32 {{ let v = {n}[i >> 2u]; return unpack2x16float(select(v.x, v.y, (i & 2u) != 0u))[i & 1u]; }}\n"
                );
            }
            s += "fn st4_dst(i: u32, v: vec4<f32>) { dst[i] = vec2<u32>(pack2x16float(v.xy), pack2x16float(v.zw)); }\n";
        }
    }
    s
}

impl Detector {
    pub fn new(
        device: &wgpu::Device,
        weights: &Weights,
        precision: Precision,
    ) -> Result<Self, String> {
        let wf = &weights.raw;
        let mut w4: Vec<f32> = vec![];
        let mut w4_off = HashMap::new();
        for (name, l) in &weights.layers {
            if name == "stem" {
                let woff = w4.len();
                for k in 0..9 {
                    for ci in 0..3 {
                        for co in 0..16 {
                            w4.push(wf[l.w_off + co * 27 + ci * 9 + k]);
                        }
                    }
                }
                let boff = w4.len();
                w4.extend_from_slice(&wf[l.b_off..l.b_off + 16]);
                w4_off.insert(name.clone(), ((woff / 4) as u32, (boff / 4) as u32, 16));
            } else if l.k == 1 {
                let c8 = l.cout.div_ceil(8) * 8;
                let woff = w4.len();
                for ci in 0..l.cin {
                    for co in 0..c8 {
                        w4.push(if co < l.cout {
                            wf[l.w_off + co * l.cin + ci]
                        } else {
                            0.0
                        });
                    }
                }
                let boff = w4.len();
                for co in 0..c8 {
                    w4.push(if co < l.cout { wf[l.b_off + co] } else { 0.0 });
                }
                w4_off.insert(
                    name.clone(),
                    ((woff / 4) as u32, (boff / 4) as u32, c8 as u32),
                );
            }
        }
        while w4.len() % 4 != 0 {
            w4.push(0.0);
        }
        let scalar_base = w4.len() as u32;
        w4.extend_from_slice(wf);
        while w4.len() % 4 != 0 {
            w4.push(0.0);
        }
        let st = wgpu::BufferUsages::STORAGE;
        let w4b = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("wdet weights"),
            contents: bytemuck::cast_slice(&w4),
            usage: st,
        });
        let dummy = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("wdet dummy"),
            size: 64,
            usage: st,
            mapped_at_creation: false,
        });
        let dummy_rw = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("wdet dummy rw"),
            size: 64,
            usage: st,
            mapped_at_creation: false,
        });
        let dummy_tex = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("wdet dummy tex"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
            .create_view(&Default::default());
        let src = format!("{}\n{}", prelude(precision), include_str!("wdet.wgsl"));
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("wdet"),
            source: wgpu::ShaderSource::Wgsl(src.into()),
        });
        let buf = |b: u32, ro: bool| wgpu::BindGroupLayoutEntry {
            binding: b,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: ro },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("wdet"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                buf(1, true),
                buf(2, true),
                buf(3, true),
                buf(4, true),
                buf(5, true),
                buf(7, false),
                wgpu::BindGroupLayoutEntry {
                    binding: 8,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                buf(9, true),
                buf(10, false),
            ],
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("wdet"),
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });
        let pipe = |e: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(e),
                layout: Some(&pl),
                module: &module,
                entry_point: Some(e),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        Ok(Self {
            precision,
            stem: pipe("stem4"),
            pw: pipe("pw4"),
            dw: pipe("dw4"),
            to_f32: pipe("to_f32"),
            bgl,
            w4: w4b,
            scalar_base,
            dummy,
            dummy_rw,
            dummy_tex,
            layers: weights.layers.clone(),
            w4_off,
        })
    }

    /// Buffers for a fixed ROI size. `width` must be a multiple of 64 and `height` a multiple of 32.
    pub fn tile(&self, device: &wgpu::Device, width: u32, height: u32) -> Result<Tile, String> {
        if width == 0 || height == 0 || width % 64 != 0 || height % 32 != 0 {
            return Err(format!(
                "tile {width}x{height}: width must be a multiple of 64 and height of 32"
            ));
        }
        let lw = &self.layers;
        let mut tensors: Vec<Tensor> = vec![];
        let mut ops: Vec<Op> = vec![];
        let (hw, hh) = (width / 2, height / 2);
        tensors.push(Tensor {
            c: 16,
            w: hw,
            h: hh,
        });
        let c0 = 0;
        let (sw, sb, _) = self.w4_off["stem"];
        ops.push(Op {
            kind: Kind::Stem,
            p: P {
                cout: 16,
                in_w: width,
                in_h: height,
                out_w: hw,
                out_h: hh,
                w_off: sw,
                b_off: sb,
                stride: 2,
                flags: RELU,
                ..Default::default()
            },
            a: None,
            b: None,
            c: None,
            u: None,
            r: None,
            out: c0,
            gy: 1,
        });
        let w4_off = &self.w4_off;
        let pw = |ops: &mut Vec<Op>,
                  tensors: &mut Vec<Tensor>,
                  name: &str,
                  a: usize,
                  b: Option<(usize, u32)>,
                  c: Option<(usize, u32)>,
                  u: Option<(usize, u32, bool)>,
                  r: Option<usize>,
                  flags: u32|
         -> usize {
            let l = &lw[name];
            let (wo, bo, c8) = w4_off[name];
            let (tw, th, ca) = (tensors[a].w, tensors[a].h, tensors[a].c);
            tensors.push(Tensor {
                c: l.cout as u32,
                w: tw,
                h: th,
            });
            let out = tensors.len() - 1;
            let mut p = P {
                cin_a: ca,
                cout: l.cout as u32,
                in_w: tw,
                in_h: th,
                out_w: tw,
                out_h: th,
                w_off: wo,
                b_off: bo,
                stride: 1,
                cout8: c8,
                flags: flags | if l.relu { RELU } else { 0 },
                ..Default::default()
            };
            if let Some((bi, s)) = b {
                p.cin_b = tensors[bi].c;
                p.b_shift = s;
            }
            if let Some((ci, s)) = c {
                p.cin_c = tensors[ci].c;
                p.c_shift = s;
            }
            if let Some((_, s, bil)) = u {
                p.flags |= HAS_U | if bil { U_BILINEAR } else { 0 };
                p.u_shift = s;
            }
            if r.is_some() {
                p.flags |= HAS_R;
            }
            ops.push(Op {
                kind: Kind::Pw,
                p,
                a: Some(a),
                b: b.map(|x| x.0),
                c: c.map(|x| x.0),
                u: u.map(|x| x.0),
                r,
                out,
                gy: c8 / 8,
            });
            out
        };
        let dw = |ops: &mut Vec<Op>, tensors: &mut Vec<Tensor>, name: &str, a: usize| -> usize {
            let l = &lw[name];
            let (tw, th) = (tensors[a].w, tensors[a].h);
            let (ow, oh) = (tw / l.stride, th / l.stride);
            tensors.push(Tensor {
                c: l.cout as u32,
                w: ow,
                h: oh,
            });
            let out = tensors.len() - 1;
            let p = P {
                cin_a: l.cout as u32,
                cout: l.cout as u32,
                in_w: tw,
                in_h: th,
                out_w: ow,
                out_h: oh,
                w_off: self.scalar_base + l.w_off as u32,
                b_off: self.scalar_base + l.b_off as u32,
                stride: l.stride,
                flags: if l.relu { RELU } else { 0 },
                ..Default::default()
            };
            ops.push(Op {
                kind: Kind::Dw,
                p,
                a: Some(a),
                b: None,
                c: None,
                u: None,
                r: None,
                out,
                gy: l.cout as u32,
            });
            out
        };
        let block = |ops: &mut Vec<Op>, tensors: &mut Vec<Tensor>, pre: &str, x: usize| -> usize {
            let a = if lw.contains_key(&format!("{pre}.pw1")) {
                pw(
                    ops,
                    tensors,
                    &format!("{pre}.pw1"),
                    x,
                    None,
                    None,
                    None,
                    None,
                    0,
                )
            } else {
                x
            };
            let b = dw(ops, tensors, &format!("{pre}.dw"), a);
            let res = (tensors[b].w == tensors[x].w
                && tensors[x].c as usize == lw[&format!("{pre}.pw2")].cout)
                .then_some(x);
            pw(
                ops,
                tensors,
                &format!("{pre}.pw2"),
                b,
                None,
                None,
                None,
                res,
                0,
            )
        };
        let mut x = c0;
        let mut stages: Vec<usize> = vec![];
        for s in ["s1", "s2", "s3"] {
            let mut i = 0;
            while lw.contains_key(&format!("{s}.{i}.dw")) {
                x = block(&mut ops, &mut tensors, &format!("{s}.{i}"), x);
                i += 1;
            }
            stages.push(x);
        }
        let (c1, c2, c3) = (stages[0], stages[1], stages[2]);
        let p3 = pw(&mut ops, &mut tensors, "l3", c3, None, None, None, None, 0);
        let p2 = pw(
            &mut ops,
            &mut tensors,
            "l2",
            c2,
            None,
            None,
            Some((p3, 1, false)),
            None,
            0,
        );
        let p1 = pw(
            &mut ops,
            &mut tensors,
            "l1",
            c1,
            None,
            None,
            Some((p2, 1, false)),
            None,
            0,
        );
        let f = pw(
            &mut ops,
            &mut tensors,
            "fuse.0",
            p1,
            Some((p2, 1)),
            Some((p3, 2)),
            None,
            None,
            0,
        );
        let f = dw(&mut ops, &mut tensors, "fuse.1", f);
        let ha = pw(
            &mut ops,
            &mut tensors,
            "head_a.0",
            f,
            None,
            None,
            None,
            None,
            0,
        );
        let ha = dw(&mut ops, &mut tensors, "head_a.1", ha);
        let hm = pw(
            &mut ops,
            &mut tensors,
            "l0",
            c0,
            None,
            None,
            Some((ha, 1, true)),
            None,
            0,
        );
        let g = dw(&mut ops, &mut tensors, "head2.0", hm);
        let g = pw(
            &mut ops,
            &mut tensors,
            "head2.1",
            g,
            None,
            None,
            None,
            None,
            0,
        );
        let last = pw(
            &mut ops,
            &mut tensors,
            "head2.2",
            g,
            None,
            None,
            None,
            None,
            SIGMOID,
        );
        ops.push(Op {
            kind: Kind::ToF32,
            p: P {
                cout: 1,
                out_w: hw,
                out_h: hh,
                ..Default::default()
            },
            a: Some(last),
            b: None,
            c: None,
            u: None,
            r: None,
            out: last,
            gy: 1,
        });

        let elem: u64 = if self.precision == Precision::F32 {
            4
        } else {
            2
        };
        // Tensors share a buffer once the previous holder has been read for
        // the last time; an op's output is placed before its inputs are
        // released, so no op writes a buffer it reads.
        let mut last_use = vec![0usize; tensors.len()];
        for (index, op) in ops.iter().enumerate() {
            for input in [op.a, op.b, op.c, op.u, op.r].into_iter().flatten() {
                last_use[input] = last_use[input].max(index);
            }
        }
        let mut slot_of = vec![usize::MAX; tensors.len()];
        let mut sizes: Vec<u64> = Vec::new();
        let mut free: Vec<usize> = Vec::new();
        for (index, op) in ops.iter().enumerate() {
            if op.kind != Kind::ToF32 {
                let t = &tensors[op.out];
                let need = (u64::from(t.c * t.w * t.h) * elem).max(16);
                let fit = free
                    .iter()
                    .enumerate()
                    .filter(|(_, slot)| sizes[**slot] >= need)
                    .min_by_key(|(_, slot)| sizes[**slot])
                    .map(|(at, _)| at);
                slot_of[op.out] = match fit {
                    Some(at) => free.swap_remove(at),
                    None => {
                        sizes.push(need);
                        sizes.len() - 1
                    }
                };
            }
            for input in [op.a, op.b, op.c, op.u, op.r].into_iter().flatten() {
                let slot = slot_of[input];
                if last_use[input] == index && slot != usize::MAX && !free.contains(&slot) {
                    free.push(slot);
                }
            }
        }
        let bufs: Vec<wgpu::Buffer> = sizes
            .iter()
            .map(|size| {
                device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("wdet act"),
                    size: *size,
                    usage: wgpu::BufferUsages::STORAGE,
                    mapped_at_creation: false,
                })
            })
            .collect();
        let n = u64::from(hw * hh) * 4;
        let prob = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("wdet prob"),
            size: n,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("wdet readback"),
            size: n,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let uniforms: Vec<wgpu::Buffer> = ops
            .iter()
            .map(|o| {
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("wdet p"),
                    contents: bytemuck::bytes_of(&o.p),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                })
            })
            .collect();
        let mut tile = Tile {
            ops,
            bufs,
            slot_of,
            uniforms,
            groups: vec![],
            prob,
            readback,
        };
        let groups = (0..tile.ops.len())
            .map(|i| {
                if tile.ops[i].kind == Kind::Stem {
                    None
                } else {
                    Some(self.bind_group(device, &tile, i, &self.dummy_tex))
                }
            })
            .collect();
        tile.groups = groups;
        Ok(tile)
    }

    fn bind_group(
        &self,
        device: &wgpu::Device,
        t: &Tile,
        i: usize,
        tex: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        let o = &t.ops[i];
        let pick = |x: Option<usize>| x.map(|k| &t.bufs[t.slot_of[k]]).unwrap_or(&self.dummy);
        fn e(b: u32, buf: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
            wgpu::BindGroupEntry {
                binding: b,
                resource: buf.as_entire_binding(),
            }
        }
        let (dst, prob) = if o.kind == Kind::ToF32 {
            (&self.dummy_rw, &t.prob)
        } else {
            (&t.bufs[t.slot_of[o.out]], &self.dummy_rw)
        };
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("wdet"),
            layout: &self.bgl,
            entries: &[
                e(0, &t.uniforms[i]),
                e(1, pick(o.a)),
                e(2, pick(o.b)),
                e(3, pick(o.c)),
                e(4, pick(o.u)),
                e(5, pick(o.r)),
                e(7, dst),
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: wgpu::BindingResource::TextureView(tex),
                },
                e(9, &self.w4),
                e(10, prob),
            ],
        })
    }

    /// Record the detector for one ROI of `src` (a texture of `src_size`) at `origin` into `encoder`.
    #[allow(clippy::too_many_arguments)]
    pub fn encode(
        &self,
        queue: &wgpu::Queue,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        tile: &Tile,
        src: &wgpu::TextureView,
        src_size: [u32; 2],
        origin: [u32; 2],
        bgr: bool,
    ) {
        let mut p = tile.ops[0].p;
        p.src_x = origin[0];
        p.src_y = origin[1];
        p.src_w = src_size[0];
        p.src_h = src_size[1];
        p.flags = RELU | if bgr { BGR } else { 0 };
        queue.write_buffer(&tile.uniforms[0], 0, bytemuck::bytes_of(&p));
        let stem_bg = self.bind_group(device, tile, 0, src);
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("wdet"),
            timestamp_writes: None,
        });
        for (i, o) in tile.ops.iter().enumerate() {
            let n4 = (o.p.out_w * o.p.out_h) / 4;
            let pipe = match o.kind {
                Kind::Stem => &self.stem,
                Kind::Pw => &self.pw,
                Kind::Dw => &self.dw,
                Kind::ToF32 => &self.to_f32,
            };
            pass.set_pipeline(pipe);
            pass.set_bind_group(
                0,
                if i == 0 {
                    &stem_bg
                } else {
                    tile.groups[i].as_ref().unwrap()
                },
                &[],
            );
            pass.dispatch_workgroups(n4.div_ceil(64), o.gy, 1);
        }
    }

    /// Records the copy of `tile`'s probability map into its readback
    /// buffer, for [`Self::map_prob`] after the submit.
    pub fn copy_prob(&self, encoder: &mut wgpu::CommandEncoder, tile: &Tile) {
        encoder.copy_buffer_to_buffer(&tile.prob, 0, &tile.readback, 0, tile.prob.size());
    }

    /// Requests the mapping of a readback copied by [`Self::copy_prob`]; the
    /// map is ready after the next blocking device poll.
    pub fn map_prob(&self, tile: &Tile) {
        tile.readback
            .slice(..)
            .map_async(wgpu::MapMode::Read, |_| {});
    }

    /// The mapped probability map of `tile` (after [`Self::map_prob`] and a
    /// poll).
    pub fn take_prob(&self, tile: &Tile) -> Vec<f32> {
        let values: Vec<f32> =
            bytemuck::cast_slice(&tile.readback.slice(..).get_mapped_range()).to_vec();
        tile.readback.unmap();
        values
    }

    /// Blocking readback of the probability map after the encoder was submitted.
    #[cfg(test)]
    pub fn read_prob(&self, device: &wgpu::Device, queue: &wgpu::Queue, tile: &Tile) -> Vec<f32> {
        let mut enc = device.create_command_encoder(&Default::default());
        enc.copy_buffer_to_buffer(&tile.prob, 0, &tile.readback, 0, tile.prob.size());
        queue.submit([enc.finish()]);
        let sl = tile.readback.slice(..);
        sl.map_async(wgpu::MapMode::Read, |_| {});
        let _ = device.poll(wgpu::PollType::Wait);
        let v: Vec<f32> = bytemuck::cast_slice(&sl.get_mapped_range()).to_vec();
        tile.readback.unmap();
        v
    }
}
