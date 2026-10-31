import { Organisation } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const orgId = Organisation.OrganisationId.make("org-1");

const env = vi.hoisted(() => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" as string | undefined },
	NODE_ENV: "production",
}));

const query = vi.hoisted(() => ({
	rows: [] as unknown[],
	error: undefined as Error | undefined,
	where: vi.fn(),
}));

vi.mock("@cap/env", () => env);

vi.mock("@cap/database/schema", () => ({
	organizations: {
		id: "organizations.id",
		customDomain: "organizations.customDomain",
		domainVerified: "organizations.domainVerified",
	},
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: (condition: unknown) => {
					query.where(condition);
					return {
						limit: async () => {
							if (query.error) throw query.error;
							return query.rows;
						},
					};
				},
			}),
		}),
	}),
}));

const { getDesktopShareUrl } = await import("@/lib/desktop-share-url");

describe("getDesktopShareUrl", () => {
	beforeEach(() => {
		env.buildEnv.NEXT_PUBLIC_IS_CAP = "true";
		env.NODE_ENV = "production";
		query.rows = [];
		query.error = undefined;
		query.where.mockClear();
	});

	it("uses the organization's verified custom domain", async () => {
		query.rows = [
			{ customDomain: "videos.team.test", domainVerified: new Date() },
		];

		await expect(getDesktopShareUrl(orgId, "video-1")).resolves.toBe(
			"https://videos.team.test/s/video-1",
		);
		expect(query.where).toHaveBeenCalledWith({
			field: "organizations.id",
			value: "org-1",
		});
	});

	it("keeps the default link for an unverified domain", async () => {
		query.rows = [{ customDomain: "videos.team.test", domainVerified: null }];

		await expect(getDesktopShareUrl(orgId, "video-1")).resolves.toBeUndefined();
	});

	it("keeps the default link without a custom domain", async () => {
		query.rows = [{ customDomain: null, domainVerified: null }];

		await expect(getDesktopShareUrl(orgId, "video-1")).resolves.toBeUndefined();
	});

	it("keeps the default link for a missing organization", async () => {
		await expect(getDesktopShareUrl(orgId, "video-1")).resolves.toBeUndefined();
	});

	it("never uses a custom domain on a self-hosted server", async () => {
		env.buildEnv.NEXT_PUBLIC_IS_CAP = undefined;
		query.rows = [
			{ customDomain: "videos.team.test", domainVerified: new Date() },
		];

		await expect(getDesktopShareUrl(orgId, "video-1")).resolves.toBeUndefined();
		expect(query.where).not.toHaveBeenCalled();
	});

	it("never uses a custom domain outside production", async () => {
		env.NODE_ENV = "development";
		query.rows = [
			{ customDomain: "videos.team.test", domainVerified: new Date() },
		];

		await expect(getDesktopShareUrl(orgId, "video-1")).resolves.toBeUndefined();
	});

	it("keeps the default link when the lookup fails", async () => {
		query.error = new Error("database unavailable");
		vi.spyOn(console, "error").mockImplementationOnce(() => {});

		await expect(getDesktopShareUrl(orgId, "video-1")).resolves.toBeUndefined();
	});
});
