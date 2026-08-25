import { afterEach, describe, expect, it, vi } from "vitest";
import { RetryableError } from "workflow";
import {
	createMediaServerCapacityError,
	isMediaServerCapacityError,
} from "@/lib/media-server-backpressure";

afterEach(() => {
	vi.useRealTimers();
});

describe("media server backpressure", () => {
	it("recognizes durable workflow errors caused by exhausted media capacity", () => {
		expect(isMediaServerCapacityError(new Error("Server is busy"))).toBe(true);
		expect(isMediaServerCapacityError("SERVER_BUSY: at capacity")).toBe(true);
		expect(isMediaServerCapacityError(new Error("Invalid video source"))).toBe(
			false,
		);
	});

	it("schedules durable retries after the server's requested delay", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
		const error = createMediaServerCapacityError({
			response: new Response(null, {
				status: 503,
				headers: { "Retry-After": "15" },
			}),
			message: "Server is busy",
			videoId: "video-1",
		});

		expect(error).toBeInstanceOf(RetryableError);
		const retryDelay = new Date(error.retryAfter).getTime() - Date.now();
		expect(retryDelay).toBeGreaterThanOrEqual(15_000);
		expect(retryDelay).toBeLessThan(35_000);
	});

	it("gives ordinary recordings priority over bulk imports", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
		const response = new Response(null, {
			status: 503,
			headers: { "Retry-After": "15" },
		});
		const recording = createMediaServerCapacityError({
			response,
			message: "Server is busy",
			videoId: "video-1",
		});
		const bulk = createMediaServerCapacityError({
			response,
			message: "Server is busy",
			videoId: "video-1",
			priority: "bulk",
		});

		expect(
			new Date(bulk.retryAfter).getTime() -
				new Date(recording.retryAfter).getTime(),
		).toBe(15_000);
	});
});
