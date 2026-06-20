"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { hashPassword } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import { spaceMembers, spaces } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { S3Buckets } from "@cap/web-backend";
import {
	Space,
	SpaceMemberId,
	type SpaceMemberRole,
	type User,
} from "@cap/web-domain";
import { eq, type SQL, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { isOrganizationOwnerPro } from "@/lib/org-pro";
import { normalizeSpaceRole } from "@/lib/permissions/roles";
import { runPromise } from "@/lib/server";
import { getSpaceAccess } from "./space-authorization";
import {
	getSpaceSettingsFromFormData,
	preserveProSpaceSettings,
} from "./space-settings";
import { uploadSpaceIcon } from "./upload-space-icon";

export async function updateSpace(formData: FormData) {
	const user = await getCurrentUser();
	if (!user) return { success: false, error: "Unauthorized" };

	const id = Space.SpaceId.make(formData.get("id") as string);
	const name = formData.get("name") as string;
	const members = formData.getAll("members[]") as User.UserId[];
	const iconFile = formData.get("icon") as File | null;
	const passwordAction = formData.get("passwordAction") as
		| "keep"
		| "set"
		| "remove"
		| null;
	const password = formData.get("password") as string | null;
	// Only touch the public flag when the form actually submitted it — callers
	// that omit the field must not silently un-publish the space.
	const publicField = formData.get("public");
	const publicEnabled = publicField === "true";

	const [space] = await db()
		.select({
			createdById: spaces.createdById,
			organizationId: spaces.organizationId,
			settings: spaces.settings,
			public: spaces.public,
		})
		.from(spaces)
		.where(eq(spaces.id, id))
		.limit(1);

	if (!space) {
		return { success: false, error: "Space not found" };
	}

	// getSpaceAccess returns null for expected denials; genuine failures must
	// propagate instead of being misreported as "Unauthorized".
	const access = await getSpaceAccess(user.id, id);
	if (!access?.canManage) {
		return { success: false, error: "Unauthorized" };
	}

	// Publishing is gated on the org owner's plan, but a downgraded org can
	// always un-publish — so only the false→true transition requires Pro.
	if (
		publicEnabled &&
		!space.public &&
		!(await isOrganizationOwnerPro(space.organizationId))
	) {
		return {
			success: false,
			error: "Upgrade to Cap Pro to create a public collection link",
		};
	}

	const submittedSettings = getSpaceSettingsFromFormData(formData);
	const canUseProFeatures = userIsPro(user);
	const viewerSettings = canUseProFeatures
		? submittedSettings
		: preserveProSpaceSettings(submittedSettings, space.settings);
	// Atomic per-key merge: the form submits every viewer-settings key
	// explicitly, while settings.publicPage (managed by the visibility/logo
	// actions, possibly concurrently) is left untouched instead of being
	// rewritten from a stale snapshot.
	const spaceUpdate: {
		name: string;
		settings: SQL;
		public?: boolean;
		password?: string | null;
	} = {
		name,
		settings: sql`JSON_MERGE_PATCH(COALESCE(${spaces.settings}, '{}'), CAST(${JSON.stringify(
			viewerSettings,
		)} AS JSON))`,
	};
	if (publicField !== null) spaceUpdate.public = publicEnabled;

	if (passwordAction === "set") {
		if (!canUseProFeatures) {
			return {
				success: false,
				error: "Upgrade required to protect a space with a password",
			};
		}
		if (!password?.trim()) {
			return { success: false, error: "Space password is required" };
		}
		spaceUpdate.password = await hashPassword(password.trim());
	} else if (passwordAction === "remove") {
		spaceUpdate.password = null;
	}

	await db().update(spaces).set(spaceUpdate).where(eq(spaces.id, id));

	const memberIds = Array.from(new Set([...members, space.createdById]));
	const existingMembers = await db()
		.select({ userId: spaceMembers.userId, role: spaceMembers.role })
		.from(spaceMembers)
		.where(eq(spaceMembers.spaceId, id));
	const existingRoleByUserId = new Map(
		existingMembers.map((member) => [
			member.userId,
			normalizeSpaceRole(member.role) ?? "member",
		]),
	);

	await db().delete(spaceMembers).where(eq(spaceMembers.spaceId, id));
	await db()
		.insert(spaceMembers)
		.values(
			memberIds.map((userId) => {
				const role: SpaceMemberRole =
					userId === space.createdById
						? "admin"
						: (existingRoleByUserId.get(userId) ?? "member");
				return {
					id: SpaceMemberId.make(nanoId()),
					spaceId: id,
					userId,
					role,
				};
			}),
		);

	if (formData.get("removeIcon") === "true") {
		const spaceArr = await db().select().from(spaces).where(eq(spaces.id, id));
		const spaceData = spaceArr[0];
		if (spaceData?.iconUrl) {
			const key = spaceData.iconUrl.startsWith("organizations/")
				? spaceData.iconUrl
				: spaceData.iconUrl.match(/organizations\/.+/)?.[0];

			if (key) {
				try {
					await Effect.gen(function* () {
						const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
						yield* bucket.deleteObject(key);
					}).pipe(runPromise);
				} catch (e) {
					console.warn("Failed to delete old space icon from S3", e);
				}
			}
		}
		await db().update(spaces).set({ iconUrl: null }).where(eq(spaces.id, id));
	} else if (iconFile && iconFile.size > 0) {
		await uploadSpaceIcon(formData, id);
	}

	revalidatePath("/dashboard");
	revalidatePath("/dashboard/caps");
	revalidatePath(`/dashboard/spaces/${id}`);
	revalidatePath(`/c/${id}`);
	return { success: true };
}
