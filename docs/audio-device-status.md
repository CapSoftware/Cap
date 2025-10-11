# Current Audio Device Status

## System Audio Configuration (as of initial investigation)

### Polar 2 (BlackStar Audio Interface)
- **Status**: Default Input Device: Yes, Default Output Device: Yes
- **Current Sample Rate**: 48000 Hz (48 kHz)
- **Input Channels**: 4
- **Output Channels**: 4
- **Transport**: USB
- **Manufacturer**: Blackstar

### Insta360 Link 2 (Webcam with Microphone)
- **Current Sample Rate**: 48000 Hz (48 kHz)
- **Input Channels**: 1
- **Transport**: USB
- **Manufacturer**: Insta360

### Other Detected Audio Devices
- LG ULTRAWIDE (HDMI audio - 48 kHz)
- LEN T23i-20 (HDMI audio - 48 kHz)
- USB PnP Audio Device (2x devices - 48 kHz)
- Mac mini Speakers (Built-in - 48 kHz)

## Key Observations

1. ✅ **Both peripheral audio devices are at 48 kHz** - the standard sample rate
2. ✅ **No obvious sample rate mismatch at the system level**
3. 🤔 **Polar 2 is set as BOTH default input and output device**
4. 📝 **Multiple audio input sources available** - need to verify which Cap uses

## Implications for Investigation

Since both devices are at 48 kHz, the audio slowdown issue is likely NOT a simple system-level sample rate configuration problem. Possible causes to investigate:

### Hypothesis 1: Audio Metadata Misreading
- Cap may be incorrectly detecting or storing the audio sample rate
- Audio recorded at 48 kHz but metadata incorrectly labels it as different rate
- During export, encoder uses wrong metadata → incorrect playback

### Hypothesis 2: Timestamp/Clock Issues
- Audio frame timestamps may be incorrect during recording
- Could cause temporal misalignment during export
- Common with USB audio interfaces that don't sync perfectly with system clock

### Hypothesis 3: Buffer Size / Frame Rate Mismatch
- Recording buffer size not matching expected frame duration
- Could accumulate timing errors over the recording
- Would explain slow + pitch down symptoms

### Hypothesis 4: FFmpeg Encoding Parameters
- Export logic may have hard-coded assumptions about audio parameters
- Even if source is 48 kHz, export settings might be using different rate
- Need to check FFmpeg command-line arguments in export code

## Next Steps
1. ✅ Confirmed current sample rates (both at 48 kHz)
2. ⏳ Investigate Cap audio recording code (crates/recording/)
3. ⏳ Check export/encoding logic (crates/export/)
4. ⏳ Create test recording and analyze with ffprobe
5. ⏳ Look for timestamp handling and audio sync code
6. ⏳ Examine FFmpeg parameter generation for export

## Testing Strategy
Even though devices are at 48 kHz, still test with:
- 96 kHz setting (to rule out any dynamic rate switching)
- 192 kHz setting (extreme case)
- Monitor if sample rate changes during Cap recording session
