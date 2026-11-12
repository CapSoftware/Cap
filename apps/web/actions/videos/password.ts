"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	hashPassword,
	verifyPassword as verifyPlainPassword,
} from "@cap/database/crypto";
import { spaces, spaceVideos, videos } from "@cap/database/schema";
import { collectPasswordHashes } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { isPasswordAttemptLimited } from "@/lib/password-attempt-limit";
import {
	passwordAttemptResourceKey,
	TOO_MANY_PASSWORD_ATTEMPTS,
} from "@/lib/password-attempts";
import { setVerifiedPasswordCookie } from "@/lib/password-cookie";
import { RATE_LIMIT_IDS } from "@/lib/rate-limit";

export async function setVideoPassword(
	videoId: Video.VideoId,
	password: string,
) {
	try {
		const user = await getCurrentUser();

		if (!user || !videoId || typeof password !== "string") {
			throw new Error("Missing required data");
		}

		const [video] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId));

		if (!video || video.ownerId !== user.id) {
			throw new Error("Unauthorized");
		}

		// A blank password would silently replace a working one with an empty
		// password; removing a password has its own action.
		if (!password.trim()) {
			return { success: false, error: "Enter a password" };
		}

		const hashed = await hashPassword(password);
		await db()
			.update(videos)
			.set({ password: hashed })
			.where(eq(videos.id, videoId));

		revalidatePath("/dashboard/caps");
		revalidatePath("/dashboard/shared-caps");
		revalidatePath(`/s/${videoId}`);

		return { success: true, value: "Password updated successfully" };
	} catch (error) {
		console.error("Error setting video password:", error);
		return { success: false, error: "Failed to update password" };
	}
}

export async function removeVideoPassword(videoId: Video.VideoId) {
	try {
		const user = await getCurrentUser();

		if (!user || !videoId) {
			throw new Error("Missing required data");
		}

		const [video] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId));

		if (!video || video.ownerId !== user.id) {
			throw new Error("Unauthorized");
		}

		await db()
			.update(videos)
			.set({ password: null })
			.where(eq(videos.id, videoId));

		revalidatePath("/dashboard/caps");
		revalidatePath("/dashboard/shared-caps");
		revalidatePath(`/s/${videoId}`);

		return { success: true, value: "Password removed successfully" };
	} catch (error) {
		console.error("Error removing video password:", error);
		return { success: false, error: "Failed to remove password" };
	}
}

export async function verifyVideoPassword(
	videoId: Video.VideoId,
	password: string,
) {
	try {
		if (!videoId || typeof password !== "string")
			return { success: false, error: "Failed to verify password" };

		const resourceKey = passwordAttemptResourceKey(videoId);
		if (!resourceKey) {
			return { success: false, error: "Failed to verify password" };
		}

		if (
			await isPasswordAttemptLimited(
				{
					perClient: RATE_LIMIT_IDS.VIDEO_PASSWORD,
					perViewer: RATE_LIMIT_IDS.VIDEO_PASSWORD_PER_VIEWER,
					perResource: RATE_LIMIT_IDS.VIDEO_PASSWORD_PER_VIDEO,
				},
				`video:${resourceKey}`,
			)
		) {
			return { success: false, error: TOO_MANY_PASSWORD_ATTEMPTS };
		}

		const [video] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId));

		if (!video) return { success: false, error: "Failed to verify password" };

		const spacePasswords = await db()
			.select({ password: spaces.password })
			.from(spaceVideos)
			.innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
			.where(eq(spaceVideos.videoId, videoId));

		const passwordHashes = collectPasswordHashes({
			videoPassword: video.password,
			spacePasswords,
		});

		for (const passwordHash of passwordHashes) {
			const valid = await verifyPlainPassword(passwordHash, password);
			if (valid) {
				await setVerifiedPasswordCookie(passwordHash);
				return { success: true, value: "Password verified" };
			}
		}

		// Wrong passwords and links whose password was since removed are expected
		// outcomes — return without logging so console.error stays signal.
		return { success: false, error: "Failed to verify password" };
	} catch (error) {
		console.error("Error verifying video password:", error);
		return { success: false, error: "Failed to verify password" };
	}
}
