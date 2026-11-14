import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationInvites,
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = {
	select: vi.fn(),
	update: vi.fn(),
	delete: vi.fn(),
	insert: vi.fn(),
	values: vi.fn(),
	from: vi.fn(),
	where: vi.fn(),
	for: vi.fn(),
	limit: vi.fn(),
	set: vi.fn(),
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
		organizationId: "organizationId",
		status: "status",
	},
	organizationMembers: {
		id: "memberId",
		userId: "memberUserId",
		organizationId: "memberOrganizationId",
		hasProSeat: "memberHasProSeat",
	},
	organizations: { id: "organizationsId" },
	spaceMembers: {
		userId: "spaceMemberUserId",
		spaceId: "spaceMemberSpaceId",
	},
	spaces: {
		id: "spaceId",
		organizationId: "spaceOrganizationId",
	},
	users: {
		id: "userId",
		thirdPartyStripeSubscriptionId: "thirdPartyStripeSubscriptionId",
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	inArray: vi.fn((field: unknown, values: unknown[]) => ({ field, values })),
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
	mockDb.update.mockReturnValue(mockDb);
	mockDb.delete.mockReturnValue(mockDb);
	mockDb.insert.mockReturnValue(mockDb);
	mockDb.values.mockResolvedValue(undefined);
	mockDb.from.mockReturnValue(mockDb);
	mockDb.where.mockReturnValue(mockDb);
	mockDb.set.mockReturnValue(mockDb);
	mockDb.for.mockResolvedValue([]);
	mockDb.limit.mockResolvedValue([]);
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
			activeOrganizationId: null,
			defaultOrgId: null,
		});
		mockDb.for.mockResolvedValueOnce([
			{
				id: "invite-1",
				invitedEmail: "invitee@example.com",
				organizationId: "org-1",
			},
		]);
		mockDb.limit.mockReturnValueOnce(mockDb);

		const response = await POST(makeRequest({ inviteId: "invite-1" }));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
		expect(mockDb.delete).toHaveBeenCalledTimes(1);
		expect(mockDb.transaction).toHaveBeenCalledTimes(1);
	});

	describe("when the invite was why signup skipped the personal organization", () => {
		beforeEach(() => {
			mockGetCurrentUser.mockResolvedValue({
				id: "user-1",
				email: "invitee@example.com",
				activeOrganizationId: "",
				defaultOrgId: null,
			});
			mockDb.for.mockResolvedValueOnce([
				{
					id: "invite-1",
					invitedEmail: "invitee@example.com",
					organizationId: "org-1",
				},
			]);
			mockDb.limit.mockReturnValueOnce(mockDb);
		});

		it("gives the user a personal organization once nothing else is left", async () => {
			const response = await POST(makeRequest({ inviteId: "invite-1" }));

			expect(response.status).toBe(200);
			expect(mockDb.insert).toHaveBeenCalledWith(organizations);
			const [organization] = mockDb.values.mock.calls[0] ?? [];
			expect(organization).toMatchObject({
				ownerId: "user-1",
				name: "My Organization",
			});
			expect(mockDb.values).toHaveBeenCalledWith(
				expect.objectContaining({
					organizationId: organization.id,
					userId: "user-1",
					role: "owner",
				}),
			);
			expect(mockDb.set).toHaveBeenCalledWith({
				activeOrganizationId: organization.id,
				defaultOrgId: organization.id,
			});
		});

		it("locks the membership, then the user row, before any plain read", async () => {
			await POST(makeRequest({ inviteId: "invite-1" }));

			expect(mockDb.from.mock.calls.map(([table]) => table)).toEqual([
				organizationInvites,
				organizationMembers,
				users,
				organizationMembers,
				organizationInvites,
			]);
			const [, membershipRead, userRead, firstPlainRead] =
				mockDb.from.mock.invocationCallOrder;
			const [, membershipLock, userLock] = mockDb.for.mock.invocationCallOrder;
			expect(membershipLock).toBeGreaterThan(membershipRead ?? 0);
			expect(userRead).toBeGreaterThan(
				membershipLock ?? Number.POSITIVE_INFINITY,
			);
			expect(userLock).toBeGreaterThan(userRead ?? 0);
			expect(firstPlainRead).toBeGreaterThan(
				userLock ?? Number.POSITIVE_INFINITY,
			);
		});

		it("waits for the other pending invite instead of adding an empty organization", async () => {
			mockDb.limit
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([{ id: "invite-2" }]);

			const response = await POST(makeRequest({ inviteId: "invite-1" }));

			expect(response.status).toBe(200);
			expect(mockDb.insert).not.toHaveBeenCalled();
		});

		it("keeps an organization the user already belongs to", async () => {
			mockDb.limit.mockResolvedValueOnce([{ organizationId: "org-2" }]);

			const response = await POST(makeRequest({ inviteId: "invite-1" }));

			expect(response.status).toBe(200);
			expect(mockDb.insert).not.toHaveBeenCalled();
		});
	});
});
