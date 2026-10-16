use std::{
    path::Path,
    time::{Duration, Instant, SystemTime},
};

pub fn wait(output: &Path, stage: &str) -> std::io::Result<()> {
    let Some(target) = std::env::var_os("CAP_VERIFY_FINALIZE_BARRIER") else {
        return Ok(());
    };
    if Path::new(&target) != output {
        return Ok(());
    }
    let entered = output.join("finalize-entered.json");
    let temporary = output.join("finalize-entered.tmp");
    let unix_nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(std::io::Error::other)?
        .as_nanos();
    std::fs::write(
        &temporary,
        serde_json::to_vec(&serde_json::json!({
            "stage": stage,
            "pid": std::process::id(),
            "unix_nanos": unix_nanos,
        }))
        .map_err(std::io::Error::other)?,
    )?;
    std::fs::rename(temporary, entered)?;
    let start = Instant::now();
    while !output.join("finalize-release").exists() {
        if start.elapsed() >= Duration::from_secs(30) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "finalize barrier timed out",
            ));
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}
