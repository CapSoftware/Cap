import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { parseVideoIdFromObjectKey } from "./GoogleDrive.ts";

describe("parseVideoIdFromObjectKey", () => {
	it("extracts the video id from user/video object keys", () => {
		const result = parseVideoIdFromObjectKey("owner-1/video-1/source.mp4");

		expect(Option.isSome(result)).toBe(true);
		expect(result.pipe(Option.getOrElse(() => ""))).toBe("video-1");
	});

	it("returns none when the object key does not include a video segment", () => {
		expect(Option.isNone(parseVideoIdFromObjectKey("owner-1"))).toBe(true);
		expect(Option.isNone(parseVideoIdFromObjectKey("owner-1/"))).toBe(true);
	});
});
