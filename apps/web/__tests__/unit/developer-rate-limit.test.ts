import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const database = drizzle(mocks.query);
	return { db: () => database };
});
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	serverEnv: () => ({ NEXTAUTH_SECRET: "test-secret" }),
}));

import {
	developerRateLimiter,
	withDeveloperPublicAuth,
	withDeveloperSecretAuth,
} from "@/app/api/utils";

const app = new Hono()
	.use(developerRateLimiter)
	.get("/public", withDeveloperPublicAuth, (c) => c.json({ success: true }))
	.get("/secret", withDeveloperSecretAuth, (c) => c.json({ success: true }));

function request(path: string, authorization: string) {
	return app.request(path, { headers: { authorization } });
}

let testId = 0;

beforeEach(() => {
	testId++;
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
	mocks.query.mockResolvedValue({ rows: [["app-1", "development"]] });
});

afterEach(() => {
	vi.useRealTimers();
});

describe.each([
	{ path: "/public", prefix: "cpk_" },
	{ path: "/secret", prefix: "csk_" },
])("developer rate limit for $prefix keys", ({ path, prefix }) => {
	it("counts header variants of the same authenticated key together", async () => {
		const key = `${prefix}test-${testId}`;
		for (let i = 0; i < 60; i++) {
			const response = await request(path, `Bearer ${key} suffix-${i}`);
			expect(response.status).toBe(200);
		}

		for (const header of [`Bearer ${key}`, `bearer ${key}`, `BEARER ${key}`]) {
			const response = await request(path, header);
			expect(response.status).toBe(429);
			expect(response.headers.get("Retry-After")).toBe("60");
			await expect(response.json()).resolves.toMatchObject({
				error: "Rate limit exceeded",
			});
		}
	});

	it("keeps keys separate and allows requests after the window expires", async () => {
		const key = `${prefix}test-${testId}`;
		for (let i = 0; i < 60; i++) {
			expect((await request(path, `Bearer ${key}`)).status).toBe(200);
		}
		expect((await request(path, `Bearer ${key}`)).status).toBe(429);
		expect((await request(path, `Bearer ${key}-other`)).status).toBe(200);

		vi.advanceTimersByTime(60_001);
		expect((await request(path, `Bearer ${key}`)).status).toBe(200);
	});
});
