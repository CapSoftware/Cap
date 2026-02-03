use crate::config::TestConfig;
use crate::discovery::DiscoveredHardware;
use crate::results::{AudioTestConfig, CameraTestConfig, DisplayTestConfig, TestCaseConfig};

#[derive(Debug, Clone)]
pub struct TestCase {
    pub id: String,
    pub name: String,
    pub config: TestCaseConfig,
    pub source: TestCaseSource,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum TestCaseSource {
    RealHardware {
        display_id: Option<String>,
        camera_id: Option<String>,
        audio_input_id: Option<String>,
    },
    Synthetic,
}

pub struct MatrixGenerator {
    config: TestConfig,
    hardware: Option<DiscoveredHardware>,
}

impl MatrixGenerator {
    pub fn new(config: TestConfig, hardware: Option<DiscoveredHardware>) -> Self {
        Self { config, hardware }
    }

    pub fn generate(&self) -> Vec<TestCase> {
        let mut cases = Vec::new();

        if let Some(hardware) = &self.hardware {
            cases.extend(self.generate_display_tests(hardware));
            cases.extend(self.generate_camera_tests(hardware));
            cases.extend(self.generate_audio_tests(hardware));
            cases.extend(self.generate_combined_tests(hardware));
        } else {
            cases.extend(self.generate_synthetic_tests());
        }

        cases
    }

    fn generate_display_tests(&self, hardware: &DiscoveredHardware) -> Vec<TestCase> {
        let mut cases = Vec::new();

        for display in &hardware.displays {
            for fps in &self.config.displays.frame_rates {
                if *fps as f64 > display.refresh_rate + 1.0 {
                    continue;
                }

                let case = TestCase {
                    id: format!(
                        "display-{}-{}x{}-{}fps",
                        display.id, display.physical_width, display.physical_height, fps
                    ),
                    name: format!(
                        "Display {} {}x{} @{}fps",
                        display.name.as_deref().unwrap_or(&display.id),
                        display.physical_width,
                        display.physical_height,
                        fps
                    ),
                    config: TestCaseConfig {
                        display: Some(DisplayTestConfig {
                            width: display.physical_width,
                            height: display.physical_height,
                            fps: *fps,
                            display_id: Some(display.id.clone()),
                        }),
                        camera: None,
                        audio: None,
                        duration_secs: self.config.recording.duration_secs,
                    },
                    source: TestCaseSource::RealHardware {
                        display_id: Some(display.id.clone()),
                        camera_id: None,
                        audio_input_id: None,
                    },
                };
                cases.push(case);
            }
        }

        cases
    }

    fn generate_camera_tests(&self, hardware: &DiscoveredHardware) -> Vec<TestCase> {
        let mut cases = Vec::new();

        if !self.config.cameras.enabled {
            return cases;
        }

        for camera in &hardware.cameras {
            for target_res in &self.config.cameras.resolutions {
                let matching_format = camera
                    .formats
                    .iter()
                    .find(|f| f.width == target_res.width && f.height == target_res.height);

                if let Some(format) = matching_format {
                    for target_fps in &self.config.cameras.frame_rates {
                        if (*target_fps as f32) > format.frame_rate + 1.0 {
                            continue;
                        }

                        let case = TestCase {
                            id: format!(
                                "camera-{}-{}x{}-{}fps",
                                sanitize_id(&camera.name),
                                format.width,
                                format.height,
                                target_fps
                            ),
                            name: format!(
                                "Camera {} {}x{} @{}fps",
                                camera.name, format.width, format.height, target_fps
                            ),
                            config: TestCaseConfig {
                                display: None,
                                camera: Some(CameraTestConfig {
                                    width: format.width,
                                    height: format.height,
                                    fps: *target_fps,
                                    pixel_format: format.pixel_format.clone(),
                                    device_id: Some(camera.id.clone()),
                                }),
                                audio: None,
                                duration_secs: self.config.recording.duration_secs,
                            },
                            source: TestCaseSource::RealHardware {
                                display_id: None,
                                camera_id: Some(camera.id.clone()),
                                audio_input_id: None,
                            },
                        };
                        cases.push(case);
                    }
                }
            }
        }

        cases
    }

    fn generate_audio_tests(&self, hardware: &DiscoveredHardware) -> Vec<TestCase> {
        let mut cases = Vec::new();

        if !self.config.audio.microphones.enabled {
            return cases;
        }

        for input in &hardware.audio_inputs {
            if input.is_bluetooth && !self.config.audio.microphones.include_bluetooth {
                continue;
            }
            if input.is_usb && !self.config.audio.microphones.include_usb {
                continue;
            }
            if input.is_builtin && !self.config.audio.microphones.include_builtin {
                continue;
            }

            for sample_rate in &self.config.audio.microphones.sample_rates {
                if !input.sample_rates.contains(sample_rate) {
                    continue;
                }

                for channels in &self.config.audio.microphones.channels {
                    if *channels > input.channels {
                        continue;
                    }

                    let case = TestCase {
                        id: format!(
                            "audio-{}-{}hz-{}ch",
                            sanitize_id(&input.name),
                            sample_rate,
                            channels
                        ),
                        name: format!("Audio {} {}Hz {}ch", input.name, sample_rate, channels),
                        config: TestCaseConfig {
                            display: None,
                            camera: None,
                            audio: Some(AudioTestConfig {
                                sample_rate: *sample_rate,
                                channels: *channels,
                                device_id: Some(input.id.clone()),
                                include_system_audio: false,
                            }),
                            duration_secs: self.config.recording.duration_secs,
                        },
                        source: TestCaseSource::RealHardware {
                            display_id: None,
                            camera_id: None,
                            audio_input_id: Some(input.id.clone()),
                        },
                    };
                    cases.push(case);
                }
            }
        }

        cases
    }

    fn generate_combined_tests(&self, hardware: &DiscoveredHardware) -> Vec<TestCase> {
        let mut cases = Vec::new();

        let primary_display = hardware.displays.iter().find(|d| d.is_primary);
        let first_camera = hardware.cameras.first();
        let first_audio = hardware.audio_inputs.first();

        if let Some(display) = primary_display {
            for fps in &self.config.displays.frame_rates {
                if *fps as f64 > display.refresh_rate + 1.0 {
                    continue;
                }

                if let Some(camera) = first_camera {
                    let camera_format = camera.formats.first();

                    let case = TestCase {
                        id: format!(
                            "combined-display-camera-{}x{}-{}fps",
                            display.physical_width, display.physical_height, fps
                        ),
                        name: format!(
                            "Display+Camera {}x{} @{}fps",
                            display.physical_width, display.physical_height, fps
                        ),
                        config: TestCaseConfig {
                            display: Some(DisplayTestConfig {
                                width: display.physical_width,
                                height: display.physical_height,
                                fps: *fps,
                                display_id: Some(display.id.clone()),
                            }),
                            camera: camera_format.map(|f| CameraTestConfig {
                                width: f.width,
                                height: f.height,
                                fps: f.frame_rate.min(*fps as f32) as u32,
                                pixel_format: f.pixel_format.clone(),
                                device_id: Some(camera.id.clone()),
                            }),
                            audio: first_audio.map(|a| AudioTestConfig {
                                sample_rate: *a.sample_rates.first().unwrap_or(&48000),
                                channels: a.channels.min(2),
                                device_id: Some(a.id.clone()),
                                include_system_audio: self.config.audio.system.enabled,
                            }),
                            duration_secs: self.config.recording.duration_secs,
                        },
                        source: TestCaseSource::RealHardware {
                            display_id: Some(display.id.clone()),
                            camera_id: Some(camera.id.clone()),
                            audio_input_id: first_audio.map(|a| a.id.clone()),
                        },
                    };
                    cases.push(case);
                }
            }
        }

        cases
    }

    fn generate_synthetic_tests(&self) -> Vec<TestCase> {
        let mut cases = Vec::new();

        for res in &self.config.displays.resolutions {
            for fps in &self.config.displays.frame_rates {
                let case = TestCase {
                    id: format!("synthetic-{}x{}-{}fps", res.width, res.height, fps),
                    name: format!(
                        "Synthetic {} {}x{} @{}fps",
                        res.label, res.width, res.height, fps
                    ),
                    config: TestCaseConfig {
                        display: Some(DisplayTestConfig {
                            width: res.width,
                            height: res.height,
                            fps: *fps,
                            display_id: None,
                        }),
                        camera: None,
                        audio: Some(AudioTestConfig {
                            sample_rate: 48000,
                            channels: 2,
                            device_id: None,
                            include_system_audio: false,
                        }),
                        duration_secs: self.config.recording.duration_secs,
                    },
                    source: TestCaseSource::Synthetic,
                };
                cases.push(case);
            }
        }

        cases
    }
}

fn sanitize_id(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}
