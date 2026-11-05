import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	checkRateLimit: vi.fn(),
	headers: vi.fn(),
}));

vi.mock("@vercel/firewall", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));

const loadRateLimit = async () => {
	vi.resetModules();
	return import("@/lib/rate-limit");
};

const callTimes = async (count: number, call: () => Promise<boolean>) => {
	const results: boolean[] = [];
	for (let index = 0; index < count; index++) results.push(await call());
	return results;
};

beforeEach(() => {
	mocks.checkRateLimit.mockReset();
	mocks.headers.mockReset().mockResolvedValue(new Headers());
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("firewallRequestHeaders", () => {
	it("forwards only host and client IP headers", async () => {
		const { firewallRequestHeaders } = await loadRateLimit();
		const forwarded = firewallRequestHeaders(
			new Headers({
				host: "cap.so",
				"x-real-ip": "203.0.113.10",
				"x-forwarded-for": "203.0.113.10, 10.0.0.1",
				"next-action": "40382acacfe2b9dd0581bfc42bc9a2c02535278e38",
				accept: "text/x-component",
				cookie: "next-auth.session-token=secret",
			}),
		);

		expect(forwarded.get("host")).toBe("cap.so");
		expect(forwarded.get("x-real-ip")).toBe("203.0.113.10");
		expect(forwarded.get("x-forwarded-for")).toBe("203.0.113.10, 10.0.0.1");
		expect(forwarded.get("next-action")).toBeNull();
		expect(forwarded.get("accept")).toBeNull();
		expect(forwarded.get("cookie")).toBeNull();
	});
});

describe("isRateLimited outside production", () => {
	it("applies the rule's in-process limit per key without calling the firewall", async () => {
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		const send = (key: string) =>
			isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_SEND, { key });

		expect(await callTimes(10, () => send("email-a"))).toEqual(
			Array(10).fill(false),
		);
		expect(await send("email-a")).toBe(true);
		expect(await send("email-b")).toBe(false);
		expect(mocks.checkRateLimit).not.toHaveBeenCalled();
	});

	it("keeps separate buckets per rule for the same key", async () => {
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		await callTimes(10, () =>
			isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_SEND, { key: "shared" }),
		);

		expect(
			await isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_SEND, { key: "shared" }),
		).toBe(true);
		expect(
			await isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_VERIFY, { key: "shared" }),
		).toBe(false);
	});

	it("allows requests again once the window has passed", async () => {
		vi.useFakeTimers();
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		const verify = () =>
			isRateLimited(RATE_LIMIT_IDS.MOBILE_VIDEO_PASSWORD, { key: "user-1" });

		await callTimes(20, verify);
		expect(await verify()).toBe(true);

		vi.advanceTimersByTime(10 * 60_000);
		expect(await verify()).toBe(false);
	});

	it("allows 30 organization invite batches per key each hour", async () => {
		vi.useFakeTimers();
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		const invite = () =>
			isRateLimited(RATE_LIMIT_IDS.ORGANIZATION_INVITE, {
				key: "organization-invite:organization:org-1",
			});

		expect(await callTimes(30, invite)).toEqual(Array(30).fill(false));
		expect(await invite()).toBe(true);

		vi.advanceTimersByTime(59 * 60_000);
		expect(await invite()).toBe(true);

		vi.advanceTimersByTime(60_000);
		expect(await invite()).toBe(false);
	});

	it("allows 20 checkouts per account every ten minutes", async () => {
		vi.useFakeTimers();
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		const checkout = (userId: string) =>
			isRateLimited(RATE_LIMIT_IDS.CHECKOUT, { key: `checkout:${userId}` });

		expect(await callTimes(20, () => checkout("user-1"))).toEqual(
			Array(20).fill(false),
		);
		expect(await checkout("user-1")).toBe(true);
		expect(await checkout("user-2")).toBe(false);

		vi.advanceTimersByTime(10 * 60_000);
		expect(await checkout("user-1")).toBe(false);
	});

	it("keys on x-real-ip, then the first x-forwarded-for entry on Vercel", async () => {
		vi.stubEnv("VERCEL", "1");
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		const fromHeaders = (init: Record<string, string>) =>
			isRateLimited(RATE_LIMIT_IDS.TRANSLATE_TRANSCRIPT, {
				headers: new Headers(init),
			});

		await callTimes(30, () =>
			fromHeaders({
				"x-real-ip": "203.0.113.1",
				"x-forwarded-for": "198.51.100.9",
			}),
		);
		expect(await fromHeaders({ "x-real-ip": "203.0.113.1" })).toBe(true);
		expect(await fromHeaders({ "x-forwarded-for": "198.51.100.9" })).toBe(
			false,
		);

		await callTimes(29, () =>
			fromHeaders({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" }),
		);
		expect(await fromHeaders({ "x-forwarded-for": "198.51.100.9" })).toBe(true);
		expect(await fromHeaders({ "x-forwarded-for": "10.0.0.1" })).toBe(false);
	});

	it("reads App Router headers when none are passed", async () => {
		mocks.headers.mockResolvedValue(new Headers({ "x-real-ip": "192.0.2.4" }));
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();

		await callTimes(30, () =>
			isRateLimited(RATE_LIMIT_IDS.TRANSLATE_TRANSCRIPT),
		);
		expect(await isRateLimited(RATE_LIMIT_IDS.TRANSLATE_TRANSCRIPT)).toBe(true);
		expect(
			await isRateLimited(RATE_LIMIT_IDS.TRANSLATE_TRANSCRIPT, {
				headers: new Headers({ "x-real-ip": "192.0.2.5" }),
			}),
		).toBe(false);
	});

	it("keys on the last x-forwarded-for entry off Vercel", async () => {
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		const fromHeaders = (init: Record<string, string>) =>
			isRateLimited(RATE_LIMIT_IDS.TRANSLATE_TRANSCRIPT, {
				headers: new Headers(init),
			});

		for (let index = 0; index < 30; index++) {
			expect(
				await fromHeaders({
					"x-real-ip": `198.51.100.${index}`,
					"x-forwarded-for": `192.0.2.${index}, 203.0.113.7`,
				}),
			).toBe(false);
		}
		expect(
			await fromHeaders({
				"x-real-ip": "198.51.100.200",
				"x-forwarded-for": "192.0.2.200, 203.0.113.7",
			}),
		).toBe(true);
		expect(await fromHeaders({ "x-forwarded-for": "203.0.113.8" })).toBe(false);
		expect(await fromHeaders({ "x-real-ip": "203.0.113.7" })).toBe(true);
	});

	it("keeps each client's allowance when many other addresses are seen off Vercel", async () => {
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		const fromAddress = (ip: string) =>
			isRateLimited(RATE_LIMIT_IDS.TRANSLATE_TRANSCRIPT, {
				headers: new Headers({ "x-forwarded-for": ip }),
			});

		for (let index = 0; index < 400; index++) {
			expect(await fromAddress(`198.51.${index >> 8}.${index & 255}`)).toBe(
				false,
			);
		}
		expect(await fromAddress("203.0.113.250")).toBe(false);
	});

	it("groups IPv6 clients by their /64 network", async () => {
		const { isRateLimited, rateLimitClientAddress, RATE_LIMIT_IDS } =
			await loadRateLimit();
		const fromAddress = (ip: string) =>
			isRateLimited(RATE_LIMIT_IDS.TRANSLATE_TRANSCRIPT, {
				headers: new Headers({ "x-forwarded-for": ip }),
			});

		for (let index = 0; index < 30; index++) {
			expect(await fromAddress(`2001:db8:1:2::${index.toString(16)}`)).toBe(
				false,
			);
		}
		expect(await fromAddress("2001:db8:1:2:ffff:1:2:3")).toBe(true);
		expect(await fromAddress("2001:db8:1:3::1")).toBe(false);

		const address = (ip: string) =>
			rateLimitClientAddress(new Headers({ "x-forwarded-for": ip }));
		expect(address("2001:0DB8:0001:0002:0:0:0:1")).toBe("2001:db8:1:2::/64");
		expect(address("::1")).toBe("0:0:0:0::/64");
		expect(address("::ffff:203.0.113.4")).toBe("203.0.113.4");
		expect(address("203.0.113.4")).toBe("203.0.113.4");
		expect(address("fe80::1%eth0")).toBe("fe80::1%eth0");
		expect(address("1::2::3")).toBe("1::2::3");
	});

	it("does not let one limited address use up the shared bucket", async () => {
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		const fromAddress = (ip: string) =>
			isRateLimited(RATE_LIMIT_IDS.TRANSLATE_TRANSCRIPT, {
				headers: new Headers({ "x-real-ip": ip }),
			});

		await callTimes(500, () => fromAddress("203.0.113.9"));
		expect(await fromAddress("203.0.113.10")).toBe(false);
	});

	it("trusts client addresses on Vercel", async () => {
		vi.stubEnv("VERCEL", "1");
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		const fromAddress = (ip: string) =>
			isRateLimited(RATE_LIMIT_IDS.TRANSLATE_TRANSCRIPT, {
				headers: new Headers({ "x-real-ip": ip }),
			});

		for (let index = 0; index < 400; index++) {
			expect(await fromAddress(`198.51.${index >> 8}.${index & 255}`)).toBe(
				false,
			);
		}
	});

	it("shares one larger bucket when there is no key and no client address", async () => {
		mocks.headers.mockRejectedValue(new Error("outside a request scope"));
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		const anonymous = () => isRateLimited(RATE_LIMIT_IDS.TRANSLATE_TRANSCRIPT);

		expect(await callTimes(300, anonymous)).toEqual(Array(300).fill(false));
		expect(await anonymous()).toBe(true);
	});

	it("uses a default limit for rule ids without a configured one", async () => {
		const { isRateLimited } = await loadRateLimit();
		const call = () => isRateLimited("rl_unlisted_rule", { key: "k" });

		expect(await callTimes(60, call)).toEqual(Array(60).fill(false));
		expect(await call()).toBe(true);
	});

	it("evicts the oldest buckets instead of growing without bound", async () => {
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		const send = (key: string) =>
			isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_SEND, { key });

		await callTimes(10, () => send("oldest"));
		expect(await send("oldest")).toBe(true);

		for (let index = 0; index < 10_000; index++) await send(`filler-${index}`);

		expect(await send("oldest")).toBe(false);
	});

	it("accepts very long keys", async () => {
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		const longKey = "x".repeat(100_000);

		await callTimes(10, () =>
			isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_SEND, { key: longKey }),
		);
		expect(
			await isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_SEND, { key: longKey }),
		).toBe(true);
		expect(
			await isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_SEND, {
				key: `${longKey}y`,
			}),
		).toBe(false);
	});
});

describe("isRateLimited in production", () => {
	beforeEach(() => {
		vi.stubEnv("NODE_ENV", "production");
	});

	it("follows the firewall when its rule answers", async () => {
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		mocks.checkRateLimit.mockResolvedValue({ rateLimited: false });

		expect(
			await callTimes(20, () =>
				isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_SEND, { key: "email" }),
			),
		).toEqual(Array(20).fill(false));

		mocks.checkRateLimit.mockResolvedValueOnce({ rateLimited: true });
		expect(
			await isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_SEND, { key: "other" }),
		).toBe(true);

		mocks.checkRateLimit.mockResolvedValueOnce({
			rateLimited: true,
			error: "blocked",
		});
		expect(
			await isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_SEND, { key: "third" }),
		).toBe(true);
		expect(mocks.checkRateLimit).toHaveBeenLastCalledWith(
			RATE_LIMIT_IDS.AUTH_OTP_SEND,
			expect.objectContaining({ rateLimitKey: "third" }),
		);
	});

	it("falls back to the in-process limit when the firewall rule is missing", async () => {
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		mocks.checkRateLimit.mockResolvedValue({
			rateLimited: false,
			error: "not-found",
		});
		const send = () =>
			isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_SEND, { key: "email" });

		expect(await callTimes(10, send)).toEqual(Array(10).fill(false));
		expect(await send()).toBe(true);
	});

	it("falls back to the in-process limit when the firewall check throws", async () => {
		const { isRateLimited, RATE_LIMIT_IDS } = await loadRateLimit();
		mocks.checkRateLimit.mockRejectedValue(
			new Error("Could not determine rate limit key."),
		);
		const verify = () =>
			isRateLimited(RATE_LIMIT_IDS.MOBILE_VIDEO_PASSWORD, {
				headers: new Headers({ "x-forwarded-for": "198.51.100.7" }),
			});

		expect(await callTimes(20, verify)).toEqual(Array(20).fill(false));
		await expect(verify()).resolves.toBe(true);
	});
});
