struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
};

@group(0) @binding(0) var screen_texture: texture_2d<f32>;
@group(0) @binding(1) var screen_sampler: sampler;
@group(0) @binding(2) var webcam_texture: texture_2d<f32>;
@group(0) @binding(3) var webcam_sampler: sampler;

struct CompositeParams {
    webcam_position: vec2<f32>,
    webcam_size: vec2<f32>,
    output_size: vec2<f32>,
    border_radius: f32,
    shadow_color: vec4<f32>,
    shadow_blur: f32,
    shadow_offset: vec2<f32>,
    background_start: vec4<f32>,
    background_end: vec4<f32>,
    background_angle: f32,
    _padding: vec3<f32>,
};

@group(0) @binding(4) var<uniform> params: CompositeParams;

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(i32(in_vertex_index & 1u) * 4 - 1);
    let y = f32(i32(in_vertex_index & 2u) * 2 - 1);
    out.clip_position = vec4<f32>(x, y, 0.0, 1.0);
    out.tex_coords = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
    return out;
}

fn gradient(uv: vec2<f32>) -> vec4<f32> {
    let angle_rad = params.background_angle * 3.14159 / 180.0;
    let rotated_uv = vec2<f32>(
        cos(angle_rad) * uv.x - sin(angle_rad) * uv.y,
        sin(angle_rad) * uv.x + cos(angle_rad) * uv.y
    );
    // Create a more vibrant gradient
    let gradient_color = mix(params.background_start, params.background_end, rotated_uv.x);
    return vec4<f32>(gradient_color.rgb * 1.2, gradient_color.a); // Increase brightness
}


fn apply_shadow(base_color: vec4<f32>, uv: vec2<f32>, shadow_uv: vec2<f32>) -> vec4<f32> {
    let distance = length(uv - shadow_uv) / (params.shadow_blur * 3.0); // Increase blur area for softer shadow
    let shadow_alpha = smoothstep(1.0, 0.0, distance) * 0.2; // Set max opacity to 0.2
    let shadow_color = vec4<f32>(0.0, 0.0, 0.0, shadow_alpha); // Black color with calculated alpha
    return mix(base_color, shadow_color, shadow_alpha);
}

fn rounded_rect(uv: vec2<f32>, size: vec2<f32>, radius: f32) -> f32 {
    let distance = vec2<f32>(
        abs(uv.x - 0.5) - (size.x * 0.5 - radius),
        abs(uv.y - 0.5) - (size.y * 0.5 - radius)
    );
    let outside_distance = length(max(distance, vec2<f32>(0.0)));
    let inside_distance = min(max(distance.x, distance.y), 0.0);
    let edge_distance = outside_distance + inside_distance - radius;
    return step(edge_distance, 0.0);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Apply gradient background
    var final_color = gradient(in.tex_coords);

    // Calculate screen recording size and position
    let screen_scale = 0.9; // Make screen recording slightly smaller
    let screen_offset = (1.0 - screen_scale) / 2.0;
    let screen_uv = (in.tex_coords - vec2<f32>(screen_offset)) / screen_scale;

    // Apply screen recording if within bounds
    if (screen_uv.x >= 0.0 && screen_uv.x <= 1.0 && screen_uv.y >= 0.0 && screen_uv.y <= 1.0) {
        let screen_color = textureSample(screen_texture, screen_sampler, screen_uv);
        let screen_radius = 0.02; // Adjust this value to change the border radius
        let screen_alpha = rounded_rect(screen_uv, vec2<f32>(1.0), screen_radius);
        final_color = mix(final_color, screen_color, screen_color.a * screen_alpha);
    }

    // Calculate webcam UV coordinates (bottom left corner)
    let webcam_scale = 0.2; // Adjust webcam size
    let webcam_offset = vec2<f32>(0.02, 0.98 - webcam_scale); // Position in bottom left
    let webcam_uv = (in.tex_coords - webcam_offset) / webcam_scale;
    
    // Apply webcam overlay
    if (webcam_uv.x >= 0.0 && webcam_uv.x <= 1.0 && webcam_uv.y >= 0.0 && webcam_uv.y <= 1.0) {
        let webcam_color = textureSample(webcam_texture, webcam_sampler, webcam_uv);
        
        // Apply border radius
        let webcam_radius = 0.05; // Adjust this value to change the border radius
        let border_alpha = rounded_rect(webcam_uv, vec2<f32>(1.0), webcam_radius);
        
        // Apply box shadow
        let shadow_size = 0.01;
        let shadow_offset = vec2<f32>(shadow_size, -shadow_size);
        let shadow_uv = webcam_uv - shadow_offset / webcam_scale;
        
        final_color = apply_shadow(final_color, webcam_uv, shadow_uv);
        final_color = mix(final_color, webcam_color, webcam_color.a * border_alpha);
    }
    
    return final_color;
}