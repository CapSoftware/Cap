import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seoMetadata } from "@/lib/seo-metadata";

const seoPagesSource = readFileSync(
	join(process.cwd(), "lib/seo-pages.ts"),
	"utf-8",
);

const expectedSolutionSlugs = [
	"solutions/agencies",
	"solutions/daily-standup-software",
	"solutions/employee-onboarding-platform",
	"solutions/online-classroom-tools",
	"solutions/remote-team-collaboration",
];

describe("SEO registry completeness", () => {
	it("loom-alternative has metadata entry", () => {
		expect(seoMetadata).toHaveProperty("loom-alternative");
	});

	for (const slug of expectedSolutionSlugs) {
		it(`"${slug}" is registered in seo-pages.ts`, () => {
			expect(seoPagesSource).toContain(`"${slug}"`);
		});

		it(`"${slug}" has metadata in seo-metadata.ts`, () => {
			expect(seoMetadata).toHaveProperty(slug);
		});
	}

	it("every slug in seo-pages.ts has a corresponding seo-metadata.ts entry", () => {
		const slugMatches = seoPagesSource.match(/^\s+"([a-z][a-z0-9/-]*)": \{/gm);
		if (!slugMatches) return;

		const registeredSlugs = slugMatches.map((line) =>
			line
				.trim()
				.replace(/^"/, "")
				.replace(/": \{$/, ""),
		);

		for (const slug of registeredSlugs) {
			expect(
				seoMetadata,
				`Slug "${slug}" is in seo-pages.ts but missing from seo-metadata.ts`,
			).toHaveProperty(slug);
		}
	});
});
