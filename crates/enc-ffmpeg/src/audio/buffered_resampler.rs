use std::collections::VecDeque;

use cap_media_info::AudioInfo;
use ffmpeg::software::resampling;

/// Consumes audio frames, resmaples them, buffers the results,
/// and allows retrieving new frames of any size.
/// When retrieving new frames via `get_frame`, silence will be accounted
/// for if the requested frame size is larger than the latest buffered frame,
/// ensuring that the resulting frame's PTS is always accurate.
pub struct BufferedResampler {
    resampler: ffmpeg::software::resampling::Context,
    buffer: VecDeque<(ffmpeg::frame::Audio, i64)>,
    sample_index: usize,
    // used to account for cases where pts is rounded down instead of up
    min_next_pts: Option<i64>,
}

impl BufferedResampler {
    pub fn new(from: AudioInfo, to: AudioInfo) -> Result<Self, ffmpeg::Error> {
        let resampler = ffmpeg::software::resampler(
            (from.sample_format, from.channel_layout(), from.sample_rate),
            (to.sample_format, to.channel_layout(), to.sample_rate),
        )?;

        Ok(Self {
            resampler,
            buffer: VecDeque::new(),
            sample_index: 0,
            min_next_pts: None,
        })
    }

    fn remaining_samples(&self) -> usize {
        let (mut pts, mut remaining_samples) = if let Some(front) = self.buffer.front() {
            (
                front.1 + front.0.samples() as i64,
                front.0.samples() - self.sample_index,
            )
        } else {
            return 0;
        };

        for buffer in self.buffer.iter().skip(1) {
            // fill in gap
            remaining_samples += (buffer.1 - pts) as usize;
            remaining_samples += buffer.0.samples();
            pts += buffer.0.samples() as i64;
        }

        remaining_samples
    }

    pub fn output(&self) -> resampling::context::Definition {
        *self.resampler.output()
    }

    pub fn add_frame(&mut self, mut frame: ffmpeg::frame::Audio) {
        if let Some(min_next_pts) = self.min_next_pts {
            if let Some(pts) = frame.pts() {
                frame.set_pts(Some(pts.max(min_next_pts)));
            }
        }

        let pts = frame.pts().unwrap();

        let mut resampled_frame = ffmpeg::frame::Audio::empty();

        self.resampler.run(&frame, &mut resampled_frame).unwrap();

        let resampled_pts =
            (pts as f64 * (resampled_frame.rate() as f64 / frame.rate() as f64)) as i64;

        let mut next_pts = resampled_pts + resampled_frame.samples() as i64;

        self.buffer.push_back((resampled_frame, resampled_pts));

        while self.resampler.delay().is_some() {
            let mut resampled_frame = ffmpeg::frame::Audio::new(
                self.resampler.output().format,
                0,
                self.resampler.output().channel_layout,
            );
            self.resampler.flush(&mut resampled_frame).unwrap();
            let samples = resampled_frame.samples();
            if samples == 0 {
                break;
            }

            self.buffer.push_back((resampled_frame, next_pts));

            next_pts += samples as i64;
        }

        self.min_next_pts = Some(pts + frame.samples() as i64);
    }

    fn get_frame_inner(&mut self, samples: usize) -> Option<ffmpeg::frame::Audio> {
        let output = self.output();

        let mut out_frame =
            ffmpeg::frame::Audio::new(output.format, samples, output.channel_layout);

        let mut samples_already_written = 0;
        let mut current_pts = 0;

        if output.format.is_packed() {
            let bytes_per_sample =
                output.format.bytes() * output.channel_layout.channels() as usize;

            while let Some((frame, pts)) = self.buffer.pop_front() {
                if out_frame.pts().is_none() {
                    current_pts = pts + self.sample_index as i64;
                    out_frame.set_pts(Some(current_pts));
                }

                if pts >= current_pts + samples as i64 {
                    self.buffer.push_front((frame, pts));

                    let dest_range_start_samples = samples_already_written;
                    let dest_range_end_samples =
                        dest_range_start_samples + (samples - samples_already_written);
                    out_frame.data_mut(0)[dest_range_start_samples * bytes_per_sample
                        ..dest_range_end_samples * bytes_per_sample]
                        .fill(0);

                    break;
                }

                if current_pts < pts {
                    let silence_needed =
                        ((pts - current_pts) as usize).min(samples - samples_already_written);

                    out_frame.data_mut(0)[samples_already_written * bytes_per_sample
                        ..(samples_already_written + silence_needed) * bytes_per_sample]
                        .fill(0);

                    samples_already_written += silence_needed;
                    current_pts += silence_needed as i64;

                    if samples_already_written >= samples {
                        self.buffer.push_front((frame, pts));
                        break;
                    }
                }

                let sample_index = self.sample_index;

                let src_samples_remaining = frame.samples() - sample_index;

                let samples_to_write =
                    usize::min(src_samples_remaining, samples - samples_already_written);

                let dest_range_start = samples_already_written * bytes_per_sample;
                let dest_range_end = dest_range_start + samples_to_write * bytes_per_sample;

                let src_range_start = sample_index * bytes_per_sample;
                let src_range_end = src_range_start + samples_to_write * bytes_per_sample;

                out_frame.data_mut(0)[dest_range_start..dest_range_end]
                    .copy_from_slice(&frame.data(0)[src_range_start..src_range_end]);

                samples_already_written += samples_to_write;

                self.sample_index += samples_to_write;

                current_pts += samples_to_write as i64;

                if samples_to_write < src_samples_remaining {
                    self.buffer.push_front((frame, pts));
                    break;
                } else if samples_to_write >= src_samples_remaining {
                    self.sample_index -= frame.samples();
                }
            }
        } else {
            let channels = output.channel_layout.channels() as usize;
            let bytes_per_sample = output.format.bytes();

            while let Some((frame, pts)) = self.buffer.pop_front() {
                if out_frame.pts().is_none() {
                    current_pts = pts + self.sample_index as i64;
                    out_frame.set_pts(Some(current_pts));
                }

                if pts >= current_pts + samples as i64 {
                    self.buffer.push_front((frame, pts));

                    for i in 0..channels {
                        let dest_range_start_samples = samples_already_written;
                        let dest_range_end_samples =
                            dest_range_start_samples + (samples - samples_already_written);
                        out_frame.data_mut(i)[dest_range_start_samples * bytes_per_sample
                            ..dest_range_end_samples * bytes_per_sample]
                            .fill(0);
                    }

                    break;
                }

                if current_pts < pts {
                    let silence_needed =
                        ((pts - current_pts) as usize).min(samples - samples_already_written);

                    for i in 0..channels {
                        out_frame.data_mut(i)[samples_already_written * bytes_per_sample
                            ..(samples_already_written + silence_needed) * bytes_per_sample]
                            .fill(0);
                    }

                    samples_already_written += silence_needed;
                    current_pts += silence_needed as i64;

                    if samples_already_written >= samples {
                        self.buffer.push_front((frame, pts));
                        break;
                    }
                }

                let sample_index = self.sample_index;

                let src_samples_remaining = frame.samples() - sample_index;

                let samples_to_write =
                    usize::min(src_samples_remaining, samples - samples_already_written);

                let dest_range_start = samples_already_written * bytes_per_sample;
                let dest_range_end = dest_range_start + samples_to_write * bytes_per_sample;

                let src_range_start = sample_index * bytes_per_sample;
                let src_range_end = src_range_start + samples_to_write * bytes_per_sample;

                for i in 0..channels {
                    out_frame.data_mut(i)[dest_range_start..dest_range_end]
                        .copy_from_slice(&frame.data(i)[src_range_start..src_range_end]);
                }

                samples_already_written += samples_to_write;

                self.sample_index += samples_to_write;

                current_pts += samples_to_write as i64;

                if samples_to_write < src_samples_remaining {
                    self.buffer.push_front((frame, pts));
                    break;
                } else if samples_to_write >= src_samples_remaining {
                    self.sample_index -= frame.samples();
                }
            }
        }

        Some(out_frame)
    }

    pub fn get_frame(&mut self, samples: usize) -> Option<ffmpeg::frame::Audio> {
        if self.remaining_samples() < samples {
            return None;
        }

        self.get_frame_inner(samples)
    }

    pub fn flush(&mut self, max_samples: usize) -> Option<ffmpeg::frame::Audio> {
        let remaining_samples = self.remaining_samples();
        if remaining_samples == 0 {
            return None;
        }

        self.get_frame_inner(remaining_samples.min(max_samples))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ffmpeg::{ChannelLayout, format};

    const IN_RATE: u32 = 100;

    fn create_resampler(out_rate: u32) -> BufferedResampler {
        BufferedResampler::new(
            AudioInfo::new_raw(format::Sample::U8(cap_media_info::Type::Packed), IN_RATE, 1),
            AudioInfo::new_raw(
                format::Sample::U8(cap_media_info::Type::Packed),
                out_rate,
                1,
            ),
        )
        .unwrap()
    }

    fn make_input_frame(samples: usize, pts: i64) -> ffmpeg::frame::Audio {
        let mut frame = ffmpeg::frame::Audio::new(
            cap_media_info::Sample::U8(cap_media_info::Type::Packed),
            samples,
            ChannelLayout::MONO,
        );

        frame.data_mut(0).fill(69);

        frame.set_rate(IN_RATE);
        frame.set_pts(Some(pts));
        frame
    }

    mod resampler {
        use super::*;

        #[test]
        fn sequential_frames() {
            let mut bufferer = create_resampler(200);

            bufferer.add_frame(make_input_frame(100, 0));
            bufferer.add_frame(make_input_frame(100, 100));

            let sample_sum = bufferer.buffer.iter().map(|f| f.0.samples()).sum::<usize>();
            assert_eq!(sample_sum, 400);

            let first = bufferer.buffer.front().unwrap();
            assert_eq!(first.1, 0);

            let last = bufferer.buffer.back().unwrap();
            assert_eq!(last.1 + last.0.samples() as i64, 400);
        }

        #[test]
        fn start_gap() {
            let mut bufferer = create_resampler(200);

            bufferer.add_frame(make_input_frame(100, 100));
            bufferer.add_frame(make_input_frame(100, 200));

            let first = bufferer.buffer.front().unwrap();
            assert_eq!(first.1, 200);

            let last = bufferer.buffer.back().unwrap();
            assert_eq!(last.1 + last.0.samples() as i64, 600);
        }

        #[test]
        fn middle_gap() {
            let mut bufferer = create_resampler(200);

            bufferer.add_frame(make_input_frame(100, 0));
            bufferer.add_frame(make_input_frame(100, 200));

            let first = bufferer.buffer.front().unwrap();
            assert_eq!(first.1, 0);

            let last = bufferer.buffer.back().unwrap();
            assert_eq!(last.1 + last.0.samples() as i64, 600);
        }
    }

    mod get_frame {
        use super::*;

        #[test]
        fn same_format() {
            // Tests getting 50 then 50 then 50

            let mut bufferer = create_resampler(IN_RATE);

            bufferer.add_frame(make_input_frame(100, 0));

            let out_frame = bufferer.get_frame(50);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 50);
            assert_eq!(bufferer.sample_index, 50);
            assert_eq!(out_frame.pts(), Some(0));

            let out_frame = bufferer.get_frame(50);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 50);
            assert_eq!(bufferer.sample_index, 0);
            assert_eq!(out_frame.pts(), Some(50));

            let out_frame = bufferer.get_frame(50);
            assert!(out_frame.is_none());

            // Tests getting 75 then 75 (should fail) then 25 (should succeed)

            let mut bufferer = create_resampler(IN_RATE);

            bufferer.add_frame(make_input_frame(100, 0));

            let out_frame = bufferer.get_frame(75);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 75);
            assert_eq!(bufferer.sample_index, 75);
            assert_eq!(out_frame.pts(), Some(0));

            let out_frame = bufferer.get_frame(75);
            assert!(out_frame.is_none());

            let out_frame = bufferer.get_frame(25);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 25);
            assert_eq!(bufferer.sample_index, 0);
            assert_eq!(out_frame.pts(), Some(75));
        }

        #[test]
        fn different_format() {
            let mut bufferer = create_resampler(200);

            bufferer.add_frame(make_input_frame(100, 0));

            let out_frame = bufferer.get_frame(125);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 125);
            assert_eq!(bufferer.sample_index, 25);
            assert_eq!(out_frame.pts(), Some(0));

            let out_frame = bufferer.get_frame(100);
            assert!(out_frame.is_none());

            let out_frame = bufferer.get_frame(75);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 75);
            assert_eq!(bufferer.sample_index, 0);
            assert_eq!(out_frame.pts(), Some(125));
        }

        // start gap will never have silence
        #[test]
        fn start_gap() {
            let mut bufferer = create_resampler(IN_RATE);

            bufferer.add_frame(make_input_frame(100, 100));

            let out_frame = bufferer.get_frame(50);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 50);
            assert_eq!(bufferer.sample_index, 50);
            assert_eq!(out_frame.pts(), Some(100));

            let out_frame = bufferer.get_frame(50);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 50);
            assert_eq!(bufferer.sample_index, 0);
            assert_eq!(out_frame.pts(), Some(150));

            let out_frame = bufferer.get_frame(50);
            assert!(out_frame.is_none());
        }

        #[test]
        fn middle_gap_no_silence() {
            let mut bufferer = create_resampler(IN_RATE);

            bufferer.add_frame(make_input_frame(100, 0));
            bufferer.add_frame(make_input_frame(100, 200));

            let out_frame = bufferer.get_frame(100);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 100);
            assert_eq!(bufferer.sample_index, 0);
            assert_eq!(out_frame.pts(), Some(0));

            let out_frame = bufferer.get_frame(100);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 100);
            assert_eq!(bufferer.sample_index, 0);
            assert_eq!(out_frame.pts(), Some(200));

            let out_frame = bufferer.get_frame(50);
            assert!(out_frame.is_none());
        }

        #[test]
        fn middle_gap_expect_silence() {
            let mut bufferer = create_resampler(IN_RATE);

            bufferer.add_frame(make_input_frame(100, 0));
            bufferer.add_frame(make_input_frame(100, 200));

            let out_frame = bufferer.get_frame(150);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 150);
            assert_eq!(bufferer.sample_index, 0);
            assert_eq!(out_frame.pts(), Some(0));

            let out_frame = bufferer.get_frame(100);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 100);
            assert_eq!(bufferer.sample_index, 0);
            assert_eq!(out_frame.pts(), Some(200));

            let out_frame = bufferer.get_frame(50);
            assert!(out_frame.is_none());
        }

        #[test]
        fn middle_gap_start_offset() {
            let mut bufferer = create_resampler(IN_RATE);

            bufferer.add_frame(make_input_frame(100, 0));
            bufferer.add_frame(make_input_frame(100, 200));

            let out_frame = bufferer.get_frame(25);
            assert!(out_frame.is_some());

            let out_frame = bufferer.get_frame(175);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 175);
            assert_eq!(bufferer.sample_index, 0);
            assert_eq!(out_frame.pts(), Some(25));

            let out_frame = bufferer.get_frame(100);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 100);
            assert_eq!(bufferer.sample_index, 0);
            assert_eq!(out_frame.pts(), Some(200));

            let out_frame = bufferer.get_frame(50);
            assert!(out_frame.is_none());
        }

        #[test]
        fn middle_gap_overlap() {
            let mut bufferer = create_resampler(IN_RATE);

            bufferer.add_frame(make_input_frame(100, 0));
            bufferer.add_frame(make_input_frame(100, 200));

            let out_frame = bufferer.get_frame(75);
            assert!(out_frame.is_some());

            let out_frame = bufferer.get_frame(175);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 175);
            assert_eq!(bufferer.sample_index, 50);
            assert_eq!(out_frame.pts(), Some(75));

            let out_frame = bufferer.get_frame(50);
            assert!(out_frame.is_some());
            let out_frame = out_frame.unwrap();

            assert_eq!(out_frame.samples(), 50);
            assert_eq!(bufferer.sample_index, 0);
            assert_eq!(out_frame.pts(), Some(250));

            let out_frame = bufferer.get_frame(50);
            assert!(out_frame.is_none());
        }

        #[test]
        fn many_small_frames() {
            let mut bufferer = create_resampler(IN_RATE);

            bufferer.add_frame(make_input_frame(100, 0));
            bufferer.add_frame(make_input_frame(100, 200));

            for i in 0..8 {
                let out_frame = bufferer.get_frame(25);
                assert!(out_frame.is_some());
                let out_frame = out_frame.unwrap();

                assert_eq!(out_frame.samples(), 25);
                assert_eq!(out_frame.pts(), Some(i % 4 * 25 + 200 * (i / 4)));
                assert_eq!(bufferer.sample_index, ((i as usize + 1) % 4) * 25 % 100);
            }
        }
    }
}
