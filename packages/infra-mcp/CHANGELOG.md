# Changelog

## 0.2.0

- `videos_import` creates a video from a public https link to a video file. Cap downloads and encodes it, so nothing is uploaded from your machine.
- `addCreditAt` opens the billing page of the app the key belongs to, not the console's last viewed app.
- Video results carry `durationSeconds` next to `duration`, matching transcripts.
- `transcripts_create` with a `videoId` sends the video itself instead of its MP4 link, so the transcript carries the `videoId`, takes the video's `userId` when none is given, and adds captions to the video when it completes.

## 0.1.0

- First release: upload, wait for, read, list and delete videos; create, wait for, read, list and delete transcripts; read the balance and ledger.
