fn main() {
    #[cfg(target_os = "macos")]
    macos::main();
}

#[cfg(target_os = "macos")]
mod macos {
    use cap_camera_avfoundation::{
        CallbackOutputDelegate, CallbackOutputDelegateInner, YCbCrMatrix, list_video_devices,
    };
    use cidre::*;
    use clap::{Parser, Subcommand};
    use inquire::Select;
    use std::{fmt::Display, ops::Deref};

    #[derive(Parser)]
    struct Cli {
        #[command(subcommand)]
        command: Commands,
    }

    #[derive(Subcommand)]
    enum Commands {
        /// Print details of a device
        Device,
    }

    pub fn main() {
        let _devices = list_video_devices();
        let devices = _devices
            .iter()
            .enumerate()
            .map(|(i, v)| CaptureDeviceSelectOption(v, i))
            .collect::<Vec<_>>();

        let selected = Select::new("Select a device", devices).prompt().unwrap();
        let mut selected_device = _devices.get(selected.1).unwrap();

        println!("Info for device '{}'", selected_device.localized_name());

        let formats = selected_device.formats();

        let mut _formats = vec![];

        for (i, format) in formats.iter().enumerate() {
            let desc = format.format_desc();

            let color_space = desc
                .ext(cm::FormatDescExtKey::ycbcr_matrix())
                .map(|v| {
                    v.try_as_string()
                        .and_then(|v| YCbCrMatrix::try_from(v).ok())
                })
                .unwrap_or(Some(YCbCrMatrix::Rec601));

            let fr_ranges = format.video_supported_frame_rate_ranges();

            for fr_range in fr_ranges.iter() {
                _formats.push(Format {
                    index: i,
                    width: desc.dims().width,
                    height: desc.dims().height,
                    fourcc: desc.media_sub_type(),
                    color_space,
                    max_frame_rate: (
                        fr_range.min_frame_duration().value,
                        fr_range.min_frame_duration().scale,
                    ),
                });
            }
        }

        let selected_format = if _formats.len() > 1 {
            inquire::Select::new("Select a format", _formats)
                .prompt()
                .unwrap()
        } else {
            _formats.remove(0)
        };

        let input = av::capture::DeviceInput::with_device(&selected_device).unwrap();
        let queue = dispatch::Queue::new();
        let delegate =
            CallbackOutputDelegate::with(CallbackOutputDelegateInner::new(Box::new(|data| {
                let Some(image_buf) = data.sample_buf.image_buf() else {
                    return;
                };

                let total_bytes = if image_buf.plane_count() > 0 {
                    (0..image_buf.plane_count())
                        .map(|i| image_buf.plane_bytes_per_row(i) * image_buf.plane_height(i))
                        .sum::<usize>()
                } else {
                    image_buf.plane_bytes_per_row(0) * image_buf.plane_height(0)
                };

                let mut format = image_buf.pixel_format().0.to_be_bytes();
                let format_fourcc = four_cc_to_str(&mut format);

                println!(
                    "New frame: {}x{}, {:.2}pts, {total_bytes} bytes, format={format_fourcc}",
                    image_buf.width(),
                    image_buf.height(),
                    data.sample_buf.pts().value as f64 / data.sample_buf.pts().scale as f64,
                )
            })));

        let mut output = av::capture::VideoDataOutput::new();

        let mut session = av::capture::Session::new();

        session.configure(|s| {
            if s.can_add_input(&input) {
                s.add_input(&input);
            } else {
                panic!("can't add input");
            }

            s.add_output(&output);

            let mut _lock = selected_device.config_lock().unwrap();

            _lock.set_active_format(&formats[selected_format.index]);
        });

        output.set_sample_buf_delegate(Some(delegate.as_ref()), Some(&queue));

        let video_settings = ns::Dictionary::with_keys_values(
            &[cv::pixel_buffer_keys::pixel_format().as_ns()],
            &[ns::Number::with_u32(selected_format.fourcc).as_id_ref()],
        );
        output
            .set_video_settings(Some(video_settings.as_ref()))
            .unwrap();

        // The device config must stay locked while running starts,
        // otherwise start_running can overwrite the active format on macOS
        // https://stackoverflow.com/questions/36689578/avfoundation-capturing-video-with-custom-resolution
        {
            let mut _lock = selected_device.config_lock().unwrap();

            _lock.set_active_format(&formats[selected_format.index]);

            session.start_running();
        }

        std::thread::sleep(std::time::Duration::from_secs(10));

        session.stop_running();

        std::thread::sleep(std::time::Duration::from_secs(10));
    }

    struct Format {
        index: usize,
        width: i32,
        height: i32,
        fourcc: FourCharCode,
        #[allow(unused)]
        color_space: Option<YCbCrMatrix>,
        max_frame_rate: (i64, i32),
    }

    impl Display for Format {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(
                f,
                "{}x{}, {} max fps ({}/{}) {}",
                self.width,
                self.height,
                self.max_frame_rate.1 as f32 / self.max_frame_rate.0 as f32,
                self.max_frame_rate.0,
                self.max_frame_rate.1,
                four_cc_to_string(self.fourcc.to_be_bytes())
            )
        }
    }

    struct CaptureDeviceSelectOption<'a>(&'a av::CaptureDevice, usize);

    impl<'a> Display for CaptureDeviceSelectOption<'a> {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "{} ({})", self.0.localized_name(), self.0.unique_id())
        }
    }

    impl AsRef<av::CaptureDevice> for CaptureDeviceSelectOption<'_> {
        fn as_ref(&self) -> &av::CaptureDevice {
            self.0
        }
    }

    impl Deref for CaptureDeviceSelectOption<'_> {
        type Target = av::CaptureDevice;

        fn deref(&self) -> &Self::Target {
            self.0
        }
    }
}
