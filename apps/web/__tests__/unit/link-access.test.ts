import { describe, expect, it } from "vitest";
import {
	describeLinkAccessChoice,
	isLinkRestricted,
	resolveLinkAccessWrite,
} from "@/lib/link-access";

describe("resolveLinkAccessWrite", () => {
	it.each([
		[true, "anyone", "anyone"],
		[undefined, "anyone", "anyone"],
		[true, "restricted", null],
		[undefined, "restricted", null],
		[false, "anyone", null],
		[false, undefined, null],
		[true, undefined, undefined],
		[undefined, undefined, undefined],
	] as const)(
		"public %j with %j writes %j",
		(isPublic, linkAccess, expected) => {
			expect(resolveLinkAccessWrite(isPublic, linkAccess)).toBe(expected);
		},
	);
});

describe("describeLinkAccessChoice", () => {
	const base = {
		isPublic: true,
		allowedEmailDomain: "company.com",
		videoSettings: { linkAccess: "anyone" },
		organizationSettings: { allowPublicLinkOverride: true },
	};

	it("reports the current choice when one exists", () => {
		expect(describeLinkAccessChoice(base)).toBe("anyone");
		expect(describeLinkAccessChoice({ ...base, videoSettings: null })).toBe(
			"restricted",
		);
	});

	it.each([
		{ isPublic: false },
		{ allowedEmailDomain: null },
		{ allowedEmailDomain: "  " },
		{ organizationSettings: null },
		{ organizationSettings: { allowPublicLinkOverride: false } },
	])("offers no choice for %j", (override) => {
		expect(describeLinkAccessChoice({ ...base, ...override })).toBeUndefined();
	});
});

describe("isLinkRestricted", () => {
	const base = {
		isPublic: true,
		allowedEmailDomain: "company.com" as string | null,
		videoSettings: null as { linkAccess?: string } | null,
		organizationSettings: null as { allowPublicLinkOverride?: boolean } | null,
	};

	it.each([
		[{}, true],
		[{ organizationSettings: { allowPublicLinkOverride: true } }, true],
		[{ videoSettings: { linkAccess: "anyone" } }, true],
		[
			{
				videoSettings: { linkAccess: "anyone" },
				organizationSettings: { allowPublicLinkOverride: true },
			},
			false,
		],
		[{ allowedEmailDomain: null }, false],
		[{ allowedEmailDomain: " " }, false],
		[{ isPublic: false }, false],
	])("%j is restricted: %j", (override, expected) => {
		expect(isLinkRestricted({ ...base, ...override })).toBe(expected);
	});
});
