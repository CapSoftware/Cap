# NeoCap

## Metadata

| Field | Value |
| --- | --- |
| Project | NeoCap |
| Document Type | Project Overview |
| Status | Active development |
| Version | v0.1 |
| Created | 2026-07-17 |
| Last Updated | 2026-07-17 |
| Owner | Haowu |
| Upstream | CapSoftware/Cap at `976681e9eab9ea201eaab6b4aad56a5114bac20c` |

## Change Log

| Date | Version | Change | Author |
| --- | --- | --- |
| 2026-07-17 | v0.1 | Creates public fork overview and records the initial product direction. | Codex |

## Purpose

NeoCap is a macOS-first, local-first screen recorder for Chinese product demos and creator explainers. It builds on Cap's capture, editor, and export foundation, with product work focused on Chinese short-form captions, cursor-driven presentation, and privacy-preserving local processing.

## Current Scope

The first implementation slice makes multilingual Whisper small the default local caption model and splits word-timed captions into short display phrases using Chinese character count, pauses, and punctuation. It preserves original word timestamps so existing trimming and timeline projection continue to work.

## License Boundary

This repository retains Cap's upstream licensing. `cap-camera*` and `scap-*` crates are MIT; other upstream content is AGPLv3. NeoCap is therefore developed as an AGPL-compatible public fork. A closed-source product or hosted derivative is not an approved path unless its licensing basis is re-evaluated.

## Distribution Baseline

Initial target: macOS 14+, Apple Silicon M1+, 16 GB RAM. Distribution will be a direct Apple-notarized download, not a Mac App Store release.
