use tauri::AppHandle;
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

    let should_update = tokio::task::spawn_blocking({
        let version = update.version.clone();
        let app = app.clone();
        move || {
            app.dialog()
                .message(format!(
                    "Version {} of Cap is available, would you like to install it?",
                    version
                ))
                .title("Update Cap")
                .ok_button_label("Update")
                .cancel_button_label("Ignore")
                .blocking_show()
        }
    })
    .await
    .unwrap();

    if !should_update {
        return Ok(());
    }

    update.download_and_install(|_, _| {}, || {}).await.unwrap();

    let should_restart = tokio::task::spawn_blocking({
        let version = update.version.clone();
        let app = app.clone();
        move || {
            app.dialog()
                .message(format!(
                    "Cap v{version} has been installed, restart Cap to finish updating.",
                ))
                .title("Update Cap")
                .ok_button_label("Restart Now")
                .cancel_button_label("Restart Later")
                .blocking_show()
        }
    })
    .await
    .unwrap();

    if should_restart {
        app.restart();
    }

    return Ok(());
}
