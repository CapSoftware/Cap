use std::time::{Duration, Instant};

fn main() {
    let seconds = std::env::args()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(30u64);
    let (tx, rx) = flume::unbounded();
    let started = Instant::now();
    let _watcher = cap_meeting_platform::MicWatcher::spawn(tx).expect("watcher");
    let deadline = started + Duration::from_secs(seconds);
    while let Ok(snapshot) = rx.recv_deadline(deadline) {
        println!(
            "{:>8.3}s in_use={} attributed={} default={:?} devices={}",
            started.elapsed().as_secs_f64(),
            snapshot.mic_in_use,
            snapshot.attributed,
            snapshot.default_input,
            snapshot.input_devices.len(),
        );
        for client in &snapshot.clients {
            println!(
                "          {} (raw {}, pid {}, device known: {})",
                client.id,
                client.raw_id,
                client.pid,
                client.device_uid.is_some()
            );
        }
    }
}
