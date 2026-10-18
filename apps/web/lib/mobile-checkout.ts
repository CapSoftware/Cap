export type CheckoutPlatform = "desktop" | "mobile" | "web";

export type CheckoutRedirectUrls = {
	successUrl: string;
	cancelUrl: string;
};

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

export function getCheckoutRedirectUrls(
	platform: CheckoutPlatform,
	webUrl: string,
): CheckoutRedirectUrls {
	if (platform === "mobile") {
		const baseUrl = trimTrailingSlashes(webUrl);
		return {
			successUrl: `${baseUrl}/mobile/checkout/complete?checkout=success`,
			cancelUrl: `${baseUrl}/mobile/checkout/complete?checkout=cancelled`,
		};
	}

	if (platform === "web") {
		return {
			successUrl: `${webUrl}/dashboard/caps?upgrade=true&guest=true&session_id={CHECKOUT_SESSION_ID}`,
			cancelUrl: `${webUrl}/pricing`,
		};
	}

	return {
		successUrl: `${webUrl}/dashboard/caps?upgrade=true`,
		cancelUrl: `${webUrl}/pricing`,
	};
}

export function getMobileCheckoutDeepLink(checkout: "cancelled" | "success") {
	return `cap://account?checkout=${checkout}`;
}
