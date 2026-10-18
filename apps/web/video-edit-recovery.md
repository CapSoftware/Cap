# Video edit recovery

New edits write video, thumbnail and preview objects below an operation-specific `.recording/outputs/edit-<token>/` prefix. Verification precedes publication of those object keys. A failed or timed-out operation can therefore release its lock while a late worker finishes writing unreferenced objects. Late callbacks cannot publish after the operation is released.

Legacy edits wrote to shared output keys and did not persist an operation or workflow run identity. Their upload rows must not be cleared based only on age, a cancellation response, or a missing job on one media-server replica.

Before enabling legacy recovery in production:

1. Drain or disable the older web deployments and server actions that can start legacy edits. Keep the legacy recovery setting disabled during rollout.
2. Confirm that every earlier edit workflow has completed or failed and that cancelled workflows have no steps still executing. Check all deployments and media-server replicas; a single replica's missing job is insufficient.
3. Set `CAP_LEGACY_EDIT_RECOVERY=enabled` for the current web deployment only after that drain is complete.
4. The recording owner can open `/s/<videoId>/edit` and choose **Restore original**. The server rechecks workflow quiescence, verifies the immutable original's duration, and replaces only the unchanged legacy upload row with a new operation. The restored result publishes from its own output keys.

The automatic check conservatively refuses recovery while another edit workflow is pending or running. The rollout setting requires prior manual verification that cancelled runs have no remaining steps or media jobs. If those checks cannot establish quiescence, complete support recovery before enabling this path. Do not delete the original recording or clear its upload row to bypass the check.

After recovery, verify share playback, original duration, captions and a subsequent save. Disable the legacy recovery setting when the historical backlog has been handled. Existing media objects remain preserved; this change does not garbage-collect previous or abandoned edit outputs.
