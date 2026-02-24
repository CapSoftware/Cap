import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFAQSchema } from "@/utils/web-schema";

const pageSource = readFileSync(
	join(process.cwd(), "app/(site)/(seo)/async-video-code-reviews/page.tsx"),
	"utf-8",
);

const componentSource = readFileSync(
	join(process.cwd(), "components/pages/seo/AsyncVideoCodeReviewsPage.tsx"),
	"utf-8",
);

describe("AsyncVideoCodeReviewsPage metadata", () => {
	it("contains canonical URL", () => {
		expect(pageSource).toContain(
			'canonical: "https://cap.so/async-video-code-reviews"',
		);
	});

	it("contains OG url field", () => {
		expect(pageSource).toContain(
			'url: "https://cap.so/async-video-code-reviews"',
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

	it("title targets async video code reviews keyword", () => {
		expect(pageSource.toLowerCase()).toContain("async");
		expect(pageSource.toLowerCase()).toContain("code review");
	});
});

describe("AsyncVideoCodeReviewsPage component content", () => {
	it("targets async code review keyword in title", () => {
		expect(componentSource.toLowerCase()).toContain("async");
		expect(componentSource.toLowerCase()).toContain("code review");
	});

	it("includes comparison table", () => {
		expect(componentSource).toContain("comparisonTable");
	});

	it("includes recording modes section", () => {
		expect(componentSource).toContain("recordingModes");
	});

	it("mentions pull requests", () => {
		expect(componentSource.toLowerCase()).toContain("pull request");
	});

	it("mentions timestamped comments", () => {
		expect(componentSource.toLowerCase()).toContain("timestamp");
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

	it("references solutions/remote-team-collaboration internal link", () => {
		expect(componentSource).toContain("/solutions/remote-team-collaboration");
	});

	it("references solutions/employee-onboarding-platform internal link", () => {
		expect(componentSource).toContain(
			"/solutions/employee-onboarding-platform",
		);
	});
});

describe("AsyncVideoCodeReviewsPage FAQ schema", () => {
	const faqs = [
		{
			question: "What is an async video code review?",
			answer:
				"An async video code review is a screen recording walkthrough of a pull request, diff, or codebase.",
		},
		{
			question: "Why use video instead of written comments for code reviews?",
			answer:
				"Video code reviews communicate context, intent, and nuance that text comments often miss.",
		},
		{
			question: "How does Cap make code reviews faster?",
			answer:
				"Cap generates a shareable link the moment you stop recording — no upload wait, no file attachment.",
		},
		{
			question:
				"Does Cap work with GitHub, GitLab, Linear, and other developer tools?",
			answer: "Yes. Cap produces a standard URL that you can paste anywhere.",
		},
		{
			question: "Can I record code in 4K so reviewers can read it clearly?",
			answer: "Yes. Cap records at up to 4K resolution at 60fps.",
		},
		{
			question: "How long can a Cap code review recording be?",
			answer: "In Studio Mode, there is no recording time limit.",
		},
		{
			question:
				"Can I keep code review recordings private or password-protected?",
			answer: "Yes. Cap supports password protection on individual recordings.",
		},
		{
			question: "What is the best tool for async video code reviews?",
			answer:
				"Cap is the best tool for async video code reviews for engineering teams.",
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
			name: "What is an async video code review?",
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

describe("AsyncVideoCodeReviewsPage SEO registry", () => {
	it("is registered in seo-pages.ts", () => {
		const seoPagesSource = readFileSync(
			join(process.cwd(), "lib/seo-pages.ts"),
			"utf-8",
		);
		expect(seoPagesSource).toContain('"async-video-code-reviews"');
	});

	it("is registered in seo-metadata.ts", () => {
		const seoMetadataSource = readFileSync(
			join(process.cwd(), "lib/seo-metadata.ts"),
			"utf-8",
		);
		expect(seoMetadataSource).toContain('"async-video-code-reviews"');
	});
});
