# Recording spool and upload recovery

All web recording pipelines keep a local IndexedDB spool when browser storage is available. Captured chunks are persisted in order, and the in-memory backup is disabled while the spool is healthy. A storage failure falls back to an in-memory backup. A browser may deny or evict local storage, so this is recovery protection rather than a guarantee against data loss.

The video and its share URL are created before capture starts. Chromium's streaming WebM path uploads multipart chunks during capture. Buffered browsers retain their existing capture format and upload the original WebM or MP4 through multipart upload after Stop. The media server prepares playback and thumbnails; browser-side conversion is no longer required to finish a web recording.

Stop waits for the recorder's final data and stop events and flushes pending local writes before completing the upload. A missing stop event has a 30-second deadline and leaves available data recoverable. The share URL is exposed while the upload finishes, and opens automatically after the server confirms receipt. Playback can still be processing at that point.

## Failure handling

- A failed live upload can switch to the durable recording and continue capture. Stop then uploads the full saved recording to the same video.
- Failed uploads retain the spool, available download, and video URL. The open dashboard retries on reconnect and makes up to three additional attempts at ten-second intervals. The user can also retry without recording again.
- An uncertain completion retains the original uploader. A manual retry checks that same multipart upload; it does not create a replacement or delete the remote object. A later missing-session response remains uncertain. The server can reconcile S3 completion against the exact ordered part ETags and total byte count. If the provider uses an incompatible ETag format, or processing has already removed the raw source, an unconfirmed completion remains recoverable rather than being guessed successful.
- Encoder failures expose the available recording for download or explicit upload, without automatically presenting a partial recording as successful capture.
- New recording releases a failed attempt for a fresh take while retaining its available download and disk backup. An uncertain remote upload is left intact.
- Closing the dialog after an upload error retains the retry state. Leaving the page preserves the disk spool and suspends local uploads without aborting a possibly completed remote object. A before-unload prompt protects active capture and unsent recordings where the browser supports it.
- Successful, confirmed uploads delete the spool. Explicitly restarting an active recording discards that recording. Downloading a recovered recording does not delete its backup; dismissal does.

## Recovery after reload

Recovery scans run when the dashboard recorder mounts and once per minute. Sessions updated within three minutes are excluded because they may still belong to a live or paused recording in another tab; active sessions send a heartbeat every fifteen seconds. Recovery retains disk data until explicit dismissal.

Recovered recordings are currently offered as downloads. Resuming the same video upload after a page reload still requires persisted upload metadata and ownership coordination between tabs. In-session retries preserve the video URL.

Multipart S3 reconciliation follows the [AWS composite ETag definition](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html). The raw upload endpoint also rejects missing or repeated part numbers and checks the stored object size before acknowledging success.
