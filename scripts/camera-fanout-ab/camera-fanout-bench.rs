use cap_enc_ffmpeg::h264::H264Encoder;
use cap_media_info::{RawVideoFormat, VideoInfo};
use cap_recording::{
    FFmpegVideoFrame, VideoFrame,
    feeds::camera::{self, synthetic::SyntheticCamera},
};
use cap_timestamp::Timestamp;
use std::{
    io::Write,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const POOL: usize = 8;
const WARMUP: usize = 32;

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Touch,
    Raw,
    Preview,
    Encoder,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Touch => "touch",
            Kind::Raw => "raw",
            Kind::Preview => "preview",
            Kind::Encoder => "encoder",
        }
    }
}

struct Ack {
    index: i64,
    at: Instant,
    shared: bool,
    bytes: usize,
}

struct Report {
    kind: Kind,
    digests: Vec<(i64, u64)>,
    mismatches: usize,
}

fn visible(format: ffmpeg::format::Pixel, width: usize, height: usize, plane: usize) -> (usize, usize) {
    match format {
        ffmpeg::format::Pixel::NV12 if plane == 0 => (width, height),
        ffmpeg::format::Pixel::NV12 => (width, height / 2),
        ffmpeg::format::Pixel::BGRA => (width * 4, height),
        other => panic!("unexpected format {other:?}"),
    }
}

fn digest(frame: &ffmpeg::frame::Video) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for plane in 0..frame.planes() {
        let stride = frame.stride(plane);
        let (row, rows) = visible(
            frame.format(),
            frame.width() as usize,
            frame.height() as usize,
            plane,
        );
        let data = frame.data(plane);
        for y in 0..rows {
            for chunk in data[y * stride..y * stride + row].chunks(8) {
                let mut word = [0u8; 8];
                word[..chunk.len()].copy_from_slice(chunk);
                hash ^= u64::from_le_bytes(word);
                hash = hash.wrapping_mul(0x0100_0000_01b3);
            }
        }
    }
    hash
}

fn buffer_bytes(frame: &ffmpeg::frame::Video) -> usize {
    (0..frame.planes())
        .map(|plane| frame.data(plane).len())
        .sum()
}

fn pattern(width: u32, height: u32, seed: usize) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, width, height);
    for plane in 0..frame.planes() {
        let stride = frame.stride(plane);
        let (row, rows) = visible(frame.format(), width as usize, height as usize, plane);
        let data = frame.data_mut(plane);
        data.fill(0);
        for y in 0..rows {
            for x in 0..row {
                data[y * stride + x] = ((x * 3 + y * 5 + seed * 29 + plane * 71) & 0xff) as u8;
            }
        }
    }
    frame
}

fn rusage() -> libc::rusage {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    usage
}

fn cpu_micros(usage: &libc::rusage) -> i64 {
    let user = usage.ru_utime.tv_sec as i64 * 1_000_000 + usage.ru_utime.tv_usec as i64;
    let system = usage.ru_stime.tv_sec as i64 * 1_000_000 + usage.ru_stime.tv_usec as i64;
    user + system
}

fn spawn_consumer(
    kind: Kind,
    rx: flume::Receiver<FFmpegVideoFrame>,
    acks: flume::Sender<Ack>,
    pool: Arc<Vec<(usize, u64)>>,
    info: VideoInfo,
    mp4: PathBuf,
) -> std::thread::JoinHandle<Report> {
    std::thread::spawn(move || {
        let mut digests = Vec::new();
        let mut mismatches = 0;
        let mut scaler: Option<ffmpeg::software::scaling::Context> = None;
        let mut encoder = (kind == Kind::Encoder).then(|| {
            let mut output = ffmpeg::format::output(&mp4).expect("mp4 output");
            let encoder = H264Encoder::builder(info)
                .with_encoder_priority_override(&["libx264"])
                .build(&mut output)
                .expect("libx264 encoder");
            output.write_header().expect("mp4 header");
            (output, encoder)
        });
        while let Ok(frame) = rx.recv() {
            let index = frame.inner.pts().unwrap_or(-1);
            let (source, expected) = pool[index as usize % POOL];
            let shared = frame.inner.data(0).as_ptr() as usize == source;
            let bytes = buffer_bytes(&frame.inner);
            match kind {
                Kind::Touch => {
                    std::hint::black_box(frame.inner.data(0)[0]);
                }
                Kind::Raw => {
                    let value = digest(&frame.inner);
                    if value != expected {
                        mismatches += 1;
                    }
                    digests.push((index, value));
                }
                Kind::Preview => {
                    let context = scaler.get_or_insert_with(|| {
                        ffmpeg::software::scaling::Context::get(
                            frame.inner.format(),
                            frame.inner.width(),
                            frame.inner.height(),
                            ffmpeg::format::Pixel::BGRA,
                            frame.inner.width(),
                            frame.inner.height(),
                            ffmpeg::software::scaling::Flags::BILINEAR,
                        )
                        .expect("scaler")
                    });
                    let mut converted = ffmpeg::frame::Video::empty();
                    context.run(&frame.inner, &mut converted).expect("scale");
                    digests.push((index, digest(&converted)));
                }
                Kind::Encoder => {
                    let (output, encoder) = encoder.as_mut().expect("encoder");
                    digests.push((index, digest(&frame.inner)));
                    let timestamp = Duration::from_secs_f64(index as f64 / f64::from(info.fps()));
                    encoder
                        .queue_frame(frame.inner, timestamp, output)
                        .expect("encode");
                }
            }
            let _ = acks.send(Ack {
                index,
                at: Instant::now(),
                shared,
                bytes,
            });
        }
        if let Some((mut output, mut encoder)) = encoder {
            encoder.flush(&mut output).expect("flush");
            output.write_trailer().expect("trailer");
        }
        Report {
            kind,
            digests,
            mismatches,
        }
    })
}

fn percentile(sorted: &[Duration], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[rank].as_secs_f64() * 1e6
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    ffmpeg::init()?;
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 8,
        "usage: camera-fanout-bench <cpu|verify> <width> <height> <senders> <frames> <variant> <out_dir>"
    );
    let mode = args[1].as_str();
    let width: u32 = args[2].parse()?;
    let height: u32 = args[3].parse()?;
    let senders: usize = args[4].parse()?;
    let frames: usize = args[5].parse()?;
    let variant = args[6].clone();
    let out = PathBuf::from(&args[7]);
    std::fs::create_dir_all(&out)?;

    let kinds: Vec<Kind> = match mode {
        "cpu" => vec![Kind::Touch; senders],
        "verify" => vec![Kind::Raw, Kind::Encoder, Kind::Preview, Kind::Raw],
        other => anyhow::bail!("unknown mode {other}"),
    };

    let info = VideoInfo::from_raw(RawVideoFormat::Nv12, width, height, 30);
    let pool_frames: Vec<FFmpegVideoFrame> = (0..POOL)
        .map(|seed| FFmpegVideoFrame {
            inner: pattern(width, height, seed),
            timestamp: Timestamp::Instant(Instant::now()),
        })
        .collect();
    let pool = Arc::new(
        pool_frames
            .iter()
            .map(|frame| (frame.inner.data(0).as_ptr() as usize, digest(&frame.inner)))
            .collect::<Vec<_>>(),
    );

    let synthetic = SyntheticCamera::spawn("Cap Fanout Bench Camera", info);
    let lock = synthetic.lock().await?;
    let (ack_tx, ack_rx) = flume::unbounded::<Ack>();
    let mut consumers = Vec::new();
    let mut attached = Vec::new();
    for kind in &kinds {
        let (tx, rx) = flume::bounded(4);
        attached.push(tx.clone());
        lock.ask(camera::AddSender(tx))
            .await
            .map_err(|error| anyhow::anyhow!("add sender: {error}"))?;
        consumers.push(spawn_consumer(
            *kind,
            rx,
            ack_tx.clone(),
            pool.clone(),
            info,
            out.join(format!("{variant}-{width}x{height}.mp4")),
        ));
    }
    drop(ack_tx);

    let total = WARMUP + frames;
    let mut latencies = Vec::with_capacity(frames);
    let mut shared = 0usize;
    let mut copied = 0usize;
    let mut copied_bytes = 0usize;
    let mut start_usage = rusage();
    let mut started = Instant::now();
    for index in 0..total {
        if index == WARMUP {
            start_usage = rusage();
            started = Instant::now();
        }
        let mut frame = pool_frames[index % POOL]
            .duplicate()
            .expect("reference-counted pool frame");
        frame.inner.set_pts(Some(index as i64));
        frame.timestamp = Timestamp::Instant(Instant::now());
        let pushed = Instant::now();
        synthetic.push(frame).await;
        let mut last = pushed;
        for _ in 0..kinds.len() {
            let ack = tokio::time::timeout(Duration::from_secs(10), ack_rx.recv_async())
                .await
                .map_err(|_| anyhow::anyhow!("frame {index} was not delivered to every sender"))??;
            anyhow::ensure!(ack.index == index as i64, "out of order frame {}", ack.index);
            last = last.max(ack.at);
            if index >= WARMUP {
                if ack.shared {
                    shared += 1;
                } else {
                    copied += 1;
                    copied_bytes += ack.bytes;
                }
            }
        }
        if index >= WARMUP {
            latencies.push(last - pushed);
        }
    }
    let elapsed = started.elapsed();
    let end_usage = rusage();

    for tx in attached {
        lock.ask(camera::RemoveSender(tx))
            .await
            .map_err(|error| anyhow::anyhow!("remove sender: {error}"))?;
    }
    let reports: Vec<Report> = consumers
        .into_iter()
        .map(|consumer| consumer.join().expect("consumer"))
        .collect();

    latencies.sort();
    let measured = frames as f64;
    let cpu = (cpu_micros(&end_usage) - cpu_micros(&start_usage)) as f64;
    let minflt = (end_usage.ru_minflt - start_usage.ru_minflt) as f64;
    let mismatches: usize = reports.iter().map(|report| report.mismatches).sum();
    let line = format!(
        "RESULT variant={variant} mode={mode} res={width}x{height} senders={} frames={frames} fanout_p50_us={:.1} fanout_p95_us={:.1} fanout_mean_us={:.1} cpu_us_per_frame={:.1} minflt_per_frame={:.1} copied_receipts={copied} shared_receipts={shared} copied_mb_per_frame={:.3} maxrss_mb={:.1} wall_ms={:.0} digest_mismatches={mismatches}",
        kinds.len(),
        percentile(&latencies, 0.5),
        percentile(&latencies, 0.95),
        latencies.iter().map(Duration::as_secs_f64).sum::<f64>() * 1e6 / measured,
        cpu / measured,
        minflt / measured,
        copied_bytes as f64 / measured / 1e6,
        end_usage.ru_maxrss as f64 / 1024.0,
        elapsed.as_secs_f64() * 1e3,
    );
    println!("{line}");

    if mode == "verify" {
        let mut file = std::fs::File::create(out.join(format!("{variant}-{width}x{height}-digests.txt")))?;
        for (position, report) in reports.iter().enumerate() {
            for (index, value) in &report.digests {
                writeln!(file, "{position} {} {index} {value:016x}", report.kind.name())?;
            }
        }
        anyhow::ensure!(mismatches == 0, "{mismatches} frames differed from their source");
    }

    Ok(())
}
