import { describe, expect, it } from "vitest";
import {
	beginPart,
	createDeveloperVideoProcessingState,
	DEVELOPER_VIDEO_MAX_LOST_JOBS,
	DEVELOPER_VIDEO_PARTS,
	developerVideoPartAction,
	developerVideoRedrive,
	developerVideoStoredBytes,
	failUnfinishedParts,
	hlsRetryDelayMs,
	LOST_JOB_CONFIRM_MS,
	lostJobConfirmed,
	markPartChecked,
	markPartDispatched,
	markPartNotFound,
	releasePart,
	requeueLostPart,
	resolveDeveloperVideoStatus,
	retryUnavailableHls,
	SILENT_JOB_CHECK_MS,
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

const dispatchedPart = (
	part: "hls" | "mp4",
	token: string,
	state = fresh(),
) => {
	const next = markPartDispatched(running(part, token, state), part, {
		token,
		jobId: "job-1",
	});
	if (!next) throw new Error("part was not dispatched");
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
		).toBe("check");
	});

	it("asks about a job only after it has been quiet for three minutes", () => {
		const dispatched = dispatchedPart("hls", "t1");

		expect(SILENT_JOB_CHECK_MS).toBe(3 * 60 * 1000);
		expect(
			developerVideoPartAction(dispatched.hls, 2_000 + SILENT_JOB_CHECK_MS - 1),
		).toBe("wait");
		expect(
			developerVideoPartAction(dispatched.hls, 2_000 + SILENT_JOB_CHECK_MS),
		).toBe("check");
	});

	it("waits another three minutes after a job answered that it is still running", () => {
		const checkedAt = 2_000 + SILENT_JOB_CHECK_MS;
		const checked = markPartChecked(dispatchedPart("hls", "t1"), "hls", {
			token: "t1",
			now: checkedAt,
		});

		expect(checked?.hls).toMatchObject({
			state: "running",
			token: "t1",
			jobId: "job-1",
			startedAt: 2_000,
		});
		expect(
			checked &&
				developerVideoPartAction(
					checked.hls,
					checkedAt + SILENT_JOB_CHECK_MS - 1,
				),
		).toBe("wait");
		expect(
			checked &&
				developerVideoPartAction(checked.hls, checkedAt + SILENT_JOB_CHECK_MS),
		).toBe("check");
		expect(
			markPartChecked(dispatchedPart("hls", "t1"), "hls", {
				token: "stale",
				now: checkedAt,
			}),
		).toBeNull();
	});

	it("counts a job as lost only after it has stayed not found for a minute", () => {
		const dispatched = dispatchedPart("hls", "t1");
		const marked = markPartNotFound(dispatched, "hls", {
			token: "t1",
			now: 200_000,
		});
		if (!marked) throw new Error("not found answer was not recorded");

		expect(LOST_JOB_CONFIRM_MS).toBe(60 * 1000);
		expect(lostJobConfirmed(dispatched.hls, 9_000_000)).toBe(false);
		expect(marked.hls).toMatchObject({ state: "running", notFoundAt: 200_000 });
		expect(marked.attempts).toEqual(dispatched.attempts);
		expect(
			lostJobConfirmed(marked.hls, 200_000 + LOST_JOB_CONFIRM_MS - 1),
		).toBe(false);
		expect(lostJobConfirmed(marked.hls, 200_000 + LOST_JOB_CONFIRM_MS)).toBe(
			true,
		);
		expect(
			markPartNotFound(marked, "hls", { token: "t1", now: 250_000 }),
		).toBeNull();
		expect(
			markPartNotFound(dispatched, "hls", { token: "stale", now: 200_000 }),
		).toBeNull();
		expect(developerVideoPartAction(marked.hls, 250_000)).toBe("check");
	});

	it("forgets that a job was not found once it answers", () => {
		const marked = markPartNotFound(dispatchedPart("hls", "t1"), "hls", {
			token: "t1",
			now: 200_000,
		});
		const alive =
			marked && markPartChecked(marked, "hls", { token: "t1", now: 220_000 });

		expect(alive?.hls).toEqual({
			state: "running",
			token: "t1",
			jobId: "job-1",
			startedAt: 2_000,
			checkedAt: 220_000,
		});
		expect(alive && lostJobConfirmed(alive.hls, 9_000_000)).toBe(false);
	});

	it("sends a lost job again without spending an attempt", () => {
		const dispatched = dispatchedPart("mp4", "t1");

		const requeued = requeueLostPart(dispatched, "mp4", "t1");

		expect(dispatched.attempts.mp4).toBe(1);
		expect(requeued?.mp4).toEqual({ state: "pending" });
		expect(requeued?.attempts.mp4).toBe(0);
		expect(requeued && developerVideoPartAction(requeued.mp4, 3_000)).toBe(
			"dispatch",
		);
		expect(requeued && running("mp4", "t2", requeued).attempts.mp4).toBe(1);
		expect(requeueLostPart(dispatched, "mp4", "stale")).toBeNull();
	});

	it("stops sending a job again once it has been lost three times", () => {
		let state = fresh();
		for (let lost = 0; lost < DEVELOPER_VIDEO_MAX_LOST_JOBS; lost++) {
			const requeued = requeueLostPart(
				dispatchedPart("hls", `t${lost}`, state),
				"hls",
				`t${lost}`,
			);
			if (!requeued) throw new Error("lost job was not requeued");
			state = requeued;
		}

		expect(DEVELOPER_VIDEO_MAX_LOST_JOBS).toBe(3);
		expect(state.attempts.hls).toBe(0);
		expect(
			requeueLostPart(dispatchedPart("hls", "last", state), "hls", "last"),
		).toBeNull();
		expect(
			requeueLostPart(dispatchedPart("mp4", "t", state), "mp4", "t"),
		).not.toBeNull();
	});

	it("keeps a ready video ready while its other output is sent again", () => {
		const ready = complete("mp4", 2_000);
		const requeued = requeueLostPart(
			dispatchedPart("hls", "t-hls", ready),
			"hls",
			"t-hls",
		);

		expect(requeued?.hls).toEqual({ state: "pending" });
		expect(requeued?.mp4).toEqual({ state: "complete", output: "t" });
		expect(
			requeued && resolveDeveloperVideoStatus(requeued, "ready").status,
		).toBe("ready");
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

	it("plays the first stored poster and counts every stored poster", () => {
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

		expect(second.poster).toEqual({ output: "mp4-attempt" });
		expect(second.bytes.poster).toBe(10);
		expect(developerVideoStoredBytes(second)).toBe(30);
	});

	it("is ready as soon as the first output is finished", () => {
		const mp4Done = complete("mp4", 300, running("hls", "h"));

		expect(mp4Done.hls.state).toBe("running");
		expect(resolveDeveloperVideoStatus(mp4Done, "processing")).toEqual({
			status: "ready",
			errorReason: null,
		});

		const hlsDone = complete("hls", 500);

		expect(resolveDeveloperVideoStatus(hlsDone, "processing").status).toBe(
			"ready",
		);
	});

	it("is still processing while nothing can be played yet", () => {
		const both = running("hls", "h", running("mp4", "m"));

		expect(resolveDeveloperVideoStatus(both, "processing").status).toBe(
			"processing",
		);
		expect(resolveDeveloperVideoStatus(fresh(), "processing").status).toBe(
			"processing",
		);
	});

	it("stays ready and counts both outputs once the second one finishes", () => {
		const bothDone = complete("mp4", 300, complete("hls", 500));

		expect(resolveDeveloperVideoStatus(bothDone, "ready")).toEqual({
			status: "ready",
			errorReason: null,
		});
		expect(bothDone.hls).toEqual({ state: "complete", output: "t" });
		expect(developerVideoStoredBytes(bothDone)).toBe(800);
	});

	it("stays ready when the second output fails after the first was playable", () => {
		const mp4Done = complete("mp4", 300, running("hls", "h"));
		const hlsFailed = failUnfinishedParts(mp4Done, "encoder crashed");

		expect(hlsFailed.hls.state).toBe("failed");
		expect(resolveDeveloperVideoStatus(hlsFailed, "ready").status).toBe(
			"ready",
		);
	});

	it("sends the MP4 to the encoder first", () => {
		expect(DEVELOPER_VIDEO_PARTS).toEqual(["mp4", "hls"]);
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

	it("does not spend an encode attempt on an endpoint that is not there", () => {
		const unavailable = (from = fresh(), now = 10_000) => {
			const next = settlePart(running("hls", "t", from), "hls", "t", {
				type: "unavailable",
				reason: "not deployed",
				now,
			});
			if (!next) throw new Error("part did not settle");
			return next;
		};
		const once = unavailable();

		expect(once.attempts.hls).toBe(0);
		expect(once.unavailableChecks).toBe(1);

		const retried = retryUnavailableHls(once);
		if (!retried) throw new Error("hls was not retried");
		const twice = unavailable(retried, 20_000);

		expect(twice.attempts.hls).toBe(0);
		expect(twice.hls).toMatchObject({
			state: "unavailable",
			retryAt: 20_000 + hlsRetryDelayMs(2),
		});

		const available = retryUnavailableHls(twice);
		if (!available) throw new Error("hls was not retried");
		const firstFailure = settlePart(
			running("hls", "e1", available),
			"hls",
			"e1",
			{ type: "failed", reason: "encoder crashed" },
		);

		expect(firstFailure?.hls).toEqual({ state: "pending" });

		const secondFailure =
			firstFailure &&
			settlePart(running("hls", "e2", firstFailure), "hls", "e2", {
				type: "failed",
				reason: "encoder crashed",
			});

		expect(secondFailure?.hls).toEqual({
			state: "failed",
			reason: "encoder crashed",
		});
	});

	it("takes the duration from the encoded output only when the probe had none", () => {
		const settle = (probeDuration: number | null) =>
			settlePart(
				running("mp4", "t", {
					...fresh(),
					probe: { duration: probeDuration, width: 1280, height: 720, fps: 30 },
				}),
				"mp4",
				"t",
				{ type: "complete", bytes: 10, duration: 41.5 },
			);

		expect(settle(null)?.probe?.duration).toBe(41.5);
		expect(settle(12)?.probe?.duration).toBe(12);
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

	it("leaves a video uploaded before encoding existed as it was", () => {
		const legacy = developerVideo({
			status: "uploading",
			playbackId: null,
			processing: null,
			updatedAt: minutesAgo(60),
		});

		expect(developerVideoRedrive(legacy, now)).toBeNull();
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

	const lostPart = (hoursAgo: number) => ({
		state: "running" as const,
		token: "t",
		jobId: "job-1",
		startedAt: now - hoursAgo * 3_600_000,
	});

	it("retries adaptive streaming whose job was lost after the MP4 made the video ready", () => {
		const encoding = (hoursAgo: number) =>
			developerVideo({
				status: "ready",
				processing: processingState({
					hls: lostPart(hoursAgo),
					mp4: { state: "complete", output: "mp4-out" },
				}),
			});

		expect(developerVideoRedrive(encoding(1), now)).toBeNull();
		expect(developerVideoRedrive(encoding(7), now)).toBe("retry-hls");

		const requeued = retryUnavailableHls(
			encoding(7).processing ?? processingState(),
			now,
		);
		expect(requeued?.hls).toEqual({ state: "pending" });
		expect(requeued?.mp4).toEqual({ state: "complete", output: "mp4-out" });
	});

	it("retries an MP4 whose job was lost after adaptive streaming made the video ready", () => {
		const encoding = (hoursAgo: number) =>
			developerVideo({
				status: "ready",
				processing: processingState({
					hls: { state: "complete", output: "hls-out" },
					mp4: lostPart(hoursAgo),
				}),
			});

		expect(developerVideoRedrive(encoding(1), now)).toBeNull();
		expect(developerVideoRedrive(encoding(7), now)).toBe("retry-hls");

		const requeued = retryUnavailableHls(
			encoding(7).processing ?? processingState(),
			now,
		);
		expect(requeued?.mp4).toEqual({ state: "pending" });
		expect(requeued?.hls).toEqual({ state: "complete", output: "hls-out" });
		expect(
			retryUnavailableHls(encoding(1).processing ?? processingState(), now),
		).toBeNull();
	});

	it("picks up an output left waiting on a ready video with no workflow", () => {
		const waiting = (updatedAt: Date) =>
			developerVideo({
				status: "ready",
				updatedAt,
				processing: processingState({
					hls: { state: "complete", output: "hls-out" },
					mp4: { state: "pending" },
				}),
			});

		expect(developerVideoRedrive(waiting(minutesAgo(1)), now)).toBeNull();
		expect(developerVideoRedrive(waiting(minutesAgo(3)), now)).toBe(
			"retry-hls",
		);
		const stuck = waiting(minutesAgo(3));
		const requeued = retryUnavailableHls(
			stuck.processing ?? processingState(),
			now,
		);
		expect(requeued?.mp4).toEqual({ state: "pending" });
		expect(requeued?.startedAt).toBe(now);
	});

	it("does not claim a waiting output again on the next read", () => {
		const stuck = developerVideo({
			status: "ready",
			updatedAt: minutesAgo(30),
			processing: processingState({
				hls: { state: "complete", output: "hls-out" },
				mp4: { state: "pending" },
			}),
		});
		expect(developerVideoRedrive(stuck, now)).toBe("retry-hls");

		const requeued = retryUnavailableHls(
			stuck.processing ?? processingState(),
			now,
		);
		const claimed = { ...stuck, processing: requeued };

		expect(requeued).not.toEqual(stuck.processing);
		expect(developerVideoRedrive(claimed, now + 1_000)).toBeNull();
		expect(developerVideoRedrive(claimed, now + 119_000)).toBeNull();
		expect(developerVideoRedrive(claimed, now + 121_000)).toBe("retry-hls");
	});

	it("does not requeue a fresh job while adaptive streaming is retried", () => {
		const state = processingState({
			hls: { state: "unavailable", reason: "not deployed", retryAt: now },
			mp4: lostPart(1),
		});

		const requeued = retryUnavailableHls(state, now);

		expect(requeued?.hls).toEqual({ state: "pending" });
		expect(requeued?.mp4).toEqual(lostPart(1));
	});

	it("does not requeue outputs that finished or failed", () => {
		expect(
			retryUnavailableHls(
				processingState({
					hls: { state: "complete", output: "hls-out" },
					mp4: { state: "complete", output: "mp4-out" },
				}),
				now,
			),
		).toBeNull();
		expect(
			retryUnavailableHls(
				processingState({
					hls: { state: "failed", reason: "bad file" },
					mp4: { state: "complete", output: "mp4-out" },
				}),
				now,
			),
		).toBeNull();
	});

	it("never restarts a failed video, whose files are removed a day later", () => {
		const longAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
		const failed = developerVideo({
			status: "errored",
			errorReason: "This file has no video track.",
			updatedAt: longAgo,
			processing: processingState({
				startedAt: longAgo.getTime(),
				hls: { state: "failed", reason: "x" },
				mp4: { state: "failed", reason: "x" },
				attempts: { hls: 2, mp4: 2 },
			}),
		});

		for (const video of [
			failed,
			{ ...failed, updatedAt: new Date(now) },
			{
				...failed,
				processing: processingState({
					startedAt: longAgo.getTime(),
					hls: { state: "unavailable", reason: "x", retryAt: now - 1 },
					mp4: { state: "failed", reason: "x" },
				}),
			},
		]) {
			expect(developerVideoRedrive(video, now)).toBeNull();
			expect(
				developerVideoRedrive(video, now, { uploadCompleted: true }),
			).toBeNull();
		}
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
