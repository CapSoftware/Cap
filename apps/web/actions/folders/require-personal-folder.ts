import { db } from "@cap/database";
import { folders } from "@cap/database/schema";
import type { Folder, Organisation, User } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";

export async function requirePersonalFolder(
	userId: User.UserId,
	organizationId: Organisation.OrganisationId,
	folderId: Folder.FolderId,
) {
	const [folder] = await db()
		.select({ id: folders.id })
		.from(folders)
		.where(
			and(
				eq(folders.id, folderId),
				eq(folders.organizationId, organizationId),
				eq(folders.createdById, userId),
				isNull(folders.spaceId),
			),
		);
	if (!folder) throw new Error("Folder not found");
}
