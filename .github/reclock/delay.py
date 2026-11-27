"""delay.py: env-gated delay (CAP_DIAG_STOP_DELAY_S) before the Studio actor handles Stop, so a late stop can be
produced on demand the same way on every arm. Run from the repo root."""
import pathlib

p = pathlib.Path("crates/recording/src/studio_recording.rs")
s = p.read_text()
old = '''        message: StopWithIntent,
        ctx: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
'''
assert s.count(old) == 1, s.count(old)
s = s.replace(old, old + '''        if let Some(delay) = std::env::var("CAP_DIAG_STOP_DELAY_S")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
        {
            tracing::warn!(delay, "diag stop delayed");
            tokio::time::sleep(std::time::Duration::from_secs_f64(delay)).await;
        }
''')
p.write_text(s)
print("delay applied")
