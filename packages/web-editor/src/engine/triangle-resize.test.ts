import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { beforeAll, describe, expect, test } from "vitest";
import init, {
	decode_image,
	decode_overlay_image,
} from "../../image-decoder/pkg/cap_editor_image_decoder.js";
import { fitWithin, resizeTriangle } from "./triangle-resize";

const file = (path: string) =>
	readFileSync(new URL(path, import.meta.url)) as Uint8Array;

function chunk(type: string, data: Uint8Array) {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

function png(pixels: Uint8Array, width: number, height: number) {
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header.set([8, 6, 0, 0, 0], 8);
	const rows = new Uint8Array((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		rows.set(
			pixels.subarray(y * width * 4, (y + 1) * width * 4),
			y * (width * 4 + 1) + 1,
		);
	}
	const parts = [
		new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", new Uint8Array()),
	];
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function crateResize(bytes: Uint8Array) {
	const image = decode_image(bytes, 2560);
	const width = image.width();
	const height = image.height();
	return { width, height, pixels: image.pixels() };
}

beforeAll(async () => {
	await init({
		module_or_path: file(
			"../../image-decoder/pkg/cap_editor_image_decoder_bg.wasm",
		),
	});
});

describe("resizeTriangle", () => {
	test("matches the image crate byte for byte on a built-in wallpaper", () => {
		const bytes = file(
			"../../../../apps/desktop-gpui/assets/backgrounds/macOS/tahoe-night-min.jpg",
		);
		const decoded = decode_overlay_image(bytes, 4096);
		const width = decoded.level_width(0);
		const height = decoded.level_height(0);
		const source = decoded.take_level_pixels(0);
		decoded.free();
		expect([width, height]).toEqual([3840, 2160]);
		const expected = crateResize(bytes);
		const [fitWidth, fitHeight] = fitWithin(width, height, 2560);
		expect([fitWidth, fitHeight]).toEqual([expected.width, expected.height]);
		const actual = resizeTriangle(source, width, height, fitWidth, fitHeight);
		expect(Buffer.from(actual).equals(Buffer.from(expected.pixels))).toBe(true);
	});

	test("matches the image crate byte for byte with straight alpha", () => {
		const width = 2903;
		const height = 731;
		const source = new Uint8Array(width * height * 4);
		let seed = 0x2545f491;
		for (let index = 0; index < source.length; index += 4) {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			const pixel = index / 4;
			const x = pixel % width;
			const y = Math.floor(pixel / width);
			source[index] = (x * 255) / width;
			source[index + 1] = seed >>> 24;
			source[index + 2] = (y * 255) / height;
			source[index + 3] = x % 97 < 40 ? 255 : (seed >>> 16) & 255;
		}
		const expected = crateResize(png(source, width, height));
		const [fitWidth, fitHeight] = fitWithin(width, height, 2560);
		expect([fitWidth, fitHeight]).toEqual([expected.width, expected.height]);
		const actual = resizeTriangle(source, width, height, fitWidth, fitHeight);
		expect(Buffer.from(actual).equals(Buffer.from(expected.pixels))).toBe(true);
	});

	test("fits tall and square images like the image crate", () => {
		for (const [width, height] of [
			[2500, 4000],
			[2561, 2561],
			[3400, 2125],
			[8192, 7],
		] as const) {
			const source = new Uint8Array(width * height * 4).fill(255);
			const expected = crateResize(png(source, width, height));
			expect(fitWithin(width, height, 2560)).toEqual([
				expected.width,
				expected.height,
			]);
		}
	});
});
