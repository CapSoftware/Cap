import { describe, expect, it } from "vitest";
import {
	assertRecordingObjectIdentity,
	readCompletedRecordingManifest,
	recordingUploadReceiptSchema,
	recordingVerificationSchema,
	validateRecordingOutput,
} from "@/lib/desktop-recording-verification";

const manifest = {
	version: 2,
	video_init_uploaded: true,
	audio_init_uploaded: true,
	video_segments: [
		{ index: 1, duration: 3 },
		{ index: 2, duration: 2 },
	],
	audio_segments: [{ index: 1, duration: 5 }],
	is_complete: true,
};

const output = {
	fileSize: 4096,
	duration: 5,
	width: 1920,
	height: 1080,
	videoCodec: "h264",
	audioCodec: "aac",
};

describe("desktop recording verification", () => {
	it("binds verification to the exact final manifest bytes", () => {
		const first = readCompletedRecordingManifest(JSON.stringify(manifest));
		const second = readCompletedRecordingManifest(
			JSON.stringify({
				...manifest,
				audio_init_uploaded: false,
				audio_segments: [],
			}),
		);
		expect(first).toMatchObject({ duration: 5, hasAudio: true });
		expect(first.manifestSha256).not.toBe(second.manifestSha256);
	});

	it.each([
		{ is_complete: false },
		{ video_init_uploaded: false },
		{ video_segments: [] },
		{ video_segments: [{ index: 2, duration: 3 }] },
		{ video_segments: [{ index: 1, duration: 0 }] },
		{
			video_segments: [
				{ index: 1, duration: 2 },
				{ index: 1, duration: 3 },
			],
		},
		{ audio_segments: [] },
		{ audio_init_uploaded: false },
	])("refuses incomplete or inconsistent manifest %j", (change) => {
		expect(() =>
			readCompletedRecordingManifest(
				JSON.stringify({ ...manifest, ...change }),
			),
		).toThrow();
	});

	it("accepts intact output and optional absent audio", () => {
		expect(() =>
			validateRecordingOutput(output, {
				fileSize: 4096,
				duration: 5,
				requiredAudio: true,
			}),
		).not.toThrow();
		expect(() =>
			validateRecordingOutput(
				{ ...output, audioCodec: null },
				{ duration: 5, requiredAudio: false },
			),
		).not.toThrow();
	});

	it.each([
		{ fileSize: 4095 },
		{ duration: 3 },
		{ duration: Number.NaN },
		{ width: 0 },
		{ audioCodec: null },
		{ videoCodec: "" },
	])("rejects incomplete or inconsistent output metadata %j", (change) => {
		expect(() =>
			validateRecordingOutput(
				{ ...output, ...change },
				{ fileSize: 4096, duration: 5, requiredAudio: true },
			),
		).toThrow();
	});

	it("refuses stale or overwritten cloud objects even when their size matches", () => {
		const expected = { fileSize: 4096, objectIdentity: "current-generation" };
		expect(() =>
			assertRecordingObjectIdentity(
				{ ContentLength: 4096, ETag: "current-generation" },
				expected,
			),
		).not.toThrow();
		for (const head of [
			{ ContentLength: 4096, ETag: "old-generation" },
			{ ContentLength: 4095, ETag: "current-generation" },
			{ ContentLength: 4096 },
		]) {
			expect(() => assertRecordingObjectIdentity(head, expected)).toThrow();
		}
	});

	it("rejects unknown versions and nonpositive MP4 identity", () => {
		const request = {
			version: 1,
			artifact: {
				kind: "mp4",
				fileSize: 4096,
				duration: 5,
				objectIdentity: '"generation"',
			},
			requiredAudio: false,
		};
		expect(recordingVerificationSchema.safeParse(request).success).toBe(true);
		expect(
			recordingVerificationSchema.safeParse({ ...request, version: 2 }).success,
		).toBe(false);
		expect(
			recordingVerificationSchema.safeParse({
				...request,
				artifact: { ...request.artifact, fileSize: 0 },
			}).success,
		).toBe(false);
		for (const objectIdentity of [
			undefined,
			"",
			'W/"weak"',
			"discovered-later",
		]) {
			expect(
				recordingVerificationSchema.safeParse({
					...request,
					artifact: { ...request.artifact, objectIdentity },
				}).success,
			).toBe(false);
		}
	});

	it("never accepts a header-only receipt as full content verification", () => {
		const receipt = {
			version: 1,
			artifact: {
				kind: "mp4",
				fileSize: 4096,
				duration: 5,
				objectIdentity: '"generation"',
			},
			fileSize: 4096,
			duration: 5,
			hasAudio: true,
			objectIdentity: '"generation"',
		};
		expect(recordingUploadReceiptSchema.safeParse(receipt).success).toBe(false);
		expect(
			recordingUploadReceiptSchema.safeParse({ ...receipt, fullDecode: false })
				.success,
		).toBe(false);
		expect(
			recordingUploadReceiptSchema.safeParse({ ...receipt, fullDecode: true })
				.success,
		).toBe(true);
		expect(
			recordingUploadReceiptSchema.safeParse({
				...receipt,
				fullDecode: true,
				objectIdentity: '"other-generation"',
			}).success,
		).toBe(false);
	});
});
