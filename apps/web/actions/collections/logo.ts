"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { folders, spaces } from "@cap/database/schema";
import { ImageUploads } from "@cap/web-backend";
import {
	type Folder,
	type ImageUpload,
	Space,
	type User,
} from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { isOrganizationOwnerPro } from "@/lib/org-pro";
import { canManageSpace } from "@/lib/permissions/roles";
import { sanitizeFile } from "@/lib/sanitizeFile";
import { runPromise } from "@/lib/server";
import { getOrganizationAccess } from "../organization/authorization";
import { getSpaceAccess } from "../organization/space-authorization";

const MAX_LOGO_BYTES = 1024 * 1024;
const ALLOWED_LOGO_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/svg+xml",
	"image/webp",
]);

function logoKey(value: string | undefined) {
	return value ? (value as ImageUpload.ImageUrlOrKey) : null;
}

async function readFilePayload(
	formData: FormData,
): Promise<ImageUpload.ImageUpdatePayload | { error: string }> {
	if (formData.get("remove") === "true") return Option.none();

	const file = formData.get("logo");
	if (!(file instanceof File) || file.size === 0) {
		return { error: "No file provided" };
	}
	if (!ALLOWED_LOGO_TYPES.has(file.type.toLowerCase())) {
		return { error: "Please upload a PNG, JPEG, SVG or WebP image" };
	}
	if (file.size > MAX_LOGO_BYTES) {
		return { error: "Logo must be 1MB or less" };
	}

	// Strips scripts/event handlers from SVGs (same treatment as space icons);
	// other formats pass through untouched.
	const sanitized = await sanitizeFile(file);
	const data = new Uint8Array(await sanitized.arrayBuffer());
	return Option.some({
		contentType: file.type,
		fileName: file.name,
		data,
	});
}

/**
 * Uploads (or removes) the custom logo shown on a collection's public page.
 * Publishing/customizing collections is a Pro entitlement, so this mirrors the
 * Pro gate enforced on the rest of the public-page settings.
 */
export async function setCollectionLogo(formData: FormData) {
	const user = await getCurrentUser();
	if (!user) return { success: false, error: "Unauthorized" };

	const collectionId = String(formData.get("collectionId") ?? "");
	const kind = String(formData.get("kind") ?? "");
	if (!collectionId || (kind !== "folder" && kind !== "space")) {
		return { success: false, error: "Invalid request" };
	}

	const payloadResult = await readFilePayload(formData);
	if ("error" in payloadResult) {
		return { success: false, error: payloadResult.error };
	}

	if (kind === "space") {
		return setSpaceLogo(collectionId, user.id, payloadResult);
	}
	return setFolderLogo(collectionId, user.id, payloadResult);
}

async function setSpaceLogo(
	collectionId: string,
	userId: User.UserId,
	payload: ImageUpload.ImageUpdatePayload,
) {
	const id = Space.SpaceId.make(collectionId);
	const [space] = await db()
		.select({
			organizationId: spaces.organizationId,
			settings: spaces.settings,
		})
		.from(spaces)
		.where(eq(spaces.id, id))
		.limit(1);

	if (!space) return { success: false, error: "Space not found" };

	// getSpaceAccess returns null for expected denials; genuine failures must
	// propagate instead of being misreported as "Unauthorized".
	const access = await getSpaceAccess(userId, id);
	if (!access?.canManage) return { success: false, error: "Unauthorized" };

	if (!(await isOrganizationOwnerPro(space.organizationId))) {
		return {
			success: false,
			error: "Upgrade to Cap Pro to customize the collection logo",
		};
	}

	const existing = space.settings ?? {};

	await Effect.gen(function* () {
		const imageUploads = yield* ImageUploads;
		yield* imageUploads.applyUpdate({
			payload,
			existing: Option.fromNullable(logoKey(existing.publicPage?.logoUrl)),
			keyPrefix: `organizations/${space.organizationId}/collections/${id}/logo`,
			update: (database, key) =>
				database
					.update(spaces)
					.set({
						// Atomic merge (a JSON null deletes the key per RFC 7396) so
						// concurrent settings patches can't overwrite the logo write.
						settings: sql`JSON_MERGE_PATCH(COALESCE(${spaces.settings}, '{}'), CAST(${JSON.stringify(
							{
								publicPage: {
									logoUrl: key ?? null,
									logoMode: key ? "custom" : "cap",
								},
							},
						)} AS JSON))`,
					})
					.where(eq(spaces.id, id)),
		});
	}).pipe(runPromise);

	revalidateCollection(collectionId);
	return { success: true };
}

async function setFolderLogo(
	collectionId: string,
	userId: User.UserId,
	payload: ImageUpload.ImageUpdatePayload,
) {
	const id = collectionId as Folder.FolderId;
	const [folder] = await db()
		.select({
			organizationId: folders.organizationId,
			spaceId: folders.spaceId,
			createdById: folders.createdById,
			settings: folders.settings,
		})
		.from(folders)
		.where(eq(folders.id, id))
		.limit(1);

	if (!folder) return { success: false, error: "Folder not found" };

	// Mirrors FoldersPolicy.canEdit: folders in a real space require space/org
	// management; folders in the org-wide area (spaceId === organizationId)
	// require org management; personal folders are creator-only.
	const canManage = !folder.spaceId
		? folder.createdById === userId
		: folder.spaceId === folder.organizationId
			? canManageSpace({
					organizationRole: (
						await getOrganizationAccess(userId, folder.organizationId)
					)?.role,
					spaceRole: null,
				})
			: ((await getSpaceAccess(userId, folder.spaceId))?.canManage ?? false);
	if (!canManage) return { success: false, error: "Unauthorized" };

	if (!(await isOrganizationOwnerPro(folder.organizationId))) {
		return {
			success: false,
			error: "Upgrade to Cap Pro to customize the collection logo",
		};
	}

	const existing = folder.settings ?? {};

	await Effect.gen(function* () {
		const imageUploads = yield* ImageUploads;
		yield* imageUploads.applyUpdate({
			payload,
			existing: Option.fromNullable(logoKey(existing.publicPage?.logoUrl)),
			keyPrefix: `organizations/${folder.organizationId}/collections/${id}/logo`,
			update: (database, key) =>
				database
					.update(folders)
					.set({
						// Atomic merge (a JSON null deletes the key per RFC 7396) so
						// concurrent settings patches can't overwrite the logo write.
						settings: sql`JSON_MERGE_PATCH(COALESCE(${folders.settings}, '{}'), CAST(${JSON.stringify(
							{
								publicPage: {
									logoUrl: key ?? null,
									logoMode: key ? "custom" : "cap",
								},
							},
						)} AS JSON))`,
					})
					.where(eq(folders.id, id)),
		});
	}).pipe(runPromise);

	revalidateCollection(collectionId);
	return { success: true };
}

function revalidateCollection(collectionId: string) {
	revalidatePath("/dashboard");
	revalidatePath(`/dashboard/spaces/${collectionId}`);
	revalidatePath(`/dashboard/folder/${collectionId}`);
	revalidatePath(`/c/${collectionId}`);
}
