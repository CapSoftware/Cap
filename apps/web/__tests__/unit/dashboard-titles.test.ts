import { describe, expect, it } from "vitest";
import { dashboardTitle } from "@/app/(org)/dashboard/_components/dashboard-titles";

const labels = (pathname: string | null) =>
	dashboardTitle(pathname).map((crumb) => crumb.label);

describe("dashboard top bar titles", () => {
	it("uses the sidebar wording for top-level pages", () => {
		expect(labels("/dashboard/caps")).toEqual(["My Caps"]);
		expect(labels("/dashboard/caps/record")).toEqual(["Record a Cap"]);
		expect(labels("/dashboard/analytics")).toEqual(["Analytics"]);
		expect(labels("/dashboard/import")).toEqual(["Import Media"]);
		expect(labels("/dashboard/admin/loom-migrations")).toEqual([
			"Migration Queue",
		]);
	});

	it("names browse spaces the same as the space breadcrumb parent", () => {
		expect(labels("/dashboard/spaces/browse")).toEqual(["Spaces"]);
	});

	it("shows a linked parent for import sub-pages", () => {
		expect(dashboardTitle("/dashboard/import/loom")).toEqual([
			{ label: "Import Media", href: "/dashboard/import" },
			{ label: "Loom" },
		]);
		expect(labels("/dashboard/import/file")).toEqual([
			"Import Media",
			"Upload a file",
		]);
	});

	it("covers every organization settings tab and ignores a trailing slash", () => {
		for (const tab of [
			"",
			"/preferences",
			"/content",
			"/billing",
			"/members",
			"/integrations",
			"/security",
		]) {
			expect(labels(`/dashboard/settings/organization${tab}`)).toEqual([
				"Organization Settings",
			]);
		}
		expect(labels("/dashboard/caps/")).toEqual(["My Caps"]);
	});

	it("falls back to My Caps on folder pages until the folder path mounts", () => {
		expect(labels("/dashboard/folder/abc123")).toEqual(["My Caps"]);
	});

	it("returns nothing for unknown routes", () => {
		expect(labels("/dashboard/unknown")).toEqual([]);
		expect(labels(null)).toEqual([]);
	});
});
