import { buildEnv } from "@cap/env";

const INFRA_PREVIEW_EMAILS = new Set(["richie@cap.so"]);

export function canUseInfra(email: string | null | undefined) {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") return true;
	if (!email) return false;
	return INFRA_PREVIEW_EMAILS.has(email.toLowerCase());
}
