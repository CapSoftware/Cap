# Ordered S3 upload presign prefetch

Production path: `upload_file` constructs the per-upload `LivePartTransport`, then `upload_file_parts` reads and validates chunks and calls presign/PUT. The candidate overlaps just the next metadata URL request with the current body transfer. It still has one PUT and one current payload buffer; no next-chunk pre-read. Deferred failed-part retries refresh their URL. Cancellation drops both pending futures, and progress is emitted as soon as a PUT succeeds. Drive URLs (including provider-misidentified URLs) and Content-MD5 uploads retain serialized presigning.

## Measurement scope

These are complete multipart-stage transfers over real loopback HTTP sockets with the repository's existing synthetic WAN model: shared100Mbps link,50/150ms injected RTT,20ms presign service time,2MiB congestion window cap and2RTT modeled TCP/TLS handshake. TLS is modeled, not actually negotiated. This is not a production WAN, authenticated service, whole Share/export, or GUI runtime measurement. All fixtures contain deterministic synthetic bytes; no production account, upload, auth state or paid service is accessed.

Host: Linux x86_64 AMD EPYC9V74,2CPUquota, affinity CPUs0/1. Rust1.99.1, release opt-level3/thinLTO/1codegenunit; reqwest0.12.28. No compilation overlaps timed runs. Five independent processes/version/case, alternating order.60MB files use12 parts at the normal5MiB minimum;1MB controls use one part. Timed: full `upload_file_parts`, starting with first presign through sorted completed parts. Fixture creation, client construction and cleanup are excluded, consistently with the function's production boundary.

| Workload / injected RTT | Baseline median (range) | Candidate median (range) | Reduction |
|---|---:|---:|---:|
| 60MB /150ms | 10.291576s (10.284179–10.317204) | 8.441429s (8.399854–9.612411) | 17.98% |
| 60MB /50ms | 6.816929s (6.805402–6.856186) | 6.360399s (6.029581–6.399385) | 6.70% |
| 1MB /150ms | 1.830158s (1.830075–1.830794) | 1.830086s (1.829971–1.830620) | 0.00% |
| 1MB /0ms | 0.104672s (0.104343–0.105081) | 0.104667s (0.104534–0.105060) | 0.00% |

All40 processes verified complete received bytes, ordered unique PUTs, sorted part numbers/ETags/sizes, monotonic progress ending at0.99, and maximum one active PUT. Single-part controls show no meaningful change. Baseline used2 TCP connections; candidate used2 or3, with all higher-count runs retained. Reused clients do not promise a fixed socket count. The third connection was not conclusively attributed; a separate diagnostic rerun used2. Do not claim exactly2 sockets or real-WAN gains.

## Validation

15 candidate multipart tests passed in the isolated exact-source release harness (8 original plus7 new);2 ignored in the ordinary suite, with the latency probe explicitly executed40 times for the comparison. Tests cover byte-exact chunk input, cache reuse/order, failed presign/PUT and fresh deferred retries, original error preservation, progress before a pending presign, cancellation/drop, provider-misidentified Drive URLs, Content-MD5 exclusion and replacement-fingerprint rejection before the next PUT. The original serial2-connection test is unchanged.

The full GPUI application and all test targets compile with `cargo check --locked -p cap-desktop-gpui --bin cap-gpui --tests`, after the current official `scripts/prepare-gpui-dependency.sh` stack. Full GUI tests are not executed here. Strict Clippy under Rust1.99.1 reports the same78 existing diagnostics on unmodified baseline and candidate, with zero new normalized diagnostics; no suppressions or unrelated lint fixes are included. Formatting and diff checks pass.

The standalone crates copy the actual production multipart functions/types/replacement guards, actual MD5/Drive identity helpers, authentication error enum/formatter and the existing/new loopback multipart tests. The authenticated application transport is compiled in the full GPUI check; the isolated benchmark uses the existing MockPartTransport over real loopback sockets. Snapshots, source manifests, frozen-binary hashes and raw measurements are included. Baseline and candidate package names differ to prevent shared-target artifact collisions.

## Reproduce

No FFmpeg, GPU, authentication or production service is needed for the standalone proof; Rust and a C build toolchain for TLS dependencies suffice. On Linux:

```sh
python3 build-proof.py
python3 run-comparison.py
```

The scripts use two Cargo jobs and CPU affinity0/1 for this host; select valid CPUs or remove `taskset` on other hosts. Results create fresh logs, samples and summaries in this directory; use a clean copy for each repeated experiment.

The in-repository ignored benchmark also now compares fresh clients, shared serial clients and shared clients with presign prefetch:

```sh
./scripts/prepare-gpui-dependency.sh
cd apps/desktop-gpui
CAP_UPLOAD_BENCH_MB=60 cargo test --release --bin cap-gpui multipart_mock_network_benchmark -- --ignored --nocapture
```

Baseline commit: `fb453e3e3032f8b976378cd477e676eeb32f7bbc`. Candidate commit: `375eeec6ef7a32df0933727b0dc34ad17d1cc2d3`.
