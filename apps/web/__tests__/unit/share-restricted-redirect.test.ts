import { type SQL, sql } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	organizations: [] as { id?: string; domainVerified: boolean }[],
	videos: [] as { belongsToDomain: boolean }[],
	videoQueries: [] as { belongsToDomain: SQL; where: SQL }[],
	lookups: 0,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: (selection: Record<string, SQL>) => ({
			from: () => ({
				where: (where: SQL) => ({
					limit: async () => {
						mocks.lookups += 1;
						if (!("belongsToDomain" in selection)) return mocks.organizations;
						mocks.videoQueries.push({
							belongsToDomain: selection.belongsToDomain,
							where,
						});
						return mocks.videos;
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
vi.mock("@/lib/cap-analytics-access", () => ({
	videoBelongsToOrganization: (organizationId: string) =>
		sql`video_belongs_to(${organizationId})`,
}));

import type { Video } from "@cap/web-domain";
import {
	resolveForeignShareRedirect,
	resolveRestrictedShareRedirect,
} from "@/lib/share-web-url";

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

describe("resolveForeignShareRedirect", () => {
	const videoId = "abc123" as Video.VideoId;
	const params = (query: SQL) => new MySqlDialect().sqlToQuery(query).params;

	beforeEach(() => {
		mocks.organizations = [{ id: "domain-org", domainVerified: true }];
		mocks.videos = [];
		mocks.videoQueries = [];
		mocks.lookups = 0;
	});

	it("serves every video on the main origin without a lookup", async () => {
		expect(
			await resolveForeignShareRedirect(hostHeaders("cap.so"), videoId, {}),
		).toBeNull();
		expect(mocks.lookups).toBe(0);
	});

	it("keeps the domain organization's videos on its custom domain", async () => {
		mocks.videos = [{ belongsToDomain: true }];
		expect(
			await resolveForeignShareRedirect(
				hostHeaders("recordings.example.com"),
				videoId,
				{},
			),
		).toBeNull();
		expect(
			mocks.videoQueries.map((query) => ({
				belongsToDomain: params(query.belongsToDomain),
				where: params(query.where),
			})),
		).toEqual([{ belongsToDomain: ["domain-org"], where: [videoId] }]);
	});

	it("sends another organization's video to the main origin share page", async () => {
		mocks.videos = [{ belongsToDomain: false }];
		expect(
			await resolveForeignShareRedirect(
				hostHeaders("recordings.example.com"),
				videoId,
				{ t: "42", comment: ["a", "b"] },
			),
		).toBe("https://cap.so/s/abc123?t=42&comment=a&comment=b");
	});

	it("leaves a video that does not exist yet on the custom domain", async () => {
		expect(
			await resolveForeignShareRedirect(
				hostHeaders("recordings.example.com"),
				videoId,
				{},
			),
		).toBeNull();
	});

	it.each([
		["an unknown host", []],
		["an unverified domain", [{ id: "domain-org", domainVerified: false }]],
	])("does not check videos on %s", async (_label, organizations) => {
		mocks.organizations = organizations;
		mocks.videos = [{ belongsToDomain: false }];
		expect(
			await resolveForeignShareRedirect(
				hostHeaders("recordings.example.com"),
				videoId,
				{},
			),
		).toBeNull();
		expect(mocks.videoQueries).toHaveLength(0);
	});
});
