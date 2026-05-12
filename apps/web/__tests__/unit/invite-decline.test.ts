import { getCurrentUser } from "@cap/database/auth/session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = {
	select: vi.fn(),
	delete: vi.fn(),
	from: vi.fn(),
	where: vi.fn(),
	for: vi.fn(),
	transaction: vi.fn(),
};

vi.mock("@cap/database", () => ({
	db: () => mockDb,
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

vi.mock("@cap/database/schema", () => ({
	organizationInvites: {
		id: "id",
		invitedEmail: "invitedEmail",
	},
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;

function resetMockDb() {
	for (const key of Object.keys(mockDb)) {
		const fn = mockDb[key as keyof typeof mockDb];
		if (typeof fn?.mockClear === "function") {
			fn.mockClear();
		}
	}
	mockDb.select.mockReturnValue(mockDb);
	mockDb.delete.mockReturnValue(mockDb);
	mockDb.from.mockReturnValue(mockDb);
	mockDb.where.mockReturnValue(mockDb);
	mockDb.for.mockResolvedValue([]);
	mockDb.transaction.mockImplementation((fn) => fn(mockDb));
}

function makeRequest(body: unknown) {
	return new Request("https://cap.test/api/invite/decline", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}) as unknown as import("next/server").NextRequest;
}

describe("POST /api/invite/decline", () => {
	let POST: typeof import("@/app/api/invite/decline/route").POST;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		const mod = await import("@/app/api/invite/decline/route");
		POST = mod.POST;
	});

	it("returns 401 when the requester is not authenticated", async () => {
		mockGetCurrentUser.mockResolvedValue(null);

		const response = await POST(makeRequest({ inviteId: "invite-1" }));

		expect(response.status).toBe(401);
		expect(mockDb.delete).not.toHaveBeenCalled();
	});

	it("returns 400 when inviteId is missing", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "invitee@example.com",
		});

		const response = await POST(makeRequest({}));

		expect(response.status).toBe(400);
		expect(mockDb.delete).not.toHaveBeenCalled();
	});

	it("returns 404 when the invite does not exist", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "invitee@example.com",
		});
		mockDb.for.mockResolvedValueOnce([]);

		const response = await POST(makeRequest({ inviteId: "invite-1" }));

		expect(response.status).toBe(404);
		expect(mockDb.delete).not.toHaveBeenCalled();
	});

	it("returns 403 when the authenticated user is not the invitee", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "attacker@example.com",
		});
		mockDb.for.mockResolvedValueOnce([
			{ id: "invite-1", invitedEmail: "invitee@example.com" },
		]);

		const response = await POST(makeRequest({ inviteId: "invite-1" }));

		expect(response.status).toBe(403);
		expect(mockDb.delete).not.toHaveBeenCalled();
	});

	it("deletes the invite when the authenticated user is the invitee", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "Invitee@Example.com",
		});
		mockDb.for.mockResolvedValueOnce([
			{ id: "invite-1", invitedEmail: "invitee@example.com" },
		]);

		const response = await POST(makeRequest({ inviteId: "invite-1" }));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
		expect(mockDb.delete).toHaveBeenCalledTimes(1);
		expect(mockDb.transaction).toHaveBeenCalledTimes(1);
	});
});
