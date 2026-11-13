import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("client events without analytics configured", () => {
	let analytics: typeof import("@/lib/server-analytics");

	beforeAll(async () => {
		Object.assign(process.env, {
			NEXT_PUBLIC_WEB_URL: "http://localhost",
			WEB_URL: "http://localhost",
			DATABASE_URL: "mysql://unused:unused@127.0.0.1:3306/unused",
			NEXTAUTH_SECRET: "synthetic-test-secret-that-is-long-enough",
			NEXTAUTH_URL: "http://localhost",
			CAP_AWS_BUCKET: "synthetic",
			CAP_AWS_REGION: "us-east-1",
			CAP_AWS_ACCESS_KEY: "synthetic",
			CAP_AWS_SECRET_KEY: "synthetic",
			NODE_ENV: "test",
		});
		delete process.env.NEXT_PUBLIC_OPENPANEL_CLIENT_ID;
		delete process.env.NEXT_PUBLIC_OPENPANEL_API_URL;
		delete process.env.OPENPANEL_CLIENT_SECRET;
		analytics = await import("@/lib/server-analytics");
	});

	it("sends nothing and says so", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		try {
			expect(analytics.acceptsClientEvents()).toBe(false);
			expect(
				await analytics.sendClientEvents({
					profileId: "user_1",
					userAgent: "Cap-iOS/1.0.4",
					ip: "203.0.113.7",
					events: [
						{ name: "app_opened", timestamp: new Date(), properties: {} },
					],
				}),
			).toBeNull();
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
