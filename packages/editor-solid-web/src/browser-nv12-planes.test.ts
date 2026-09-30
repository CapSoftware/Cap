import { describe, expect, test } from "bun:test";
import { nv12Planes, takesNv12Planes } from "./browser-nv12-planes";

function fakeFrame(
	width: number,
	height: number,
	options: { format?: string; fullRange?: boolean } = {},
) {
	const copies: Array<{ length: number; layout: unknown }> = [];
	const frame = {
		format: options.format ?? "NV12",
		colorSpace: { fullRange: options.fullRange ?? false },
		visibleRect: { x: 0, y: 0, width, height },
		displayWidth: width,
		displayHeight: height,
		copyTo: async (buffer: Uint8Array, init: { layout: unknown }) => {
			copies.push({ length: buffer.length, layout: init.layout });
			return [];
		},
	};
	return { frame: frame as unknown as VideoFrame, copies };
}

describe("takesNv12Planes", () => {
	test("takes NV12 only", () => {
		expect(takesNv12Planes(fakeFrame(4, 4).frame)).toBe(true);
		expect(takesNv12Planes(fakeFrame(4, 4, { format: "I420" }).frame)).toBe(
			false,
		);
	});
});

describe("nv12Planes", () => {
	test("packs the UV plane straight after the Y plane", async () => {
		const { frame, copies } = fakeFrame(1920, 1080);
		const planes = await nv12Planes(frame);
		expect(planes).toMatchObject({
			width: 1920,
			height: 1080,
			yStride: 1920,
			uvStride: 1920,
			fullRange: false,
		});
		expect(planes.nv12.length).toBe(1920 * 1080 * 1.5);
		expect(copies[0]?.layout).toEqual([
			{ offset: 0, stride: 1920 },
			{ offset: 1920 * 1080, stride: 1920 },
		]);
	});

	test("passes the decoder's range on", async () => {
		const planes = await nv12Planes(fakeFrame(4, 4, { fullRange: true }).frame);
		expect(planes.fullRange).toBe(true);
	});

	test("rounds odd sizes up to whole chroma samples", async () => {
		const { frame } = fakeFrame(5, 3);
		const planes = await nv12Planes(frame);
		expect(planes.uvStride).toBe(6);
		expect(planes.nv12.length).toBe(5 * 3 + 6 * 2);
	});
});
