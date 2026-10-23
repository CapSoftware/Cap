//! `CAP_GPUI_SNAPSHOT=/path/out.png[,delay_ms]`: write the onboarding window
//! to a PNG after a delay, then quit. Debug builds only; the design loop uses
//! it because a shell without Screen Recording cannot `screencapture`, while
//! this binary already holds the grant.

use std::time::Duration;

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::App;

pub fn arm_from_env(cx: &mut App) {
    crate::permission_guide::preview_from_env(cx);
    let Ok(spec) = std::env::var("CAP_GPUI_SNAPSHOT") else {
        return;
    };
    let mut parts = spec.split(',');
    let Some(path) = parts
        .next()
        .filter(|path| !path.is_empty())
        .map(String::from)
    else {
        return;
    };
    let delay = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(2500);
    cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(Duration::from_millis(delay))
            .await;
        let mut number = None;
        for _ in 0..20 {
            number = cx.update(|cx| {
                let target = std::env::var("CAP_GPUI_SNAPSHOT_WINDOW").unwrap_or_default();
                let handle = if target == "guide" {
                    crate::permission_guide::window_handle(cx)
                } else if target == "main" {
                    Some(cx.global::<crate::app_windows::AppWindows>().main.into())
                } else {
                    cx.global::<crate::app_windows::AppWindows>()
                        .onboarding
                        .map(Into::into)
                };
                let Some(handle) = handle else {
                    tracing::warn!("snapshot: window handle missing");
                    return None;
                };
                match handle.update(cx, |_, window, _| crate::platform::window_number(window)) {
                    Ok(number) => number,
                    Err(error) => {
                        tracing::warn!("snapshot: onboarding update failed: {error}");
                        None
                    }
                }
            });
            if number.is_some() {
                break;
            }
            cx.background_executor()
                .timer(Duration::from_millis(100))
                .await;
        }
        let Some(id) = number.and_then(|number| number.to_string().parse().ok()) else {
            tracing::error!("snapshot: no onboarding window");
            cx.update(|cx| cx.quit());
            return;
        };
        let result = gpui_tokio::Tokio::spawn(cx, async move {
            cap_recording::screenshot::capture_screenshot(ScreenCaptureTarget::Window { id }).await
        })
        .await;
        match result {
            Ok(Ok(image)) => match image.save(&path) {
                Ok(()) => tracing::info!("snapshot written to {path}"),
                Err(error) => tracing::error!("snapshot save failed: {error}"),
            },
            Ok(Err(error)) => tracing::error!("snapshot capture failed: {error:#}"),
            Err(error) => tracing::error!("snapshot task failed: {error}"),
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}
