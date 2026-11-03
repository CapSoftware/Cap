//! Replays mask tracking over a real clip, without the editor, to see how
//! the trackers do on recorded footage.
//!
//!   ffmpeg -i clip.mp4 -vf scale=960:540 -f rawvideo -pix_fmt rgba frames.rgba
//!   cargo run --release -p cap-gpui-kernels --example mask_track_replay -- \
//!     frames.rgba 960x540 30 "x,y x,y x,y x,y"
//!
//! Frames dumped by the editor (`CAP_GPUI_MASK_TRACK_DUMP`) are at the
//! tracking resolution fitted to the recording's aspect ratio, which the
//! editor logs when tracking starts.
//!
//! Points are normalized to the frame (0..1), taken on the first frame. Four
//! or more track points (covering both estimates where they disagree, as a
//! sensitive mask does); two (centre, size) track the whole box instead.
//! Prints the tracked box per frame as `time left top right bottom` in
//! pixels, then the spans in which the target was lost.

use cap_gpui_kernels::motion_track::{LumaFrame, TrackSession};
use cap_gpui_kernels::point_track::{Disagreement, PointTrackSession};

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let [_, frames, size, fps, points] = &args[..] else {
        eprintln!("usage: mask_track_replay <frames.rgba> <width>x<height> <fps> \"x,y x,y ...\"");
        std::process::exit(2);
    };
    let (width, height) = size.split_once('x').expect("<width>x<height>");
    let (width, height): (u32, u32) = (
        width.parse().expect("width"),
        height.parse().expect("height"),
    );
    let fps: f64 = fps.parse().expect("fps");
    let points = points
        .split_whitespace()
        .map(|pair| {
            let (x, y) = pair.split_once(',').expect("x,y");
            (x.parse::<f64>().expect("x"), y.parse::<f64>().expect("y"))
        })
        .collect::<Vec<_>>();
    let bytes = std::fs::read(frames).expect("frames");
    let frame_len = (width * height * 4) as usize;
    let mut frames = bytes
        .chunks_exact(frame_len)
        .map(|frame| LumaFrame::from_rgba(frame, width, height, (width * 4) as usize));
    let first = frames.next().expect("at least one frame");
    let (path, lost) = if points.len() >= 4 {
        let mut session = PointTrackSession::new(&first, 0.0, &points, Disagreement::CoverBoth)
            .expect("trackable points");
        for (index, frame) in frames.enumerate() {
            session.push((index + 1) as f64 / fps, frame);
        }
        session.finish()
    } else {
        let [center, size] = points[..] else {
            panic!("give four or more points, or a centre and a size");
        };
        let mut session = TrackSession::new(&first, 0.0, center, size).expect("trackable box");
        for (index, frame) in frames.enumerate() {
            session.push((index + 1) as f64 / fps, frame);
        }
        session.finish()
    };
    for point in path {
        let (w, h) = (f64::from(width), f64::from(height));
        println!(
            "{:.3} {:.1} {:.1} {:.1} {:.1}",
            point.time,
            (point.center.0 - point.size.0 / 2.0) * w,
            (point.center.1 - point.size.1 / 2.0) * h,
            (point.center.0 + point.size.0 / 2.0) * w,
            (point.center.1 + point.size.1 / 2.0) * h,
        );
    }
    eprintln!("lost: {lost:?}");
}
