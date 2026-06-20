"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoIdLength } from "@cap/database/helpers";
import { organizationMembers, spaceMembers } from "@cap/database/schema";
import { type Organisation, Space, User } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { requireSpaceManager } from "@/actions/organization/space-authorization";
import {
	canRemoveSpaceMember,
	normalizeSpaceRole,
	type SpaceRole,
} from "@/lib/permissions/roles";

const spaceRole = z.preprocess(
	(value) => (value === "Admin" ? "admin" : value),
	z.union([z.literal("admin"), z.literal("member")]),
);

const spaceMemberRoleSchema = z.object({
	userId: z.string().transform((v) => User.UserId.make(v)),
	role: spaceRole,
});

const addSpaceMemberSchema = z.object({
	spaceId: z.string().transform((v) => Space.SpaceId.make(v)),
	userId: z.string().transform((v) => User.UserId.make(v)),
	role: spaceRole,
});

const addSpaceMembersSchema = z.object({
	spaceId: z.string().transform((v) => Space.SpaceId.make(v)),
	userIds: z.array(z.string().transform((v) => User.UserId.make(v))),
	role: spaceRole,
});

async function assertUsersBelongToOrganization(
	organizationId: Organisation.OrganisationId,
	organizationOwnerId: User.UserId,
	userIds: User.UserId[],
) {
	const uniqueUserIds = Array.from(new Set(userIds));
	if (uniqueUserIds.length === 0) return;

	const rows = await db()
		.select({ userId: organizationMembers.userId })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				inArray(
					organizationMembers.userId,
					uniqueUserIds.map((id) => User.UserId.make(id)),
				),
			),
		);
	const allowedUserIds = new Set([
		organizationOwnerId,
		...rows.map((row) => row.userId),
	]);
	const invalidUserIds = uniqueUserIds.filter((id) => !allowedUserIds.has(id));

	if (invalidUserIds.length > 0) {
		throw new Error("All space members must belong to the organization");
	}
}

export async function addSpaceMember(
	data: z.infer<typeof addSpaceMemberSchema>,
) {
	const validation = addSpaceMemberSchema.safeParse(data);

	if (!validation.success) {
		throw new Error("Invalid input");
	}

	const currentUser = await getCurrentUser();

	if (!currentUser) {
		throw new Error("Unauthorized");
	}

	const { spaceId, userId, role } = validation.data;
	const access = await requireSpaceManager(currentUser.id, spaceId);
	await assertUsersBelongToOrganization(
		access.organizationId,
		access.organizationOwnerId,
		[userId],
	);

	await db()
		.insert(spaceMembers)
		.values({
			id: uuidv4().substring(0, nanoIdLength),
			spaceId,
			userId,
			role,
			createdAt: new Date(),
			updatedAt: new Date(),
		});

	revalidatePath(`/dashboard/spaces/${spaceId}`);

	return { success: true };
}

export async function addSpaceMembers(
	data: z.infer<typeof addSpaceMembersSchema>,
) {
	const validation = addSpaceMembersSchema.safeParse(data);
	if (!validation.success) {
		throw new Error("Invalid input");
	}

	const currentUser = await getCurrentUser();
	if (!currentUser) {
		throw new Error("Unauthorized");
	}

	const { spaceId, userIds, role } = validation.data;
	const access = await requireSpaceManager(currentUser.id, spaceId);
	await assertUsersBelongToOrganization(
		access.organizationId,
		access.organizationOwnerId,
		userIds,
	);

	const existing = await db()
		.select({ userId: spaceMembers.userId })
		.from(spaceMembers)
		.where(eq(spaceMembers.spaceId, spaceId));
	const existingIds = new Set(existing.map((m) => m.userId));
	const newUserIds = userIds.filter((id) => !existingIds.has(id));

	if (newUserIds.length === 0) {
		revalidatePath(`/dashboard/spaces/${spaceId}`);
		return { success: true, added: [], alreadyMembers: userIds };
	}

	const now = new Date();
	const values = newUserIds.map((userId) => ({
		id: uuidv4().substring(0, nanoIdLength),
		spaceId,
		userId,
		role,
		createdAt: now,
		updatedAt: now,
	}));

	await db().insert(spaceMembers).values(values);
	revalidatePath(`/dashboard/spaces/${spaceId}`);
	return {
		success: true,
		added: newUserIds,
		alreadyMembers: Array.from(existingIds),
	};
}

const removeSpaceMemberSchema = z.object({
	memberId: z.string(),
});

export async function removeSpaceMember(
	data: z.infer<typeof removeSpaceMemberSchema>,
) {
	const validation = removeSpaceMemberSchema.safeParse(data);

	if (!validation.success) {
		throw new Error("Invalid input");
	}

	const currentUser = await getCurrentUser();

	if (!currentUser) {
		throw new Error("Unauthorized");
	}

	const { memberId } = validation.data;

	const member = await db()
		.select({ spaceId: spaceMembers.spaceId, userId: spaceMembers.userId })
		.from(spaceMembers)
		.where(eq(spaceMembers.id, memberId))
		.limit(1);

	if (member.length === 0) {
		throw new Error("Member not found");
	}

	const spaceId = member[0]?.spaceId;

	if (!spaceId) {
		throw new Error("Space ID not found");
	}

	const access = await requireSpaceManager(currentUser.id, spaceId);
	if (
		!canRemoveSpaceMember({
			canManage: access.canManage,
			targetUserId: member[0]?.userId,
			createdById: access.createdById,
		})
	) {
		throw new Error("You do not have permission to remove this space member");
	}

	await db().delete(spaceMembers).where(eq(spaceMembers.id, memberId));

	revalidatePath(`/dashboard/spaces/${spaceId}`);

	return { success: true };
}

const setSpaceMembersSchema = z.object({
	spaceId: z
		.string()
		.transform((v) => Space.SpaceId.make(v) as Space.SpaceIdOrOrganisationId),
	userIds: z.array(z.string().transform((v) => User.UserId.make(v))),
	role: spaceRole.default("member"),
	members: z.array(spaceMemberRoleSchema).optional(),
});

export async function setSpaceMembers(
	data: z.infer<typeof setSpaceMembersSchema>,
) {
	const validation = setSpaceMembersSchema.safeParse(data);
	if (!validation.success) {
		throw new Error("Invalid input");
	}
	const currentUser = await getCurrentUser();
	if (!currentUser) {
		throw new Error("Unauthorized");
	}
	const { spaceId, userIds, role, members } = validation.data;

	const access = await requireSpaceManager(currentUser.id, spaceId);

	const submittedMembers =
		members?.map((member) => ({
			userId: member.userId,
			role: normalizeSpaceRole(member.role) ?? "member",
		})) ??
		userIds.map((userId) => ({
			userId,
			role: normalizeSpaceRole(role) ?? "member",
		}));

	await assertUsersBelongToOrganization(
		access.organizationId,
		access.organizationOwnerId,
		submittedMembers.map((member) => member.userId),
	);

	const roleByUserId = new Map(
		submittedMembers.map((member) => [member.userId, member.role]),
	);
	const allMemberIds = Array.from(
		new Set([
			...submittedMembers.map((member) => member.userId),
			access.createdById,
		]),
	);
	const now = new Date();
	const values = allMemberIds.map((userId) => {
		return {
			id: uuidv4().substring(0, nanoIdLength),
			spaceId,
			userId,
			role:
				userId === access.createdById
					? ("admin" as const)
					: ((roleByUserId.get(userId) as SpaceRole | undefined) ?? "member"),
			createdAt: now,
			updatedAt: now,
		};
	});

	await db().delete(spaceMembers).where(eq(spaceMembers.spaceId, spaceId));
	await db().insert(spaceMembers).values(values);

	revalidatePath(`/dashboard/spaces/${spaceId}`);
	return { success: true, count: allMemberIds.length };
}

const batchRemoveSpaceMembersSchema = z.object({
	memberIds: z.array(z.string()),
});

export async function batchRemoveSpaceMembers(
	data: z.infer<typeof batchRemoveSpaceMembersSchema>,
) {
	const validation = batchRemoveSpaceMembersSchema.safeParse(data);
	if (!validation.success) {
		throw new Error("Invalid input");
	}

	const currentUser = await getCurrentUser();
	if (!currentUser) {
		throw new Error("Unauthorized");
	}

	const { memberIds } = validation.data;
	if (memberIds.length === 0) {
		return { success: true, removed: [] };
	}

	const members = await db()
		.select({
			id: spaceMembers.id,
			spaceId: spaceMembers.spaceId,
			userId: spaceMembers.userId,
		})
		.from(spaceMembers)
		.where(inArray(spaceMembers.id, memberIds));
	const spaceId = members[0]?.spaceId;

	if (!spaceId) {
		return { success: true, removed: [] };
	}

	if (members.some((member) => member.spaceId !== spaceId)) {
		throw new Error("Cannot remove members from multiple spaces at once");
	}

	const access = await requireSpaceManager(currentUser.id, spaceId);
	const protectedMember = members.find(
		(member) =>
			!canRemoveSpaceMember({
				canManage: access.canManage,
				targetUserId: member.userId,
				createdById: access.createdById,
			}),
	);

	if (protectedMember) {
		throw new Error("You do not have permission to remove one or more members");
	}

	await db().delete(spaceMembers).where(inArray(spaceMembers.id, memberIds));
	revalidatePath(`/dashboard/spaces/${spaceId}`);
	return { success: true, removed: memberIds };
}
