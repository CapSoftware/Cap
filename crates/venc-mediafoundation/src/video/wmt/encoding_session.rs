use std::{thread::JoinHandle, time::Duration};

use windows::{
    Foundation::{TimeSpan, TypedEventHandler},
    Graphics::{
        Capture::{GraphicsCaptureItem, GraphicsCaptureSession},
        SizeInt32,
    },
    Media::{
        Core::{
            MediaStreamSample, MediaStreamSource, MediaStreamSourceSampleRequest,
            MediaStreamSourceSampleRequestedEventArgs, MediaStreamSourceStartingEventArgs,
            VideoStreamDescriptor,
        },
        MediaProperties::{MediaEncodingProfile, MediaEncodingSubtypes, VideoEncodingProperties},
        Transcoding::MediaTranscoder,
    },
    Storage::Streams::IRandomAccessStream,
    Win32::{
        Foundation::E_UNEXPECTED,
        Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D},
    },
    core::{Result, h},
};

use crate::{
    capture::CaptureFrameGeneratorStopSignal,
    d3d::create_direct3d_surface,
    video::{
        encoding_session::{VideoEncoderSessionFactory, VideoEncodingSession},
        util::ensure_even_size,
    },
};

use super::sample_generator::SampleGenerator;

pub struct WMTVideoEncodingSessionFactory {}

impl WMTVideoEncodingSessionFactory {
    pub fn new() -> Self {
        Self {}
    }
}

impl VideoEncoderSessionFactory for WMTVideoEncodingSessionFactory {
    fn create_session(
        &self,
        d3d_device: ID3D11Device,
        item: GraphicsCaptureItem,
        borderless: bool,
        resolution: SizeInt32,
        bit_rate: u32,
        frame_rate: u32,
        stream: IRandomAccessStream,
    ) -> Result<Box<dyn VideoEncodingSession>> {
        Ok(Box::new(WMTVideoEncodingSession::new(
            d3d_device, item, borderless, resolution, bit_rate, frame_rate, stream,
        )?))
    }
}

struct WMTVideoEncodingSession {
    stream: IRandomAccessStream,
    encoding_profile: MediaEncodingProfile,
    stream_source: MediaStreamSource,
    transcoder: MediaTranscoder,

    capture_session: GraphicsCaptureSession,
    encoder_thread: Option<JoinHandle<Result<()>>>,
    stop_signal: CaptureFrameGeneratorStopSignal,
}

impl WMTVideoEncodingSession {
    pub fn new(
        d3d_device: ID3D11Device,
        item: GraphicsCaptureItem,
        borderless: bool,
        resolution: SizeInt32,
        bit_rate: u32,
        frame_rate: u32,
        stream: IRandomAccessStream,
    ) -> Result<Self> {
        let item_size = item.Size()?;
        let input_size = ensure_even_size(item_size);
        let output_size = ensure_even_size(resolution);

        // Describe our output: H264 video with an MP4 container
        let encoding_profile = {
            let profile = MediaEncodingProfile::new()?;
            profile.Container()?.SetSubtype(h!("MPEG4"))?;
            let video = profile.Video()?;
            video.SetSubtype(h!("H264"))?;
            video.SetWidth(output_size.Width as u32)?;
            video.SetHeight(output_size.Height as u32)?;
            video.SetBitrate(bit_rate)?;
            video.FrameRate()?.SetNumerator(frame_rate)?;
            video.FrameRate()?.SetDenominator(1)?;
            video.PixelAspectRatio()?.SetNumerator(1)?;
            video.PixelAspectRatio()?.SetDenominator(1)?;
            profile.SetVideo(&video)?;
            profile
        };

        // Describe our input: uncompressed BGRA8 buffers
        let properties = VideoEncodingProperties::CreateUncompressed(
            &MediaEncodingSubtypes::Bgra8()?,
            input_size.Width as u32,
            input_size.Height as u32,
        )?;
        let video_descriptor = VideoStreamDescriptor::Create(&properties)?;

        let mut sample_generator = SampleGenerator::new(d3d_device, item, input_size, output_size)?;
        let stop_signal = sample_generator.stop_signal();
        let mut first_timestamp: Option<TimeSpan> = None;
        let capture_session = sample_generator.capture_session().clone();
        if borderless {
            capture_session.SetIsBorderRequired(false)?;
        }

        let stream_source = MediaStreamSource::CreateFromDescriptor(&video_descriptor)?;
        stream_source.SetBufferTime(Duration::from_secs(0).into())?;
        stream_source.Starting(&TypedEventHandler::<
            MediaStreamSource,
            MediaStreamSourceStartingEventArgs,
        >::new(move |_, args| {
            let args = args.as_ref().unwrap();
            args.Request()?
                .SetActualStartPosition(Duration::from_secs(0).into())?;
            Ok(())
        }))?;
        stream_source.SampleRequested(&TypedEventHandler::<
            MediaStreamSource,
            MediaStreamSourceSampleRequestedEventArgs,
        >::new(move |_, args| {
            let args = args.as_ref().unwrap();
            let request = args.Request()?;
            let mut handler = |request: &MediaStreamSourceSampleRequest,
                               generator: &mut SampleGenerator|
             -> Result<()> {
                if let Some(input) = generator.generate()? {
                    let timestamp = if let Some(first_timestamp) = first_timestamp.as_ref() {
                        TimeSpan {
                            Duration: input.timestamp.Duration - first_timestamp.Duration,
                        }
                    } else {
                        first_timestamp = Some(input.timestamp);
                        TimeSpan { Duration: 0 }
                    };
                    let surface = create_direct3d_surface(&input.texture)?;
                    let sample =
                        MediaStreamSample::CreateFromDirect3D11Surface(&surface, timestamp)?;
                    request.SetSample(&sample)?;
                } else {
                    request.SetSample(None)?;
                }
                Ok(())
            };
            let result = handler(&request, &mut sample_generator);
            if result.is_err() {
                println!("Error during sample generation: {:?}", result);
                request.SetSample(None)?;
            }
            Ok(())
        }))?;

        let transcoder = MediaTranscoder::new()?;
        transcoder.SetHardwareAccelerationEnabled(true)?;

        Ok(Self {
            stream,
            encoding_profile,
            stream_source,
            transcoder,

            capture_session,
            encoder_thread: None,
            stop_signal,
        })
    }
}

unsafe impl Send for TranscoderSession {}
struct TranscoderSession {
    profile: MediaEncodingProfile,
    stream: IRandomAccessStream,
    stream_source: MediaStreamSource,
    transcoder: MediaTranscoder,
}

impl TranscoderSession {
    pub fn new(
        profile: MediaEncodingProfile,
        stream: IRandomAccessStream,
        stream_source: MediaStreamSource,
        transcoder: MediaTranscoder,
    ) -> Self {
        Self {
            profile,
            stream,
            stream_source,
            transcoder,
        }
    }

    pub fn start(&self) -> Result<()> {
        let transcode = self
            .transcoder
            .PrepareMediaStreamSourceTranscodeAsync(
                &self.stream_source,
                &self.stream,
                &self.profile,
            )?
            .get()?;
        transcode.TranscodeAsync()?.get()?;
        Ok(())
    }
}

impl VideoEncodingSession for WMTVideoEncodingSession {
    fn start(&mut self) -> Result<()> {
        if self.encoder_thread.is_none() {
            let profile = self.encoding_profile.clone();
            let stream = self.stream.clone();
            let stream_source = self.stream_source.clone();
            let transcoder = self.transcoder.clone();
            let session = TranscoderSession::new(profile, stream, stream_source, transcoder);
            self.capture_session.StartCapture()?;
            self.encoder_thread = Some({
                let result = std::thread::Builder::new()
                    .name("Encoder Thread".to_owned())
                    .spawn(move || -> Result<()> {
                        session.start()?;
                        Ok(())
                    });
                match result {
                    Ok(handle) => handle,
                    Err(_) => {
                        return Err(windows::core::Error::new(
                            E_UNEXPECTED,
                            "Unable to create the encoder thread!",
                        ));
                    }
                }
            });
        }
        Ok(())
    }

    fn stop(&mut self) -> Result<()> {
        if let Some(encoder_thread) = self.encoder_thread.take() {
            self.capture_session.Close()?;
            self.stop_signal.signal();
            match encoder_thread.join() {
                Ok(result) => result,
                Err(_) => Err(windows::core::Error::new(
                    E_UNEXPECTED,
                    "Encoder thread failed unexpectedly!",
                )),
            }
        } else {
            Ok(())
        }
    }
}

pub struct VideoEncoderInputSample {
    timestamp: TimeSpan,
    texture: ID3D11Texture2D,
}

impl VideoEncoderInputSample {
    pub fn new(timestamp: TimeSpan, texture: ID3D11Texture2D) -> Self {
        Self { timestamp, texture }
    }
}
