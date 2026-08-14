pub use cap_cli_install::CliInstallStatus;

#[cap_desktop_runtime::command]
#[specta::specta]
pub fn get_cli_install_status() -> Result<CliInstallStatus, String> {
    cap_cli_install::status()
}

#[cap_desktop_runtime::command]
#[specta::specta]
pub fn install_cli() -> Result<CliInstallStatus, String> {
    cap_cli_install::install()
}

#[cap_desktop_runtime::command]
#[specta::specta]
pub fn uninstall_cli() -> Result<CliInstallStatus, String> {
    cap_cli_install::uninstall()
}
