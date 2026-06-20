pub use cap_cli_install::CliInstallStatus;

#[tauri::command]
#[specta::specta]
pub fn get_cli_install_status() -> Result<CliInstallStatus, String> {
    cap_cli_install::status()
}

#[tauri::command]
#[specta::specta]
pub fn install_cli() -> Result<CliInstallStatus, String> {
    cap_cli_install::install()
}

#[tauri::command]
#[specta::specta]
pub fn uninstall_cli() -> Result<CliInstallStatus, String> {
    cap_cli_install::uninstall()
}
