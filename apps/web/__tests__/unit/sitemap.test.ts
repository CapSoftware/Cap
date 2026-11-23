import { describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";

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
		]) {
			expect(urls).toContain(`https://cap.so${routePath}`);
		}
	});

	it("lists each URL once", async () => {
		const urls = (await sitemap()).map((entry) => entry.url);

		expect(new Set(urls).size).toBe(urls.length);
	});
});
