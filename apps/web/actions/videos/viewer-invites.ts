"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sendEmail } from "@cap/database/emails/config";
import { VideoViewerInvite } from "@cap/database/emails/video-viewer-invite";
import { nanoId } from "@cap/database/helpers";
import { videos, videoViewerGrants } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function getOwnedVideo(videoId: Video.VideoId) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [video] = await db()
		.select({ id: videos.id, name: videos.name, ownerId: videos.ownerId })
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);

	if (!video || video.ownerId !== user.id) throw new Error("Unauthorized");
	return { user, video };
}

function normalizeEmail(email: string) {
	const normalized = email.trim().toLowerCase();
	if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
		throw new Error("Enter a valid email address");
	}
	return normalized;
}

export async function getVideoViewerGrants(videoId: Video.VideoId) {
	await getOwnedVideo(videoId);
	return db()
		.select({ email: videoViewerGrants.email })
		.from(videoViewerGrants)
		.where(
			and(
				eq(videoViewerGrants.videoId, videoId),
				isNull(videoViewerGrants.revokedAt),
			),
		)
		.orderBy(videoViewerGrants.email);
}

export async function inviteVideoViewer(videoId: Video.VideoId, email: string) {
	const { user, video } = await getOwnedVideo(videoId);
	const normalizedEmail = normalizeEmail(email);

	const [existingGrant] = await db()
		.select({ revokedAt: videoViewerGrants.revokedAt })
		.from(videoViewerGrants)
		.where(
			and(
				eq(videoViewerGrants.videoId, videoId),
				eq(videoViewerGrants.email, normalizedEmail),
			),
		)
		.limit(1);

	if (existingGrant && !existingGrant.revokedAt) {
		return { success: true, alreadyAdded: true, emailSent: false };
	}

	await db()
		.insert(videoViewerGrants)
		.values({
			id: nanoId(),
			videoId,
			email: normalizedEmail,
			invitedByUserId: user.id,
		})
		.onDuplicateKeyUpdate({
			set: { revokedAt: null, invitedByUserId: user.id },
		});

	revalidatePath(`/s/${videoId}`);

	let emailSent = false;
	try {
		const result = await sendEmail({
			email: normalizedEmail,
			subject: `Invitation to watch ${video.name} on Cap`,
			react: VideoViewerInvite({
				email: normalizedEmail,
				videoName: video.name,
				url: `${serverEnv().WEB_URL}/s/${videoId}`,
			}),
		});
		emailSent = Boolean(result?.data && !result.error);
		if (result?.error) {
			console.error("Failed to email video viewer invitation:", result.error);
		}
	} catch (error) {
		console.error("Failed to email video viewer invitation:", error);
	}

	return { success: true, alreadyAdded: false, emailSent };
}

export async function revokeVideoViewer(videoId: Video.VideoId, email: string) {
	await getOwnedVideo(videoId);
	const normalizedEmail = normalizeEmail(email);
	await db()
		.update(videoViewerGrants)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(videoViewerGrants.videoId, videoId),
				eq(videoViewerGrants.email, normalizedEmail),
				isNull(videoViewerGrants.revokedAt),
			),
		);

	revalidatePath(`/s/${videoId}`);
	return { success: true };
}
