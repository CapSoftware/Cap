import { ApiError, isUnanswered, type ToolError, toToolError } from "./errors";
import { sleep } from "./time";

export type WaitTuning = {
	pollIntervalMs: number;
	maxPollIntervalMs: number;
	mp4WaitMs: number;
};

export const DEFAULT_WAIT_TUNING: WaitTuning = {
	pollIntervalMs: 3_000,
	maxPollIntervalMs: 10_000,
	mp4WaitMs: 30_000,
};

const POLL_GROWTH = 1.2;
const SHORTEST_USEFUL_POLL_MS = 1_000;

export type WaitOutcome<T> = {
	settled: boolean;
	last: T | null;
	lastError: ToolError | null;
	polls: number;
	waitedSeconds: number;
};

const worthAnotherPoll = (error: unknown) =>
	isUnanswered(error) ||
	(error instanceof ApiError && (error.status === 429 || error.status >= 500));

export async function waitFor<T>(options: {
	poll: (deadlineAt: number) => Promise<T>;
	settled: (value: T) => boolean;
	tuning: WaitTuning;
	timeoutMs: number;
	signal?: AbortSignal;
	onPoll?: (value: T | null, polls: number) => void;
}): Promise<WaitOutcome<T>> {
	const startedAt = Date.now();
	const deadlineAt = startedAt + options.timeoutMs;
	let last: T | null = null;
	let lastError: ToolError | null = null;
	let polls = 0;

	const outcome = (settled: boolean): WaitOutcome<T> => ({
		settled,
		last,
		lastError,
		polls,
		waitedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
	});

	for (;;) {
		try {
			last = await options.poll(deadlineAt);
			lastError = null;
		} catch (error) {
			if (!worthAnotherPoll(error)) throw error;
			lastError = toToolError(error);
		}
		polls++;
		options.onPoll?.(last, polls);
		if (last !== null && lastError === null && options.settled(last)) {
			return outcome(true);
		}

		const told =
			lastError instanceof ApiError && lastError.retryAfterSeconds
				? lastError.retryAfterSeconds * 1000
				: 0;
		const interval = Math.max(
			told,
			Math.min(
				options.tuning.maxPollIntervalMs,
				options.tuning.pollIntervalMs * POLL_GROWTH ** (polls - 1),
			),
		);
		if (Date.now() + interval + SHORTEST_USEFUL_POLL_MS > deadlineAt) {
			return outcome(false);
		}
		await sleep(interval, options.signal);
	}
}
