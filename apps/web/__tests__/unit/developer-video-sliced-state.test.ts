import type { DeveloperVideoProcessingState } from "@cap/database/types";
import { describe, expect, it } from "vitest";
import {
	abandonSlicedHls,
	beginPart,
	beginSlices,
	completeSlicedHls,
	DEVELOPER_VIDEO_MAX_LOST_JOBS,
	developerVideoRedrive,
	developerVideoStoredBytes,
	failUnfinishedParts,
	findRunningSlice,
	LOST_JOB_CONFIRM_MS,
	markSliceChecked,
	markSliceDispatched,
	markSliceNotFound,
	releaseSlice,
	requeueLostSlice,
	resolveDeveloperVideoStatus,
	retryUnavailableHls,
	SILENT_JOB_CHECK_MS,
	settlePart,
	settleSlice,
	slicedHlsAction,
	slicedHlsEncoding,
	slicedHlsStep,
} from "@/lib/developer-video-state";
import { processingState } from "../fixtures/developer-video";
import {
	finishedSlice,
	runningJob,
	slice,
	slicedHls,
	sliceResult,
} from "../fixtures/developer-video-slices";

const NOW = 10_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function begin(
	state: DeveloperVideoProcessingState,
	tokens: string[],
	now = NOW,
) {
	const started = beginSlices(state, { tokens, now });
	if (!started) throw new Error("no slice was due");
	return started;
}

function confirm(state: DeveloperVideoProcessingState, token: string) {
	const next = markSliceDispatched(state, { token, jobId: `job-${token}` });
	if (!next) throw new Error(`no running slice ${token}`);
	return next;
}

function complete(
	state: DeveloperVideoProcessingState,
	token: string,
	seconds: number,
	extra: { audioBytes?: number; posterBytes?: number } = {},
) {
	const next = settleSlice(state, token, {
		type: "complete",
		result: sliceResult(seconds, { audioBytes: extra.audioBytes }),
		posterBytes: extra.posterBytes,
	});
	if (!next) throw new Error(`slice ${token} did not settle`);
	return next;
}

function fail(state: DeveloperVideoProcessingState, token: string) {
	const next = settleSlice(state, token, { type: "failed", reason: "boom" });
	if (!next) throw new Error(`slice ${token} did not settle`);
	return next;
}

const jobStates = (state: DeveloperVideoProcessingState) =>
	state.sliced?.slices.map((entry) => entry.job.state);

const fresh = () => processingState({ sliced: slicedHls() });

describe("sending slices to the encoder", () => {
	it("sends the first three in playback order and holds the rest back", () => {
		const { state, begun } = begin(fresh(), ["a", "b", "c"]);

		expect(begun).toEqual([
			{ index: 0, token: "a" },
			{ index: 1, token: "b" },
			{ index: 2, token: "c" },
		]);
		expect(jobStates(state)).toEqual([
			"running",
			"running",
			"running",
			"pending",
		]);
		expect(state.sliced?.slices.map((entry) => entry.attempts)).toEqual([
			1, 1, 1, 0,
		]);
		expect(beginSlices(state, { tokens: ["d"], now: NOW })).toBeNull();
		expect(slicedHlsAction(state.sliced ?? slicedHls(), NOW)).toBe("wait");
	});

	it("sends the next slice when one finishes", () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);
		state = complete(state, "a", 20);

		const { begun } = begin(state, ["d", "e", "f"]);

		expect(begun).toEqual([{ index: 3, token: "d" }]);
	});

	it("leaves the hls part waiting and never sends the whole job while slices encode", () => {
		const { state } = begin(fresh(), ["a", "b", "c"]);

		expect(state.hls).toEqual({ state: "pending" });
		expect(slicedHlsEncoding(state)).not.toBeNull();
	});

	it("sends a slice again when its start was never confirmed", () => {
		const { state } = begin(fresh(), ["a", "b", "c"]);
		const later = NOW + 2 * MINUTE;

		const again = begin(state, ["x", "y", "z"], later);

		expect(again.begun).toEqual([
			{ index: 0, token: "x" },
			{ index: 1, token: "y" },
			{ index: 2, token: "z" },
		]);
		expect(again.state.sliced?.slices.map((entry) => entry.attempts)).toEqual([
			1, 1, 1, 0,
		]);
	});

	it("gives a slice back when the encoder was busy, at no cost to its attempts", () => {
		const { state } = begin(fresh(), ["a", "b", "c"]);

		const released = releaseSlice(state, "b");

		expect(released?.sliced?.slices[1]).toMatchObject({
			job: { state: "pending" },
			attempts: 0,
		});
		expect(releaseSlice(state, "nope")).toBeNull();
	});
});

describe("slice results arriving", () => {
	it("makes the video ready when the first slice is in", () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);
		expect(resolveDeveloperVideoStatus(state, "processing").status).toBe(
			"processing",
		);

		state = complete(state, "a", 20, { audioBytes: 300, posterBytes: 50 });

		expect(resolveDeveloperVideoStatus(state, "processing")).toEqual({
			status: "ready",
			errorReason: null,
		});
		expect(state.sliced).toMatchObject({ exposed: true, hasAudio: true });
		expect(state.poster).toEqual({ output: "a" });
		expect(state.bytes).toMatchObject({ hls: 6_000, poster: 50 });
		expect(developerVideoStoredBytes(state)).toBe(1_000 + 6_000 + 50);
	});

	it("ignores a result delivered twice", () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);
		state = complete(state, "a", 20);

		expect(
			settleSlice(state, "a", { type: "complete", result: sliceResult(20) }),
		).toBeNull();
		expect(settleSlice(state, "a", { type: "failed", reason: "x" })).toBeNull();
	});

	it("ignores a result from an attempt that was replaced", () => {
		const { state } = begin(fresh(), ["a", "b", "c"]);
		const { state: resent } = begin(state, ["x", "y", "z"], NOW + 2 * MINUTE);

		expect(
			settleSlice(resent, "a", { type: "complete", result: sliceResult(20) }),
		).toBeNull();
		expect(findRunningSlice(resent, "x")?.index).toBe(0);
	});

	it("is not ready, and offers nothing, when a later slice finishes before the first", () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);

		state = complete(state, "c", 96);
		state = complete(state, "b", 96);

		expect(resolveDeveloperVideoStatus(state, "processing").status).toBe(
			"processing",
		);
		expect(state.sliced?.exposed).toBeNull();
		expect(state.bytes.hls).toBe(11_400);

		state = complete(state, "a", 20);

		expect(resolveDeveloperVideoStatus(state, "processing").status).toBe(
			"ready",
		);
		expect(state.sliced?.exposed).toBe(true);
	});

	it("counts the poster and the audio once, with the first slice only", () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);

		state = complete(state, "b", 96, { posterBytes: 999 });
		expect(state.poster).toBeNull();
		expect(state.bytes.poster).toBe(0);

		state = complete(state, "a", 20, { audioBytes: 300, posterBytes: 50 });
		expect(state.bytes).toMatchObject({ poster: 50, hls: 5_700 * 2 + 300 });
	});

	it("holds the growing ladder back when the MP4 was already playable", () => {
		const { state: started } = begin(
			processingState({
				mp4: { state: "complete", output: "mp4-1" },
				sliced: slicedHls(),
			}),
			["a", "b", "c"],
		);

		const state = complete(started, "a", 20);

		expect(state.sliced?.exposed).toBe(false);
		expect(resolveDeveloperVideoStatus(state, "ready").status).toBe("ready");
	});

	it("keeps offering the growing ladder when the MP4 finishes after the first slice", () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);
		state = complete(state, "a", 20);
		const token = "mp4-1";
		const running = beginPart(state, "mp4", { token, now: NOW });
		if (!running) throw new Error("mp4 did not start");

		const done = settlePart(running, "mp4", token, {
			type: "complete",
			bytes: 2_000,
		});

		expect(done?.sliced?.exposed).toBe(true);
	});

	it("becomes an ordinary complete ladder once every slice is in", () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);
		state = complete(state, "a", 20, { audioBytes: 300 });
		state = complete(state, "b", 96);
		state = complete(state, "c", 96);
		expect(completeSlicedHls(state)).toBeNull();
		({ state } = begin(state, ["d"]));
		state = complete(state, "d", 88);

		expect(slicedHlsStep(state.sliced ?? slicedHls(), NOW).finalize).toBe(true);
		expect(slicedHlsAction(state.sliced ?? slicedHls(), NOW)).toBe("dispatch");

		const whole = completeSlicedHls(state);

		expect(whole?.hls).toEqual({ state: "complete", output: "sliced-1" });
		expect(whole?.sliced?.state).toBe("complete");
		expect(whole?.bytes.hls).toBe(5_700 * 4 + 300);
		expect(whole && slicedHlsEncoding(whole)).toBeNull();
		expect(whole && completeSlicedHls(whole)).toBeNull();
	});

	it("refuses a slice whose renditions differ from the others", () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);
		state = complete(state, "a", 20);
		const odd = sliceResult(96);
		odd.renditions[0] = { ...odd.renditions[0], width: 1280, height: 720 };

		const refused = settleSlice(state, "b", { type: "complete", result: odd });

		expect(refused?.sliced?.slices[1]?.job).toEqual({ state: "pending" });
		expect(refused?.sliced?.slices[1]?.result).toBeUndefined();
	});
});

describe("a slice that is lost", () => {
	it("is asked about after three quiet minutes", () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);
		state = confirm(state, "a");
		const sliced = state.sliced ?? slicedHls();

		expect(slicedHlsStep(sliced, NOW + SILENT_JOB_CHECK_MS - 1).check).toEqual(
			[],
		);
		expect(slicedHlsStep(sliced, NOW + SILENT_JOB_CHECK_MS).check).toEqual([0]);

		const checked = markSliceChecked(state, {
			token: "a",
			now: NOW + SILENT_JOB_CHECK_MS,
		});
		expect(
			slicedHlsStep(
				checked?.sliced ?? slicedHls(),
				NOW + SILENT_JOB_CHECK_MS + 1,
			).check,
		).toEqual([]);
	});

	it("is sent again without costing an attempt", () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);
		state = confirm(state, "a");
		const missing = markSliceNotFound(state, { token: "a", now: NOW });
		expect(
			missing && markSliceNotFound(missing, { token: "a", now: NOW }),
		).toBe(null);
		expect(NOW + LOST_JOB_CONFIRM_MS).toBeGreaterThan(NOW);

		const requeued = requeueLostSlice(missing ?? state, "a");

		expect(requeued?.sliced?.slices[0]).toMatchObject({
			job: { state: "pending" },
			attempts: 0,
			lostJobs: 1,
		});
		expect(requeued?.sliced?.state).toBe("encoding");
		expect(begin(requeued ?? state, ["x"]).begun).toEqual([
			{ index: 0, token: "x" },
		]);
	});

	it("that keeps vanishing ends the sliced encode and falls back to one job", () => {
		const state = processingState({
			sliced: slicedHls({
				slices: [
					slice(0, 20, {
						job: runningJob("a"),
						attempts: 1,
						lostJobs: DEVELOPER_VIDEO_MAX_LOST_JOBS,
					}),
					slice(20, null),
				],
			}),
		});

		const next = requeueLostSlice(state, "a");

		expect(next?.sliced?.state).toBe("abandoned");
		expect(next?.hls).toEqual({ state: "pending" });
		expect(next && slicedHlsEncoding(next)).toBeNull();
	});
});

describe("a slice that fails", () => {
	it("is tried once more", () => {
		const { state } = begin(fresh(), ["a", "b", "c"]);

		const failed = fail(state, "b");

		expect(failed.sliced?.state).toBe("encoding");
		expect(failed.sliced?.slices[1]).toMatchObject({
			job: { state: "pending" },
			attempts: 1,
		});
	});

	it("twice hands the whole video to a single job, which gets one attempt", () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);
		state = fail(state, "b");
		({ state } = begin(state, ["b2"]));

		const abandoned = fail(state, "b2");

		expect(abandoned.sliced).toMatchObject({ state: "abandoned" });
		expect(abandoned.sliced?.slices[1]?.job.state).toBe("failed");
		expect(abandoned.hls).toEqual({ state: "pending" });
		expect(slicedHlsEncoding(abandoned)).toBeNull();
		expect(resolveDeveloperVideoStatus(abandoned, "processing").status).toBe(
			"processing",
		);

		const whole = beginPart(abandoned, "hls", { token: "w", now: NOW });
		if (!whole) throw new Error("whole job did not start");
		const ended = settlePart(whole, "hls", "w", {
			type: "failed",
			reason: "still broken",
		});

		expect(ended?.hls).toEqual({ state: "failed", reason: "still broken" });
	});

	it("ignores the other slices' results once the single job has taken over", () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);
		state = fail(state, "b");
		({ state } = begin(state, ["b2"]));
		state = fail(state, "b2");

		expect(
			settleSlice(state, "a", { type: "complete", result: sliceResult(20) }),
		).toBeNull();
		expect(beginSlices(state, { tokens: ["x"], now: NOW })).toBeNull();
	});

	const readyThenAbandoned = () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);
		state = complete(state, "a", 20);
		state = fail(state, "b");
		({ state } = begin(state, ["b2"]));
		return fail(state, "b2");
	};

	it("after the video was ready keeps it ready and playing while the single job runs", () => {
		const abandoned = readyThenAbandoned();

		expect(resolveDeveloperVideoStatus(abandoned, "ready").status).toBe(
			"ready",
		);
		expect(abandoned.bytes.hls).toBe(5_700);
	});

	it("is replaced by the single job's ladder when that finishes", () => {
		const whole = beginPart(readyThenAbandoned(), "hls", {
			token: "w",
			now: NOW,
		});
		if (!whole) throw new Error("whole job did not start");

		const done = settlePart(whole, "hls", "w", {
			type: "complete",
			bytes: 9_000,
		});

		expect(done?.hls).toEqual({ state: "complete", output: "w" });
		expect(done?.bytes.hls).toBe(9_000);
		expect(done && resolveDeveloperVideoStatus(done, "ready").status).toBe(
			"ready",
		);
	});

	const wholeJobFailed = (state: DeveloperVideoProcessingState) => {
		const whole = beginPart(state, "hls", { token: "w", now: NOW });
		if (!whole) throw new Error("whole job did not start");
		const ended = settlePart(whole, "hls", "w", {
			type: "failed",
			reason: "This video could not be processed.",
		});
		if (!ended) throw new Error("whole job did not settle");
		return ended;
	};

	it("ends as errored when the single job fails too and there is no MP4", () => {
		const state = {
			...readyThenAbandoned(),
			mp4: { state: "failed" as const, reason: "no mp4 either" },
		};

		const ended = wholeJobFailed(state);

		expect(resolveDeveloperVideoStatus(ended, "ready")).toEqual({
			status: "errored",
			errorReason: "no mp4 either",
		});
		expect(ended.bytes.hls).toBe(0);
	});

	it("stays ready on its MP4 when the single job fails too", () => {
		const state = {
			...readyThenAbandoned(),
			mp4: { state: "complete" as const, output: "mp4-1" },
		};

		const ended = wholeJobFailed(state);

		expect(resolveDeveloperVideoStatus(ended, "ready").status).toBe("ready");
		expect(ended.bytes.hls).toBe(0);
	});

	it("stays ready while the MP4 is still being made after both failed", () => {
		const state = {
			...readyThenAbandoned(),
			mp4: runningJob("mp4-1"),
		};

		const ended = wholeJobFailed(state);

		expect(resolveDeveloperVideoStatus(ended, "ready").status).toBe("ready");
	});
});

describe("the ways a sliced encode ends early", () => {
	it("is given up when the workflow runs out of time", () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);
		state = complete(state, "a", 20);

		const failed = failUnfinishedParts(state, "Processing took too long");

		expect(failed.sliced?.state).toBe("abandoned");
		expect(failed.hls).toMatchObject({ state: "failed" });
		expect(failed.mp4).toMatchObject({ state: "failed" });
		expect(failed.bytes.hls).toBe(0);
		expect(resolveDeveloperVideoStatus(failed, "ready")).toEqual({
			status: "errored",
			errorReason: "Processing took too long",
		});
	});

	it("gives way to a single job that finished first", () => {
		const { state } = begin(fresh(), ["a", "b", "c"]);
		const whole = { ...state, hls: runningJob("w") };

		const done = settlePart(whole, "hls", "w", {
			type: "complete",
			bytes: 9_000,
		});

		expect(done?.sliced?.state).toBe("abandoned");
		expect(done?.bytes.hls).toBe(9_000);
	});

	it("can be given up directly, leaving the single job one attempt", () => {
		const abandoned = abandonSlicedHls(fresh(), "not available");

		expect(abandoned.sliced).toMatchObject({
			state: "abandoned",
			reason: "not available",
		});
		expect(abandoned.attempts.hls).toBe(1);
		expect(abandonSlicedHls(abandoned, "again")).toBe(abandoned);
	});

	it("leaves a video with no slices exactly as it was", () => {
		const plain = processingState();
		expect(abandonSlicedHls(plain, "x")).toBe(plain);
		expect(failUnfinishedParts(plain, "x").sliced).toBeUndefined();
	});
});

describe("a ready video whose sliced encode lost its workflow", () => {
	const video = (
		processing: DeveloperVideoProcessingState,
		updatedAt: number,
	) => ({
		status: "ready" as const,
		playbackId: "playback-id-0123456789ab",
		duration: 300,
		deletedAt: null,
		updatedAt: new Date(updatedAt),
		processing,
	});
	const playing = () => {
		let { state } = begin(fresh(), ["a", "b", "c"]);
		state = complete(state, "a", 20);
		return state;
	};

	it("is left alone while slices are encoding, however long they take", () => {
		const state = { ...playing(), mp4: runningJob("mp4-1") };

		expect(developerVideoRedrive(video(state, NOW), NOW + 30 * MINUTE)).toBe(
			null,
		);
	});

	it("is picked up again when no slice is encoding and nothing has moved for two minutes", () => {
		let state = playing();
		state = releaseSlice(state, "b") ?? state;
		state = releaseSlice(state, "c") ?? state;

		expect(developerVideoRedrive(video(state, NOW), NOW + MINUTE)).toBeNull();
		expect(developerVideoRedrive(video(state, NOW), NOW + 2 * MINUTE)).toBe(
			"retry-hls",
		);

		const retried = retryUnavailableHls(state, NOW + 2 * MINUTE);
		expect(retried?.startedAt).toBe(NOW + 2 * MINUTE);
		expect(retried?.sliced?.state).toBe("encoding");
	});

	it("resends a slice that has been encoding for six hours", () => {
		const state = playing();
		const later = NOW + 6 * HOUR;

		expect(developerVideoRedrive(video(state, later - 1), later)).toBe(
			"retry-hls",
		);

		const retried = retryUnavailableHls(state, later);
		expect(jobStates(retried ?? state)).toEqual([
			"complete",
			"pending",
			"pending",
			"pending",
		]);
	});

	it("is picked up again when every slice is in but the ladder was never written", () => {
		const state = processingState({
			sliced: slicedHls({
				exposed: true,
				slices: [
					finishedSlice(0, 20, "a", sliceResult(20)),
					finishedSlice(20, null, "b", sliceResult(100)),
				],
			}),
		});

		expect(developerVideoRedrive(video(state, NOW), NOW + 2 * MINUTE)).toBe(
			"retry-hls",
		);
		expect(retryUnavailableHls(state, NOW + 2 * MINUTE)).not.toBeNull();
	});
});
