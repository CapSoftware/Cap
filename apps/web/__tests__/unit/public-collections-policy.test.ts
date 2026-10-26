import { describe, expect, it } from "vitest";
import {
	getPublicCollectionHref,
	getPublicCollectionLoginHref,
	parsePublicCollectionPage,
	resolvePublicCollectionAccess,
	resolvePublicCollectionCandidate,
} from "@/lib/public-collections-policy";

describe("public collections policy", () => {
	it("parses invalid collection pages as the first page", () => {
		expect(parsePublicCollectionPage(undefined)).toBe(1);
		expect(parsePublicCollectionPage("0")).toBe(1);
		expect(parsePublicCollectionPage("-2")).toBe(1);
		expect(parsePublicCollectionPage("1.5")).toBe(1);
		expect(parsePublicCollectionPage(["3", "4"])).toBe(3);
	});

	it("builds canonical collection page hrefs", () => {
		expect(getPublicCollectionHref("abc123", 1)).toBe("/c/abc123");
		expect(getPublicCollectionHref("abc123", 2)).toBe("/c/abc123?page=2");
	});

	it("keeps the original collection URL after sign-in", () => {
		expect(getPublicCollectionLoginHref("abc123", 1)).toBe(
			"/login?next=%2Fc%2Fabc123",
		);
		expect(getPublicCollectionLoginHref("abc123", 3)).toBe(
			"/login?next=%2Fc%2Fabc123%3Fpage%3D3",
		);
	});

	it("encodes the continuation as a single internal query value", () => {
		const url = new URL(
			getPublicCollectionLoginHref("abc123", 17),
			"https://cap.so",
		);
		expect(url.pathname).toBe("/login");
		expect(url.searchParams.getAll("next")).toEqual(["/c/abc123?page=17"]);
	});

	it("resolves public folder before public space on id collisions", () => {
		const folder = {
			kind: "folder" as const,
			public: true,
			organizationTombstoneAt: null,
			name: "Folder",
		};
		const space = {
			kind: "space" as const,
			public: true,
			organizationTombstoneAt: null,
			name: "Space",
		};

		expect(resolvePublicCollectionCandidate(folder, space)).toBe(folder);
	});

	it("falls through private or tombstoned folders to public spaces", () => {
		const privateFolder = {
			kind: "folder" as const,
			public: false,
			organizationTombstoneAt: null,
		};
		const tombstonedFolder = {
			kind: "folder" as const,
			public: true,
			organizationTombstoneAt: new Date("2026-01-01T00:00:00.000Z"),
		};
		const space = {
			kind: "space" as const,
			public: true,
			organizationTombstoneAt: null,
		};

		expect(resolvePublicCollectionCandidate(privateFolder, space)).toBe(space);
		expect(resolvePublicCollectionCandidate(tombstonedFolder, space)).toBe(
			space,
		);
	});

	it("blocks tombstoned spaces", () => {
		const space = {
			kind: "space" as const,
			public: true,
			organizationTombstoneAt: new Date("2026-01-01T00:00:00.000Z"),
		};

		expect(resolvePublicCollectionCandidate(null, space)).toBeNull();
	});

	it("applies email restrictions before password checks", () => {
		expect(
			resolvePublicCollectionAccess({
				allowedEmailDomain: "company.com",
				viewerEmail: null,
				passwordHash: "hash",
				verifiedPasswordHashes: [],
			}),
		).toEqual({ state: "email_restriction_login_required" });

		expect(
			resolvePublicCollectionAccess({
				allowedEmailDomain: "company.com",
				viewerEmail: "person@example.com",
				passwordHash: "hash",
				verifiedPasswordHashes: [],
			}),
		).toEqual({ state: "email_restriction_denied" });
	});

	it("requires the collection password when present", () => {
		expect(
			resolvePublicCollectionAccess({
				viewerEmail: "person@company.com",
				passwordHash: "space-hash",
				verifiedPasswordHashes: [],
			}),
		).toEqual({ state: "password_required" });

		expect(
			resolvePublicCollectionAccess({
				viewerEmail: "person@company.com",
				passwordHash: "space-hash",
				verifiedPasswordHashes: ["space-hash"],
			}),
		).toEqual({ state: "allowed" });
	});

	it("matches the collection password against any verified hash", () => {
		expect(
			resolvePublicCollectionAccess({
				viewerEmail: "person@company.com",
				passwordHash: "space-hash",
				verifiedPasswordHashes: ["video-hash", "space-hash"],
			}),
		).toEqual({ state: "allowed" });

		expect(
			resolvePublicCollectionAccess({
				viewerEmail: "person@company.com",
				passwordHash: "space-hash",
				verifiedPasswordHashes: ["video-hash"],
			}),
		).toEqual({ state: "password_required" });
	});
});
