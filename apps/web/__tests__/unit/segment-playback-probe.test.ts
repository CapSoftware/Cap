import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForSegmentPlayback } from "@/app/s/[videoId]/_components/segment-playback-probe";

describe("Instant playback polling", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const start = (fetchImpl: typeof fetch, controller = new AbortController()) =>
		waitForSegmentPlayback({
			url: "/api/playlist?videoType=segments-status",
			fetchImpl,
			signal: controller.signal,
		});

	it("plays immediately when the source is ready", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 204 }));
		expect(await start(fetchImpl)).toBe("ready");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reconciles stale upload status only when the complete source is ready", async () => {
		const onComplete = vi.fn();
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(null, {
				status: 204,
				headers: { "X-Cap-Recording-Complete": "1" },
			}),
		);
		expect(
			await waitForSegmentPlayback({
				url: "/status",
				signal: new AbortController().signal,
				fetchImpl,
				onComplete,
			}),
		).toBe("ready");
		expect(onComplete).toHaveBeenCalledTimes(1);
		fetchImpl.mockResolvedValue(
			new Response(null, {
				status: 204,
				headers: { "X-Cap-Recording-Complete": "0" },
			}),
		);
		await waitForSegmentPlayback({
			url: "/status",
			signal: new AbortController().signal,
			fetchImpl,
			onComplete,
		});
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it("notices a completed upload within half a second in the common path", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 202 }))
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValue(new Response(null, { status: 204 }));
		const result = start(fetchImpl);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await result).toBe("ready");
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("surfaces missing media immediately without futile retries", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 409 }));
		expect(await start(fetchImpl)).toBe("incomplete");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("aborts an in-flight request when the player is replaced", async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
			(_url, options) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener(
						"abort",
						() => reject(new Error("aborted")),
						{ once: true },
					);
				}),
		);
		const result = start(fetchImpl, controller);
		controller.abort();
		expect(await result).toBe("unavailable");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels a pending retry on navigation", async () => {
		const controller = new AbortController();
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 202 }));
		const result = start(fetchImpl, controller);
		await vi.advanceTimersByTimeAsync(100);
		controller.abort();
		expect(await result).toBe("unavailable");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("backs off and ends a permanently unavailable upload", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 202 }));
		const result = start(fetchImpl);
		await vi.advanceTimersByTimeAsync(305_000);
		expect(await result).toBe("unavailable");
		expect(fetchImpl.mock.calls.length).toBeLessThan(110);
		expect(vi.getTimerCount()).toBe(0);
	});
});
