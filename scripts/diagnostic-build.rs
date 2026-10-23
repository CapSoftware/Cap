use std::{
    path::{Path, PathBuf},
    process::Command,
};

fn git_executable() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("CAP_BUILD_GIT") {
        let path = PathBuf::from(path);
        return (path.is_absolute() && path.is_file()).then_some(path);
    }
    #[cfg(windows)]
    let mut candidates = ["ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(|directory| PathBuf::from(directory).join("Git/cmd/git.exe"));
    #[cfg(not(windows))]
    let mut candidates = ["/usr/bin/git", "/bin/git"].into_iter().map(PathBuf::from);
    candidates.find(|path| path.is_absolute() && path.is_file())
}

pub fn emit() {
    println!("cargo:rerun-if-env-changed=CAP_BUILD_GIT");
    println!("cargo:rerun-if-changed=src");
    let Some(executable) = git_executable() else {
        return;
    };
    let Ok(directory) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let git = |args: &[&str]| {
        Command::new(&executable)
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
}
