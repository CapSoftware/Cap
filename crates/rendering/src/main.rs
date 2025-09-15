use std::{path::PathBuf, sync::Arc, time::Instant};

use cap_project::{RecordingMeta, StudioRecordingMeta};
use cap_rendering::{
    ProjectRecordingsMeta, RecordingSegmentDecoders, RenderSegment, RenderVideoConstants,
    RenderedFrame, SegmentVideoPaths,
};

#[tokio::main]
async fn main() {
    let path: PathBuf = std::env::args().collect::<Vec<_>>().swap_remove(1).into();

    let project_config =
        serde_json::from_reader(std::fs::File::open(path.join("project-config.json")).unwrap())
            .unwrap();

    let recording_meta = RecordingMeta::load_for_project(&path).unwrap();
    let studio_meta = recording_meta.studio_meta().unwrap();

    let recordings =
        Arc::new(ProjectRecordingsMeta::new(&recording_meta.project_path, studio_meta).unwrap());

    let render_constants = Arc::new(
        RenderVideoConstants::new(
            &recordings.segments,
            recording_meta.clone(),
            studio_meta.clone(),
        )
        .await
        .unwrap(),
    );

    let segments = match studio_meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            todo!();
        }
        StudioRecordingMeta::MultipleSegments { inner, .. } => {
            let mut segments = vec![];

            for (i, s) in inner.segments.iter().enumerate() {
                let cursor = Arc::new(s.cursor_events(&recording_meta));

                let decoders = RecordingSegmentDecoders::new(
                    &recording_meta,
                    studio_meta,
                    SegmentVideoPaths {
                        display: recording_meta.path(&s.display.path),
                        camera: s.camera.as_ref().map(|c| recording_meta.path(&c.path)),
                    },
                    i,
                    &render_constants.device,
                )
                .await
                .unwrap();

                segments.push(RenderSegment { cursor, decoders });
            }

            segments
        }
    };

    let (tx_image_data, mut video_rx) = tokio::sync::mpsc::channel::<(RenderedFrame, u32)>(4);

    tokio::spawn(async move { while let Some((_, i)) = video_rx.recv().await {} });

    let start = Instant::now();
    cap_rendering::render_video_to_channel(
        render_constants,
        project_config,
        tx_image_data,
        &recording_meta,
        studio_meta,
        segments,
        30,
        cap_project::XY::new(1920, 1080),
        &recordings,
    )
    .await
    .unwrap();
    println!("All frames rendered in {:?}", start.elapsed());
}
