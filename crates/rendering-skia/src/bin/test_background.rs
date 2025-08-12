use cap_project::BackgroundSource;
use cap_rendering_skia::layers::{FrameData, SkiaProjectUniforms};
use cap_rendering_skia::{BackgroundLayer, LayerStack, SkiaRenderContext};
use skia_safe::EncodedImageFormat;
use std::fs;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    println!("=== Background Layer Test ===");

    // Create rendering context
    let mut context = SkiaRenderContext::new()?;
    println!("✓ Created rendering context");

    // Test dimensions
    let width = 800;
    let height = 600;

    // Create output directory
    let output_dir = "test_output";
    fs::create_dir_all(output_dir)?;
    println!("✓ Created output directory: {output_dir}");

    // Test 1: Solid Color Background
    println!("\n1. Testing solid color background...");
    test_color_background(&mut context, width, height, output_dir)?;

    // Test 2: Gradient Background
    println!("\n2. Testing gradient background...");
    test_gradient_background(&mut context, width, height, output_dir)?;

    // Test 3: Multiple gradients with different angles
    println!("\n3. Testing gradient angles...");
    test_gradient_angles(&mut context, width, height, output_dir)?;

    // Test 4: Picture caching
    println!("\n4. Testing picture caching...");
    test_caching(&mut context, width, height)?;

    println!("\n=== All tests completed successfully! ===");
    println!("Check the '{output_dir}' directory for output images.");

    Ok(())
}

fn test_color_background(
    context: &mut SkiaRenderContext,
    width: u32,
    height: u32,
    output_dir: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut surface = context.create_surface(width, height)?;
    let mut layer_stack = LayerStack::new();

    // Add background layer
    let background_layer = Box::new(BackgroundLayer::new());
    layer_stack.add_recorded(background_layer);

    // Test different colors
    let colors = [
        ([65535, 0, 0], "red"),
        ([0, 65535, 0], "green"),
        ([0, 0, 65535], "blue"),
        ([32768, 32768, 32768], "gray"),
    ];

    for (color, name) in colors {
        let uniforms = SkiaProjectUniforms {
            output_size: (width, height),
            background: BackgroundSource::Color { value: color },
        };

        let frame_data = FrameData {
            uniforms: uniforms.clone(),
            video_frame: None,
            camera_frame: None,
            cursor_position: None,
        };

        // Prepare and render
        futures::executor::block_on(layer_stack.prepare(&frame_data))?;

        let canvas = surface.canvas();
        canvas.clear(skia_safe::Color::BLACK);
        layer_stack.render(canvas, &uniforms);

        // Flush to ensure rendering is complete
        context.flush();

        // Save output
        let image = surface.image_snapshot();
        println!(
            "   - Image snapshot for {}: {}x{}",
            name,
            image.width(),
            image.height()
        );
        match image.encode(context.direct_context(), EncodedImageFormat::PNG, 100) {
            Some(data) => {
                let path = format!("{output_dir}/background_color_{name}.png");
                fs::write(&path, data.as_bytes())?;
                println!("   ✓ Saved {name} background to: {path}");
            }
            None => {
                println!("   ✗ Failed to encode {name} color image to PNG");
            }
        }
    }

    Ok(())
}

fn test_gradient_background(
    context: &mut SkiaRenderContext,
    width: u32,
    height: u32,
    output_dir: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut surface = context.create_surface(width, height)?;
    let mut layer_stack = LayerStack::new();

    // Add background layer
    let background_layer = Box::new(BackgroundLayer::new());
    layer_stack.add_recorded(background_layer);

    // Test gradient
    let uniforms = SkiaProjectUniforms {
        output_size: (width, height),
        background: BackgroundSource::Gradient {
            from: [65535, 0, 0], // Red
            to: [0, 0, 65535],   // Blue
            angle: 45,
        },
    };

    let frame_data = FrameData {
        uniforms: uniforms.clone(),
        video_frame: None,
        camera_frame: None,
        cursor_position: None,
    };

    // Prepare and render
    futures::executor::block_on(layer_stack.prepare(&frame_data))?;

    let canvas = surface.canvas();
    canvas.clear(skia_safe::Color::BLACK);
    layer_stack.render(canvas, &uniforms);

    // Flush to ensure rendering is complete
    context.flush();

    // Save output
    let image = surface.image_snapshot();
    println!(
        "   - Image snapshot created: {}x{}",
        image.width(),
        image.height()
    );
    match image.encode(context.direct_context(), EncodedImageFormat::PNG, 100) {
        Some(data) => {
            let path = format!("{output_dir}/background_gradient.png");
            fs::write(&path, data.as_bytes())?;
            println!("   ✓ Saved gradient background to: {path}");
        }
        None => {
            println!("   ✗ Failed to encode gradient image to PNG");
        }
    }

    Ok(())
}

fn test_gradient_angles(
    context: &mut SkiaRenderContext,
    width: u32,
    height: u32,
    output_dir: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut surface = context.create_surface(width, height)?;
    let mut layer_stack = LayerStack::new();

    // Add background layer
    let background_layer = Box::new(BackgroundLayer::new());
    layer_stack.add_recorded(background_layer);

    // Test different angles
    let angles = [0u16, 45, 90, 135, 180, 225, 270, 315];

    for angle in angles {
        let uniforms = SkiaProjectUniforms {
            output_size: (width, height),
            background: BackgroundSource::Gradient {
                from: [65535, 32768, 0], // Orange
                to: [32768, 0, 65535],   // Purple
                angle,
            },
        };

        let frame_data = FrameData {
            uniforms: uniforms.clone(),
            video_frame: None,
            camera_frame: None,
            cursor_position: None,
        };

        // Prepare and render
        futures::executor::block_on(layer_stack.prepare(&frame_data))?;

        let canvas = surface.canvas();
        canvas.clear(skia_safe::Color::BLACK);
        layer_stack.render(canvas, &uniforms);

        // Flush to ensure rendering is complete
        context.flush();

        // Save output
        let image = surface.image_snapshot();
        println!(
            "   - Image snapshot for angle {}: {}x{}",
            angle,
            image.width(),
            image.height()
        );
        match image.encode(context.direct_context(), EncodedImageFormat::PNG, 100) {
            Some(data) => {
                let path = format!(
                    "{}/background_gradient_angle_{}.png",
                    output_dir, angle as i32
                );
                fs::write(&path, data.as_bytes())?;
                println!("   ✓ Saved gradient with angle {angle} to: {path}");
            }
            None => {
                println!("   ✗ Failed to encode gradient angle {angle} image to PNG");
            }
        }
    }

    Ok(())
}

fn test_caching(
    context: &mut SkiaRenderContext,
    width: u32,
    height: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut surface = context.create_surface(width, height)?;
    let mut layer_stack = LayerStack::new();

    // Add background layer
    let background_layer = Box::new(BackgroundLayer::new());
    let _layer_id = layer_stack.add_recorded(background_layer);

    let uniforms = SkiaProjectUniforms {
        output_size: (width, height),
        background: BackgroundSource::Gradient {
            from: [0, 65535, 0],
            to: [0, 0, 65535],
            angle: 90,
        },
    };

    let frame_data = FrameData {
        uniforms: uniforms.clone(),
        video_frame: None,
        camera_frame: None,
        cursor_position: None,
    };

    // First render - should record
    println!("   - First render (recording)...");
    let start = std::time::Instant::now();
    futures::executor::block_on(layer_stack.prepare(&frame_data))?;
    let canvas = surface.canvas();
    layer_stack.render(canvas, &uniforms);
    let first_render_time = start.elapsed();
    println!("     Time: {first_render_time:?}");

    // Second render with same uniforms - should use cache
    println!("   - Second render (using cache)...");
    let start = std::time::Instant::now();
    let canvas = surface.canvas();
    layer_stack.render(canvas, &uniforms);
    let cached_render_time = start.elapsed();
    println!("     Time: {cached_render_time:?}");

    // Cache should make it faster
    if cached_render_time < first_render_time {
        println!(
            "   ✓ Caching is working! Cached render is {:.2}x faster",
            first_render_time.as_secs_f64() / cached_render_time.as_secs_f64()
        );
    } else {
        println!("   ⚠ Cached render was not faster (may be due to small render time)");
    }

    // Change uniforms - should re-record
    println!("   - Third render (new gradient, re-recording)...");
    let new_uniforms = SkiaProjectUniforms {
        output_size: (width, height),
        background: BackgroundSource::Gradient {
            from: [65535, 0, 0],
            to: [65535, 65535, 0],
            angle: 45,
        },
    };

    let new_frame_data = FrameData {
        uniforms: new_uniforms.clone(),
        video_frame: None,
        camera_frame: None,
        cursor_position: None,
    };

    let start = std::time::Instant::now();
    futures::executor::block_on(layer_stack.prepare(&new_frame_data))?;
    let canvas = surface.canvas();
    layer_stack.render(canvas, &new_uniforms);
    let new_render_time = start.elapsed();
    println!("     Time: {new_render_time:?}");

    Ok(())
}
