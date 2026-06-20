import { describe, expect, it } from "vitest";
import {
	canChangeOrganizationMemberRole,
	canChangeSpaceMemberRole,
	canManageOrganizationBilling,
	canManageOrganizationMembers,
	canManageOrganizationProSeats,
	canManageSpace,
	canRemoveOrganizationMember,
	canRemoveSpaceMember,
	canViewOrganizationSettings,
	getEffectiveOrganizationRole,
	getEffectiveSpaceRole,
	normalizeAssignableOrganizationRole,
	normalizeOrganizationRole,
	normalizeSpaceRole,
} from "@/lib/permissions/roles";

describe("organization role permissions", () => {
	it("normalizes organization roles and rejects non-assignable owner changes", () => {
		expect(normalizeOrganizationRole("OWNER")).toBe("owner");
		expect(normalizeOrganizationRole("admin")).toBe("admin");
		expect(normalizeOrganizationRole("member")).toBe("member");
		expect(normalizeOrganizationRole("unknown")).toBeNull();
		expect(normalizeAssignableOrganizationRole("admin")).toBe("admin");
		expect(normalizeAssignableOrganizationRole("member")).toBe("member");
		expect(normalizeAssignableOrganizationRole("owner")).toBeNull();
	});

	it("derives owner from organization ownership even when membership role differs", () => {
		expect(
			getEffectiveOrganizationRole({
				userId: "user-1",
				ownerId: "user-1",
				memberRole: "member",
			}),
		).toBe("owner");
		expect(
			getEffectiveOrganizationRole({
				userId: "user-2",
				ownerId: "user-1",
				memberRole: "admin",
			}),
		).toBe("admin");
		expect(
			getEffectiveOrganizationRole({
				userId: "stale-owner-row",
				ownerId: "real-owner",
				memberRole: "owner",
			}),
		).toBe("member");
	});

	it("allows only owners and admins to view and manage organization members", () => {
		expect(canViewOrganizationSettings("owner")).toBe(true);
		expect(canViewOrganizationSettings("admin")).toBe(true);
		expect(canViewOrganizationSettings("member")).toBe(false);
		expect(canManageOrganizationMembers("owner")).toBe(true);
		expect(canManageOrganizationMembers("admin")).toBe(true);
		expect(canManageOrganizationMembers("member")).toBe(false);
		expect(canManageOrganizationBilling("owner")).toBe(true);
		expect(canManageOrganizationBilling("admin")).toBe(false);
		expect(canManageOrganizationProSeats("owner")).toBe(true);
		expect(canManageOrganizationProSeats("admin")).toBe(true);
		expect(canManageOrganizationProSeats("member")).toBe(false);
	});

	it("lets owners and admins assign admin/member roles to non-owner members", () => {
		for (const actorRole of ["owner", "admin"] as const) {
			for (const nextRole of ["admin", "member"] as const) {
				expect(
					canChangeOrganizationMemberRole({
						actorRole,
						actorUserId: "actor",
						targetUserId: "target",
						ownerId: "owner",
						targetRole: "member",
						nextRole,
					}),
				).toBe(true);
			}
		}
	});

	it("protects organization owners, peer admins, and actor self role from role changes", () => {
		expect(
			canChangeOrganizationMemberRole({
				actorRole: "admin",
				actorUserId: "admin",
				targetUserId: "owner",
				ownerId: "owner",
				targetRole: "owner",
				nextRole: "member",
			}),
		).toBe(false);
		expect(
			canChangeOrganizationMemberRole({
				actorRole: "admin",
				actorUserId: "admin-1",
				targetUserId: "admin-2",
				ownerId: "owner",
				targetRole: "admin",
				nextRole: "member",
			}),
		).toBe(false);
		expect(
			canChangeOrganizationMemberRole({
				actorRole: "owner",
				actorUserId: "owner",
				targetUserId: "admin",
				ownerId: "owner",
				targetRole: "admin",
				nextRole: "member",
			}),
		).toBe(true);
		expect(
			canChangeOrganizationMemberRole({
				actorRole: "admin",
				actorUserId: "admin",
				targetUserId: "admin",
				ownerId: "owner",
				targetRole: "admin",
				nextRole: "member",
			}),
		).toBe(false);
		expect(
			canChangeOrganizationMemberRole({
				actorRole: "member",
				actorUserId: "member",
				targetUserId: "target",
				ownerId: "owner",
				targetRole: "member",
				nextRole: "admin",
			}),
		).toBe(false);
	});

	it("lets admins remove members but never owners, peer admins, or themselves", () => {
		expect(
			canRemoveOrganizationMember({
				actorRole: "admin",
				actorUserId: "admin",
				targetUserId: "member",
				ownerId: "owner",
				targetRole: "member",
			}),
		).toBe(true);
		expect(
			canRemoveOrganizationMember({
				actorRole: "admin",
				actorUserId: "admin",
				targetUserId: "owner",
				ownerId: "owner",
				targetRole: "owner",
			}),
		).toBe(false);
		expect(
			canRemoveOrganizationMember({
				actorRole: "admin",
				actorUserId: "admin-1",
				targetUserId: "admin-2",
				ownerId: "owner",
				targetRole: "admin",
			}),
		).toBe(false);
		expect(
			canRemoveOrganizationMember({
				actorRole: "owner",
				actorUserId: "owner",
				targetUserId: "admin",
				ownerId: "owner",
				targetRole: "admin",
			}),
		).toBe(true);
		expect(
			canRemoveOrganizationMember({
				actorRole: "admin",
				actorUserId: "admin",
				targetUserId: "admin",
				ownerId: "owner",
				targetRole: "admin",
			}),
		).toBe(false);
	});
});

describe("space role permissions", () => {
	it("normalizes current and legacy space admin roles", () => {
		expect(normalizeSpaceRole("admin")).toBe("admin");
		expect(normalizeSpaceRole("Admin")).toBe("admin");
		expect(normalizeSpaceRole("member")).toBe("member");
		expect(normalizeSpaceRole("owner")).toBeNull();
	});

	it("treats the creator as a space admin", () => {
		expect(
			getEffectiveSpaceRole({
				userId: "creator",
				createdById: "creator",
				memberRole: "member",
			}),
		).toBe("admin");
		expect(
			getEffectiveSpaceRole({
				userId: "member",
				createdById: "creator",
				memberRole: "Admin",
			}),
		).toBe("admin");
	});

	it("allows organization owners, organization admins, and space admins to manage a space", () => {
		expect(canManageSpace({ organizationRole: "owner", spaceRole: null })).toBe(
			true,
		);
		expect(canManageSpace({ organizationRole: "admin", spaceRole: null })).toBe(
			true,
		);
		expect(
			canManageSpace({ organizationRole: "member", spaceRole: "admin" }),
		).toBe(true);
		expect(
			canManageSpace({ organizationRole: "member", spaceRole: "member" }),
		).toBe(false);
		expect(canManageSpace({ organizationRole: null, spaceRole: null })).toBe(
			false,
		);
	});

	it("protects the space creator from role changes and removal", () => {
		expect(
			canChangeSpaceMemberRole({
				canManage: true,
				targetUserId: "creator",
				createdById: "creator",
				nextRole: "member",
			}),
		).toBe(false);
		expect(
			canRemoveSpaceMember({
				canManage: true,
				targetUserId: "creator",
				createdById: "creator",
			}),
		).toBe(false);
		expect(
			canChangeSpaceMemberRole({
				canManage: true,
				targetUserId: "member",
				createdById: "creator",
				nextRole: "admin",
			}),
		).toBe(true);
		expect(
			canRemoveSpaceMember({
				canManage: true,
				targetUserId: "member",
				createdById: "creator",
			}),
		).toBe(true);
	});
});
