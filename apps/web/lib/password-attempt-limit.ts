import { headers } from "next/headers";
import { isRateLimited, rateLimitClientAddress } from "@/lib/rate-limit";

type PasswordAttemptRules = {
	perClient: string;
	perViewer: string;
	perResource: string;
};

export async function isPasswordAttemptLimited(
	rules: PasswordAttemptRules,
	resourceKey: string,
): Promise<boolean> {
	if (await isRateLimited(rules.perClient)) return true;

	const viewer = await requestClientAddress();
	if (
		viewer &&
		!(await isRateLimited(rules.perViewer, { key: `${resourceKey}|${viewer}` }))
	) {
		return false;
	}

	return isRateLimited(rules.perResource, { key: resourceKey });
}

async function requestClientAddress(): Promise<string | undefined> {
	try {
		return rateLimitClientAddress(new Headers(await headers()));
	} catch {
		return undefined;
	}
}
