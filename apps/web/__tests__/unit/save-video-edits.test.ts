import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentUserMock = vi.fn();
const whereMock = vi.fn();
const selectMock = vi.fn(() => ({
	from: vi.fn(() => ({
		where: whereMock,
	})),
}));
const insertMock = vi.fn();

vi.mock("@cap/database", () => ({
	db: () => ({
		select: selectMock,
		insert: insertMock,
	}),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: getCurrentUserMock,
}));

vi.mock("@cap/utils", () => ({
	userIsPro: (user?: { isPro?: boolean } | null) => Boolean(user?.isPro),
}));

vi.mock("@cap/web-backend", () => ({
	Storage: {
		getAccessForVideo: vi.fn(),
	},
}));

vi.mock("workflow/api", () => ({
	start: vi.fn(),
}));

vi.mock("@/lib/server", () => ({
	runPromise: vi.fn(),
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: vi.fn(),
}));

vi.mock("server-only", () => ({}));

describe("saveVideoEdits", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("requires an owner session", async () => {
		getCurrentUserMock.mockResolvedValueOnce(null);
		const { saveVideoEdits } = await import("@/actions/videos/save-edits");

		await expect(
			saveVideoEdits("video-1" as never, {
				version: 1,
				sourceDuration: 10,
				keepRanges: [{ start: 0, end: 10 }],
			}),
		).rejects.toThrow("Unauthorized");

		expect(selectMock).not.toHaveBeenCalled();
	});

	it("rejects active processing rows before saving", async () => {
		getCurrentUserMock.mockResolvedValueOnce({ id: "user-1", isPro: true });
		whereMock
			.mockResolvedValueOnce([
				{
					id: "video-1",
					ownerId: "user-1",
					duration: 10,
					source: { type: "webMP4" },
					isScreenshot: false,
					metadata: null,
				},
			])
			.mockResolvedValueOnce([{ phase: "processing" }]);
		const { saveVideoEdits } = await import("@/actions/videos/save-edits");

		await expect(
			saveVideoEdits("video-1" as never, {
				version: 1,
				sourceDuration: 10,
				keepRanges: [{ start: 0, end: 10 }],
			}),
		).rejects.toThrow("Video is already uploading or processing");

		expect(insertMock).not.toHaveBeenCalled();
	});

	it("rejects completed edit rows before the workflow clears them", async () => {
		getCurrentUserMock.mockResolvedValueOnce({ id: "user-1", isPro: true });
		whereMock
			.mockResolvedValueOnce([
				{
					id: "video-1",
					ownerId: "user-1",
					duration: 10,
					source: { type: "webMP4" },
					isScreenshot: false,
					metadata: null,
				},
			])
			.mockResolvedValueOnce([{ phase: "complete" }]);
		const { saveVideoEdits } = await import("@/actions/videos/save-edits");

		await expect(
			saveVideoEdits("video-1" as never, {
				version: 1,
				sourceDuration: 10,
				keepRanges: [{ start: 0, end: 10 }],
			}),
		).rejects.toThrow("Video is already uploading or processing");

		expect(insertMock).not.toHaveBeenCalled();
	});

	it("requires Cap Pro before saving edits", async () => {
		getCurrentUserMock.mockResolvedValueOnce({ id: "user-1", isPro: false });
		const { saveVideoEdits } = await import("@/actions/videos/save-edits");

		await expect(
			saveVideoEdits("video-1" as never, {
				version: 1,
				sourceDuration: 10,
				keepRanges: [{ start: 0, end: 10 }],
			}),
		).rejects.toThrow("Cap Pro is required to edit videos");

		expect(selectMock).not.toHaveBeenCalled();
	});
});
