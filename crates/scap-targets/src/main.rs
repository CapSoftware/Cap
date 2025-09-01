use std::time::Duration;

fn main() {
    #[cfg(windows)]
    {
        use windows::Win32::UI::HiDpi::{PROCESS_PER_MONITOR_DPI_AWARE, SetProcessDpiAwareness};

        unsafe { SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE).unwrap() };
    }

    // Test display functionality
    println!("=== Display Information ===");
    for (index, display) in scap_targets::Display::list().iter().enumerate() {
        println!("Display {}: {}", index + 1, display.name().unwrap());
        println!("  ID: {}", display.id());

        let logical_size = display.raw_handle().logical_size().unwrap();
        let physical_size = display.physical_size().unwrap();
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
        let main_display_id = scap_targets::Display::list().first().map(|d| d.id());

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

    if let Some(cursor_display) = scap_targets::Display::get_containing_cursor() {
        println!(
            "🖱️  Cursor is currently on: {}",
            cursor_display.name().unwrap()
        );
        println!();
    }

    // Test window functionality
    println!("=== Windows Under Cursor ===");
    let windows = scap_targets::Window::list_containing_cursor();

    if windows.is_empty() {
        println!("No windows found under cursor");
    } else {
        println!("Found {} window(s) under cursor:", windows.len());
        for (index, window) in windows.iter().take(5).enumerate() {
            // Limit to first 5 windows
            println!("\nWindow {}: {}", index + 1, window.id());

            #[cfg(target_os = "macos")]
            if let Some(bounds) = window.raw_handle().logical_bounds() {
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
                    println!("  Icon (Standard): {} bytes", icon_data.len());
                    println!("    Format: PNG (Raw bytes)");
                    println!("    Size: {} bytes", icon_data.len());
                }
                None => println!("  Icon (Standard): Not available"),
            }
        }
    }

    println!("\n=== Topmost Window Icon Test ===");
    if let Some(topmost) = scap_targets::Window::get_topmost_at_cursor()
        && let Some(owner) = topmost.owner_name()
    {
        println!("Testing icon extraction for: {}", owner);

        match topmost.app_icon() {
            Some(icon_data) => {
                println!("  ✅ Icon found: {} bytes", icon_data.len());
                println!("    Format: PNG (Raw bytes)");
                println!("    Size: {} bytes", icon_data.len());
            }
            None => println!("  ❌ No icon found"),
        }
    }

    println!("\n=== Live Monitoring (Press Ctrl+C to exit) ===");
    println!("Monitoring window levels under cursor...\n");

    loop {
        let mut relevant_windows = scap_targets::WindowImpl::list_containing_cursor()
            .into_iter()
            .filter_map(|window| {
                let level = window.level()?;
                level.lt(&5).then_some((window, level))
            })
            .collect::<Vec<_>>();

        relevant_windows.sort_by(|a, b| b.1.cmp(&a.1));

        // Print current topmost window info
        if let Some((topmost_window, level)) = relevant_windows.first()
            && let Some(owner) = topmost_window.owner_name()
        {
            print!("\rTopmost: {} (level: {})    ", owner, level);
            std::io::Write::flush(&mut std::io::stdout()).unwrap();
        }

        std::thread::sleep(Duration::from_millis(100));
    }
}
