import type { User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ preferences: null as unknown }));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => [{ preferences: state.preferences }],
				}),
			}),
		}),
	}),
}));

import {
	applyMediaInputPolicyStrike,
	getMediaProcessingRejection,
	isMediaPolicyProcessingError,
	isNonMediaRawUploadKey,
	isProcessableMediaKey,
	MEDIA_INPUT_POLICY_STRIKE_WINDOW_MS,
	mediaProcessingSuspendedError,
	readMediaInputPolicyState,
	unsupportedMediaInputError,
} from "@/lib/media-processing-policy";

const ownerId = "usr_owner" as User.UserId;

describe("media processing source keys", () => {
	it.each([
		"usr/vid/raw-upload.mp4",
		"usr/vid/raw-upload.webm",
		"usr/vid/raw-upload.MOV",
		"usr/vid/raw-upload.mkv",
		"usr/vid/raw-upload.m4v",
		"usr/vid/raw-upload.avi",
		"usr/vid/raw-upload.3gp",
		"usr/vid/raw-upload.mts",
		"usr/vid/result.mp4",
		"usr/vid/agent-upload.mp4",
		"usr/vid/source/original.mp4",
		"usr/vid/.recording/outputs/reupload-1/result.mp4",
	])("processes %s", (key) => {
		expect(isProcessableMediaKey(key)).toBe(true);
	});

	it.each([
		"usr/vid/raw-upload.m3u8",
		"usr/vid/raw-upload.txt",
		"usr/vid/raw-upload.ffconcat",
		"usr/vid/raw-upload",
		"usr/vid/raw-upload.",
		"usr/vid/result.mp4/list.m3u8",
	])("does not process %s", (key) => {
		expect(isProcessableMediaKey(key)).toBe(false);
	});

	it.each([
		"usr/vid/raw-upload.m3u8",
		"usr/vid/raw-upload.M3U",
		"usr/vid/result.mpd",
		"usr/vid/list.txt",
		"usr/vid/list.ffconcat",
		"usr/vid/source/original.xml",
	])("refuses raw upload key %s", (key) => {
		expect(isNonMediaRawUploadKey(key)).toBe(true);
	});

	it.each([
		"usr/vid/output/video_recording_000.m3u8",
		"usr/vid/combined-source/stream.m3u8",
		"usr/vid/segments/manifest.json",
		"usr/vid/segments/video/segment_001.m4s",
		"usr/vid/screenshot/screen-capture.jpg",
		"usr/vid/raw-upload.webm",
		"usr/vid/result.mp4",
	])("keeps accepting %s", (key) => {
		expect(isNonMediaRawUploadKey(key)).toBe(false);
	});
});

describe("media input policy strikes", () => {
	const start = Date.parse("2026-11-01T00:00:00.000Z");

	it("suspends on the third rejected video within 24 hours", () => {
		let current = readMediaInputPolicyState(undefined);
		const first = applyMediaInputPolicyStrike(current, {
			at: start,
			videoId: "v1",
		});
		current = first.state;
		const second = applyMediaInputPolicyStrike(current, {
			at: start + 1_000,
			videoId: "v2",
		});
		current = second.state;
		expect(first.newlySuspended).toBe(false);
		expect(second.newlySuspended).toBe(false);
		expect(current.suspendedAt).toBeUndefined();

		const third = applyMediaInputPolicyStrike(current, {
			at: start + 2_000,
			videoId: "v3",
		});
		expect(third.newlySuspended).toBe(true);
		expect(third.state.suspendedAt).toBe(new Date(start + 2_000).toISOString());
	});

	it("counts each video once", () => {
		let current = readMediaInputPolicyState(undefined);
		for (let index = 0; index < 5; index++) {
			current = applyMediaInputPolicyStrike(current, {
				at: start + index,
				videoId: "same-video",
			}).state;
		}
		expect(current.strikes).toHaveLength(1);
		expect(current.suspendedAt).toBeUndefined();
	});

	it("drops strikes older than the window", () => {
		const current = {
			strikes: [
				{ at: start, videoId: "v1" },
				{ at: start + 1, videoId: "v2" },
			],
		};
		const next = applyMediaInputPolicyStrike(current, {
			at: start + MEDIA_INPUT_POLICY_STRIKE_WINDOW_MS + 10,
			videoId: "v3",
		});
		expect(next.newlySuspended).toBe(false);
		expect(next.state.strikes).toEqual([
			{ at: start + MEDIA_INPUT_POLICY_STRIKE_WINDOW_MS + 10, videoId: "v3" },
		]);
	});

	it("stays suspended without re-triggering", () => {
		const suspendedAt = new Date(start).toISOString();
		const next = applyMediaInputPolicyStrike(
			{ strikes: [], suspendedAt },
			{ at: start + 5, videoId: "v9" },
		);
		expect(next.newlySuspended).toBe(false);
		expect(next.state.suspendedAt).toBe(suspendedAt);
	});

	it("ignores malformed stored state", () => {
		expect(
			readMediaInputPolicyState({
				mediaInputPolicy: {
					strikes: [{ at: "x" }, null, { at: 1, videoId: "v1" }],
					suspendedAt: 5,
				},
			}),
		).toEqual({ strikes: [{ at: 1, videoId: "v1" }] });
		expect(readMediaInputPolicyState("not-json")).toEqual({ strikes: [] });
	});

	it("recognises stored policy errors", () => {
		expect(isMediaPolicyProcessingError(unsupportedMediaInputError)).toBe(true);
		expect(
			isMediaPolicyProcessingError(
				`FatalError: Step failed: ${mediaProcessingSuspendedError}`,
			),
		).toBe(true);
		expect(isMediaPolicyProcessingError("Server is busy")).toBe(false);
		expect(isMediaPolicyProcessingError(null)).toBe(false);
	});
});

describe("getMediaProcessingRejection", () => {
	beforeEach(() => {
		state.preferences = null;
	});

	it("allows media sources for active accounts", async () => {
		await expect(
			getMediaProcessingRejection({
				ownerId,
				rawFileKey: "usr/vid/raw-upload.mp4",
			}),
		).resolves.toBeNull();
	});

	it("rejects non-media sources before checking the account", async () => {
		state.preferences = {
			mediaInputPolicy: { strikes: [], suspendedAt: "2026-11-01T00:00:00Z" },
		};
		await expect(
			getMediaProcessingRejection({
				ownerId,
				rawFileKey: "usr/vid/raw-upload.m3u8",
			}),
		).resolves.toBe(unsupportedMediaInputError);
	});

	it("rejects every source while processing is suspended", async () => {
		state.preferences = {
			notifications: { pauseComments: true },
			mediaInputPolicy: { strikes: [], suspendedAt: "2026-11-01T00:00:00Z" },
		};
		await expect(
			getMediaProcessingRejection({
				ownerId,
				rawFileKey: "usr/vid/result.mp4",
			}),
		).resolves.toBe(mediaProcessingSuspendedError);
		await expect(getMediaProcessingRejection({ ownerId })).resolves.toBe(
			mediaProcessingSuspendedError,
		);
	});
});
