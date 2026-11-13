# Changelog

## 0.2.0

- `videos_import` creates a video from a public https link to a video file. Cap downloads and encodes it, so nothing is uploaded from your machine.
- `addCreditAt` opens the billing page of the app the key belongs to, not the console's last viewed app.
- Video results carry `durationSeconds` next to `duration`, matching transcripts.
- A transcript made from a `videoId` without a `userId` takes the video's `userId`.

## 0.1.0

- First release: upload, wait for, read, list and delete videos; create, wait for, read, list and delete transcripts; read the balance and ledger.
