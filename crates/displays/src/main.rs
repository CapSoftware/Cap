use std::time::Duration;

fn main() {
    // Test display functionality
    println!("=== Display Information ===");
    for (index, display) in cap_displays::Display::list().iter().enumerate() {
        println!("Display {}: {}", index + 1, display.name());
        println!("  ID: {}", display.id());

        let logical_size = display.raw_handle().logical_size();
        let physical_size = display.physical_size();
        let refresh_rate = display.refresh_rate();

        println!(
            "  Logical Resolution: {}x{}",
            logical_size.width(),
            logical_size.height()
        );
        println!(
            "  Physical Resolution: {}x{}",
            physical_size.width(),
            physical_size.height()
        );

        if refresh_rate > 0.0 {
            println!("  Refresh Rate: {} Hz", refresh_rate);
        } else {
            println!("  Refresh Rate: Unknown");
        }

        // Check if this is the main display
        let main_display_id = cap_displays::Display::list().get(0).map(|d| d.id());

        if let Some(main_id) = main_display_id {
            if display.id() == main_id {
                println!("  Type: Primary Display");
            } else {
                println!("  Type: Secondary Display");
            }
        } else {
            println!("  Type: Unknown");
        }

        println!();
    }

    if let Some(cursor_display) = cap_displays::Display::get_containing_cursor() {
        println!("🖱️  Cursor is currently on: {}", cursor_display.name());
        println!();
    }

    // Test window functionality
    println!("=== Windows Under Cursor ===");
    let windows = cap_displays::Window::list_containing_cursor();

    if windows.is_empty() {
        println!("No windows found under cursor");
    } else {
        println!("Found {} window(s) under cursor:", windows.len());
        for (index, window) in windows.iter().take(5).enumerate() {
            // Limit to first 5 windows
            println!("\nWindow {}: {}", index + 1, window.id());

            if let Some(bounds) = window.bounds() {
                println!(
                    "  Bounds: {}x{} at ({}, {})",
                    bounds.size().width(),
                    bounds.size().height(),
                    bounds.position().x(),
                    bounds.position().y()
                );
            }

            if let Some(owner) = window.owner_name() {
                println!("  Application: {}", owner);
            } else {
                println!("  Application: Unknown");
            }

            // Test icon functionality
            match window.app_icon() {
                Some(icon_data) => {
                    println!("  Icon (Standard): {} characters", icon_data.len());
                    if icon_data.starts_with("data:image/png;base64,") {
                        println!("    Format: PNG (Base64 encoded)");
                        let base64_data = &icon_data[22..]; // Skip "data:image/png;base64,"
                        let estimated_bytes = (base64_data.len() * 3) / 4;
                        println!("    Estimated size: {} bytes", estimated_bytes);
                    }
                }
                None => println!("  Icon (Standard): Not available"),
            }

            // Test high-resolution icon functionality
            match window.app_icon_high_res() {
                Some(icon_data) => {
                    println!("  Icon (High-Res): {} characters", icon_data.len());
                    if icon_data.starts_with("data:image/png;base64,") {
                        println!("    Format: PNG (Base64 encoded)");
                        let base64_data = &icon_data[22..]; // Skip "data:image/png;base64,"
                        let estimated_bytes = (base64_data.len() * 3) / 4;
                        println!("    Estimated size: {} bytes", estimated_bytes);

                        // Try to estimate resolution based on data size
                        let estimated_pixels = estimated_bytes / 4; // Assuming 4 bytes per pixel
                        let estimated_dimension = (estimated_pixels as f64).sqrt() as i32;
                        println!(
                            "    Estimated dimensions: ~{}x{}",
                            estimated_dimension, estimated_dimension
                        );
                    }
                }
                None => println!("  Icon (High-Res): Not available"),
            }
        }
    }

    println!("\n=== Icon Resolution Comparison ===");
    if let Some(topmost) = cap_displays::Window::get_topmost_at_cursor() {
        if let Some(owner) = topmost.owner_name() {
            println!("Testing icon resolution for: {}", owner);

            let standard_icon = topmost.app_icon();
            let high_res_icon = topmost.app_icon_high_res();

            match (standard_icon, high_res_icon) {
                (Some(std), Some(hr)) => {
                    println!("  Standard method: {} chars", std.len());
                    println!("  High-res method: {} chars", hr.len());
                    if hr.len() > std.len() {
                        println!("  ✅ High-res method provided larger icon data");
                    } else if hr.len() == std.len() {
                        println!("  ℹ️  Both methods provided same size data");
                    } else {
                        println!("  ⚠️  Standard method had larger data");
                    }
                }
                (Some(_), None) => println!("  ⚠️  Only standard method succeeded"),
                (None, Some(_)) => println!("  ✅ Only high-res method succeeded"),
                (None, None) => println!("  ❌ Neither method found an icon"),
            }
        }
    }

    println!("\n=== Live Monitoring (Press Ctrl+C to exit) ===");
    println!("Monitoring window levels under cursor...\n");

    loop {
        let mut relevant_windows = cap_displays::WindowImpl::list_containing_cursor()
            .into_iter()
            .filter_map(|window| {
                let level = window.level()?;
                level.lt(&5).then_some((window, level))
            })
            .collect::<Vec<_>>();

        relevant_windows.sort_by(|a, b| b.1.cmp(&a.1));

        // Print current topmost window info
        if let Some((topmost_window, level)) = relevant_windows.first() {
            if let Some(owner) = topmost_window.owner_name() {
                print!("\rTopmost: {} (level: {})    ", owner, level);
                std::io::Write::flush(&mut std::io::stdout()).unwrap();
            }
        }

        std::thread::sleep(Duration::from_millis(100));
    }
}
