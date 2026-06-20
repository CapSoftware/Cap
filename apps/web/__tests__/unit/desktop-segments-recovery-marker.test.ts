import { describe, expect, it } from "vitest";
import {
	buildDesktopSegmentsRecoveryMarker,
	getDesktopSegmentsManifestSignature,
	parseDesktopSegmentsRecoveryMarker,
} from "@/lib/desktop-segments-recovery-marker";

describe("desktop segment recovery markers", () => {
	it("round trips marker data", () => {
		const marker = buildDesktopSegmentsRecoveryMarker("abc123", 12345);

		expect(parseDesktopSegmentsRecoveryMarker(marker)).toEqual({
			observedAtMs: 12345,
			signature: "abc123",
		});
	});

	it("ignores unrelated marker text", () => {
		expect(
			parseDesktopSegmentsRecoveryMarker("Muxing segments into MP4..."),
		).toBe(null);
	});

	it("keeps the same signature for reordered segments", () => {
		const first = getDesktopSegmentsManifestSignature({
			version: 1,
			video_init_uploaded: true,
			audio_init_uploaded: true,
			video_segments: [
				{ index: 2, duration: 3 },
				{ index: 1, duration: 3 },
			],
			audio_segments: [{ index: 1, duration: 3 }],
			is_complete: false,
		});
		const second = getDesktopSegmentsManifestSignature({
			version: 1,
			video_init_uploaded: true,
			audio_init_uploaded: true,
			video_segments: [
				{ index: 1, duration: 3 },
				{ index: 2, duration: 3 },
			],
			audio_segments: [{ index: 1, duration: 3 }],
			is_complete: false,
		});

		expect(first).toBe(second);
	});

	it("changes signature when new segments arrive", () => {
		const first = getDesktopSegmentsManifestSignature({
			version: 1,
			video_init_uploaded: true,
			audio_init_uploaded: true,
			video_segments: [{ index: 1, duration: 3 }],
			audio_segments: [{ index: 1, duration: 3 }],
			is_complete: false,
		});
		const second = getDesktopSegmentsManifestSignature({
			version: 1,
			video_init_uploaded: true,
			audio_init_uploaded: true,
			video_segments: [
				{ index: 1, duration: 3 },
				{ index: 2, duration: 3 },
			],
			audio_segments: [{ index: 1, duration: 3 }],
			is_complete: false,
		});

		expect(first).not.toBe(second);
	});
});
