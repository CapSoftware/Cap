"""Scratch DIAG patch for the encfail run (never pushed to a PR branch).

Inert unless CAP_DIAG_FAIL_HW_ENCODE_AT_FRAME=N is set. With it set, from the Nth encode call made on a hardware H264
encoder onwards, H264Encoder::queue_frame_to returns an Encode error before handing the frame to the codec, the way a
dead hardware encoder fails every call. Software encoders are never failed, so once the product's own fallback has
replaced the hardware encoder with libx264 the errors stop.

It touches only the start of H264Encoder::queue_frame_to plus one new private function. It does not touch
replace_with_software, install_software, recover_from_codec_failure, CodecFailureHistory or any fallback decision.
"""
import sys

path = sys.argv[1] + "/crates/enc-ffmpeg/src/video/h264.rs"
s = open(path).read()

anchor = """        #[cfg(test)]
        if let Some(error) = self.injected_codec_failure() {
            return Err(QueueFrameError::Encode(error));
        }
"""
assert s.count(anchor) >= 1, "anchor not found"
i = s.index("    pub fn queue_frame_to<S: PacketSink + ?Sized>(")
j = s.index(anchor, i)
s = s[:j] + anchor + """        if self.is_hardware() && diag_forced_hardware_encode_failure() {
            return Err(QueueFrameError::Encode(ffmpeg::Error::Other {
                errno: ffmpeg::error::EIO,
            }));
        }
""" + s[j + len(anchor):]

s += """
fn diag_forced_hardware_encode_failure() -> bool {
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicU64, Ordering};
    static AT: OnceLock<Option<u64>> = OnceLock::new();
    static CALLS: AtomicU64 = AtomicU64::new(0);
    let Some(at) = *AT.get_or_init(|| {
        std::env::var("CAP_DIAG_FAIL_HW_ENCODE_AT_FRAME")
            .ok()
            .and_then(|value| value.parse().ok())
    }) else {
        return false;
    };
    let call = CALLS.fetch_add(1, Ordering::Relaxed);
    if call == at {
        tracing::warn!(call, "DIAG: forcing hardware encode failures from here on");
    }
    call >= at
}
"""
open(path, "w").write(s)
print("patched", path)
