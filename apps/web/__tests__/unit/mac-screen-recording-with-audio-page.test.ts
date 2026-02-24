import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFAQSchema } from "@/utils/web-schema";

const pageSource = readFileSync(
	join(
		process.cwd(),
		"app/(site)/(seo)/mac-screen-recording-with-audio/page.tsx",
	),
	"utf-8",
);

const componentSource = readFileSync(
	join(
		process.cwd(),
		"components/pages/seo/MacScreenRecordingWithAudioPage.tsx",
	),
	"utf-8",
);

describe("MacScreenRecordingWithAudioPage metadata", () => {
	it("contains canonical URL", () => {
		expect(pageSource).toContain(
			'canonical: "https://cap.so/mac-screen-recording-with-audio"',
		);
	});

	it("contains OG url field", () => {
		expect(pageSource).toContain(
			'url: "https://cap.so/mac-screen-recording-with-audio"',
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

	it("title targets mac-screen-recording-with-audio keyword", () => {
		expect(pageSource.toLowerCase()).toContain(
			"mac screen recording with audio",
		);
	});
});

describe("MacScreenRecordingWithAudioPage component content", () => {
	it("targets mac-screen-recording-with-audio keyword in title", () => {
		expect(componentSource.toLowerCase()).toContain(
			"mac screen recording with audio",
		);
	});

	it("includes comparison table", () => {
		expect(componentSource).toContain("comparisonTable");
	});

	it("includes recording modes section", () => {
		expect(componentSource).toContain("recordingModes");
	});

	it("mentions system audio capture", () => {
		expect(componentSource.toLowerCase()).toContain("system audio");
	});

	it("mentions macOS built-in recorder limitation", () => {
		expect(componentSource.toLowerCase()).toContain("cmd+shift+5");
	});

	it("mentions QuickTime as a comparison target", () => {
		expect(componentSource).toContain("QuickTime");
	});

	it("mentions OBS as a comparison target", () => {
		expect(componentSource).toContain("OBS");
	});

	it("mentions Loom as a comparison target", () => {
		expect(componentSource).toContain("Loom");
	});

	it("explains no BlackHole required", () => {
		expect(componentSource).toContain("BlackHole");
	});

	it("references the screen-recorder-mac internal link", () => {
		expect(componentSource).toContain("/screen-recorder-mac");
	});

	it("references the free-screen-recorder internal link", () => {
		expect(componentSource).toContain("/free-screen-recorder");
	});

	it("references the loom-alternative internal link", () => {
		expect(componentSource).toContain("/loom-alternative");
	});

	it("references the screen-recording-software internal link", () => {
		expect(componentSource).toContain("/screen-recording-software");
	});

	it("references the open-source-screen-recorder internal link", () => {
		expect(componentSource).toContain("/open-source-screen-recorder");
	});

	it("includes migration guide / how-to steps", () => {
		expect(componentSource).toContain("migrationGuide");
	});
});

describe("MacScreenRecordingWithAudioPage FAQ schema", () => {
	const faqs = [
		{
			question: "Why doesn't macOS record internal audio by default?",
			answer:
				"Apple restricts internal audio capture on macOS for privacy and copyright protection reasons.",
		},
		{
			question: "How do I record my Mac screen with internal audio?",
			answer:
				"The easiest way to record your Mac screen with internal audio is to use Cap.",
		},
		{
			question:
				"Can I record Mac screen with both microphone and system audio?",
			answer:
				"Yes — with Cap you can record both microphone and system audio simultaneously on Mac.",
		},
		{
			question: "Does Cap require BlackHole or Loopback for audio on Mac?",
			answer:
				"No. Cap handles Mac system audio capture natively without requiring BlackHole, Loopback, or any virtual audio driver.",
		},
		{
			question: "Is there a free way to record Mac screen with audio?",
			answer:
				"Yes. Cap is completely free for Mac screen recording with audio. Studio Mode has no time limits, no watermarks, and no fees.",
		},
		{
			question: "Does Cap record Mac screen with audio in 4K?",
			answer:
				"Yes. Cap records your Mac screen at up to 4K resolution at 60fps while simultaneously capturing system audio and microphone input.",
		},
		{
			question: "How do I share a Mac screen recording with audio?",
			answer:
				"With Cap, sharing is automatic. When you stop recording, Cap generates a shareable link in seconds.",
		},
		{
			question: "Can I record a specific app window with audio on Mac?",
			answer:
				"Yes. Cap lets you record a specific application window on Mac while capturing that app's system audio along with your microphone.",
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
			name: "Why doesn't macOS record internal audio by default?",
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

describe("MacScreenRecordingWithAudioPage SEO registry", () => {
	it("is registered in seo-pages.ts", () => {
		const seoPagesSource = readFileSync(
			join(process.cwd(), "lib/seo-pages.ts"),
			"utf-8",
		);
		expect(seoPagesSource).toContain('"mac-screen-recording-with-audio"');
	});

	it("is registered in seo-metadata.ts", () => {
		const seoMetadataSource = readFileSync(
			join(process.cwd(), "lib/seo-metadata.ts"),
			"utf-8",
		);
		expect(seoMetadataSource).toContain('"mac-screen-recording-with-audio"');
	});
});
