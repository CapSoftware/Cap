# Recording spool and upload recovery

The web recorder uploads display, webcam and audio media as separate files when they are selected. Each track keeps a local IndexedDB backup while multipart upload runs, so progressive upload does not require holding an entire long recording in memory. A storage failure falls back to a bounded in-memory backup. A browser may deny or evict local storage, so this is recovery protection rather than a guarantee against data loss.

Display and camera backups have the same session prefix with `-display` and `-camera` suffixes. Camera-only recordings use `-camera`. Each backup has its own heartbeat while capture is active, including while MediaRecorder is paused. Recovery ignores sessions updated within the live heartbeat window so another tab cannot offer or delete a running recording.

The video and its share URL are created before capture starts. Streaming captures upload multipart chunks during capture. Buffered browsers upload the original capture from its backup through multipart upload after Stop, and the media server processes it.

Every MediaRecorder chunk is queued to IndexedDB and the corresponding uploader. Stop waits for the recorder's final data and stop events and flushes pending local writes before completing the upload. A missing stop event has a 30-second deadline and leaves available data recoverable. The share URL is exposed while the upload finishes.

## Failure handling

- A failed live screen upload switches to the durable recording and continues capture. Stop then uploads the full saved recording to the same video.
- Failed uploads retain the spools, available downloads (screen, camera and audio separately) and the video URL. The open dashboard retries on reconnect and makes up to three additional attempts at ten-second intervals. The user can also retry without recording again; a retry sends each track that did not finish from its backup.
- An uncertain completion retains the original uploaders. A retry checks that same multipart upload; it does not create a replacement or delete the remote object. The server can reconcile S3 completion against the exact ordered part ETags and total byte count. If the provider uses an incompatible ETag format, or processing has already removed the raw source, an unconfirmed completion remains recoverable rather than being guessed successful.
- If a spool's data cannot be read back after a storage failure, recording stops and the spool stays on disk rather than publishing only the in-memory tail.
- Encoder failures expose the available recording for download or explicit upload, without automatically presenting a partial recording as successful capture. A paired take whose camera clip failed cannot be uploaded.
- New recording releases a failed attempt for a fresh take while retaining its available download and disk backups. An uncertain remote upload is left intact.
- Closing the dialog after an upload error retains the retry state. Leaving the page preserves the disk spools and suspends local uploads without aborting a possibly completed remote object. A before-unload prompt protects active capture and unsent recordings where the browser supports it.
- Successful, confirmed uploads delete the spools. Explicitly restarting an active recording discards that recording. Downloading a recovered recording does not delete its backup; dismissal does.

## Recovery after reload

Recovery scans run when the dashboard recorder mounts and once per minute. Sessions updated within the live heartbeat window are excluded because they may still belong to a live or paused recording in another tab. Recovery retains disk data until explicit dismissal.

Recovered recordings are currently offered as downloads. Resuming the same video upload after a page reload still requires persisted upload metadata and ownership coordination between tabs. In-session retries preserve the video URL.

Multipart S3 reconciliation follows the [AWS composite ETag definition](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html). The raw upload endpoint also rejects missing or repeated part numbers and checks the stored object size before acknowledging success.
