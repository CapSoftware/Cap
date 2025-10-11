# Audio Bug Investigation - Key Findings

**Date**: October 11, 2025
**Status**: Initial investigation complete, ready for testing phase
**Confidence Level**: High - Root cause identified

---

## Executive Summary

The audio slowdown/pitch reduction bug has been traced to a **sample rate metadata mismatch** between audio recording and export. The codebase properly captures the device's sample rate during recording, but the export process ignores this metadata and assumes a hardcoded 48 kHz rate.

---

## Critical Code Locations

### 1. Export Hardcoded Sample Rate (PRIMARY BUG)
**File**: `crates/audio/src/audio_data.rs`
**Line**: 18
```rust
pub const SAMPLE_RATE: u32 = 48_000;
```

**Problem**: This constant is used by `AudioRenderer::SAMPLE_RATE` during export (line 77 in `crates/editor/src/audio.rs`). The export process always assumes 48 kHz regardless of the actual recorded sample rate.

**Impact**: If audio was recorded at a different rate, the export will have incorrect timing, causing slowdown/speedup and pitch shift.

---

### 2. Microphone Device Configuration
**File**: `crates/recording/src/feeds/microphone.rs`
**Lines**: 149, 156

```rust
.filter(|c| c.min_sample_rate().0 <= 48000 && c.max_sample_rate().0 <= 48000)
// ...
config.with_max_sample_rate()
```

**Problem**: Two conflicting behaviors:
- Filters devices to those with `max_sample_rate <= 48000`
- Then uses `.with_max_sample_rate()` which sets the device to its maximum rate

**Impact**: BlackStar Polar 2 supports up to 192 kHz, which would be filtered OUT by this logic. This might cause device selection issues or fallback behavior.

---

### 3. Proper Sample Rate Capture (WORKING CORRECTLY)
**File**: `crates/media-info/src/lib.rs`
**Line**: 69

```rust
sample_rate: config.sample_rate().0,
```

**Status**: ✅ This correctly reads the sample rate from the audio device configuration.

**File**: `crates/media-info/src/lib.rs`
**Line**: 124

```rust
frame.set_rate(self.sample_rate);
```

**Status**: ✅ This correctly sets the frame rate based on the captured sample rate.

---

### 4. Export Using Hardcoded Info
**File**: `crates/export/src/mp4.rs`
**Lines**: 88-89

```rust
AACEncoder::init(AudioRenderer::info(), o)
```

**Problem**: `AudioRenderer::info()` returns:
```rust
AudioInfo::new(Self::SAMPLE_FORMAT, Self::SAMPLE_RATE, Self::CHANNELS).unwrap()
```

Where `Self::SAMPLE_RATE` is the hardcoded 48 kHz constant.

**Impact**: Export encoder is initialized with wrong sample rate information.

---

## Current System Configuration

From `system_profiler SPAudioDataType`:

```
Polar 2 (BlackStar):
  - Default Input Device: Yes
  - Current Sample Rate: 48000 Hz
  - Input Channels: 4
  - Transport: USB

Insta360 Link 2:
  - Current Sample Rate: 48000 Hz
  - Input Channels: 1
  - Transport: USB
```

**Key Observation**: Both devices are currently at 48 kHz, yet the bug still occurs. This suggests the problem is NOT a simple system-level configuration mismatch, but rather a code-level metadata handling issue.

---

## Primary Hypothesis: Metadata Mismatch

**Confidence**: High

### Theory
1. During recording, audio device is properly queried and `AudioInfo` is created with correct sample rate
2. Audio frames are recorded with correct metadata
3. Audio is saved to disk (likely in .cap project format or intermediate files)
4. During export:
   - Export process loads recorded audio files
   - `AudioData::from_file()` reads the audio and **resamples to 48 kHz** (lines 41-49 in audio_data.rs)
   - However, if the original audio file has INCORRECT metadata (claiming 48 kHz when it's actually recorded at a different rate), the resampler won't fix it
   - Export then uses hardcoded 48 kHz for AAC encoding

### Evidence Supporting This Theory
1. ✅ Hardcoded 48 kHz constant exists in export code
2. ✅ Device filter contradicts max sample rate selection
3. ✅ System shows 48 kHz but bug persists (suggests metadata, not device config)
4. ✅ Resampler exists but relies on file metadata being correct
5. ✅ Bug is specific to peripheral hardware (different audio path than built-in)

### How This Causes The Bug
If audio is actually recorded at 96 kHz but metadata incorrectly labels it as 48 kHz:
- File header says "48 kHz"
- Resampler sees "48 kHz → 48 kHz" and does nothing
- But actual data is 96 kHz
- Playback at 48 kHz rate = 50% speed + 50% pitch = **exact symptom reported**

---

## Alternative Hypotheses

### Hypothesis B: Device Filter Blocking Proper Configuration
**Confidence**: Medium

The filter at line 149 might be preventing the BlackStar Polar 2 from being properly configured, causing:
- Device not found → fallback to different device
- Or device configured incorrectly → wrong sample rate recording

### Hypothesis C: Timestamp/PTS Calculation Errors
**Confidence**: Low

Audio frame timestamps might not account for actual sample rate, accumulating timing errors.

---

## Technology Stack Identified

- **Audio Capture**: cpal (Cross-Platform Audio Library)
- **Recording**: Custom Rust implementation using cpal + FFmpeg frames
- **Encoding**: FFmpeg-based AAC encoder
- **Container**: MP4 with H.264 video + AAC audio
- **Resampling**: FFmpeg software resampler (used during file loading)

---

## Next Steps

### Phase 1: Diagnostic Testing ✅ CURRENT PHASE
1. ✅ Document hardware specifications
2. ✅ Check system audio configuration
3. ✅ Investigate codebase for audio handling
4. ✅ Identify critical code locations
5. ⏳ **Create test recording with peripheral hardware**
6. ⏳ **Analyze recorded file metadata with ffprobe**
7. ⏳ **Analyze exported file metadata with ffprobe**
8. ⏳ **Confirm hypothesis**

### Phase 2: Fix Development
Based on test results, implement one of:
- **Solution A** (Most Likely): Fix export to use actual recorded sample rate
- **Solution B**: Fix device filter to not exclude high-sample-rate devices
- **Solution C**: Add explicit sample rate conversion at recording time
- **Solution D**: Constrain all recording to 48 kHz and validate it works

### Phase 3: Testing & Validation
1. Test fix with BlackStar Polar 2 at 48 kHz (should work)
2. Test with BlackStar Polar 2 at 96 kHz (stress test)
3. Test with BlackStar Polar 2 at 192 kHz (maximum stress test)
4. Verify MacBook Air built-in audio still works
5. Test studio editor playback (watch for secondary bug mentioned)

### Phase 4: Git & PR
1. Clean feature branch with only working fix
2. Descriptive commit messages
3. Update any relevant documentation
4. Submit PR to original Cap repository

---

## Testing Protocol

### ffprobe Commands
```bash
# Analyze recorded audio file
ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate,codec_name,channels path/to/recorded/file

# Analyze exported MP4
ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate,codec_name,channels path/to/exported.mp4

# Get full audio stream info
ffprobe -v error -select_streams a:0 -show_streams path/to/file
```

### Expected Results
If hypothesis is correct:
- Recorded file: Incorrect sample rate metadata OR correct metadata but file data mismatch
- Exported file: 48 kHz AAC (hardcoded)
- Actual audio data: Different rate than metadata claims

---

## Questions to Answer with Testing

1. ❓ What sample rate is written to the recorded audio file metadata?
2. ❓ Does the actual audio data match the metadata sample rate?
3. ❓ What happens if we manually set BlackStar Polar 2 to 96 kHz before recording?
4. ❓ Is the bug consistent across multiple recordings?
5. ❓ Does the bug affect instant recordings differently than studio recordings?

---

## Files Modified During Investigation

**Created**:
- `docs/hardware-specs.md` - Hardware specifications
- `docs/audio-device-status.md` - Current system audio configuration
- `docs/investigation-findings.md` - This file
- `claude-audio-fix.md` - High-level overview for context persistence
- `.memory-bank/` - Detailed memory bank files

**Modified**:
- `.gitignore` - Added working files to ignore list

**Not Yet Modified** (awaiting fix implementation):
- No code changes yet - investigation only

---

## Memory Bank Location

Detailed technical findings, test results, and solution attempts are tracked in:
```
/Users/mattdreier/Desktop/CAP/.memory-bank/
```

Key files:
- `activeContext.md` - Current status and next steps
- `techContext.md` - Technical architecture details
- `testResults.md` - Test recordings and analysis
- `solutionAttempts.md` - Fix attempts and outcomes
- `CHANGELOG.md` - Session-by-session progress log

---

**Status**: Ready to proceed with test recording and ffprobe analysis to confirm hypothesis.
