use std::ops::Range;

/// The frames an export renders: every frame of the timeline, or sparse
/// windows sampled from it in one pass so decoders, layers and the encoder
/// are set up once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameWindows(Vec<Range<u32>>);

impl FrameWindows {
    pub fn all(total_frames: u32) -> Self {
        Self::new(std::iter::once(0..total_frames).collect())
    }

    pub fn new(windows: Vec<Range<u32>>) -> Self {
        let mut windows: Vec<Range<u32>> = windows
            .into_iter()
            .filter(|window| window.start < window.end)
            .collect();
        windows.sort_by_key(|window| window.start);
        windows.dedup_by(|next, previous| {
            if next.start <= previous.end {
                previous.end = previous.end.max(next.end);
                true
            } else {
                false
            }
        });
        Self(windows)
    }

    pub fn clamped_to(self, total_frames: u32) -> Self {
        Self::new(
            self.0
                .into_iter()
                .map(|window| window.start.min(total_frames)..window.end.min(total_frames))
                .collect(),
        )
    }

    pub fn windows(&self) -> &[Range<u32>] {
        &self.0
    }

    pub fn first(&self) -> Option<u32> {
        self.0.first().map(|window| window.start)
    }

    pub fn end(&self) -> u32 {
        self.0.last().map_or(0, |window| window.end)
    }

    pub fn len(&self) -> u32 {
        self.0.iter().map(|window| window.end - window.start).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn contains(&self, frame: u32) -> bool {
        self.0.iter().any(|window| window.contains(&frame))
    }

    pub fn next_after(&self, frame: u32) -> Option<u32> {
        let index = self.0.iter().position(|window| window.contains(&frame))?;
        let window = &self.0[index];
        if frame + 1 < window.end {
            Some(frame + 1)
        } else {
            self.0.get(index + 1).map(|next| next.start)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_are_walked_in_order_and_jump_between_them() {
        let windows = FrameWindows::new(vec![40..42, 0..3, 10..12, 12..13, 5..5]);
        assert_eq!(windows.windows(), &[0..3, 10..13, 40..42]);
        assert_eq!(windows.first(), Some(0));
        assert_eq!(windows.len(), 8);
        assert_eq!(windows.end(), 42);
        let mut walked = Vec::new();
        let mut next = windows.first();
        while let Some(frame) = next {
            walked.push(frame);
            next = windows.next_after(frame);
        }
        assert_eq!(walked, vec![0, 1, 2, 10, 11, 12, 40, 41]);
        assert_eq!(windows.next_after(7), None);
    }

    #[test]
    fn clamping_drops_windows_past_the_end() {
        let windows = FrameWindows::new(vec![0..10, 20..30, 50..60]).clamped_to(25);
        assert_eq!(windows.windows(), &[0..10, 20..25]);
        assert!(FrameWindows::all(0).is_empty());
        assert_eq!(FrameWindows::all(7).next_after(6), None);
    }
}
