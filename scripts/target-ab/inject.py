import pathlib, shutil, sys

root = pathlib.Path(sys.argv[1])
src = root / "apps/desktop-gpui/src"


def edit(path, old, new):
    p = src / path
    s = p.read_text()
    if s.count(old) != 1:
        raise SystemExit(f"anchor not found once in {path}: {old[:60]!r}")
    p.write_text(s.replace(old, new))


shutil.copy(pathlib.Path(__file__).with_name("target_probe.rs"), src / "target_probe.rs")
edit("main.rs", "mod app_windows;\n", "mod app_windows;\nmod target_probe;\n")
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
    "main_window.rs",
    "    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {\n        self.sync_appearance(window, cx);\n",
    "    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {\n        crate::target_probe::count_render();\n        self.sync_appearance(window, cx);\n",
)
edit(
    "target_thumbnails.rs",
    "            capture_display_thumbnail(&display, content.retained()),\n",
    "            crate::target_probe::display(capture_display_thumbnail(&display, content.retained())),\n",
)
edit(
    "target_thumbnails.rs",
    "            capture_window_thumbnail(&window, content.retained()),\n",
    "            crate::target_probe::window(capture_window_thumbnail(&window, content.retained())),\n",
)
print("probe injected into", root)
