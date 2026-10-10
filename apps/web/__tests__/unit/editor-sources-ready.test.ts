import type { VideoMetadata } from "@cap/database/types";
import { describe, expect, it } from "vitest";
import { editorSourcesUploaded } from "@/lib/editor-sources-ready";

const display = {
	key: "user/video/raw-upload.mp4",
	contentType: "video/mp4" as const,
	size: 1024,
};
const camera = {
	key: "user/video/camera-upload.mp4",
	contentType: "video/mp4" as const,
	size: 2048,
	objectIdentity: null,
	offsetMs: 0,
};

const metadata = (sources: object): VideoMetadata =>
	({ editorSources: { version: 1, ...sources } }) as VideoMetadata;

describe("editorSourcesUploaded", () => {
	it("opens a processing recording once its sources are uploaded", () => {
		expect(
			editorSourcesUploaded(metadata({ display, camera }), "processing"),
		).toBe(true);
		expect(
			editorSourcesUploaded(metadata({ display }), "generating_thumbnail"),
		).toBe(true);
	});

	it("waits while anything is still uploading or failed", () => {
		expect(editorSourcesUploaded(metadata({ display }), "uploading")).toBe(
			false,
		);
		expect(editorSourcesUploaded(metadata({ display }), "error")).toBe(false);
		expect(editorSourcesUploaded(metadata({ display }), null)).toBe(false);
	});

	it("waits for a display or camera source without a verified size", () => {
		expect(
			editorSourcesUploaded(
				metadata({ display: { ...display, size: undefined } }),
				"processing",
			),
		).toBe(false);
		expect(
			editorSourcesUploaded(
				metadata({ display, camera: { ...camera, size: 0 } }),
				"processing",
			),
		).toBe(false);
		expect(editorSourcesUploaded(null, "processing")).toBe(false);
	});

	it("leaves an edit that is being processed to its recovery screen", () => {
		expect(
			editorSourcesUploaded(
				{
					...metadata({ display }),
					editProcessing: {},
				} as unknown as VideoMetadata,
				"processing",
			),
		).toBe(false);
	});
});
