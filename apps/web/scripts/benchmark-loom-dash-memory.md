# Loom DASH memory replay

This Linux-only replay calls the public `saveLoomStreamAsMp4` function with real
Mediabunny, WebCodecs, Response bodies, and independently allocated 1 MiB chunks.
It appends valid WebM Void padding to a two-second video. This isolates input-size
pressure; it does not model the decoding cost of a long or high-resolution video.
No Loom account or media server is used. A fresh Chromium profile opens
`https://example.com` to obtain a secure context, then fixture fetches are handled
in the page. Browser startup, bundle loading and fixture creation are excluded.

Install optional tooling outside the repository:

```sh
npm install --prefix /tmp/cap-loom-bench playwright-core@1.58.2
mkdir -p /tmp/cap-loom-bench/fixtures
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i testsrc2=size=320x180:rate=15 -t 2 -an \
  -c:v libvpx-vp9 -b:v 350k -g 15 -f dash -seg_duration 1 -use_template 1 \
  -init_seg_name init.webm -media_seg_name 'segment-$Number$.webm' \
  /tmp/cap-loom-bench/fixtures/manifest.mpd
```

Bundle this entry from each installed checkout, replacing the absolute import
with that checkout's path and preserving separate before/after bundles:

```ts
import { saveLoomStreamAsMp4 } from "/absolute/checkout/apps/web/lib/loom-browser-conversion";
Object.assign(globalThis, { convertFixture: saveLoomStreamAsMp4 });
```

```sh
bun build /tmp/cap-loom-bench/entry.ts --target browser --minify \
  --define 'process.env.NODE_ENV="production"' \
  --outfile /tmp/cap-loom-bench/before.js
node apps/web/scripts/benchmark-loom-dash-memory.mjs \
  /tmp/cap-loom-bench/before.js /tmp/cap-loom-bench/fixtures \
  /tmp/cap-loom-bench/before-128-0 128 /usr/bin/chromium \
  /tmp/cap-loom-bench/node_modules/playwright-core/index.mjs
```

The script writes an MP4 and JSON with bundle SHA-256, every PSS sample, sampled
peak aggregate browser-process PSS, elapsed time, fetched resources and final
progress. It requires readable `/proc/PID/smaps_rollup`. Sampling is every 20 ms;
this is neither an exact high-water mark nor JavaScript heap usage. The elapsed
measurement includes the whole conversion, output serialization and final
sampling; output file writes and browser teardown are excluded.

Run five fresh processes per revision for padding sizes 0, 32 and 128 MiB,
alternating revision order and keeping CPU affinity and limits fixed. Compare
medians and ranges, retaining every sample. Check all MP4s with ffprobe and decode
them with ffmpeg; compare decoded frame hashes rather than container hashes,
which can differ because of timestamps. Ordinary tests cover audio assembly,
out-of-order body completion, empty bodies, body failure and cancellation.

A browser without hardware AVC or AAC needs the compatibility fix in #3448
applied identically to both revisions. The reported measurements used common
commit `9ca228721f30b1deaa55ea11bc9ef99632ade8a5`, with only this PR's two-line
Blob change applied to the candidate. They do not compare unmodified main against
the compatibility fix. The optimization remains independent of #3448.
