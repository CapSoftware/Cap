import { Organisation, User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateOrganizationVideoSharing } from "@/actions/organization/default-video-visibility";

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	access: vi.fn(),
	set: vi.fn(),
	where: vi.fn(),
	revalidate: vi.fn(),
}));

vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				leftJoin: () => ({ where: () => ({ limit: mocks.access }) }),
			}),
		}),
		update: () => ({ set: mocks.set }),
	}),
}));

const userId = User.UserId.make("fixture-user");
const organizationId = Organisation.OrganisationId.make("fixture-org");

describe("organization-only sharing settings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.user.mockResolvedValue({
			id: userId,
			activeOrganizationId: organizationId,
		});
		mocks.access.mockResolvedValue([
			{
				id: organizationId,
				ownerId: userId,
				memberId: "fixture-member",
				memberRole: "owner",
			},
		]);
		mocks.set.mockReturnValue({ where: mocks.where });
		mocks.where.mockResolvedValue(undefined);
	});

	it.each([true, false])(
		"lets the owner set the lock to %s without rewriting videos",
		async (restricted) => {
			await expect(
				updateOrganizationVideoSharing(organizationId, restricted),
			).resolves.toEqual({ success: true });
			expect(mocks.set).toHaveBeenCalledExactlyOnceWith({
				videoSharingRestrictedToOrg: restricted,
			});
			expect(mocks.revalidate).toHaveBeenCalledWith("/s/[videoId]", "page");
			expect(mocks.revalidate).toHaveBeenCalledWith("/embed/[videoId]", "page");
		},
	);

	it("lets organization admins manage the lock", async () => {
		mocks.access.mockResolvedValue([
			{
				id: organizationId,
				ownerId: "other-owner",
				memberId: "fixture-member",
				memberRole: "admin",
			},
		]);
		await expect(
			updateOrganizationVideoSharing(organizationId, true),
		).resolves.toEqual({
			success: true,
		});
	});

	it("keeps the displayed organization when another tab switches context", async () => {
		mocks.user.mockResolvedValue({
			id: userId,
			activeOrganizationId: "other-org",
		});
		await expect(
			updateOrganizationVideoSharing(organizationId, true),
		).resolves.toEqual({ success: true });
		expect(mocks.set).toHaveBeenCalledExactlyOnceWith({
			videoSharingRestrictedToOrg: true,
		});
	});

	it("denies ordinary members", async () => {
		mocks.access.mockResolvedValue([
			{
				id: organizationId,
				ownerId: "other-owner",
				memberId: "fixture-member",
				memberRole: "member",
			},
		]);
		await expect(
			updateOrganizationVideoSharing(organizationId, false),
		).rejects.toThrow("only available to admins and owners");
		expect(mocks.set).not.toHaveBeenCalled();
	});

	it("denies users without organization access", async () => {
		mocks.access.mockResolvedValue([]);
		await expect(
			updateOrganizationVideoSharing(organizationId, false),
		).rejects.toThrow("Forbidden");
		expect(mocks.set).not.toHaveBeenCalled();
	});

	it("requires sign-in", async () => {
		mocks.user.mockResolvedValue(null);
		await expect(
			updateOrganizationVideoSharing(organizationId, true),
		).rejects.toThrow("Unauthorized");
		expect(mocks.set).not.toHaveBeenCalled();
	});

	it("validates direct action inputs", async () => {
		await expect(
			updateOrganizationVideoSharing(
				organizationId,
				"true" as unknown as boolean,
			),
		).rejects.toThrow("Invalid sharing setting");
		expect(mocks.set).not.toHaveBeenCalled();
	});
});
