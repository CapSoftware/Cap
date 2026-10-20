//! `Contents/MacOS/cap-cli` in the macOS app.
//!
//! The app binary next to it runs the CLI when its first argument is `--cap-cli`, so the bundle
//! carries one copy of the recording, rendering and export engine instead of two. This launcher
//! keeps the `cap-cli` path that `cap desktop install-cli`, Settings → CLI and every existing
//! `~/.cap/bin/cap` shim point at.

#[cfg(target_os = "macos")]
fn main() -> std::process::ExitCode {
    use std::os::unix::process::CommandExt;

    let mut args = std::env::args_os();
    let program = args.next().unwrap_or_else(|| "cap".into());
    // A shim reaches this binary through a symlink, and `current_exe` reports the symlink.
    let app = match std::env::current_exe().and_then(std::fs::canonicalize) {
        Ok(exe) => exe.with_file_name("Cap"),
        Err(error) => {
            eprintln!("error: Could not locate the Cap app: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let error = std::process::Command::new(&app)
        .arg0(program)
        .arg("--cap-cli")
        .args(args)
        .exec();
    eprintln!(
        "error: Could not launch the Cap CLI at {}: {error}",
        app.display()
    );
    std::process::ExitCode::FAILURE
}

#[cfg(not(target_os = "macos"))]
fn main() -> std::process::ExitCode {
    eprintln!("error: cap-cli-launcher only ships in the macOS app");
    std::process::ExitCode::FAILURE
}
