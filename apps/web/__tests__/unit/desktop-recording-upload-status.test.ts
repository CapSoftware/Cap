import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type RecordingSourceProof,
	type RecordingVerification,
	readCompletedRecordingManifest,
} from "@/lib/desktop-recording-verification";

const mocks = vi.hoisted(() => ({ head: vi.fn(), get: vi.fn() }));

vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	return {
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([{ headObject: mocks.head, getObject: mocks.get }]),
		},
	};
});
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: Effect.runPromise };
});
vi.mock("@/lib/video-storage", () => ({ decodeStorageVideo: () => ({}) }));

import {
	createVerifiedRecordingReceipt,
	type RecordingReceiptOptions,
	validateDesktopRecordingRequest,
	verifyDesktopRecordingUpload,
} from "@/lib/desktop-recording-upload-status";

type VideoRow = Parameters<typeof verifyDesktopRecordingUpload>[0];

const weakRequest: RecordingVerification = {
	version: 1,
	artifact: {
		kind: "mp4",
		fileSize: 4096,
		duration: 5,
		objectIdentity: '"same-uploaded-generation"',
	},
	requiredAudio: false,
};
const strongRequest: RecordingVerification = {
	...weakRequest,
	requiredAudio: true,
};
const output = {
	fileSize: 4096,
	duration: 5,
	width: 320,
	height: 180,
	videoCodec: "h264",
	audioCodec: "aac",
};
const immutableOutputKey =
	"owned-user/owned-video/.recording/outputs/26b763e0-d731-473e-a1f0-c41b965f4c83/856a5a30-d6f5-4e35-8ab6-394fb5b1a90f.mp4";

function video(
	receipt?: NonNullable<VideoRow["metadata"]>["desktopRecordingUpload"],
): VideoRow {
	return {
		id: "owned-video",
		ownerId: "owned-user",
		source: {
			type: "desktopMP4",
			...(receipt?.sourceProof || receipt?.sourceObjectIdentity
				? { outputKey: receipt.outputKey }
				: {}),
		},
		metadata: receipt ? { desktopRecordingUpload: receipt } : {},
	} as VideoRow;
}

function segmentedFixture(
	videoSegments: (number | { index: number; duration: number })[] = [
		{ index: 1, duration: 40 },
		{ index: 2, duration: 44.849652863 },
	],
	hasAudio = true,
) {
	const json = JSON.stringify({
		version: 2,
		video_init_uploaded: true,
		audio_init_uploaded: hasAudio,
		video_segments: videoSegments,
		audio_segments: hasAudio ? [1] : [],
		is_complete: true,
	});
	const manifest = readCompletedRecordingManifest(json);
	const request: RecordingVerification = {
		version: 1,
		artifact: { kind: "segments", manifestSha256: manifest.manifestSha256 },
		requiredAudio: false,
	};
	const sourceProof: RecordingSourceProof = {
		version: 1,
		manifestSha256: manifest.manifestSha256,
		inventorySha256: "b".repeat(64),
		sourcePreserved: true,
		videoDuration: 91.6680778,
		hasAudio,
		audioVerified: hasAudio,
	};
	const options: RecordingReceiptOptions = {
		outputKey: immutableOutputKey,
		outputSha256: "c".repeat(64),
		sourceProof,
	};
	mocks.get.mockReturnValue(Effect.succeed(Option.some(json)));
	return {
		json,
		request,
		sourceProof,
		options,
		output: {
			...output,
			duration: sourceProof.videoDuration,
			audioCodec: hasAudio ? "aac" : null,
		},
	};
}

beforeEach(() => {
	mocks.head.mockReturnValue(
		Effect.succeed({
			ContentLength: output.fileSize,
			ETag: '"same-uploaded-generation"',
		}),
	);
	mocks.get.mockReturnValue(Effect.succeed(Option.none()));
});

describe("desktop recording audio verification strength", () => {
	it("cannot upgrade an optional-audio receipt to required coverage for the same object", async () => {
		const receipt = await createVerifiedRecordingReceipt(
			video(),
			weakRequest,
			output,
			true,
			'"same-uploaded-generation"',
		);
		expect(receipt.hasAudio).toBe(true);
		expect(receipt.requiredAudioVerified).toBe(false);
		const stored = video(receipt);
		expect(
			await verifyDesktopRecordingUpload(stored, strongRequest),
		).toBeNull();
		expect(
			await verifyDesktopRecordingUpload(stored, weakRequest),
		).toMatchObject({
			fullDecode: true,
			hasAudio: true,
			requiredAudioVerified: false,
		});
	});

	it.each([undefined, false])(
		"reverifies legacy or weak audio coverage (%s) without changing optional-audio behavior",
		async (requiredAudioVerified) => {
			const stored = video({
				version: 1,
				artifact: weakRequest.artifact,
				fileSize: output.fileSize,
				duration: output.duration,
				hasAudio: true,
				fullDecode: true,
				objectIdentity: '"same-uploaded-generation"',
				...(requiredAudioVerified === undefined
					? {}
					: { requiredAudioVerified }),
			});
			expect(
				await verifyDesktopRecordingUpload(stored, strongRequest),
			).toBeNull();
			expect(
				await verifyDesktopRecordingUpload(stored, weakRequest),
			).toMatchObject({
				requiredAudioVerified: false,
			});
		},
	);

	it("returns checked required-audio coverage after a fresh strict proof is persisted", async () => {
		const receipt = await createVerifiedRecordingReceipt(
			video(),
			strongRequest,
			output,
			true,
			'"same-uploaded-generation"',
		);
		expect(receipt.requiredAudioVerified).toBe(true);
		expect(
			await verifyDesktopRecordingUpload(video(receipt), strongRequest),
		).toMatchObject({
			artifact: strongRequest.artifact,
			fullDecode: true,
			hasAudio: true,
			requiredAudioVerified: true,
		});
		mocks.head.mockReturnValue(
			Effect.succeed({ ContentLength: output.fileSize, ETag: '"replaced"' }),
		);
		expect(
			await verifyDesktopRecordingUpload(video(receipt), strongRequest),
		).toBeNull();
	});

	it("keeps full decode and an actual audio track mandatory for strict proof", async () => {
		await expect(
			createVerifiedRecordingReceipt(
				video(),
				strongRequest,
				output,
				false,
				'"same-uploaded-generation"',
			),
		).rejects.toThrow("not fully verified");
		await expect(
			createVerifiedRecordingReceipt(
				video(),
				strongRequest,
				{ ...output, audioCodec: null },
				true,
				'"same-uploaded-generation"',
			),
		).rejects.toThrow("does not match");
	});
});

describe("segmented recording preservation receipts", () => {
	it("publishes and rechecks a content-bound Drive receipt across metadata changes", async () => {
		const fixture = segmentedFixture();
		const identity = `"cap-drive-content-v1:${"d".repeat(64)}"`;
		mocks.head.mockReturnValue(
			Effect.succeed({
				ContentLength: output.fileSize,
				ETag: '"drive-file:3"',
				RecordingContentETag: identity,
			}),
		);
		const receipt = await createVerifiedRecordingReceipt(
			video(),
			fixture.request,
			fixture.output,
			true,
			identity,
			fixture.options,
		);
		expect(receipt.objectIdentity).toBe(identity);
		mocks.head.mockReturnValue(
			Effect.succeed({
				ContentLength: output.fileSize,
				ETag: '"drive-file:6"',
				RecordingContentETag: identity,
			}),
		);
		expect(
			await verifyDesktopRecordingUpload(video(receipt), fixture.request),
		).toMatchObject({ fullDecode: true, requiredAudioVerified: true });
		mocks.head.mockReturnValue(
			Effect.succeed({
				ContentLength: output.fileSize,
				ETag: '"drive-file:6"',
				RecordingContentETag: `"cap-drive-content-v1:${"e".repeat(64)}"`,
			}),
		);
		expect(
			await verifyDesktopRecordingUpload(video(receipt), fixture.request),
		).toBeNull();
	});

	it("does not reinterpret an old Drive receipt when its version changes", async () => {
		const fixture = segmentedFixture();
		const identity = `"cap-drive-content-v1:${"d".repeat(64)}"`;
		mocks.head.mockReturnValue(
			Effect.succeed({
				ContentLength: output.fileSize,
				ETag: '"drive-file:1"',
				RecordingContentETag: identity,
			}),
		);
		const receipt = await createVerifiedRecordingReceipt(
			video(),
			fixture.request,
			fixture.output,
			true,
			'"drive-file:1"',
			fixture.options,
		);
		mocks.head.mockReturnValue(
			Effect.succeed({
				ContentLength: output.fileSize,
				ETag: '"drive-file:6"',
				RecordingContentETag: identity,
			}),
		);
		expect(
			await verifyDesktopRecordingUpload(video(receipt), fixture.request),
		).toBeNull();
	});

	it.each([
		{
			name: "legacy object estimates",
			segments: [
				{ index: 1, duration: 40 },
				{ index: 2, duration: 44.849652863 },
			],
		},
		{ name: "numeric inventory", segments: [1, 2] },
		{ name: "mixed inventory", segments: [1, { index: 2, duration: 3 }] },
	])("uses preserved source timing for $name", async ({ segments }) => {
		const fixture = segmentedFixture(segments);
		const receipt = await createVerifiedRecordingReceipt(
			video(),
			fixture.request,
			fixture.output,
			true,
			'"same-uploaded-generation"',
			fixture.options,
		);
		expect(receipt).toMatchObject({
			duration: 91.6680778,
			requiredAudioVerified: true,
			outputKey: immutableOutputKey,
			sourceProof: fixture.sourceProof,
		});
		expect(
			await verifyDesktopRecordingUpload(video(receipt), fixture.request),
		).toEqual({
			version: 1,
			videoId: "owned-video",
			artifact: fixture.request.artifact,
			fileSize: output.fileSize,
			duration: 91.6680778,
			hasAudio: true,
			fullDecode: true,
			requiredAudioVerified: true,
		});
		expect(mocks.head).toHaveBeenLastCalledWith(immutableOutputKey);
	});

	it("keeps video-only recordings valid without inventing audio verification", async () => {
		const fixture = segmentedFixture([1, 2], false);
		const receipt = await createVerifiedRecordingReceipt(
			video(),
			fixture.request,
			fixture.output,
			true,
			'"same-uploaded-generation"',
			fixture.options,
		);
		expect(
			await verifyDesktopRecordingUpload(video(receipt), fixture.request),
		).toMatchObject({ hasAudio: false, requiredAudioVerified: false });
		await expect(
			createVerifiedRecordingReceipt(
				video(),
				{ ...fixture.request, requiredAudio: true },
				fixture.output,
				true,
				'"same-uploaded-generation"',
				fixture.options,
			),
		).rejects.toThrow("not fully verified");
	});

	it("requires source proof, an explicit output key, and verified remote bytes", async () => {
		const fixture = segmentedFixture();
		for (const change of [
			{ sourceProof: undefined },
			{ outputKey: undefined },
			{ outputSha256: undefined },
			{ outputSha256: "invalid" },
			{
				sourceProof: { ...fixture.sourceProof, manifestSha256: "d".repeat(64) },
			},
			{ sourceProof: { ...fixture.sourceProof, audioVerified: false } },
			{
				sourceProof: {
					...fixture.sourceProof,
					hasAudio: false,
					audioVerified: false,
				},
			},
		]) {
			await expect(
				createVerifiedRecordingReceipt(
					video(),
					fixture.request,
					fixture.output,
					true,
					'"same-uploaded-generation"',
					{ ...fixture.options, ...change },
				),
			).rejects.toThrow();
		}
		expect(mocks.head).not.toHaveBeenCalled();
	});

	it("rejects output that differs from measured source timing or loses audio", async () => {
		const fixture = segmentedFixture();
		for (const change of [{ duration: 84.849652863 }, { audioCodec: null }]) {
			await expect(
				createVerifiedRecordingReceipt(
					video(),
					fixture.request,
					{ ...fixture.output, ...change },
					true,
					'"same-uploaded-generation"',
					fixture.options,
				),
			).rejects.toThrow();
		}
	});

	it.each([
		"other-user/owned-video/result.mp4",
		"owned-user/other-video/result.mp4",
		"owned-user/owned-video/../other-video/result.mp4",
		"owned-user/owned-video/%2e%2e/other-video/result.mp4",
		"owned-user/owned-video/..\\other-video/result.mp4",
		"owned-user/owned-video/./result.mp4",
		"owned-user/owned-video//result.mp4",
		"owned-user/owned-video/result\n.mp4",
	])("refuses an unsafe output key %s", async (outputKey) => {
		const fixture = segmentedFixture();
		await expect(
			createVerifiedRecordingReceipt(
				video(),
				fixture.request,
				fixture.output,
				true,
				'"same-uploaded-generation"',
				{ ...fixture.options, outputKey },
			),
		).rejects.toThrow();
		expect(mocks.head).not.toHaveBeenCalled();
	});

	it("does not read back legacy, unpublished, or replaced output as verified", async () => {
		const fixture = segmentedFixture();
		const receipt = await createVerifiedRecordingReceipt(
			video(),
			fixture.request,
			fixture.output,
			true,
			'"same-uploaded-generation"',
			fixture.options,
		);
		expect(
			await verifyDesktopRecordingUpload(
				video({ ...receipt, sourceProof: undefined }),
				fixture.request,
			),
		).toBeNull();
		const unpublished = video(receipt);
		unpublished.source = { type: "desktopMP4" };
		expect(
			await verifyDesktopRecordingUpload(unpublished, fixture.request),
		).toBeNull();
		const replaced = video(receipt);
		replaced.source = {
			type: "desktopMP4",
			outputKey: `${immutableOutputKey}.replacement`,
		};
		expect(
			await verifyDesktopRecordingUpload(replaced, fixture.request),
		).toBeNull();
		mocks.head.mockReturnValue(
			Effect.succeed({ ContentLength: output.fileSize, ETag: '"replaced"' }),
		);
		expect(
			await verifyDesktopRecordingUpload(video(receipt), fixture.request),
		).toBeNull();
	});

	it("keeps committed proof valid after mutable originals change or disappear", async () => {
		const fixture = segmentedFixture();
		mocks.get.mockReturnValue(Effect.succeed(Option.none()));
		const receipt = await createVerifiedRecordingReceipt(
			video(),
			fixture.request,
			fixture.output,
			true,
			'"same-uploaded-generation"',
			fixture.options,
		);
		for (const content of [Option.none(), Option.some(`${fixture.json}\n`)]) {
			mocks.get.mockReturnValue(Effect.succeed(content));
			expect(
				await verifyDesktopRecordingUpload(video(receipt), fixture.request),
			).toMatchObject({ artifact: fixture.request.artifact, fullDecode: true });
		}
		expect(mocks.get).not.toHaveBeenCalled();
		expect(
			await verifyDesktopRecordingUpload(video(receipt), {
				...fixture.request,
				artifact: { kind: "segments", manifestSha256: "d".repeat(64) },
			}),
		).toBeNull();
	});

	it("still checks the exact current manifest before accepting a new upload request", async () => {
		const fixture = segmentedFixture();
		await expect(
			validateDesktopRecordingRequest(video(), fixture.request),
		).resolves.toMatchObject({ expected: { requiredAudio: true } });
		mocks.get.mockReturnValue(Effect.succeed(Option.some(`${fixture.json}\n`)));
		await expect(
			validateDesktopRecordingRequest(video(), fixture.request),
		).rejects.toThrow("manifest does not match");
	});
});

describe("immutable MP4 snapshot receipts", () => {
	it("binds the original upload identity while verifying the snapshot output", async () => {
		mocks.head.mockReturnValue(
			Effect.succeed({ ContentLength: output.fileSize, ETag: '"snapshot"' }),
		);
		const receipt = await createVerifiedRecordingReceipt(
			video(),
			strongRequest,
			output,
			true,
			'"snapshot"',
			{
				outputKey: immutableOutputKey,
				outputSha256: "c".repeat(64),
				sourceObjectIdentity: '"same-uploaded-generation"',
			},
		);
		expect(receipt.objectIdentity).toBe('"snapshot"');
		expect(receipt.artifact).toEqual(strongRequest.artifact);
		expect(
			await verifyDesktopRecordingUpload(video(receipt), strongRequest),
		).toMatchObject({ artifact: strongRequest.artifact, fullDecode: true });
		expect(mocks.head).toHaveBeenLastCalledWith(immutableOutputKey);
	});

	it("never substitutes an output identity without a bound verified snapshot", async () => {
		for (const options of [
			{},
			{
				outputKey: immutableOutputKey,
				outputSha256: "c".repeat(64),
				sourceObjectIdentity: '"wrong-original"',
			},
			{
				outputKey: immutableOutputKey,
				sourceObjectIdentity: '"same-uploaded-generation"',
			},
			{
				outputSha256: "c".repeat(64),
				sourceObjectIdentity: '"same-uploaded-generation"',
			},
		]) {
			await expect(
				createVerifiedRecordingReceipt(
					video(),
					strongRequest,
					output,
					true,
					'"snapshot"',
					options,
				),
			).rejects.toThrow();
		}
		expect(mocks.head).not.toHaveBeenCalled();
	});
});
