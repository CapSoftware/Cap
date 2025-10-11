# Hardware Specifications - Audio Bug Investigation

This document details the hardware specifications for the peripheral devices being used on the Mac Mini where audio export issues occur.

## Problem Configuration (Mac Mini)

### RODE PodMic - Microphone
- **Type**: Dynamic broadcast microphone (analog XLR output)
- **Frequency Response**: 20 Hz - 20 kHz
- **Output**: XLR analog signal (no digital sample rate)
- **Sensitivity**: -57 dB re 1 Volt/Pascal (1.60mV @ 94 dB SPL) ± 2 dB @ 1kHz
- **Output Impedance**: 320 Ω
- **Connection**: XLR cable to BlackStar Polar 2 audio interface
- **Notes**:
  - Analog microphone - sample rate is determined by the audio interface
  - Tailored frequency response for speech and broadcast applications
  - Not a USB microphone - requires audio interface

### BlackStar Polar 2 - Audio Interface
- **Type**: 2-channel USB audio interface
- **A/D Conversion**: 24-bit / up to 192kHz
- **Supported Sample Rates**:
  - 44.1 kHz
  - 48 kHz
  - 88.2 kHz
  - 96 kHz
  - 176.4 kHz
  - **192 kHz** (maximum)
- **Input Channels**: 2 high headroom FET inputs
- **Connection**: USB to Mac Mini (class-compliant, no drivers needed)
- **Platform Support**: macOS, Windows, iOS (with adapters), Android (with adapters)
- **Notes**:
  - Class-compliant interface (works without drivers on macOS)
  - Can operate at multiple sample rates - configured in macOS Audio MIDI Setup
  - **CRITICAL**: Current configured sample rate unknown - needs verification

### Insta360 Link 2 - Webcam
- **Type**: 4K PTZ webcam with built-in microphone
- **Video**: 4K resolution, 1/2" sensor
- **Audio**:
  - AI noise-canceling microphone
  - Pickup range: up to 3 meters (optimal within 1.5m)
  - Three audio modes: Voice Focus, Voice Suppression, Music Balance
  - **Sample Rate**: Not officially documented (likely 48 kHz based on industry standard)
- **Connection**: USB to Mac Mini
- **Notes**:
  - Built-in microphone may have different sample rate than BlackStar Polar 2
  - If both audio sources are being used, potential for sample rate conflicts

## Working Configuration (MacBook Air)
- **Camera**: Built-in FaceTime HD camera
- **Microphone**: Built-in microphone
- **Audio Interface**: Internal (Apple T2/M1/M2 chip)
- **Sample Rate**: Likely standardized at 48 kHz
- **Result**: ✅ No audio issues

## Investigation Focus

### Primary Hypothesis: Sample Rate Mismatch
The audio slowdown and pitch reduction suggests audio is being recorded at one sample rate but exported/played back assuming a different rate.

**Example scenario:**
- Audio recorded at 96 kHz (BlackStar Polar 2 setting)
- Exported/encoded assuming 48 kHz
- Result: Playback at 50% speed and 50% pitch

**Verification needed:**
1. Check current BlackStar Polar 2 sample rate in Audio MIDI Setup
2. Examine Cap's audio capture code for sample rate detection
3. Check export/encoding logic for hard-coded sample rate assumptions
4. Test with various sample rates to identify pattern

### Secondary Consideration: Multiple Audio Sources
If both the Insta360 Link 2 microphone AND the RODE PodMic (via BlackStar Polar 2) are active:
- Two different audio devices with potentially different sample rates
- Need to verify which audio source Cap is actually using during recording
- Potential for audio device selection issues

## Next Steps
1. ✅ Document hardware specifications (this file)
2. ⏳ Check Audio MIDI Setup for current BlackStar Polar 2 configuration
3. ⏳ Investigate Cap audio recording code
4. ⏳ Create diagnostic test recording
5. ⏳ Analyze audio file metadata (ffprobe)
6. ⏳ Implement fix for sample rate handling

## Testing Protocol
For each fix attempt, test with:
- BlackStar Polar 2 at 48 kHz (should match "expected" rate)
- BlackStar Polar 2 at 96 kHz (likely current problematic setting)
- BlackStar Polar 2 at 192 kHz (maximum, most extreme test case)

Expected outcome: Audio export should maintain correct speed/pitch regardless of input device sample rate.
