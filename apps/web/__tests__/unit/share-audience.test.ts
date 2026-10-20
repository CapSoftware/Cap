import { describe, expect, it } from "vitest";
import { describeShareAudience } from "@/app/s/[videoId]/_components/share-audience";

describe("describeShareAudience", () => {
	it("names the public link as the widest audience, even when spaces are attached", () => {
		const audience = describeShareAudience({
			isPublic: true,
			passwordProtected: false,
			audienceNames: ["Design"],
		});

		expect(audience.kind).toBe("public");
		expect(audience.label).toBe("Anyone with the link");
		expect(audience.tooltip).toContain("outside your organization");
	});

	it("identifies domain restricted link sharing separately from a private recording", () => {
		const audience = describeShareAudience({
			isPublic: true,
			allowedEmailDomain: "route.com",
			passwordProtected: false,
			audienceNames: [],
		});

		expect(audience.label).toBe("Restricted link access");
		expect(audience.tooltip).toContain("route.com or invited viewers");
	});

	it("says a password is required when the public link is locked", () => {
		const audience = describeShareAudience({
			isPublic: true,
			passwordProtected: true,
			audienceNames: [],
		});

		expect(audience.label).toBe("Anyone with the password");
	});

	it("names a single space", () => {
		const audience = describeShareAudience({
			isPublic: false,
			passwordProtected: false,
			audienceNames: ["Design"],
		});

		expect(audience.kind).toBe("spaces");
		expect(audience.label).toBe("Shared with Design");
		expect(audience.tooltip).toContain("Only members of Design");
	});

	it("names both when there are two", () => {
		const audience = describeShareAudience({
			isPublic: false,
			passwordProtected: false,
			audienceNames: ["Design", "Marketing"],
		});

		expect(audience.label).toBe("Shared with Design and Marketing");
	});

	it("counts the rest past two, without claiming they are all spaces", () => {
		const audience = describeShareAudience({
			isPublic: false,
			passwordProtected: false,
			audienceNames: ["Acme Inc", "Design", "Marketing", "Support"],
		});

		expect(audience.label).toBe("Shared with Acme Inc and 3 others");
		expect(audience.tooltip).toContain("Design and 2 more");
	});

	it("uses the singular for exactly one other", () => {
		const audience = describeShareAudience({
			isPublic: false,
			passwordProtected: false,
			audienceNames: ["Design", null],
		});

		expect(audience.label).toBe("Shared with Design and 1 other");
	});

	it("still counts entries whose name never arrived", () => {
		const audience = describeShareAudience({
			isPublic: false,
			passwordProtected: false,
			audienceNames: ["Design", null, undefined],
		});

		expect(audience.label).toBe("Shared with Design and 2 others");
	});

	it("falls back to a count when no name came through", () => {
		const audience = describeShareAudience({
			isPublic: false,
			passwordProtected: false,
			audienceNames: [null, ""],
		});

		expect(audience.label).toBe("Shared with 2 spaces");
		expect(audience.tooltip).toContain("the spaces this is shared with");
	});

	it("says nobody can see it when it is shared nowhere", () => {
		const audience = describeShareAudience({
			isPublic: false,
			passwordProtected: false,
			audienceNames: [],
		});

		expect(audience.kind).toBe("private");
		expect(audience.label).toBe("Only you");
		expect(audience.tooltip).toContain("Click to share it");
	});

	it("shows invited viewers on a private recording", () => {
		const audience = describeShareAudience({
			isPublic: false,
			passwordProtected: false,
			audienceNames: [],
			viewerCount: 2,
		});

		expect(audience.kind).toBe("people");
		expect(audience.label).toBe("Shared with 2 people");
		expect(audience.tooltip).toContain("invited email address");
	});

	it("includes invited viewers alongside a shared space", () => {
		const audience = describeShareAudience({
			isPublic: false,
			passwordProtected: false,
			audienceNames: ["Design"],
			viewerCount: 1,
		});

		expect(audience.label).toBe("Shared with spaces and 1 person");
		expect(audience.tooltip).toContain(
			"members of Design and 1 invited person",
		);
	});
});
