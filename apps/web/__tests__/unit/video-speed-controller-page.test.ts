import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFAQSchema, createHowToSchema } from "@/utils/web-schema";

const pageSource = readFileSync(
	join(process.cwd(), "app/(site)/tools/video-speed-controller/page.tsx"),
	"utf-8",
);

describe("Video Speed Controller page metadata", () => {
	it("contains canonical URL", () => {
		expect(pageSource).toContain(
			'canonical: "https://cap.so/tools/video-speed-controller"',
		);
	});

	it("contains full OG image URL", () => {
		expect(pageSource).toContain('"https://cap.so/og.png"');
	});

	it("contains OG url field", () => {
		expect(pageSource).toContain(
			'url: "https://cap.so/tools/video-speed-controller"',
		);
	});

	it("contains OG siteName field", () => {
		expect(pageSource).toContain('siteName: "Cap"');
	});

	it("contains OG locale field", () => {
		expect(pageSource).toContain('locale: "en_US"');
	});
});

describe("Video Speed Controller page structured data", () => {
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

describe("Video Speed Controller FAQ schema validity", () => {
	const faqs = [
		{
			question: "How do I change the speed of a video online?",
			answer:
				"Open Cap's Video Speed Controller, drag and drop your video file (or click to browse), select your target speed from 0.25× to 3×, then click Speed Up or Slow Down Video. The entire process runs in your browser — your file never leaves your device. Once processing is complete, preview and download the result.",
		},
		{
			question: "What video formats does the speed controller support?",
			answer:
				"MP4, WebM, MOV, AVI and MKV are all supported — essentially any video format modern browsers can decode. Chrome is recommended for the best compatibility and performance.",
		},
		{
			question: "Is the video speed controller free?",
			answer:
				"Yes, completely free with no limits on the number of videos you can process. There are no watermarks, no sign-up required, and no hidden fees. The tool runs entirely in your browser at zero cost.",
		},
		{
			question: "Will my video quality change when I adjust the speed?",
			answer:
				"No. The tool preserves your original resolution and bitrate — only the playback speed changes. There is no re-encoding that degrades visual quality. Audio pitch is also automatically corrected to stay natural at the new speed.",
		},
		{
			question: "Is there a file size limit?",
			answer:
				"Up to 500 MB for smooth in-browser performance. For larger files, consider trimming the video first to keep only the section you need, then adjusting the speed.",
		},
		{
			question: "Why is processing taking a long time?",
			answer:
				"Browser-based video processing relies on your device's hardware. Older CPUs or GPUs, throttled mobile devices, and very long or high-resolution videos will take longer. For fastest results, use Chrome on a modern desktop or laptop.",
		},
		{
			question: "Does this work on iPhone or Android?",
			answer:
				"Yes — modern Safari, Chrome, and Firefox on mobile are supported, though Chrome on desktop delivers the most reliable performance. If you encounter issues on mobile, try Chrome or Firefox instead of the default browser.",
		},
		{
			question: "Do I need to install any software?",
			answer:
				"No. The tool runs entirely in your browser — no downloads, no plugins, no extensions required. Just open the page and start adjusting your video speed. All processing happens locally on your device for complete privacy.",
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
			name: "How do I change the speed of a video online?",
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

describe("Video Speed Controller HowTo schema validity", () => {
	const howToSteps = [
		{
			name: "Upload your video file",
			text: "Open Cap's Video Speed Controller and drag and drop your video into the upload area, or click to browse your files. Supported formats include MP4, WebM, MOV, AVI, and MKV up to 500 MB.",
		},
		{
			name: "Select your target speed",
			text: "Choose a playback speed from the options: 0.25× (very slow) up to 3× (ultra fast). The tool shows an estimated output duration so you know exactly how long the processed video will be.",
		},
		{
			name: "Process and download your video",
			text: "Click Speed Up or Slow Down Video. Processing runs entirely in your browser — nothing is uploaded to any server. Once complete, preview the result and click Download to save the speed-adjusted video.",
		},
	];

	it("produces valid HowTo schema with 3 steps", () => {
		const schema = createHowToSchema({
			name: "How to Change Video Speed Online",
			description:
				"Adjust the playback speed of any video for free using Cap's browser-based speed controller. No upload required.",
			steps: howToSteps,
		});

		expect(schema["@context"]).toBe("https://schema.org");
		expect(schema["@type"]).toBe("HowTo");
		expect(schema.step).toHaveLength(3);
	});

	it("assigns correct positions to each step", () => {
		const schema = createHowToSchema({
			name: "How to Change Video Speed Online",
			description: "Adjust video playback speed directly in your browser.",
			steps: howToSteps,
		});

		expect(schema.step[0].position).toBe(1);
		expect(schema.step[0].name).toBe("Upload your video file");
		expect(schema.step[1].position).toBe(2);
		expect(schema.step[2].position).toBe(3);
		expect(schema.step[2].name).toBe("Process and download your video");
	});

	it("produces JSON-serializable output", () => {
		const schema = createHowToSchema({
			name: "How to Change Video Speed Online",
			description: "Adjust video playback speed directly in your browser.",
			steps: howToSteps,
		});

		expect(() => JSON.stringify(schema)).not.toThrow();
		const parsed = JSON.parse(JSON.stringify(schema));
		expect(parsed["@type"]).toBe("HowTo");
		expect(parsed.step).toHaveLength(3);
	});
});
