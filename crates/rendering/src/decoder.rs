use std::{
    num::NonZeroUsize,
    path::PathBuf,
    sync::{mpsc, Arc},
    thread,
};

use ffmpeg_next::{frame, rescale, Rational, Rescale};
use lru::LruCache;

pub type DecodedFrame = Arc<Vec<u8>>;

pub struct VideoDecoder {
    input: ffmpeg_next::format::context::Input,
    decoder: ffmpeg_next::codec::decoder::Video,
    scaler: ffmpeg_next::software::scaling::context::Context,
    input_stream_index: usize,
    temp_frame: ffmpeg_next::frame::Video,
    time_base: ffmpeg_next::Rational,
    frame_rate: ffmpeg_next::Rational,
    last_decoded_frame: Option<u32>,
    frame_cache: LruCache<u32, DecodedFrame>,
}

impl VideoDecoder {
    pub fn new(path: &PathBuf) -> Self {
        println!("creating decoder for {}", path.display());
        let ictx = ffmpeg_next::format::input(path).unwrap();

        let input_stream = ictx
            .streams()
            .best(ffmpeg_next::media::Type::Video)
            .ok_or("Could not find a video stream")
            .unwrap();
        let input_stream_index = input_stream.index();
        let time_base = input_stream.time_base();
        let frame_rate = input_stream.rate();

        // Create a decoder for the video stream
        let decoder =
            ffmpeg_next::codec::context::Context::from_parameters(input_stream.parameters())
                .unwrap()
                .decoder()
                .video()
                .unwrap();

        use ffmpeg_next::format::Pixel;
        use ffmpeg_next::software::scaling::{context::Context, flag::Flags};

        let scaler = Context::get(
            decoder.format(),
            decoder.width(),
            decoder.height(),
            Pixel::RGBA,
            decoder.width(),
            decoder.height(),
            Flags::BILINEAR,
        )
        .unwrap();

        Self {
            input: ictx,
            decoder,
            scaler,
            input_stream_index,
            temp_frame: ffmpeg_next::frame::Video::empty(),
            time_base,
            frame_rate,
            frame_cache: LruCache::new(NonZeroUsize::new(FRAME_CACHE_SIZE).unwrap()),
            last_decoded_frame: None,
        }
    }

    pub fn get_frame(&mut self, frame_number: u32) -> Option<DecodedFrame> {
        if let Some(frame) = self.frame_cache.get(&frame_number) {
            return Some(frame.clone());
        }

        if frame_number <= 0 || self.last_decoded_frame != Some(frame_number - 1) {
            let timestamp_us =
                ((frame_number as f32 / self.frame_rate.numerator() as f32) * 1_000_000.0) as i64;
            let position = timestamp_us.rescale((1, 1_000_000), rescale::TIME_BASE);

            println!("seeeking to {position} for frame {frame_number}");

            self.decoder.flush();
            self.input.seek(position, ..position).unwrap();
        }

        for (stream, packet) in self.input.packets() {
            if stream.index() == self.input_stream_index {
                let current_frame =
                    ts_to_frame(packet.pts().unwrap(), self.time_base, self.frame_rate);

                self.decoder.send_packet(&packet).unwrap();

                while self.decoder.receive_frame(&mut self.temp_frame).is_ok() {
                    // Convert the frame to RGB
                    let mut rgb_frame = frame::Video::empty();
                    self.scaler.run(&self.temp_frame, &mut rgb_frame).unwrap();

                    let frame = Arc::new(rgb_frame.data(0).to_vec());

                    self.last_decoded_frame = Some(current_frame);
                    self.frame_cache.put(current_frame, frame.clone());

                    if current_frame == frame_number {
                        return Some(frame);
                    }
                }
            }
        }

        None
    }
}

enum VideoDecoderActorMessage {
    GetFrame(u32, tokio::sync::oneshot::Sender<Option<Arc<Vec<u8>>>>),
}

#[derive(Clone)]
pub struct VideoDecoderActor {
    tx: mpsc::Sender<VideoDecoderActorMessage>,
}

impl VideoDecoderActor {
    pub fn new(path: PathBuf) -> Self {
        let (tx, rx) = mpsc::channel();

        thread::spawn(move || {
            let mut decoder = VideoDecoder::new(&path);

            loop {
                match rx.recv() {
                    Ok(VideoDecoderActorMessage::GetFrame(frame_number, sender)) => {
                        let frame = decoder.get_frame(frame_number);
                        sender.send(frame).ok();
                    }
                    Err(_) => break,
                }
            }
        });

        Self { tx }
    }

    pub async fn get_frame(&self, frame_number: u32) -> Option<Arc<Vec<u8>>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(VideoDecoderActorMessage::GetFrame(frame_number, tx))
            .unwrap();
        rx.await.unwrap()
    }
}

fn ts_to_frame(ts: i64, time_base: Rational, frame_rate: Rational) -> u32 {
    // dbg!((ts, time_base, frame_rate));
    ((ts * time_base.numerator() as i64 * frame_rate.numerator() as i64)
        / (time_base.denominator() as i64 * frame_rate.denominator() as i64)) as u32
}

const FRAME_CACHE_SIZE: usize = 50;

fn async_video_decoder(
    path: PathBuf,
    requests: std::sync::mpsc::Receiver<VideoDecoderActorMessage>,
) {
    std::thread::spawn(move || {
        let mut input = ffmpeg_next::format::input(&path).unwrap();

        let input_stream = input
            .streams()
            .best(ffmpeg_next::media::Type::Video)
            .ok_or("Could not find a video stream")
            .unwrap();
        let input_stream_index = input_stream.index();
        let time_base = input_stream.time_base();
        let frame_rate = input_stream.rate();

        // Create a decoder for the video stream
        let mut decoder =
            ffmpeg_next::codec::context::Context::from_parameters(input_stream.parameters())
                .unwrap()
                .decoder()
                .video()
                .unwrap();

        use ffmpeg_next::format::Pixel;
        use ffmpeg_next::software::scaling::{context::Context, flag::Flags};

        let mut scaler = Context::get(
            decoder.format(),
            decoder.width(),
            decoder.height(),
            Pixel::RGBA,
            decoder.width(),
            decoder.height(),
            Flags::BILINEAR,
        )
        .unwrap();

        let mut temp_frame = ffmpeg_next::frame::Video::empty();

        let mut frame_cache =
            LruCache::<u32, Arc<Vec<u8>>>::new(NonZeroUsize::new(FRAME_CACHE_SIZE).unwrap());

        let mut peekable_requests = PeekableReceiver {
            rx: requests,
            peeked: None,
        };

        while let Ok(r) = peekable_requests.recv() {
            match r {
                VideoDecoderActorMessage::GetFrame(frame_number, sender) => {
                    if let Some(frame) = frame_cache.get(&frame_number) {
                        sender.send(Some(frame.clone())).ok();
                        continue;
                    }

                    let mut sender = Some(sender);

                    for (stream, packet) in input.packets() {
                        if peekable_requests.peek().is_some() {
                            break;
                        }

                        if stream.index() == input_stream_index {
                            let current_frame =
                                ts_to_frame(packet.pts().unwrap(), time_base, frame_rate);

                            decoder.send_packet(&packet).unwrap();

                            if current_frame - frame_number >= FRAME_CACHE_SIZE as u32 / 2 {
                                break;
                            }

                            while decoder.receive_frame(&mut temp_frame).is_ok() {
                                let mut rgb_frame = frame::Video::empty();
                                scaler.run(&temp_frame, &mut rgb_frame).unwrap();

                                let frame = Arc::new(rgb_frame.data(0).to_vec());

                                frame_cache.put(current_frame, frame.clone());

                                if current_frame == frame_number {
                                    if let Some(sender) = sender.take() {
                                        sender.send(Some(frame)).ok();
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    });
}

struct PeekableReceiver<T> {
    rx: mpsc::Receiver<T>,
    peeked: Option<T>,
}

impl<T> PeekableReceiver<T> {
    fn peek(&mut self) -> Option<&T> {
        if self.peeked.is_some() {
            self.peeked.as_ref()
        } else {
            match self.rx.try_recv() {
                Ok(value) => {
                    self.peeked = Some(value);
                    self.peeked.as_ref()
                }
                Err(_) => None,
            }
        }
    }

    fn try_recv(&mut self) -> Result<T, mpsc::TryRecvError> {
        if let Some(value) = self.peeked.take() {
            Ok(value)
        } else {
            self.rx.try_recv()
        }
    }

    fn recv(&mut self) -> Result<T, mpsc::RecvError> {
        if let Some(value) = self.peeked.take() {
            Ok(value)
        } else {
            self.rx.recv()
        }
    }
}
