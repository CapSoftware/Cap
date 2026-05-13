"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	encrypt,
	hashPassword,
	verifyPassword as verifyPlainPassword,
} from "@cap/database/crypto";
import { spaces, spaceVideos, videos } from "@cap/database/schema";
import { collectPasswordHashes } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

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
			throw new Error("Missing data");

		const [video] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId));

		if (!video) throw new Error("No password set");

		const spacePasswords = await db()
			.select({ password: spaces.password })
			.from(spaceVideos)
			.innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
			.where(eq(spaceVideos.videoId, videoId));

		const passwordHashes = collectPasswordHashes({
			videoPassword: video.password,
			spacePasswords,
		});

		if (passwordHashes.length === 0) throw new Error("No password set");

		for (const passwordHash of passwordHashes) {
			const valid = await verifyPlainPassword(passwordHash, password);
			if (valid) {
				(await cookies()).set("x-cap-password", await encrypt(passwordHash));
				return { success: true, value: "Password verified" };
			}
		}

		throw new Error("Invalid password");
	} catch (error) {
		console.error("Error verifying video password:", error);
		return { success: false, error: "Failed to verify password" };
	}
}
