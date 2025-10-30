use cap_recording::{
    CameraFeed,
    feeds::camera::{self, DeviceOrModelID},
};
use ffmpeg::format::Pixel;
use image::{ColorType, codecs::jpeg};
use kameo::Actor;
use std::fmt::Display;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let cameras = cap_camera::list_cameras().map(CameraSelection).collect();
    let device = inquire::Select::new("Select a device", cameras)
        .prompt()
        .unwrap();

    let feed = CameraFeed::spawn(CameraFeed::default());
    feed.ask(camera::SetInput {
        id: DeviceOrModelID::from_info(&device.0),
    })
    .await
    .unwrap()
    .await
    .unwrap();

    let (tx, rx) = flume::bounded(1);

    feed.ask(camera::AddSender(tx)).await.unwrap();

    let frame = rx.recv_async().await.unwrap().inner;
    frame.format();
    frame.width();
    frame.height();

    let mut converter = ffmpeg::software::converter(
        (frame.width(), frame.height()),
        frame.format(),
        Pixel::RGB24,
    )
    .unwrap();

    let mut converted_frame = ffmpeg::frame::Video::empty();
    converter.run(&frame, &mut converted_frame).unwrap();

    println!(
        "Converted frame data len: {}",
        converted_frame.data(0).len()
    );
    let mut file = std::fs::File::create("./out.jpeg").unwrap();
    jpeg::JpegEncoder::new(&mut file)
        .encode(
            &converted_frame.data(0)[0..(frame.width() * frame.height() * 3) as usize],
            frame.width(),
            frame.height(),
            ColorType::Rgb8.into(),
        )
        .unwrap();
}

struct CameraSelection(cap_camera::CameraInfo);

impl Display for CameraSelection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0.display_name())
    }
}
