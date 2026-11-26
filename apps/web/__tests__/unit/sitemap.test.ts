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

const nonIndexablePaths = [
	"/admin",
	"/admin/rebuild-manifests",
	"/admin/replace-video",
	"/admin/reprocess-video",
	"/admin/retry-recordings",
	"/c",
	"/s",
	"/embed",
	"/messenger",
	"/login",
	"/signup",
	"/verify-otp",
	"/onboarding",
	"/checkout",
	"/checkout/complete",
	"/download/started",
	"/redeem",
	"/cli/authorize",
	"/cli/complete",
	"/mcp/authorize",
	"/docs/introduction",
	"/home",
];

describe("sitemap", () => {
	it("lists only pages robots.txt lets crawlers fetch", async () => {
		const isBlocked = await blockedByRobots();
		const paths = (await sitemap()).map(({ url }) => new URL(url).pathname);

		expect(paths.filter(isBlocked)).toEqual([]);
	});

	it("lists only indexable pages", async () => {
		const urls = (await sitemap()).map((entry) => entry.url);

		for (const routePath of nonIndexablePaths) {
			expect(urls).not.toContain(`https://cap.so${routePath}`);
		}
	});

	it("keeps public content pages", async () => {
		const urls = (await sitemap()).map((entry) => entry.url);

		for (const routePath of [
			"/",
			"/docs",
			"/download",
			"/pricing",
			"/docs/s3-config",
			"/docs/s3-config/aws-s3",
			"/record-screen",
			"/screen-recorder",
			"/changelog",
			"/blog/record-screen-mac-system-audio",
		]) {
			expect(urls).toContain(`https://cap.so${routePath}`);
		}
	});

	it("lists each URL once", async () => {
		const urls = (await sitemap()).map((entry) => entry.url);

		expect(new Set(urls).size).toBe(urls.length);
	});
});
