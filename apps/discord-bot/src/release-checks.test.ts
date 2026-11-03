import { describe, expect, it } from "vitest";
import {
	canManageGuild,
	isGuildInvocation,
	matchesRepositoryClaims,
} from "./release-checks";

const GUILD_ID = "1100000000000000000";
const USER_ID = "1200000000000000000";

describe("isGuildInvocation", () => {
	it("accepts a guild install invocation", () => {
		expect(
			isGuildInvocation({
				guild_id: GUILD_ID,
				member: { permissions: "8" },
				authorizing_integration_owners: { "0": GUILD_ID },
			}),
		).toBe(true);
	});

	it("accepts a guild invocation without integration owners", () => {
		expect(
			isGuildInvocation({ guild_id: GUILD_ID, member: { permissions: "8" } }),
		).toBe(true);
	});

	it("accepts a guild invocation authorized by both install types", () => {
		expect(
			isGuildInvocation({
				guild_id: GUILD_ID,
				member: { permissions: "8" },
				authorizing_integration_owners: { "0": GUILD_ID, "1": USER_ID },
			}),
		).toBe(true);
	});

	it("rejects a DM invocation", () => {
		expect(
			isGuildInvocation({
				authorizing_integration_owners: { "1": USER_ID },
			}),
		).toBe(false);
	});

	it("rejects a bot DM invocation", () => {
		expect(
			isGuildInvocation({ authorizing_integration_owners: { "0": "0" } }),
		).toBe(false);
	});

	it("rejects a user install invocation inside a guild", () => {
		expect(
			isGuildInvocation({
				guild_id: GUILD_ID,
				member: { permissions: "8" },
				authorizing_integration_owners: { "1": USER_ID },
			}),
		).toBe(false);
	});

	it("rejects a guild invocation without member data", () => {
		expect(isGuildInvocation({ guild_id: GUILD_ID })).toBe(false);
	});
});

describe("canManageGuild", () => {
	it("accepts ADMINISTRATOR", () => {
		expect(canManageGuild("8")).toBe(true);
	});

	it("accepts MANAGE_GUILD", () => {
		expect(canManageGuild("32")).toBe(true);
	});

	it("reads bits above 2^53 without losing precision", () => {
		expect(canManageGuild(((1n << 53n) | (1n << 5n)).toString())).toBe(true);
		expect(canManageGuild(((1n << 53n) | 1n).toString())).toBe(false);
	});

	it("rejects members without either permission", () => {
		expect(canManageGuild("0")).toBe(false);
		expect(canManageGuild(((1n << 31n) | 0b111n).toString())).toBe(false);
	});

	it("rejects missing or malformed values", () => {
		expect(canManageGuild(undefined)).toBe(false);
		expect(canManageGuild("")).toBe(false);
		expect(canManageGuild("-8")).toBe(false);
		expect(canManageGuild("0x8")).toBe(false);
		expect(canManageGuild(8)).toBe(false);
	});
});

describe("matchesRepositoryClaims", () => {
	it("accepts the exact repository and owner", () => {
		expect(
			matchesRepositoryClaims(
				{ repository: "CapSoftware/Cap", repository_owner: "CapSoftware" },
				"CapSoftware",
				"Cap",
			),
		).toBe(true);
	});

	it("rejects repositories that only contain the name", () => {
		for (const repository of [
			"CapSoftware/Cap-fork",
			"someone/CapSoftware/Cap",
			"CapSoftware/Caps",
		]) {
			expect(
				matchesRepositoryClaims(
					{ repository, repository_owner: "CapSoftware" },
					"CapSoftware",
					"Cap",
				),
			).toBe(false);
		}
	});

	it("rejects a different owner", () => {
		expect(
			matchesRepositoryClaims(
				{ repository: "CapSoftware/Cap", repository_owner: "someone" },
				"CapSoftware",
				"Cap",
			),
		).toBe(false);
	});

	it("rejects missing claims", () => {
		expect(matchesRepositoryClaims({}, "CapSoftware", "Cap")).toBe(false);
		expect(
			matchesRepositoryClaims(
				{ repository: "CapSoftware/Cap" },
				"CapSoftware",
				"Cap",
			),
		).toBe(false);
	});
});
