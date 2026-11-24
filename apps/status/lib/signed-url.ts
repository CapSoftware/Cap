import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import type { ServiceDefinition } from "./types";

// Long enough to cover both probe attempts and any clock difference with the
// CDN, short enough that a leaked probe URL is useless soon after.
export const SIGNED_PROBE_URL_SECONDS = 15 * 60;

export function probeUrl(
	service: ServiceDefinition,
	url: string,
	now: number = Date.now(),
	env: Record<string, string | undefined> = process.env,
): string {
	if (!service.signedUrl) return url;
	const keyPairId = env.STATUS_STORAGE_KEY_PAIR_ID?.trim();
	const privateKey = env.STATUS_STORAGE_PRIVATE_KEY?.trim();
	if (!keyPairId || !privateKey) return url;
	return getSignedUrl({
		url,
		keyPairId,
		privateKey,
		dateLessThan: new Date(now + SIGNED_PROBE_URL_SECONDS * 1000),
	});
}
