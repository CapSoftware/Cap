import pathlib, shutil, sys

root = pathlib.Path(sys.argv[1])
src = root / "apps/desktop-gpui/src"


def edit(path, old, new):
    p = src / path
    s = p.read_text()
    if s.count(old) != 1:
        raise SystemExit(f"anchor not found once in {path}: {old[:60]!r}")
    p.write_text(s.replace(old, new))


shutil.copy(pathlib.Path(__file__).with_name("meter_probe.rs"), src / "meter_probe.rs")
edit("main.rs", "mod app_windows;\n", "mod app_windows;\nmod meter_probe;\n")
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
    "    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {\n        crate::meter_probe::count_render(self.microphone.is_some());\n        self.sync_appearance(window, cx);\n",
)
edit(
    "feeds.rs",
    """        let meter = cx.background_executor().spawn(async move {
            while let Ok(samples) = meter_rx.recv_async().await {
                sender.push(Instant::now(), db_fs(&samples));
            }
        });
""",
    """        let meter = if let Ok(profile) = std::env::var("CAP_PROBE_FAKE_MIC") {
            let _feeder = std::thread::spawn(move || {
                crate::meter_probe::feed(&profile, move |now, db| sender.push(now, db))
            });
            gpui::Task::ready(())
        } else {
            cx.background_executor().spawn(async move {
                while let Ok(samples) = meter_rx.recv_async().await {
                    sender.push(Instant::now(), db_fs(&samples));
                }
            })
        };
""",
)
edit(
    "feeds.rs",
    "        cx.set_global(FeedsGlobal(feeds.clone()));\n",
    """        cx.set_global(FeedsGlobal(feeds.clone()));
        if std::env::var_os("CAP_PROBE_FAKE_MIC").is_some() {
            crate::meter_probe::start_reporter();
            let weak = feeds.downgrade();
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(3))
                    .await;
                let _ = weak.update(cx, |this, cx| {
                    this.microphone = Some("Fake Mic".into());
                    let _actor = this.ensure_mic_actor(cx);
                    cx.notify();
                });
            })
            .detach();
        }
""",
)
print("probe injected into", root)
