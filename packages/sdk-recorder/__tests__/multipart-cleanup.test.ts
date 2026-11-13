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
const requestedParts = (init: RequestInit | undefined) =>
	(JSON.parse(String(init?.body)) as { partNumbers: number[] }).partNumbers;
const presigned = (
	init: RequestInit | undefined,
	urlFor: (partNumber: number) => string = () =>
		"https://storage.example.test/part",
) =>
	json({
		parts: requestedParts(init).map((partNumber) => ({
			partNumber,
			presignedUrl: urlFor(partNumber),
		})),
	});
const numberedUrl = (partNumber: number) =>
	`https://storage.example.test/${partNumber}`;
const sizedBlob = (size: number) =>
	({
		size,
		type: "video/webm",
		slice: (start: number, end: number) =>
			new Blob([String(Math.floor(start / chunkBytes) + 1)], {
				type: `${end - start}`,
			}),
	}) as unknown as Blob;

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
				return presigned(init);
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
		setFetch(async (url, init) => {
			if (url.endsWith(`/${failure}`))
				return new Response("request failed", { status: 503 });
			if (url.endsWith("/initiate")) return json({ uploadId: "upload" });
			if (url.endsWith("/presign-part")) return presigned(init);
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

test("cancels concurrent part uploads before aborting the failed upload once", async () => {
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
		if (url.endsWith("/presign-part")) return presigned(init, numberedUrl);
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
		pending[0]?.resolve(new Response(null, { status: 503 }));
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
});

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
		if (url.endsWith("/presign-part")) return presigned(init);
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
	const signed: number[][] = [];
	let initiation: unknown;
	let completion: unknown;
	let aborted = 0;
	setFetch(async (url, init) => {
		if (url.endsWith("/initiate")) {
			initiation = JSON.parse(String(init?.body));
			return json({ uploadId: "upload" });
		}
		if (url.endsWith("/presign-part")) {
			signed.push(requestedParts(init));
			return presigned(init, numberedUrl);
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
	expect(signed).toEqual([[1, 2, 3, 4]]);
	expect(initiation).toEqual({
		videoId: "video",
		contentType: "video/mp4",
		contentLength: 3 * chunkBytes + 123,
	});
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
	setFetch(async (url, init) => {
		if (url.endsWith("/initiate")) return json({ uploadId: "upload" });
		if (url.endsWith("/presign-part")) return presigned(init);
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

function batchUploadServer() {
	const signed: number[][] = [];
	const requests: string[] = [];
	const uploaded: number[] = [];
	let completion: { parts: { partNumber: number; size: number }[] } | undefined;
	let aborted = 0;
	setFetch(async (url, init) => {
		if (url.endsWith("/initiate")) return json({ uploadId: "upload" });
		if (url.endsWith("/presign-part")) {
			signed.push(requestedParts(init));
			requests.push("presign");
			return presigned(init, numberedUrl);
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
		expect(await (init?.body as Blob).text()).toBe(String(partNumber));
		uploaded.push(partNumber);
		requests.push("put");
		return new Response(null, { headers: { ETag: `etag-${partNumber}` } });
	});
	return {
		signed,
		requests,
		uploaded,
		completion: () => completion,
		aborted: () => aborted,
	};
}

const range = (first: number, last: number) =>
	Array.from({ length: last - first + 1 }, (_, index) => first + index);

test("signs a large upload in batches of 50 parts, one request per batch", async () => {
	const server = batchUploadServer();

	await client().uploadBlob("video", sizedBlob(120 * chunkBytes + 7));

	expect(server.signed).toEqual([
		range(1, 50),
		range(51, 100),
		range(101, 121),
	]);
	expect(server.uploaded.toSorted((a, b) => a - b)).toEqual(range(1, 121));
	expect(server.requests.filter((kind) => kind === "presign")).toHaveLength(3);
	expect(server.requests.slice(0, 4)).toEqual(["presign", "put", "put", "put"]);
	expect(server.completion()?.parts.map((part) => part.partNumber)).toEqual(
		range(1, 121),
	);
	expect(server.completion()?.parts.at(-1)).toMatchObject({ size: 7 });
	expect(server.aborted()).toBe(0);
});

test("signs exactly the parts a file has when it fills whole batches", async () => {
	const server = batchUploadServer();

	await client().uploadBlob("video", sizedBlob(50 * chunkBytes));

	expect(server.signed).toEqual([range(1, 50)]);
	expect(server.uploaded).toHaveLength(50);
});

test("signs the remaining parts again once the signed URLs are 30 minutes old", async () => {
	const nowDescriptor = Object.getOwnPropertyDescriptor(Date, "now");
	let now = 1_000_000;
	Object.defineProperty(Date, "now", { configurable: true, value: () => now });
	const server = batchUploadServer();
	try {
		await client().uploadBlob("video", sizedBlob(9 * chunkBytes), {
			onProgress: (progress) => {
				if (progress === 3 / 9) now += 30 * 60 * 1000;
				if (progress === 6 / 9) now += 30 * 60 * 1000 + 1;
			},
		});
	} finally {
		if (nowDescriptor) Object.defineProperty(Date, "now", nowDescriptor);
	}

	expect(server.signed).toEqual([range(1, 9), range(7, 9)]);
	expect(server.uploaded.toSorted((a, b) => a - b)).toEqual(range(1, 9));
	expect(server.aborted()).toBe(0);
});

test("aborts the upload when a later batch cannot be signed", async () => {
	const signed: number[][] = [];
	let aborted = 0;
	let completed = 0;
	setFetch(async (url, init) => {
		if (url.endsWith("/initiate")) return json({ uploadId: "upload" });
		if (url.endsWith("/presign-part")) {
			signed.push(requestedParts(init));
			if (signed.length === 2)
				return new Response("second batch failed", { status: 429 });
			return presigned(init, numberedUrl);
		}
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

	await expect(
		client().uploadBlob("video", sizedBlob(60 * chunkBytes)),
	).rejects.toThrow("second batch failed");
	expect(signed).toEqual([range(1, 50), range(51, 60)]);
	expect(aborted).toBe(1);
	expect(completed).toBe(0);
});

test("fails and aborts when the server leaves a part out of a signed batch", async () => {
	let aborted = 0;
	setFetch(async (url, init) => {
		if (url.endsWith("/initiate")) return json({ uploadId: "upload" });
		if (url.endsWith("/presign-part"))
			return json({
				parts: requestedParts(init)
					.filter((partNumber) => partNumber !== 2)
					.map((partNumber) => ({
						partNumber,
						presignedUrl: numberedUrl(partNumber),
					})),
			});
		if (url.endsWith("/abort")) {
			aborted++;
			return json({ success: true });
		}
		return new Response(null, { headers: { ETag: "etag" } });
	});

	await expect(
		client().uploadBlob("video", sizedBlob(3 * chunkBytes)),
	).rejects.toThrow("Missing presigned URL for part 2");
	expect(aborted).toBe(1);
});
