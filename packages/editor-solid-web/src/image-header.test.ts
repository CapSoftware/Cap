import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readImageHeader } from "./image-header";

const fixture = (name: string) =>
	new Uint8Array(
		readFileSync(join(import.meta.dir, "..", "browser-replay", name)),
	);

describe("readImageHeader", () => {
	test("reads a JPEG's stored size and EXIF orientation", () => {
		expect(readImageHeader(fixture("exif-background-6.jpg"))).toEqual({
			width: 120,
			height: 80,
			orientation: 6,
		});
	});

	test("reads a PNG's size", () => {
		expect(readImageHeader(fixture("large-background.png"))).toEqual({
			width: 3600,
			height: 2400,
			orientation: 1,
		});
		expect(readImageHeader(fixture("raw-background.png"))).toEqual({
			width: 120,
			height: 80,
			orientation: 1,
		});
	});

	test("returns null for unknown formats and truncated headers", () => {
		expect(
			readImageHeader(new Uint8Array([0x52, 0x49, 0x46, 0x46])),
		).toBeNull();
		expect(
			readImageHeader(fixture("exif-background-6.jpg").subarray(0, 24)),
		).toBeNull();
		expect(
			readImageHeader(fixture("large-background.png").subarray(0, 16)),
		).toBeNull();
	});
});
