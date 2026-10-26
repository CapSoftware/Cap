import { afterEach, describe, expect, test } from "bun:test";
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FileSpec, ProjectCache } from "./materialize";
import { S3 } from "./s3";

const PIECE = 4 << 20;
const roots: string[] = [];
const caches: ProjectCache[] = [];

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function harness(getRange: S3["getRange"], concurrency = 1) {
	const root = mkdtempSync(join(tmpdir(), "cap-project-cache-"));
	roots.push(root);
	const s3 = new S3({
		endpoint: "https://storage.test",
		region: "test",
		bucket: "test",
		accessKeyId: "test",
		secretAccessKey: "test",
		virtualHost: false,
	});
	s3.getRange = getRange;
	const cache = new ProjectCache(s3, root, concurrency);
	caches.push(cache);
	return { cache, root };
}

const spec = (size: number): FileSpec => ({
	path: "content/video.mp4",
	key: "recording/video.mp4",
	size,
	ranges: "all",
});

afterEach(() => {
	for (const cache of caches.splice(0)) cache.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("ProjectCache lifecycle", () => {
	test("does not create files after close, including empty requests", async () => {
		const { cache, root } = harness(async () => {
			throw new Error("Unexpected S3 request");
		});
		cache.close();
		await expect(cache.materialize([spec(1)])).rejects.toThrow("closed");
		expect(existsSync(join(root, "content/video.mp4"))).toBe(false);
		await expect(cache.materialize([])).rejects.toThrow("closed");
		cache.close();
	});

	test("rejects an in-flight piece before writing through a closed descriptor", async () => {
		const response = deferred<Awaited<ReturnType<S3["getRange"]>>>();
		const started = deferred<void>();
		const { cache, root } = harness(async () => {
			started.resolve();
			return response.promise;
		});
		const pending = cache.materialize([spec(4)]);
		const settled = pending.then(
			() => null,
			(error: unknown) => error,
		);
		await started.promise;
		cache.close();
		const victim = join(root, "other-job.mp4");
		writeFileSync(victim, "safe");
		const fd = openSync(victim, "r+");
		try {
			response.resolve(new Uint8Array([1, 2, 3, 4]));
			const error = await settled;
			expect(readFileSync(victim, "utf8")).toBe("safe");
			expect(error).toBeInstanceOf(Error);
			if (!(error instanceof Error))
				throw new Error("Expected a closed-cache error");
			expect(error.message).toContain("closed");
			expect(cache.bytesFetched).toBe(0);
		} finally {
			closeSync(fd);
		}
	});

	test("does not start queued S3 requests after close", async () => {
		const response = deferred<Awaited<ReturnType<S3["getRange"]>>>();
		const started = deferred<void>();
		let requests = 0;
		const { cache } = harness(async (_key, start, end) => {
			requests++;
			if (start === 0) {
				started.resolve();
				return response.promise;
			}
			return new Uint8Array(end - start + 1);
		});
		const pending = cache.materialize([spec(2 * PIECE + 1)]);
		const settled = pending.catch((error: unknown) => error);
		await started.promise;
		cache.close();
		response.resolve(new Uint8Array(PIECE));
		expect(await settled).toBeInstanceOf(Error);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(requests).toBe(1);
	});

	test("rejects cached work when closed before its completion continuation", async () => {
		const { cache } = harness(async () => new Uint8Array([42]));
		await cache.materialize([spec(1)]);
		const pending = cache.materialize([spec(1)]);
		cache.close();
		await expect(pending).rejects.toThrow("closed");
	});

	test("reuses fetched pieces across overlapping ranges and preserves their bytes", async () => {
		const ranges: [number, number][] = [];
		const { cache, root } = harness(async (_key, start, end) => {
			ranges.push([start, end]);
			return new Uint8Array(end - start + 1).fill(start === 0 ? 11 : 22);
		});
		const file = spec(PIECE + 3);
		const first = await cache.materialize([
			{
				...file,
				ranges: [
					[0, 2],
					[1, 4],
				],
			},
		]);
		const second = await cache.materialize([file]);
		expect(ranges).toEqual([
			[0, PIECE - 1],
			[PIECE, PIECE + 2],
		]);
		expect(first).toMatchObject({ requests: 1, bytes: PIECE });
		expect(second).toMatchObject({ requests: 1, bytes: 3 });
		const bytes = readFileSync(join(root, file.path));
		expect(bytes.subarray(0, PIECE).every((value) => value === 11)).toBe(true);
		expect([...bytes.subarray(PIECE)]).toEqual([22, 22, 22]);
	});

	test("allows a failed piece to be retried while the cache remains open", async () => {
		let requests = 0;
		const { cache, root } = harness(async () => {
			if (++requests === 1) throw new Error("Storage unavailable");
			return new Uint8Array([42]);
		});
		await expect(cache.materialize([spec(1)])).rejects.toThrow(
			"Storage unavailable",
		);
		await cache.materialize([spec(1)]);
		expect(requests).toBe(2);
		expect([...readFileSync(join(root, spec(1).path))]).toEqual([42]);
	});
});
