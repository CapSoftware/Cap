pub mod plugin {
    use cap_flags::FLAGS;
    use tauri::{
        plugin::{Builder, TauriPlugin},
        Runtime,
    };

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("cap-flags")
            .js_init_script(format!(
                "window.FLAGS = {}",
                serde_json::to_string(&FLAGS).unwrap()
            ))
            .build()
    }
}
