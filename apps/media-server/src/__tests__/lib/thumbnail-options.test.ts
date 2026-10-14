import { describe, expect, test } from "bun:test";
import { resolveThumbnailOptions } from "../../lib/media-video";

describe("resolveThumbnailOptions", () => {
	test("keeps defaults for fields a request leaves undefined", () => {
		expect(
			resolveThumbnailOptions({
				timestamp: undefined,
				width: undefined,
				height: undefined,
				quality: undefined,
			}),
		).toEqual({ timestamp: 1, width: 1280, height: 720, quality: 85 });
	});

	test("applies provided values", () => {
		expect(resolveThumbnailOptions({ width: 640, quality: 50 })).toMatchObject({
			width: 640,
			height: 720,
			quality: 50,
		});
	});
});
