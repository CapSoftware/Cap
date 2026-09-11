use crate::{
    ProjectConfiguration, RenderingError,
    layers::{CaptionsLayer, ImageLayer, KeyboardLayer, TextLayer},
    readiness,
};

pub(super) struct OverlayLayers {
    pub(super) text: TextLayer,
    pub(super) images: ImageLayer,
    pub(super) captions: CaptionsLayer,
    pub(super) keyboard: KeyboardLayer,
}

impl OverlayLayers {
    pub(super) fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        Self {
            text: readiness::measure("layers.text", || TextLayer::new(device, queue)),
            images: readiness::measure("layers.images", || ImageLayer::new(device)),
            captions: readiness::measure("layers.captions", || CaptionsLayer::new(device, queue)),
            keyboard: readiness::measure("layers.keyboard", || KeyboardLayer::new(device, queue)),
        }
    }

    pub(super) fn validate_omission(
        project: &ProjectConfiguration,
        has_prepared_text: bool,
    ) -> Result<(), RenderingError> {
        if has_prepared_text
            || project.captions.is_some()
            || project.keyboard.is_some()
            || !project.annotations.is_empty()
            || !project.hidden_text_segments.is_empty()
            || !project.overlay_order.is_empty()
            || project.timeline.as_ref().is_some_and(|timeline| {
                !timeline.text_segments.is_empty()
                    || !timeline.image_segments.is_empty()
                    || !timeline.caption_segments.is_empty()
                    || !timeline.keyboard_segments.is_empty()
            })
        {
            Err(RenderingError::PreparingOverlayContent)
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod native_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> ProjectConfiguration {
        ProjectConfiguration {
            timeline: Some(
                serde_json::from_value(serde_json::json!({
                    "segments": [],
                    "zoomSegments": []
                }))
                .unwrap(),
            ),
            ..Default::default()
        }
    }

    #[test]
    fn omitted_layers_accept_an_overlay_free_project() {
        assert!(OverlayLayers::validate_omission(&project(), false).is_ok());
        assert!(OverlayLayers::validate_omission(&ProjectConfiguration::default(), false).is_ok());
    }

    #[test]
    fn prepared_text_cannot_bypass_project_admission() {
        assert!(matches!(
            OverlayLayers::validate_omission(&project(), true),
            Err(RenderingError::PreparingOverlayContent)
        ));
    }

    #[test]
    fn every_declared_overlay_source_requires_the_bundle() {
        let mutations: [fn(&mut ProjectConfiguration); 9] =
            [
                |project| project.captions = Some(Default::default()),
                |project| project.keyboard = Some(Default::default()),
                |project| project.hidden_text_segments.push(0),
                |project| {
                    project.overlay_order.push(cap_project::OverlayTrack {
                        kind: cap_project::OverlayTrackKind::Mask,
                        track: 0,
                    });
                },
                |project| {
                    project.annotations.push(
                        serde_json::from_value(serde_json::json!({
                            "id": "text", "type": "text", "x": 0.0, "y": 0.0,
                            "width": 1.0, "height": 1.0, "strokeColor": "#000000",
                            "strokeWidth": 1.0, "fillColor": "#ffffff", "opacity": 0.0,
                            "rotation": 0.0, "text": "hidden annotation"
                        }))
                        .unwrap(),
                    );
                },
                |project| {
                    project.timeline.as_mut().unwrap().text_segments.push(
                        serde_json::from_value(serde_json::json!({
                            "start": 0.0, "end": 1.0, "enabled": false
                        }))
                        .unwrap(),
                    );
                },
                |project| {
                    project.timeline.as_mut().unwrap().image_segments.push(
                        cap_project::ImageSegment {
                            enabled: false,
                            path: "unopened-overlay.png".into(),
                            ..Default::default()
                        },
                    );
                },
                |project| {
                    project.timeline.as_mut().unwrap().caption_segments.push(
                        serde_json::from_value(serde_json::json!({
                            "id": "caption", "start": 0.0, "end": 1.0, "text": "caption"
                        }))
                        .unwrap(),
                    );
                },
                |project| {
                    project.timeline.as_mut().unwrap().keyboard_segments.push(
                        serde_json::from_value(serde_json::json!({
                            "id": "keys", "start": 0.0, "end": 1.0, "displayText": "A"
                        }))
                        .unwrap(),
                    );
                },
            ];
        for (index, mutate) in mutations.iter().enumerate() {
            let mut project = project();
            mutate(&mut project);
            assert!(
                matches!(
                    OverlayLayers::validate_omission(&project, false),
                    Err(RenderingError::PreparingOverlayContent)
                ),
                "overlay source {index} bypassed the missing bundle guard"
            );
        }
    }
}
