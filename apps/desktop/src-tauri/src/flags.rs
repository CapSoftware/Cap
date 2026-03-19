pub mod plugin {
    use cap_flags::FLAGS;
    use tauri::{
        Runtime,
        plugin::{Builder, TauriPlugin},
    };

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("cap-flags")
            .js_init_script(format!(
                "window.FLAGS = {}",
                serde_json::to_string_pretty(&FLAGS).unwrap()
            ))
            .build()
    }
}
