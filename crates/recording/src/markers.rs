use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};

use cap_project::TimelineMarker;
use cap_timestamp::Timestamps;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::RecordingStartGate;

/// Written beside the segments while a Studio recording runs, so crash
/// recovery keeps the markers a normal stop would have saved into the
/// project. Lives under `content/` because recovery stages that directory.
pub const RECORDING_MARKERS_FILE: &str = "content/markers.json";

/// A runaway key repeat must not grow the sidecar without bound.
const MAX_RECORDING_MARKERS: usize = 10_000;

/// A marker as captured: seconds since its segment's capture epoch, the
/// clock every track's start time is measured on, or `None` for a marker
/// pressed while paused, which belongs at the end of the segment before.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecordedMarker {
    pub segment: u32,
    pub offset: Option<f64>,
}

#[derive(Serialize, Deserialize)]
struct MarkerFile {
    markers: Vec<RecordedMarker>,
}

struct SegmentClock {
    segment: u32,
    start_time: Timestamps,
    start_gate: Option<RecordingStartGate>,
    paused_at: Option<Instant>,
}

struct State {
    segments: Vec<SegmentClock>,
    stopped_at: Option<Instant>,
    markers: Vec<RecordedMarker>,
    revision: u64,
}

impl State {
    /// Placed by the clock that was running at `at`, not the current one: a
    /// press can reach here after a pause or resume it happened before.
    fn locate(&self, at: Instant) -> Option<RecordedMarker> {
        if self.stopped_at.is_some_and(|stopped| at >= stopped) {
            return None;
        }
        let clock = self
            .segments
            .iter()
            .rev()
            .find(|clock| clock.start_time.instant() <= at)
            .or_else(|| self.segments.first())?;
        if clock.paused_at.is_some_and(|paused| at >= paused) {
            return Some(RecordedMarker {
                segment: clock.segment,
                offset: None,
            });
        }
        let epoch =
            crate::studio_recording::pipeline_epoch(clock.start_time, clock.start_gate.as_ref())
                .instant();
        let offset = match at.checked_duration_since(epoch) {
            Some(elapsed) => elapsed.as_secs_f64(),
            None => -epoch.saturating_duration_since(at).as_secs_f64(),
        };
        Some(RecordedMarker {
            segment: clock.segment,
            offset: Some(offset),
        })
    }
}

struct Inner {
    state: Mutex<State>,
    path: Option<PathBuf>,
    written: Mutex<u64>,
}

/// The marker log of one Studio recording. The actor moves its clock as
/// segments start and pause; the app adds markers without going through the
/// actor's mailbox, so a press during a slow pause or resume still lands at
/// the instant it happened. Nothing here touches the capture pipelines.
#[derive(Clone)]
pub struct RecordingMarkers(Arc<Inner>);

impl RecordingMarkers {
    pub(crate) fn new(recording_dir: Option<&Path>) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(State {
                segments: Vec::new(),
                stopped_at: None,
                markers: Vec::new(),
                revision: 0,
            }),
            path: recording_dir.map(|dir| dir.join(RECORDING_MARKERS_FILE)),
            written: Mutex::new(0),
        }))
    }

    pub(crate) fn segment_started(
        &self,
        segment: u32,
        start_time: Timestamps,
        start_gate: Option<RecordingStartGate>,
    ) {
        self.lock().segments.push(SegmentClock {
            segment,
            start_time,
            start_gate,
            paused_at: None,
        });
    }

    pub(crate) fn segment_paused(&self, segment: u32) {
        let mut state = self.lock();
        if let Some(clock) = state.segments.last_mut()
            && clock.segment == segment
            && clock.paused_at.is_none()
        {
            clock.paused_at = Some(Instant::now());
        }
    }

    pub(crate) fn stopped(&self) {
        self.lock().stopped_at.get_or_insert_with(Instant::now);
    }

    pub(crate) fn snapshot(&self) -> Vec<RecordedMarker> {
        self.lock().markers.clone()
    }

    pub fn count(&self) -> usize {
        self.lock().markers.len()
    }

    pub fn add(&self, at: Instant) -> Option<usize> {
        let (count, revision) = {
            let mut state = self.lock();
            if state.markers.len() >= MAX_RECORDING_MARKERS {
                return None;
            }
            let marker = state.locate(at)?;
            state.markers.push(marker);
            state.revision += 1;
            (state.markers.len(), state.revision)
        };
        self.persist(revision);
        Some(count)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Rewrites the sidecar off the caller's thread. Each write takes the
    /// newest list, and an older write never lands over a newer one.
    fn persist(&self, revision: u64) {
        if self.0.path.is_none() {
            return;
        }
        let markers = self.clone();
        let spawned = std::thread::Builder::new()
            .name("recording-markers".into())
            .spawn(move || {
                let mut written = markers
                    .0
                    .written
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if *written >= revision {
                    return;
                }
                let (list, latest) = {
                    let state = markers.lock();
                    (state.markers.clone(), state.revision)
                };
                if let Some(path) = &markers.0.path
                    && let Err(error) = write_marker_file(path, &list)
                {
                    warn!(%error, "Could not save recording markers");
                    return;
                }
                *written = latest;
            });
        if let Err(error) = spawned {
            warn!(%error, "Could not start saving recording markers");
        }
    }
}

fn write_marker_file(path: &Path, markers: &[RecordedMarker]) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&MarkerFile {
        markers: markers.to_vec(),
    })
    .map_err(std::io::Error::other)?;
    crate::cursor::write_atomically(path, &[&bytes])
}

pub fn read_recorded_markers(project_path: &Path) -> Vec<RecordedMarker> {
    let Ok(raw) = std::fs::read(project_path.join(RECORDING_MARKERS_FILE)) else {
        return Vec::new();
    };
    serde_json::from_slice::<MarkerFile>(&raw)
        .map(|file| file.markers)
        .inspect_err(|error| warn!(%error, "Ignoring unreadable recording markers"))
        .unwrap_or_default()
}

/// Where a recorded segment sits in the editor's source clock: its latest
/// track start (source time zero) and the length the timeline gives it.
#[derive(Clone, Copy, Debug)]
pub struct MarkerSegmentClock {
    pub latest_start: Option<f64>,
    pub duration: f64,
}

/// Turns captured markers into project markers. `segment_position` maps a
/// captured segment index to its index in the saved meta, which differs
/// only when recovery dropped an unreadable segment.
pub fn place_recorded_markers(
    markers: &[RecordedMarker],
    segments: &[MarkerSegmentClock],
    segment_position: impl Fn(u32) -> Option<u32>,
) -> Vec<TimelineMarker> {
    markers
        .iter()
        .filter_map(|marker| {
            let position = segment_position(marker.segment)?;
            let clock = segments.get(position as usize)?;
            let duration = if clock.duration.is_finite() {
                clock.duration.max(0.0)
            } else {
                0.0
            };
            let time = match marker.offset {
                Some(offset) => offset - clock.latest_start.unwrap_or(0.0),
                None => duration,
            };
            let time = if time.is_finite() {
                time.clamp(0.0, duration)
            } else {
                duration
            };
            Some(TimelineMarker::new(position, time))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn clock(latest_start: f64, duration: f64) -> MarkerSegmentClock {
        MarkerSegmentClock {
            latest_start: Some(latest_start),
            duration,
        }
    }

    #[test]
    fn markers_need_a_running_segment() {
        let markers = RecordingMarkers::new(None);
        assert_eq!(markers.add(Instant::now()), None);
        markers.segment_started(0, Timestamps::now(), None);
        assert_eq!(markers.add(Instant::now()), Some(1));
        markers.stopped();
        assert_eq!(markers.add(Instant::now()), None);
        assert_eq!(markers.count(), 1);
    }

    #[test]
    fn markers_measure_from_the_segment_epoch() {
        let markers = RecordingMarkers::new(None);
        let start = Timestamps::now();
        markers.segment_started(2, start, None);
        markers.add(start.instant() + Duration::from_millis(1500));
        markers.add(
            start
                .instant()
                .checked_sub(Duration::from_millis(250))
                .unwrap(),
        );
        let snapshot = markers.snapshot();
        assert_eq!(snapshot[0].segment, 2);
        assert!((snapshot[0].offset.unwrap() - 1.5).abs() < 1e-9);
        assert!((snapshot[1].offset.unwrap() + 0.25).abs() < 1e-9);
    }

    #[test]
    fn the_armed_start_gate_moves_the_epoch() {
        let markers = RecordingMarkers::new(None);
        let start = Timestamps::now();
        let gate = RecordingStartGate::new();
        markers.segment_started(0, start, Some(gate.clone()));
        std::thread::sleep(Duration::from_millis(20));
        gate.arm();
        let armed = gate.armed_at().unwrap().instant();
        markers.add(armed + Duration::from_secs(1));
        let offset = markers.snapshot()[0].offset.unwrap();
        assert!((offset - 1.0).abs() < 1e-9, "{offset}");
    }

    #[test]
    fn a_late_press_uses_the_clock_of_the_moment_it_happened() {
        let markers = RecordingMarkers::new(None);
        let first = Timestamps::now();
        markers.segment_started(0, first, None);
        std::thread::sleep(Duration::from_millis(5));
        let before_pause = Instant::now();
        std::thread::sleep(Duration::from_millis(5));
        markers.segment_paused(0);
        std::thread::sleep(Duration::from_millis(5));
        let while_paused = Instant::now();
        std::thread::sleep(Duration::from_millis(5));
        markers.segment_started(1, Timestamps::now(), None);
        std::thread::sleep(Duration::from_millis(5));
        let after_resume = Instant::now();

        markers.add(before_pause);
        markers.add(while_paused);
        markers.add(after_resume);
        let snapshot = markers.snapshot();
        assert_eq!(snapshot[0].segment, 0);
        let offset = snapshot[0].offset.unwrap();
        assert!((offset - before_pause.duration_since(first.instant()).as_secs_f64()).abs() < 1e-9);
        assert_eq!(
            snapshot[1],
            RecordedMarker {
                segment: 0,
                offset: None
            }
        );
        assert_eq!(snapshot[2].segment, 1);
        assert!(snapshot[2].offset.unwrap() > 0.0);
    }

    #[test]
    fn a_press_before_stop_still_counts_and_one_after_does_not() {
        let markers = RecordingMarkers::new(None);
        markers.segment_started(0, Timestamps::now(), None);
        let pressed = Instant::now();
        std::thread::sleep(Duration::from_millis(2));
        markers.stopped();
        assert_eq!(markers.add(pressed), Some(1));
        assert_eq!(markers.add(Instant::now()), None);
    }

    #[test]
    fn a_paused_press_lands_on_the_pause_point() {
        let markers = RecordingMarkers::new(None);
        markers.segment_started(0, Timestamps::now(), None);
        markers.segment_paused(0);
        markers.add(Instant::now());
        markers.add(Instant::now());
        let placed = place_recorded_markers(&markers.snapshot(), &[clock(0.1, 4.0)], Some);
        assert_eq!(placed.len(), 2);
        assert!(placed.iter().all(|marker| marker.time == 4.0));
    }

    #[test]
    fn placement_subtracts_the_latest_track_start_and_clamps() {
        let recorded = [
            RecordedMarker {
                segment: 0,
                offset: Some(2.35),
            },
            RecordedMarker {
                segment: 0,
                offset: Some(0.01),
            },
            RecordedMarker {
                segment: 1,
                offset: Some(99.0),
            },
            RecordedMarker {
                segment: 1,
                offset: Some(f64::NAN),
            },
            RecordedMarker {
                segment: 7,
                offset: Some(1.0),
            },
        ];
        let placed = place_recorded_markers(&recorded, &[clock(0.1, 10.0), clock(0.0, 5.0)], Some);
        let times: Vec<_> = placed
            .iter()
            .map(|marker| (marker.recording_clip, marker.time))
            .collect();
        assert_eq!(times.len(), 4);
        assert_eq!(times[0].0, 0);
        assert!((times[0].1 - 2.25).abs() < 1e-9);
        assert_eq!(times[1], (0, 0.0));
        assert_eq!(times[2], (1, 5.0));
        assert_eq!(times[3], (1, 5.0));
    }

    #[test]
    fn recovery_renumbers_segments_it_kept() {
        let recorded = [
            RecordedMarker {
                segment: 0,
                offset: Some(1.0),
            },
            RecordedMarker {
                segment: 2,
                offset: Some(1.0),
            },
        ];
        let placed = place_recorded_markers(&recorded, &[clock(0.0, 3.0)], |segment| {
            (segment == 2).then_some(0)
        });
        assert_eq!(placed.len(), 1);
        assert_eq!(placed[0].recording_clip, 0);
    }

    #[test]
    fn the_sidecar_survives_a_crash_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("content")).unwrap();
        let markers = RecordingMarkers::new(Some(dir.path()));
        markers.segment_started(0, Timestamps::now(), None);
        for _ in 0..25 {
            markers.add(Instant::now());
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while read_recorded_markers(dir.path()).len() != 25 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(read_recorded_markers(dir.path()), markers.snapshot());
    }

    #[test]
    fn a_damaged_sidecar_reads_as_no_markers() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("content")).unwrap();
        std::fs::write(dir.path().join(RECORDING_MARKERS_FILE), b"{oops").unwrap();
        assert!(read_recorded_markers(dir.path()).is_empty());
        assert!(read_recorded_markers(&dir.path().join("missing")).is_empty());
    }
}
