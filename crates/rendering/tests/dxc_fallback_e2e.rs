#![cfg(target_os = "windows")]

use std::path::PathBuf;

struct UnloadableBundledDxc {
    files: Vec<(PathBuf, Option<PathBuf>)>,
}

impl UnloadableBundledDxc {
    fn install() -> Self {
        let exe = std::env::current_exe().expect("test exe");
        let dir = exe.parent().expect("test exe dir");
        let mut files = Vec::new();
        for name in ["dxcompiler.dll", "dxil.dll"] {
            let path = dir.join(name);
            let backup = path.exists().then(|| {
                let backup = dir.join(format!("{name}.proof-backup"));
                std::fs::rename(&path, &backup).expect("back up dll");
                backup
            });
            std::fs::write(&path, b"").expect("write zero-byte dll");
            files.push((path, backup));
        }
        Self { files }
    }
}

impl Drop for UnloadableBundledDxc {
    fn drop(&mut self) {
        for (path, backup) in &self.files {
            let _ = std::fs::remove_file(path);
            if let Some(backup) = backup {
                let _ = std::fs::rename(backup, path);
            }
        }
    }
}

#[test]
fn shared_device_with_unloadable_bundled_dxc() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init();
    let _dlls = UnloadableBundledDxc::install();

    match pollster::block_on(cap_rendering::create_shared_device()) {
        Ok(shared) => {
            let info = shared.adapter.get_info();
            println!(
                "PROOF RESULT: Ok, device created on adapter={} backend={:?} type={:?}",
                info.name, info.backend, info.device_type
            );
            let second = pollster::block_on(cap_rendering::create_shared_device());
            println!("PROOF RESULT: second instance ok={}", second.is_ok());
            assert!(second.is_ok());
        }
        Err(error) => {
            println!("PROOF RESULT: Err({error})");
            panic!("create_shared_device failed: {error}");
        }
    }
}
