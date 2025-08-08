# Cap Web

Cap Web is our Next.js application for sharing screen recordings.
It is located at `./apps/web`.

# Cap Desktop

Cap Desktop is our Tauri application for recording and editing screen recordings.
It is located at `./apps/desktop`.

## Crates

Cap Desktop consumes a lot of crates inside `./crates`.
These crates have names prefixed with `cap-`, but their folders are not.
Some crates have READMEs you can use to learn more about their specific APIs.

## Recording

Cap allows recording in Studio Mode, where the screen, camera, and audio are recorded as separate files, or Instant Mode, where they are all combined and uploaded to Cap Web in real time.
A combination of crates are used to achieve this:
- Our `cap-camera*` crates are used for capturing frames from cameras.
- The external `scap` crate is used for capturing frames from the screen.
- The external `cpal` crate is used for capturing audio from microphones.
- `cap-media` contains binding code for all of the above, connecting some of them with FFmpeg
- `cap-media-encoders` contains encoders for various audio and video formats, powered by various media frameworks
- `cap-recording` uses `cap-media` and `cap-media-encoders` to implement instant and studio recording

## Editing

Studio recordings may be edited to add things like backgrounds, zooms, and cuts. Rendering is done using `wgpu` in `cap-rendering`.
`cap-editor` is the code that runs and communicates with the editor UI to coordinate playback and state mangement.

## Exporting

Studio recordings can be exported to single files, and optionally uploaded to Cap Web. `cap-export` uses `cap-rendering` and `cap-media-encoders` to render the recording into a single file.
