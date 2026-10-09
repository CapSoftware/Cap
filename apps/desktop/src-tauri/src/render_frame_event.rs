use tauri::{EventId, Listener, Runtime};
use tauri_specta::Event;

use crate::RenderFrameEvent;

impl RenderFrameEvent {
    pub(crate) fn listen_checked<R: Runtime>(
        handle: &impl Listener<R>,
        handler: impl Fn(Self) + Send + 'static,
    ) -> EventId {
        // tauri-specta's typed listener panics when a numeric JS payload becomes JSON null.
        handle.listen_any(Self::NAME, move |event| {
            let Ok(payload) = serde_json::from_str::<Self>(event.payload()) else {
                return;
            };
            handler(payload);
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::{Value, json};
    use tauri::{Emitter, EventTarget, Listener, test::mock_app};
    use tauri_specta::Event;

    use crate::RenderFrameEvent;

    fn request(frame_number: u32) -> Value {
        json!({
            "frame_number": frame_number,
            "fps": 60,
            "resolution_base": { "x": 1248, "y": 702 }
        })
    }

    #[test]
    fn malformed_requests_do_not_dispatch_and_valid_requests_still_arrive() {
        let app = mock_app();
        let received = Arc::new(Mutex::new(Vec::new()));
        let received_by_handler = received.clone();
        let id = RenderFrameEvent::listen_checked(&app, move |event| {
            received_by_handler.lock().unwrap().push((
                event.frame_number,
                event.fps,
                event.resolution_base.x,
                event.resolution_base.y,
            ));
        });

        app.emit(RenderFrameEvent::NAME, request(0)).unwrap();
        for pointer in [
            "/frame_number",
            "/fps",
            "/resolution_base/x",
            "/resolution_base/y",
        ] {
            for invalid in [
                Value::Null,
                json!(-1),
                json!(u64::from(u32::MAX) + 1),
                json!(1.5),
                json!("60"),
                json!(false),
                json!({}),
                json!([]),
            ] {
                let mut payload = request(1);
                *payload.pointer_mut(pointer).unwrap() = invalid;
                app.emit(RenderFrameEvent::NAME, payload).unwrap();
            }
        }
        for malformed in [
            "null",
            "{}",
            "[]",
            "{",
            "false",
            r#"{"frame_number":0,"fps":60}"#,
            r#"{"frame_number":0,"fps":60,"resolution_base":null}"#,
        ] {
            app.emit_str(RenderFrameEvent::NAME, malformed.to_string())
                .unwrap();
        }
        assert_eq!(*received.lock().unwrap(), [(0, 60, 1248, 702)]);

        app.emit_to(EventTarget::app(), RenderFrameEvent::NAME, request(150))
            .unwrap();
        app.emit_to(
            EventTarget::labeled("editor-1"),
            RenderFrameEvent::NAME,
            request(u32::MAX),
        )
        .unwrap();
        assert_eq!(
            *received.lock().unwrap(),
            [
                (0, 60, 1248, 702),
                (150, 60, 1248, 702),
                (u32::MAX, 60, 1248, 702)
            ]
        );

        app.unlisten(id);
        app.emit(RenderFrameEvent::NAME, request(200)).unwrap();
        assert_eq!(received.lock().unwrap().len(), 3);
    }

    #[test]
    fn checked_listener_preserves_the_existing_u32_contract() {
        let app = mock_app();
        let received = Arc::new(Mutex::new(Vec::new()));
        let received_by_handler = received.clone();
        RenderFrameEvent::listen_checked(&app, move |event| {
            received_by_handler.lock().unwrap().push((
                event.frame_number,
                event.fps,
                event.resolution_base.x,
                event.resolution_base.y,
            ));
        });
        for value in [0, u32::MAX] {
            app.emit(
                RenderFrameEvent::NAME,
                json!({
                    "frame_number": value,
                    "fps": value,
                    "resolution_base": { "x": value, "y": value }
                }),
            )
            .unwrap();
        }
        assert_eq!(
            *received.lock().unwrap(),
            [(0, 0, 0, 0), (u32::MAX, u32::MAX, u32::MAX, u32::MAX)]
        );
    }
}
