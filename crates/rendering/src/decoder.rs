use std::{
    collections::BTreeMap,
    num::NonZeroUsize,
    path::PathBuf,
    sync::{mpsc, Arc},
    thread,
};

use ffmpeg_next::{
    format::context::{input::PacketIter, Input},
    frame, rescale, Packet, Rational, Rescale, Stream,
};
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

pub struct AsyncVideoDecoder;

impl AsyncVideoDecoder {
    pub fn spawn(path: PathBuf) -> AsyncVideoDecoderHandle {
        let (tx, rx) = mpsc::channel();

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

            let render_more_margin = (FRAME_CACHE_SIZE / 4) as u32;

            let mut cache = BTreeMap::<u32, Arc<Vec<u8>>>::new();
            // active frame is a frame that triggered decode.
            // frames that are within render_more_margin of this frame won't trigger decode.
            let mut last_active_frame = None::<u32>;

            let mut last_decoded_frame = None::<u32>;

            struct PacketStuff<'a> {
                packets: PacketIter<'a>,
                skipped_packet: Option<(Stream<'a>, Packet)>,
            }

            let mut peekable_requests = PeekableReceiver { rx, peeked: None };

            let mut packet_stuff = PacketStuff {
                packets: input.packets(),
                skipped_packet: None,
            };

            while let Ok(r) = peekable_requests.recv() {
                match r {
                    VideoDecoderActorMessage::GetFrame(frame_number, sender) => {
                        println!("received request for frame {frame_number}");

                        let mut sender = if let Some(cached) = cache.get(&frame_number) {
                            sender.send(Some(cached.clone())).ok();
                            continue;
                        } else {
                            Some(sender)
                        };

                        // need to seek when frame_number is less than last_decoded_frame

                        let cache_min = frame_number
                            .checked_sub(FRAME_CACHE_SIZE as u32 / 2)
                            .unwrap_or(0);
                        let cache_max = frame_number + FRAME_CACHE_SIZE as u32 / 2;

                        // TODO: seek forward when last_decoded_frame's I-frame is previous to frame_number's I-frame
                        if frame_number <= 0
                            || last_decoded_frame
                                .map(|f| frame_number < f)
                                .unwrap_or(false)
                        {
                            dbg!(cache.keys().min(), cache.keys().max());
                            dbg!(cache.get(&frame_number).is_some());
                            dbg!((frame_number, last_decoded_frame));

                            let timestamp_us =
                                ((frame_number as f32 / frame_rate.numerator() as f32)
                                    * 1_000_000.0) as i64;
                            let position = timestamp_us.rescale((1, 1_000_000), rescale::TIME_BASE);

                            println!("seeking to {position} for frame {frame_number}");

                            drop(packet_stuff);

                            decoder.flush();
                            input.seek(position, ..position).unwrap();
                            cache.clear();
                            last_decoded_frame = None;

                            packet_stuff = PacketStuff {
                                packets: input.packets(),
                                skipped_packet: None,
                            };
                        }

                        last_active_frame = Some(frame_number);

                        loop {
                            let Some((stream, packet)) = packet_stuff
                                .skipped_packet
                                .take()
                                .or_else(|| packet_stuff.packets.next())
                            else {
                                break;
                            };

                            let current_frame =
                                ts_to_frame(packet.pts().unwrap(), time_base, frame_rate);

                            let too_great_for_cache_bounds = current_frame > cache_max;
                            let too_small_for_cache_bounds = current_frame < cache_min;

                            // if peekable_requests.peek().is_some() {
                            //     println!("skipping packet for frame {current_frame} as new request is available");
                            //     packet_stuff.skipped_packet = Some((stream, packet));

                            //     break;
                            // }

                            if stream.index() == input_stream_index {
                                if too_great_for_cache_bounds {
                                    // println!("skipping packet for frame {current_frame} as it's out of cache bounds");
                                    packet_stuff.skipped_packet = Some((stream, packet));
                                    break;
                                }

                                decoder.send_packet(&packet).unwrap();

                                last_decoded_frame = Some(current_frame);

                                while decoder.receive_frame(&mut temp_frame).is_ok() {
                                    println!(
                                        "decoded frame {current_frame}. will cache: {}",
                                        !too_great_for_cache_bounds && !too_small_for_cache_bounds
                                    );

                                    let mut rgb_frame = frame::Video::empty();
                                    scaler.run(&temp_frame, &mut rgb_frame).unwrap();

                                    let frame = Arc::new(rgb_frame.data(0).to_vec());

                                    if current_frame == frame_number {
                                        // println!("decoded frame {current_frame} for request {frame_number}");
                                        if let Some(sender) = sender.take() {
                                            // println!("sending frame {frame_number}");
                                            sender.send(Some(frame.clone())).ok();
                                        }
                                    }

                                    if !too_small_for_cache_bounds && !too_great_for_cache_bounds {
                                        if cache.len() >= FRAME_CACHE_SIZE {
                                            if let Some(last_active_frame) = &last_active_frame {
                                                let frame = if frame_number > *last_active_frame {
                                                    *cache.keys().next().unwrap()
                                                } else if frame_number < *last_active_frame {
                                                    *cache.keys().next_back().unwrap()
                                                } else {
                                                    let min = *cache.keys().min().unwrap();
                                                    let max = *cache.keys().max().unwrap();

                                                    if current_frame > max {
                                                        min
                                                    } else {
                                                        max
                                                    }
                                                };

                                                println!("removing frame {frame} from cache");
                                                cache.remove(&frame);
                                            } else {
                                                println!("clearing cache");
                                                cache.clear()
                                            }
                                        }

                                        println!("caching frame {current_frame}");
                                        cache.insert(current_frame, frame);
                                    }
                                }
                            }
                        }

                        if sender.is_some() {
                            println!("failed to send frame {frame_number}");
                        }
                    }
                }
            }
        });

        AsyncVideoDecoderHandle { sender: tx }
    }
}

#[derive(Clone)]
pub struct AsyncVideoDecoderHandle {
    sender: mpsc::Sender<VideoDecoderActorMessage>,
}

impl AsyncVideoDecoderHandle {
    pub async fn get_frame(&self, frame_number: u32) -> Option<Arc<Vec<u8>>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.sender
            .send(VideoDecoderActorMessage::GetFrame(frame_number, tx))
            .unwrap();
        rx.await.unwrap()
    }
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
        println!("try_recv");
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
