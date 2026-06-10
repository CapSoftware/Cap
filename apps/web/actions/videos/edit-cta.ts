"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { VideoCta, VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

const MAX_LABEL_LENGTH = 40;

export async function editCta(videoId: Video.VideoId, cta: VideoCta | null) {
	const user = await getCurrentUser();

	if (!user || !videoId) {
		throw new Error("Missing required data for updating video CTA");
	}

	const userId = user.id;
	const query = await db().select().from(videos).where(eq(videos.id, videoId));

	const video = query[0];
	if (!video) {
		throw new Error("Video not found");
	}

	if (video.ownerId !== userId) {
		throw new Error("You don't have permission to update this video");
	}

	const currentMetadata = (video.metadata as VideoMetadata) || {};
	let nextCta: VideoCta | undefined;

	if (cta?.enabled) {
		const label = cta.label.trim().slice(0, MAX_LABEL_LENGTH);
		const url = cta.url.trim();

		if (!label) {
			throw new Error("CTA label is required");
		}

		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error("CTA URL is invalid");
		}

		if (parsed.protocol !== "https:") {
			throw new Error("CTA URL must start with https://");
		}

		nextCta = { enabled: true, label, url: parsed.toString() };
	}

	const updatedMetadata: VideoMetadata = { ...currentMetadata };
	if (nextCta) {
		updatedMetadata.cta = nextCta;
	} else {
		delete updatedMetadata.cta;
	}

	await db()
		.update(videos)
		.set({ metadata: updatedMetadata })
		.where(eq(videos.id, videoId));

	revalidatePath(`/s/${videoId}`);
	revalidatePath("/dashboard/caps");

	return { success: true };
}
