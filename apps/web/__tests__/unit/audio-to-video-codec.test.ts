import { describe, expect, it } from "vitest";
import { firstWorkingVideoCodec } from "@/lib/audio-to-video";

describe("firstWorkingVideoCodec", () => {
	it("keeps H.264 when it encodes", async () => {
		const tried: string[] = [];
		const codec = await firstWorkingVideoCodec(
			["avc", "vp9", "av1", "vp8"],
			async (candidate) => {
				tried.push(candidate);
				return true;
			},
		);
		expect(codec).toBe("avc");
		expect(tried).toEqual(["avc"]);
	});

	it("moves past a codec whose encode fails", async () => {
		const tried: string[] = [];
		const codec = await firstWorkingVideoCodec(
			["avc", "vp9", "av1", "vp8"],
			async (candidate) => {
				tried.push(candidate);
				return candidate !== "avc";
			},
		);
		expect(codec).toBe("vp9");
		expect(tried).toEqual(["avc", "vp9"]);
	});

	it("returns null when nothing encodes", async () => {
		expect(
			await firstWorkingVideoCodec(["avc", "vp9"], async () => false),
		).toBeNull();
	});
});
