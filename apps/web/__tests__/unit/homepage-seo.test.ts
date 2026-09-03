import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import { homePageMetadata } from "@/components/pages/HomeTwo/metadata";
import { HomeTwoSchema } from "@/components/pages/HomeTwo/Schema";
import { homepageSchema, homepageSeo } from "@/components/pages/HomeTwo/seo";
import { PRICING } from "@/data/pricing";

describe("homepage SEO", () => {
	it("uses the public root as the crawlable canonical", async () => {
		expect(homePageMetadata.alternates?.canonical).toBe("https://cap.so/");
		expect(homePageMetadata.robots).toMatchObject({
			index: true,
			follow: true,
		});
		const policy = await robots();
		const rules = Array.isArray(policy.rules) ? policy.rules : [policy.rules];
		for (const rule of rules) {
			if (rule.userAgent !== "*") continue;
			const disallowed = Array.isArray(rule.disallow)
				? rule.disallow
				: [rule.disallow];
			expect(disallowed).not.toContain("/");
			expect(disallowed).not.toContain("/home");
		}
	});

	it("connects the website, page, software, and publisher without invented ratings", () => {
		const graph = homepageSchema["@graph"];
		const ids = new Set(graph.map((entity) => entity["@id"]));
		expect(ids.size).toBe(graph.length);
		const visit = (value: unknown) => {
			if (Array.isArray(value)) {
				value.forEach(visit);
			} else if (value && typeof value === "object") {
				if ("@id" in value) expect(ids.has(String(value["@id"]))).toBe(true);
				Object.values(value).forEach(visit);
			}
		};
		visit(graph);
		const serialized = JSON.stringify(homepageSchema);
		expect(serialized).not.toContain("aggregateRating");
		expect(serialized).not.toContain("reviewRating");
		expect(serialized).not.toContain("FAQPage");
		expect(serialized).not.toContain("priceValidUntil");
	});

	it("uses the displayed plan prices and supported desktop platforms", () => {
		const software = homepageSchema["@graph"].find(
			(entity) => entity["@type"] === "SoftwareApplication",
		);
		expect(software?.operatingSystem).toEqual(["macOS", "Windows", "Linux"]);
		expect(software?.offers).toMatchObject([
			{ name: "Cap Free", price: 0 },
			{ name: "Desktop License", price: PRICING.commercial.lifetime },
			{ name: "Cap Pro", price: PRICING.pro.monthly },
		]);
	});

	it("describes the actual logo dimensions", () => {
		const logo = homepageSchema["@graph"].find(
			(entity) => entity["@type"] === "Organization",
		)?.logo;
		const image = readFileSync(
			new URL("../../public/cap-logo.png", import.meta.url),
		);
		expect(logo).toMatchObject({
			width: image.readUInt32BE(16),
			height: image.readUInt32BE(20),
		});
	});

	it("renders valid JSON-LD with the same description as the search metadata", () => {
		const html = renderToStaticMarkup(createElement(HomeTwoSchema));
		const json = html.match(
			/<script type="application\/ld\+json">(.*?)<\/script>/,
		)?.[1];
		expect(json).toBeDefined();
		expect(JSON.parse(json ?? "")).toEqual(homepageSchema);
		expect(homePageMetadata.description).toBe(homepageSeo.description);
	});
});
