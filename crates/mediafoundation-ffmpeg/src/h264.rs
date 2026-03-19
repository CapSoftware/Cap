use cap_mediafoundation_utils::*;
use ffmpeg::{Rational, ffi::av_rescale_q, packet};
use std::ffi::CString;
use tracing::*;
use windows::Win32::Media::MediaFoundation::{IMFSample, MFSampleExtension_CleanPoint};

#[derive(Clone, Debug)]
pub struct MuxerConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    pub fragmented: bool,
    pub frag_duration_us: i64,
}

impl Default for MuxerConfig {
    fn default() -> Self {
        Self {
            width: 0,
            height: 0,
            fps: 30,
            bitrate: 0,
            fragmented: false,
            frag_duration_us: 2_000_000,
        }
    }
}

pub struct H264StreamMuxer {
    stream_index: usize,
    time_base: ffmpeg::Rational,
    is_finished: bool,
    frame_count: u64,
}

impl H264StreamMuxer {
    pub fn new(
        output: &mut ffmpeg::format::context::Output,
        config: MuxerConfig,
    ) -> Result<Self, ffmpeg::Error> {
        info!("Adding H264 stream to output context");

        let h264_codec = ffmpeg::codec::decoder::find(ffmpeg::codec::Id::H264)
            .ok_or(ffmpeg::Error::DecoderNotFound)?;

        let mut stream = output.add_stream(h264_codec)?;
        let stream_index = stream.index();

        let time_base = ffmpeg::Rational::new(1, config.fps as i32 * 1000);
        stream.set_time_base(time_base);

        unsafe {
            let codecpar = (*stream.as_mut_ptr()).codecpar;
            (*codecpar).codec_type = ffmpeg::ffi::AVMediaType::AVMEDIA_TYPE_VIDEO;
            (*codecpar).codec_id = ffmpeg::ffi::AVCodecID::AV_CODEC_ID_H264;
            (*codecpar).width = config.width as i32;
            (*codecpar).height = config.height as i32;
            (*codecpar).bit_rate = config.bitrate as i64;
            (*codecpar).format = ffmpeg::ffi::AVPixelFormat::AV_PIX_FMT_NV12 as i32;

            (*stream.as_mut_ptr()).avg_frame_rate = ffmpeg::ffi::AVRational {
                num: config.fps as i32,
                den: 1,
            };
            (*stream.as_mut_ptr()).r_frame_rate = ffmpeg::ffi::AVRational {
                num: config.fps as i32,
                den: 1,
            };
        }

        info!(
            "H264 stream added: {}x{} @ {} fps, {} kbps, fragmented={}",
            config.width,
            config.height,
            config.fps,
            config.bitrate / 1000,
            config.fragmented
        );

        Ok(Self {
            stream_index,
            time_base,
            is_finished: false,
            frame_count: 0,
        })
    }

    pub fn write_sample(
        &mut self,
        sample: &IMFSample,
        output: &mut ffmpeg::format::context::Output,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if self.is_finished {
            return Err("Muxer is already finished".into());
        }

        let mut packet = self.mf_sample_to_avpacket(sample)?;

        packet.rescale_ts(
            self.time_base,
            output.stream(self.stream_index).unwrap().time_base(),
        );

        packet.write_interleaved(output)?;

        Ok(())
    }

    fn mf_sample_to_avpacket(&self, sample: &IMFSample) -> windows::core::Result<ffmpeg::Packet> {
        let len = unsafe { sample.GetTotalLength()? };
        let mut packet = ffmpeg::Packet::new(len as usize);

        {
            let buffer = unsafe { sample.ConvertToContiguousBuffer()? };
            let data = buffer.lock()?;

            packet
                .data_mut()
                .unwrap()
                .copy_from_slice(&data[0..len as usize]);
        }

        let pts = unsafe { sample.GetSampleTime() }
            .ok()
            .map(|v| mf_from_mf_time(self.time_base, v));
        packet.set_pts(pts);
        packet.set_dts(pts);

        let duration = unsafe { sample.GetSampleDuration() }
            .ok()
            .map(|v| mf_from_mf_time(self.time_base, v))
            .unwrap_or_default();
        packet.set_duration(duration);

        if let Ok(t) = unsafe { sample.GetUINT32(&MFSampleExtension_CleanPoint) }
            && t != 0
        {
            packet.set_flags(packet::Flags::KEY);
        }

        packet.set_stream(self.stream_index);

        Ok(packet)
    }

    pub fn finish(&mut self) -> Result<(), ffmpeg::Error> {
        if self.is_finished {
            return Ok(());
        }

        self.is_finished = true;

        info!("Finishing H264 muxer, wrote {} frames", self.frame_count);

        Ok(())
    }

    pub fn frame_count(&self) -> u64 {
        self.frame_count
    }

    pub fn is_finished(&self) -> bool {
        self.is_finished
    }
}

const MF_TIMEBASE: ffmpeg::Rational = ffmpeg::Rational(1, 10_000_000);

fn mf_from_mf_time(tb: Rational, stime: i64) -> i64 {
    unsafe { av_rescale_q(stime, MF_TIMEBASE.into(), tb.into()) }
}

pub fn set_fragmented_mp4_options(
    output: &mut ffmpeg::format::context::Output,
    frag_duration_us: i64,
) -> Result<(), ffmpeg::Error> {
    unsafe {
        let ctx = output.as_mut_ptr();

        let movflags_key = CString::new("movflags").unwrap();
        let movflags_val = CString::new("frag_keyframe+empty_moov+default_base_moof").unwrap();

        let ret = ffmpeg::ffi::av_opt_set(
            (*ctx).priv_data,
            movflags_key.as_ptr(),
            movflags_val.as_ptr(),
            0,
        );
        if ret < 0 {
            warn!("Failed to set movflags: {}", ret);
        }

        let frag_duration_key = CString::new("frag_duration").unwrap();
        let frag_duration_val = CString::new(frag_duration_us.to_string()).unwrap();

        let ret = ffmpeg::ffi::av_opt_set(
            (*ctx).priv_data,
            frag_duration_key.as_ptr(),
            frag_duration_val.as_ptr(),
            0,
        );
        if ret < 0 {
            warn!("Failed to set frag_duration: {}", ret);
        }

        info!(
            "Set fMP4 options: movflags=frag_keyframe+empty_moov+default_base_moof, frag_duration={}us",
            frag_duration_us
        );
    }

    Ok(())
}
