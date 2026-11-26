"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerApps, developerVideos } from "@cap/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { canUseInfra } from "@/lib/infra-access";
import { actionFailure } from "@/lib/infra-action-result";

const MAX_NAME_LENGTH = 255;

export async function renameDeveloperVideo(
	appId: string,
	videoId: string,
	name: string,
) {
	const user = await getCurrentUser();
	if (!user || !canUseInfra(user.email)) throw new Error("Unauthorized");

	const trimmed = name.trim();
	if (!trimmed) return actionFailure("Give the video a name.");
	if (trimmed.length > MAX_NAME_LENGTH) {
		return actionFailure(
			`Keep the name to ${MAX_NAME_LENGTH} characters or fewer.`,
		);
	}

	const [video] = await db()
		.select({ id: developerVideos.id })
		.from(developerVideos)
		.innerJoin(developerApps, eq(developerVideos.appId, developerApps.id))
		.where(
			and(
				eq(developerVideos.id, videoId),
				eq(developerApps.id, appId),
				eq(developerApps.ownerId, user.id),
				isNull(developerApps.deletedAt),
				isNull(developerVideos.deletedAt),
			),
		)
		.limit(1);

	if (!video) throw new Error("Video not found");

	// Processing recovery reads updatedAt to judge how long a video has sat
	// untouched, so a rename must not make it look freshly worked on.
	await db()
		.update(developerVideos)
		.set({ name: trimmed, updatedAt: sql`${developerVideos.updatedAt}` })
		.where(eq(developerVideos.id, video.id));

	revalidatePath("/dashboard/infra", "layout");
	return { success: true as const, name: trimmed };
}
