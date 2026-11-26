import { afterEach, expect, test } from "bun:test";
import {
	CHUNK_SIZE,
	CONCURRENCY,
	MultipartClient,
} from "../src/upload/multipart-client";

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");

afterEach(() => {
	if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
});

const sizedBlob = (size: number) =>
	({
		size,
		type: "video/webm",
		slice: (start: number, end: number) =>
			new Blob([String(Math.floor(start / CHUNK_SIZE) + 1)], {
				type: `${end - start}`,
			}),
	}) as unknown as Blob;

type HeldPut = {
	partNumber: number;
	signal?: AbortSignal | null;
	resolve: (response: Response) => void;
};

function heldServer(
	options: { presignStatus?: (call: number) => number } = {},
) {
	const held: HeldPut[] = [];
	const started: number[] = [];
	const signed: number[][] = [];
	const requests: Promise<Response>[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	let aborted = 0;
	let completion:
		| { parts: { partNumber: number; etag: string; size: number }[] }
		| undefined;

	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		value: async (url: string, init?: RequestInit) => {
			if (url.endsWith("/initiate")) return Response.json({ uploadId: "u" });
			if (url.endsWith("/presign-part")) {
				const partNumbers = (
					JSON.parse(String(init?.body)) as { partNumbers: number[] }
				).partNumbers;
				signed.push(partNumbers);
				const status = options.presignStatus?.(signed.length) ?? 200;
				if (status !== 200) return new Response("presign refused", { status });
				return Response.json({
					parts: partNumbers.map((partNumber) => ({
						partNumber,
						presignedUrl: `https://storage.example.test/${partNumber}`,
					})),
				});
			}
			if (url.endsWith("/abort")) {
				aborted++;
				return Response.json({ success: true });
			}
			if (url.endsWith("/complete")) {
				completion = JSON.parse(String(init?.body));
				return Response.json({ success: true });
			}
			const partNumber = Number(url.split("/").at(-1));
			started.push(partNumber);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			const request = new Promise<Response>((resolve, reject) => {
				held.push({
					partNumber,
					signal: init?.signal,
					resolve: (response) => {
						inFlight--;
						resolve(response);
					},
				});
				init?.signal?.addEventListener(
					"abort",
					() => {
						inFlight--;
						reject(new DOMException("Aborted", "AbortError"));
					},
					{ once: true },
				);
			});
			requests.push(request);
			return request;
		},
	});

	const settle = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	const finish = async (partNumber: number) => {
		const put = held.find((entry) => entry.partNumber === partNumber);
		if (!put) throw new Error(`part ${partNumber} was not started`);
		held.splice(held.indexOf(put), 1);
		put.resolve(
			new Response(null, { headers: { ETag: `etag-${partNumber}` } }),
		);
		await settle();
	};
	const fail = async (partNumber: number) => {
		const put = held.find((entry) => entry.partNumber === partNumber);
		if (!put) throw new Error(`part ${partNumber} was not started`);
		held.splice(held.indexOf(put), 1);
		put.resolve(new Response(null, { status: 503 }));
		await settle();
	};
	const releaseAll = async () => {
		for (const put of held.splice(0))
			put.resolve(new Response(null, { headers: { ETag: "late" } }));
		await Promise.allSettled(requests);
	};

	return {
		held,
		started,
		signed,
		settle,
		finish,
		fail,
		releaseAll,
		maxInFlight: () => maxInFlight,
		aborted: () => aborted,
		completion: () => completion,
	};
}

const client = () => new MultipartClient("https://api.example.test", "key");

test("uses 8 MB parts and keeps 6 parts in flight", () => {
	expect(CHUNK_SIZE).toBe(8 * 1024 * 1024);
	expect(CONCURRENCY).toBe(6);
});

test("never has more than 6 part uploads in flight", async () => {
	const server = heldServer();
	const progress: number[] = [];
	const uploading = client().uploadBlob("video", sizedBlob(20 * CHUNK_SIZE), {
		onProgress: (value) => progress.push(value),
	});
	await server.settle();
	expect(server.started).toEqual([1, 2, 3, 4, 5, 6]);

	for (let part = 1; part <= 20; part++) {
		expect(server.held.length).toBeLessThanOrEqual(CONCURRENCY);
		await server.finish(part);
	}
	await uploading;

	expect(server.maxInFlight()).toBe(CONCURRENCY);
	expect(server.started).toEqual(
		Array.from({ length: 20 }, (_, index) => index + 1),
	);
	expect(progress).toEqual(
		Array.from({ length: 20 }, (_, index) => (index + 1) / 20),
	);
});

test("starts the next part as soon as any part finishes, not at a batch boundary", async () => {
	const server = heldServer();
	const uploading = client().uploadBlob("video", sizedBlob(12 * CHUNK_SIZE));
	await server.settle();
	expect(server.started).toEqual([1, 2, 3, 4, 5, 6]);

	await server.finish(4);
	expect(server.started).toEqual([1, 2, 3, 4, 5, 6, 7]);
	expect(
		server.held.map((put) => put.partNumber).sort((a, b) => a - b),
	).toEqual([1, 2, 3, 5, 6, 7]);

	await server.finish(7);
	expect(server.started.at(-1)).toBe(8);

	for (const part of [1, 2, 3, 5, 6, 8, 9, 10, 11, 12]) {
		await server.finish(part);
	}
	await uploading;
	expect(server.signed).toEqual([
		Array.from({ length: 12 }, (_, index) => index + 1),
	]);
});

test("reports completed parts to complete in part-number order", async () => {
	const server = heldServer();
	const size = 7 * CHUNK_SIZE + 11;
	const uploading = client().uploadBlob("video", sizedBlob(size));
	await server.settle();
	for (const part of [6, 3, 5, 1, 7, 4, 8, 2]) {
		await server.finish(part);
	}
	await uploading;

	expect(server.completion()?.parts).toEqual(
		Array.from({ length: 8 }, (_, index) => ({
			partNumber: index + 1,
			etag: `etag-${index + 1}`,
			size: index < 7 ? CHUNK_SIZE : 11,
		})),
	);
	expect(server.aborted()).toBe(0);
});

test("signs the next batch once when several workers cross into it together", async () => {
	const server = heldServer();
	const uploading = client().uploadBlob("video", sizedBlob(56 * CHUNK_SIZE));
	await server.settle();
	for (let part = 1; part <= 44; part++) await server.finish(part);
	expect(server.signed).toHaveLength(1);

	for (const part of [45, 46, 47, 48, 49, 50]) {
		const finishing = server.held.find((put) => put.partNumber === part);
		finishing?.resolve(
			new Response(null, { headers: { ETag: `etag-${part}` } }),
		);
		server.held.splice(server.held.indexOf(finishing as HeldPut), 1);
	}
	await server.settle();
	expect(server.signed).toEqual([
		Array.from({ length: 50 }, (_, index) => index + 1),
		Array.from({ length: 6 }, (_, index) => index + 51),
	]);
	expect(server.started.slice(50).sort((a, b) => a - b)).toEqual([
		51, 52, 53, 54, 55, 56,
	]);
	for (let part = 51; part <= 56; part++) await server.finish(part);
	await uploading;
	expect(server.completion()?.parts).toHaveLength(56);
});

test("signs again when the URLs pass the reuse window while workers are mid-upload", async () => {
	const nowDescriptor = Object.getOwnPropertyDescriptor(Date, "now");
	let now = 1_000_000;
	Object.defineProperty(Date, "now", { configurable: true, value: () => now });
	try {
		const server = heldServer();
		const uploading = client().uploadBlob("video", sizedBlob(10 * CHUNK_SIZE));
		await server.settle();
		await server.finish(1);
		expect(server.started.at(-1)).toBe(7);

		now += 30 * 60 * 1000 + 1;
		await server.finish(2);
		expect(server.signed).toEqual([
			Array.from({ length: 10 }, (_, index) => index + 1),
			[8, 9, 10],
		]);
		expect(server.started.at(-1)).toBe(8);

		for (const part of [3, 4, 5, 6, 7, 8, 9, 10]) await server.finish(part);
		await uploading;
		expect(server.signed).toHaveLength(2);
		expect(server.completion()?.parts.map((part) => part.partNumber)).toEqual(
			Array.from({ length: 10 }, (_, index) => index + 1),
		);
	} finally {
		if (nowDescriptor) Object.defineProperty(Date, "now", nowDescriptor);
	}
});

test("a failed part aborts the parts in flight, starts no more, and aborts the upload once", async () => {
	const server = heldServer();
	const progress: number[] = [];
	const uploading = client()
		.uploadBlob("video", sizedBlob(20 * CHUNK_SIZE), {
			onProgress: (value) => progress.push(value),
		})
		.catch((error: unknown) => error);
	try {
		await server.settle();
		await server.finish(1);
		const inFlight = [...server.held];
		expect(inFlight).toHaveLength(CONCURRENCY);

		await server.fail(3);
		const error = await uploading;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Failed to upload part 3");
		expect(inFlight.every((put) => put.signal?.aborted)).toBe(true);
		expect(server.started).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(progress).toEqual([1 / 20]);
		expect(server.aborted()).toBe(1);
		expect(server.completion()).toBeUndefined();
	} finally {
		await server.releaseAll();
		await uploading;
	}
});

test("a refused presign for a later batch aborts the parts in flight and the upload", async () => {
	const server = heldServer({
		presignStatus: (call) => (call === 2 ? 429 : 200),
	});
	const uploading = client()
		.uploadBlob("video", sizedBlob(53 * CHUNK_SIZE))
		.catch((error: unknown) => error);
	try {
		await server.settle();
		for (let part = 1; part <= 45; part++) await server.finish(part);
		const inFlight = [...server.held];
		expect(inFlight.map((put) => put.partNumber)).toEqual([46, 47, 48, 49, 50]);

		const error = await uploading;
		expect(String(error)).toContain("presign refused");
		expect(inFlight.every((put) => put.signal?.aborted)).toBe(true);
		expect(server.aborted()).toBe(1);
		expect(server.completion()).toBeUndefined();
	} finally {
		await server.releaseAll();
		await uploading;
	}
});
