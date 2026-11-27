#[cfg(windows)]
mod win;

#[cfg(windows)]
fn main() {
    if let Err(e) = win::run() {
        eprintln!("wgcprobe error: {e:?}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("wgcprobe runs on Windows only");
}
