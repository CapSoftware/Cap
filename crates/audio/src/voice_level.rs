use crate::{AudioSampleSource, VoiceEnhancer, cast_bytes_to_f32_slice, cast_f32_slice_to_bytes};
use ffmpeg::{ChannelLayout, filter, format, frame::Audio};

pub const VOICE_PROFILE_SAMPLES: usize = 16 * 48_000;
fn compressor(channels: u16) -> String {
    let threshold = if channels == 1 {
        0.125 * std::f32::consts::SQRT_2
    } else {
        0.125
    };
    format!("acompressor=threshold={threshold}:ratio=2:attack=15:release=180:knee=2.828:makeup=1")
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VoiceProfile {
    pub gain_db: f32,
    pub makeup_db: f32,
}

struct ProfileSource<'a, T> {
    source: &'a T,
    frames: usize,
    channels: u16,
}

impl<T: AudioSampleSource> AudioSampleSource for ProfileSource<'_, T> {
    fn channels(&self) -> u16 {
        self.channels
    }
    fn sample_count(&self) -> usize {
        self.frames
    }
    fn sample(&self, index: usize) -> Option<&f32> {
        if index / usize::from(self.channels) < self.frames {
            self.source.sample(index)
        } else {
            None
        }
    }
}

impl VoiceProfile {
    pub fn analyze(source: &impl AudioSampleSource) -> Self {
        Self::try_analyze(source).unwrap_or_else(|error| {
            tracing::warn!(%error, "Could not estimate Studio Sound voice level");
            Self::default()
        })
    }

    fn try_analyze(source: &impl AudioSampleSource) -> Result<Self, ffmpeg::Error> {
        let channels = source.channels().clamp(1, 2);
        let frames = source.sample_count().min(VOICE_PROFILE_SAMPLES);
        let source = ProfileSource {
            source,
            frames,
            channels,
        };
        let window = frames.min(24_000);
        if window < 480 {
            return Ok(Self::default());
        }
        let windows = (frames / window).clamp(1, 8);
        let mut samples = Vec::with_capacity(windows * window * usize::from(channels));
        let mut speech_frames = 0;
        for index in 0..windows {
            let start = if windows == 1 {
                0
            } else {
                (frames - window) * index / (windows - 1)
            };
            let mut enhancer = VoiceEnhancer::new(channels);
            let audio = enhancer.render(&source, start, window);
            speech_frames += enhancer.speech_frames();
            samples.extend_from_slice(audio.samples());
        }
        if speech_frames < 20 {
            return Ok(Self::default());
        }
        let Some(level) = measure(&samples, channels, "anull")? else {
            return Ok(Self::default());
        };
        if level < -60.0 {
            return Ok(Self::default());
        }
        let gain_db = (-16.0 - level).clamp(-12.0, 24.0);
        let filter = format!("volume={gain_db}dB,{}", compressor(channels));
        let compressed = measure(&samples, channels, &filter)?.unwrap_or(-16.0);
        Ok(Self {
            gain_db,
            makeup_db: (-16.0 - compressed).clamp(-6.0, 6.0),
        })
    }

    pub(crate) fn filter(self, channels: u16) -> String {
        format!(
            "volume={}dB,{},volume={}dB,aresample=192000,alimiter=limit=0.841395:attack=5:release=80:level=false:latency=true,aresample=48000",
            self.gain_db,
            compressor(channels),
            self.makeup_db,
        )
    }
}

fn measure(samples: &[f32], channels: u16, processing: &str) -> Result<Option<f32>, ffmpeg::Error> {
    let mut filter = VoiceFilter::new(
        channels,
        &format!("{processing},ebur128=metadata=1:framelog=verbose"),
    )?;
    let mut level = None;
    for chunk in samples.chunks(4_800 * usize::from(channels)) {
        filter.push(chunk)?;
        filter.drain(|frame| {
            if let Some(value) = frame.metadata().get("lavfi.r128.I") {
                level = value.parse::<f32>().ok().filter(|value| value.is_finite());
            }
        })?;
    }
    filter.graph.get("in").unwrap().source().flush()?;
    filter.drain(|frame| {
        if let Some(value) = frame.metadata().get("lavfi.r128.I") {
            level = value.parse::<f32>().ok().filter(|value| value.is_finite());
        }
    })?;
    Ok(level)
}

pub(crate) struct VoiceFilter {
    graph: filter::Graph,
    channels: usize,
    position: i64,
    output: Audio,
}

impl VoiceFilter {
    pub(crate) fn new(channels: u16, processing: &str) -> Result<Self, ffmpeg::Error> {
        let layout = ChannelLayout::default(i32::from(channels));
        let mut graph = filter::Graph::new();
        unsafe { (*graph.as_mut_ptr()).nb_threads = 1 };
        graph.add(
            &filter::find("abuffer").ok_or(ffmpeg::Error::FilterNotFound)?,
            "in",
            &format!(
                "time_base=1/48000:sample_rate=48000:sample_fmt=flt:channel_layout=0x{:x}",
                layout.bits()
            ),
        )?;
        graph.add(
            &filter::find("abuffersink").ok_or(ffmpeg::Error::FilterNotFound)?,
            "out",
            "",
        )?;
        graph.output("in", 0)?.input("out", 0)?.parse(&format!(
            "{processing},aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=0x{:x}",
            layout.bits()
        ))?;
        graph.validate()?;
        Ok(Self {
            graph,
            channels: usize::from(channels),
            position: 0,
            output: Audio::empty(),
        })
    }

    fn push(&mut self, samples: &[f32]) -> Result<(), ffmpeg::Error> {
        let frames = samples.len() / self.channels;
        let mut frame = Audio::new(
            format::Sample::F32(format::sample::Type::Packed),
            frames,
            ChannelLayout::default(self.channels as i32),
        );
        frame.set_rate(48_000);
        frame.set_pts(Some(self.position));
        frame.data_mut(0)[..samples.len() * 4]
            .copy_from_slice(unsafe { cast_f32_slice_to_bytes(samples) });
        self.graph.get("in").unwrap().source().add(&frame)?;
        self.position += frames as i64;
        Ok(())
    }

    fn drain(&mut self, mut visit: impl FnMut(&Audio)) -> Result<(), ffmpeg::Error> {
        loop {
            match self
                .graph
                .get("out")
                .unwrap()
                .sink()
                .frame(&mut self.output)
            {
                Ok(()) => {
                    visit(&self.output);
                    // The filter sink transfers a frame reference; reusing a referenced frame leaks its buffers.
                    unsafe { ffmpeg::ffi::av_frame_unref(self.output.as_mut_ptr()) };
                }
                Err(ffmpeg::Error::Eof) => return Ok(()),
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => {
                    return Ok(());
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub(crate) fn process(
        &mut self,
        samples: &[f32],
        output: &mut std::collections::VecDeque<f32>,
    ) -> Result<(), ffmpeg::Error> {
        self.push(samples)?;
        let channels = self.channels;
        self.drain(|frame| {
            let bytes = &frame.data(0)[..frame.samples() * channels * 4];
            output.extend(unsafe { cast_bytes_to_f32_slice(bytes) });
        })
    }
}
