"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { encrypt } from "@cap/database/crypto";
import { nanoId, nanoIdLong } from "@cap/database/helpers";
import {
	developerApiKeys,
	developerApps,
	developerCreditAccounts,
} from "@cap/database/schema";
import { hashKey } from "@/lib/developer-key-hash";

export async function createDeveloperApp(data: {
	name: string;
	environment: "development" | "production";
}) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	if (!data.name.trim()) throw new Error("App name is required");

	const appId = nanoId();
	const publicKeyRaw = `cpk_${nanoIdLong()}`;
	const secretKeyRaw = `csk_${nanoIdLong()}`;
	const publicKeyHash = await hashKey(publicKeyRaw);
	const secretKeyHash = await hashKey(secretKeyRaw);

	await db().insert(developerApps).values({
		id: appId,
		ownerId: user.id,
		name: data.name.trim(),
		environment: data.environment,
	});

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

	await db().insert(developerCreditAccounts).values({
		id: nanoId(),
		appId,
		ownerId: user.id,
	});

	return {
		appId,
		publicKey: publicKeyRaw,
		secretKey: secretKeyRaw,
	};
}
