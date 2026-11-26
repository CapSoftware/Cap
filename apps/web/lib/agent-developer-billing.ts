import { getInfraBilling, infraBillingJson } from "@/lib/infra-standing";

export const BILLING_ACCESS_HINT =
	"Billing details need the billing:read permission, which this token was not granted.";

export async function developerAppBillingSection<Credits>({
	scopes,
	appId,
	credits,
}: {
	scopes: { has(scope: "billing:read"): boolean };
	appId: string;
	credits: Credits | null;
}) {
	if (!scopes.has("billing:read")) {
		return { credits: null, billing: null, billingHint: BILLING_ACCESS_HINT };
	}
	return {
		credits,
		billing: infraBillingJson(await getInfraBilling(appId)),
		billingHint: null,
	};
}
