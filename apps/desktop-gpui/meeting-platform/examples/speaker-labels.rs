//! speaker-labels <pid> [polls] [--browser] : poll a meeting app's speaking
//! labels every 500 ms and print them with the walk's cost.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let pid: u32 = args.get(1).and_then(|a| a.parse().ok()).expect("pid");
    let polls: usize = args.get(2).and_then(|a| a.parse().ok()).unwrap_or(20);
    let browser = args.iter().any(|a| a == "--browser");
    let pages: &'static [&'static str] = if args.iter().any(|a| a == "--any-page") {
        &[""]
    } else {
        &[
            "meet.google.com",
            "teams.microsoft.com",
            "teams.live.com",
            "zoom.us/wc",
        ]
    };
    let mut worst = std::time::Duration::ZERO;
    for i in 0..polls {
        let got = cap_meeting_platform::speaker_labels(pid, browser, pages);
        worst = worst.max(got.took);
        println!(
            "{i:3} trusted={} complete={} visited={} took={:?} labels={:?}",
            got.trusted, got.complete, got.visited, got.took, got.labels
        );
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    println!("worst walk {worst:?}");
}
