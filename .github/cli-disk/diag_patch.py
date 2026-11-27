"""CI scratch only: holds back Stop in the Studio actor by CAP_DIAG_STOP_DELAY_S seconds."""
import pathlib

p = pathlib.Path("crates/recording/src/studio_recording.rs")
s = p.read_text()
old = """        self.update_diagnostic_segment_count();
        if let Some(diagnostic) = &mut self.diagnostic {
            diagnostic.stage(if discard"""
assert s.count(old) == 1, s.count(old)
s = s.replace(old, """        if let Some(delay) = std::env::var("CAP_DIAG_STOP_DELAY_S").ok().and_then(|v| v.parse::<f64>().ok()) {
            tracing::warn!(delay, "diag stop delayed");
            tokio::time::sleep(std::time::Duration::from_secs_f64(delay)).await;
        }
""" + old, 1)
p.write_text(s)
print("diag delay applied")
