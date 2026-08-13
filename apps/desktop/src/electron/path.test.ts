import { describe, expect, it } from "vitest";

import { basename } from "./path";

describe("Electron path basename", () => {
	it("keeps the filename when no suffix is provided", async () => {
		await expect(basename("/tmp/video.mp4")).resolves.toBe("video.mp4");
		await expect(basename("/tmp/video.mp4", "")).resolves.toBe("video.mp4");
	});

	it("removes only a matching trailing suffix", async () => {
		await expect(basename("/tmp/video.mp4", ".mp4")).resolves.toBe("video");
		await expect(basename("/tmp/.mp4-video", ".mp4")).resolves.toBe(
			".mp4-video",
		);
		await expect(basename("C:\\tmp\\video.mp4", ".mov")).resolves.toBe(
			"video.mp4",
		);
	});
});
