use cap_media_info::{Pixel, Sample, Type};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct TestConfig {
    pub video: Option<VideoTestConfig>,
    pub audio: Option<AudioTestConfig>,
    pub duration: Duration,
    pub output_format: OutputFormat,
}

impl Default for TestConfig {
    fn default() -> Self {
        Self {
            video: Some(VideoTestConfig::default()),
            audio: Some(AudioTestConfig::default()),
            duration: Duration::from_secs(5),
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct VideoTestConfig {
    pub width: u32,
    pub height: u32,
    pub frame_rate: u32,
    pub pixel_format: Pixel,
    pub pattern: TestPattern,
}

impl Default for VideoTestConfig {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            frame_rate: 30,
            pixel_format: Pixel::NV12,
            pattern: TestPattern::FrameCounter,
        }
    }
}

impl VideoTestConfig {
    pub fn with_resolution(mut self, width: u32, height: u32) -> Self {
        self.width = width;
        self.height = height;
        self
    }

    pub fn with_frame_rate(mut self, fps: u32) -> Self {
        self.frame_rate = fps;
        self
    }

    pub fn with_pixel_format(mut self, format: Pixel) -> Self {
        self.pixel_format = format;
        self
    }

    pub fn with_pattern(mut self, pattern: TestPattern) -> Self {
        self.pattern = pattern;
        self
    }

    pub fn hd_720p() -> Self {
        Self::default().with_resolution(1280, 720)
    }

    pub fn fhd_1080p() -> Self {
        Self::default().with_resolution(1920, 1080)
    }

    pub fn qhd_1440p() -> Self {
        Self::default().with_resolution(2560, 1440)
    }

    pub fn uhd_4k() -> Self {
        Self::default().with_resolution(3840, 2160)
    }

    pub fn ultrawide_1080() -> Self {
        Self::default().with_resolution(2560, 1080)
    }

    pub fn ultrawide_1440() -> Self {
        Self::default().with_resolution(3440, 1440)
    }

    pub fn super_ultrawide() -> Self {
        Self::default().with_resolution(5120, 1440)
    }

    pub fn portrait_1080() -> Self {
        Self::default().with_resolution(1080, 1920)
    }

    pub fn macbook_retina() -> Self {
        Self::default().with_resolution(2880, 1800)
    }

    pub fn macbook_pro_14() -> Self {
        Self::default().with_resolution(3024, 1964)
    }

    pub fn macbook_pro_16_promotion() -> Self {
        Self::default()
            .with_resolution(3456, 2234)
            .with_frame_rate(120)
    }

    pub fn webcam_vga() -> Self {
        Self::default().with_resolution(640, 480)
    }

    pub fn webcam_hd() -> Self {
        Self::default().with_resolution(1280, 720)
    }

    pub fn webcam_fhd() -> Self {
        Self::default().with_resolution(1920, 1080)
    }

    pub fn webcam_4k() -> Self {
        Self::default().with_resolution(3840, 2160)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TestPattern {
    SmpteColorBars,
    ColorGradient,
    #[default]
    FrameCounter,
    TimestampOverlay,
    Checkerboard,
    SolidColor {
        r: u8,
        g: u8,
        b: u8,
    },
    Random,
}

#[derive(Debug, Clone)]
pub struct AudioTestConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: Sample,
    pub generator: AudioGenerator,
}

impl Default for AudioTestConfig {
    fn default() -> Self {
        Self {
            sample_rate: 48000,
            channels: 2,
            sample_format: Sample::F32(Type::Planar),
            generator: AudioGenerator::SineWave { frequency: 440.0 },
        }
    }
}

impl AudioTestConfig {
    pub fn with_sample_rate(mut self, rate: u32) -> Self {
        self.sample_rate = rate;
        self
    }

    pub fn with_channels(mut self, channels: u16) -> Self {
        self.channels = channels;
        self
    }

    pub fn with_sample_format(mut self, format: Sample) -> Self {
        self.sample_format = format;
        self
    }

    pub fn with_generator(mut self, generator: AudioGenerator) -> Self {
        self.generator = generator;
        self
    }

    pub fn cd_quality_mono() -> Self {
        Self::default().with_sample_rate(44100).with_channels(1)
    }

    pub fn cd_quality_stereo() -> Self {
        Self::default().with_sample_rate(44100).with_channels(2)
    }

    pub fn broadcast_mono() -> Self {
        Self::default().with_sample_rate(48000).with_channels(1)
    }

    pub fn broadcast_stereo() -> Self {
        Self::default().with_sample_rate(48000).with_channels(2)
    }

    pub fn high_res_stereo() -> Self {
        Self::default().with_sample_rate(96000).with_channels(2)
    }

    pub fn surround_5_1() -> Self {
        Self::default().with_sample_rate(48000).with_channels(6)
    }

    pub fn voice_optimized() -> Self {
        Self::default()
            .with_sample_rate(16000)
            .with_channels(1)
            .with_sample_format(Sample::I16(Type::Planar))
    }
}

#[derive(Debug, Clone)]
pub enum AudioGenerator {
    SineWave { frequency: f32 },
    Chirp { start_freq: f32, end_freq: f32 },
    WhiteNoise,
    Silence,
    TimestampBeeps { beep_interval_ms: u32 },
    Square { frequency: f32 },
}

impl Default for AudioGenerator {
    fn default() -> Self {
        Self::SineWave { frequency: 440.0 }
    }
}

#[derive(Debug, Clone)]
pub enum OutputFormat {
    Mp4,
    FragmentedM4s { segment_duration: Duration },
    OggOpus,
}

impl Default for OutputFormat {
    fn default() -> Self {
        Self::FragmentedM4s {
            segment_duration: Duration::from_secs(3),
        }
    }
}

pub fn common_test_configs() -> Vec<TestConfig> {
    vec![
        TestConfig {
            video: Some(VideoTestConfig::fhd_1080p().with_frame_rate(30)),
            audio: Some(AudioTestConfig::broadcast_stereo()),
            duration: Duration::from_secs(5),
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        },
        TestConfig {
            video: Some(VideoTestConfig::fhd_1080p().with_frame_rate(60)),
            audio: Some(AudioTestConfig::broadcast_stereo()),
            duration: Duration::from_secs(5),
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        },
        TestConfig {
            video: Some(VideoTestConfig::hd_720p().with_frame_rate(30)),
            audio: Some(AudioTestConfig::broadcast_stereo()),
            duration: Duration::from_secs(5),
            output_format: OutputFormat::Mp4,
        },
        TestConfig {
            video: Some(VideoTestConfig::uhd_4k().with_frame_rate(30)),
            audio: Some(AudioTestConfig::broadcast_stereo()),
            duration: Duration::from_secs(5),
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        },
    ]
}

pub fn comprehensive_test_configs() -> Vec<TestConfig> {
    let mut configs = vec![];

    let resolutions = [
        (1280, 720),
        (1920, 1080),
        (2560, 1440),
        (3840, 2160),
        (2560, 1080),
        (3440, 1440),
        (1080, 1920),
        (2880, 1800),
        (3024, 1964),
    ];

    let frame_rates = [24, 30, 60];
    let pixel_formats = [Pixel::NV12, Pixel::BGRA];

    for (width, height) in resolutions {
        for fps in frame_rates {
            if width * height > 1920 * 1080 && fps > 60 {
                continue;
            }

            for pixel_format in pixel_formats {
                configs.push(TestConfig {
                    video: Some(VideoTestConfig {
                        width,
                        height,
                        frame_rate: fps,
                        pixel_format,
                        pattern: TestPattern::FrameCounter,
                    }),
                    audio: Some(AudioTestConfig::broadcast_stereo()),
                    duration: Duration::from_secs(5),
                    output_format: OutputFormat::FragmentedM4s {
                        segment_duration: Duration::from_secs(3),
                    },
                });
            }
        }
    }

    let audio_configs = [
        AudioTestConfig::cd_quality_mono(),
        AudioTestConfig::cd_quality_stereo(),
        AudioTestConfig::broadcast_mono(),
        AudioTestConfig::broadcast_stereo(),
        AudioTestConfig::high_res_stereo(),
        AudioTestConfig::voice_optimized(),
    ];

    for audio in audio_configs {
        configs.push(TestConfig {
            video: Some(VideoTestConfig::fhd_1080p()),
            audio: Some(audio),
            duration: Duration::from_secs(5),
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        });
    }

    configs
}
