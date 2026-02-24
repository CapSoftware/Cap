import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFAQSchema } from "@/utils/web-schema";

const pageSource = readFileSync(
	join(process.cwd(), "app/(site)/(seo)/video-recording-software/page.tsx"),
	"utf-8",
);

const componentSource = readFileSync(
	join(process.cwd(), "components/pages/seo/VideoRecordingSoftwarePage.tsx"),
	"utf-8",
);

describe("VideoRecordingSoftwarePage metadata", () => {
	it("contains canonical URL", () => {
		expect(pageSource).toContain(
			'canonical: "https://cap.so/video-recording-software"',
		);
	});

	it("contains OG url field", () => {
		expect(pageSource).toContain(
			'url: "https://cap.so/video-recording-software"',
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

	it("title targets video-recording-software keyword", () => {
		expect(pageSource.toLowerCase()).toContain("video recording software");
	});
});

describe("VideoRecordingSoftwarePage component content", () => {
	it("targets video-recording-software keyword in title", () => {
		expect(componentSource.toLowerCase()).toContain("video recording software");
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

	it("includes Camtasia as a comparison target", () => {
		expect(componentSource).toContain("Camtasia");
	});

	it("includes OBS as a comparison target", () => {
		expect(componentSource).toContain("OBS");
	});

	it("references the free-screen-recorder internal link", () => {
		expect(componentSource).toContain("/free-screen-recorder");
	});

	it("references the screen-recorder-mac internal link", () => {
		expect(componentSource).toContain("/screen-recorder-mac");
	});

	it("references the screen-recorder-windows internal link", () => {
		expect(componentSource).toContain("/screen-recorder-windows");
	});

	it("references the loom-alternative internal link", () => {
		expect(componentSource).toContain("/loom-alternative");
	});

	it("references the open-source-screen-recorder internal link", () => {
		expect(componentSource).toContain("/open-source-screen-recorder");
	});
});

describe("VideoRecordingSoftwarePage FAQ schema", () => {
	const faqs = [
		{
			question: "What is video recording software?",
			answer:
				"Video recording software captures the visual and audio output from your computer as a video file.",
		},
		{
			question: "What is the best free video recording software?",
			answer:
				"Cap is the best free video recording software for most users. Studio Mode is 100% free for personal use.",
		},
		{
			question: "Is Cap video recording software free?",
			answer:
				"Yes. Cap's Studio Mode is completely free for personal use with no time limits, no watermarks, and no hidden fees.",
		},
		{
			question: "Does Cap video recording software work on Mac and Windows?",
			answer:
				"Yes. Cap is available as a native desktop app for both macOS and Windows.",
		},
		{
			question: "Can video recording software capture system audio?",
			answer:
				"Yes. Cap captures both system audio and microphone input simultaneously in every recording.",
		},
		{
			question: "What video recording software has no watermark?",
			answer: "Cap has no watermark on any recording, including the free plan.",
		},
		{
			question: "Can I self-host my video recordings with Cap?",
			answer:
				"Yes. Cap supports any S3-compatible storage provider including AWS S3, Cloudflare R2, and self-hosted MinIO.",
		},
		{
			question: "Is Cap open-source video recording software?",
			answer:
				"Yes. Cap is fully open-source and MIT-licensed. The complete codebase is publicly available on GitHub.",
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
			name: "What is video recording software?",
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

describe("VideoRecordingSoftwarePage SEO registry", () => {
	it("is registered in seo-pages.ts", () => {
		const seoPagesSource = readFileSync(
			join(process.cwd(), "lib/seo-pages.ts"),
			"utf-8",
		);
		expect(seoPagesSource).toContain('"video-recording-software"');
	});

	it("is registered in seo-metadata.ts", () => {
		const seoMetadataSource = readFileSync(
			join(process.cwd(), "lib/seo-metadata.ts"),
			"utf-8",
		);
		expect(seoMetadataSource).toContain('"video-recording-software"');
	});
});
