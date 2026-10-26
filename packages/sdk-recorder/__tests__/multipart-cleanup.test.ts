import { afterEach, expect, test } from "bun:test";
import { MultipartClient } from "../src/upload/multipart-client";

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
const chunkBytes = 5 * 1024 * 1024;
const client = () =>
	new MultipartClient("https://api.example.test", "fixture-key");
const setFetch = (
	fetcher: (input: string, init?: RequestInit) => Promise<Response>,
) =>
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		value: fetcher,
	});
const json = (body: unknown) => Response.json(body);

afterEach(() => {
	if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
});

test.each(["presign", "network", "http", "etag", "abort failure"])(
	"cleans up an initiated upload after %s without replacing the original failure",
	async (failure) => {
		let aborted = 0;
		let completed = 0;
		setFetch(async (url, init) => {
			if (url.endsWith("/initiate")) return json({ uploadId: "upload" });
			if (url.endsWith("/presign-part")) {
				if (failure === "presign")
					return new Response("presign failed", { status: 503 });
				return json({ presignedUrl: "https://storage.example.test/part" });
			}
			if (url.endsWith("/abort")) {
				aborted++;
				expect(JSON.parse(String(init?.body))).toEqual({
					videoId: "video",
					uploadId: "upload",
				});
				if (failure === "abort failure") throw new Error("cleanup failed");
				return json({ success: true });
			}
			if (url.endsWith("/complete")) {
				completed++;
				return json({ success: true });
			}
			if (failure === "network") throw new Error("network failed");
			return new Response(null, { status: failure === "etag" ? 200 : 503 });
		});
		const message =
			failure === "presign"
				? "presign failed"
				: failure === "network"
					? "network failed"
					: failure === "etag"
						? "ETag"
						: "Failed to upload part 1";
		await expect(
			client().uploadBlob("video", new Blob(["recording"])),
		).rejects.toThrow(message);
		expect(aborted).toBe(1);
		expect(completed).toBe(0);
	},
);

test.each(["initiate", "complete"])(
	"does not send an unsafe abort when %s fails",
	async (failure) => {
		let aborted = 0;
		setFetch(async (url) => {
			if (url.endsWith(`/${failure}`))
				return new Response("request failed", { status: 503 });
			if (url.endsWith("/initiate")) return json({ uploadId: "upload" });
			if (url.endsWith("/presign-part"))
				return json({ presignedUrl: "https://storage.example.test/part" });
			if (url.endsWith("/abort")) {
				aborted++;
				return json({ success: true });
			}
			return new Response(null, { headers: { ETag: "etag" } });
		});
		await expect(
			client().uploadBlob("video", new Blob(["recording"])),
		).rejects.toThrow("request failed");
		expect(aborted).toBe(0);
	},
);

test.each(["presign", "put"])(
	"cancels concurrent %s requests before aborting the failed upload once",
	async (waiting) => {
		const entered = Promise.withResolvers<void>();
		const pending: Array<{
			signal?: AbortSignal | null;
			resolve: (response: Response) => void;
		}> = [];
		const requests: Promise<Response>[] = [];
		let aborted = 0;
		let completed = 0;
		setFetch(async (url, init) => {
			if (url.endsWith("/initiate")) return json({ uploadId: "upload" });
			if (url.endsWith("/abort")) {
				aborted++;
				return json({ success: true });
			}
			if (url.endsWith("/complete")) {
				completed++;
				return json({ success: true });
			}
			if (url.endsWith("/presign-part")) {
				const partNumber = (
					JSON.parse(String(init?.body)) as { partNumber: number }
				).partNumber;
				if (partNumber === 1 || waiting === "put")
					return json({
						presignedUrl: `https://storage.example.test/${partNumber}`,
					});
			}
			const request = new Promise<Response>((resolve, reject) => {
				pending.push({ signal: init?.signal, resolve });
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("Aborted", "AbortError")),
					{ once: true },
				);
				if (pending.length === 3) entered.resolve();
			});
			requests.push(request);
			return request;
		});
		const uploading = client()
			.uploadBlob("video", new Blob([new Uint8Array(3 * chunkBytes)]))
			.catch((error: unknown) => error);
		try {
			await entered.promise;
			const failedIndex = waiting === "put" ? 0 : 2;
			pending[failedIndex]?.resolve(new Response(null, { status: 503 }));
			expect(await uploading).toBeInstanceOf(Error);
			expect(pending.every(({ signal }) => signal?.aborted)).toBe(true);
			expect(aborted).toBe(1);
			expect(completed).toBe(0);
		} finally {
			for (const request of pending)
				request.resolve(new Response(null, { headers: { ETag: "etag" } }));
			await Promise.allSettled(requests);
			await uploading;
		}
	},
);

test("bounds a stalled cleanup request and retains the part failure", async () => {
	const timeoutDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"setTimeout",
	);
	const entered = Promise.withResolvers<void>();
	const failure = new Error("part network failure");
	let fireTimeout: (() => void) | undefined;
	let rejectAbort: ((reason?: unknown) => void) | undefined;
	let abortSignal: AbortSignal | null | undefined;
	Object.defineProperty(globalThis, "setTimeout", {
		configurable: true,
		value: (handler: () => void, delay: number) => {
			expect(delay).toBe(10_000);
			fireTimeout = handler;
			return 0;
		},
	});
	setFetch(async (url, init) => {
		if (url.endsWith("/initiate")) return json({ uploadId: "upload" });
		if (url.endsWith("/presign-part"))
			return json({ presignedUrl: "https://storage.example.test/part" });
		if (url.endsWith("/abort")) {
			abortSignal = init?.signal;
			return new Promise<Response>((_resolve, reject) => {
				rejectAbort = reject;
				abortSignal?.addEventListener(
					"abort",
					() => reject(new DOMException("Aborted", "AbortError")),
					{ once: true },
				);
				entered.resolve();
			});
		}
		throw failure;
	});
	const uploading = client()
		.uploadBlob("video", new Blob(["recording"]))
		.catch((error: unknown) => error);
	try {
		await entered.promise;
		expect(fireTimeout).toBeDefined();
		expect(abortSignal?.aborted).toBe(false);
		fireTimeout?.();
		expect(await uploading).toBe(failure);
		expect(abortSignal?.aborted).toBe(true);
	} finally {
		rejectAbort?.(new Error("released test request"));
		await uploading;
		if (timeoutDescriptor)
			Object.defineProperty(globalThis, "setTimeout", timeoutDescriptor);
	}
});

test("preserves successful multi-batch bytes, completion parts and progress", async () => {
	const blob = new Blob(
		Array.from({ length: 4 }, (_, index) =>
			new Uint8Array(index < 3 ? chunkBytes : 123).fill(index + 1),
		),
	);
	const uploaded: number[] = [];
	const progress: number[] = [];
	let completion: unknown;
	let aborted = 0;
	setFetch(async (url, init) => {
		if (url.endsWith("/initiate")) return json({ uploadId: "upload" });
		if (url.endsWith("/presign-part")) {
			const partNumber = (
				JSON.parse(String(init?.body)) as { partNumber: number }
			).partNumber;
			return json({
				presignedUrl: `https://storage.example.test/${partNumber}`,
			});
		}
		if (url.endsWith("/complete")) {
			completion = JSON.parse(String(init?.body));
			return json({ success: true });
		}
		if (url.endsWith("/abort")) {
			aborted++;
			return json({ success: true });
		}
		const partNumber = Number(url.split("/").at(-1));
		const bytes = new Uint8Array(await (init?.body as Blob).arrayBuffer());
		expect(bytes.every((value) => value === partNumber)).toBe(true);
		expect(bytes.length).toBe(partNumber < 4 ? chunkBytes : 123);
		expect(init?.signal?.aborted).toBe(false);
		uploaded.push(partNumber);
		return new Response(null, { headers: { ETag: `etag-${partNumber}` } });
	});
	await client().uploadBlob("video", blob, {
		durationMs: 1234,
		onProgress: (value) => progress.push(value),
	});
	expect(uploaded.toSorted()).toEqual([1, 2, 3, 4]);
	expect(progress).toEqual([0.75, 1]);
	expect(completion).toEqual({
		videoId: "video",
		uploadId: "upload",
		durationInSecs: 1.234,
		parts: Array.from({ length: 4 }, (_, index) => ({
			partNumber: index + 1,
			etag: `etag-${index + 1}`,
			size: index < 3 ? chunkBytes : 123,
		})),
	});
	expect(aborted).toBe(0);
});

test("cleans up when a progress callback fails before completion", async () => {
	const failure = new Error("progress callback failed");
	let aborted = 0;
	let completed = 0;
	setFetch(async (url) => {
		if (url.endsWith("/initiate")) return json({ uploadId: "upload" });
		if (url.endsWith("/presign-part"))
			return json({ presignedUrl: "https://storage.example.test/part" });
		if (url.endsWith("/abort")) {
			aborted++;
			return json({ success: true });
		}
		if (url.endsWith("/complete")) {
			completed++;
			return json({ success: true });
		}
		return new Response(null, { headers: { ETag: "etag" } });
	});
	const result = await client()
		.uploadBlob("video", new Blob(["recording"]), {
			onProgress: () => {
				throw failure;
			},
		})
		.catch((error: unknown) => error);
	expect(result).toBe(failure);
	expect(aborted).toBe(1);
	expect(completed).toBe(0);
});
