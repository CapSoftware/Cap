"use server";

import { db } from "@cap/database";
import { organizations, users } from "@cap/database/schema";
import { S3Buckets } from "@cap/web-backend";
import { OrganisationId, UserId } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import * as path from "path";
import { runPromise } from "@/lib/server";

export async function removeImage(
	imageUrlOrKey: string,
	type: "user" | "organization",
	entityId: string,
) {
	try {
		await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());

			// Extract the S3 key - handle both old URL format and new key format
			let s3Key = imageUrlOrKey;
			if (
				imageUrlOrKey.startsWith("http://") ||
				imageUrlOrKey.startsWith("https://")
			) {
				const url = new URL(imageUrlOrKey);
				const raw = url.pathname.startsWith("/")
					? url.pathname.slice(1)
					: url.pathname;
				const decoded = decodeURIComponent(raw);
				const normalized = path.posix.normalize(decoded);
				if (normalized.includes("..")) {
					throw new Error("Invalid S3 key path");
				}
				s3Key = normalized;
			}

			// Only delete if it looks like the correct type of image key
			const expectedPrefix = type === "user" ? "users/" : "organizations/";
			if (s3Key.startsWith(expectedPrefix)) {
				yield* bucket.deleteObject(s3Key);
			}
		}).pipe(runPromise);

		// Update database
		if (type === "user") {
			await db()
				.update(users)
				.set({ image: null })
				.where(eq(users.id, UserId.make(entityId)));
		} else {
			await db()
				.update(organizations)
				.set({ iconUrl: null })
				.where(eq(organizations.id, OrganisationId.make(entityId)));
		}

		revalidatePath("/dashboard/settings/account");
		if (type === "organization") {
			revalidatePath("/dashboard/settings/organization");
		}

		return { success: true } as const;
	} catch (error) {
		console.error(`Error removing ${type} image:`, error);
		throw new Error(error instanceof Error ? error.message : "Remove failed");
	}
}
