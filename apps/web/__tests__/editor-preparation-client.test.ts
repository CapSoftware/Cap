import { afterEach, expect, test, vi } from "vitest";
import { startWebEditorPreparation } from "../lib/editor-preparation-client";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("a busy editor retries and opens a real preparation when capacity returns", async () => {
	vi.useFakeTimers();
	vi.spyOn(Math, "random").mockReturnValue(0);
	const onWait = vi.fn();
	let calls = 0;
	const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
		expect(init.signal).toBeUndefined();
		expect(JSON.parse(String(init.body))).toEqual({ videoId: "recording" });
		calls++;
		return calls === 1
			? Response.json(
					{ _tag: "EditorCapacityBusy", retryAfterMs: 1_000 },
					{ status: 503 },
				)
			: Response.json({ id: "preparation-id", status: "preparing" });
	});
	const pending = startWebEditorPreparation(
		"recording",
		new AbortController().signal,
		onWait,
		fetcher,
	);
	await vi.advanceTimersByTimeAsync(0);
	expect(onWait).toHaveBeenCalledWith(true);
	expect(fetcher).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1_000);
	expect(await pending).toEqual({ id: "preparation-id", status: "preparing" });
	expect(onWait).toHaveBeenLastCalledWith(false);
	expect(fetcher).toHaveBeenCalledTimes(2);
});

test("leaving while capacity is busy cancels the retry before any session starts", async () => {
	vi.useFakeTimers();
	const controller = new AbortController();
	const onWait = vi.fn();
	const fetcher = vi.fn(async () =>
		Response.json(
			{ _tag: "EditorCapacityBusy", retryAfterMs: 1_000 },
			{ status: 503 },
		),
	);
	const pending = startWebEditorPreparation(
		"recording",
		controller.signal,
		onWait,
		fetcher,
	);
	await vi.advanceTimersByTimeAsync(0);
	expect(onWait).toHaveBeenCalledWith(true);
	controller.abort();
	await expect(pending).rejects.toThrow("Editor preparation was canceled");
	await vi.advanceTimersByTimeAsync(30_000);
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test("an aborted successful response still returns its id for caller cleanup", async () => {
	let resolveFetch: (response: Response) => void = () => undefined;
	const fetcher = vi.fn((_url: string, init: RequestInit) => {
		expect(init.signal).toBeUndefined();
		return new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
	});
	const controller = new AbortController();
	const onWait = vi.fn();
	const pending = startWebEditorPreparation(
		"recording",
		controller.signal,
		onWait,
		fetcher,
	);
	controller.abort();
	resolveFetch(
		Response.json({ id: "prepared-after-close", status: "preparing" }),
	);
	expect(await pending).toEqual({
		id: "prepared-after-close",
		status: "preparing",
	});
	expect(onWait).not.toHaveBeenCalled();
});

test("an aborted busy response does not announce waiting after the editor closes", async () => {
	let resolveFetch: (response: Response) => void = () => undefined;
	const fetcher = vi.fn(
		() =>
			new Promise<Response>((resolve) => {
				resolveFetch = resolve;
			}),
	);
	const controller = new AbortController();
	const onWait = vi.fn();
	const pending = startWebEditorPreparation(
		"recording",
		controller.signal,
		onWait,
		fetcher,
	);
	controller.abort();
	resolveFetch(
		Response.json(
			{ _tag: "EditorCapacityBusy", retryAfterMs: 1_000 },
			{ status: 503 },
		),
	);
	await expect(pending).rejects.toThrow("Editor preparation was canceled");
	expect(onWait).not.toHaveBeenCalled();
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test("a missing or unhealthy editor worker fails promptly without a busy wait", async () => {
	const onWait = vi.fn();
	const fetcher = vi.fn(async () =>
		Response.json({ _tag: "ServiceUnavailable" }, { status: 503 }),
	);
	await expect(
		startWebEditorPreparation(
			"recording",
			new AbortController().signal,
			onWait,
			fetcher,
		),
	).rejects.toThrow("Editor preparation could not start");
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(onWait).not.toHaveBeenCalled();
});

test("capacity waiting has a deadline rather than retrying forever", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	vi.spyOn(Math, "random").mockReturnValue(0);
	const fetcher = vi.fn(async () =>
		Response.json(
			{ _tag: "EditorCapacityBusy", retryAfterMs: 1_000 },
			{ status: 503 },
		),
	);
	const pending = startWebEditorPreparation(
		"recording",
		new AbortController().signal,
		vi.fn(),
		fetcher,
	);
	const rejection = expect(pending).rejects.toThrow(
		"All editors are busy. Please try again in a moment.",
	);
	await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 + 20_000);
	await rejection;
	expect(fetcher.mock.calls.length).toBeLessThan(30);
});
