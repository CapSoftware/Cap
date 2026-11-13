---
name: cap-infra
description: Host video and turn speech into text with Cap Infra. Use when the user wants to upload a video file and get a playback, share or embed link, transcribe an audio or video file or link, or check what their Cap Infra app has stored and spent. Needs the cap-infra MCP server with CAP_SECRET_KEY set.
---

# Cap Infra

Cap Infra stores and streams video and turns speech into text. It bills from prepaid credit. You reach it through the tools of the `cap-infra` MCP server.

## First steps

1. Check the tools are there. If no `videos_upload` tool exists, the server is not connected: tell the user to add it with their app's secret key as `CAP_SECRET_KEY`. Never ask them to paste the key into the chat.
2. Call `account_usage` once before the first upload or transcript. It tells you the balance, whether uploads are accepted (`upload.allowed`) and the rates.
3. Carry on when `upload.allowed` is true. Stop only when `upload.allowed` is false, or when a tool fails with a credit error (its result has `credit` and `error.code` is `out_of_credit` or `insufficient_credits`). Then give the user the `addCreditAt` link from that result. Only a signed-in person can add credit. Do not retry until they say it is done.

## Upload a video and get its links

1. `videos_upload` with the absolute `path` of the file. Set `name` if the file name is not a good title, and `userId` if the video belongs to one of the user's own users.
2. Keep the `videoId` it returns. The `shareUrl` and `embedUrl` exist right away, but the video only plays once it is ready.
3. `videos_wait` with that `videoId`. A video becomes `ready` when its first playback link exists and the other one usually follows within seconds, so by default the wait returns once both `hlsUrl` and `mp4Url` exist, together with `posterUrl`, `shareUrl` and `embedUrl`. It allows the second link 30 seconds after `ready`. Pass `output` (`mp4`, `hls` or `any`) when you need only one of them.
4. Give the user the link that fits: `shareUrl` for a page to send someone, `embedUrl` for an iframe, `hlsUrl` for their own player, `mp4Url` for a download.

If `videos_wait` returns `timedOut`, the video is still encoding, so call it again with the same `videoId`. Encoding a long video takes minutes. If your client ends tool calls after a fixed time, pass a `timeoutSeconds` below that limit.

If the result has `missing`, it is final and `timedOut` is not set. The video is `ready` and plays with the links it has, and the missing link may not be coming, so do not wait for it again. Use `hlsUrl`, `shareUrl` or `embedUrl` to play it. An MP4 is needed only for a download and for `transcripts_create` with `videoId`. If you need one of those, read the video later with `videos_get`, or transcribe the original file with `path`.

If `status` is `errored`, tell the user the `errorReason`. The file was not a video Cap could read. Delete the video with `videos_delete` unless they want to keep the record.

If the upload fails or is cancelled, the result has the `videoId`, a `videoStatus` and a `next` hint. Do what `next` says:

- `videoStatus` is `uploading`: the video exists with no file. Run `videos_upload` again with the same `path` and that `videoId`, or remove it with `videos_delete`.
- `videoStatus` is `unknown`: the upload may have completed. Call `videos_get` first. If its status is `processing` or `ready`, the file arrived, so carry on with `videos_wait` and do not upload again or delete it. Only when its status is still `uploading` may you retry or delete.

When a call was cancelled you get no result. `videos_list` shows the video, and the same rule applies: check its status before you retry or delete. Do not leave a video with no file behind.

## Transcripts

`transcripts_create` takes exactly one source:

- `url`: a public http or https link to an audio or video file.
- `path`: the absolute path of a local file, up to 2 GB.
- `videoId`: a stored video whose status is `ready` and that has an `mp4Url`. It does not need to be uploaded again. If the tool answers `video_has_no_mp4`, that video will not get one: use `path` with the original file, or `url`.

Then `transcripts_wait` with the id, and `transcripts_text` for the text. Use `transcripts_get` with `words` or `segments` only when the user needs timings, because the result is large.

If `transcripts_create` fails after the transcript was created, the result has the `transcriptId`, a `transcriptStatus` and a `next` hint. When `transcriptStatus` is `unknown`, the file was stored and the transcript may be running and may be billed, so check it with `transcripts_get` or `transcripts_wait` before anything else. Delete and create again only when `next` says the transcript did not start.

A transcript with the status `error` has an `error.code` that says why, for example `no_audio_track`, `source_unreachable` or `duration_too_long` (over 4 hours). A complete transcript with a `wordCount` of 0 means the audio had no speech.

Pass an `idempotencyKey` when you might repeat a create call for the same file, so a retry returns the first transcript and is not billed twice.

## What costs money

- Uploading and encoding a video are free.
- Stored video is billed every day by its length and resolution tier until it is deleted. `maxResolutionTier` defaults to `1080p`, the cheapest. Only raise it when the user asks for higher resolution.
- Transcripts are billed per audio hour when they complete. A transcript that fails, or is deleted before it completes, is not charged. Audio with no speech is still billed for its length.
- Every read, list and wait tool is free.
- `account_usage` has the current rates, and `account_transactions` lists every charge.

Tell the user before you do something that keeps costing money, such as uploading many videos, and delete test uploads when you are done with them.

## Deleting

`videos_delete` and `transcripts_delete` cannot be undone. Deleting a video breaks its share, embed and playback links. Ask the user before deleting anything you did not create in this conversation.

## Limits to respect

- The API limits how many requests each key can send a minute. The wait tools already pace themselves, so call a wait tool and let it run, and do not poll `videos_get` or `transcripts_get` in a loop.
- A video can be up to 36 GB and 4 hours. A transcript source can be up to 2 GB and 4 hours.
- Lists return 50 items unless you set `limit` (up to 100). When `nextOffset` is not null, pass it as `offset` for the next page.
