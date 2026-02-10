pub fn map_texture_usage(
    format: wgt::TextureFormat,
    usage: wgt::TextureUses,
) -> metal::MTLTextureUsage {
    use wgt::TextureUses as Tu;

    let mut mtl_usage = metal::MTLTextureUsage::Unknown;

    mtl_usage.set(
        metal::MTLTextureUsage::RenderTarget,
        usage.intersects(Tu::COLOR_TARGET | Tu::DEPTH_STENCIL_READ | Tu::DEPTH_STENCIL_WRITE),
    );
    mtl_usage.set(
        metal::MTLTextureUsage::ShaderRead,
        usage.intersects(
            Tu::RESOURCE | Tu::DEPTH_STENCIL_READ | Tu::STORAGE_READ_ONLY | Tu::STORAGE_READ_WRITE,
        ),
    );
    mtl_usage.set(
        metal::MTLTextureUsage::ShaderWrite,
        usage.intersects(Tu::STORAGE_WRITE_ONLY | Tu::STORAGE_READ_WRITE),
    );
    // needed for combined depth/stencil formats since we might
    // create a stencil-only view from them
    mtl_usage.set(
        metal::MTLTextureUsage::PixelFormatView,
        format.is_combined_depth_stencil_format(),
    );

    mtl_usage.set(
        metal::MTLTextureUsage::ShaderAtomic,
        usage.intersects(Tu::STORAGE_ATOMIC),
    );

    mtl_usage
}

pub fn map_texture_view_dimension(dim: wgt::TextureViewDimension) -> metal::MTLTextureType {
    use metal::MTLTextureType::*;
    use wgt::TextureViewDimension as Tvd;
    match dim {
        Tvd::D1 => D1,
        Tvd::D2 => D2,
        Tvd::D2Array => D2Array,
        Tvd::D3 => D3,
        Tvd::Cube => Cube,
        Tvd::CubeArray => CubeArray,
    }
}

pub fn map_compare_function(fun: wgt::CompareFunction) -> metal::MTLCompareFunction {
    use metal::MTLCompareFunction::*;
    use wgt::CompareFunction as Cf;
    match fun {
        Cf::Never => Never,
        Cf::Less => Less,
        Cf::LessEqual => LessEqual,
        Cf::Equal => Equal,
        Cf::GreaterEqual => GreaterEqual,
        Cf::Greater => Greater,
        Cf::NotEqual => NotEqual,
        Cf::Always => Always,
    }
}

pub fn map_filter_mode(filter: wgt::FilterMode) -> metal::MTLSamplerMinMagFilter {
    use metal::MTLSamplerMinMagFilter::*;
    match filter {
        wgt::FilterMode::Nearest => Nearest,
        wgt::FilterMode::Linear => Linear,
    }
}

pub fn map_address_mode(address: wgt::AddressMode) -> metal::MTLSamplerAddressMode {
    use metal::MTLSamplerAddressMode::*;
    use wgt::AddressMode as Fm;
    match address {
        Fm::Repeat => Repeat,
        Fm::MirrorRepeat => MirrorRepeat,
        Fm::ClampToEdge => ClampToEdge,
        Fm::ClampToBorder => ClampToBorderColor,
        //Fm::MirrorClamp => MirrorClampToEdge,
    }
}

pub fn map_border_color(border_color: wgt::SamplerBorderColor) -> metal::MTLSamplerBorderColor {
    use metal::MTLSamplerBorderColor::*;
    match border_color {
        wgt::SamplerBorderColor::TransparentBlack => TransparentBlack,
        wgt::SamplerBorderColor::OpaqueBlack => OpaqueBlack,
        wgt::SamplerBorderColor::OpaqueWhite => OpaqueWhite,
        wgt::SamplerBorderColor::Zero => unreachable!(),
    }
}

pub fn map_primitive_topology(
    topology: wgt::PrimitiveTopology,
) -> (metal::MTLPrimitiveTopologyClass, metal::MTLPrimitiveType) {
    use wgt::PrimitiveTopology as Pt;
    match topology {
        Pt::PointList => (
            metal::MTLPrimitiveTopologyClass::Point,
            metal::MTLPrimitiveType::Point,
        ),
        Pt::LineList => (
            metal::MTLPrimitiveTopologyClass::Line,
            metal::MTLPrimitiveType::Line,
        ),
        Pt::LineStrip => (
            metal::MTLPrimitiveTopologyClass::Line,
            metal::MTLPrimitiveType::LineStrip,
        ),
        Pt::TriangleList => (
            metal::MTLPrimitiveTopologyClass::Triangle,
            metal::MTLPrimitiveType::Triangle,
        ),
        Pt::TriangleStrip => (
            metal::MTLPrimitiveTopologyClass::Triangle,
            metal::MTLPrimitiveType::TriangleStrip,
        ),
    }
}

pub fn map_color_write(mask: wgt::ColorWrites) -> metal::MTLColorWriteMask {
    let mut raw_mask = metal::MTLColorWriteMask::empty();

    if mask.contains(wgt::ColorWrites::RED) {
        raw_mask |= metal::MTLColorWriteMask::Red;
    }
    if mask.contains(wgt::ColorWrites::GREEN) {
        raw_mask |= metal::MTLColorWriteMask::Green;
    }
    if mask.contains(wgt::ColorWrites::BLUE) {
        raw_mask |= metal::MTLColorWriteMask::Blue;
    }
    if mask.contains(wgt::ColorWrites::ALPHA) {
        raw_mask |= metal::MTLColorWriteMask::Alpha;
    }

    raw_mask
}

pub fn map_blend_factor(factor: wgt::BlendFactor) -> metal::MTLBlendFactor {
    use metal::MTLBlendFactor::*;
    use wgt::BlendFactor as Bf;

    match factor {
        Bf::Zero => Zero,
        Bf::One => One,
        Bf::Src => SourceColor,
        Bf::OneMinusSrc => OneMinusSourceColor,
        Bf::Dst => DestinationColor,
        Bf::OneMinusDst => OneMinusDestinationColor,
        Bf::SrcAlpha => SourceAlpha,
        Bf::OneMinusSrcAlpha => OneMinusSourceAlpha,
        Bf::DstAlpha => DestinationAlpha,
        Bf::OneMinusDstAlpha => OneMinusDestinationAlpha,
        Bf::Constant => BlendColor,
        Bf::OneMinusConstant => OneMinusBlendColor,
        Bf::SrcAlphaSaturated => SourceAlphaSaturated,
        Bf::Src1 => Source1Color,
        Bf::OneMinusSrc1 => OneMinusSource1Color,
        Bf::Src1Alpha => Source1Alpha,
        Bf::OneMinusSrc1Alpha => OneMinusSource1Alpha,
    }
}

pub fn map_blend_op(operation: wgt::BlendOperation) -> metal::MTLBlendOperation {
    use metal::MTLBlendOperation::*;
    use wgt::BlendOperation as Bo;

    match operation {
        Bo::Add => Add,
        Bo::Subtract => Subtract,
        Bo::ReverseSubtract => ReverseSubtract,
        Bo::Min => Min,
        Bo::Max => Max,
    }
}

pub fn map_blend_component(
    component: &wgt::BlendComponent,
) -> (
    metal::MTLBlendOperation,
    metal::MTLBlendFactor,
    metal::MTLBlendFactor,
) {
    (
        map_blend_op(component.operation),
        map_blend_factor(component.src_factor),
        map_blend_factor(component.dst_factor),
    )
}

pub fn map_vertex_format(format: wgt::VertexFormat) -> metal::MTLVertexFormat {
    use metal::MTLVertexFormat::*;
    use wgt::VertexFormat as Vf;

    match format {
        Vf::Unorm8 => UCharNormalized,
        Vf::Snorm8 => CharNormalized,
        Vf::Uint8 => UChar,
        Vf::Sint8 => Char,
        Vf::Unorm8x2 => UChar2Normalized,
        Vf::Snorm8x2 => Char2Normalized,
        Vf::Uint8x2 => UChar2,
        Vf::Sint8x2 => Char2,
        Vf::Unorm8x4 => UChar4Normalized,
        Vf::Snorm8x4 => Char4Normalized,
        Vf::Uint8x4 => UChar4,
        Vf::Sint8x4 => Char4,
        Vf::Unorm16 => UShortNormalized,
        Vf::Snorm16 => ShortNormalized,
        Vf::Uint16 => UShort,
        Vf::Sint16 => Short,
        Vf::Float16 => Half,
        Vf::Unorm16x2 => UShort2Normalized,
        Vf::Snorm16x2 => Short2Normalized,
        Vf::Uint16x2 => UShort2,
        Vf::Sint16x2 => Short2,
        Vf::Float16x2 => Half2,
        Vf::Unorm16x4 => UShort4Normalized,
        Vf::Snorm16x4 => Short4Normalized,
        Vf::Uint16x4 => UShort4,
        Vf::Sint16x4 => Short4,
        Vf::Float16x4 => Half4,
        Vf::Uint32 => UInt,
        Vf::Sint32 => Int,
        Vf::Float32 => Float,
        Vf::Uint32x2 => UInt2,
        Vf::Sint32x2 => Int2,
        Vf::Float32x2 => Float2,
        Vf::Uint32x3 => UInt3,
        Vf::Sint32x3 => Int3,
        Vf::Float32x3 => Float3,
        Vf::Uint32x4 => UInt4,
        Vf::Sint32x4 => Int4,
        Vf::Float32x4 => Float4,
        Vf::Unorm10_10_10_2 => UInt1010102Normalized,
        Vf::Unorm8x4Bgra => UChar4Normalized_BGRA,
        Vf::Float64 | Vf::Float64x2 | Vf::Float64x3 | Vf::Float64x4 => unimplemented!(),
    }
}

pub fn map_step_mode(mode: wgt::VertexStepMode) -> metal::MTLVertexStepFunction {
    match mode {
        wgt::VertexStepMode::Vertex => metal::MTLVertexStepFunction::PerVertex,
        wgt::VertexStepMode::Instance => metal::MTLVertexStepFunction::PerInstance,
    }
}

pub fn map_stencil_op(op: wgt::StencilOperation) -> metal::MTLStencilOperation {
    use metal::MTLStencilOperation::*;
    use wgt::StencilOperation as So;

    match op {
        So::Keep => Keep,
        So::Zero => Zero,
        So::Replace => Replace,
        So::IncrementClamp => IncrementClamp,
        So::IncrementWrap => IncrementWrap,
        So::DecrementClamp => DecrementClamp,
        So::DecrementWrap => DecrementWrap,
        So::Invert => Invert,
    }
}

pub fn map_winding(winding: wgt::FrontFace) -> metal::MTLWinding {
    match winding {
        wgt::FrontFace::Cw => metal::MTLWinding::Clockwise,
        wgt::FrontFace::Ccw => metal::MTLWinding::CounterClockwise,
    }
}

pub fn map_cull_mode(face: Option<wgt::Face>) -> metal::MTLCullMode {
    match face {
        None => metal::MTLCullMode::None,
        Some(wgt::Face::Front) => metal::MTLCullMode::Front,
        Some(wgt::Face::Back) => metal::MTLCullMode::Back,
    }
}

pub fn map_range(range: &crate::MemoryRange) -> metal::NSRange {
    metal::NSRange {
        location: range.start,
        length: range.end - range.start,
    }
}

pub fn map_copy_extent(extent: &crate::CopyExtent) -> metal::MTLSize {
    metal::MTLSize {
        width: extent.width as u64,
        height: extent.height as u64,
        depth: extent.depth as u64,
    }
}

pub fn map_origin(origin: &wgt::Origin3d) -> metal::MTLOrigin {
    metal::MTLOrigin {
        x: origin.x as u64,
        y: origin.y as u64,
        z: origin.z as u64,
    }
}

pub fn map_store_action(store: bool, resolve: bool) -> metal::MTLStoreAction {
    use metal::MTLStoreAction::*;
    match (store, resolve) {
        (true, true) => StoreAndMultisampleResolve,
        (false, true) => MultisampleResolve,
        (true, false) => Store,
        (false, false) => DontCare,
    }
}

pub fn map_clear_color(color: &wgt::Color) -> metal::MTLClearColor {
    metal::MTLClearColor {
        red: color.r,
        green: color.g,
        blue: color.b,
        alpha: color.a,
    }
}

pub fn get_blit_option(
    format: wgt::TextureFormat,
    aspect: crate::FormatAspects,
) -> metal::MTLBlitOption {
    if format.is_combined_depth_stencil_format() {
        match aspect {
            crate::FormatAspects::DEPTH => metal::MTLBlitOption::DepthFromDepthStencil,
            crate::FormatAspects::STENCIL => metal::MTLBlitOption::StencilFromDepthStencil,
            _ => unreachable!(),
        }
    } else {
        metal::MTLBlitOption::None
    }
}

pub fn map_render_stages(stage: wgt::ShaderStages) -> metal::MTLRenderStages {
    let mut raw_stages = metal::MTLRenderStages::empty();

    if stage.contains(wgt::ShaderStages::VERTEX) {
        raw_stages |= metal::MTLRenderStages::Vertex;
    }
    if stage.contains(wgt::ShaderStages::FRAGMENT) {
        raw_stages |= metal::MTLRenderStages::Fragment;
    }

    raw_stages
}

pub fn map_resource_usage(ty: &wgt::BindingType) -> metal::MTLResourceUsage {
    match ty {
        wgt::BindingType::Texture { .. } => metal::MTLResourceUsage::Sample,
        wgt::BindingType::StorageTexture { access, .. } => match access {
            wgt::StorageTextureAccess::WriteOnly => metal::MTLResourceUsage::Write,
            wgt::StorageTextureAccess::ReadOnly => metal::MTLResourceUsage::Read,
            wgt::StorageTextureAccess::Atomic | wgt::StorageTextureAccess::ReadWrite => {
                metal::MTLResourceUsage::Read | metal::MTLResourceUsage::Write
            }
        },
        wgt::BindingType::Sampler(..) => metal::MTLResourceUsage::empty(),
        _ => unreachable!(),
    }
}
