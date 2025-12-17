use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, mpsc},
};
use tokio::sync::oneshot;
use tracing::{debug, info, warn};
use windows::Win32::{Foundation::HANDLE, Graphics::Direct3D11::ID3D11Texture2D};

use super::{DecodedFrame, FRAME_CACHE_SIZE, VideoDecoderMessage};

#[derive(Clone)]
struct CachedFrame {
    number: u32,
    texture: ID3D11Texture2D,
    shared_handle: Option<HANDLE>,
    y_handle: Option<HANDLE>,
    uv_handle: Option<HANDLE>,
    nv12_data: Option<Arc<cap_video_decode::NV12Data>>,
    width: u32,
    height: u32,
}

impl CachedFrame {
    fn to_decoded_frame(&self) -> DecodedFrame {
        if let Some(nv12_data) = &self.nv12_data {
            DecodedFrame::new_nv12(
                nv12_data.data.clone(),
                self.width,
                self.height,
                nv12_data.y_stride,
                nv12_data.uv_stride,
            )
        } else {
            warn!(
                "CachedFrame has no CPU data, creating black frame (D3D11 zero-copy not implemented)"
            );
            let black_data = vec![0u8; (self.width * self.height * 3 / 2) as usize];
            DecodedFrame::new_nv12(black_data, self.width, self.height, self.width, self.width)
        }
    }
}

pub struct MFDecoder;

impl MFDecoder {
    pub fn spawn(
        name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<(), String>>,
    ) -> Result<(), String> {
        let (continue_tx, continue_rx) = mpsc::channel();

        std::thread::spawn(move || {
            let mut decoder = match cap_video_decode::MediaFoundationDecoder::new(&path) {
                Err(e) => {
                    let _ = continue_tx.send(Err(e));
                    return;
                }
                Ok(v) => {
                    info!(
                        "MediaFoundation decoder created for '{}': {}x{} @ {:?}fps",
                        name,
                        v.width(),
                        v.height(),
                        v.frame_rate()
                    );
                    let _ = continue_tx.send(Ok(()));
                    v
                }
            };

            let video_width = decoder.width();
            let video_height = decoder.height();

            let mut cache = BTreeMap::<u32, CachedFrame>::new();
            let mut last_decoded_frame: Option<u32> = None;

            let _ = ready_tx.send(Ok(()));

            while let Ok(r) = rx.recv() {
                match r {
                    VideoDecoderMessage::GetFrame(requested_time, sender) => {
                        if sender.is_closed() {
                            continue;
                        }

                        let requested_frame = (requested_time * fps as f32).floor() as u32;

                        if let Some(cached) = cache.get(&requested_frame) {
                            if sender.send(cached.to_decoded_frame()).is_err() {
                                warn!(
                                    "Failed to send cached frame {requested_frame}: receiver dropped"
                                );
                            }
                            continue;
                        }

                        let cache_min = requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 / 2);
                        let cache_max = requested_frame + FRAME_CACHE_SIZE as u32 / 2;

                        let needs_seek = last_decoded_frame
                            .map(|last| {
                                requested_frame < last
                                    || requested_frame.saturating_sub(last)
                                        > FRAME_CACHE_SIZE as u32
                            })
                            .unwrap_or(true);

                        if needs_seek {
                            debug!("MediaFoundation seeking to frame {requested_frame}");
                            let time_100ns = frame_to_100ns(requested_frame, fps);
                            if let Err(e) = decoder.seek(time_100ns) {
                                warn!("MediaFoundation seek failed: {e}");
                            }
                            cache.clear();
                            last_decoded_frame = None;
                        }

                        let mut sender = Some(sender);
                        let mut last_valid_frame: Option<CachedFrame> = None;

                        loop {
                            match decoder.read_sample() {
                                Ok(Some(mf_frame)) => {
                                    let frame_number = pts_100ns_to_frame(mf_frame.pts, fps);

                                    let nv12_data = match decoder.read_texture_to_cpu(
                                        &mf_frame.texture,
                                        mf_frame.width,
                                        mf_frame.height,
                                    ) {
                                        Ok(data) => {
                                            debug!(
                                                frame = frame_number,
                                                data_len = data.data.len(),
                                                y_stride = data.y_stride,
                                                uv_stride = data.uv_stride,
                                                width = mf_frame.width,
                                                height = mf_frame.height,
                                                "read_texture_to_cpu succeeded"
                                            );
                                            Some(Arc::new(data))
                                        }
                                        Err(e) => {
                                            warn!(
                                                "Failed to read texture to CPU for frame {frame_number}: {e}"
                                            );
                                            None
                                        }
                                    };

                                    let cached = CachedFrame {
                                        number: frame_number,
                                        texture: mf_frame.texture,
                                        shared_handle: mf_frame.shared_handle,
                                        y_handle: mf_frame.y_handle,
                                        uv_handle: mf_frame.uv_handle,
                                        nv12_data,
                                        width: mf_frame.width,
                                        height: mf_frame.height,
                                    };

                                    last_decoded_frame = Some(frame_number);

                                    if frame_number >= cache_min && frame_number <= cache_max {
                                        if cache.len() >= FRAME_CACHE_SIZE {
                                            let key_to_remove = if frame_number > requested_frame {
                                                *cache.keys().next().unwrap()
                                            } else {
                                                *cache.keys().next_back().unwrap()
                                            };
                                            cache.remove(&key_to_remove);
                                        }
                                        cache.insert(frame_number, cached.clone());
                                    }

                                    if frame_number <= requested_frame {
                                        last_valid_frame = Some(cached);
                                    }

                                    if frame_number >= requested_frame {
                                        let frame_to_send = if frame_number == requested_frame {
                                            cache.get(&requested_frame)
                                        } else {
                                            last_valid_frame
                                                .as_ref()
                                                .or_else(|| cache.get(&frame_number))
                                        };

                                        if let Some(frame) = frame_to_send {
                                            if let Some(s) = sender.take() {
                                                if s.send(frame.to_decoded_frame()).is_err() {
                                                    warn!(
                                                        "Failed to send frame {}: receiver dropped",
                                                        frame.number
                                                    );
                                                }
                                            }
                                        }
                                        break;
                                    }

                                    if frame_number > cache_max {
                                        break;
                                    }
                                }
                                Ok(None) => {
                                    debug!("MediaFoundation end of stream");
                                    break;
                                }
                                Err(e) => {
                                    warn!("MediaFoundation read_sample error: {e}");
                                    break;
                                }
                            }
                        }

                        if let Some(s) = sender.take() {
                            if let Some(frame) = last_valid_frame
                                .or_else(|| cache.values().max_by_key(|f| f.number).cloned())
                            {
                                if s.send(frame.to_decoded_frame()).is_err() {
                                    warn!("Failed to send fallback frame: receiver dropped");
                                }
                            } else {
                                debug!(
                                    "No frames available for request {requested_frame}, sending black frame"
                                );
                                let black_frame = DecodedFrame::new(
                                    vec![0u8; (video_width * video_height * 4) as usize],
                                    video_width,
                                    video_height,
                                );
                                if s.send(black_frame).is_err() {
                                    warn!("Failed to send black frame: receiver dropped");
                                }
                            }
                        }
                    }
                }
            }
        });

        continue_rx.recv().map_err(|e| e.to_string())??;

        Ok(())
    }
}

fn frame_to_100ns(frame: u32, fps: u32) -> i64 {
    ((frame as i64) * 10_000_000) / (fps as i64)
}

fn pts_100ns_to_frame(pts_100ns: i64, fps: u32) -> u32 {
    ((pts_100ns * fps as i64) / 10_000_000) as u32
}
