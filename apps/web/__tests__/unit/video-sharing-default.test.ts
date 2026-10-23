import { getNewVideoPublic } from "@cap/database/video-sharing-default";
import type { Organisation } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => ({
	limit: vi.fn(),
	serverDefaultPublic: true,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: lookup.limit }),
			}),
		}),
	}),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		CAP_VIDEOS_DEFAULT_PUBLIC: lookup.serverDefaultPublic,
	}),
}));

const ORGANIZATION_ID = "org-1" as Organisation.OrganisationId;

describe("new recording visibility", () => {
	beforeEach(() => {
		lookup.limit.mockReset();
		lookup.serverDefaultPublic = true;
	});

	it("keeps the current server default for organizations that have not opted in", async () => {
		lookup.limit.mockResolvedValue([
			{ defaultVideoVisibility: null, tombstoneAt: null },
		]);
		expect(await getNewVideoPublic(ORGANIZATION_ID)).toBe(true);

		lookup.serverDefaultPublic = false;
		expect(await getNewVideoPublic(ORGANIZATION_ID)).toBe(false);
	});

	it("starts recordings private after the organization opts in", async () => {
		lookup.limit.mockResolvedValue([
			{ defaultVideoVisibility: "private", tombstoneAt: null },
		]);
		expect(await getNewVideoPublic(ORGANIZATION_ID)).toBe(false);
	});

	it("rejects a missing or deleted organization", async () => {
		lookup.limit.mockResolvedValue([]);
		await expect(getNewVideoPublic(ORGANIZATION_ID)).rejects.toThrow(
			"Organization not found",
		);
	});
});
