import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFAQSchema, createHowToSchema } from "@/utils/web-schema";

const pageSource = readFileSync(
	join(process.cwd(), "app/(site)/tools/convert/mov-to-mp4/page.tsx"),
	"utf-8",
);

describe("MOV to MP4 page metadata", () => {
	it("contains canonical URL", () => {
		expect(pageSource).toContain(
			'canonical: "https://cap.so/tools/convert/mov-to-mp4"',
		);
	});

	it("contains full OG image URL", () => {
		expect(pageSource).toContain('"https://cap.so/og.png"');
	});

	it("contains OG url field", () => {
		expect(pageSource).toContain(
			'url: "https://cap.so/tools/convert/mov-to-mp4"',
		);
	});

	it("contains OG siteName field", () => {
		expect(pageSource).toContain('siteName: "Cap"');
	});

	it("contains OG locale field", () => {
		expect(pageSource).toContain('locale: "en_US"');
	});
});

describe("MOV to MP4 page structured data", () => {
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

describe("MOV to MP4 FAQ schema validity", () => {
	const faqs = [
		{
			question: "How do I convert MOV to MP4 online?",
			answer:
				"Open Cap's MOV to MP4 converter, drag and drop your MOV file (or click to browse), then click Convert. The entire process runs in your browser — your file never leaves your device. Once complete, click Download to save the MP4 file.",
		},
		{
			question: "Is the MOV to MP4 converter free?",
			answer:
				"Yes, completely free with no limits on the number of conversions. There are no watermarks, no sign-up required, and no hidden fees. The converter runs entirely in your browser at zero cost.",
		},
		{
			question: "Why convert MOV to MP4?",
			answer:
				"MOV is Apple's proprietary QuickTime format and plays natively on macOS and iOS but often has limited support on Windows, Android, and smart TVs. MP4 (H.264) is the universal standard supported by virtually every device, platform, browser, and video hosting service. Converting to MP4 ensures your video plays anywhere without compatibility issues.",
		},
		{
			question: "Will converting MOV to MP4 reduce video quality?",
			answer:
				"Quality is preserved as closely as possible during conversion. The converter uses your browser's native video decoding and re-encodes to H.264 MP4, which is visually lossless at typical settings. For most use cases — sharing, uploading, or playing on other devices — the output quality will look identical to the original.",
		},
		{
			question: "Is there a file size limit?",
			answer:
				"The converter supports MOV files up to 500 MB. For smooth in-browser performance, files under 200 MB convert fastest. For very large MOV files, consider trimming the video first to keep only the section you need.",
		},
		{
			question: "Does this work with iPhone MOV files?",
			answer:
				"Yes. iPhones and iPads record video in the MOV (QuickTime) container using HEVC or H.264. Cap's converter handles both formats and outputs a widely compatible MP4 file you can share, upload, or play on any device.",
		},
		{
			question: "Does the converter work on mobile?",
			answer:
				"The converter works best on desktop browsers (Chrome, Edge, Brave). Mobile browser support for the underlying video processing APIs is still limited, so desktop is recommended for the most reliable results.",
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
			name: "How do I convert MOV to MP4 online?",
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

describe("MOV to MP4 HowTo schema validity", () => {
	const howToSteps = [
		{
			name: "Upload your MOV file",
			text: "Open Cap's MOV to MP4 converter and drag and drop your MOV file into the upload area, or click to browse your files. Supports QuickTime MOV files up to 500 MB.",
		},
		{
			name: "Start the conversion",
			text: "Click Convert. The file is processed entirely in your browser using local compute — nothing is uploaded to any server. Conversion time depends on file size and your device speed.",
		},
		{
			name: "Download your MP4",
			text: "Once conversion is complete, click Download to save the MP4 file to your device. The output is a standard H.264 MP4 compatible with every device, platform, and video hosting service.",
		},
	];

	it("produces valid HowTo schema with 3 steps", () => {
		const schema = createHowToSchema({
			name: "How to Convert MOV to MP4 Online",
			description:
				"Convert Apple QuickTime MOV video files to MP4 format for free using Cap's browser-based converter. No upload required.",
			steps: howToSteps,
		});

		expect(schema["@context"]).toBe("https://schema.org");
		expect(schema["@type"]).toBe("HowTo");
		expect(schema.step).toHaveLength(3);
	});

	it("assigns correct positions to each step", () => {
		const schema = createHowToSchema({
			name: "How to Convert MOV to MP4 Online",
			description: "Convert MOV to MP4 in your browser.",
			steps: howToSteps,
		});

		expect(schema.step[0].position).toBe(1);
		expect(schema.step[0].name).toBe("Upload your MOV file");
		expect(schema.step[1].position).toBe(2);
		expect(schema.step[2].position).toBe(3);
		expect(schema.step[2].name).toBe("Download your MP4");
	});

	it("produces JSON-serializable output", () => {
		const schema = createHowToSchema({
			name: "How to Convert MOV to MP4 Online",
			description: "Convert MOV to MP4 in your browser.",
			steps: howToSteps,
		});

		expect(() => JSON.stringify(schema)).not.toThrow();
		const parsed = JSON.parse(JSON.stringify(schema));
		expect(parsed["@type"]).toBe("HowTo");
		expect(parsed.step).toHaveLength(3);
	});
});
