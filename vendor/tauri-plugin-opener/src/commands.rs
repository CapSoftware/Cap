// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::path::{Path, PathBuf};

use tauri::{
    ipc::{CommandScope, GlobalScope},
    AppHandle, Runtime,
};

use crate::{scope::Scope, Error, OpenerExt};

#[tauri::command]
pub async fn open_url<R: Runtime>(
    app: AppHandle<R>,
    command_scope: CommandScope<crate::scope::Entry>,
    global_scope: GlobalScope<crate::scope::Entry>,
    url: String,
    with: Option<String>,
) -> crate::Result<()> {
    let scope = Scope::new(
        &app,
        command_scope
            .allows()
            .iter()
            .chain(global_scope.allows())
            .collect(),
        command_scope
            .denies()
            .iter()
            .chain(global_scope.denies())
            .collect(),
    );

    if scope.is_url_allowed(&url, with.as_deref()) {
        app.opener().open_url(url, with)
    } else {
        Err(Error::ForbiddenUrl { url, with })
    }
}

#[tauri::command]
pub async fn open_path<R: Runtime>(
    app: AppHandle<R>,
    command_scope: CommandScope<crate::scope::Entry>,
    global_scope: GlobalScope<crate::scope::Entry>,
    path: String,
    with: Option<String>,
) -> crate::Result<()> {
    let scope = Scope::new(
        &app,
        command_scope
            .allows()
            .iter()
            .chain(global_scope.allows())
            .collect(),
        command_scope
            .denies()
            .iter()
            .chain(global_scope.denies())
            .collect(),
    );

    if scope.is_path_allowed(Path::new(&path), with.as_deref())? {
        app.opener().open_path(path, with)
    } else {
        Err(Error::ForbiddenPath { path, with })
    }
}

/// TODO: in the next major version, rename to `reveal_items_in_dir`
#[tauri::command]
pub async fn reveal_item_in_dir(paths: Vec<PathBuf>) -> crate::Result<()> {
    reveal_item_in_dir_with(paths, crate::reveal_items_in_dir).await
}

async fn reveal_item_in_dir_with(
    paths: Vec<PathBuf>,
    reveal: impl FnOnce(Vec<PathBuf>) -> crate::Result<()> + Send + 'static,
) -> crate::Result<()> {
    // The Linux backend uses blocking zbus, which may enter its own Tokio runtime.
    tauri::async_runtime::spawn_blocking(move || reveal(paths)).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn assert_reveal_can_enter_runtime() {
        let paths = vec![
            PathBuf::from("recording with spaces.cap/"),
            PathBuf::from("截图.png"),
        ];
        let expected = paths.clone();
        reveal_item_in_dir_with(paths, move |actual| {
            assert_eq!(actual, expected);
            let runtime = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            runtime.block_on(async { Ok(()) })
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn reveal_from_current_thread_runtime() {
        assert_reveal_can_enter_runtime().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reveal_from_multi_thread_runtime() {
        assert_reveal_can_enter_runtime().await;
    }

    #[tokio::test]
    async fn preserves_backend_errors() {
        let error = reveal_item_in_dir_with(Vec::new(), |_| {
            Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "reveal denied").into())
        })
        .await
        .unwrap_err();
        assert!(matches!(&error, Error::Io(e) if e.kind() == std::io::ErrorKind::PermissionDenied));
        assert_eq!(error.to_string(), "reveal denied");
    }

    #[tokio::test]
    async fn returns_worker_panics_as_errors() {
        let error = reveal_item_in_dir_with(Vec::new(), |_| panic!("reveal worker failed"))
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Tauri(tauri::Error::JoinError(_))));
    }

    #[tokio::test]
    async fn validates_every_path_before_revealing() {
        let directory = tempfile::tempdir().unwrap();
        let existing = directory.path().join("recording with spaces.cap");
        std::fs::write(&existing, []).unwrap();
        let missing = directory.path().join("missing.png");
        let error = reveal_item_in_dir(vec![existing, missing])
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Io(e) if e.kind() == std::io::ErrorKind::NotFound));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linux_zbus_backend_from_tokio_runtime() {
        let result = reveal_item_in_dir(Vec::new()).await;
        // A headless host may lack a session bus or file manager; neither is a worker panic.
        assert!(!matches!(
            result,
            Err(Error::Tauri(tauri::Error::JoinError(_)))
        ));
    }
}
