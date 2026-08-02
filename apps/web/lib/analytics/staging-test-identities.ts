import { createHash } from "node:crypto";

export const syntheticStagingIdentities = (runId: string) => {
	const hash = createHash("sha256").update(runId).digest("hex");
	return {
		anonymousId: `synthetic_${hash.slice(0, 24)}`,
		hash,
		organizationId: `synthetic_org_${hash.slice(24, 48)}`,
		userId: `synthetic_user_${hash.slice(0, 24)}`,
	};
};

export const syntheticStagingEventIds = (runId: string) => {
	const { hash } = syntheticStagingIdentities(runId);
	return [
		`staging_signup_${hash.slice(0, 24)}`,
		`staging_retry_429_${hash.slice(0, 24)}`,
		`staging_retry_503_${hash.slice(0, 24)}`,
		`stripe:staging_ambiguous_${hash.slice(0, 24)}:purchase_completed`,
		`staging_reject_400_${hash.slice(0, 24)}`,
		`staging_erasure_replay_${hash.slice(0, 24)}`,
	];
};
