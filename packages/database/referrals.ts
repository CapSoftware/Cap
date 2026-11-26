import { serverEnv } from "@cap/env";

// Cookies written by the Dub analytics script (and by proxy.ts for
// ?dub_id= landings) when a visitor arrives through a partner link.
export const DUB_CLICK_ID_COOKIE = "dub_id";
export const DUB_PARTNER_DATA_COOKIE = "dub_partner_data";

// Dub dedupes leads on (customerExternalId, eventName), so every lead Cap
// sends uses this one name and a user can only ever become one referral.
export const REFERRAL_LEAD_EVENT = "Sign Up";

const DUB_API_URL = "https://api.dub.co";
const LEAD_TIMEOUT_MS = 5_000;
const DISCOUNT_TIMEOUT_MS = 2_000;
const CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COUPON_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Same Domain attribute the Dub script uses, so the server reads, overwrites
// and clears the one cookie instead of creating a host-only twin.
export function dubCookieDomain(hostname: string) {
	const host = hostname.split(":")[0]?.toLowerCase() ?? "";
	if (!host || host === "localhost") return undefined;
	return `.${host.replace(/^www\./, "")}`;
}

export function parseDubClickId(value: string | null | undefined) {
	if (!value) return null;
	const clickId = value.trim();
	return CLICK_ID_PATTERN.test(clickId) ? clickId : null;
}

const dubApiKey = () => serverEnv().DUB_API_KEY?.trim() || null;

type ReferralUser = {
	id: string;
	email: string | null | undefined;
	name?: string | null;
	image?: string | null;
};

/**
 * Records the user as a referred customer in Dub. Without this lead Dub
 * cannot attribute the user's later Stripe payments to the partner link, so
 * it runs in "wait" mode: by the time it resolves, a checkout started next
 * will be credited.
 */
export async function trackReferralLead(input: {
	clickId: string;
	user: ReferralUser;
}): Promise<boolean> {
	const apiKey = dubApiKey();
	if (!apiKey) return false;

	try {
		const response = await fetch(`${DUB_API_URL}/track/lead`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				clickId: input.clickId,
				eventName: REFERRAL_LEAD_EVENT,
				customerExternalId: input.user.id,
				customerName: input.user.name?.trim() || null,
				customerEmail: input.user.email || null,
				// users.image can be a storage key rather than a URL.
				customerAvatar: input.user.image?.startsWith("https://")
					? input.user.image
					: null,
				mode: "wait",
			}),
			signal: AbortSignal.timeout(LEAD_TIMEOUT_MS),
		});

		if (!response.ok) {
			console.error("[referrals] Dub lead was not recorded", {
				status: response.status,
				userId: input.user.id,
				body: (await response.text().catch(() => "")).slice(0, 500),
			});
			return false;
		}
		return true;
	} catch (error) {
		console.error("[referrals] Dub lead request failed", {
			userId: input.user.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

export type ReferralDiscount = { couponId: string; discountId: string };

export type ReferralCustomer =
	| { status: "found"; discount: ReferralDiscount | null }
	| { status: "missing" }
	| { status: "unavailable" };

/**
 * Looks the user up as a Dub customer (a recorded referral) and returns the
 * partner discount (dual-sided incentive) they are entitled to. Read from Dub
 * by user ID, never from a client cookie, so it cannot be forged. Never
 * throws: checkout must not depend on Dub being up.
 */
export async function findReferralCustomer(
	userId: string,
): Promise<ReferralCustomer> {
	const apiKey = dubApiKey();
	if (!apiKey) return { status: "unavailable" };

	try {
		const url = new URL(`${DUB_API_URL}/customers`);
		url.searchParams.set("externalId", userId);
		url.searchParams.set("includeExpandedFields", "true");
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(DISCOUNT_TIMEOUT_MS),
		});
		if (!response.ok) return { status: "unavailable" };

		const customers: unknown = await response.json();
		if (!Array.isArray(customers)) return { status: "unavailable" };
		if (customers.length === 0) return { status: "missing" };

		const discount = (
			customers[0] as
				| {
						discount?: {
							id?: unknown;
							couponId?: unknown;
							couponTestId?: unknown;
						} | null;
				  }
				| undefined
		)?.discount;
		if (!discount || typeof discount.id !== "string") {
			return { status: "found", discount: null };
		}

		const couponId =
			serverEnv().VERCEL_ENV === "production"
				? discount.couponId
				: discount.couponTestId;
		if (typeof couponId !== "string" || !COUPON_ID_PATTERN.test(couponId)) {
			return { status: "found", discount: null };
		}
		return {
			status: "found",
			discount: { couponId, discountId: discount.id },
		};
	} catch (error) {
		console.error("[referrals] Dub customer lookup failed", {
			userId,
			error: error instanceof Error ? error.message : String(error),
		});
		return { status: "unavailable" };
	}
}

export async function getReferralDiscount(
	userId: string,
): Promise<ReferralDiscount | null> {
	const customer = await findReferralCustomer(userId);
	return customer.status === "found" ? customer.discount : null;
}
