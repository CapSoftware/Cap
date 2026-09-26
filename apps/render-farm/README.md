# Render farm

Server-side Studio export, split across a fleet of NVIDIA GPU workers. An export
is cut into chunks that render in parallel; each chunk streams playable HLS
segments while it renders and uploads its share of the final MP4 directly into
one S3 multipart upload.

- **Coordinator** (`RF_ROLE=coordinator`): plans chunks and audio sections,
  schedules them fairly across exports, assembles the MP4 header, keeps the HLS
  playlist, and journals state to S3 so a restart resumes in-flight exports.
- **Worker** (`RF_ROLE=worker`, one per GPU): runs render slots (`cap-render-farm`
  engine processes from `crates/render-farm`) and CPU audio lanes.

## How an export flows

1. `POST /jobs {recording, resolution, fps, compression}` indexes the source
   MP4s (cached per recording), probes the project with the engine, and plans
   chunks sized by render work (~6 s per chunk) plus a short lead-in chunk so the
   first HLS segment never waits on a large download.
2. Workers fetch only the byte ranges their chunk needs into sparse local files,
   render with frames kept on the GPU end to end (NVDEC → CUDA → Vulkan
   compositing → CUDA → NVENC), publish 2 s fMP4 segments per finished GOP, and
   upload the chunk's MP4 bytes as multipart parts.
3. Audio (Studio Sound) renders in sections split on clip boundaries, on the
   coordinator's and workers' spare CPU cores.
4. When every chunk is in, the coordinator writes the `moov` as part 1 and
   completes the upload. `hlsUrl` is playable within a few seconds of the
   request; the MP4 is ready when the job reports `ready`.

## Reliability

- Chunks that fail retry with backoff; slow or stuck chunks are hedged on another
  slot, and a worker-side watchdog kills engines that stop reporting progress.
- A worker that restarts or stops heartbeating has its tasks requeued; `SIGTERM`
  drains a worker (finishes running tasks, takes no new ones) before it exits.
- Job acceptance waits for a durable request receipt; interrupted planning is
  replayed after restart. The plan and each video dispatch reservation are durable
  before work is sent.
  Each chunk has six disjoint part ranges (five original attempts plus a hedge).
  Retries never wrap around to old ranges; exhausting the range budget fails the
  export. A restart restores reservations, attempt numbers and hedge ownership.
- Accepted video results and audio packets are durable before acknowledgement or
  use by another task. Concurrent copies cannot replace the first accepted result.
- Recovery recognizes a completed MP4 by its expected size and header, including
  when S3 committed completion but its response was lost.
- Failed playlist writes retain the unpublished cursor and retry without waiting
  for another segment report. The final journal marker waits for the HLS end list.
- Probes run serially with a two-minute execution deadline and one fresh-process
  retry after exit or timeout; a failed engine does not poison future exports.
- `RF_REQUIRE_GPU=1` refuses a chunk whose engine fell back to software decoding
  or rendering, so it is retried on a healthy engine instead of slowing the job.
- Finished jobs keep a summary for `RF_JOB_RETENTION_MS`; a job with no progress
  for `RF_JOB_STALL_MS` fails and releases its upload.

## Deployment

```sh
docker build -f apps/render-farm/Dockerfile -t cap-render-farm .
```

Before upgrading from the initial unversioned journal format, stop accepting new
exports and let the active jobs finish. That format did not durably reserve upload
ranges, so version 2 refuses to resume those unfinished uploads and aborts them.
Jobs created with version 2 can resume across subsequent coordinator restarts.

Run workers with the NVIDIA container toolkit (`--gpus all`) and `--init`.
Give the coordinator a bucket-scoped IAM role (or keys), a shared `RF_TOKEN`,
and a lifecycle rule on the bucket that aborts incomplete multipart uploads and
expires `hls/` and `jobs/` objects.

| Variable | Default | Role |
| --- | --- | --- |
| `RF_ROLE` | `worker` | `coordinator` or `worker` |
| `RF_TOKEN` | required | Bearer token between clients, coordinator and workers |
| `RF_S3_ENDPOINT`, `RF_S3_BUCKET`, `RF_S3_REGION` | required | Bucket holding recordings, outputs, HLS and the journal |
| `RF_S3_IMDS` | off | Use the instance role instead of `RF_S3_ACCESS_KEY_ID`/`RF_S3_SECRET_ACCESS_KEY` |
| `RF_MEDIA_S3_BUCKET` (`_REGION`, `_ENDPOINT`) | the `RF_S3_*` bucket | Bucket holding recordings and receiving exports; may belong to another account whose policy grants the farm's role. Objects are written `bucket-owner-full-control`; the journal stays in `RF_S3_BUCKET` |
| `RF_CALLBACK_HOSTS` | none | Host suffixes a job's `callbackUrl` may use (e.g. `vercel.app,cap.so`) |
| `RF_CALLBACK_SECRET` | `RF_TOKEN` | HMAC key for callback signatures |
| `RF_TRANSCODE_ENCODER` | `h264_nvenc` | Encoder for source transcodes (`libx264` without a GPU) |
| `RF_COORDINATOR_URL` | `http://127.0.0.1:8080` | Coordinator address (workers) and its advertised URL |
| `RF_SLOTS` / `RF_AUDIO_SLOTS` | `5` / `4` | Render slots and audio lanes per worker (tuned on one L4 with 8 vCPUs) |
| `RF_LOCAL_AUDIO_SLOTS` | `2` | Audio lanes on the coordinator |
| `RF_CHUNK_WORK_SECONDS` | `6` | Target render work per chunk |
| `RF_SLOT_MEGAPIXELS_PER_SEC` | `450` | Planning estimate of one slot's throughput |
| `RF_HLS` / `RF_HLS_SEGMENT_SECONDS` | on / `2` | Progressive HLS output |
| `RF_LEAD_IN_SECONDS` | `4` | Length of the lead-in chunk |
| `RF_JOURNAL` | on | Resume unfinished jobs after a coordinator restart |
| `RF_MAX_ACTIVE_JOBS` | `32` | Further `POST /jobs` get `429` |
| `RF_MAX_SOURCE_FILES` / `RF_MAX_SOURCE_BYTES` | `4096` / 256 GiB | Largest recording manifest a job accepts |
| `RF_MAX_EXPORT_SECONDS` | 4 h | Longest export a job accepts |
| `RF_SOURCE_KEY_PREFIXES` | none | Shared bucket prefixes a manifest may reference besides its own recording |
| `RF_JOB_STALL_MS` / `RF_JOB_RETENTION_MS` | 10 min / 1 h | Job watchdog and summary retention |
| `RF_STALL_MS` | `30000` | Worker engine watchdog |
| `RF_DRAIN_MS` | 15 min | Longest a `SIGTERM` drain may take |
| `CAP_DECODER_READAHEAD` | `8` | Frames each decoder decodes ahead of the renderer |
| `RF_HOT_SWAP` | off | Development: pull the engine, app and tuning from the bucket's `bin/` pointers |

## Product integration

A job can export a recording that lives in the product's bucket:

- `sourceRoot` names the recording's folder (e.g. `<owner>/<video>/`); manifest
  keys may point anywhere inside it, so a small render project (manifest,
  project config, cursors) can sit beside the untouched source files.
- `output: { key, hlsPrefix }` places the MP4 and HLS segments inside that
  folder instead of `out/` and `hls/`.
- `callbackUrl` receives the job's outcome once it is ready or failed, signed
  `x-render-farm-signature: sha256=<hex HMAC of the body>`. `GET /jobs/:id`
  reports `progress` (0-1), `hlsSegments` and a freshly signed `hlsUrl`.

Browser recordings are WebM with no seek index and few keyframes, so chunks
cannot start in the middle of them. A manifest entry with `transcodeFrom`
names such a source; the coordinator first has a GPU slot re-encode it into
the entry's `key` as H.264 with a keyframe every second (kept and reused for
later exports). `POST /transcodes {sourceRoot, source, output}` starts one
ahead of time (e.g. when the editor opens) and `GET /transcodes/:id` reports
it.

## Development

```sh
bun test apps/render-farm
bun run --cwd apps/render-farm typecheck
cargo test -p cap-render-farm
```
