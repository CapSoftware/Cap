import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectCache } from "./materialize";
import type { S3 } from "./s3";

test("a prefixed file is its prefix, then the source shifted by it", async () => {
	const objects = new Map<string, Uint8Array>([
		["prefix", Uint8Array.from({ length: 100 }, (_, index) => index + 1)],
		[
			"source",
			Uint8Array.from({ length: 10 << 20 }, (_, index) => (index % 250) + 1),
		],
	]);
	const reads: string[] = [];
	const s3 = {
		async getRange(key: string, start: number, endInclusive: number) {
			reads.push(`${key}:${start}-${endInclusive}`);
			return (objects.get(key) as Uint8Array).slice(start, endInclusive + 1);
		},
	} as unknown as S3;
	const root = mkdtempSync(join(tmpdir(), "rf-materialize-"));
	const cache = new ProjectCache(s3, root);
	const size = 100 + (10 << 20);
	await cache.materialize([
		{
			path: "display.mp4",
			key: "source",
			size,
			prefix: { key: "prefix", size: 100 },
			// The header, then a range crossing the source's first 4 MiB piece.
			ranges: [
				[0, 100],
				[100 + (4 << 20) - 10, 100 + (4 << 20) + 10],
			],
		},
	]);
	cache.close();
	expect(reads.sort()).toEqual([
		"prefix:0-99",
		`source:0-${(4 << 20) - 1}`,
		`source:${4 << 20}-${(8 << 20) - 1}`,
	]);
	const file = readFileSync(join(root, "display.mp4"));
	expect(file.byteLength).toBe(size);
	expect([...file.subarray(0, 100)]).toEqual([
		...(objects.get("prefix") as Uint8Array),
	]);
	const source = objects.get("source") as Uint8Array;
	for (const at of [0, 1, (4 << 20) - 1, 4 << 20, (8 << 20) - 1]) {
		expect(file[100 + at]).toBe(source[at] as number);
	}
	// Past what was asked for, the file is still a hole.
	expect(file[100 + (9 << 20)]).toBe(0);
});
