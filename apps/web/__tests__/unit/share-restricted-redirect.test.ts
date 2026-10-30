import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	organizations: [] as { domainVerified: boolean }[],
	lookups: 0,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => {
						mocks.lookups += 1;
						return mocks.organizations;
					},
				}),
			}),
		}),
	}),
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
}));

import { resolveRestrictedShareRedirect } from "@/lib/share-web-url";

const hostHeaders = (host: string) => new Headers({ host });

describe("resolveRestrictedShareRedirect", () => {
	beforeEach(() => {
		mocks.organizations = [];
		mocks.lookups = 0;
	});

	it("keeps restricted videos on the main origin without a lookup", async () => {
		expect(
			await resolveRestrictedShareRedirect(hostHeaders("cap.so"), "abc123", {}),
		).toBeNull();
		expect(mocks.lookups).toBe(0);
	});

	it("sends a verified custom domain to the main origin share page", async () => {
		mocks.organizations = [{ domainVerified: true }];
		expect(
			await resolveRestrictedShareRedirect(
				hostHeaders("recordings.example.com"),
				"abc123",
				{},
			),
		).toBe("https://cap.so/s/abc123");
	});

	it("carries the query string across, including repeated keys", async () => {
		mocks.organizations = [{ domainVerified: true }];
		expect(
			await resolveRestrictedShareRedirect(
				hostHeaders("recordings.example.com"),
				"abc123",
				{ t: "42", comment: ["a", "b"], view: undefined },
			),
		).toBe("https://cap.so/s/abc123?t=42&comment=a&comment=b");
	});

	it("encodes the video id into a single path segment", async () => {
		mocks.organizations = [{ domainVerified: true }];
		expect(
			await resolveRestrictedShareRedirect(
				hostHeaders("recordings.example.com"),
				"../dashboard?x=1",
				{},
			),
		).toBe("https://cap.so/s/..%2Fdashboard%3Fx%3D1");
	});

	it.each([
		["an unknown host", []],
		["an unverified domain", [{ domainVerified: false }]],
	])("does not redirect %s", async (_label, organizations) => {
		mocks.organizations = organizations;
		expect(
			await resolveRestrictedShareRedirect(
				hostHeaders("recordings.example.com"),
				"abc123",
				{},
			),
		).toBeNull();
	});
});
