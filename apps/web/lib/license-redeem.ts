export const DEFAULT_LICENSE_API_URL = "https://l.cap.so";

export const LICENSE_KEY_LENGTH = 30;
const LICENSE_KEY_PATTERN = /^[0-9A-Za-z]{30}$/;
const CHECKOUT_SESSION_PATTERN = /^cs_(test|live)_[0-9A-Za-z]{10,200}$/;

export type LicenseDuration = "yearly" | "lifetime";

type Refused =
	| { status: "rate_limited"; retryAfter: number }
	| { status: "unavailable" };

export type GiftLookup =
	| { status: "claimable"; duration: LicenseDuration }
	| { status: "redeemed" }
	| { status: "not_found" }
	| Refused;

export type GiftClaim =
	| { status: "claimed"; duration: LicenseDuration; emailSent: boolean }
	| { status: "redeemed" }
	| { status: "not_found" }
	| Refused;

export type PurchasedLicense =
	| { position: number; licenseKey: string; redeemed: false }
	| { position: number; licenseKey: null; redeemed: true };

export const LICENSE_KEY_SLOTS = ["k1", "k2", "k3", "k4", "k5", "k6"] as const;

export type PurchaseLookup =
	| { status: "pending" }
	| {
			status: "ready";
			gift: boolean;
			duration: LicenseDuration;
			email: string | null;
			licenses: PurchasedLicense[];
	  }
	| Refused;

export const isLicenseKey = (value: string) => LICENSE_KEY_PATTERN.test(value);

export const REDEEM_INTENT_STORAGE_KEY = "cap-redeem-intent";

export type RedeemIntent = { session: string } | { key: string };

export function parseRedeemIntent(value: unknown): RedeemIntent | null {
	if (!isRecord(value)) return null;
	if (
		typeof value.session === "string" &&
		CHECKOUT_SESSION_PATTERN.test(value.session)
	) {
		return { session: value.session };
	}
	if (typeof value.key === "string" && isLicenseKey(value.key)) {
		return { key: value.key };
	}
	return null;
}

// A gift link carries a license key and a purchase return carries a checkout
// session, and either one is all it takes to collect the license. Analytics
// records the full page URL on load, so this runs while the document is still
// parsing, ahead of every deferred script: it moves the value into this tab's
// session storage and leaves a bare /redeem in the address bar and history.
export const TAKE_REDEEM_INTENT_FROM_URL = `(function(){try{var l=window.location,h=l.hash.slice(1),q=new URLSearchParams(l.search);var s=q.get("session_id")||(h.indexOf("session=")===0?h.slice(8):"");var k=q.get("key")||(s?"":h);var v=null;if(/^cs_(test|live)_[0-9A-Za-z]{10,200}$/.test(s)){v={session:s}}else if(/^[0-9A-Za-z]{30}$/.test(k)){v={key:k}}if(!v){try{v=JSON.parse(sessionStorage.getItem("${REDEEM_INTENT_STORAGE_KEY}"))}catch(e){}if(v){window.__capRedeemIntent=v;document.body.classList.add("rd-pending")}return}window.__capRedeemIntent=v;document.body.classList.add("rd-pending");history.replaceState(history.state,"",l.pathname);try{sessionStorage.setItem("${REDEEM_INTENT_STORAGE_KEY}",JSON.stringify(v))}catch(e){}}catch(e){}})();`;

export function redeemIntentFromLocation(location: {
	hash: string;
	search: string;
}): RedeemIntent | null {
	const hash = location.hash.replace(/^#/, "");
	const query = new URLSearchParams(location.search);
	return (
		parseRedeemIntent({
			session:
				query.get("session_id") ??
				(hash.startsWith("session=")
					? hash.slice("session=".length)
					: undefined),
		}) ?? parseRedeemIntent({ key: query.get("key") ?? hash })
	);
}

// The redeem page's inline script normally hands the intent over on `window`
// after stripping it from the URL. The URL is still read here for the case
// where the page was reached by a client-side navigation, which runs no
// inline script.
export function readRedeemIntent(source: {
	handedOver: unknown;
	stored: string | null;
	location: { hash: string; search: string };
}): RedeemIntent | null {
	const handedOver = parseRedeemIntent(source.handedOver);
	if (handedOver) return handedOver;

	const fromUrl = redeemIntentFromLocation(source.location);
	if (fromUrl) return fromUrl;

	if (!source.stored) return null;
	try {
		return parseRedeemIntent(JSON.parse(source.stored));
	} catch {
		return null;
	}
}

// People paste the key, the key with spaces from the card, or the whole gift
// link. All three resolve to the same 30 characters.
export function extractLicenseKey(input: string): string {
	const trimmed = input.trim();
	const fromHash = trimmed.includes("#")
		? trimmed.slice(trimmed.lastIndexOf("#") + 1)
		: trimmed;
	const fromQuery = /[?&]key=([^&#\s]+)/.exec(trimmed)?.[1];
	return (fromQuery ?? fromHash).replace(/[^0-9A-Za-z]/g, "");
}

export const giftLink = (origin: string, licenseKey: string) =>
	`${origin}/redeem#${licenseKey}`;

export const groupLicenseKey = (licenseKey: string) =>
	licenseKey.match(/.{1,5}/g) ?? [];

const isDuration = (value: unknown): value is LicenseDuration =>
	value === "yearly" || value === "lifetime";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function post(
	baseUrl: string,
	path: string,
	body: Record<string, string>,
	signal?: AbortSignal,
): Promise<Record<string, unknown> | Refused> {
	let response: Response;
	try {
		response = await fetch(`${baseUrl}/api/commercial/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
	} catch {
		return { status: "unavailable" };
	}

	if (response.status === 429) {
		const header = Number(response.headers.get("Retry-After"));
		const data: unknown = await response.json().catch(() => null);
		const fromBody = isRecord(data) ? Number(data.retryAfter) : Number.NaN;
		const retryAfter = [header, fromBody].find(
			(seconds) => Number.isFinite(seconds) && seconds > 0,
		);
		return { status: "rate_limited", retryAfter: retryAfter ?? 600 };
	}
	if (!response.ok) return { status: "unavailable" };

	const data: unknown = await response.json().catch(() => null);
	return isRecord(data) ? data : { status: "unavailable" };
}

const refused = (data: Record<string, unknown>): Refused | null =>
	data.status === "rate_limited" && typeof data.retryAfter === "number"
		? { status: "rate_limited", retryAfter: data.retryAfter }
		: data.status === "unavailable"
			? { status: "unavailable" }
			: null;

export async function lookupGift(
	baseUrl: string,
	licenseKey: string,
	signal?: AbortSignal,
): Promise<GiftLookup> {
	if (!isLicenseKey(licenseKey)) return { status: "not_found" };
	const data = await post(baseUrl, "redeem/lookup", { licenseKey }, signal);
	if (data.status === "claimable" && isDuration(data.duration)) {
		return { status: "claimable", duration: data.duration };
	}
	if (data.status === "redeemed" || data.status === "not_found") {
		return { status: data.status };
	}
	return refused(data) ?? { status: "unavailable" };
}

export async function claimGift(
	baseUrl: string,
	licenseKey: string,
	email: string,
): Promise<GiftClaim> {
	if (!isLicenseKey(licenseKey)) return { status: "not_found" };
	const data = await post(baseUrl, "redeem/claim", { licenseKey, email });
	if (data.status === "claimed" && isDuration(data.duration)) {
		return {
			status: "claimed",
			duration: data.duration,
			emailSent: data.emailSent === true,
		};
	}
	if (data.status === "redeemed" || data.status === "not_found") {
		return { status: data.status };
	}
	return refused(data) ?? { status: "unavailable" };
}

export async function lookupPurchase(
	baseUrl: string,
	sessionId: string,
	signal?: AbortSignal,
): Promise<PurchaseLookup> {
	const data = await post(baseUrl, "purchase", { sessionId }, signal);
	if (data.status === "pending") return { status: "pending" };
	if (
		data.status === "ready" &&
		isDuration(data.duration) &&
		Array.isArray(data.licenses)
	) {
		const licenses: PurchasedLicense[] = [];
		for (const entry of data.licenses) {
			if (!isRecord(entry)) return { status: "unavailable" };
			const key = entry.licenseKey;
			const position = licenses.length + 1;
			if (entry.redeemed === true) {
				licenses.push({ position, licenseKey: null, redeemed: true });
			} else if (typeof key === "string" && isLicenseKey(key)) {
				licenses.push({ position, licenseKey: key, redeemed: false });
			} else {
				return { status: "unavailable" };
			}
		}
		if (licenses.length === 0) return { status: "unavailable" };
		return {
			status: "ready",
			gift: data.gift === true,
			duration: data.duration,
			email: typeof data.email === "string" ? data.email : null,
			licenses,
		};
	}
	return refused(data) ?? { status: "unavailable" };
}

export function retryAfterText(seconds: number): string {
	const minutes = Math.ceil(seconds / 60);
	if (minutes <= 1) return "a minute";
	if (minutes < 60) return `${minutes} minutes`;
	const hours = Math.ceil(minutes / 60);
	return hours === 1 ? "an hour" : `${hours} hours`;
}
