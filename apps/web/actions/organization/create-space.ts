"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { spaceMembers, spaces } from "@cap/database/schema";
import {
	type ImageUpload,
	Space,
	SpaceMemberId,
	type SpaceMemberRole,
	User,
} from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
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

		if (!name) {
			return {
				success: false,
				error: "Space name is required",
			};
		}

		// Check for duplicate space name in the same organization
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

		// Generate the space ID early so we can use it in the file path
		const spaceId = Space.SpaceId.make(nanoId());
		let iconUrl: ImageUpload.ImageUrlOrKey | null = null;

		await db().transaction(async (tx) => {
			// Create the space first
			await tx.insert(spaces).values({
				id: spaceId,
				name,
				organizationId: user.activeOrganizationId,
				createdById: user.id,
				iconUrl: null,
			});

			// --- Member Management Logic ---
			// Collect member user IDs from formData
			const memberUserIds: string[] = [];
			for (const entry of formData.getAll("members[]")) {
				if (typeof entry === "string" && entry.length > 0) {
					memberUserIds.push(entry);
				}
			}

			// Always add the creator as Admin (if not already in the list)
			if (!memberUserIds.includes(user.id)) {
				memberUserIds.push(user.id);
			}

			// Create space members
			if (memberUserIds.length > 0) {
				const spaceMembersToInsert = memberUserIds.map((userId) => {
					// Creator is always Admin, others are member
					const role: SpaceMemberRole = userId === user.id ? "Admin" : "member";
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
