"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoIdLength } from "@cap/database/helpers";
import { spaceMembers } from "@cap/database/schema";
import { eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

const addSpaceMemberSchema = z.object({
	spaceId: z.string(),
	userId: z.string(),
	role: z.string(),
});

const addSpaceMembersSchema = z.object({
	spaceId: z.string(),
	userIds: z.array(z.string()),
	role: z.string(),
});

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

	// Fetch existing members to avoid duplicates
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
		.select({ spaceId: spaceMembers.spaceId })
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

	await db().delete(spaceMembers).where(eq(spaceMembers.id, memberId));

	revalidatePath(`/dashboard/spaces/${spaceId}`);

	return { success: true };
}

// Replace all members for a space
const setSpaceMembersSchema = z.object({
	spaceId: z.string(),
	userIds: z.array(z.string()),
	role: z.string().default("member"),
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
	const { spaceId, userIds, role } = validation.data;

	// Remove all current members
	await db().delete(spaceMembers).where(eq(spaceMembers.spaceId, spaceId));

	// Insert new members if any
	if (userIds.length > 0) {
		const now = new Date();
		const values = userIds.map((userId) => ({
			id: uuidv4().substring(0, nanoIdLength),
			spaceId,
			userId,
			role,
			createdAt: now,
			updatedAt: now,
		}));
		await db().insert(spaceMembers).values(values);
	}

	revalidatePath(`/dashboard/spaces/${spaceId}`);
	return { success: true, count: userIds.length };
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

	// Get spaceId for revalidation (assume all memberIds are from the same space)
	const members = await db()
		.select({ spaceId: spaceMembers.spaceId })
		.from(spaceMembers)
		.where(inArray(spaceMembers.id, memberIds));
	const spaceId = members[0]?.spaceId;

	await db().delete(spaceMembers).where(inArray(spaceMembers.id, memberIds));
	if (spaceId) {
		revalidatePath(`/dashboard/spaces/${spaceId}`);
	}
	return { success: true, removed: memberIds };
}
