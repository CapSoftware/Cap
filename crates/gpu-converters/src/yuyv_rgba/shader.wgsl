    // Each texel stores two Y’s => two output RGBA pixels.
    let out_coords = gid.xy * vec2<u32>(2, 1);

    textureStore(rgba_output, out_coords, vec4<f32>(r1, g1, b1, 1.0));
    textureStore(rgba_output, out_coords + vec2<u32>(1, 0), vec4<f32>(r2, g2, b2, 1.0));
}