"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { folders, videos } from "@cap/database/schema";
import type { Folder } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { signFolderShareSlug } from "@/lib/folder-share";

const requireOwnedFolder = async (folderId: Folder.FolderId) => {
	const user = await getCurrentUser();
	if (!user || !user.activeOrganizationId)
		throw new Error("Unauthorized or no active organization");

	const [folder] = await db()
		.select()
		.from(folders)
		.where(
			and(
				eq(folders.id, folderId),
				eq(folders.organizationId, user.activeOrganizationId),
			),
		);

	if (!folder) throw new Error("Folder not found");
	return folder;
};

export async function getFolderShareState(folderId: Folder.FolderId) {
	const folder = await requireOwnedFolder(folderId);
	return {
		isShared: folder.publicShared === true,
		slug: folder.publicShared ? signFolderShareSlug(folderId) : null,
	};
}

export async function enableFolderSharing(folderId: Folder.FolderId) {
	await requireOwnedFolder(folderId);
	await db()
		.update(folders)
		.set({ publicShared: true })
		.where(eq(folders.id, folderId));
	await db()
		.update(videos)
		.set({ public: true })
		.where(eq(videos.folderId, folderId));
	revalidatePath(`/dashboard/folder/${folderId}`);
	revalidatePath(`/dashboard/caps`);
	return { slug: signFolderShareSlug(folderId) };
}

export async function disableFolderSharing(folderId: Folder.FolderId) {
	await requireOwnedFolder(folderId);
	await db()
		.update(folders)
		.set({ publicShared: false })
		.where(eq(folders.id, folderId));
	await db()
		.update(videos)
		.set({ public: false })
		.where(eq(videos.folderId, folderId));
	revalidatePath(`/dashboard/folder/${folderId}`);
	revalidatePath(`/dashboard/caps`);
}
