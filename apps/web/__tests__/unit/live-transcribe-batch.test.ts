import { describe, expect, it } from "vitest";
import {
	LIVE_TRANSCRIBE,
	type LiveChunkCursor,
	type LiveChunkResult,
	runLiveChunkBatch,
} from "@/lib/live-transcribe-core";

type Call = {
	lastProcessedIndex: number;
	targetSeconds: number;
	languageCode: string | null;
	skipPastFailedChunk: boolean;
	withContext: boolean;
	pollUntil: number;
};

const start: LiveChunkCursor = {
	lastAudioSegmentIndex: -1,
	transcribedDurationMs: 0,
	languageCode: null,
	chunkCount: 0,
};

const chunk = (
	lastAudioSegmentIndex: number,
	extra: Partial<Extract<LiveChunkResult, { outcome: "chunk" }>> = {},
): LiveChunkResult => ({
	outcome: "chunk",
	lastAudioSegmentIndex,
	transcribedDurationMs: (lastAudioSegmentIndex + 1) * 2000,
	languageCode: "en",
	...extra,
});

function harness(
	steps: ((call: Call) => LiveChunkResult | Promise<LiveChunkResult>)[],
	{ chunkMs = 8_000 } = {},
) {
	let clock = 1_000_000;
	const calls: Call[] = [];
	const errors: unknown[] = [];
	const run = (
		cursor: LiveChunkCursor = start,
		flags = { skipPastFailedChunk: false, withContext: true },
	) =>
		runLiveChunkBatch({
			cursor,
			...flags,
			now: () => clock,
			onError: (error) => errors.push(error),
			processChunk: async (call) => {
				calls.push(call);
				const step = steps.shift();
				if (!step) throw new Error("unexpected call");
				const result = await step(call);
				clock +=
					result.outcome === "waiting" ? call.pollUntil - clock : chunkMs;
				return result;
			},
		});
	return {
		run,
		calls,
		errors,
		advance: (ms: number) => {
			clock += ms;
		},
		get clock() {
			return clock;
		},
	};
}

describe("runLiveChunkBatch", () => {
	it("keeps transcribing chunks in one batch and reports each cursor", async () => {
		const h = harness([
			() => chunk(1),
			() => chunk(4, { languageCode: "de" }),
			() => chunk(9),
			() => ({ outcome: "waiting" }),
		]);
		const result = await h.run();

		expect(result.chunks).toBe(3);
		expect(result.cursor).toEqual({
			lastAudioSegmentIndex: 9,
			transcribedDurationMs: 20_000,
			languageCode: "en",
			chunkCount: 3,
		});
		expect(h.calls.map((call) => call.lastProcessedIndex)).toEqual([
			-1, 1, 4, 9,
		]);
		expect(h.calls.map((call) => call.targetSeconds)).toEqual([
			LIVE_TRANSCRIBE.INITIAL_CHUNK_SECONDS,
			LIVE_TRANSCRIBE.INITIAL_CHUNK_SECONDS,
			LIVE_TRANSCRIBE.MAX_CHUNK_SECONDS,
			LIVE_TRANSCRIBE.MAX_CHUNK_SECONDS,
		]);
		expect(h.calls.map((call) => call.languageCode)).toEqual([
			null,
			"en",
			"en",
			"en",
		]);
	});

	it("only lets the first chunk of a batch be a retry or a skip", async () => {
		const h = harness([
			() => chunk(3),
			() => chunk(5),
			() => ({ outcome: "done" }),
		]);
		await h.run(start, { skipPastFailedChunk: true, withContext: false });

		expect(
			h.calls.map((call) => [call.skipPastFailedChunk, call.withContext]),
		).toEqual([
			[true, false],
			[false, true],
			[false, true],
		]);
	});

	it("hands a failure after progress back with the progress kept", async () => {
		const h = harness([
			() => chunk(2),
			() => ({ outcome: "chunk-failed", failedAtIndex: 2, reason: "boom" }),
		]);
		const result = await h.run();

		expect(result.chunks).toBe(1);
		expect(result.cursor.lastAudioSegmentIndex).toBe(2);
		expect(result.last).toEqual({
			outcome: "chunk-failed",
			failedAtIndex: 2,
			reason: "boom",
		});
	});

	it("rethrows a throw before any progress so the step retries", async () => {
		const h = harness([
			() => {
				throw new Error("db down");
			},
		]);
		await expect(h.run()).rejects.toThrow("db down");
	});

	it("ends with progress instead of throwing once a chunk has landed", async () => {
		const h = harness([
			() => chunk(2),
			() => {
				throw new Error("db down");
			},
		]);
		const result = await h.run();

		expect(result.chunks).toBe(1);
		expect(result.cursor.lastAudioSegmentIndex).toBe(2);
		expect(result.last).toEqual({ outcome: "progress" });
		expect(h.errors).toHaveLength(1);
	});

	it("reports a full empty poll after progress as waiting", async () => {
		const h = harness([() => chunk(2), () => ({ outcome: "waiting" })], {
			chunkMs: 0,
		});
		const result = await h.run();

		const second = h.calls[1] as Call;
		expect(second.pollUntil).toBe(
			1_000_000 + LIVE_TRANSCRIBE.MAX_POLL_MS_PER_STEP,
		);
		expect(result.last).toEqual({ outcome: "waiting" });
	});

	it("never polls past the batch deadline and does not count a cut poll as idle", async () => {
		const h = harness([() => chunk(2), () => ({ outcome: "waiting" })], {
			chunkMs: 100_000,
		});
		const result = await h.run();

		const deadline = 1_000_000 + LIVE_TRANSCRIBE.MAX_BATCH_MS_PER_STEP;
		expect((h.calls[1] as Call).pollUntil).toBe(deadline);
		expect(result.chunks).toBe(1);
		expect(result.last).toEqual({ outcome: "progress" });
	});

	it("starts no new chunk once the batch deadline has passed", async () => {
		const h = harness([() => chunk(2), () => chunk(4)], {
			chunkMs: LIVE_TRANSCRIBE.MAX_BATCH_MS_PER_STEP,
		});
		const result = await h.run();

		expect(h.calls).toHaveLength(1);
		expect(result.chunks).toBe(1);
		expect(result.last).toEqual({ outcome: "progress" });
	});

	it("gives the first chunk a full poll window", async () => {
		const h = harness([() => ({ outcome: "waiting" })]);
		const result = await h.run();

		expect((h.calls[0] as Call).pollUntil).toBe(
			1_000_000 + LIVE_TRANSCRIBE.MAX_POLL_MS_PER_STEP,
		);
		expect(result).toEqual({
			cursor: start,
			chunks: 0,
			last: { outcome: "waiting" },
		});
	});

	it("returns as soon as the final chunk completes the recording", async () => {
		const h = harness([
			() => chunk(2),
			() => chunk(3, { recordingComplete: true }),
		]);
		const result = await h.run();

		expect(result.chunks).toBe(2);
		expect(result.last).toEqual({ outcome: "done" });
	});

	it("passes terminal outcomes through", async () => {
		for (const outcome of [
			"done",
			"no-audio",
			"canonical-done",
			"gone",
		] as const) {
			const h = harness([() => chunk(2), () => ({ outcome })]);
			const result = await h.run();
			expect(result.chunks).toBe(1);
			expect(result.last).toEqual({ outcome });
		}
	});

	it("stops at the chunk and audio budgets", async () => {
		const byCount = harness([() => chunk(2), () => chunk(4)], { chunkMs: 0 });
		const countResult = await byCount.run({
			...start,
			chunkCount: LIVE_TRANSCRIBE.MAX_CHUNKS - 1,
		});
		expect(byCount.calls).toHaveLength(1);
		expect(countResult.last).toEqual({ outcome: "progress" });

		const byAudio = harness(
			[
				() =>
					chunk(2, {
						transcribedDurationMs:
							LIVE_TRANSCRIBE.MAX_TRANSCRIBED_SECONDS * 1000,
					}),
				() => chunk(4),
			],
			{ chunkMs: 0 },
		);
		const audioResult = await byAudio.run();
		expect(byAudio.calls).toHaveLength(1);
		expect(audioResult.last).toEqual({ outcome: "progress" });
	});
});
