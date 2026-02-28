import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFAQSchema } from "@/utils/web-schema";

const pageSource = readFileSync(
	join(process.cwd(), "app/(site)/(seo)/open-source-screen-recorder/page.tsx"),
	"utf-8",
);

const componentSource = readFileSync(
	join(process.cwd(), "components/pages/seo/OpenSourceScreenRecorderPage.tsx"),
	"utf-8",
);

describe("OpenSourceScreenRecorderPage metadata", () => {
	it("contains canonical URL", () => {
		expect(pageSource).toContain(
			'canonical: "https://cap.so/open-source-screen-recorder"',
		);
	});

	it("contains OG url field", () => {
		expect(pageSource).toContain(
			'url: "https://cap.so/open-source-screen-recorder"',
		);
	});

	it("contains OG siteName field", () => {
		expect(pageSource).toContain('siteName: "Cap"');
	});

	it("contains OG locale field", () => {
		expect(pageSource).toContain('locale: "en_US"');
	});

	it("contains full OG image URL", () => {
		expect(pageSource).toContain('"https://cap.so/og.png"');
	});

	it("title targets open-source-screen-recorder keyword", () => {
		expect(pageSource.toLowerCase()).toContain("open source screen recorder");
	});
});

describe("OpenSourceScreenRecorderPage component content", () => {
	it("targets open-source-screen-recorder keyword in title", () => {
		expect(componentSource.toLowerCase()).toContain(
			"open source screen recorder",
		);
	});

	it("includes comparison table", () => {
		expect(componentSource).toContain("comparisonTable");
	});

	it("includes recording modes section", () => {
		expect(componentSource).toContain("recordingModes");
	});

	it("includes Loom as a comparison target", () => {
		expect(componentSource).toContain("Loom");
	});

	it("includes OBS as a comparison target", () => {
		expect(componentSource).toContain("OBS");
	});

	it("mentions open source and MIT license", () => {
		expect(componentSource.toLowerCase()).toContain("open source");
		expect(componentSource.toLowerCase()).toContain("mit");
	});

	it("mentions self-hosting capability", () => {
		expect(componentSource.toLowerCase()).toContain("self-host");
	});

	it("references the loom-alternative internal link", () => {
		expect(componentSource).toContain("/loom-alternative");
	});

	it("references the screen-recorder-mac internal link", () => {
		expect(componentSource).toContain("/screen-recorder-mac");
	});

	it("references the screen-recorder-windows internal link", () => {
		expect(componentSource).toContain("/screen-recorder-windows");
	});
});

describe("OpenSourceScreenRecorderPage FAQ schema", () => {
	const faqs = [
		{
			question: "Is Cap really open source?",
			answer:
				"Yes. Cap is fully open source and MIT-licensed. The complete codebase is publicly available on GitHub.",
		},
		{
			question: "Can I self-host Cap's screen recordings?",
			answer:
				"Yes. Cap supports any S3-compatible storage provider, including AWS S3, Cloudflare R2, and self-hosted MinIO.",
		},
		{
			question: "What is the best open source screen recorder?",
			answer:
				"Cap is the best open source screen recorder for most users because it combines full transparency with practical features.",
		},
		{
			question: "Is Cap's open source version free?",
			answer:
				"Yes. Cap's Studio Mode is completely free for personal use with no time limits and no watermarks.",
		},
		{
			question:
				"How does Cap compare to OBS Studio as an open source recorder?",
			answer:
				"Both Cap and OBS Studio are open source, but OBS is built for live streaming while Cap is designed for async screen sharing.",
		},
		{
			question: "Can I contribute to Cap's development?",
			answer:
				"Absolutely. Cap welcomes contributions of all kinds — bug reports, feature requests, and code contributions.",
		},
		{
			question: "Does Cap work on Mac and Windows?",
			answer:
				"Yes. Cap is available as a native desktop app for macOS and Windows.",
		},
		{
			question: "What license does Cap use?",
			answer:
				"Cap is released under the MIT License. You are free to use, copy, modify, merge, publish, distribute, sublicense, and sell copies.",
		},
	];

	it("produces valid FAQPage schema with 8 questions", () => {
		const schema = createFAQSchema(faqs);

		expect(schema["@context"]).toBe("https://schema.org");
		expect(schema["@type"]).toBe("FAQPage");
		expect(schema.mainEntity).toHaveLength(8);
	});

	it("maps each FAQ to a Question entity with acceptedAnswer", () => {
		const schema = createFAQSchema(faqs);

		expect(schema.mainEntity[0]).toEqual({
			"@type": "Question",
			name: "Is Cap really open source?",
			acceptedAnswer: {
				"@type": "Answer",
				text: faqs[0].answer,
			},
		});
	});

	it("produces JSON-serializable output", () => {
		const schema = createFAQSchema(faqs);
		expect(() => JSON.stringify(schema)).not.toThrow();
		const parsed = JSON.parse(JSON.stringify(schema));
		expect(parsed["@type"]).toBe("FAQPage");
		expect(parsed.mainEntity).toHaveLength(8);
	});
});

describe("OpenSourceScreenRecorderPage SEO registry", () => {
	it("is registered in seo-pages.ts", () => {
		const seoPagesSource = readFileSync(
			join(process.cwd(), "lib/seo-pages.ts"),
			"utf-8",
		);
		expect(seoPagesSource).toContain('"open-source-screen-recorder"');
	});

	it("is registered in seo-metadata.ts", () => {
		const seoMetadataSource = readFileSync(
			join(process.cwd(), "lib/seo-metadata.ts"),
			"utf-8",
		);
		expect(seoMetadataSource).toContain('"open-source-screen-recorder"');
	});
});
