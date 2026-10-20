type BillingRequest = {
	apiKey: string;
	baseUrl: string;
};

export type ProPlan = {
	upgraded: boolean;
	stripeSubscriptionStatus: string | null;
};

export class MobileBillingError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly payload: unknown,
	) {
		super(message);
		this.name = "MobileBillingError";
	}
}

const trimBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = async (response: Response) => {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
};

export const getProPlan = async ({
	apiKey,
	baseUrl,
}: BillingRequest): Promise<ProPlan> => {
	const response = await fetch(`${trimBaseUrl(baseUrl)}/api/desktop/plan`, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
	});
	const payload = await parseJson(response);

	if (!response.ok) {
		throw new MobileBillingError(
			`Mobile billing request failed with ${response.status}`,
			response.status,
			payload,
		);
	}
	if (
		!isRecord(payload) ||
		typeof payload.upgraded !== "boolean" ||
		(payload.stripeSubscriptionStatus !== null &&
			typeof payload.stripeSubscriptionStatus !== "string")
	) {
		throw new MobileBillingError("Invalid mobile plan response", 200, payload);
	}

	return {
		upgraded: payload.upgraded,
		stripeSubscriptionStatus: payload.stripeSubscriptionStatus,
	};
};
