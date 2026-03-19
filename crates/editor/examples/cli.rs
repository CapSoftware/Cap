use cap_editor::EditorInstance;
use cap_project::XY;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let path: PathBuf = std::env::args().collect::<Vec<_>>().swap_remove(1).into();

    let editor = EditorInstance::new(path, |_s| {}, Box::new(|_| {}), None)
        .await
        .unwrap();

    editor.start_playback(30, XY::new(1920, 1080)).await;

    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
}
