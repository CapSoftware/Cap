import type { Metadata } from "next";
import { describe, expect, it } from "vitest";
import { buildMarketingMetadata } from "@/lib/og/url";

const pages: Record<string, () => Promise<{ metadata: Metadata }>> = {
	"/download": () => import("@/app/(site)/download/page"),
	"/faq": () => import("@/app/(site)/faq/page"),
	"/privacy": () => import("@/app/(site)/privacy/page"),
	"/terms": () => import("@/app/(site)/terms/page"),
};

describe("marketing page metadata", () => {
	it("sets the description for search results and link previews", () => {
		const metadata = buildMarketingMetadata({
			title: "Pricing — Cap",
			description: "Plans for every team.",
			path: "/pricing",
		});
		expect(metadata.description).toBe("Plans for every team.");
		expect(metadata.openGraph?.description).toBe("Plans for every team.");
		expect(metadata.twitter?.description).toBe("Plans for every team.");
	});

	for (const [path, load] of Object.entries(pages)) {
		it(`gives ${path} a description of its own`, async () => {
			const { metadata } = await load();
			expect(metadata.description).toMatch(/\S/);
			expect(metadata.openGraph?.description).toBe(metadata.description);
			expect(metadata.twitter?.description).toBe(metadata.description);
		});
	}
});
