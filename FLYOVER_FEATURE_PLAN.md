# Flyover Camera Feature - Architecture Analysis & Implementation Plan

## Table of Contents
1. [Project Overview](#project-overview)
2. [Architecture Analysis](#architecture-analysis)
3. [Current System Deep Dive](#current-system-deep-dive)
4. [Feature Requirements](#feature-requirements)
5. [Implementation Plan](#implementation-plan)
6. [Technical Decisions](#technical-decisions)
7. [Risks & Mitigations](#risks--mitigations)

---

## Project Overview

### Feature Goal
Add a "flyover" camera mode to Cap's instant recordings where the user's camera video dynamically follows cursor movements during both recording preview and playback. Users should be able to toggle between flyover mode (camera follows cursor) and fixed position mode (camera in bottom-right corner).

### Key Requirements
- **Mode**: Instant mode (not studio mode)
- **Real-time Preview**: Camera follows cursor during recording in desktop app
- **Playback Format**: Separate video tracks (display.mp4, camera.mp4) + cursor.json uploaded to web
- **Editable**: Users can adjust flyover settings after recording
- **Toggle**: Switch between flyover and fixed position modes

---

## Architecture Analysis

### Current Recording Modes

#### Instant Mode (`crates/recording/src/instant_recording.rs`)
**Current Behavior**:
- Single-file output: `content/output.mp4`
- Real-time compositing during recording
- Screen + system audio + microphone → single MP4
- **Camera is NOT recorded** (captured but not encoded)
- Designed for fast sharing with immediate upload

**Key Code References**:
```rust
// Line 302: Camera explicitly disabled
camera_feed: None

// Lines 220-229: Single pipeline creation
let output = ScreenCaptureMethod::make_instant_mode_pipeline(
    screen_capture,
    system_audio,
    mic_feed,
    output_path.clone(),
    output_resolution,
    encoder_preferences,
).await?
```

**Output Structure**:
```
project/
  content/
    output.mp4          ← Single composited video
  recording-meta.json
```

#### Studio Mode (`crates/recording/src/studio_recording.rs`)
**Current Behavior**:
- **Separate streams** for each source
- Screen, camera, microphone, system audio recorded independently
- Multiple segments support (pause/resume)
- **Comprehensive cursor tracking** (position + clicks)
- Post-processing rendering pipeline for final output

**Key Code References**:
```rust
// Lines 816-892: Separate pipelines for each source
Pipeline {
    screen: OutputPipeline,          // display.mp4
    camera: Option<OutputPipeline>,  // camera.mp4 (separate!)
    microphone: Option<OutputPipeline>,
    system_audio: Option<OutputPipeline>,
    cursor: Option<CursorPipeline>,
}
```

**Output Structure**:
```
project/
  content/
    segments/
      segment-0/
        display.mp4          ← Screen recording
        camera.mp4           ← Camera feed (SEPARATE!)
        audio-input.ogg      ← Microphone
        system_audio.ogg     ← System audio
        cursor.json          ← Cursor events
    cursors/
      cursor_0.png           ← Cursor image assets
      cursor_1.png
  recording-meta.json
  cap-project.json
```

### Key Finding: Streams Are Already Separate in Studio Mode ✅

Studio mode demonstrates the pattern we need:
1. Screen and camera recorded to separate MP4 files
2. Cursor positions tracked at 100Hz (10ms intervals)
3. Post-processing compositor positions camera over screen
4. All data available for flexible editing

---

## Current System Deep Dive

### Cursor Tracking System (`crates/recording/src/cursor.rs`)

**Already Implemented in Studio Mode** ✅

**Capture Details**:
- Polling frequency: 10ms (100 Hz) - Line 80
- Position normalization: 0.0-1.0 coordinates (relative to screen)
- Click tracking: Down/Up events with timestamps
- Cursor image capture: PNG files for different cursor shapes
- Modifier keys: Ctrl, Shift, Alt, etc.

**Data Structures**:
```rust
pub struct CursorMoveEvent {
    cursor_id: String,
    time_ms: f64,        // Milliseconds since recording start
    x: f64,              // Normalized 0.0-1.0
    y: f64,              // Normalized 0.0-1.0
    active_modifiers: Vec<Modifier>,
}

pub struct CursorClickEvent {
    down: bool,
    cursor_num: u8,
    cursor_id: String,
    time_ms: f64,
}

pub struct Cursor {
    pub file_name: String,    // cursor_N.png
    pub id: u32,
    pub hotspot: XY<f64>,     // Click point offset
    pub shape: Option<CursorShape>,
}
```

**Output Format** (`cursor.json`):
```json
{
  "moves": [
    {
      "active_modifiers": [],
      "cursor_id": "0",
      "time_ms": 123.45,
      "x": 0.5234,
      "y": 0.6789
    }
  ],
  "clicks": [
    {
      "down": true,
      "cursor_num": 0,
      "cursor_id": "0",
      "time_ms": 456.78
    }
  ]
}
```

**Reusability**: Can be directly reused in instant mode with minimal changes.

### Camera Recording System (`crates/recording/src/feeds/camera.rs`)

**Actor-Based Architecture**:
```rust
pub struct CameraFeed {
    state: State,                            // Open or Locked
    senders: Vec<flume::Sender<FFmpegVideoFrame>>,
    on_ready: Vec<oneshot::Sender<()>>,
}
```

**Capture Flow**:
1. Platform-specific camera APIs:
   - macOS: AVFoundation (`camera-avfoundation`)
   - Windows: Media Foundation (`camera-mediafoundation`)
   - Fallback: FFmpeg (`camera-ffmpeg`)
2. Format selection prioritizes:
   - Frame rate ≥ 30 FPS
   - Resolution < 2000x2000
   - 16:9 aspect ratio
3. Native capture → FFmpeg frames → H.264 encoding
4. Output to separate `camera.mp4` file

**Studio Mode Integration**:
```rust
// Lines 827-836 in studio_recording.rs
let camera = OptionFuture::from(base_inputs.camera_feed.map(|camera_feed| {
    OutputPipeline::builder(dir.join("camera.mp4"))
        .with_video::<sources::Camera>(camera_feed)
        .with_timestamps(start_time)
        .build::<Mp4Muxer>(())
}))
```

### Rendering Pipeline (`crates/rendering/`)

**GPU-Accelerated Compositor** built on WGPU.

**Layer Architecture**:
1. **Background Layer** (`background.rs`) - Solid color or gradient
2. **Display Layer** (`display.rs`) - Screen recording video
3. **Camera Layer** (`camera.rs`) - Separate video texture with position/size/opacity control
4. **Cursor Layer** (`cursor.rs`) - Cursor images with interpolated motion
5. **Captions Layer** (`captions.rs`) - AI-generated subtitles

**Camera Layer Key Features**:
```rust
pub struct CameraLayer {
    frame_texture: wgpu::Texture,
    uniforms_buffer: wgpu::Buffer,
    hidden: bool,
}

pub fn prepare(
    &mut self,
    data: Option<(CompositeVideoFrameUniforms, XY<u32>, &DecodedFrame)>
) {
    // CompositeVideoFrameUniforms includes:
    // - position (x, y in screen space)
    // - size (width, height)
    // - opacity
    // - corner_radius
}
```

**Cursor Rendering** (`cursor.rs`, `cursor_interpolation.rs`):
- Spring-mass-damper physics for smooth motion
- Motion blur based on velocity
- Click animations (shrink effect)
- Three spring profiles: Default, Snappy (near clicks), Drag (button held)

**Coordinate Systems** (`coord.rs`):
```rust
pub struct RawDisplayUVSpace;    // Normalized 0.0-1.0
pub struct FrameSpace;            // Output video pixels
pub struct ZoomedFrameSpace;      // After zoom transform
```

### Preview System (`apps/desktop/src/routes/editor/Player.tsx`)

**Current Implementation**:
- 2D Canvas element (line 426-437)
- Rust GPU renderer generates frames
- Frames sent via IPC as `ImageData`
- Canvas displays with `ctx.putImageData(frame.data, 0, 0)` (line 373)
- `renderFrameEvent` triggers frame generation
- 30-60 FPS rendering

**Frame Pipeline**:
```
SolidJS Component → renderFrameEvent (frame number)
       ↓
Rust editor_instance.rs → Handle event
       ↓
cap_rendering crate → GPU composition
       ↓
Return RenderedFrame with ImageData
       ↓
Canvas display
```

---

## Feature Requirements

Based on user answers to clarifying questions:

1. **Recording Mode**: Instant mode (current default)
2. **Live Preview**: Yes - camera follows cursor in real-time during recording
3. **Playback Format**: Separate tracks (display.mp4, camera.mp4, cursor.json)
4. **Post-Recording Editing**: Yes - users can adjust flyover settings after recording

### Functional Requirements

**Desktop App (Recording)**:
- Record screen, camera, and cursor position separately
- Real-time preview shows camera following cursor during recording
- Toggle between flyover mode and fixed position mode
- Configurable offset (camera position relative to cursor)
- Smooth motion with spring physics
- Output multiple files: display.mp4, camera.mp4, cursor.json

**Web App (Playback)**:
- Upload multiple video tracks + cursor data
- Custom player with synchronized video elements
- Camera position calculated from cursor.json in real-time
- Smooth interpolation between cursor events
- Editable flyover settings (offset, smoothing, enable/disable)
- Preview changes without re-rendering video

**Web App (Editor)**:
- Toggle flyover on/off
- Adjust camera offset from cursor
- Adjust smoothing strength
- Real-time preview of changes
- Save settings to database
- Optional: Re-render video with baked camera positions

---

## Implementation Plan

### Phase 1: Desktop Recording Infrastructure (Rust)

#### 1.1 Add Camera Recording to Instant Mode

**Files to Modify**:
- `crates/recording/src/instant_recording.rs`
- `crates/recording/src/capture_pipeline.rs`

**Changes**:
1. Update `ActorBuilder` to accept camera feed
```rust
pub fn with_camera_feed(mut self, camera_feed: Arc<CameraFeedLock>) -> Self {
    self.camera_feed = Some(camera_feed);
    self
}
```

2. Modify line 302 to use camera feed instead of `None`:
```rust
RecordingBaseInputs {
    capture_target: self.capture_target,
    capture_system_audio: self.system_audio,
    mic_feed: self.mic_feed,
    camera_feed: self.camera_feed, // Change from None
    ...
}
```

3. Update `create_pipeline` to create separate camera output:
```rust
let camera = if let Some(camera_feed) = base_inputs.camera_feed {
    Some(OutputPipeline::builder(content_dir.join("camera.mp4"))
        .with_video::<sources::Camera>(camera_feed)
        .with_timestamps(start_time)
        .build::<Mp4Muxer>(())
        .await?)
} else {
    None
}
```

4. Update `make_instant_mode_pipeline` trait to accept optional camera parameter

**Output**: Instant recordings produce `display.mp4` and `camera.mp4` separately

#### 1.2 Add Cursor Tracking to Instant Mode

**Files to Modify**:
- `crates/recording/src/instant_recording.rs`
- Reuse: `crates/recording/src/cursor.rs` (no changes needed)

**Changes**:
1. Add cursor recorder to pipeline creation:
```rust
let cursor = if enable_cursor {
    let cursor_crop_bounds = target.cursor_crop()
        .ok_or_else(|| anyhow!("No cursor bounds"))?;

    let cursor = spawn_cursor_recorder(
        cursor_crop_bounds,
        display,
        content_dir.join("cursors"),
        HashMap::new(),  // prev_cursors
        0,               // next_cursor_id
        start_time,
    );

    Some(CursorPipeline {
        output_path: content_dir.join("cursor.json"),
        actor: cursor,
    })
} else {
    None
}
```

2. Add cursor directory creation
3. Update Pipeline struct to include cursor

**Output**: `cursor.json` with 100Hz position data, cursor images in `cursors/` directory

#### 1.3 Update Metadata Format

**Files to Modify**:
- `crates/project/src/meta.rs`

**Changes**:
1. Add new variant to `InstantRecordingMeta`:
```rust
pub enum InstantRecordingMeta {
    InProgress { recording: bool },
    Failed { error: String },
    Complete {
        fps: u32,
        sample_rate: Option<u32>
    },
    // NEW: Multi-track format
    MultiTrack {
        display: VideoTrackMeta,
        camera: Option<VideoTrackMeta>,
        mic: Option<AudioTrackMeta>,
        system_audio: Option<AudioTrackMeta>,
        cursor: Option<RelativePathBuf>,
        fps: u32,
    }
}

pub struct VideoTrackMeta {
    pub path: RelativePathBuf,
    pub fps: u32,
    pub resolution: (u32, u32),
    pub start_time: f64,
}
```

2. Update serialization/deserialization
3. Maintain backward compatibility with legacy `output.mp4` format

**Output Structure**:
```
project/
  content/
    display.mp4          ← Screen only
    camera.mp4           ← Camera only
    audio-input.ogg      ← Mic audio
    system_audio.ogg     ← System audio (optional)
    cursor.json          ← Cursor data
    cursors/             ← Cursor images
      cursor_0.png
  recording-meta.json    ← Updated format
```

---

### Phase 2: Real-time Preview Compositor (Rust + SolidJS)

#### 2.1 Camera Follow Position Calculator

**New File**: `crates/rendering/src/camera_follow.rs`

**Implementation**:
```rust
use crate::coord::{Coord, RawDisplayUVSpace};
use crate::spring_mass_damper::{SpringMassDamperSimulationConfig, SpringMassDamper};

pub struct CameraFollowConfig {
    pub enabled: bool,
    pub offset: XY<f64>,           // Offset from cursor (e.g., 150px right, 150px down)
    pub camera_size: XY<f64>,      // Camera dimensions
    pub smoothing: SpringMassDamperSimulationConfig,
    pub boundary_padding: f64,     // Padding from screen edges
}

pub struct CameraFollowState {
    position: SpringMassDamper<XY<f64>>,
    config: CameraFollowConfig,
}

impl CameraFollowState {
    pub fn update(
        &mut self,
        cursor_pos: Coord<RawDisplayUVSpace>,
        delta_time: f64,
    ) -> Coord<RawDisplayUVSpace> {
        let target_pos = self.calculate_target_position(cursor_pos);
        self.position.update(target_pos, delta_time);

        // Apply boundary constraints
        self.constrain_to_bounds(self.position.position())
    }

    fn calculate_target_position(&self, cursor_pos: Coord<RawDisplayUVSpace>) -> XY<f64> {
        // Camera position = cursor position + offset
        let target = XY {
            x: cursor_pos.x() + self.config.offset.x,
            y: cursor_pos.y() + self.config.offset.y,
        };
        target
    }

    fn constrain_to_bounds(&self, pos: XY<f64>) -> Coord<RawDisplayUVSpace> {
        // Ensure camera stays within screen bounds (0.0 - 1.0)
        // with padding for camera size
        let constrained = XY {
            x: pos.x.clamp(
                self.config.boundary_padding,
                1.0 - self.config.camera_size.x - self.config.boundary_padding
            ),
            y: pos.y.clamp(
                self.config.boundary_padding,
                1.0 - self.config.camera_size.y - self.config.boundary_padding
            ),
        };
        Coord::from_xy(constrained)
    }
}
```

**Features**:
- Spring-mass-damper smoothing (reuse existing implementation)
- Configurable offset from cursor
- Boundary checking to keep camera on-screen
- Smooth transitions

#### 2.2 Extend GPU Renderer for Live Camera Overlay

**Files to Modify**:
- `crates/rendering/src/lib.rs`
- `crates/rendering/src/layers/camera.rs`

**Changes to `lib.rs`**:
1. Add preview mode flag to renderer
2. Accept live camera feed and cursor position
3. Calculate camera position using `CameraFollowState`
4. Update `ProjectUniforms` to include camera follow config

**Changes to `camera.rs`**:
1. Support real-time camera feed (not just pre-recorded video)
2. Accept dynamic position parameter
3. Update uniforms buffer with new position each frame

**Implementation**:
```rust
// In rendering loop
let cursor_position = get_current_cursor_position();
let camera_position = camera_follow_state.update(cursor_position, delta_time);

// Prepare camera layer with dynamic position
camera_layer.prepare(Some((
    CompositeVideoFrameUniforms {
        position: camera_position,
        size: camera_config.size,
        opacity: 1.0,
        corner_radius: camera_config.corner_radius,
    },
    camera_frame.size,
    &camera_frame,
)));
```

**Output**: Composited frames with camera overlay at cursor-following position

#### 2.3 Update Preview Frame Generation

**Files to Modify**:
- `apps/desktop/src-tauri/src/editor_instance.rs`
- `apps/desktop/src-tauri/src/recording.rs`

**Changes**:
1. Pass camera feed to renderer during recording
2. Pass current cursor position to renderer
3. Enable camera overlay for instant mode preview
4. Stream composited frames to frontend at 30-60 FPS

**IPC Event**:
```rust
#[derive(Serialize, Type, tauri_specta::Event, Debug, Clone)]
pub struct PreviewFrameReady {
    frame: ImageData,
    timestamp: f64,
}
```

#### 2.4 Desktop UI Controls

**Files to Modify**:
- `apps/desktop/src/routes/editor/Player.tsx`
- New: `apps/desktop/src/components/CameraFollowControls.tsx`

**UI Components**:
1. Toggle switch: "Flyover Mode" vs "Fixed Position"
2. Offset controls:
   - X offset slider (-500 to 500 pixels)
   - Y offset slider (-500 to 500 pixels)
3. Smoothing strength slider (0.1 to 1.0)
4. Camera size dropdown (Small, Medium, Large)
5. Preview indicator showing camera will follow cursor

**State Management**:
```typescript
const [cameraMode, setCameraMode] = createSignal<'flyover' | 'fixed'>('fixed');
const [offset, setOffset] = createSignal({ x: 150, y: 150 });
const [smoothing, setSmoothing] = createSignal(0.5);

// Send config to Rust via IPC
createEffect(() => {
  commands.updateCameraFollowConfig({
    enabled: cameraMode() === 'flyover',
    offset: offset(),
    smoothing: smoothing(),
  });
});
```

**Real-time Preview**:
- Canvas receives composited frames from Rust
- Settings updates trigger immediate re-render
- Visual feedback of camera position

---

### Phase 3: Web Upload & Storage

#### 3.1 Multi-File Upload Pipeline

**Files to Modify**:
- `apps/web/actions/video/upload.ts` (or create new Server Action)
- `apps/web/lib/s3.ts`

**Changes**:
1. Create upload function for multiple files:
```typescript
"use server";

export async function uploadMultiTrackVideo(data: {
  videoId: string;
  displayFile: File;
  cameraFile: File;
  cursorData: string; // JSON string
  metadata: VideoMetadata;
}) {
  const s3 = getS3Client();

  // Upload files concurrently
  const [displayUrl, cameraUrl, cursorUrl] = await Promise.all([
    s3.upload({
      key: `videos/${data.videoId}/display.mp4`,
      file: data.displayFile,
    }),
    s3.upload({
      key: `videos/${data.videoId}/camera.mp4`,
      file: data.cameraFile,
    }),
    s3.upload({
      key: `videos/${data.videoId}/cursor.json`,
      file: new Blob([data.cursorData], { type: 'application/json' }),
    }),
  ]);

  // Update database with all URLs
  await db.update(videos).set({
    videoPath: displayUrl,
    cameraVideoPath: cameraUrl,
    cursorDataPath: cursorUrl,
    status: 'ready',
  }).where(eq(videos.id, data.videoId));

  return { success: true, videoId: data.videoId };
}
```

2. Progress tracking for all uploads
3. Atomic commit (only mark ready when all files uploaded)
4. Error handling and retry logic

#### 3.2 Database Schema Updates

**Files to Modify**:
- `packages/database/schema.ts`

**Schema Changes**:
```typescript
export const videos = mysqlTable("videos", {
  id: varchar("id", { length: 26 }).primaryKey(),

  // Existing fields
  videoPath: text("videoPath").notNull(),

  // NEW: Multi-track support
  cameraVideoPath: text("cameraVideoPath"),      // camera.mp4 URL
  cursorDataPath: text("cursorDataPath"),        // cursor.json URL
  recordingMode: varchar("recordingMode", {
    length: 20,
    enum: ["instant", "studio"]
  }).default("instant"),

  // Camera follow settings
  cameraFollowEnabled: boolean("cameraFollowEnabled").default(false),
  cameraFollowOffset: json("cameraFollowOffset").$type<{ x: number; y: number }>(),
  cameraFollowSmoothing: float("cameraFollowSmoothing").default(0.5),

  // ... other existing fields
});
```

**Migration Script**:
```sql
ALTER TABLE videos
  ADD COLUMN cameraVideoPath TEXT,
  ADD COLUMN cursorDataPath TEXT,
  ADD COLUMN recordingMode VARCHAR(20) DEFAULT 'instant',
  ADD COLUMN cameraFollowEnabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN cameraFollowOffset JSON,
  ADD COLUMN cameraFollowSmoothing FLOAT DEFAULT 0.5;
```

**Run Migration**:
```bash
pnpm db:generate
pnpm db:push
```

#### 3.3 S3 Storage Structure

**New Structure**:
```
s3://cap-bucket/
  videos/
    {videoId}/
      display.mp4        ← Screen recording
      camera.mp4         ← Camera recording
      cursor.json        ← Cursor position data
      thumbnail.jpg      ← Thumbnail (existing)
```

**Backward Compatibility**:
- Old recordings: `videos/{videoId}.mp4` (single file)
- New recordings: `videos/{videoId}/display.mp4` (multi-track)
- Check for `cameraVideoPath` to determine format

---

### Phase 4: Web Video Player

#### 4.1 Multi-Track Player Component

**New File**: `apps/web/components/VideoPlayer/MultiTrackPlayer.tsx`

**Implementation**:
```typescript
"use client";

import { useEffect, useRef, useState } from "react";
import { useCursorPositioning } from "./useCursorPositioning";

interface MultiTrackPlayerProps {
  displayVideoUrl: string;
  cameraVideoUrl: string;
  cursorDataUrl: string;
  cameraFollowConfig: {
    enabled: boolean;
    offset: { x: number; y: number };
    smoothing: number;
  };
}

export function MultiTrackPlayer({
  displayVideoUrl,
  cameraVideoUrl,
  cursorDataUrl,
  cameraFollowConfig,
}: MultiTrackPlayerProps) {
  const displayRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // Load and process cursor data
  const { getCameraPosition } = useCursorPositioning(
    cursorDataUrl,
    cameraFollowConfig
  );

  // Sync both videos
  useEffect(() => {
    const display = displayRef.current;
    const camera = cameraRef.current;
    if (!display || !camera) return;

    const syncVideos = () => {
      const timeDiff = Math.abs(display.currentTime - camera.currentTime);

      // If drift > 50ms, correct it
      if (timeDiff > 0.05) {
        camera.currentTime = display.currentTime;
      }

      setCurrentTime(display.currentTime);
    };

    display.addEventListener('timeupdate', syncVideos);
    display.addEventListener('play', () => {
      camera.play();
      setIsPlaying(true);
    });
    display.addEventListener('pause', () => {
      camera.pause();
      setIsPlaying(false);
    });
    display.addEventListener('seeked', () => {
      camera.currentTime = display.currentTime;
    });

    return () => {
      display.removeEventListener('timeupdate', syncVideos);
    };
  }, []);

  // Update camera position based on cursor data
  useEffect(() => {
    if (!cameraRef.current || !containerRef.current) return;

    let animationFrame: number;

    const updatePosition = () => {
      const position = getCameraPosition(currentTime);

      if (position && cameraRef.current) {
        const container = containerRef.current!;
        const containerRect = container.getBoundingClientRect();

        // Convert normalized position (0-1) to pixels
        const x = position.x * containerRect.width;
        const y = position.y * containerRect.height;

        cameraRef.current.style.transform = `translate(${x}px, ${y}px)`;
      }

      animationFrame = requestAnimationFrame(updatePosition);
    };

    if (isPlaying) {
      updatePosition();
    }

    return () => cancelAnimationFrame(animationFrame);
  }, [currentTime, isPlaying, getCameraPosition]);

  return (
    <div ref={containerRef} className="relative w-full aspect-video bg-black">
      {/* Screen video (base layer) */}
      <video
        ref={displayRef}
        src={displayVideoUrl}
        className="w-full h-full"
        controls
      />

      {/* Camera video (overlay) */}
      <video
        ref={cameraRef}
        src={cameraVideoUrl}
        className="absolute w-[200px] h-[200px] rounded-full object-cover pointer-events-none"
        style={{
          willChange: 'transform',
          transition: 'transform 0.016s linear', // ~60 FPS
        }}
        muted
      />
    </div>
  );
}
```

**Key Features**:
- Two synchronized `<video>` elements
- Camera positioned absolutely over screen
- CSS `transform` for GPU-accelerated positioning
- Drift correction for sync issues
- `requestAnimationFrame` for smooth updates

#### 4.2 Cursor-Based Camera Positioning Hook

**New File**: `apps/web/components/VideoPlayer/useCursorPositioning.ts`

**Implementation**:
```typescript
import { useEffect, useState, useCallback } from "react";

interface CursorData {
  moves: Array<{
    time_ms: number;
    x: number;
    y: number;
    cursor_id: string;
  }>;
  clicks: Array<{
    time_ms: number;
    down: boolean;
    cursor_num: number;
  }>;
}

interface CameraPosition {
  x: number; // 0.0 - 1.0
  y: number; // 0.0 - 1.0
}

export function useCursorPositioning(
  cursorDataUrl: string,
  config: {
    enabled: boolean;
    offset: { x: number; y: number };
    smoothing: number;
  }
) {
  const [cursorData, setCursorData] = useState<CursorData | null>(null);
  const [smoothingState, setSmoothingState] = useState<{
    position: { x: number; y: number };
    velocity: { x: number; y: number };
  }>({ position: { x: 0.5, y: 0.5 }, velocity: { x: 0, y: 0 } });

  // Load cursor data
  useEffect(() => {
    fetch(cursorDataUrl)
      .then(res => res.json())
      .then(data => setCursorData(data));
  }, [cursorDataUrl]);

  // Get camera position at specific time
  const getCameraPosition = useCallback((time: number): CameraPosition | null => {
    if (!cursorData || !config.enabled) {
      // Fixed position (bottom-right)
      return { x: 0.75, y: 0.75 };
    }

    const timeMs = time * 1000;

    // Find cursor position at this time (interpolate between events)
    const cursorPos = interpolateCursorPosition(cursorData.moves, timeMs);

    if (!cursorPos) return null;

    // Apply offset (convert to normalized coordinates)
    const cameraPos = {
      x: cursorPos.x + (config.offset.x / 1920), // Assuming 1920px width
      y: cursorPos.y + (config.offset.y / 1080), // Assuming 1080px height
    };

    // Apply smoothing (spring physics)
    const smoothed = applySpringSmoothing(
      smoothingState,
      cameraPos,
      config.smoothing,
      0.016 // 60 FPS delta time
    );

    setSmoothingState(smoothed);

    // Constrain to bounds
    return {
      x: Math.max(0, Math.min(0.85, smoothed.position.x)),
      y: Math.max(0, Math.min(0.85, smoothed.position.y)),
    };
  }, [cursorData, config, smoothingState]);

  return { getCameraPosition };
}

function interpolateCursorPosition(
  moves: CursorData['moves'],
  timeMs: number
): { x: number; y: number } | null {
  if (moves.length === 0) return null;

  // Find the two cursor events surrounding this time
  let before = moves[0];
  let after = moves[moves.length - 1];

  for (let i = 0; i < moves.length - 1; i++) {
    if (moves[i].time_ms <= timeMs && moves[i + 1].time_ms >= timeMs) {
      before = moves[i];
      after = moves[i + 1];
      break;
    }
  }

  // Linear interpolation
  const timeDiff = after.time_ms - before.time_ms;
  if (timeDiff === 0) return { x: before.x, y: before.y };

  const t = (timeMs - before.time_ms) / timeDiff;

  return {
    x: before.x + (after.x - before.x) * t,
    y: before.y + (after.y - before.y) * t,
  };
}

function applySpringSmoothing(
  state: { position: { x: number; y: number }; velocity: { x: number; y: number } },
  target: { x: number; y: number },
  smoothing: number,
  dt: number
) {
  // Simple spring-damper physics
  const stiffness = 200 * (1 - smoothing);
  const damping = 20;

  const dx = target.x - state.position.x;
  const dy = target.y - state.position.y;

  const ax = stiffness * dx - damping * state.velocity.x;
  const ay = stiffness * dy - damping * state.velocity.y;

  const newVelocity = {
    x: state.velocity.x + ax * dt,
    y: state.velocity.y + ay * dt,
  };

  const newPosition = {
    x: state.position.x + newVelocity.x * dt,
    y: state.position.y + newVelocity.y * dt,
  };

  return {
    position: newPosition,
    velocity: newVelocity,
  };
}
```

**Features**:
- Loads and parses cursor.json
- Interpolates between cursor events (100Hz data)
- Applies spring smoothing for natural motion
- Converts cursor position to camera position with offset
- Boundary constraining

#### 4.3 Integration with Existing Player

**Files to Modify**:
- `apps/web/app/[videoId]/page.tsx` (or wherever video player is rendered)

**Changes**:
```typescript
import { MultiTrackPlayer } from "@/components/VideoPlayer/MultiTrackPlayer";

export default async function VideoPage({ params }: { params: { videoId: string } }) {
  const video = await getVideo(params.videoId);

  // Check if multi-track format
  const isMultiTrack = video.cameraVideoPath && video.cursorDataPath;

  if (isMultiTrack) {
    return (
      <MultiTrackPlayer
        displayVideoUrl={video.videoPath}
        cameraVideoUrl={video.cameraVideoPath!}
        cursorDataUrl={video.cursorDataPath!}
        cameraFollowConfig={{
          enabled: video.cameraFollowEnabled,
          offset: video.cameraFollowOffset || { x: 150, y: 150 },
          smoothing: video.cameraFollowSmoothing || 0.5,
        }}
      />
    );
  }

  // Legacy single-video player
  return <SingleVideoPlayer videoUrl={video.videoPath} />;
}
```

---

### Phase 5: Web Editor UI

#### 5.1 Flyover Control Panel

**New File**: `apps/web/components/Editor/CameraFollowControls.tsx`

**Implementation**:
```typescript
"use client";

import { useState } from "react";
import { updateVideoSettings } from "@/actions/video/settings";
import { useMutation, useQueryClient } from "@tanstack/react-query";

interface CameraFollowControlsProps {
  videoId: string;
  initialSettings: {
    enabled: boolean;
    offset: { x: number; y: number };
    smoothing: number;
  };
}

export function CameraFollowControls({
  videoId,
  initialSettings,
}: CameraFollowControlsProps) {
  const [enabled, setEnabled] = useState(initialSettings.enabled);
  const [offset, setOffset] = useState(initialSettings.offset);
  const [smoothing, setSmoothing] = useState(initialSettings.smoothing);

  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: updateVideoSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["video", videoId] });
    },
  });

  const handleSave = () => {
    updateMutation.mutate({
      videoId,
      cameraFollowEnabled: enabled,
      cameraFollowOffset: offset,
      cameraFollowSmoothing: smoothing,
    });
  };

  return (
    <div className="space-y-4 p-4 bg-gray-100 rounded-lg">
      <h3 className="font-semibold">Camera Follow Settings</h3>

      {/* Toggle */}
      <div className="flex items-center justify-between">
        <label>Enable Flyover Mode</label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="toggle"
        />
      </div>

      {enabled && (
        <>
          {/* X Offset */}
          <div>
            <label>Horizontal Offset: {offset.x}px</label>
            <input
              type="range"
              min="-500"
              max="500"
              value={offset.x}
              onChange={(e) => setOffset({ ...offset, x: Number(e.target.value) })}
              className="w-full"
            />
          </div>

          {/* Y Offset */}
          <div>
            <label>Vertical Offset: {offset.y}px</label>
            <input
              type="range"
              min="-500"
              max="500"
              value={offset.y}
              onChange={(e) => setOffset({ ...offset, y: Number(e.target.value) })}
              className="w-full"
            />
          </div>

          {/* Smoothing */}
          <div>
            <label>Smoothing: {(smoothing * 100).toFixed(0)}%</label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={smoothing}
              onChange={(e) => setSmoothing(Number(e.target.value))}
              className="w-full"
            />
          </div>
        </>
      )}

      {/* Save Button */}
      <button
        onClick={handleSave}
        disabled={updateMutation.isPending}
        className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700"
      >
        {updateMutation.isPending ? "Saving..." : "Save Changes"}
      </button>
    </div>
  );
}
```

#### 5.2 Server Action for Settings Update

**New File**: `apps/web/actions/video/settings.ts`

**Implementation**:
```typescript
"use server";

import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@cap/database/auth/session";

export async function updateVideoSettings(data: {
  videoId: string;
  cameraFollowEnabled: boolean;
  cameraFollowOffset: { x: number; y: number };
  cameraFollowSmoothing: number;
}) {
  const user = await getCurrentUser();
  if (!user?.id) throw new Error("Unauthorized");

  // Verify ownership
  const video = await db()
    .select()
    .from(videos)
    .where(eq(videos.id, data.videoId))
    .limit(1);

  if (!video[0] || video[0].ownerId !== user.id) {
    throw new Error("Unauthorized");
  }

  // Update settings
  await db()
    .update(videos)
    .set({
      cameraFollowEnabled: data.cameraFollowEnabled,
      cameraFollowOffset: data.cameraFollowOffset,
      cameraFollowSmoothing: data.cameraFollowSmoothing,
    })
    .where(eq(videos.id, data.videoId));

  return { success: true };
}
```

#### 5.3 Editor Page Integration

**Files to Modify**:
- `apps/web/app/[videoId]/edit/page.tsx` (or create if doesn't exist)

**Changes**:
```typescript
import { CameraFollowControls } from "@/components/Editor/CameraFollowControls";
import { MultiTrackPlayer } from "@/components/VideoPlayer/MultiTrackPlayer";

export default async function EditVideoPage({ params }: { params: { videoId: string } }) {
  const video = await getVideo(params.videoId);

  if (!video.cameraVideoPath) {
    return <div>This video doesn't support camera follow</div>;
  }

  return (
    <div className="grid grid-cols-3 gap-4 p-4">
      {/* Preview (2/3 width) */}
      <div className="col-span-2">
        <MultiTrackPlayer
          displayVideoUrl={video.videoPath}
          cameraVideoUrl={video.cameraVideoPath}
          cursorDataUrl={video.cursorDataPath!}
          cameraFollowConfig={{
            enabled: video.cameraFollowEnabled,
            offset: video.cameraFollowOffset || { x: 150, y: 150 },
            smoothing: video.cameraFollowSmoothing || 0.5,
          }}
        />
      </div>

      {/* Controls (1/3 width) */}
      <div>
        <CameraFollowControls
          videoId={video.id}
          initialSettings={{
            enabled: video.cameraFollowEnabled,
            offset: video.cameraFollowOffset || { x: 150, y: 150 },
            smoothing: video.cameraFollowSmoothing || 0.5,
          }}
        />
      </div>
    </div>
  );
}
```

---

## Technical Decisions

### 1. Real-time Compositor: Rust GPU (WGPU)

**Rationale**:
- Reuse existing WGPU rendering infrastructure from studio mode
- Best performance (60+ FPS) with minimal CPU usage
- Consistent architecture across recording and rendering
- Professional-grade quality
- Already have camera layer and cursor layer implementations

**Alternatives Considered**:
- Canvas 2D in frontend: Simpler but lower performance, inconsistent with existing system
- WebGL in frontend: Good performance but duplicates rendering logic

### 2. Camera Positioning: CSS Transform

**Rationale**:
- GPU-accelerated positioning via `transform: translate()`
- No video re-encoding needed (non-destructive)
- Real-time editability without re-rendering
- Simple implementation with `requestAnimationFrame`
- Widely supported, excellent performance

**Alternatives Considered**:
- WebGL compositor: More complex, overkill for simple positioning
- Video re-rendering: Destructive, slow, not editable

### 3. File Format: Separate Tracks

**Rationale**:
- Maximum flexibility for editing after recording
- Non-destructive workflow (can adjust settings without quality loss)
- Reuses proven studio mode architecture
- Easier to add new features (e.g., zoom, camera swap)
- Lower processing overhead during recording

**Alternatives Considered**:
- Single composited video: Simpler upload but not editable, requires real-time encoding during recording

### 4. Cursor Data: JSON with 100Hz Sampling

**Rationale**:
- Human-readable format for debugging
- Existing implementation from studio mode
- 100Hz (10ms) provides smooth motion
- Compressed efficiently with gzip
- Easy to parse in web player

**File Size Estimates**:
- 1 minute recording: ~12KB (100 events/sec × 60 sec × 20 bytes/event)
- 10 minute recording: ~120KB
- 1 hour recording: ~720KB

**Alternatives Considered**:
- Binary format: More efficient but harder to debug
- Lower sampling rate: Choppier motion
- WebM metadata track: Not widely supported

### 5. Synchronization: Timestamp-Based with Drift Correction

**Rationale**:
- All streams have precise timestamps (Unix epoch)
- Cursor events have millisecond precision
- Detect and correct drift > 50ms
- Robust to network buffering and seek operations

**Implementation**:
- Display video is primary time source
- Camera video syncs to display via `currentTime` adjustment
- Cursor position calculated from timestamp lookup
- Spring smoothing absorbs minor timing jitter

---

## Risks & Mitigations

### Risk 1: Real-time Compositor Performance on Low-End Machines

**Risk Level**: Medium

**Impact**:
- Choppy preview during recording
- High CPU/GPU usage
- Potential frame drops

**Mitigation**:
1. Add performance mode with lower preview FPS (30 FPS instead of 60)
2. GPU workload optimization (reuse textures, minimize state changes)
3. Fallback to simpler preview (fixed camera position during recording)
4. Monitor GPU memory usage and add warnings
5. Allow users to disable preview entirely if needed

**Detection**:
- Monitor frame timing in renderer
- Add telemetry for average FPS and frame drops
- User setting: "Performance Mode"

### Risk 2: Web Player Sync Drift Between Video Tracks

**Risk Level**: Medium

**Impact**:
- Camera and screen video out of sync
- Jarring user experience
- Cursor position doesn't match screen content

**Mitigation**:
1. Continuous drift detection (every `timeupdate` event)
2. Automatic correction when drift > 50ms
3. Buffer both videos before playing (wait for `canplaythrough`)
4. Fallback to single-track player if sync fails
5. Add sync quality indicator for debugging

**Monitoring**:
```typescript
const checkSync = () => {
  const drift = Math.abs(displayVideo.currentTime - cameraVideo.currentTime);
  if (drift > 0.05) {
    console.warn(`Sync drift detected: ${drift}s`);
    cameraVideo.currentTime = displayVideo.currentTime;
  }
};
```

### Risk 3: Cursor Data File Size for Long Recordings

**Risk Level**: Low

**Impact**:
- Large cursor.json files (hours-long recordings)
- Slow loading in web player
- Increased storage costs

**File Size Growth**:
- 1 hour: ~720KB
- 4 hours: ~2.8MB
- 8 hours: ~5.6MB

**Mitigation**:
1. Gzip compression on upload (reduces size by 80-90%)
2. Delta encoding (only store position changes, not every event)
3. Binary format for large files (Protocol Buffers or MessagePack)
4. Lazy loading: Load cursor data in chunks as video plays
5. Downsampling: Reduce to 50Hz for recordings > 1 hour

**Implementation**:
```rust
// In cursor recorder
let time_since_last = current_time - last_event.time_ms;
let position_delta = (current_pos - last_pos).magnitude();

// Only record if significant change
if time_since_last > MIN_INTERVAL || position_delta > MIN_DISTANCE {
    record_cursor_event(current_pos, current_time);
}
```

### Risk 4: Upload Failures with Multiple Files

**Risk Level**: Medium

**Impact**:
- Incomplete uploads (only some files uploaded)
- Broken videos in database
- User frustration

**Mitigation**:
1. Transactional uploads:
   ```typescript
   // Don't mark video as ready until ALL files uploaded
   const [display, camera, cursor] = await Promise.allSettled([...]);
   if (display.status !== 'fulfilled' || camera.status !== 'fulfilled') {
     throw new Error('Upload incomplete');
   }
   ```

2. Resumable uploads with retry logic (use tus protocol or similar)
3. Progress indicator for each file
4. Cleanup partial uploads on failure
5. Draft state: Video exists in DB but not public until all files ready

**Database States**:
- `uploading`: Upload in progress
- `processing`: All files uploaded, processing metadata
- `ready`: Available for viewing
- `failed`: Upload failed, show error

### Risk 5: Backward Compatibility with Existing Videos

**Risk Level**: Low

**Impact**:
- Old single-file videos break in new player
- Metadata format incompatible
- User confusion

**Mitigation**:
1. Format detection:
   ```typescript
   const isMultiTrack = video.cameraVideoPath !== null;
   return isMultiTrack
     ? <MultiTrackPlayer {...} />
     : <LegacyPlayer videoUrl={video.videoPath} />;
   ```

2. Metadata versioning:
   ```rust
   pub enum InstantRecordingMeta {
       Legacy { output_path: PathBuf },
       MultiTrack { display: ..., camera: ... },
   }
   ```

3. Database migration leaves old records intact
4. Gradual rollout: Feature flag for multi-track recording

### Risk 6: Camera Positioning Edge Cases

**Risk Level**: Low

**Impact**:
- Camera goes off-screen
- Camera overlaps important screen content
- Disorienting motion

**Mitigation**:
1. Boundary constraints (keep camera fully on-screen)
2. Smart positioning: Avoid screen edges, corners
3. User control: Manual offset adjustment
4. Preview in recording UI shows exact camera position
5. Default fallback to bottom-right if cursor data missing

**Smart Positioning Algorithm**:
```rust
fn constrain_camera_position(cursor: XY, camera_size: XY, screen_size: XY) -> XY {
    let padding = 20.0; // pixels from edge

    XY {
        x: cursor.x.clamp(padding, screen_size.x - camera_size.x - padding),
        y: cursor.y.clamp(padding, screen_size.y - camera_size.y - padding),
    }
}
```

---

## Future Enhancements

### Near-Term (3-6 months)

1. **Multiple Follow Modes**
   - Smooth: Spring-damped following (default)
   - Snappy: Tight following with minimal lag
   - Lazy: Camera moves only when cursor far from center
   - Orbit: Camera circles around cursor

2. **Cursor Activity Detection**
   - Detect idle periods (no movement)
   - Fade camera opacity during inactivity
   - Highlight camera during clicks/drags
   - Zoom camera on click events

3. **Smart Positioning**
   - AI-powered camera placement
   - Avoid covering active screen regions (text, buttons)
   - Detect face in camera feed, keep centered
   - OCR to detect important content, avoid overlap

4. **Camera Transitions**
   - Fade in/out effects
   - Smooth zoom during cursor speed changes
   - Entrance animations at recording start
   - Exit animations at recording end

### Mid-Term (6-12 months)

5. **Advanced Camera Effects**
   - Picture-in-picture border styles
   - Drop shadows and glows
   - Camera shape options (circle, rounded square, star)
   - Animated borders on click

6. **Multi-Camera Support**
   - Switch between multiple camera feeds
   - Picture-in-picture with multiple cameras
   - Auto-switch based on speaker detection
   - Manual camera selection timeline

7. **Performance Optimizations**
   - WebAssembly cursor interpolation
   - Web Workers for heavy calculations
   - Adaptive quality based on device performance
   - Pre-rendered camera position cache

8. **Analytics & Insights**
   - Heatmap of cursor activity
   - Time spent in different screen regions
   - Click frequency analysis
   - Viewer attention tracking (where camera was during viewing)

### Long-Term (12+ months)

9. **AI-Powered Features**
   - Auto-generate optimal camera paths
   - Remove camera during typing/reading periods
   - Emphasize camera during speaking
   - Voice activity detection for camera priority

10. **Collaborative Features**
    - Multiple cursors (co-presenter mode)
    - Multiple cameras following different cursors
    - Team recording with auto-switching
    - Synchronized multi-screen recordings

11. **Export Options**
    - Export with camera baked-in (flat video)
    - Export without camera
    - Export camera-only track
    - Export with custom camera animations

12. **Mobile Playback**
    - Optimized player for mobile devices
    - Touch controls for camera position
    - Reduced bandwidth mode (lower resolution camera)
    - Picture-in-picture support

---

## Implementation Timeline

### Week 1-2: Desktop Recording Foundation
- Add camera recording to instant mode
- Add cursor tracking to instant mode
- Update metadata format
- Test multi-track output

**Deliverable**: Instant recordings produce display.mp4, camera.mp4, cursor.json

### Week 3-4: Desktop Real-time Preview
- Implement camera follow position calculator
- Extend GPU renderer with camera overlay
- Update preview frame generation
- Build UI controls

**Deliverable**: Desktop app shows camera following cursor during recording

### Week 5-6: Web Backend & Upload
- Multi-file upload pipeline
- Database schema migration
- S3 storage updates
- Backward compatibility testing

**Deliverable**: Multi-track videos upload to cloud storage

### Week 7-8: Web Player
- Multi-track player component
- Cursor-based positioning logic
- Synchronization system
- Performance optimization

**Deliverable**: Web player shows flyover effect

### Week 9-10: Web Editor UI
- Flyover control panel
- Settings persistence
- Real-time preview
- Public player integration

**Deliverable**: Complete editable flyover feature

### Week 11-12: Polish & Testing
- Bug fixes
- Performance tuning
- User acceptance testing
- Documentation

**Deliverable**: Production-ready flyover feature

---

## Testing Strategy

### Desktop App Testing

**Unit Tests**:
- Camera follow position calculator
- Cursor interpolation
- Boundary constraints
- Spring physics simulation

**Integration Tests**:
- Camera recording pipeline
- Cursor recording pipeline
- Multi-track file output
- Metadata serialization

**Manual Tests**:
- Recording with flyover enabled
- Recording with flyover disabled
- Preview performance at different FPS
- Edge cases (cursor off-screen, rapid movement)

### Web App Testing

**Unit Tests**:
- Cursor position interpolation
- Spring smoothing algorithm
- Coordinate transformations
- Boundary checking

**Integration Tests**:
- Multi-file upload
- Database operations
- S3 storage
- Player synchronization

**E2E Tests** (Playwright/Cypress):
- Upload multi-track video
- Play video with flyover
- Edit flyover settings
- Save and reload settings

**Performance Tests**:
- Video sync accuracy over time
- Frame rate during playback
- Memory usage with long videos
- Cursor data loading time

### Load Testing

**Scenarios**:
- 100 concurrent uploads of multi-track videos
- 1000 concurrent players with flyover
- Large cursor.json files (1 hour+ recordings)
- S3 bandwidth limits

---

## Monitoring & Observability

### Metrics to Track

**Desktop App**:
- Preview FPS during recording
- GPU memory usage
- Recording failure rate
- File output sizes

**Web App**:
- Upload success rate
- Upload duration per file
- Player initialization time
- Sync drift frequency
- Video buffer health

**User Engagement**:
- Flyover enable rate
- Average offset settings
- Edit frequency
- Feature adoption rate

### Alerts

1. **Upload failure rate > 5%**: Check S3 connectivity
2. **Sync drift > 200ms**: Investigate player sync logic
3. **Preview FPS < 20**: GPU performance issue
4. **File size > 10MB**: Cursor data optimization needed

---

## Success Metrics

### Phase 1 (Recording)
- 90%+ of instant recordings include camera track
- <5% recording failures
- Preview maintains 30+ FPS on mid-range hardware

### Phase 2 (Playback)
- <100ms sync drift maintained during playback
- 60 FPS camera positioning
- <2 second player initialization

### Phase 3 (Adoption)
- 50%+ of users enable flyover mode
- 20%+ of users customize flyover settings
- <5% user-reported issues with sync/positioning

### Phase 4 (Performance)
- Upload completes in <30 seconds for 5-minute video
- Player loads in <3 seconds
- Cursor.json file size <100KB per minute of recording

---

## Conclusion

This implementation plan provides a comprehensive roadmap for adding the flyover camera feature to Cap's instant recording mode. The plan leverages existing studio mode architecture (separate streams, cursor tracking, GPU rendering) and adapts it for real-time preview and web playback.

**Key Strengths**:
- Reuses proven architecture from studio mode
- Non-destructive workflow (editable after recording)
- High performance (GPU-accelerated)
- Flexible and extensible
- Backward compatible

**Next Steps**:
1. Review and approve plan
2. Set up feature branch
3. Begin Phase 1 implementation (desktop recording)
4. Iterative development with regular demos
5. User testing and feedback
6. Production rollout

The feature represents a significant enhancement to Cap's recording capabilities, providing users with professional-looking recordings where their camera presence enhances rather than obscures screen content.