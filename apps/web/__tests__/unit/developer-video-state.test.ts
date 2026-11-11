import { describe, expect, it } from "vitest";
import {
	beginPart,
	createDeveloperVideoProcessingState,
	developerVideoPartAction,
	developerVideoRedrive,
	developerVideoStoredBytes,
	failUnfinishedParts,
	hlsRetryDelayMs,
	markPartDispatched,
	releasePart,
	resolveDeveloperVideoStatus,
	retryUnavailableHls,
	settlePart,
} from "@/lib/developer-video-state";
import { developerVideo, processingState } from "../fixtures/developer-video";

const fresh = () =>
	createDeveloperVideoProcessingState({ encodeId: "e1", now: 1_000 });

const running = (part: "hls" | "mp4", token: string, state = fresh()) => {
	const next = beginPart(state, part, { token, now: 2_000 });
	if (!next) throw new Error("part did not start");
	return next;
};

const complete = (part: "hls" | "mp4", bytes: number, state = fresh()) => {
	const next = settlePart(running(part, "t", state), part, "t", {
		type: "complete",
		bytes,
	});
	if (!next) throw new Error("part did not settle");
	return next;
};

describe("developer video processing state", () => {
	it("starts with both parts pending and the video processing", () => {
		const state = fresh();

		expect(state.hls).toEqual({ state: "pending" });
		expect(state.mp4).toEqual({ state: "pending" });
		expect(resolveDeveloperVideoStatus(state, "processing").status).toBe(
			"processing",
		);
	});

	it("counts an attempt when a part starts and gives it back when the server is busy", () => {
		const started = running("hls", "t1");

		expect(started.attempts.hls).toBe(1);
		expect(releasePart(started, "hls", "t1")).toMatchObject({
			hls: { state: "pending" },
			attempts: { hls: 0 },
		});
	});

	it("does not start a part that already has a job", () => {
		const dispatched = markPartDispatched(running("hls", "t1"), "hls", {
			token: "t1",
			jobId: "job-1",
		});

		expect(dispatched?.hls).toMatchObject({ state: "running", jobId: "job-1" });
		expect(
			dispatched &&
				beginPart(dispatched, "hls", { token: "t2", now: 9_000_000 }),
		).toBeNull();
		expect(
			dispatched && developerVideoPartAction(dispatched.hls, 9_000_000),
		).toBe("wait");
	});

	it("waits two minutes for a start that was never confirmed, then restarts it without a second attempt", () => {
		const unconfirmed = running("hls", "t1");

		expect(developerVideoPartAction(unconfirmed.hls, 2_000 + 119_000)).toBe(
			"wait",
		);
		expect(
			beginPart(unconfirmed, "hls", { token: "t2", now: 2_000 + 119_000 }),
		).toBeNull();
		expect(developerVideoPartAction(unconfirmed.hls, 2_000 + 120_000)).toBe(
			"dispatch",
		);

		const restarted = beginPart(unconfirmed, "hls", {
			token: "t2",
			now: 2_000 + 120_000,
		});

		expect(restarted?.hls).toMatchObject({ state: "running", token: "t2" });
		expect(restarted?.attempts.hls).toBe(1);
	});

	it("ignores results that carry another attempt's token", () => {
		const state = running("mp4", "current");

		expect(
			settlePart(state, "mp4", "stale", { type: "complete", bytes: 10 }),
		).toBeNull();
		expect(
			settlePart(fresh(), "mp4", "current", { type: "complete", bytes: 10 }),
		).toBeNull();
	});

	it("keeps the poster from the first part that stored one", () => {
		const withPoster = (part: "hls" | "mp4", token: string, from = fresh()) => {
			const next = settlePart(running(part, token, from), part, token, {
				type: "complete",
				bytes: 10,
				posterBytes: 5,
			});
			if (!next) throw new Error("part did not settle");
			return next;
		};
		const first = withPoster("mp4", "mp4-attempt");
		const second = withPoster("hls", "hls-attempt", first);

		expect(second.poster).toEqual({ output: "mp4-attempt", bytes: 5 });
		expect(developerVideoStoredBytes(second)).toBe(25);
	});

	it("is ready only once both parts have finished", () => {
		const hlsDone = complete("hls", 500);

		expect(resolveDeveloperVideoStatus(hlsDone, "processing").status).toBe(
			"processing",
		);

		const bothDone = complete("mp4", 300, hlsDone);

		expect(resolveDeveloperVideoStatus(bothDone, "processing")).toEqual({
			status: "ready",
			errorReason: null,
		});
		expect(bothDone.hls).toEqual({ state: "complete", output: "t" });
		expect(developerVideoStoredBytes(bothDone)).toBe(800);
	});

	it("retries a failed part once, then keeps the failure", () => {
		const first = settlePart(running("mp4", "t1"), "mp4", "t1", {
			type: "failed",
			reason: "encoder crashed",
		});

		expect(first?.mp4).toEqual({ state: "pending" });

		const second =
			first &&
			settlePart(running("mp4", "t2", first), "mp4", "t2", {
				type: "failed",
				reason: "encoder crashed",
			});

		expect(second?.mp4).toEqual({ state: "failed", reason: "encoder crashed" });
	});

	it("is ready with the MP4 alone when adaptive streaming is unavailable", () => {
		const parked = settlePart(running("hls", "t1"), "hls", "t1", {
			type: "unavailable",
			reason: "not deployed",
			now: 10_000,
		});
		if (!parked) throw new Error("part did not settle");

		expect(parked.hls).toEqual({
			state: "unavailable",
			reason: "not deployed",
			retryAt: 10_000 + hlsRetryDelayMs(1),
		});
		expect(resolveDeveloperVideoStatus(parked, "processing").status).toBe(
			"processing",
		);
		expect(
			resolveDeveloperVideoStatus(complete("mp4", 300, parked), "processing")
				.status,
		).toBe("ready");
	});

	it("is errored with the reason when nothing could be produced", () => {
		const failed = failUnfinishedParts(fresh(), "Uploaded file has no video");

		expect(resolveDeveloperVideoStatus(failed, "processing")).toEqual({
			status: "errored",
			errorReason: "Uploaded file has no video",
		});
	});

	it("keeps storage URLs out of the reason shown to API callers", () => {
		const failed = failUnfinishedParts(
			fresh(),
			"Could not open https://storage.internal/bucket/key?X-Amz-Signature=abc for reading",
		);

		expect(resolveDeveloperVideoStatus(failed, "processing").errorReason).toBe(
			"Could not open [url] for reading",
		);
	});

	it("stays ready while adaptive streaming is retried", () => {
		const retried = retryUnavailableHls(
			processingState({
				hls: { state: "unavailable", reason: "not deployed", retryAt: 0 },
				mp4: { state: "complete", output: "mp4-out" },
			}),
		);

		expect(retried?.hls).toEqual({ state: "pending" });
		expect(
			retried && resolveDeveloperVideoStatus(retried, "ready").status,
		).toBe("ready");
		expect(retryUnavailableHls(fresh())).toBeNull();
	});

	it("backs retries off from 15 minutes to 6 hours", () => {
		expect(hlsRetryDelayMs(1)).toBe(15 * 60_000);
		expect(hlsRetryDelayMs(2)).toBe(30 * 60_000);
		expect(hlsRetryDelayMs(20)).toBe(6 * 60 * 60_000);
	});
});

describe("developer video redrive", () => {
	const now = Date.parse("2026-11-01T01:00:00Z");
	const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000);

	it("starts a video whose upload has just completed", () => {
		const video = developerVideo({
			status: "uploading",
			duration: null,
			processing: null,
			updatedAt: minutesAgo(0),
		});

		expect(developerVideoRedrive(video, now)).toBeNull();
		expect(developerVideoRedrive(video, now, { uploadCompleted: true })).toBe(
			"start",
		);
	});

	it("starts an uploaded video that was never picked up", () => {
		const video = developerVideo({ status: "uploading", processing: null });

		expect(
			developerVideoRedrive({ ...video, updatedAt: minutesAgo(1) }, now),
		).toBeNull();
		expect(
			developerVideoRedrive({ ...video, updatedAt: minutesAgo(3) }, now),
		).toBe("start");
	});

	it("restarts processing that has been stuck for hours", () => {
		const startedAt = (hours: number) =>
			developerVideo({
				processing: processingState({ startedAt: now - hours * 3_600_000 }),
			});

		expect(developerVideoRedrive(startedAt(1), now)).toBeNull();
		expect(developerVideoRedrive(startedAt(7), now)).toBe("start");
	});

	it("retries adaptive streaming only once its retry time has passed", () => {
		const parked = (retryAt: number) =>
			developerVideo({
				status: "ready",
				processing: processingState({
					hls: { state: "unavailable", reason: "not deployed", retryAt },
					mp4: { state: "complete", output: "mp4-out" },
				}),
			});

		expect(developerVideoRedrive(parked(now + 1), now)).toBeNull();
		expect(developerVideoRedrive(parked(now), now)).toBe("retry-hls");
	});

	it("leaves finished, errored and deleted videos alone", () => {
		const done = processingState({
			hls: { state: "complete", output: "hls-out" },
			mp4: { state: "complete", output: "mp4-out" },
		});

		expect(
			developerVideoRedrive(
				developerVideo({ status: "ready", processing: done }),
				now,
			),
		).toBeNull();
		expect(
			developerVideoRedrive(developerVideo({ status: "errored" }), now),
		).toBeNull();
		expect(
			developerVideoRedrive(
				developerVideo({
					status: "uploading",
					deletedAt: minutesAgo(1),
					updatedAt: minutesAgo(30),
				}),
				now,
				{ uploadCompleted: true },
			),
		).toBeNull();
	});
});
