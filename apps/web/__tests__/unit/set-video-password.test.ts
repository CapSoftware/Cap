import { beforeEach, describe, expect, it, vi } from "vitest";

const updateSet = vi.hoisted(() => vi.fn());
const hashPasswordMock = vi.hoisted(() =>
	vi.fn(async (p: string) => `hash:${p}`),
);

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
vi.mock("@cap/database/crypto", () => ({
	hashPassword: hashPasswordMock,
	verifyPassword: vi.fn(),
}));
vi.mock("@cap/database/schema", () => ({
	spaces: {},
	spaceVideos: {},
	videos: { id: "id" },
}));
vi.mock("@cap/web-backend", () => ({ collectPasswordHashes: vi.fn() }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/password-cookie", () => ({
	setVerifiedPasswordCookie: vi.fn(),
}));

import { setVideoPassword } from "@/actions/videos/password";

describe("setVideoPassword", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		updateSet.mockReturnValue({ where: vi.fn(() => Promise.resolve()) });
	});

	it.each(["", "   "])(
		"rejects a blank password (%j) without saving",
		async (blank) => {
			const result = await setVideoPassword("video-1" as never, blank);

			expect(result.success).toBe(false);
			expect(updateSet).not.toHaveBeenCalled();
		},
	);

	it("saves a real password", async () => {
		const result = await setVideoPassword("video-1" as never, "hunter2");

		expect(result.success).toBe(true);
		expect(updateSet).toHaveBeenCalledWith({ password: "hash:hunter2" });
	});
});
