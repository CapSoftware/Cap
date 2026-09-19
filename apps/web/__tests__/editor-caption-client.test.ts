import { afterEach, expect, test, vi } from "vitest";
import { generateWebEditorCaptions } from "../lib/editor-caption-client";

const captions = {
	settings: null,
	segments: [
		{
			id: "segment-0",
			start: 0.1,
			end: 0.5,
			text: "Hello world",
			words: [
				{ text: "Hello", start: 0.1, end: 0.3 },
				{ text: "world", start: 0.3, end: 0.5 },
			],
		},
	],
};

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("web editor captions reuse an existing transcript without polling", async () => {
	const fetchMock = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Response.json({ status: "ready", captions, message: null }),
	);
	vi.stubGlobal("fetch", fetchMock);
	const result = await generateWebEditorCaptions(
		"video",
		"session",
		new AbortController().signal,
	);
	expect(result).toEqual(captions);
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(fetchMock.mock.calls[0]?.[0]).toBe(
		"/api/editor/sessions/session/captions",
	);
	expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
	expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
		videoId: "video",
		language: "auto",
	});
});

test("web editor captions wait for the existing AssemblyAI workflow", async () => {
	vi.useFakeTimers();
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(
			Response.json({ status: "processing", captions: null, message: null }),
		)
		.mockResolvedValueOnce(
			Response.json({ status: "ready", captions, message: null }),
		);
	vi.stubGlobal("fetch", fetchMock);
	const generated = generateWebEditorCaptions(
		"video",
		"session",
		new AbortController().signal,
	);
	await vi.advanceTimersByTimeAsync(2000);
	expect(await generated).toEqual(captions);
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(fetchMock.mock.calls[1]?.[0]).toBe(
		"/api/editor/sessions/session/captions?videoId=video&language=auto",
	);
	expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("GET");
});

test("selected caption language stays with the AssemblyAI job during polling", async () => {
	vi.useFakeTimers();
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(
			Response.json({ status: "processing", captions: null, message: null }),
		)
		.mockResolvedValueOnce(
			Response.json({ status: "ready", captions, message: null }),
		);
	vi.stubGlobal("fetch", fetchMock);
	const generated = generateWebEditorCaptions(
		"video",
		"session",
		new AbortController().signal,
		"es",
	);
	await vi.advanceTimersByTimeAsync(2000);
	expect(await generated).toEqual(captions);
	expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
		videoId: "video",
		language: "es",
	});
	expect(fetchMock.mock.calls[1]?.[0]).toBe(
		"/api/editor/sessions/session/captions?videoId=video&language=es",
	);
});

test("caption generation starts a new job when an added clip appears during processing", async () => {
	vi.useFakeTimers();
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(
			Response.json({ status: "processing", captions: null, message: null }),
		)
		.mockResolvedValueOnce(
			Response.json({ status: "missing", captions: null, message: null }),
		)
		.mockResolvedValueOnce(
			Response.json({ status: "processing", captions: null, message: null }),
		)
		.mockResolvedValueOnce(
			Response.json({ status: "ready", captions, message: null }),
		);
	vi.stubGlobal("fetch", fetchMock);
	const generated = generateWebEditorCaptions(
		"video",
		"session",
		new AbortController().signal,
	);
	await vi.advanceTimersByTimeAsync(4000);
	expect(await generated).toEqual(captions);
	expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual([
		"POST",
		"GET",
		"POST",
		"GET",
	]);
});

test("web editor caption entitlement is enforced by the caption API", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 403 })),
	);
	await expect(
		generateWebEditorCaptions("video", "session", new AbortController().signal),
	).rejects.toThrow("Cap Pro is required");
});

test("closing the editor cancels a pending caption poll", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({ status: "processing", captions: null, message: null }),
		),
	);
	const controller = new AbortController();
	const generated = generateWebEditorCaptions(
		"video",
		"session",
		controller.signal,
	);
	await Promise.resolve();
	await Promise.resolve();
	controller.abort();
	await expect(generated).rejects.toThrow("Caption generation cancelled");
});
