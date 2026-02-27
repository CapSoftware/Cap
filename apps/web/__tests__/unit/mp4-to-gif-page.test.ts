import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFAQSchema, createHowToSchema } from "@/utils/web-schema";

const pageSource = readFileSync(
	join(process.cwd(), "app/(site)/tools/convert/mp4-to-gif/page.tsx"),
	"utf-8",
);

describe("MP4 to GIF page metadata", () => {
	it("contains canonical URL", () => {
		expect(pageSource).toContain(
			'canonical: "https://cap.so/tools/convert/mp4-to-gif"',
		);
	});

	it("contains full OG image URL", () => {
		expect(pageSource).toContain('"https://cap.so/og.png"');
	});

	it("contains OG url field", () => {
		expect(pageSource).toContain(
			'url: "https://cap.so/tools/convert/mp4-to-gif"',
		);
	});

	it("contains OG siteName field", () => {
		expect(pageSource).toContain('siteName: "Cap"');
	});

	it("contains OG locale field", () => {
		expect(pageSource).toContain('locale: "en_US"');
	});
});

describe("MP4 to GIF page structured data", () => {
	it("contains FAQPage JSON-LD", () => {
		expect(pageSource).toContain('"@type": "FAQPage"');
	});

	it("contains HowTo JSON-LD", () => {
		expect(pageSource).toContain('"@type": "HowTo"');
	});

	it("contains at least 6 FAQ questions", () => {
		const matches = pageSource.match(/question:/g);
		expect(matches).not.toBeNull();
		expect(matches?.length).toBeGreaterThanOrEqual(6);
	});

	it("contains HowTo steps", () => {
		expect(pageSource).toContain('"@type": "HowToStep"');
	});
});

describe("MP4 to GIF FAQ schema validity", () => {
	const faqs = [
		{
			question: "How do I convert MP4 to GIF?",
			answer:
				"Open the Cap MP4 to GIF converter, drag and drop your MP4 file (or click to browse), adjust your settings if needed, then click Convert. The entire process runs in your browser — your file never leaves your device. Once complete, download the GIF instantly.",
		},
		{
			question: "Is the MP4 to GIF converter free?",
			answer:
				"Yes, completely free with no limits on the number of conversions. There are no watermarks, no sign-up required, and no hidden fees. The converter runs entirely in your browser at zero cost.",
		},
		{
			question: "What quality settings can I adjust?",
			answer:
				"You can customize the frame rate (5–30 FPS), quality level (1–20, where lower means smaller file size), maximum width (240–1280px), and toggle dithering on or off. Dithering improves color gradients in GIFs at the cost of a larger file size.",
		},
		{
			question: "Will the GIF be smaller than the original MP4?",
			answer:
				"Usually not. GIFs are often larger than MP4 videos because the GIF format supports a limited 256-color palette per frame and lacks modern compression. For smaller file sizes, lower the FPS, reduce the max width, or increase the quality number (which reduces quality but shrinks file size).",
		},
		{
			question: "What frame rate should I use for GIFs?",
			answer:
				"10–15 FPS is the standard for web GIFs and produces smooth-looking animations without excessive file size. For short, action-heavy clips you may want 20–30 FPS. For looping backgrounds or simple animations, 10 FPS or lower is usually sufficient.",
		},
		{
			question: "Is there a file size limit?",
			answer:
				"The converter supports MP4 files up to 500 MB. For smooth in-browser performance, keep source files short (under 30 seconds) since longer videos produce very large GIFs. For longer content, consider exporting a trimmed clip first.",
		},
		{
			question: "Does this converter work on mobile?",
			answer:
				"The converter works best on desktop browsers (Chrome, Edge, Brave). Mobile browser support for the underlying video decoding APIs is still limited, so desktop is recommended for reliable results.",
		},
		{
			question: "Do I need to install any software?",
			answer:
				"No. The converter runs entirely in your browser — no downloads, no plugins, no extensions required. Just open the page and start converting. All processing happens locally on your device for complete privacy.",
		},
	];

	it("produces valid FAQPage schema with all 8 questions", () => {
		const schema = createFAQSchema(faqs);

		expect(schema["@context"]).toBe("https://schema.org");
		expect(schema["@type"]).toBe("FAQPage");
		expect(schema.mainEntity).toHaveLength(8);
	});

	it("maps each FAQ to a Question entity with acceptedAnswer", () => {
		const schema = createFAQSchema(faqs);

		expect(schema.mainEntity[0]).toEqual({
			"@type": "Question",
			name: "How do I convert MP4 to GIF?",
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

describe("MP4 to GIF HowTo schema validity", () => {
	const howToSteps = [
		{
			name: "Upload your MP4 file",
			text: "Open the Cap MP4 to GIF converter and drag and drop your MP4 file into the upload area, or click to browse your files.",
		},
		{
			name: "Adjust conversion settings",
			text: "Optionally customize the frame rate, quality, maximum width, and dithering to balance GIF quality and file size.",
		},
		{
			name: "Convert and download your GIF",
			text: "Click Convert. The file is processed entirely in your browser — nothing is uploaded to any server. Once done, click Download to save the animated GIF.",
		},
	];

	it("produces valid HowTo schema with 3 steps", () => {
		const schema = createHowToSchema({
			name: "How to Convert MP4 to GIF Online",
			description:
				"Convert MP4 video files to animated GIF format for free using Cap's browser-based converter. No upload required.",
			steps: howToSteps,
		});

		expect(schema["@context"]).toBe("https://schema.org");
		expect(schema["@type"]).toBe("HowTo");
		expect(schema.step).toHaveLength(3);
	});

	it("assigns correct positions to each step", () => {
		const schema = createHowToSchema({
			name: "How to Convert MP4 to GIF Online",
			description: "Convert MP4 to animated GIF in your browser.",
			steps: howToSteps,
		});

		expect(schema.step[0].position).toBe(1);
		expect(schema.step[0].name).toBe("Upload your MP4 file");
		expect(schema.step[1].position).toBe(2);
		expect(schema.step[2].position).toBe(3);
		expect(schema.step[2].name).toBe("Convert and download your GIF");
	});

	it("produces JSON-serializable output", () => {
		const schema = createHowToSchema({
			name: "How to Convert MP4 to GIF Online",
			description: "Convert MP4 to animated GIF in your browser.",
			steps: howToSteps,
		});

		expect(() => JSON.stringify(schema)).not.toThrow();
		const parsed = JSON.parse(JSON.stringify(schema));
		expect(parsed["@type"]).toBe("HowTo");
		expect(parsed.step).toHaveLength(3);
	});
});
