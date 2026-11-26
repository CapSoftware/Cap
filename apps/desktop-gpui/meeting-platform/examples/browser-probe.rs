fn main() {
    let pid: u32 = std::env::args()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .expect("usage: browser-probe <pid>");
    let started = std::time::Instant::now();
    let probe = cap_meeting_platform::probe_browser(pid);
    println!(
        "trusted={} complete={} in {:.1} ms",
        probe.trusted,
        probe.complete,
        started.elapsed().as_secs_f64() * 1000.0
    );
    for url in &probe.urls {
        println!("url   {url}");
    }
    for title in &probe.titles {
        println!("title {title}");
    }
}
