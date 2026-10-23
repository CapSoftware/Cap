import { stat } from "@tauri-apps/plugin-fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordingThumbnailUrl } from "./recording-thumbnail";

vi.mock("@tauri-apps/api/core", () => ({
	convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ stat: vi.fn() }));

function metadata(mtime: number, size = 1234) {
	return { isFile: true, mtime: new Date(mtime), size } as Awaited<
		ReturnType<typeof stat>
	>;
}

describe("recording thumbnails", () => {
	beforeEach(() => vi.resetAllMocks());

	it("loads the edited preview and reuses its URL until the file changes", async () => {
		vi.mocked(stat).mockResolvedValue(metadata(1000));
		const first = await recordingThumbnailUrl("/recording.cap");
		expect(await recordingThumbnailUrl("/recording.cap")).toBe(first);
		expect(first).toBe(
			"asset:///recording.cap/screenshots/preview.jpg?v=1000-1234",
		);
		vi.mocked(stat).mockResolvedValue(metadata(2000));
		expect(await recordingThumbnailUrl("/recording.cap")).not.toBe(first);
	});

	it("falls back to the original capture for older recordings", async () => {
		vi.mocked(stat)
			.mockRejectedValueOnce(new Error("missing preview"))
			.mockResolvedValueOnce(metadata(500));
		expect(await recordingThumbnailUrl("/legacy.cap")).toBe(
			"asset:///legacy.cap/screenshots/display.jpg?v=500-1234",
		);
	});

	it("retains a usable fallback path when no thumbnail exists yet", async () => {
		vi.mocked(stat).mockRejectedValue(new Error("missing"));
		expect(await recordingThumbnailUrl("/new.cap")).toBe(
			"asset:///new.cap/screenshots/display.jpg",
		);
	});
});
