use std::time::Duration;

fn main() {
    // Test display functionality
    println!("=== Display Information ===");
    for display in cap_displays::Display::list() {
        println!("Display ID: {}", display.id());
        let logical_size = display.raw_handle().logical_size();
        let physical_size = display.physical_size();
        let refresh_rate = display.refresh_rate();

        println!(
            "  Logical Size: {}x{}",
            logical_size.width(),
            logical_size.height()
        );
        println!(
            "  Physical Size: {}x{}",
            physical_size.width(),
            physical_size.height()
        );
        println!("  Refresh Rate: {} Hz", refresh_rate);
        println!();
    }

    if let Some(cursor_display) = cap_displays::Display::get_containing_cursor() {
        println!("Display containing cursor: {}", cursor_display.id());
        println!();
    }

    // Test window functionality
    println!("=== Window Information ===");
    let windows = cap_displays::Window::list_containing_cursor();
    for window in windows.iter().take(5) {
        // Limit to first 5 windows
        println!("Window ID: {}", window.id());

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
            println!("  Owner: {}", owner);
        }

        // Test icon functionality (currently returns None)
        match window.app_icon() {
            Some(icon_data) => println!("  Icon: {} bytes", icon_data.len()),
            None => println!("  Icon: Not available"),
        }

        println!();
    }

    loop {
        let mut relevant_windows = cap_displays::WindowImpl::list_containing_cursor()
            .into_iter()
            .filter_map(|window| {
                let level = window.level()?;
                level.lt(&5).then_some((window, level))
            })
            .collect::<Vec<_>>();

        relevant_windows.sort_by(|a, b| b.1.cmp(&a.1));

        std::thread::sleep(Duration::from_millis(50));
    }
}
