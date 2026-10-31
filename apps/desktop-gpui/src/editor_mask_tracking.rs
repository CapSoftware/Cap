use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use cap_editor::EditorInstance;
use cap_export::preview::{ExportPreviewSettings, render_frame_with_editor};
use cap_gpui_kernels::four_point_track::FourPointSession;
use cap_gpui_kernels::motion_track::{LumaFrame, TrackSession};
use cap_project::{ProjectConfiguration, XY};
use gpui::{Context, MouseMoveEvent, Pixels, Point, Task, Window};

use crate::{editor_window::EditorWindow, i18n::tr};

const TRACK_FPS: f64 = 30.;
const TRACK_RESOLUTION: XY<u32> = XY { x: 960, y: 540 };
const MARKER_TOLERANCE: f64 = 0.003;

type TrackedRect = (f64, XY<f64>, XY<f64>);

pub(crate) fn tracking_pin_centers(points: &[XY<f64>], size: (f32, f32)) -> Vec<(f32, f32)> {
    let bounds = points
        .iter()
        .take(4)
        .fold((1.0_f64, 1.0_f64, 0.0_f64, 0.0_f64), |(l, t, r, b), p| {
            (l.min(p.x), t.min(p.y), r.max(p.x), b.max(p.y))
        });
    let center = ((bounds.0 + bounds.2) / 2.0, (bounds.1 + bounds.3) / 2.0);
    let mut handles: Vec<(f32, f32)> = Vec::with_capacity(points.len());
    for (index, point) in points.iter().enumerate() {
        let dx = (point.x - center.0) / (bounds.2 - bounds.0).max(0.01);
        let dy = (point.y - center.1) / (bounds.3 - bounds.1).max(0.01);
        let angle = if dx.hypot(dy) < 0.01 {
            -std::f64::consts::FRAC_PI_4 * 3.0 + index as f64 * std::f64::consts::FRAC_PI_2
        } else {
            dy.atan2(dx)
        };
        let candidate = |turn: f64| {
            let angle = angle + turn * std::f64::consts::FRAC_PI_4;
            (
                (point.x as f32 * size.0 + angle.cos() as f32 * 28.).clamp(9., size.0 - 9.),
                (point.y as f32 * size.1 + angle.sin() as f32 * 28.).clamp(9., size.1 - 9.),
            )
        };
        let handle = [0., 1., -1., 2., -2., 3., -3., 4.]
            .into_iter()
            .map(candidate)
            .find(|p| handles.iter().all(|q| (p.0 - q.0).hypot(p.1 - q.1) >= 19.))
            .unwrap_or_else(|| candidate(0.));
        handles.push(handle);
    }
    handles
}

pub(crate) struct MaskTrackingPoints {
    pub(crate) index: usize,
    pub(crate) time: f64,
    pub(crate) points: Vec<XY<f64>>,
    pub(crate) dragging: Option<(usize, Point<Pixels>, XY<f64>)>,
}

enum TrackingTarget {
    Box(XY<f64>, XY<f64>),
    Points(Vec<(f64, f64)>),
}

enum TrackingSession {
    Box(TrackSession),
    Points(FourPointSession),
}

pub(crate) struct MaskTrackingJob {
    pub(crate) index: usize,
    pub(crate) progress: f32,
    cancel: Arc<AtomicBool>,
    _task: Task<()>,
}

impl Drop for MaskTrackingJob {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}

struct TrackedPath {
    rects: Vec<TrackedRect>,
    needs_review: bool,
}

enum TrackEvent {
    Progress(f32),
    Done(TrackedPath),
}

impl EditorWindow {
    pub(crate) fn pick_mask_tracking_point(
        &mut self,
        point: XY<f64>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let time = self.preview_or_playhead();
        let Some(picking) = self.mask_tracking_points.as_mut() else {
            return;
        };
        if picking.time != time {
            self.mask_tracking_points = None;
            cx.notify();
            return;
        }
        picking.points.push(point);
        cx.notify();
    }

    pub(crate) fn move_mask_tracking_point(
        &mut self,
        event: &MouseMoveEvent,
        cx: &mut Context<Self>,
    ) {
        let Some(bounds) = self.canvas_bounds() else {
            return;
        };
        let Some(picking) = self.mask_tracking_points.as_mut() else {
            return;
        };
        let Some((index, origin, point)) = picking.dragging else {
            return;
        };
        picking.points[index] = XY::new(
            (point.x
                + f64::from(f32::from(event.position.x - origin.x) / f32::from(bounds.size.width)))
            .clamp(0.0, 1.0),
            (point.y
                + f64::from(
                    f32::from(event.position.y - origin.y) / f32::from(bounds.size.height),
                ))
            .clamp(0.0, 1.0),
        );
        cx.notify();
    }

    pub(crate) fn mask_tracking_progress(&self, index: usize) -> Option<f32> {
        self.mask_tracking
            .as_ref()
            .filter(|job| job.index == index)
            .map(|job| job.progress)
    }

    pub(crate) fn stop_mask_tracking(&mut self, cx: &mut Context<Self>) {
        if let Some(job) = self.mask_tracking.as_ref() {
            job.cancel.store(true, Ordering::Release);
        }
        cx.notify();
    }

    pub(crate) fn start_mask_tracking(
        &mut self,
        index: usize,
        points: Option<Vec<(f64, f64)>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.mask_tracking.is_some() {
            return;
        }
        let Some(instance) = self.instance.clone() else {
            return;
        };
        let Some(segment) = self
            .project
            .timeline
            .as_ref()
            .and_then(|timeline| timeline.mask_segments.get(index))
            .cloned()
        else {
            return;
        };
        let from = self.preview_or_playhead().clamp(segment.start, segment.end);
        if from >= segment.end {
            return;
        }
        let (center, size) = segment.rect_at(from - segment.start);
        let target = points.map_or(TrackingTarget::Box(center, size), TrackingTarget::Points);
        let Ok(snapshot) = serde_json::to_value(&self.project) else {
            return;
        };
        let mut project = self.project.clone();
        if let Some(timeline) = project.timeline.as_mut() {
            timeline.mask_segments.clear();
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let (events, received) = flume::unbounded();
        let job_cancel = cancel.clone();
        let worker = gpui_tokio::Tokio::spawn(cx, async move {
            let path = track(
                &instance,
                project,
                (from, segment.end),
                segment.start,
                target,
                &job_cancel,
                |progress| {
                    let _ = events.send(TrackEvent::Progress(progress));
                },
            )
            .await;
            let _ = events.send(TrackEvent::Done(path));
        });
        let task = cx.spawn_in(window, async move |this, cx| {
            let _worker = worker;
            while let Ok(event) = received.recv_async().await {
                let done = matches!(event, TrackEvent::Done(_));
                let _ = this.update_in(cx, |this, window, cx| {
                    match event {
                        TrackEvent::Progress(progress) => {
                            if let Some(job) = this.mask_tracking.as_mut() {
                                job.progress = progress;
                            }
                        }
                        TrackEvent::Done(path) => {
                            this.mask_tracking = None;
                            tracing::info!(index, points = path.rects.len(), "mask tracked");
                            if serde_json::to_value(&this.project).ok().as_ref() != Some(&snapshot)
                            {
                                this.show_notice(
                                    tr::editor::panel::mask::tracking_changed(),
                                    window,
                                    cx,
                                );
                            } else if path.rects.len() > 1 {
                                if path.needs_review {
                                    this.show_notice(
                                        tr::editor::panel::mask::tracking_review(),
                                        window,
                                        cx,
                                    );
                                }
                                this.edit_mask_segment(
                                    "mask-track",
                                    index,
                                    window,
                                    cx,
                                    move |segment| {
                                        segment.apply_tracked_path(&path.rects, MARKER_TOLERANCE);
                                        true
                                    },
                                );
                            } else {
                                this.show_notice(
                                    tr::editor::panel::mask::tracking_failed(),
                                    window,
                                    cx,
                                );
                            }
                        }
                    }
                    cx.notify();
                });
                if done {
                    break;
                }
            }
        });
        self.mask_tracking = Some(MaskTrackingJob {
            index,
            progress: 0.,
            cancel,
            _task: task,
        });
        cx.notify();
    }
}

async fn track(
    instance: &EditorInstance,
    project: ProjectConfiguration,
    (from, to): (f64, f64),
    segment_start: f64,
    target: TrackingTarget,
    cancel: &AtomicBool,
    progress: impl Fn(f32),
) -> TrackedPath {
    let settings = ExportPreviewSettings {
        fps: TRACK_FPS as u32,
        resolution_base: TRACK_RESOLUTION,
        compression_bpp: 0.1,
        cursor_only: false,
    };
    let steps = ((to - from) * TRACK_FPS).floor().max(0.) as usize;
    let mut session: Option<TrackingSession> = None;
    let mut needs_review = false;
    for step in 0..=steps {
        if cancel.load(Ordering::Acquire) {
            needs_review = true;
            break;
        }
        let time = (from + step as f64 / TRACK_FPS).min(to - 1e-3);
        let Ok((frame, _)) =
            render_frame_with_editor(instance, project.clone(), time, settings).await
        else {
            needs_review = true;
            break;
        };
        let luma = LumaFrame::from_rgba(
            &frame.data,
            frame.width,
            frame.height,
            frame.padded_bytes_per_row as usize,
        );
        match session.as_mut() {
            Some(TrackingSession::Box(session)) => session.push(time, luma),
            Some(TrackingSession::Points(session)) => session.push(time, luma),
            None => {
                let created = match &target {
                    TrackingTarget::Box(center, size) => {
                        TrackSession::new(&luma, time, (center.x, center.y), (size.x, size.y))
                            .map(TrackingSession::Box)
                    }
                    TrackingTarget::Points(points) => {
                        FourPointSession::new(&luma, time, points).map(TrackingSession::Points)
                    }
                };
                let Some(created) = created else {
                    tracing::warn!("mask area has too little detail to track");
                    break;
                };
                session = Some(created);
            }
        }
        progress(step as f32 / steps.max(1) as f32);
    }
    let Some(session) = session else {
        return TrackedPath {
            rects: Vec::new(),
            needs_review: true,
        };
    };
    let (points, lost) = match session {
        TrackingSession::Box(session) => session.finish(),
        TrackingSession::Points(session) => session.finish(),
    };
    if !lost.is_empty() {
        tracing::info!(?lost, "mask target was out of sight");
    }
    let rects = points
        .into_iter()
        .map(|point| {
            (
                point.time - segment_start,
                XY::new(point.center.0, point.center.1),
                XY::new(point.size.0, point.size.1),
            )
        })
        .collect();
    TrackedPath {
        rects,
        needs_review: needs_review || !lost.is_empty(),
    }
}
