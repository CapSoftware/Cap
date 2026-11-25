//! hybrid-replay <run json> <dump stem> <out json>: applies the crate's final-pass hybrid to a harness report made
//! without Nemotron, using Nemotron voices dumped by another run (`<stem>.mic.u8`, `.mic.parts.json`, `.system.*`).
//! Writes the report with the new final labels and the hybrid's stats under "replay".

use cap_diarize::FinalPass;
use cap_diarize::nemotron::TrackVoices;

fn load(stem: &str, track: &str) -> TrackVoices {
    let raw = std::fs::read(format!("{stem}.{track}.u8")).unwrap_or_default();
    let parts: Vec<(usize, u64, usize)> = std::fs::read(format!("{stem}.{track}.parts.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    TrackVoices::from_raw(raw, &parts)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut report: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[0]).expect("run json")).unwrap();
    let mut pass: FinalPass = serde_json::from_value(report["final"].clone()).expect("final pass");
    let voices = [load(&args[1], "mic"), load(&args[1], "system")];
    let stats = cap_diarize::hybrid::apply(&mut pass, &voices);
    report["final"] = serde_json::to_value(&pass).unwrap();
    report["replay"] = serde_json::json!({"relabelledMs": stats.relabelled_ms, "newVoices": stats.new_voices, "tracksKept": stats.tracks_kept});
    std::fs::write(&args[2], serde_json::to_vec(&report).unwrap()).expect("write");
}
