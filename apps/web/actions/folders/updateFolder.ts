"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { folders } from "@cap/database/schema";
import type { Folder } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function updateFolder({
	folderId,
	name,
	color,
	parentId,
}: {
	folderId: Folder.FolderId;
	name?: string;
	color?: "normal" | "blue" | "red" | "yellow";
	parentId?: Folder.FolderId | null;
}) {
	const user = await getCurrentUser();
	if (!user || !user.activeOrganizationId)
		throw new Error("Unauthorized or no active organization");

	// If parentId is provided and not null, verify it exists and belongs to the same organization
	if (parentId) {
		// Check that we're not creating a circular reference
		if (parentId === folderId) {
			throw new Error("A folder cannot be its own parent");
		}

		const [parentFolder] = await db()
			.select()
			.from(folders)
			.where(
				and(
					eq(folders.id, parentId),
					eq(folders.organizationId, user.activeOrganizationId),
				),
			);

		if (!parentFolder) {
			throw new Error("Parent folder not found or not accessible");
		}

		// Check for circular references in the folder hierarchy
		let currentParentId = parentFolder.parentId;
		while (currentParentId) {
			if (currentParentId === folderId) {
				throw new Error("Cannot create circular folder references");
			}

			const [nextParent] = await db()
				.select()
				.from(folders)
				.where(eq(folders.id, currentParentId));

			if (!nextParent) break;
			currentParentId = nextParent.parentId;
		}
	}

	await db()
		.update(folders)
		.set({
			...(name !== undefined ? { name } : {}),
			...(color !== undefined ? { color } : {}),
			...(parentId !== undefined ? { parentId } : {}),
		})
		.where(eq(folders.id, folderId));
	revalidatePath(`/dashboard/caps`);
	revalidatePath(`/dashboard/folder/${folderId}`);
}
