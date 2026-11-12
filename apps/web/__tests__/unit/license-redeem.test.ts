import { afterEach, describe, expect, it, vi } from "vitest";
import {
	claimGift,
	extractLicenseKey,
	giftLink,
	groupLicenseKey,
	isLicenseKey,
	lookupGift,
	lookupPurchase,
	parseRedeemIntent,
	REDEEM_INTENT_STORAGE_KEY,
	readRedeemIntent,
	redeemIntentFromLocation,
	retryAfterText,
	TAKE_REDEEM_INTENT_FROM_URL,
} from "@/lib/license-redeem";

const KEY = "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0";
const SESSION = "cs_test_a1B2c3D4e5F6g7H8i9J0";
const API = "https://license.test";

const respond = (
	status: number,
	body: unknown,
	headers?: Record<string, string>,
) =>
	vi.fn().mockResolvedValue(
		new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers,
		}),
	);

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("license keys", () => {
	it("accepts exactly 30 letters and digits", () => {
		expect(isLicenseKey(KEY)).toBe(true);
		expect(isLicenseKey(KEY.slice(1))).toBe(false);
		expect(isLicenseKey(`${KEY}A`)).toBe(false);
		expect(isLicenseKey(`${KEY.slice(0, 29)}-`)).toBe(false);
		expect(isLicenseKey("")).toBe(false);
	});

	it("pulls the key out of whatever was pasted", () => {
		expect(extractLicenseKey(`  ${KEY}\n`)).toBe(KEY);
		expect(extractLicenseKey(groupLicenseKey(KEY).join(" "))).toBe(KEY);
		expect(extractLicenseKey(groupLicenseKey(KEY).join("-"))).toBe(KEY);
		expect(extractLicenseKey(`https://cap.so/redeem#${KEY}`)).toBe(KEY);
		expect(extractLicenseKey(`cap.so/redeem?key=${KEY}&utm=x`)).toBe(KEY);
		expect(extractLicenseKey(`https://cap.so/redeem?utm=x#${KEY}`)).toBe(KEY);
	});

	it("leaves something that is not a key recognisably invalid", () => {
		expect(isLicenseKey(extractLicenseKey("https://cap.so/redeem"))).toBe(
			false,
		);
		expect(isLicenseKey(extractLicenseKey("hello"))).toBe(false);
		expect(isLicenseKey(extractLicenseKey(""))).toBe(false);
	});

	it("groups a key in fives and builds a fragment link", () => {
		expect(groupLicenseKey(KEY)).toEqual([
			"Ab3dE",
			"6gH9j",
			"K2mN5",
			"pQ8sT",
			"1vW4y",
			"Z7cF0",
		]);
		expect(giftLink("https://cap.so", KEY)).toBe(
			`https://cap.so/redeem#${KEY}`,
		);
	});
});

describe("redeem intent", () => {
	const none = { hash: "", search: "" };

	it("accepts only a well formed session or key", () => {
		expect(parseRedeemIntent({ session: SESSION })).toEqual({
			session: SESSION,
		});
		expect(parseRedeemIntent({ key: KEY })).toEqual({ key: KEY });
		expect(parseRedeemIntent({ session: "cs_test_short" })).toBeNull();
		expect(parseRedeemIntent({ session: `${SESSION}<script>` })).toBeNull();
		expect(parseRedeemIntent({ key: "nope" })).toBeNull();
		expect(parseRedeemIntent({ key: 42 })).toBeNull();
		expect(parseRedeemIntent(null)).toBeNull();
		expect(parseRedeemIntent("x")).toBeNull();
	});

	it("prefers what the inline script handed over", () => {
		expect(
			readRedeemIntent({
				handedOver: { key: KEY },
				stored: JSON.stringify({ session: SESSION }),
				location: none,
			}),
		).toEqual({ key: KEY });
	});

	it("reads an intent straight from a location", () => {
		expect(redeemIntentFromLocation({ hash: `#${KEY}`, search: "" })).toEqual({
			key: KEY,
		});
		expect(
			redeemIntentFromLocation({ hash: `#session=${SESSION}`, search: "" }),
		).toEqual({ session: SESSION });
		expect(redeemIntentFromLocation({ hash: "", search: "" })).toBeNull();
		expect(
			redeemIntentFromLocation({ hash: "#faq", search: "?ref=x" }),
		).toBeNull();
	});

	it("reads the URL when nothing was handed over", () => {
		const read = (location: { hash: string; search: string }) =>
			readRedeemIntent({ handedOver: undefined, stored: null, location });
		expect(read({ hash: `#${KEY}`, search: "" })).toEqual({ key: KEY });
		expect(read({ hash: "", search: `?key=${KEY}` })).toEqual({ key: KEY });
		expect(read({ hash: `#session=${SESSION}`, search: "" })).toEqual({
			session: SESSION,
		});
		expect(read({ hash: "", search: `?session_id=${SESSION}` })).toEqual({
			session: SESSION,
		});
		expect(read({ hash: "#pricing", search: "?utm=x" })).toBeNull();
	});

	it("falls back to this tab's stored intent and ignores junk in it", () => {
		const read = (stored: string | null) =>
			readRedeemIntent({ handedOver: undefined, stored, location: none });
		expect(read(JSON.stringify({ session: SESSION }))).toEqual({
			session: SESSION,
		});
		expect(read("{not json")).toBeNull();
		expect(read(JSON.stringify({ key: "<img>" }))).toBeNull();
		expect(read(null)).toBeNull();
	});
});

describe("inline script that takes the intent out of the URL", () => {
	const run = (
		url: string,
		options: { stored?: string; storageThrows?: boolean } = {},
	) => {
		const location = new URL(url);
		const store = new Map<string, string>();
		if (options.stored) store.set(REDEEM_INTENT_STORAGE_KEY, options.stored);
		const fail = () => {
			throw new Error("storage blocked");
		};
		const sessionStorage = {
			getItem: options.storageThrows
				? fail
				: (name: string) => store.get(name) ?? null,
			setItem: options.storageThrows
				? fail
				: (name: string, value: string) => void store.set(name, value),
		};
		const replaceState = vi.fn();
		const classes: string[] = [];
		const window: Record<string, unknown> = { location };
		new Function(
			"window",
			"document",
			"history",
			"sessionStorage",
			TAKE_REDEEM_INTENT_FROM_URL,
		)(
			window,
			{ body: { classList: { add: (name: string) => classes.push(name) } } },
			{ state: { tree: 1 }, replaceState },
			sessionStorage,
		);
		return {
			intent: window.__capRedeemIntent,
			replaced: replaceState.mock.calls[0],
			pending: classes.includes("rd-pending"),
			stored: store.get(REDEEM_INTENT_STORAGE_KEY),
		};
	};

	it("takes a gift key out of the fragment", () => {
		const result = run(`https://cap.so/redeem#${KEY}`);
		expect(result.intent).toEqual({ key: KEY });
		expect(result.replaced).toEqual([{ tree: 1 }, "", "/redeem"]);
		expect(result.pending).toBe(true);
		expect(result.stored).toBe(JSON.stringify({ key: KEY }));
	});

	it("takes a checkout session out of the fragment or the query", () => {
		for (const url of [
			`https://cap.so/redeem#session=${SESSION}`,
			`https://cap.so/redeem?session_id=${SESSION}`,
		]) {
			const result = run(url);
			expect(result.intent).toEqual({ session: SESSION });
			expect(result.replaced?.[2]).toBe("/redeem");
			expect(result.stored).toBe(JSON.stringify({ session: SESSION }));
		}
	});

	it("takes a key out of the query", () => {
		const result = run(`https://cap.so/redeem?key=${KEY}&utm_source=x`);
		expect(result.intent).toEqual({ key: KEY });
		expect(result.replaced?.[2]).toBe("/redeem");
	});

	it("leaves an ordinary URL alone", () => {
		for (const url of [
			"https://cap.so/redeem",
			"https://cap.so/redeem?utm_source=x#pricing",
			"https://cap.so/redeem#session=nope",
			`https://cap.so/redeem#${KEY}x`,
		]) {
			const result = run(url);
			expect(result.intent).toBeUndefined();
			expect(result.replaced).toBeUndefined();
			expect(result.pending).toBe(false);
		}
	});

	it("resumes this tab's stored intent on a bare URL", () => {
		const result = run("https://cap.so/redeem", {
			stored: JSON.stringify({ session: SESSION }),
		});
		expect(result.intent).toEqual({ session: SESSION });
		expect(result.replaced).toBeUndefined();
		expect(result.pending).toBe(true);
	});

	it("still strips the URL when storage is blocked", () => {
		const result = run(`https://cap.so/redeem#${KEY}`, {
			storageThrows: true,
		});
		expect(result.intent).toEqual({ key: KEY });
		expect(result.replaced?.[2]).toBe("/redeem");
	});

	it("hands over exactly what the page then accepts", () => {
		const { intent } = run(`https://cap.so/redeem#session=${SESSION}`);
		expect(parseRedeemIntent(intent)).toEqual({ session: SESSION });
	});
});

describe("license server calls", () => {
	it("never sends a malformed key", async () => {
		const fetchMock = respond(200, { status: "claimable" });
		vi.stubGlobal("fetch", fetchMock);
		expect(await lookupGift(API, "short")).toEqual({ status: "not_found" });
		expect(await claimGift(API, "short", "a@b.co")).toEqual({
			status: "not_found",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("posts the lookup to the license server", async () => {
		const fetchMock = respond(200, {
			status: "claimable",
			duration: "lifetime",
		});
		vi.stubGlobal("fetch", fetchMock);
		expect(await lookupGift(API, KEY)).toEqual({
			status: "claimable",
			duration: "lifetime",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			`${API}/api/commercial/redeem/lookup`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ licenseKey: KEY }),
			}),
		);
	});

	it("passes redeemed and not_found through", async () => {
		vi.stubGlobal("fetch", respond(200, { status: "redeemed" }));
		expect(await lookupGift(API, KEY)).toEqual({ status: "redeemed" });
		vi.stubGlobal("fetch", respond(200, { status: "not_found" }));
		expect(await claimGift(API, KEY, "a@b.co")).toEqual({
			status: "not_found",
		});
	});

	it("reports a claim and whether the email went out", async () => {
		vi.stubGlobal(
			"fetch",
			respond(200, { status: "claimed", duration: "yearly", emailSent: true }),
		);
		expect(await claimGift(API, KEY, "a@b.co")).toEqual({
			status: "claimed",
			duration: "yearly",
			emailSent: true,
		});
	});

	it("reads the wait from a 429, header first", async () => {
		vi.stubGlobal(
			"fetch",
			respond(
				429,
				{ status: "rate_limited", retryAfter: 90 },
				{ "Retry-After": "120" },
			),
		);
		expect(await lookupGift(API, KEY)).toEqual({
			status: "rate_limited",
			retryAfter: 120,
		});
		vi.stubGlobal(
			"fetch",
			respond(429, { status: "rate_limited", retryAfter: 90 }),
		);
		expect(await lookupGift(API, KEY)).toEqual({
			status: "rate_limited",
			retryAfter: 90,
		});
		vi.stubGlobal("fetch", respond(429, "slow down"));
		expect(await lookupGift(API, KEY)).toEqual({
			status: "rate_limited",
			retryAfter: 600,
		});
	});

	it("treats anything unexpected as unavailable, never as success", async () => {
		const unavailable = { status: "unavailable" };
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		expect(await lookupGift(API, KEY)).toEqual(unavailable);
		vi.stubGlobal("fetch", respond(500, "boom"));
		expect(await claimGift(API, KEY, "a@b.co")).toEqual(unavailable);
		vi.stubGlobal("fetch", respond(200, "<html>"));
		expect(await lookupGift(API, KEY)).toEqual(unavailable);
		vi.stubGlobal("fetch", respond(200, { status: "claimable" }));
		expect(await lookupGift(API, KEY)).toEqual(unavailable);
		vi.stubGlobal(
			"fetch",
			respond(200, { status: "claimed", duration: "forever" }),
		);
		expect(await claimGift(API, KEY, "a@b.co")).toEqual(unavailable);
		vi.stubGlobal("fetch", respond(404, { status: "claimable" }));
		expect(await lookupGift(API, KEY)).toEqual(unavailable);
	});

	it("returns a purchase with claimed gifts keyless", async () => {
		vi.stubGlobal(
			"fetch",
			respond(200, {
				status: "ready",
				gift: true,
				duration: "lifetime",
				email: "b••••@cap.test",
				licenses: [
					{ licenseKey: KEY, redeemed: false },
					{ licenseKey: null, redeemed: true },
					{ licenseKey: KEY, redeemed: true },
				],
			}),
		);
		expect(await lookupPurchase(API, SESSION)).toEqual({
			status: "ready",
			gift: true,
			duration: "lifetime",
			email: "b••••@cap.test",
			licenses: [
				{ position: 1, licenseKey: KEY, redeemed: false },
				{ position: 2, licenseKey: null, redeemed: true },
				{ position: 3, licenseKey: null, redeemed: true },
			],
		});
	});

	it("refuses a purchase where an unclaimed license has no usable key", async () => {
		for (const broken of [
			{ licenseKey: "<script>", redeemed: false },
			{ licenseKey: null, redeemed: false },
			{ redeemed: "yes" },
			{},
			"junk",
			null,
		]) {
			vi.stubGlobal(
				"fetch",
				respond(200, {
					status: "ready",
					gift: true,
					duration: "lifetime",
					licenses: [{ licenseKey: KEY, redeemed: false }, broken],
				}),
			);
			expect(await lookupPurchase(API, SESSION)).toEqual({
				status: "unavailable",
			});
		}
	});

	it("handles a pending purchase and a ready one with nothing in it", async () => {
		vi.stubGlobal("fetch", respond(200, { status: "pending" }));
		expect(await lookupPurchase(API, SESSION)).toEqual({ status: "pending" });
		vi.stubGlobal(
			"fetch",
			respond(200, { status: "ready", duration: "yearly", licenses: [] }),
		);
		expect(await lookupPurchase(API, SESSION)).toEqual({
			status: "unavailable",
		});
	});
});

describe("retryAfterText", () => {
	it("rounds up to a readable wait", () => {
		expect(retryAfterText(1)).toBe("a minute");
		expect(retryAfterText(60)).toBe("a minute");
		expect(retryAfterText(61)).toBe("2 minutes");
		expect(retryAfterText(600)).toBe("10 minutes");
		expect(retryAfterText(3600)).toBe("an hour");
		expect(retryAfterText(3601)).toBe("2 hours");
		expect(retryAfterText(86400)).toBe("24 hours");
	});
});
