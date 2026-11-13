import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeVideoFile } from "../../lib/media-probe";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const PLAIN = readFileSync(join(FIXTURES_DIR, "test-bframes-64.mp4"));
const FRAGMENTED = readFileSync(
	join(FIXTURES_DIR, "test-bframes-64-fragmented.mp4"),
);

// The limits live in a patch to the parser, which is applied when the media
// server is installed from its own lockfile, as the image is. An install from
// the repository root resolves a different, unpatched copy.
const parserVersion = (
	createRequire(import.meta.url)("mediabunny/package.json") as {
		version: string;
	}
).version;
const patched = parserVersion === "1.45.2";

const dir = mkdtempSync(join(tmpdir(), "sample-counts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MAX = 0xffffffff;
const MB = 1024 * 1024;

// Overwrites one 32-bit field, counted from the first byte of a box's type.
function withField(
	source: Buffer,
	box: string,
	offset: number,
	value: number,
	name: string,
) {
	const at = source.indexOf(box, 0, "latin1");
	expect(at).toBeGreaterThan(0);
	const data = Buffer.from(source);
	data.writeUInt32BE(value, at + offset);
	const path = join(dir, name);
	writeFileSync(path, data);
	return path;
}

async function probeWithin(path: string) {
	const rssBefore = process.memoryUsage().rss;
	const started = performance.now();
	let metadata: Awaited<ReturnType<typeof probeVideoFile>> | null = null;
	let error: unknown = null;
	try {
		metadata = await probeVideoFile(path);
	} catch (caught) {
		error = caught;
	}
	return {
		metadata,
		error,
		ms: performance.now() - started,
		grownMb: (process.memoryUsage().rss - rssBefore) / MB,
	};
}

describe.skipIf(!patched)("sample counts a file only declares", () => {
	test("the unchanged files probe normally", async () => {
		const plain = await probeVideoFile(
			join(FIXTURES_DIR, "test-bframes-64.mp4"),
		);
		expect(plain.width).toBe(64);
		expect(plain.height).toBe(64);
		expect(plain.duration).toBeCloseTo(1.1, 1);
		const fragmented = await probeVideoFile(
			join(FIXTURES_DIR, "test-bframes-64-fragmented.mp4"),
		);
		expect(fragmented.width).toBe(64);
	});

	test("a time table claiming three million samples costs no memory", async () => {
		const result = await probeWithin(
			withField(PLAIN, "stts", 12, 3_000_000, "stts-3m.mp4"),
		);
		expect(result.error).toBeNull();
		expect(result.metadata?.width).toBe(64);
		expect(result.metadata?.duration).toBeCloseTo(1.1, 1);
		expect(result.grownMb).toBeLessThan(80);
		expect(result.ms).toBeLessThan(2000);
	});

	for (const [box, offset, label] of [
		["stts", 12, "time table"],
		["ctts", 12, "offset table"],
		["stsc", 16, "chunk table"],
	] as const) {
		test(`a ${label} claiming the largest possible count is read as the file it is`, async () => {
			const result = await probeWithin(
				withField(PLAIN, box, offset, MAX, `${box}-max.mp4`),
			);
			expect(result.error).toBeNull();
			expect(result.metadata?.width).toBe(64);
			expect(result.metadata?.duration).toBeCloseTo(1.1, 1);
			expect(result.grownMb).toBeLessThan(80);
			expect(result.ms).toBeLessThan(2000);
		});
	}

	test("a track with one size for every sample is held to what its chunks can hold", async () => {
		const shared = Buffer.from(PLAIN);
		shared.writeUInt32BE(100, shared.indexOf("stsz", 0, "latin1") + 8);
		const honest = join(dir, "shared-size.mp4");
		writeFileSync(honest, shared);
		expect((await probeVideoFile(honest)).duration).toBeCloseTo(1.1, 1);

		const inflated = Buffer.from(shared);
		inflated.writeUInt32BE(1, inflated.indexOf("stsz", 0, "latin1") + 8);
		for (const [box, offset] of [
			["stsc", 16],
			["stts", 12],
			["ctts", 12],
		] as const) {
			inflated.writeUInt32BE(MAX, inflated.indexOf(box, 0, "latin1") + offset);
		}
		const path = join(dir, "shared-size-max.mp4");
		writeFileSync(path, inflated);
		const result = await probeWithin(path);
		expect(result.error).toBeNull();
		expect(result.metadata?.width).toBe(64);
		expect(result.grownMb).toBeLessThan(80);
		expect(result.ms).toBeLessThan(2000);
	});

	test("a fragment run claiming more samples than a fragment can hold is refused at once", async () => {
		const at = FRAGMENTED.indexOf("trun", 0, "latin1");
		expect(at).toBeGreaterThan(0);
		const data = Buffer.from(FRAGMENTED);
		// Flags: a data offset and nothing per sample, so the count is the only
		// thing that says how many samples there are.
		data.writeUInt8(0, at + 5);
		data.writeUInt8(0, at + 6);
		data.writeUInt8(1, at + 7);
		data.writeUInt32BE(3_000_000, at + 8);
		const path = join(dir, "trun-3m.mp4");
		writeFileSync(path, data);
		const result = await probeWithin(path);
		expect(result.grownMb).toBeLessThan(80);
		expect(result.ms).toBeLessThan(2000);
		expect(result.metadata === null || result.metadata.width === 64).toBe(true);
	});
});
