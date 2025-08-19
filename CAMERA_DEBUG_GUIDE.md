# Camera Preview Debug Guide

This guide helps you diagnose and fix invisible camera preview issues in Cap.

## Quick Diagnosis

### 1. Check Camera Feed Status
First, verify if the camera feed itself is working:

```rust
// In your Rust code
if let Ok(working) = camera_preview.test_camera_feed().await {
    if !working {
        println!("❌ Camera feed not working!");
    } else {
        println!("✅ Camera feed is working");
    }
}
```

### 2. Run Comprehensive Diagnostics
Get a full diagnostic report:

```rust
let report = CameraDiagnostics::diagnose_camera_preview(&camera_preview, &window).await?;
println!("{}", report);
```

### 3. Apply Quick Fixes
Try automatic fixes:

```rust
let fixes = CameraDiagnostics::quick_fix_camera_preview(&camera_preview, &window).await?;
for fix in fixes {
    println!("Applied: {}", fix);
}
```

## From Frontend (JavaScript/TypeScript)

You can also debug from the frontend using these Tauri commands:

```typescript
import { invoke } from '@tauri-apps/api/tauri';

// Test camera feed
const feedResult = await invoke('test_camera_feed');
console.log('Camera feed:', feedResult);

// Get loading state
const loadingState = await invoke('get_camera_loading_state');
console.log('Loading state:', loadingState);

// Force show window
const showResult = await invoke('force_show_camera_window');
console.log('Force show:', showResult);

// Full diagnostics
const diagnostics = await invoke('diagnose_camera_preview');
console.log('Diagnostics:', diagnostics);

// Auto-fix issues
const autoFix = await invoke('debug_camera_auto_fix');
console.log('Auto-fix results:', autoFix);
```

## Common Issues and Solutions

### Issue 1: Camera Preview Never Appears

**Symptoms:**
- Camera preview window spawns but remains invisible
- No errors in console
- Camera device is working

**Diagnosis:**
```bash
# Check logs for these patterns:
RUST_LOG=info cargo run
# Look for:
# - "Camera feed is working" vs "No camera frames received"
# - "Window forced visible" 
# - "GPU converter initialized" vs "GPU converter failed"
```

**Solutions:**
1. **Force show window:**
   ```rust
   camera_preview.force_show_window(&window)?;
   ```

2. **Check frame reception:**
   ```rust
   // Should see frames being received
   let working = camera_preview.test_camera_feed().await?;
   ```

3. **Verify GPU converter:**
   ```bash
   # Look for GPU converter initialization in logs
   # If failed, check GPU drivers and WGPU compatibility
   ```

### Issue 2: Black Screen (Window Visible but No Content)

**Symptoms:**
- Camera window is visible
- Window shows black/empty content
- Camera feed is working

**Diagnosis:**
```bash
# Check for these log patterns:
# - "GPU conversion failed, falling back to ffmpeg"
# - "No texture data provided for render"
# - "Buffer too small" or texture upload errors
```

**Solutions:**
1. **Check texture upload:**
   ```rust
   // Look for "Uploading texture" logs every ~1 second
   // If missing, frame conversion is failing
   ```

2. **Verify GPU surface:**
   ```bash
   # Look for "Configuring GPU surface" logs
   # Surface should be larger than 0x0
   ```

3. **Test with solid frame:**
   ```rust
   // Should see gray loading frame initially
   // If not, rendering pipeline has issues
   ```

### Issue 3: Stuck in Loading State

**Symptoms:**
- Camera shows gray loading screen indefinitely
- `is_loading()` returns `true`
- No frame processing occurs

**Diagnosis:**
```rust
let is_loading = camera_preview.is_loading();
println!("Loading state: {}", is_loading);
```

**Solutions:**
1. **Check camera frame reception:**
   ```bash
   # Should see "Camera finished loading, received first frame" log
   # If not, camera may not be sending frames
   ```

2. **Verify frame conversion:**
   ```bash
   # Look for successful GPU or FFmpeg conversion logs
   # Conversion failures prevent loading completion
   ```

### Issue 4: Window Positioning Issues

**Symptoms:**
- Camera preview appears off-screen
- Window size is 0x0
- Cannot find preview window

**Solutions:**
1. **Reset window size and position:**
   ```rust
   window.set_size(tauri::LogicalSize::new(400, 300))?;
   window.set_position(tauri::LogicalPosition::new(100, 100))?;
   ```

2. **Check window status:**
   ```typescript
   const status = await invoke('get_window_status');
   console.log('Window status:', status);
   ```

## Debug Logging

Enable comprehensive logging:

```bash
# Full debug output
RUST_LOG=cap_desktop=debug,cap_gpu_converters=info cargo run

# Camera-specific logs only
RUST_LOG=cap_desktop::camera=debug cargo run

# GPU converter logs
RUST_LOG=cap_gpu_converters=debug cargo run
```

### Key Log Messages to Look For

**✅ Good signs:**
```
✓ Camera feed is working
✓ GPU camera converter initialized successfully
✓ Camera finished loading, received first frame
✓ Window forced visible
Uploading texture #N: 1280x720, stride: 5120, buffer size: 3686400 bytes
Surface presented #N
```

**❌ Problem indicators:**
```
✗ No camera frames received for 5.0s
✗ GPU conversion failed, falling back to ffmpeg
✗ Failed to force show window
No texture data provided for render #N
Buffer too small: X bytes, expected at least Y bytes
```

## Integration with Your App

### 1. Add Commands to Tauri App

```rust
// In your main.rs or lib.rs
use commands::camera_debug::*;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            test_camera_feed,
            get_camera_loading_state,
            force_show_camera_window,
            diagnose_camera_preview,
            quick_fix_camera_preview,
            debug_camera_auto_fix,
            get_window_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 2. Frontend Debug Panel

Create a debug panel in your frontend:

```typescript
// DebugPanel.tsx
import { invoke } from '@tauri-apps/api/tauri';

export function CameraDebugPanel() {
    const runDiagnostics = async () => {
        const result = await invoke('debug_camera_auto_fix');
        console.log('Debug result:', result);
        alert(JSON.stringify(result, null, 2));
    };

    return (
        <div className="debug-panel">
            <h3>Camera Debug Tools</h3>
            <button onClick={runDiagnostics}>
                🔧 Auto-Debug Camera
            </button>
        </div>
    );
}
```

### 3. Automatic Health Checks

Add periodic health checks:

```typescript
// Camera health monitoring
setInterval(async () => {
    const feedStatus = await invoke('test_camera_feed');
    const loadingState = await invoke('get_camera_loading_state');
    
    if (!feedStatus.success) {
        console.warn('Camera feed issue detected:', feedStatus.message);
        // Optionally trigger auto-fix
        await invoke('quick_fix_camera_preview');
    }
}, 10000); // Check every 10 seconds
```

## Performance Impact

The debugging functions are designed to be lightweight:

- **Low impact:** `test_camera_feed()`, `is_loading()`, `get_window_status()`
- **Medium impact:** `force_show_window()`, `quick_fix_camera_preview()`
- **High impact:** `test_camera_preview_full()`, `diagnose_camera_preview()`

Use high-impact functions only during active debugging.

## Troubleshooting Checklist

When camera preview is invisible:

- [ ] **Camera feed working?** → `test_camera_feed()`
- [ ] **Window visible?** → `get_window_status()`
- [ ] **Still loading?** → `get_camera_loading_state()`
- [ ] **GPU working?** → Check logs for GPU converter messages
- [ ] **Frame conversion working?** → Look for texture upload logs
- [ ] **Window positioned correctly?** → Check window size/position
- [ ] **Try force show** → `force_show_camera_window()`
- [ ] **Apply quick fixes** → `quick_fix_camera_preview()`

If none of these work, run the full diagnostic suite and check the detailed logs.