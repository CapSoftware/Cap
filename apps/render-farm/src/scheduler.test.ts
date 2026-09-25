import { describe, expect, test } from "bun:test";
import {
	pickQueued,
	type SchedulableJob,
	type SchedulableState,
	type SchedulerOptions,
} from "./scheduler";

const options: SchedulerOptions = { headChunks: 2, fifo: false, now: 1_000 };

function job(
	id: string,
	requestedAt: number,
	chunks: number,
	overrides: Partial<SchedulableJob> = {},
): SchedulableJob {
	return {
		id,
		status: "rendering",
		requestedAt,
		chunks: Array.from({ length: chunks }, (_, index) => index),
		finishedChunks: new Set<number>(),
		runningTasks: 0,
		...overrides,
	};
}

function video(
	jobId: string,
	chunk: number,
	heldUntil?: number,
): SchedulableState {
	return { task: { kind: "video", jobId, chunk }, state: "queued", heldUntil };
}

function audio(jobId: string, section: number): SchedulableState {
	return { task: { kind: "audio", jobId, section }, state: "queued" };
}

const any = () => true;

describe("pickQueued", () => {
	test("a new job's first chunks outrank a long job's remaining work", () => {
		const long = job("long", 0, 40, {
			runningTasks: 15,
			finishedChunks: new Set([0, 1, 2]),
		});
		const short = job("short", 500, 4);
		const queue = [
			video("long", 20),
			video("long", 21),
			video("short", 0),
			video("short", 1),
		];
		expect(pickQueued(queue, [long, short], any, options)).toBe(2);
	});

	test("among non-gating work the least-served job goes first", () => {
		const busy = job("busy", 0, 40, {
			runningTasks: 10,
			finishedChunks: new Set([0, 1]),
		});
		const idle = job("idle", 100, 40, {
			runningTasks: 1,
			finishedChunks: new Set([0, 1]),
		});
		const queue = [video("busy", 30), video("idle", 30)];
		expect(pickQueued(queue, [busy, idle], any, options)).toBe(1);
	});

	test("ties go to the older job, then the earlier chunk", () => {
		const older = job("older", 0, 10);
		const newer = job("newer", 50, 10);
		const queue = [video("newer", 0), video("older", 5), video("older", 0)];
		expect(pickQueued(queue, [older, newer], any, options)).toBe(2);
	});

	test("held tasks wait until their hold expires", () => {
		const resumed = job("resumed", 0, 4);
		const queue = [video("resumed", 0, 2_000), video("resumed", 1)];
		expect(pickQueued(queue, [resumed], any, options)).toBe(1);
		expect(pickQueued(queue, [resumed], any, { ...options, now: 3_000 })).toBe(
			0,
		);
	});

	test("slots only receive the task kinds they accept", () => {
		const queue = [video("a", 0), audio("a", 0)];
		expect(
			pickQueued(queue, [job("a", 0, 2)], (kind) => kind === "audio", options),
		).toBe(1);
	});

	test("the first audio section of a job is playback-gating", () => {
		const long = job("long", 0, 40, {
			runningTasks: 20,
			finishedChunks: new Set([0, 1]),
		});
		const fresh = job("fresh", 900, 4, { runningTasks: 0 });
		const queue = [audio("long", 7), audio("fresh", 0)];
		expect(pickQueued(queue, [long, fresh], any, options)).toBe(1);
	});

	test("fifo mode takes the first eligible task", () => {
		const queue = [
			{ ...video("a", 3), state: "running" as const },
			video("a", 4),
			video("b", 0),
		];
		expect(
			pickQueued(queue, [job("a", 0, 8), job("b", 1, 2)], any, {
				...options,
				fifo: true,
			}),
		).toBe(1);
	});

	test("returns -1 when nothing is eligible", () => {
		expect(pickQueued([], [], any, options)).toBe(-1);
	});
});
