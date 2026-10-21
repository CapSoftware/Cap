import pathlib, shutil, sys

root = pathlib.Path(sys.argv[1])
src = root / "apps/desktop-gpui/src"


def edit(path, old, new):
    p = src / path
    s = p.read_text()
    if s.count(old) != 1:
        raise SystemExit(f"anchor not found once in {path}: {old[:60]!r}")
    p.write_text(s.replace(old, new))


shutil.copy(pathlib.Path(__file__).with_name("loader_probe.rs"), src / "loader_probe.rs")
edit("main.rs", "mod app_windows;\n", "mod app_windows;\nmod loader_probe;\n")
edit(
    "main.rs",
    'let first_run = cfg!(not(target_os = "linux"))',
    'let first_run = std::env::var_os("CAP_PERF_SKIP_ONBOARDING").is_none() && cfg!(not(target_os = "linux"))',
)
edit(
    "store.rs",
    "pub fn should_show_onboarding() -> bool {\n",
    'pub fn should_show_onboarding() -> bool {\n    if std::env::var_os("CAP_PERF_SKIP_ONBOARDING").is_some() {\n        return false;\n    }\n',
)
edit(
    "main.rs",
    "        // `CAP_GPUI_AUTO_CAMERA_BENCH=1`: open the camera bubble and pump\n",
    """        if std::env::var_os("CAP_PROBE_CAMERA_LOADING").is_some() {
            crate::loader_probe::start_reporter();
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(3))
                    .await;
                let _ = cx.update(|cx| app_windows::open_camera_window(cx));
            })
            .detach();
        }

        // `CAP_GPUI_AUTO_CAMERA_BENCH=1`: open the camera bubble and pump
""",
)
edit(
    "camera_window.rs",
    "        let has_issue =\n            self.camera_error.is_some() || self.effect_issue.is_some() || awaiting_access;\n",
    "        let has_issue =\n            self.camera_error.is_some() || self.effect_issue.is_some() || awaiting_access;\n        let has_issue = has_issue && std::env::var_os(\"CAP_PROBE_CAMERA_LOADING\").is_none();\n",
)
edit(
    "camera_loading.rs",
    "            if opacity > 0. {\n                let script_area",
    "            crate::loader_probe::count_paint();\n            if opacity > 0. {\n                let script_area",
)
print("loader probe injected into", root)
