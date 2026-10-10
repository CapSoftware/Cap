import { describe, expect, it } from "vitest";
import {
	PRO_DURATION_SECONDS,
	recordingRenderEligible,
	recordingRenderSourcesReady,
} from "@/lib/render-recording-eligibility";

describe("render on recording finish", () => {
	const candidate = {
		isScreenshot: false,
		sourceType: "webMP4",
		duration: 60,
		ownerIsPro: false,
		metadata: {
			editorSources: {
				version: 1 as const,
				display: {
					key: "owner/video/raw-upload.webm",
					contentType: "video/webm" as const,
					size: 1000,
				},
			},
		},
	};

	it("renders untouched browser recordings with editor sources", () => {
		expect(recordingRenderEligible(candidate)).toBe(true);
	});

	it("skips screenshots, imports, desktop and edited or saved videos", () => {
		expect(recordingRenderEligible({ ...candidate, isScreenshot: true })).toBe(
			false,
		);
		expect(recordingRenderEligible({ ...candidate, metadata: {} })).toBe(false);
		expect(
			recordingRenderEligible({ ...candidate, sourceType: "desktopMP4" }),
		).toBe(false);
		expect(
			recordingRenderEligible({
				...candidate,
				metadata: {
					...candidate.metadata,
					webEditorProject: { version: 1, config: {}, savedAt: "now" },
				},
			}),
		).toBe(false);
		expect(
			recordingRenderEligible({
				...candidate,
				metadata: {
					...candidate.metadata,
					renderFarmSave: {
						version: 1,
						exportId: "e",
						jobId: "j",
						status: "published",
						startedAt: "now",
						outputKey: "k",
						hlsPrefix: "h",
					},
				},
			}),
		).toBe(false);
	});

	it("keeps the Pro limit Save has", () => {
		const long = { ...candidate, duration: PRO_DURATION_SECONDS };
		expect(recordingRenderEligible(long)).toBe(false);
		expect(recordingRenderEligible({ ...long, ownerIsPro: true })).toBe(true);
	});

	it("waits until the screen source is verified and uploaded", () => {
		expect(
			recordingRenderSourcesReady(candidate.metadata, 60, "processing"),
		).toBe(true);
		expect(recordingRenderSourcesReady(candidate.metadata, 60, null)).toBe(
			true,
		);
		expect(
			recordingRenderSourcesReady(candidate.metadata, 60, "uploading"),
		).toBe(false);
		expect(recordingRenderSourcesReady(candidate.metadata, null, null)).toBe(
			false,
		);
		expect(
			recordingRenderSourcesReady(
				{
					editorSources: {
						version: 1,
						display: {
							key: "owner/video/result.mp4",
							contentType: "video/mp4",
						},
					},
				},
				60,
				null,
			),
		).toBe(false);
	});
});
