use crate::{
    output_pipeline::{AudioFrame, AudioMuxer, Muxer, TaskPool, VideoMuxer},
    sources::screen_capture,
};
use anyhow::{Context, anyhow};
use cap_enc_avfoundation::QueueFrameError;
use cap_enc_ffmpeg::{aac::AACEncoder, h264::H264Encoder};
use cap_media_info::{AudioInfo, VideoInfo};
use cidre::cv::{self, pixel_buffer::LockFlags};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool},
    time::Duration,
};

#[derive(Clone)]
pub struct AVFoundationMp4Muxer(
    Arc<Mutex<cap_enc_avfoundation::MP4Encoder>>,
    Arc<AtomicBool>,
);

impl AVFoundationMp4Muxer {
    const MAX_QUEUE_RETRIES: u32 = 500;
}

#[derive(Default)]
pub struct AVFoundationMp4MuxerConfig {
    pub output_height: Option<u32>,
}

impl Muxer for AVFoundationMp4Muxer {
    type Config = AVFoundationMp4MuxerConfig;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        pause_flag: Arc<AtomicBool>,
        _tasks: &mut TaskPool,
    ) -> anyhow::Result<Self> {
        let video_config =
            video_config.ok_or_else(|| anyhow!("Invariant: No video source provided"))?;

        Ok(Self(
            Arc::new(Mutex::new(
                cap_enc_avfoundation::MP4Encoder::init(
                    output_path,
                    video_config,
                    audio_config,
                    config.output_height,
                )
                .map_err(|e| anyhow!("{e}"))?,
            )),
            pause_flag,
        ))
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        Ok(self
            .0
            .lock()
            .map_err(|e| anyhow!("{e}"))?
            .finish(Some(timestamp))
            .map(Ok)?)
    }
}

impl VideoMuxer for AVFoundationMp4Muxer {
    type VideoFrame = screen_capture::VideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        let mut mp4 = self.0.lock().map_err(|e| anyhow!("MuxerLock/{e}"))?;

        if self.1.load(std::sync::atomic::Ordering::Relaxed) {
            mp4.pause();
        } else {
            mp4.resume();
        }

        let mut retry_count = 0;
        loop {
            match mp4.queue_video_frame(frame.sample_buf.clone(), timestamp) {
                Ok(()) => break,
                Err(QueueFrameError::NotReadyForMore) => {
                    retry_count += 1;
                    if retry_count >= Self::MAX_QUEUE_RETRIES {
                        return Err(anyhow!(
                            "send_video_frame/timeout after {} retries",
                            Self::MAX_QUEUE_RETRIES
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(e) => return Err(anyhow!("send_video_frame/{e}")),
            }
        }

        Ok(())
    }
}

impl AudioMuxer for AVFoundationMp4Muxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        let mut mp4 = self.0.lock().map_err(|e| anyhow!("{e}"))?;

        loop {
            match mp4.queue_audio_frame(&frame.inner, timestamp) {
                Ok(()) => break,
                Err(QueueFrameError::NotReadyForMore) => {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(e) => return Err(anyhow!("send_audio_frame/{e}")),
            }
        }

        Ok(())
    }
}

pub struct FragmentedMp4MuxerMacOS {
    output: ffmpeg::format::context::Output,
    video_encoder: Option<H264Encoder>,
    audio_encoder: Option<AACEncoder>,
}

impl Muxer for FragmentedMp4MuxerMacOS {
    type Config = ();

    async fn setup(
        _: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        _pause_flag: Arc<AtomicBool>,
        _tasks: &mut TaskPool,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let mut output = ffmpeg::format::output(&output_path)?;

        let video_encoder = video_config
            .map(|video_config| H264Encoder::builder(video_config).build(&mut output))
            .transpose()
            .context("video encoder")?;

        let audio_encoder = audio_config
            .map(|config| AACEncoder::init(config, &mut output))
            .transpose()
            .context("audio encoder")?;

        let mut opts = ffmpeg::Dictionary::new();
        opts.set("movflags", "frag_keyframe+empty_moov+default_base_moof");
        opts.set("frag_duration", "1000000");

        output.write_header_with(opts)?;

        Ok(Self {
            output,
            video_encoder,
            audio_encoder,
        })
    }

    fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
        let video_result = self
            .video_encoder
            .as_mut()
            .map(|enc| enc.flush(&mut self.output))
            .unwrap_or(Ok(()));

        let audio_result = self
            .audio_encoder
            .as_mut()
            .map(|enc| enc.flush(&mut self.output))
            .unwrap_or(Ok(()));

        self.output.write_trailer().context("write_trailer")?;

        if video_result.is_ok() && audio_result.is_ok() {
            return Ok(Ok(()));
        }

        Ok(Err(anyhow!(
            "Video: {video_result:#?}, Audio: {audio_result:#?}"
        )))
    }
}

fn sample_buf_to_ffmpeg(sample_buf: &cidre::cm::SampleBuf) -> anyhow::Result<ffmpeg::frame::Video> {
    let image_buf = sample_buf
        .image_buf()
        .ok_or_else(|| anyhow!("No image buffer in sample"))?;

    let width = image_buf.width();
    let height = image_buf.height();

    let mut image_buf_mut = image_buf.retained();
    unsafe { image_buf_mut.lock_base_addr(LockFlags::READ_ONLY) }
        .result()
        .map_err(|e| anyhow!("Failed to lock base addr: {e:?}"))?;

    let result = match image_buf.pixel_format() {
        cv::PixelFormat::_420V => {
            let mut ff_frame =
                ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, width as u32, height as u32);

            let src_stride = image_buf.plane_bytes_per_row(0);
            let dest_stride = ff_frame.stride(0);
            let src_bytes = unsafe {
                std::slice::from_raw_parts(
                    image_buf.plane_base_address(0),
                    src_stride * image_buf.plane_height(0),
                )
            };
            let dest_bytes = ff_frame.data_mut(0);

            for y in 0..height {
                let row_width = width;
                let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];
                dest_row.copy_from_slice(src_row);
            }

            let src_stride = image_buf.plane_bytes_per_row(1);
            let dest_stride = ff_frame.stride(1);
            let src_bytes = unsafe {
                std::slice::from_raw_parts(
                    image_buf.plane_base_address(1),
                    src_stride * image_buf.plane_height(1),
                )
            };
            let dest_bytes = ff_frame.data_mut(1);

            for y in 0..height / 2 {
                let row_width = width;
                let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];
                dest_row.copy_from_slice(src_row);
            }

            Ok(ff_frame)
        }
        cv::PixelFormat::_32_BGRA => {
            let mut ff_frame =
                ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, width as u32, height as u32);

            let src_stride = image_buf.plane_bytes_per_row(0);
            let dest_stride = ff_frame.stride(0);
            let src_bytes = unsafe {
                std::slice::from_raw_parts(
                    image_buf.plane_base_address(0),
                    src_stride * image_buf.plane_height(0),
                )
            };
            let dest_bytes = ff_frame.data_mut(0);

            for y in 0..height {
                let row_width = width * 4;
                let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];
                dest_row.copy_from_slice(src_row);
            }

            Ok(ff_frame)
        }
        format => Err(anyhow!("Unsupported pixel format: {:?}", format)),
    };

    unsafe { image_buf_mut.unlock_lock_base_addr(LockFlags::READ_ONLY) }
        .result()
        .ok();

    result
}

impl VideoMuxer for FragmentedMp4MuxerMacOS {
    type VideoFrame = screen_capture::VideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        if let Some(video_encoder) = self.video_encoder.as_mut() {
            let ff_frame = sample_buf_to_ffmpeg(&frame.sample_buf)?;
            video_encoder.queue_frame(ff_frame, timestamp, &mut self.output)?;
        }

        Ok(())
    }
}

impl AudioMuxer for FragmentedMp4MuxerMacOS {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        if let Some(audio_encoder) = self.audio_encoder.as_mut() {
            audio_encoder.send_frame(frame.inner, timestamp, &mut self.output)?;
        }

        Ok(())
    }
}
