import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingVerification } from "@/lib/desktop-recording-verification";

const mocks = vi.hoisted(() => ({ head: vi.fn() }));

vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	return {
		Storage: {
			getAccessForVideo: () => Effect.succeed([{ headObject: mocks.head }]),
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

function video(
	receipt?: NonNullable<VideoRow["metadata"]>["desktopRecordingUpload"],
): VideoRow {
	return {
		id: "owned-video",
		ownerId: "owned-user",
		source: { type: "desktopMP4" },
		metadata: receipt ? { desktopRecordingUpload: receipt } : {},
	} as VideoRow;
}

describe("desktop recording audio verification strength", () => {
	beforeEach(() => {
		mocks.head.mockReturnValue(
			Effect.succeed({
				ContentLength: output.fileSize,
				ETag: '"same-uploaded-generation"',
			}),
		);
	});

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
