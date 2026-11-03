use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use cap_editor::EditorInstance;
use cap_export::preview::{ExportPreviewSettings, render_frame_with_editor};
use cap_gpui_kernels::motion_track::{LumaFrame, TrackSession};
use cap_gpui_kernels::point_track::PointTrackSession;
use cap_project::{MaskSegment, ProjectConfiguration, XY};
use gpui::{
    AnyElement, Context, CursorStyle, Div, FontWeight, Hsla, InteractiveElement, IntoElement,
    MouseButton, MouseDownEvent, MouseMoveEvent, ParentElement, Pixels, Point, Styled, Task,
    Window, div, px,
};

use crate::{
    editor_sidebar::with_alpha, editor_timeline::MASK_MARKER_DOT, editor_window::EditorWindow,
    i18n::tr, theme::Theme,
};

const TRACK_FPS: f64 = 30.;
const TRACK_RESOLUTION: XY<u32> = XY { x: 960, y: 540 };
const MARKER_TOLERANCE: f64 = 0.003;
/// How much a Track Points mask is widened and heightened past the box
/// around its points (about 4 pixels a side at 1280 wide): measured on
/// clicks around round and rectangular targets, it covers how far inside
/// the outline a careful click lands.
const POINT_OUTLINE_MARGIN: f64 = 0.006;
/// The canvas's resize handle (`render_element_box`): picked points use the
/// same disc so the picker reads as part of the selection, hollow so the
/// pixel being tracked stays visible through it.
const POINT_HANDLE: f32 = 12.;
/// How far a point's number sits from the point, clear of the handle.
const POINT_LABEL_OFFSET: f32 = 18.;
const POINT_LABEL_SPACING: f32 = 18.;

type TrackedRect = (f64, XY<f64>, XY<f64>);

/// Numbers sit outside the shape, off their points, because a number over a
/// point hides the pixel being aimed at; neighbouring points (a rounded
/// shape's) would otherwise stack their numbers on one another.
pub(crate) fn tracking_label_centers(points: &[XY<f64>], size: (f32, f32)) -> Vec<(f32, f32)> {
    let bounds = points
        .iter()
        .take(4)
        .fold((1.0_f64, 1.0_f64, 0.0_f64, 0.0_f64), |(l, t, r, b), p| {
            (l.min(p.x), t.min(p.y), r.max(p.x), b.max(p.y))
        });
    let center = ((bounds.0 + bounds.2) / 2.0, (bounds.1 + bounds.3) / 2.0);
    let mut labels: Vec<(f32, f32)> = Vec::with_capacity(points.len());
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
                (point.x as f32 * size.0 + angle.cos() as f32 * POINT_LABEL_OFFSET)
                    .clamp(9., size.0 - 9.),
                (point.y as f32 * size.1 + angle.sin() as f32 * POINT_LABEL_OFFSET)
                    .clamp(9., size.1 - 9.),
            )
        };
        let label = [0., 1., -1., 2., -2., 3., -3., 4.]
            .into_iter()
            .map(candidate)
            .find(|p| {
                labels
                    .iter()
                    .all(|q| (p.0 - q.0).hypot(p.1 - q.1) >= POINT_LABEL_SPACING)
            })
            .unwrap_or_else(|| candidate(0.));
        labels.push(label);
    }
    labels
}

/// Points around a shape arrive in click order, which can cross itself; the
/// convex hull is the outline that order-free clicks enclose.
pub(crate) fn points_outline(points: &[XY<f64>]) -> Option<Vec<XY<f64>>> {
    let mut sorted = points.to_vec();
    sorted.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
    sorted.dedup_by(|a, b| a.x == b.x && a.y == b.y);
    if sorted.len() < 3 {
        return None;
    }
    let turn =
        |o: XY<f64>, a: XY<f64>, b: XY<f64>| (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    let mut hull: Vec<XY<f64>> = Vec::with_capacity(sorted.len() * 2);
    for pass in [sorted.clone(), sorted.into_iter().rev().collect()] {
        let floor = hull.len();
        for point in pass {
            while hull.len() >= floor + 2
                && turn(hull[hull.len() - 2], hull[hull.len() - 1], point) <= 0.0
            {
                hull.pop();
            }
            hull.push(point);
        }
        hull.pop();
    }
    (hull.len() >= 3).then_some(hull)
}

pub(crate) fn render_motion_path(
    theme: &Theme,
    segment: &MaskSegment,
    (width, height): (f32, f32),
) -> AnyElement {
    let centers = segment
        .tracking_marker_times()
        .into_iter()
        .map(|time| {
            let (center, _) = segment.rect_at(time);
            (center.x as f32 * width, center.y as f32 * height)
        })
        .collect::<Vec<_>>();
    let line = with_alpha(theme.blue_9, 0.55);
    let path = centers.clone();
    div()
        .absolute()
        .inset_0()
        .child(
            gpui::canvas(
                |bounds, _, _| bounds,
                move |_, bounds, window, _| {
                    if path.len() < 2 {
                        return;
                    }
                    let mut stroke = gpui::PathBuilder::stroke(px(1.5));
                    for (index, &(x, y)) in path.iter().enumerate() {
                        let point = gpui::point(bounds.origin.x + px(x), bounds.origin.y + px(y));
                        if index == 0 {
                            stroke.move_to(point);
                        } else {
                            stroke.line_to(point);
                        }
                    }
                    if let Ok(stroke) = stroke.build() {
                        window.paint_path(stroke, line);
                    }
                },
            )
            .absolute()
            .inset_0(),
        )
        .children(centers.into_iter().map(|(x, y)| {
            div()
                .absolute()
                .left(px(x - MASK_MARKER_DOT / 2.))
                .top(px(y - MASK_MARKER_DOT / 2.))
                .size(px(MASK_MARKER_DOT))
                .rounded_full()
                .border_1()
                .border_color(gpui::white())
                .bg(Hsla::from(theme.blue_9))
        }))
        .into_any_element()
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
    Points(PointTrackSession),
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
    /// The point picker over the player, drawn in the canvas's selection
    /// vocabulary: the selection blue, its hollow handle disc at each point,
    /// its label chip for each point's number, and its dark notice pill for
    /// the instruction. Clicks on the frame add points; handles drag them.
    pub(crate) fn render_mask_point_picker(
        &self,
        layer: Div,
        picking: &MaskTrackingPoints,
        (width, height): (f32, f32),
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let blue = Hsla::from(theme.blue_9);
        let fill = with_alpha(theme.blue_9, 0.12);
        let faint = with_alpha(theme.blue_9, 0.5);
        let points = picking.points.clone();
        let labels = tracking_label_centers(&points, (width, height));
        let at = |point: &XY<f64>| (point.x as f32 * width, point.y as f32 * height);
        let outline = (points.len() >= 4)
            .then(|| points_outline(&points))
            .flatten()
            .map(|outline| outline.iter().map(at).collect::<Vec<_>>());
        // Until there are four points, join them in the order they were
        // clicked so the next click's place in the outline is obvious.
        let trail = points.iter().map(at).collect::<Vec<_>>();
        let instruction = if points.len() < 4 {
            tr::editor::panel::mask::pick_point(points.len() + 1)
        } else {
            tr::editor::panel::mask::pick_more().to_string()
        };

        let start_drag = |index: usize| {
            cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                cx.stop_propagation();
                if let Some(picking) = this.mask_tracking_points.as_mut() {
                    picking.dragging = Some((index, event.position, picking.points[index]));
                }
                cx.notify();
            })
        };

        layer
            .id("mask-tracking-points")
            .cursor(CursorStyle::Crosshair)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    let Some(bounds) = this.canvas_bounds() else {
                        return;
                    };
                    let point = XY::new(
                        f64::from(
                            f32::from(event.position.x - bounds.origin.x)
                                / f32::from(bounds.size.width),
                        )
                        .clamp(0.0, 1.0),
                        f64::from(
                            f32::from(event.position.y - bounds.origin.y)
                                / f32::from(bounds.size.height),
                        )
                        .clamp(0.0, 1.0),
                    );
                    this.pick_mask_tracking_point(point, window, cx);
                }),
            )
            .child(
                gpui::canvas(
                    |bounds, _, _| bounds,
                    move |_, bounds, window, _| {
                        let at = |(x, y): (f32, f32)| {
                            gpui::point(bounds.origin.x + px(x), bounds.origin.y + px(y))
                        };
                        let polygon =
                            |points: &[(f32, f32)], close: bool, mut path: gpui::PathBuilder| {
                                for (index, &point) in points.iter().enumerate() {
                                    if index == 0 {
                                        path.move_to(at(point));
                                    } else {
                                        path.line_to(at(point));
                                    }
                                }
                                if close {
                                    path.close();
                                }
                                path.build().ok()
                            };
                        match outline {
                            Some(outline) => {
                                if let Some(area) =
                                    polygon(&outline, true, gpui::PathBuilder::fill())
                                {
                                    window.paint_path(area, fill);
                                }
                                if let Some(edge) =
                                    polygon(&outline, true, gpui::PathBuilder::stroke(px(2.)))
                                {
                                    window.paint_path(edge, blue);
                                }
                                // The mask itself is the box around the
                                // points; outline it faintly so a rounded
                                // shape's covered corners are not a surprise.
                                let (left, top, right, bottom) = outline.iter().fold(
                                    (f32::MAX, f32::MAX, f32::MIN, f32::MIN),
                                    |(l, t, r, b), &(x, y)| {
                                        (l.min(x), t.min(y), r.max(x), b.max(y))
                                    },
                                );
                                if let Some(edge) = polygon(
                                    &[(left, top), (right, top), (right, bottom), (left, bottom)],
                                    true,
                                    gpui::PathBuilder::stroke(px(1.)),
                                ) {
                                    window.paint_path(edge, faint);
                                }
                            }
                            None if trail.len() >= 2 => {
                                if let Some(edge) =
                                    polygon(&trail, false, gpui::PathBuilder::stroke(px(2.)))
                                {
                                    window.paint_path(edge, blue);
                                }
                            }
                            None => {}
                        }
                    },
                )
                .absolute()
                .inset_0(),
            )
            .children(points.iter().enumerate().map(|(index, point)| {
                let (x, y) = at(point);
                div()
                    .id(("mask-point-handle", index))
                    .absolute()
                    .left(px(x - POINT_HANDLE / 2.))
                    .top(px(y - POINT_HANDLE / 2.))
                    .size(px(POINT_HANDLE))
                    .rounded_full()
                    .border_1()
                    .border_color(gpui::white())
                    .cursor(CursorStyle::OpenHand)
                    .child(
                        div()
                            .size_full()
                            .rounded_full()
                            .border_2()
                            .border_color(blue),
                    )
                    .on_mouse_down(MouseButton::Left, start_drag(index))
            }))
            .children(labels.into_iter().enumerate().map(|(index, (x, y))| {
                div()
                    .id(("mask-point-label", index))
                    .absolute()
                    .left(px(x - 8.))
                    .top(px(y - 8.))
                    .min_w(px(16.))
                    .h(px(16.))
                    .px(px(4.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(4.))
                    .bg(blue)
                    .text_size(px(11.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(gpui::white())
                    .cursor(CursorStyle::OpenHand)
                    .child((index + 1).to_string())
                    .on_mouse_down(MouseButton::Left, start_drag(index))
            }))
            .child(
                div()
                    .absolute()
                    .top(px(10.))
                    .left_0()
                    .right_0()
                    .flex()
                    .justify_center()
                    .child(
                        div()
                            .px(px(12.))
                            .py(px(6.))
                            .rounded(px(8.))
                            .bg(gpui::hsla(0., 0., 0., 0.8))
                            .text_size(px(12.))
                            .text_color(gpui::white())
                            .child(instruction),
                    ),
            )
            .into_any_element()
    }

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
        tracing::debug!(index, from, ?points, "mask tracking started");
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
        #[cfg(debug_assertions)]
        dump_tracking_frame(&frame);
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
                        PointTrackSession::new(&luma, time, points).map(TrackingSession::Points)
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
    // Points are clicked on, or just inside, the outline of what they mark,
    // so the box around them falls a few pixels short of it.
    let (points, lost, outline_margin) = match session {
        TrackingSession::Box(session) => {
            let (points, lost) = session.finish();
            (points, lost, 0.0)
        }
        TrackingSession::Points(session) => {
            let (points, lost) = session.finish();
            (points, lost, POINT_OUTLINE_MARGIN)
        }
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
                XY::new(point.size.0 + outline_margin, point.size.1 + outline_margin),
            )
        })
        .collect();
    TrackedPath {
        rects,
        needs_review: needs_review || !lost.is_empty(),
    }
}

/// `CAP_GPUI_MASK_TRACK_DUMP=<file>` (debug builds): append every frame the
/// tracker is given, as raw RGBA at the tracking resolution, so a run can be
/// replayed outside the editor with the kernels' `mask_track_replay`
/// example. Tracking sees the editor's render, not the source video, and
/// the two differ in colour and sharpness enough to matter.
#[cfg(debug_assertions)]
fn dump_tracking_frame(frame: &cap_rendering::RenderedFrame) {
    use std::io::Write;
    let Some(path) = std::env::var_os("CAP_GPUI_MASK_TRACK_DUMP") else {
        return;
    };
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| {
            let stride = frame.padded_bytes_per_row as usize;
            frame
                .data
                .chunks(stride)
                .take(frame.height as usize)
                .try_for_each(|row| file.write_all(&row[..frame.width as usize * 4]))
        });
    if let Err(error) = written {
        tracing::warn!(%error, "could not dump a tracking frame");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_outline_encloses_points_in_any_order_and_skips_inner_ones() {
        let point = |x, y| XY::new(x, y);
        let outline = points_outline(&[
            point(0.6, 0.6),
            point(0.2, 0.2),
            point(0.4, 0.4),
            point(0.6, 0.2),
            point(0.2, 0.6),
        ])
        .unwrap();
        assert_eq!(outline.len(), 4, "{outline:?}");
        assert!(!outline.contains(&point(0.4, 0.4)));

        let around = (0..8)
            .map(|k| {
                let angle = k as f64 * std::f64::consts::TAU / 8.0;
                point(0.5 + 0.2 * angle.cos(), 0.5 + 0.1 * angle.sin())
            })
            .rev()
            .collect::<Vec<_>>();
        assert_eq!(points_outline(&around).unwrap().len(), 8);
        assert!(points_outline(&[point(0.1, 0.1), point(0.2, 0.2)]).is_none());
    }
}
