import "server-only";
import { serverEnv } from "@cap/env";
import {
	PREFLIGHT_LIFETIME_MS,
	PREFLIGHT_POLICY,
	preflightHash,
	preflightRequestSchema,
	requirePreflightRequest,
	sealPreflight,
} from "@cap/utils/recording-ownership-preflight";
import {
	inspectOwnershipHeads,
	type OwnershipMediaStore,
	type OwnershipSnapshot,
	OwnershipTransferError,
	ownershipPreflightBinding,
} from "@/lib/recording-ownership-transfer";

export function ownershipPreflightSecret() {
	const secret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
	if (!secret || secret.length < 32)
		throw new OwnershipTransferError("NOT_READY");
	return secret;
}

export async function prepareOwnershipPreflight(
	snapshot: OwnershipSnapshot,
	target: string,
	destination: string | null,
	store: OwnershipMediaStore,
) {
	if (!store.signRead) throw new OwnershipTransferError("UNSUPPORTED");
	const prefix = `${snapshot.video.ownerId}/${snapshot.video.id}/`;
	const manifest = await inspectOwnershipHeads(store, prefix);
	const binding = ownershipPreflightBinding(
		snapshot,
		target,
		destination,
		manifest,
	);
	const reads = [];
	for (const object of manifest)
		reads.push({
			ref: preflightHash(object.key),
			pinnedUrl: await store.signRead(object.key, object.versionId),
			currentUrl: await store.signRead(object.key, null),
		});
	if (
		preflightHash(await inspectOwnershipHeads(store, prefix)) !==
		preflightHash(manifest)
	)
		throw new OwnershipTransferError("MEDIA_CHANGED");
	const now = Date.now();
	const request = preflightRequestSchema.parse({
		...binding,
		reads,
		policy: PREFLIGHT_POLICY,
		issuedAt: now,
		expiresAt: now + PREFLIGHT_LIFETIME_MS,
	});
	requirePreflightRequest(request);
	return {
		request: sealPreflight("request", request, ownershipPreflightSecret()),
		expiresAt: request.expiresAt,
	};
}
