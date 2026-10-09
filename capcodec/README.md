# capcodec

Tov source for the H.264 screen encoder used when `CAP_MEDIA_VIDEO_ENCODER=capcodec`. This directory is the `main` snapshot (`517b7e6`). Cap CI leaves it unbuilt. Mount a binary as described in `apps/media-server/capcodec.md`.

`capcodec.bundle` stores every branch. Restore it with `git clone capcodec.bundle`. The media-server flag runs `main`. `rd-next`, `ssim`, `intra-rd`, and `dashboard` stay on their own branches.

Benchmark notes keep the commit ids of the builds that were measured. In this bundle those commits are `76be2a6` (measured as `00fecf7`), `82b7840` (measured as `fff504d`), `42e1d3b` (measured as `d0cce5e`, branch `rd-next`), and `6610051` (measured as `b72e995`, branch `ssim`).
