use std::{path::Path, process::Command};

pub fn emit() {
    let Ok(directory) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(&directory)
            .output()
            .ok()
    };
    if let Some(output) = git(&["rev-parse", "HEAD"])
        && output.status.success()
    {
        let revision = String::from_utf8_lossy(&output.stdout);
        let revision = revision.trim();
        if (revision.len() == 40 || revision.len() == 64)
            && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            println!("cargo:rustc-env=CAP_BUILD_REVISION={revision}");
        }
    }
    if let Some(output) = git(&["diff-index", "--quiet", "HEAD", "--"]) {
        match output.status.code() {
            Some(0) => println!("cargo:rustc-env=CAP_BUILD_DIRTY=false"),
            Some(1) => println!("cargo:rustc-env=CAP_BUILD_DIRTY=true"),
            _ => {}
        }
    }
    for entry in ["HEAD", "refs", "index"] {
        if let Some(output) = git(&["rev-parse", "--git-path", entry])
            && output.status.success()
        {
            let path = String::from_utf8_lossy(&output.stdout);
            println!(
                "cargo:rerun-if-changed={}",
                Path::new(&directory).join(path.trim()).display()
            );
        }
    }
    println!("cargo:rerun-if-changed=src");
}
