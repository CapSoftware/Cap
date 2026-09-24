import { afterEach, describe, expect, it, vi } from "vitest";
import { coverRect, imageSize, loadOgThumbnail } from "../../lib/og/thumbnail";

const png = (width: number, height: number) => {
	const buf = Buffer.alloc(33);
	buf.writeUInt32BE(0x89504e47, 0);
	buf.writeUInt32BE(0x0d0a1a0a, 4);
	buf.writeUInt32BE(13, 8);
	buf.write("IHDR", 12, "ascii");
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
};

const jpeg = (width: number, height: number) =>
	Buffer.from([
		0xff,
		0xd8,
		0xff,
		0xe0,
		0x00,
		0x04,
		0x00,
		0x00,
		0xff,
		0xc0,
		0x00,
		0x11,
		0x08,
		height >> 8,
		height & 0xff,
		width >> 8,
		width & 0xff,
		0x03,
		0,
		0,
		0,
		0,
		0,
		0,
	]);

const webpLossless = (width: number, height: number) => {
	const buf = Buffer.alloc(30);
	buf.write("RIFF", 0, "ascii");
	buf.write("WEBP", 8, "ascii");
	buf.write("VP8L", 12, "ascii");
	buf.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
	return buf;
};

describe("imageSize", () => {
	it("reads PNG, JPEG, WebP and GIF headers", () => {
		expect(imageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
		expect(imageSize(jpeg(1440, 900))).toEqual({ width: 1440, height: 900 });
		expect(imageSize(webpLossless(800, 600))).toEqual({
			width: 800,
			height: 600,
		});
		const gif = Buffer.alloc(10);
		gif.write("GIF89a", 0, "ascii");
		gif.writeUInt16LE(320, 6);
		gif.writeUInt16LE(240, 8);
		expect(imageSize(gif)).toEqual({ width: 320, height: 240 });
	});

	it("rejects unknown or truncated data", () => {
		expect(imageSize(Buffer.from("not an image"))).toBeUndefined();
		expect(imageSize(Buffer.from([0xff, 0xd8, 0xff]))).toBeUndefined();
		expect(imageSize(png(0, 100))).toBeUndefined();
	});
});

describe("coverRect", () => {
	const box = { width: 600, height: 338 };

	it("fills the box and centres the overflow", () => {
		const tall = coverRect({ width: 1440, height: 1080 }, box);
		expect(tall.width).toBe(600);
		expect(tall.height).toBeGreaterThanOrEqual(338);
		expect(tall.top).toBe(Math.floor((338 - tall.height) / 2));
		const wide = coverRect({ width: 3000, height: 1000 }, box);
		expect(wide.height).toBe(338);
		expect(wide.width).toBeGreaterThanOrEqual(600);
		expect(wide.left).toBe(Math.floor((600 - wide.width) / 2));
	});
});

describe("loadOgThumbnail", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("keeps data URIs and measures them", async () => {
		const uri = `data:image/png;base64,${png(1280, 720).toString("base64")}`;
		expect(await loadOgThumbnail(uri)).toEqual({
			src: uri,
			width: 1280,
			height: 720,
		});
	});

	it("inlines remote images", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(jpeg(1440, 900))),
		);
		const thumb = await loadOgThumbnail("https://example.com/shot.jpg");
		expect(thumb?.width).toBe(1440);
		expect(thumb?.src.startsWith("data:image/jpeg;base64,")).toBe(true);
	});

	it("returns undefined when the image can't be loaded", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 403 })),
		);
		expect(await loadOgThumbnail("https://example.com/x.png")).toBeUndefined();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network");
			}),
		);
		expect(await loadOgThumbnail("https://example.com/x.png")).toBeUndefined();
		expect(await loadOgThumbnail("file:///etc/passwd")).toBeUndefined();
	});
});
