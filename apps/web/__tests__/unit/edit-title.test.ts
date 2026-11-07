import { beforeEach, describe, expect, it, vi } from "vitest";

const updateSet = vi.hoisted(() => vi.fn());

const mockDb = vi.hoisted(() => ({
	select: vi.fn(() => mockDb),
	from: vi.fn(() => mockDb),
	where: vi.fn(() => Promise.resolve([{ id: "video-1", ownerId: "user-1" }])),
	update: vi.fn(() => mockDb),
	set: updateSet,
}));

vi.mock("@cap/database", () => ({ db: vi.fn(() => mockDb) }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@cap/database/schema", () => ({ videos: { id: "id" } }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), sql: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: vi.fn(),
}));

import { editTitle } from "@/actions/videos/edit-title";

describe("editTitle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		updateSet.mockReturnValue({ where: vi.fn(() => Promise.resolve()) });
	});

	it("rejects a whitespace-only title without saving", async () => {
		await expect(editTitle("video-1" as never, "   ")).rejects.toThrow();
		expect(updateSet).not.toHaveBeenCalled();
	});

	it("saves the trimmed title", async () => {
		await editTitle("video-1" as never, "  My Cap  ");
		expect(updateSet).toHaveBeenCalledWith(
			expect.objectContaining({ name: "My Cap" }),
		);
	});
});
