import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFAQSchema } from "@/utils/web-schema";

const pageSource = readFileSync(
	join(
		process.cwd(),
		"app/(site)/(seo)/developer-documentation-videos/page.tsx",
	),
	"utf-8",
);

const componentSource = readFileSync(
	join(
		process.cwd(),
		"components/pages/seo/DeveloperDocumentationVideosPage.tsx",
	),
	"utf-8",
);

describe("DeveloperDocumentationVideosPage metadata", () => {
	it("contains canonical URL", () => {
		expect(pageSource).toContain(
			'canonical: "https://cap.so/developer-documentation-videos"',
		);
	});

	it("contains OG url field", () => {
		expect(pageSource).toContain(
			'url: "https://cap.so/developer-documentation-videos"',
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

	it("title targets developer documentation videos keyword", () => {
		expect(pageSource.toLowerCase()).toContain("developer documentation");
	});
});

describe("DeveloperDocumentationVideosPage component content", () => {
	it("targets developer documentation keyword in title", () => {
		expect(componentSource.toLowerCase()).toContain("developer documentation");
	});

	it("includes comparison table", () => {
		expect(componentSource).toContain("comparisonTable");
	});

	it("includes recording modes section", () => {
		expect(componentSource).toContain("recordingModes");
	});

	it("mentions API demos", () => {
		expect(componentSource.toLowerCase()).toContain("api demo");
	});

	it("mentions SDK walkthroughs", () => {
		expect(componentSource.toLowerCase()).toContain("sdk");
	});

	it("includes migration guide", () => {
		expect(componentSource).toContain("migrationGuide");
	});

	it("mentions 4K resolution", () => {
		expect(componentSource).toContain("4K");
	});

	it("has badge set", () => {
		expect(componentSource).toContain("badge");
	});

	it("references self-hosted-screen-recording internal link", () => {
		expect(componentSource).toContain("/self-hosted-screen-recording");
	});

	it("references open-source-screen-recorder internal link", () => {
		expect(componentSource).toContain("/open-source-screen-recorder");
	});

	it("references solutions/employee-onboarding-platform internal link", () => {
		expect(componentSource).toContain(
			"/solutions/employee-onboarding-platform",
		);
	});

	it("mentions AI transcripts", () => {
		expect(componentSource.toLowerCase()).toContain("transcript");
	});
});

describe("DeveloperDocumentationVideosPage FAQ schema", () => {
	const faqs = [
		{
			question: "What is a developer documentation video?",
			answer:
				"A developer documentation video is a screen recording that demonstrates how to use an API, SDK, CLI tool, or technical workflow.",
		},
		{
			question: "How do I embed a Cap video in my documentation?",
			answer:
				"Cap generates a shareable link the moment you stop recording. You can paste this URL directly into Notion, Confluence, Docusaurus, GitBook.",
		},
		{
			question: "Can I record my terminal and IDE output in 4K?",
			answer: "Yes. Cap records at up to 4K resolution at 60fps.",
		},
		{
			question: "Does Cap auto-generate transcripts for documentation?",
			answer:
				"Yes. Cap auto-generates captions and transcripts for every recording using AI transcription.",
		},
		{
			question: "How do I share a documentation video with my team or users?",
			answer:
				"Cap generates a shareable link immediately when you stop recording — no upload wait, no file attachment.",
		},
		{
			question: "Can I record videos for private internal documentation?",
			answer:
				"Yes. Cap supports password protection on individual recordings and expiry dates on share links.",
		},
		{
			question: "What is the best screen recorder for developer documentation?",
			answer:
				"Cap is the best screen recorder for developer documentation because it combines 4K recording quality, instant shareable links, AI-generated transcripts, and self-hosted storage.",
		},
		{
			question: "Does Cap work for recording API demos and SDK walkthroughs?",
			answer:
				"Yes. Cap is designed exactly for this use case. Record your terminal, IDE, browser, API client.",
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
			name: "What is a developer documentation video?",
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

describe("DeveloperDocumentationVideosPage SEO registry", () => {
	it("is registered in seo-pages.ts", () => {
		const seoPagesSource = readFileSync(
			join(process.cwd(), "lib/seo-pages.ts"),
			"utf-8",
		);
		expect(seoPagesSource).toContain('"developer-documentation-videos"');
	});

	it("is registered in seo-metadata.ts", () => {
		const seoMetadataSource = readFileSync(
			join(process.cwd(), "lib/seo-metadata.ts"),
			"utf-8",
		);
		expect(seoMetadataSource).toContain('"developer-documentation-videos"');
	});
});
