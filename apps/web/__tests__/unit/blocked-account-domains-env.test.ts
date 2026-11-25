import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const required = {
	DATABASE_URL: "mysql://user:pass@localhost:3306/cap",
	WEB_URL: "https://cap.test",
	NEXTAUTH_SECRET: "secret",
	NEXTAUTH_URL: "https://cap.test",
	CAP_AWS_BUCKET: "bucket",
	CAP_AWS_REGION: "us-east-1",
};

const loadEnv = async (lists: Record<string, string | undefined>) => {
	vi.resetModules();
	for (const [key, value] of Object.entries({ ...required, ...lists })) {
		if (value === undefined) vi.stubEnv(key, undefined as unknown as string);
		else vi.stubEnv(key, value);
	}
	const { serverEnv } = await import("@cap/env");
	const { isBlockedAccountEmail } = await import(
		"@cap/database/auth/domain-utils"
	);
	return { env: serverEnv(), isBlockedAccountEmail };
};

beforeEach(() => {
	vi.unstubAllEnvs();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("blocked signup domains env", () => {
	it("merges the extra list into the main list", async () => {
		const { env, isBlockedAccountEmail } = await loadEnv({
			CAP_BLOCKED_SIGNUP_DOMAINS: "first.test,someone@second.test",
			CAP_BLOCKED_SIGNUP_DOMAINS_EXTRA: "third.test",
		});
		expect(env.CAP_BLOCKED_SIGNUP_DOMAINS).toBe(
			"first.test,someone@second.test,third.test",
		);
		expect(isBlockedAccountEmail("a@first.test")).toBe(true);
		expect(isBlockedAccountEmail("someone@second.test")).toBe(true);
		expect(isBlockedAccountEmail("a@third.test")).toBe(true);
		expect(isBlockedAccountEmail("other@second.test")).toBe(false);
		expect(isBlockedAccountEmail("a@cap.test")).toBe(false);
	});

	it("keeps the main list when the extra list is unset", async () => {
		const { env } = await loadEnv({
			CAP_BLOCKED_SIGNUP_DOMAINS: "first.test",
			CAP_BLOCKED_SIGNUP_DOMAINS_EXTRA: undefined,
		});
		expect(env.CAP_BLOCKED_SIGNUP_DOMAINS).toBe("first.test");
	});

	it("uses the extra list alone when the main list is unset", async () => {
		const { env, isBlockedAccountEmail } = await loadEnv({
			CAP_BLOCKED_SIGNUP_DOMAINS: undefined,
			CAP_BLOCKED_SIGNUP_DOMAINS_EXTRA: "third.test",
		});
		expect(env.CAP_BLOCKED_SIGNUP_DOMAINS).toBe("third.test");
		expect(isBlockedAccountEmail("a@third.test")).toBe(true);
	});

	it("blocks nothing when both lists are unset or blank", async () => {
		const { env, isBlockedAccountEmail } = await loadEnv({
			CAP_BLOCKED_SIGNUP_DOMAINS: " ",
			CAP_BLOCKED_SIGNUP_DOMAINS_EXTRA: undefined,
		});
		expect(env.CAP_BLOCKED_SIGNUP_DOMAINS).toBeUndefined();
		expect(isBlockedAccountEmail("a@cap.test")).toBe(false);
	});
});
