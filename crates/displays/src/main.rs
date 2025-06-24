use std::time::Duration;

fn main() {
    loop {
        let mut relevant_windows = cap_displays::WindowImpl::list_containing_cursor()
            .into_iter()
            .filter_map(|window| {
                let level = window.level()?;
                level.lt(&5).then_some((window, level))
            })
            .collect::<Vec<_>>();

        relevant_windows.sort_by(|a, b| b.1.cmp(&a.1));

        dbg!(relevant_windows.get(0).and_then(|(window, _)| Some((
            window.owner_name()?,
            window.bounds()?,
            window.level()?
        ))));

        std::thread::sleep(Duration::from_millis(50));
    }
}
