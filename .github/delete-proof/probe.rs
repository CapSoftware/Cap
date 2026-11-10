use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const FILES: [&str; 7] = [
    "recording-meta.json",
    "project-config.json",
    "content/cursors/cursor_0.png",
    "content/segments/segment-0/cursor.json",
    "content/segments/segment-0/display.mp4",
    "content/segments/segment-0/keyboard.bin",
    "screenshots/display.jpg",
];
const HELD: &str = "content/segments/segment-0/display.mp4";

fn build(root: &Path) -> PathBuf {
    let bundle = root.join("Recording.cap");
    for file in FILES {
        let path = bundle.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::File::create(&path).unwrap().write_all(b"data").unwrap();
    }
    bundle
}

fn count(path: &Path) -> usize {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() { count(&path) } else { 1 }
        })
        .sum()
}

fn describe<T>(result: &std::io::Result<T>) -> String {
    match result {
        Ok(_) => "ok".to_string(),
        Err(error) => format!("error os={:?} kind={:?}", error.raw_os_error(), error.kind()),
    }
}

#[cfg(windows)]
fn holders() -> Vec<(&'static str, Box<dyn Fn(&Path) -> fs::File>)> {
    use std::os::windows::fs::OpenOptionsExt;
    vec![
        (
            "file open, share read+write+delete (Rust default)",
            Box::new(|bundle: &Path| fs::File::open(bundle.join(HELD)).unwrap()),
        ),
        (
            "file open, share read+write (C runtime default)",
            Box::new(|bundle: &Path| {
                fs::OpenOptions::new()
                    .read(true)
                    .share_mode(3)
                    .open(bundle.join(HELD))
                    .unwrap()
            }),
        ),
        (
            "file open, share none",
            Box::new(|bundle: &Path| {
                fs::OpenOptions::new()
                    .read(true)
                    .share_mode(0)
                    .open(bundle.join(HELD))
                    .unwrap()
            }),
        ),
        (
            "subdirectory handle open, share all",
            Box::new(|bundle: &Path| {
                fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(0x0200_0000)
                    .open(bundle.join("content/segments"))
                    .unwrap()
            }),
        ),
    ]
}

#[cfg(not(windows))]
fn holders() -> Vec<(&'static str, Box<dyn Fn(&Path) -> fs::File>)> {
    vec![(
        "file open",
        Box::new(|bundle: &Path| fs::File::open(bundle.join(HELD)).unwrap()),
    )]
}

fn main() {
    let base = std::env::temp_dir().join(format!("delete-probe-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    println!("| holder | strategy | step | result | files left in recording | files left aside |");
    println!("| --- | --- | --- | --- | --- | --- |");
    for (index, (name, hold)) in holders().into_iter().enumerate() {
        let root = base.join(format!("direct-{index}"));
        let bundle = build(&root);
        let held = hold(&bundle);
        let removed = fs::remove_dir_all(&bundle);
        println!(
            "| {name} | remove in place | remove_dir_all | {} | {} of {} | |",
            describe(&removed),
            count(&bundle),
            FILES.len()
        );
        drop(held);

        let root = base.join(format!("aside-{index}"));
        let bundle = build(&root);
        let holding = root.join(".cap-deleting");
        fs::create_dir(&holding).unwrap();
        let aside = holding.join("0123456789abcdef");
        let held = hold(&bundle);
        let moved = fs::rename(&bundle, &aside);
        println!(
            "| {name} | move aside | rename | {} | {} of {} | {} |",
            describe(&moved),
            count(&bundle),
            FILES.len(),
            count(&holding)
        );
        if moved.is_ok() {
            let removed = fs::remove_dir_all(&holding);
            println!(
                "| {name} | move aside | remove_dir_all after rename | {} | {} of {} | {} |",
                describe(&removed),
                count(&bundle),
                FILES.len(),
                count(&holding)
            );
        }
        drop(held);
        if bundle.exists() {
            let moved = fs::rename(&bundle, &aside);
            let removed = fs::remove_dir_all(&holding);
            println!(
                "| {name} | move aside, holder closed | rename then remove_dir_all | {} then {} | {} of {} | {} |",
                describe(&moved),
                describe(&removed),
                count(&bundle),
                FILES.len(),
                count(&holding)
            );
        }
    }
    let _ = fs::remove_dir_all(&base);
}
