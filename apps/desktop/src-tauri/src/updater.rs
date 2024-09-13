use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
#[specta::specta]
pub async fn check_for_updates(app: AppHandle) -> Result<(), ()> {
    let Some(update) = app
        .updater()
        .map_err(|_| {})?
        .check()
        .await
        .map_err(|_| {})?
    else {
        return Ok(());
    };

    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .message(format!(
            "Version {} of Cap is available, would you like to install it?",
            update.version
        ))
        .title("Update Cap")
        .ok_button_label("Update")
        .cancel_button_label("Ignore")
        .show(move |install| {
            tx.send(install).ok();
        });

    if !rx.await.unwrap() {
        return Ok(());
    }

    update
        .download_and_install(
            |_, _| {},
            || {
            },
        )
        .await
        .unwrap();

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "Cap v{} has been installed, restart Cap to finish updating.",
            update.version
        ))
        .title("Update Cap")
        .ok_button_label("Restart Now")
        .cancel_button_label("Restart Later")
        .show(|restart| {
            tx.send(restart).ok();
        });

    if rx.await.unwrap() {
        app.restart();
    }

    return Ok(());
}
