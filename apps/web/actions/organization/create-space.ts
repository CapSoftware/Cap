"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { hashPassword } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import { spaceMembers, spaces } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import {
	type ImageUpload,
	Organisation,
	Space,
	SpaceMemberId,
	type SpaceMemberRole,
	User,
} from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { isOrganizationOwnerPro } from "@/lib/org-pro";
import {
	getSpaceSettingsFromFormData,
	hasProSpaceSettingsEnabled,
} from "./space-settings";
import { uploadSpaceIcon } from "./upload-space-icon";

interface CreateSpaceResponse {
	success: boolean;
	spaceId?: string;
	name?: string;
	iconUrl?: string | null;
	error?: string;
}

export async function createSpace(
	formData: FormData,
): Promise<CreateSpaceResponse> {
	try {
		const user = await getCurrentUser();

		if (!user || !user.activeOrganizationId) {
			return {
				success: false,
				error: "User not logged in or no active organization",
			};
		}

		const name = formData.get("name") as string;
		const passwordEnabled = formData.get("passwordEnabled") === "true";
		const password = formData.get("password") as string | null;
		const publicEnabled = formData.get("public") === "true";
		const settings = getSpaceSettingsFromFormData(formData);
		const canUseProFeatures = userIsPro(user);

		if (!name) {
			return {
				success: false,
				error: "Space name is required",
			};
		}

		if (passwordEnabled && !password?.trim()) {
			return {
				success: false,
				error: "Space password is required",
			};
		}

		if (!canUseProFeatures && passwordEnabled) {
			return {
				success: false,
				error: "Upgrade required to protect a space with a password",
			};
		}

		if (!canUseProFeatures && hasProSpaceSettingsEnabled(settings)) {
			return {
				success: false,
				error: "Upgrade required to change these viewer rules",
			};
		}

		if (
			publicEnabled &&
			!(await isOrganizationOwnerPro(
				Organisation.OrganisationId.make(user.activeOrganizationId),
			))
		) {
			return {
				success: false,
				error: "Upgrade to Cap Pro to create a public collection link",
			};
		}

		const existingSpace = await db()
			.select({ id: spaces.id })
			.from(spaces)
			.where(
				and(
					eq(spaces.organizationId, user.activeOrganizationId),
					eq(spaces.name, name),
				),
			)
			.limit(1);

		if (existingSpace.length > 0) {
			return {
				success: false,
				error: "A space with this name already exists.",
			};
		}

		const spaceId = Space.SpaceId.make(nanoId());
		let iconUrl: ImageUpload.ImageUrlOrKey | null = null;
		const hashedPassword =
			passwordEnabled && password?.trim()
				? await hashPassword(password.trim())
				: null;

		await db().transaction(async (tx) => {
			await tx.insert(spaces).values({
				id: spaceId,
				name,
				organizationId: user.activeOrganizationId,
				createdById: user.id,
				iconUrl: null,
				settings,
				password: hashedPassword,
				public: publicEnabled,
			});

			const memberUserIds: string[] = [];
			for (const entry of formData.getAll("members[]")) {
				if (typeof entry === "string" && entry.length > 0) {
					memberUserIds.push(entry);
				}
			}

			if (!memberUserIds.includes(user.id)) {
				memberUserIds.push(user.id);
			}

			if (memberUserIds.length > 0) {
				const spaceMembersToInsert = memberUserIds.map((userId) => {
					const role: SpaceMemberRole = userId === user.id ? "admin" : "member";
					return {
						id: SpaceMemberId.make(nanoId()),
						spaceId,
						userId: User.UserId.make(userId),
						role,
					};
				});

				await tx.insert(spaceMembers).values(spaceMembersToInsert);
			}
		});

		const iconFile = formData.get("icon") as File | null;

		if (iconFile) {
			try {
				const iconFormData = new FormData();
				iconFormData.append("icon", iconFile);
				const result = await uploadSpaceIcon(iconFormData, spaceId);
				iconUrl = result.iconUrl;
			} catch (error) {
				console.error("Error uploading space icon:", error);
			}
		}

		revalidatePath("/dashboard");

		return {
			success: true,
			spaceId,
			iconUrl,
			name,
		};
	} catch (error) {
		console.error("Error creating space:", error);
		return {
			success: false,
			error: "Failed to create space",
		};
	}
}
