import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFAQSchema } from "@/utils/web-schema";

const pageSource = readFileSync(
	join(process.cwd(), "app/(site)/(seo)/obs-alternative/page.tsx"),
	"utf-8",
);

const componentSource = readFileSync(
	join(process.cwd(), "components/pages/seo/ObsAlternativePage.tsx"),
	"utf-8",
);

describe("ObsAlternativePage metadata", () => {
	it("contains canonical URL", () => {
		expect(pageSource).toContain('canonical: "https://cap.so/obs-alternative"');
	});

	it("contains OG url field", () => {
		expect(pageSource).toContain('url: "https://cap.so/obs-alternative"');
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

	it("title targets obs-alternative keyword", () => {
		expect(pageSource.toLowerCase()).toContain("obs alternative");
	});
});

describe("ObsAlternativePage component content", () => {
	it("targets obs-alternative keyword in title", () => {
		expect(componentSource.toLowerCase()).toContain("obs alternative");
	});

	it("includes comparison table", () => {
		expect(componentSource).toContain("comparisonTable");
	});

	it("includes recording modes section", () => {
		expect(componentSource).toContain("recordingModes");
	});

	it("includes OBS Studio as primary comparison target", () => {
		expect(componentSource).toContain("OBS");
	});

	it("includes Loom as a comparison target", () => {
		expect(componentSource).toContain("Loom");
	});

	it("includes migration guide", () => {
		expect(componentSource).toContain("migrationGuide");
	});

	it("mentions open source and MIT license", () => {
		expect(componentSource.toLowerCase()).toContain("open source");
		expect(componentSource.toLowerCase()).toContain("mit");
	});

	it("mentions instant sharing capability", () => {
		expect(componentSource.toLowerCase()).toContain("shareable link");
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

	it("references the open-source-screen-recorder internal link", () => {
		expect(componentSource).toContain("/open-source-screen-recorder");
	});

	it("has badge set", () => {
		expect(componentSource).toContain("badge");
	});
});

describe("ObsAlternativePage FAQ schema", () => {
	const faqs = [
		{
			question: "Why would I use Cap instead of OBS Studio?",
			answer:
				"OBS Studio is the best tool for live streaming, but it's complex and saves files locally. Cap is designed for async screen sharing.",
		},
		{
			question: "Is Cap free like OBS?",
			answer:
				"Yes. Cap's Studio Mode is completely free for personal use with no time limits and no watermarks.",
		},
		{
			question: "Is Cap open source like OBS?",
			answer: "Yes. Cap is fully open source and MIT-licensed on GitHub.",
		},
		{
			question: "Can Cap do live streaming like OBS?",
			answer:
				"No. Cap is built for async screen recording and sharing, not live streaming.",
		},
		{
			question: "Does Cap support the same recording quality as OBS?",
			answer:
				"Yes. Cap records at up to 4K resolution and 60 frames per second with system audio and microphone.",
		},
		{
			question: "What happens to my recordings after I stop recording in Cap?",
			answer:
				"Cap automatically uploads your recording and generates a shareable link in seconds.",
		},
		{
			question: "Does Cap work on Mac and Windows like OBS?",
			answer:
				"Yes. Cap is available as a native desktop app for macOS and Windows, just like OBS.",
		},
		{
			question: "Can I self-host Cap like I can self-host OBS outputs?",
			answer:
				"Yes. Cap supports any S3-compatible storage provider, including AWS S3, Cloudflare R2, and self-hosted MinIO.",
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
			name: "Why would I use Cap instead of OBS Studio?",
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

describe("ObsAlternativePage SEO registry", () => {
	it("is registered in seo-pages.ts", () => {
		const seoPagesSource = readFileSync(
			join(process.cwd(), "lib/seo-pages.ts"),
			"utf-8",
		);
		expect(seoPagesSource).toContain('"obs-alternative"');
	});

	it("is registered in seo-metadata.ts", () => {
		const seoMetadataSource = readFileSync(
			join(process.cwd(), "lib/seo-metadata.ts"),
			"utf-8",
		);
		expect(seoMetadataSource).toContain('"obs-alternative"');
	});
});
