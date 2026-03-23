# Recording Spool

The streaming recorder now keeps a durable local spool in browser storage while it uploads raw chunks.

This exists to keep three properties aligned:

- progressive multipart upload stays fast
- the browser tab does not retain the whole recording in RAM
- failures after capture can still recover a full local recording

The current lifecycle is:

1. `useWebRecorder` creates a `RecordingSpool` for the `streaming-webm` pipeline before `MediaRecorder.start`.
2. Each `dataavailable` chunk is sent to both the multipart uploader and the local spool.
3. The streaming path disables the in-memory recorder backup once the durable spool is available.
4. On upload or processing failure, the recorder rebuilds a local blob from the spool for the error download.
5. On success or explicit cleanup, the spool is deleted.

This keeps the recorder biased toward reliability without pushing long recordings back into an unbounded memory path.

The spool now also handles orphan recovery after a tab crash or reload:

1. Sessions are listed from IndexedDB when the dialog hook initializes.
2. Each orphaned session is rebuilt into a blob and immediately removed from storage.
3. The dialog exposes the recovered downloads while idle so the user can save them before starting again.

Deleting recovered sessions during discovery is intentional. The spool is a crash-recovery handoff, not a permanent browser archive, so we prefer one clear recovery opportunity over accumulating stale local recordings indefinitely.
