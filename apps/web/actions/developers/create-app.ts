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
import {
	DEVELOPER_APP_LIMIT_MESSAGE,
	DEVELOPER_APP_RATE_MESSAGE,
	developerAppCreationLimited,
	developerAppEnvironment,
	developerAppName,
	reserveDeveloperAppSlot,
} from "@/lib/developer-app-limits";
import { hashKey } from "@/lib/developer-key-hash";
import { canUseInfra } from "@/lib/infra-access";
import { actionFailure } from "@/lib/infra-action-result";

export async function createDeveloperApp(data: {
	name: string;
	environment: "development" | "production";
}) {
	const user = await getCurrentUser();
	if (!user || !canUseInfra(user.email)) throw new Error("Unauthorized");

	const named = developerAppName(data.name);
	if (!named.ok) return actionFailure(named.message);
	const chosen = developerAppEnvironment(data.environment);
	if (!chosen.ok) return actionFailure(chosen.message);
	if (await developerAppCreationLimited(user.id)) {
		return actionFailure(DEVELOPER_APP_RATE_MESSAGE);
	}

	const appId = nanoId();
	const publicKeyRaw = `cpk_${nanoIdLong()}`;
	const secretKeyRaw = `csk_${nanoIdLong()}`;
	const publicKeyHash = await hashKey(publicKeyRaw);
	const secretKeyHash = await hashKey(secretKeyRaw);

	const encryptedPublicKey = await encrypt(publicKeyRaw);
	const encryptedSecretKey = await encrypt(secretKeyRaw);

	const created = await db().transaction(async (tx) => {
		if (!(await reserveDeveloperAppSlot(tx, user.id))) return false;

		await tx.insert(developerApps).values({
			id: appId,
			ownerId: user.id,
			name: named.name,
			environment: chosen.environment,
		});

		await tx.insert(developerApiKeys).values([
			{
				id: nanoId(),
				appId,
				keyType: "public",
				keyPrefix: publicKeyRaw.slice(0, 12),
				keyHash: publicKeyHash,
				encryptedKey: encryptedPublicKey,
			},
			{
				id: nanoId(),
				appId,
				keyType: "secret",
				keyPrefix: secretKeyRaw.slice(0, 12),
				keyHash: secretKeyHash,
				encryptedKey: encryptedSecretKey,
			},
		]);

		await tx.insert(developerCreditAccounts).values({
			id: nanoId(),
			appId,
			ownerId: user.id,
		});
		return true;
	});

	if (!created) return actionFailure(DEVELOPER_APP_LIMIT_MESSAGE);

	return {
		appId,
		publicKey: publicKeyRaw,
		secretKey: secretKeyRaw,
	};
}
