fn main() {
    println!("access: {:?}", cap_meeting_platform::calendar_access());
    match cap_meeting_platform::system_calendars() {
        Ok(calendars) => println!("{} calendars", calendars.len()),
        Err(access) => println!("calendars unavailable: {access:?}"),
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64);
    match cap_meeting_platform::system_events(now - 86_400_000, now + 14 * 86_400_000) {
        Ok(events) => {
            println!("{} events in the window", events.len());
            for event in events.iter().take(5) {
                println!(
                    "  {} attendees, all_day={}, recurring={}, has_url={}",
                    event.attendees.len(),
                    event.all_day,
                    event.recurring,
                    event.url.is_some()
                );
            }
        }
        Err(access) => println!("events unavailable: {access:?}"),
    }
}
