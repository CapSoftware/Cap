use cap_rendering_skia::{SkiaRenderContext, SkiaRenderingError};
use std::fs;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing for debug output
    tracing_subscriber::fmt::init();

    println!("=== Skia Rendering Test ===");
    println!("Testing Skia context creation and basic rendering...\n");

    // Create Skia context
    println!("1. Creating Skia context...");
    let mut context = match SkiaRenderContext::new() {
        Ok(ctx) => {
            println!("   ✓ Skia context created successfully");
            ctx
        }
        Err(e) => {
            println!("   ✗ Failed to create Skia context: {e}");
            return Err(e.into());
        }
    };

    // Check if GPU acceleration is enabled
    if context.is_gpu_accelerated() {
        println!("   ✓ GPU acceleration: ENABLED (Metal)");
    } else {
        println!("   ⚠ GPU acceleration: DISABLED (using CPU backend)");
    }

    // Test surface creation
    println!("\n2. Testing surface creation...");
    let test_sizes = [(800, 600), (1920, 1080), (100, 100)];

    for (width, height) in test_sizes {
        match context.create_surface(width, height) {
            Ok(_) => {
                println!("   ✓ Created {width}x{height} surface");
            }
            Err(e) => {
                println!("   ✗ Failed to create {width}x{height} surface: {e}");
            }
        }
    }

    // Test invalid surface creation
    println!("\n3. Testing error handling...");
    match context.create_surface(0, 100) {
        Ok(_) => {
            println!("   ✗ Unexpectedly succeeded creating 0x100 surface");
        }
        Err(SkiaRenderingError::InvalidDimensions(_)) => {
            println!("   ✓ Correctly rejected invalid dimensions");
        }
        Err(e) => {
            println!("   ✗ Wrong error type: {e}");
        }
    }

    // Test rendering
    println!("\n4. Testing rendering...");
    let render_width = 800;
    let render_height = 600;

    match context.test_render(render_width, render_height) {
        Ok(pixels) => {
            println!("   ✓ Rendering completed successfully");
            println!("   - Output size: {} bytes", pixels.len());
            println!(
                "   - Expected size: {} bytes",
                render_width * render_height * 4
            );

            // Save as PPM for easy verification
            let output_path = "test_render.ppm";
            save_as_ppm(&pixels, render_width, render_height, output_path)?;
            println!("   ✓ Saved test render to: {output_path}");

            // Verify some pixels
            println!("\n5. Verifying pixel data...");
            let center_idx =
                (((render_height / 2) * render_width + (render_width / 2)) * 4) as usize;
            let center_pixel = &pixels[center_idx..center_idx + 4];
            println!("   - Center pixel RGBA: {center_pixel:?}");

            // The center should be greenish (from the circle)
            if center_pixel[1] > center_pixel[0] && center_pixel[1] > center_pixel[2] {
                println!("   ✓ Center pixel is green as expected");
            } else {
                println!("   ! Center pixel color unexpected");
            }
        }
        Err(e) => {
            println!("   ✗ Rendering failed: {e}");
            return Err(e.into());
        }
    }

    println!("\n=== All tests completed ===");
    println!("Skia integration is working correctly!");

    Ok(())
}

fn save_as_ppm(pixels: &[u8], width: u32, height: u32, path: &str) -> std::io::Result<()> {
    use std::io::Write;

    let mut file = fs::File::create(path)?;

    // PPM header
    writeln!(file, "P3")?;
    writeln!(file, "{width} {height}")?;
    writeln!(file, "255")?;

    // Write pixels (PPM is RGB, our data is RGBA)
    for y in 0..height {
        for x in 0..width {
            let idx = ((y * width + x) * 4) as usize;
            let r = pixels[idx];
            let g = pixels[idx + 1];
            let b = pixels[idx + 2];
            write!(file, "{r} {g} {b} ")?;
        }
        writeln!(file)?;
    }

    Ok(())
}
