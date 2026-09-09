import { describe, expect, it } from "vitest";
import {
	loomImportDestinationFromPathname,
	loomImportDestinationFromSearchParams,
	loomImportDestinationHref,
	loomImportPageHref,
} from "@/lib/loom-import-destination";

describe("Loom import navigation", () => {
	it.each([
		["/dashboard/caps", "/dashboard/import", "/dashboard/caps"],
		[
			"/dashboard/folder/nested-folder",
			"/dashboard/import?folderId=nested-folder",
			"/dashboard/folder/nested-folder",
		],
		[
			"/dashboard/spaces/team-space/folder/nested-folder",
			"/dashboard/import?folderId=nested-folder&spaceId=team-space",
			"/dashboard/spaces/team-space/folder/nested-folder",
		],
		[
			"/dashboard/spaces/team-space",
			"/dashboard/import?spaceId=team-space",
			"/dashboard/spaces/team-space",
		],
		[
			"/dashboard/spaces/org-id/folder/nested-folder",
			"/dashboard/import?folderId=nested-folder&spaceId=org-id",
			"/dashboard/spaces/org-id/folder/nested-folder",
		],
		["/dashboard/spaces/browse", "/dashboard/import", "/dashboard/caps"],
	])(
		"preserves the destination from %s through the import hub and back",
		(pathname, importHref, returnHref) => {
			const destination = loomImportDestinationFromPathname(pathname);
			expect(loomImportPageHref(destination)).toBe(importHref);
			const hubParams = Object.fromEntries(
				new URL(importHref, "https://cap.test").searchParams,
			);
			const hubDestination = loomImportDestinationFromSearchParams(hubParams);
			const loomHref = loomImportPageHref(hubDestination, "loom");
			expect(loomHref).toBe(importHref.replace("/import", "/import/loom"));
			const loomDestination = loomImportDestinationFromSearchParams(
				Object.fromEntries(new URL(loomHref, "https://cap.test").searchParams),
			);
			expect(loomImportDestinationHref(loomDestination)).toBe(returnHref);
		},
	);

	it("keeps encoded identifiers inside their path segment", () => {
		const destination = loomImportDestinationFromPathname(
			"/dashboard/folder/a%2Fb%3Fc",
		);
		expect(loomImportPageHref(destination, "loom")).toBe(
			"/dashboard/import/loom?folderId=a%2Fb%3Fc",
		);
		expect(loomImportDestinationHref(destination)).toBe(
			"/dashboard/folder/a%2Fb%3Fc",
		);
	});

	it("does not break navigation on malformed URI escapes", () => {
		expect(() =>
			loomImportDestinationFromPathname("/dashboard/folder/bad%escape"),
		).not.toThrow();
	});
});
