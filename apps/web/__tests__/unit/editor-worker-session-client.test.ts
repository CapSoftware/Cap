import { describe, expect, it, vi } from "vitest";
import { openWorkerEditorSession } from "@/lib/editor-worker-session-client";

function responses(
	...queue: (Response | ((url: string, init: RequestInit) => Response))[]
) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetcher = vi.fn(async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		if (init.method === "DELETE") return new Response(null, { status: 204 });
		const next = queue.shift();
		if (!next) throw new Error(`unexpected request ${url}`);
		return typeof next === "function" ? next(url, init) : next;
	});
	return { fetcher, calls };
}

describe("worker-rendered editor preview", () => {
	it("returns the session once the worker has prepared it", async () => {
		const { fetcher, calls } = responses(
			Response.json({ id: "prep-1", status: "preparing" }),
			Response.json({ status: "preparing" }),
			Response.json({ status: "ready", sessionId: "worker.session-1" }),
		);
		await expect(
			openWorkerEditorSession(
				"video-1",
				new AbortController().signal,
				() => undefined,
				fetcher,
				1,
			),
		).resolves.toBe("worker.session-1");
		expect(calls.map((call) => call.init.method ?? "GET")).toEqual([
			"POST",
			"GET",
			"GET",
		]);
		expect(calls[1]?.url).toBe(
			"/api/editor/preparations/prep-1?videoId=video-1",
		);
	});

	it("cancels the preparation when it fails", async () => {
		const { fetcher, calls } = responses(
			Response.json({ id: "prep-2", status: "preparing" }),
			Response.json({ status: "error" }),
		);
		await expect(
			openWorkerEditorSession(
				"video-1",
				new AbortController().signal,
				() => undefined,
				fetcher,
				1,
			),
		).rejects.toThrow("Editor preparation failed");
		expect(calls.at(-1)?.init.method).toBe("DELETE");
		expect(calls.at(-1)?.url).toBe(
			"/api/editor/preparations/prep-2?videoId=video-1",
		);
	});

	it("stops and cancels the preparation when the page leaves", async () => {
		const controller = new AbortController();
		const { fetcher, calls } = responses(
			Response.json({ id: "prep-3", status: "preparing" }),
			() => {
				controller.abort();
				return Response.json({ status: "preparing" });
			},
		);
		await expect(
			openWorkerEditorSession(
				"video-1",
				controller.signal,
				() => undefined,
				fetcher,
				1,
			),
		).rejects.toThrow("canceled");
		expect(calls.at(-1)?.init.method).toBe("DELETE");
	});
});
