import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

// Google applies the longest robots.txt rule whose path is a prefix of the
// URL's, and the less restrictive one when an allow and a disallow tie.
async function blockedByRobots() {
	const { rules } = await robots();
	const groups = Array.isArray(rules) ? rules : [rules];
	const longest = (paths: string[], path: string) =>
		Math.max(
			-1,
			...paths
				.filter((rule) => path.startsWith(rule))
				.map((rule) => rule.length),
		);
	const allow = groups.flatMap((group) => group.allow ?? []);
	const disallow = groups.flatMap((group) => group.disallow ?? []);
	return (path: string) => longest(disallow, path) > longest(allow, path);
}

async function sitemapPaths() {
	return (await sitemap()).map(({ url }) => new URL(url).pathname);
}

describe("sitemap", () => {
	it("lists only pages robots.txt lets crawlers fetch", async () => {
		const isBlocked = await blockedByRobots();
		expect((await sitemapPaths()).filter(isBlocked)).toEqual([]);
	});

	it("leaves out admin, sign-in and redirect-only routes", async () => {
		const paths = await sitemapPaths();
		for (const path of [
			"/admin",
			"/admin/rebuild-manifests",
			"/admin/replace-video",
			"/admin/reprocess-video",
			"/admin/retry-recordings",
			"/c",
			"/s",
			"/embed",
			"/login",
			"/onboarding",
			"/verify-otp",
			"/docs/s3-config",
		]) {
			expect(paths).not.toContain(path);
		}
	});

	it("keeps the public pages", async () => {
		expect(await sitemapPaths()).toEqual(
			expect.arrayContaining([
				"/",
				"/pricing",
				"/record-screen",
				"/screen-recorder",
				"/signup",
				"/messenger",
				"/blog/record-screen-mac-system-audio",
				"/docs/s3-config/aws-s3",
				"/changelog",
			]),
		);
	});
});
