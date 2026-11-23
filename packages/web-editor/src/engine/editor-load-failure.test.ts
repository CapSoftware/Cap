import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	isNetworkFailure,
	LOAD_RETRY_DELAYS_MS,
	loadFailureMessage,
	withLoadRetries,
} from "./editor-load-failure";

describe("withLoadRetries", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("retries a failing load with backoff until it succeeds", async () => {
		const attemptsAt: number[] = [];
		const releases: number[] = [];
		const start = Date.now();
		const result = withLoadRetries(
			async () => {
				attemptsAt.push(Date.now() - start);
				if (attemptsAt.length < 3) throw new TypeError("Failed to fetch");
				return "loaded";
			},
			{ beforeRetry: () => releases.push(Date.now() - start) },
		);
		await vi.runAllTimersAsync();
		await expect(result).resolves.toBe("loaded");
		expect(attemptsAt).toEqual([0, 500, 2000]);
		expect(releases).toEqual([500, 2000]);
	});

	test("gives up with the last error after every delay is spent", async () => {
		let attempts = 0;
		const result = withLoadRetries(async () => {
			attempts++;
			throw new TypeError(`Load failed ${attempts}`);
		});
		const settled = result.then(
			() => null,
			(error: unknown) => error,
		);
		await vi.runAllTimersAsync();
		const error = await settled;
		expect(attempts).toBe(LOAD_RETRY_DELAYS_MS.length + 1);
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).toBe(
			`Load failed ${LOAD_RETRY_DELAYS_MS.length + 1}`,
		);
	});

	test("does not retry once the load is aborted", async () => {
		const controller = new AbortController();
		let attempts = 0;
		const result = withLoadRetries(
			async () => {
				attempts++;
				controller.abort();
				throw new DOMException("Canceled", "AbortError");
			},
			{ signal: controller.signal },
		);
		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(attempts).toBe(1);
	});

	test("an abort during the backoff stops the next attempt", async () => {
		const controller = new AbortController();
		let attempts = 0;
		const result = withLoadRetries(
			async () => {
				attempts++;
				throw new TypeError("Failed to fetch");
			},
			{ signal: controller.signal },
		);
		const settled = result.then(
			() => null,
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(100);
		controller.abort();
		await vi.runAllTimersAsync();
		expect(await settled).toMatchObject({ name: "AbortError" });
		expect(attempts).toBe(1);
	});
});

describe("loadFailureMessage", () => {
	test.each([
		"Failed to fetch",
		"Load failed",
		"NetworkError when attempting to fetch resource.",
		"Failed to fetch dynamically imported module: https://x/editor/a.js",
		"Importing a module script failed.",
	])("names a connection problem for %s", (message) => {
		const error = new TypeError(message);
		expect(isNetworkFailure(error)).toBe(true);
		expect(loadFailureMessage(error)).toBe(
			"Cap couldn't download this recording. Check your connection and try again.",
		);
	});

	test("keeps the editor's own message for other failures", () => {
		expect(
			loadFailureMessage(
				new Error("Editor imported recording media is unavailable"),
			),
		).toBe("Editor imported recording media is unavailable");
		expect(
			isNetworkFailure(new TypeError("Cannot read properties of undefined")),
		).toBe(false);
		expect(loadFailureMessage("boom")).toBe(
			"The editor couldn't open this recording. Try again.",
		);
	});
});
