# Browser recording backup

The web recorder uploads display and webcam media as separate files when both are selected. Each recording keeps a local browser backup while multipart upload runs, so progressive upload does not require holding an entire long recording in memory.

Display and camera backups have the same session prefix with `-display` and `-camera` suffixes. Camera-only recordings use `-camera`. Each backup has its own heartbeat while capture is active, including while MediaRecorder is paused. Recovery ignores sessions updated within the live heartbeat window so another tab cannot offer or delete a running recording.

Every MediaRecorder chunk is queued to IndexedDB and the corresponding uploader. A local camera write failure stops the paired capture. If IndexedDB is unavailable before capture, the camera clip uses an in-memory fallback and the recorder warns the user. A failed or uncertain paired upload exposes separate screen and camera downloads and leaves durable backups available for recovery after the dialog closes. Successful uploads and explicit restarts remove their local backups.

Recovery lists idle sessions, reconstructs their blobs, and offers downloads. A recovered session is removed only when the user dismisses it or downloads it. The web editor still requires the paired source files, project configuration service, and native preview/export bridge before this capture path can provide desktop editor parity.
