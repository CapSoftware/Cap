"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { encrypt } from "@cap/database/crypto";
import { nanoId, nanoIdLong } from "@cap/database/helpers";
import { developerApiKeys, developerApps } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { hashKey } from "@/lib/developer-key-hash";

export async function regenerateDeveloperKeys(appId: string) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [app] = await db()
		.select()
		.from(developerApps)
		.where(
			and(
				eq(developerApps.id, appId),
				eq(developerApps.ownerId, user.id),
				isNull(developerApps.deletedAt),
			),
		)
		.limit(1);

	if (!app) throw new Error("App not found");

	await db()
		.update(developerApiKeys)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(developerApiKeys.appId, appId),
				isNull(developerApiKeys.revokedAt),
			),
		);

	const publicKeyRaw = `cpk_${nanoIdLong()}`;
	const secretKeyRaw = `csk_${nanoIdLong()}`;
	const publicKeyHash = await hashKey(publicKeyRaw);
	const secretKeyHash = await hashKey(secretKeyRaw);

	await db()
		.insert(developerApiKeys)
		.values([
			{
				id: nanoId(),
				appId,
				keyType: "public",
				keyPrefix: publicKeyRaw.slice(0, 12),
				keyHash: publicKeyHash,
				encryptedKey: await encrypt(publicKeyRaw),
			},
			{
				id: nanoId(),
				appId,
				keyType: "secret",
				keyPrefix: secretKeyRaw.slice(0, 12),
				keyHash: secretKeyHash,
				encryptedKey: await encrypt(secretKeyRaw),
			},
		]);

	revalidatePath("/dashboard/developers");
	return {
		publicKey: publicKeyRaw,
		secretKey: secretKeyRaw,
	};
}
