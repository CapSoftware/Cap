use cap_media::{data::FFVideo, feeds::CameraFeed};
use ffmpeg::format::Pixel;
use image::{codecs::jpeg, ColorType};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let cameras = CameraFeed::list_cameras();
    let device = inquire::Select::new("Select a device", cameras)
        .prompt()
        .unwrap();

    let feed = CameraFeed::init(&device).await.unwrap();
    let (tx, rx) = flume::bounded(1);
    feed.attach(tx);
    let frame = rx.recv_async().await.unwrap().frame;
    dbg!(frame.format(), frame.width(), frame.height());

    let mut converter = ffmpeg::software::converter(
        (frame.width(), frame.height()),
        frame.format(),
        Pixel::RGB24,
    )
    .unwrap();

    let mut converted_frame = ffmpeg::frame::Video::empty();
    converter.run(&frame, &mut converted_frame).unwrap();

    dbg!(converted_frame.data(0).len());
    let mut file = std::fs::File::create("./out.jpeg").unwrap();
    jpeg::JpegEncoder::new(&mut file)
        .encode(
            converted_frame.data(0),
            frame.width(),
            frame.height(),
            ColorType::Rgb8.into(),
        )
        .unwrap();
}
