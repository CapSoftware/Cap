import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFAQSchema } from "@/utils/web-schema";

const pageSource = readFileSync(
	join(process.cwd(), "app/(site)/(seo)/best-screen-recorder/page.tsx"),
	"utf-8",
);

const componentSource = readFileSync(
	join(process.cwd(), "components/pages/seo/BestScreenRecorderPage.tsx"),
	"utf-8",
);

describe("BestScreenRecorderPage metadata", () => {
	it("contains canonical URL", () => {
		expect(pageSource).toContain(
			'canonical: "https://cap.so/best-screen-recorder"',
		);
	});

	it("contains OG url field", () => {
		expect(pageSource).toContain('url: "https://cap.so/best-screen-recorder"');
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

	it("title targets best-screen-recorder keyword", () => {
		expect(pageSource.toLowerCase()).toContain("best screen recorder");
	});
});

describe("BestScreenRecorderPage component content", () => {
	it("targets best-screen-recorder keyword in title", () => {
		expect(componentSource.toLowerCase()).toContain("best screen recorder");
	});

	it("includes comparison table", () => {
		expect(componentSource).toContain("comparisonTable");
	});

	it("includes recording modes section", () => {
		expect(componentSource).toContain("recordingModes");
	});

	it("includes OBS as a comparison target", () => {
		expect(componentSource).toContain("OBS");
	});

	it("includes Loom as a comparison target", () => {
		expect(componentSource).toContain("Loom");
	});

	it("includes Camtasia as a comparison target", () => {
		expect(componentSource).toContain("Camtasia");
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
});

describe("BestScreenRecorderPage FAQ schema", () => {
	const faqs = [
		{
			question: "What is the best screen recorder?",
			answer:
				"Cap is the best screen recorder for most users — it records in 4K at 60fps, works on Mac and Windows, has no watermarks, and generates shareable links instantly.",
		},
		{
			question: "What is the best free screen recorder?",
			answer:
				'Cap is the best free screen recorder available. Studio Mode is 100% free for personal use with unlimited recording time, no watermarks, and no time limits. <a href="/free-screen-recorder">Download Cap free</a> to get started.',
		},
		{
			question: "What is the best screen recorder for Mac?",
			answer:
				"Cap is the best screen recorder for Mac. It is natively optimized for macOS and records at up to 4K with system audio and webcam overlay.",
		},
		{
			question: "What is the best screen recorder for Windows?",
			answer:
				"Cap is the best screen recorder for Windows. It supports Windows 10 and 11 and records your full screen, specific windows, or custom regions.",
		},
		{
			question: "Which screen recorder has no watermark?",
			answer:
				"Cap has no watermark on any recording, including the free plan. Studio Mode produces completely clean recordings with no branding overlays.",
		},
		{
			question: "What is the best screen recorder for beginners?",
			answer:
				"Cap is designed to be the best screen recorder for beginners. Download the app, click record, and get a shareable link when you stop.",
		},
		{
			question: "Does Cap screen recorder capture system audio?",
			answer:
				"Yes, Cap captures both system audio and microphone input simultaneously. Both audio tracks are captured and synchronized automatically.",
		},
		{
			question: "What is the best screen recorder for teams?",
			answer:
				"Cap is the best screen recorder for teams because of its built-in sharing and collaboration features, including instant shareable links and timestamped comments.",
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
			name: "What is the best screen recorder?",
			acceptedAnswer: {
				"@type": "Answer",
				text: faqs[0].answer,
			},
		});
	});

	it("strips HTML tags from answers", () => {
		const schema = createFAQSchema(faqs);
		expect(schema.mainEntity[1].acceptedAnswer.text).not.toContain("<a");
		expect(schema.mainEntity[1].acceptedAnswer.text).toContain("Cap free");
	});

	it("produces JSON-serializable output", () => {
		const schema = createFAQSchema(faqs);
		expect(() => JSON.stringify(schema)).not.toThrow();
		const parsed = JSON.parse(JSON.stringify(schema));
		expect(parsed["@type"]).toBe("FAQPage");
		expect(parsed.mainEntity).toHaveLength(8);
	});
});
