import { authOptions } from "@cap/database/auth/auth-options";
import {
	dubCookieDomain,
	findReferralCustomer,
	getReferralDiscount,
	parseDubClickId,
	trackReferralLead,
} from "@cap/database/referrals";
import type { User } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>,
	cookies: new Map<string, string>(),
	cookieSet: vi.fn(),
	host: "cap.so",
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => mocks.env,
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
}));

vi.mock("@cap/database", () => ({ db: () => ({}) }));

vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: (name: string) => {
			const value = mocks.cookies.get(name);
			return value === undefined ? undefined : { name, value };
		},
		set: mocks.cookieSet,
	}),
	headers: async () => new Headers({ host: mocks.host }),
}));

const fetchMock = vi.fn<typeof fetch>();

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const leadBody = () => {
	const init = fetchMock.mock.calls[0]?.[1];
	return JSON.parse(String(init?.body));
};

beforeEach(() => {
	mocks.env = { DUB_API_KEY: "dub_test_key", VERCEL_ENV: "production" };
	mocks.cookies = new Map();
	mocks.host = "cap.so";
	fetchMock.mockReset();
	mocks.cookieSet.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("parseDubClickId", () => {
	it("accepts Dub click IDs", () => {
		expect(parseDubClickId("k3XpQ9wLm2Vb7RtA")).toBe("k3XpQ9wLm2Vb7RtA");
		expect(parseDubClickId(" test ")).toBe("test");
	});

	it.each([
		undefined,
		null,
		"",
		"a b",
		"x;domain=evil",
		"<script>",
		"a".repeat(65),
	])("rejects %s", (value) => {
		expect(parseDubClickId(value)).toBeNull();
	});
});

describe("dubCookieDomain", () => {
	it("matches the Domain the Dub script writes", () => {
		expect(dubCookieDomain("cap.so")).toBe(".cap.so");
		expect(dubCookieDomain("www.cap.so")).toBe(".cap.so");
		expect(dubCookieDomain("cap.so:443")).toBe(".cap.so");
		expect(dubCookieDomain("localhost:3000")).toBeUndefined();
		expect(dubCookieDomain("")).toBeUndefined();
	});
});

describe("trackReferralLead", () => {
	const user = {
		id: "user_123",
		email: "new@example.com",
		name: "New User",
		image: "https://lh3.googleusercontent.com/avatar",
	};

	it("records the sign-up lead against the Cap user ID and waits for it", async () => {
		fetchMock.mockResolvedValue(json({ click: { id: "click_1" } }));

		await expect(trackReferralLead({ clickId: "click_1", user })).resolves.toBe(
			true,
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe("https://api.dub.co/track/lead");
		expect(init?.method).toBe("POST");
		expect(new Headers(init?.headers).get("authorization")).toBe(
			"Bearer dub_test_key",
		);
		expect(leadBody()).toEqual({
			clickId: "click_1",
			eventName: "Sign Up",
			customerExternalId: "user_123",
			customerName: "New User",
			customerEmail: "new@example.com",
			customerAvatar: "https://lh3.googleusercontent.com/avatar",
			mode: "wait",
		});
	});

	it("does not send storage keys as avatar URLs", async () => {
		fetchMock.mockResolvedValue(json({}));
		await trackReferralLead({
			clickId: "click_1",
			user: { ...user, image: "users/user_123/avatar.png", name: " " },
		});
		expect(leadBody()).toMatchObject({
			customerAvatar: null,
			customerName: null,
		});
	});

	it("reports failure when Dub rejects the click", async () => {
		fetchMock.mockResolvedValue(json({ error: { code: "not_found" } }, 404));
		await expect(trackReferralLead({ clickId: "click_1", user })).resolves.toBe(
			false,
		);
	});

	it("reports failure instead of throwing when Dub is unreachable", async () => {
		fetchMock.mockRejectedValue(new Error("network down"));
		await expect(trackReferralLead({ clickId: "click_1", user })).resolves.toBe(
			false,
		);
	});

	it("does nothing without a Dub API key", async () => {
		mocks.env = {};
		await expect(trackReferralLead({ clickId: "click_1", user })).resolves.toBe(
			false,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("getReferralDiscount", () => {
	const customer = {
		externalId: "user_123",
		discount: {
			id: "disc_1",
			couponId: "cpn_partner20",
			couponTestId: "test_cpn",
		},
	};

	it("looks the customer up by Cap user ID", async () => {
		fetchMock.mockResolvedValue(json([customer]));
		await getReferralDiscount("user_123");
		const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(url.origin + url.pathname).toBe("https://api.dub.co/customers");
		expect(url.searchParams.get("externalId")).toBe("user_123");
		expect(url.searchParams.get("includeExpandedFields")).toBe("true");
	});

	it("returns the live coupon in production", async () => {
		fetchMock.mockResolvedValue(json([customer]));
		await expect(getReferralDiscount("user_123")).resolves.toEqual({
			couponId: "cpn_partner20",
			discountId: "disc_1",
		});
	});

	it("returns the test coupon outside production", async () => {
		mocks.env.VERCEL_ENV = "preview";
		fetchMock.mockResolvedValue(json([customer]));
		await expect(getReferralDiscount("user_123")).resolves.toEqual({
			couponId: "test_cpn",
			discountId: "disc_1",
		});
	});

	it.each([
		["no Dub customer", json([])],
		["a customer without a discount", json([{ discount: null }])],
		[
			"a discount without a coupon for this mode",
			json([{ discount: { ...customer.discount, couponId: null } }]),
		],
		[
			"a malformed coupon ID",
			json([{ discount: { ...customer.discount, couponId: "a b" } }]),
		],
		["a Dub error", json({ error: {} }, 500)],
		["an unexpected payload", json({ customers: [] })],
	])("returns null for %s", async (_label, response) => {
		fetchMock.mockResolvedValue(response);
		await expect(getReferralDiscount("user_123")).resolves.toBeNull();
	});

	it("returns null instead of throwing when Dub is unreachable", async () => {
		fetchMock.mockRejectedValue(new Error("timeout"));
		await expect(getReferralDiscount("user_123")).resolves.toBeNull();
	});

	it("does nothing without a Dub API key", async () => {
		mocks.env = {};
		await expect(getReferralDiscount("user_123")).resolves.toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("findReferralCustomer", () => {
	it("tells a missing customer apart from Dub being unavailable", async () => {
		fetchMock.mockResolvedValueOnce(json([]));
		await expect(findReferralCustomer("user_123")).resolves.toEqual({
			status: "missing",
		});

		fetchMock.mockResolvedValueOnce(json({ error: {} }, 503));
		await expect(findReferralCustomer("user_123")).resolves.toEqual({
			status: "unavailable",
		});

		fetchMock.mockRejectedValueOnce(new Error("timeout"));
		await expect(findReferralCustomer("user_123")).resolves.toEqual({
			status: "unavailable",
		});
	});

	it("reports a referral without a discount as found", async () => {
		fetchMock.mockResolvedValue(json([{ externalId: "user_123" }]));
		await expect(findReferralCustomer("user_123")).resolves.toEqual({
			status: "found",
			discount: null,
		});
	});
});

describe("NextAuth sign-in referral tracking", () => {
	const signIn = (isNewUser: boolean) =>
		authOptions().events?.signIn?.({
			user: {
				id: "user_123",
				email: "new@example.com",
				name: "New User",
				image: null,
			} as User,
			account: null,
			isNewUser,
		});

	it("credits a new account to the partner click and clears the click", async () => {
		mocks.cookies.set("dub_id", "click_1");
		mocks.cookies.set("dub_partner_data", "{}");
		fetchMock.mockResolvedValue(json({ click: { id: "click_1" } }));

		await signIn(true);

		expect(leadBody()).toMatchObject({
			clickId: "click_1",
			customerExternalId: "user_123",
			eventName: "Sign Up",
		});
		expect(mocks.cookieSet).toHaveBeenCalledWith("dub_id", "", {
			domain: ".cap.so",
			path: "/",
			maxAge: 0,
		});
		expect(mocks.cookieSet).toHaveBeenCalledWith("dub_partner_data", "", {
			domain: ".cap.so",
			path: "/",
			maxAge: 0,
		});
	});

	it("ignores returning users", async () => {
		mocks.cookies.set("dub_id", "click_1");
		await signIn(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("ignores sign-ups without a partner click", async () => {
		await signIn(true);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps the click when Dub did not record the lead", async () => {
		mocks.cookies.set("dub_id", "click_1");
		fetchMock.mockResolvedValue(json({ error: {} }, 500));
		await signIn(true);
		expect(mocks.cookieSet).not.toHaveBeenCalled();
	});

	it("never fails the sign-in when Dub is down", async () => {
		mocks.cookies.set("dub_id", "click_1");
		fetchMock.mockRejectedValue(new Error("network down"));
		await expect(signIn(true)).resolves.toBeUndefined();
	});
});
