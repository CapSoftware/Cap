import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFAQSchema } from "@/utils/web-schema";

const pageSource = readFileSync(
	join(
		process.cwd(),
		"app/(site)/(seo)/hipaa-compliant-screen-recording/page.tsx",
	),
	"utf-8",
);

const componentSource = readFileSync(
	join(
		process.cwd(),
		"components/pages/seo/HipaaCompliantScreenRecordingPage.tsx",
	),
	"utf-8",
);

describe("HipaaCompliantScreenRecordingPage metadata", () => {
	it("contains canonical URL", () => {
		expect(pageSource).toContain(
			'canonical: "https://cap.so/hipaa-compliant-screen-recording"',
		);
	});

	it("contains OG url field", () => {
		expect(pageSource).toContain(
			'url: "https://cap.so/hipaa-compliant-screen-recording"',
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

	it("title targets hipaa-compliant-screen-recording keyword", () => {
		expect(pageSource.toLowerCase()).toContain("hipaa");
	});
});

describe("HipaaCompliantScreenRecordingPage component content", () => {
	it("targets hipaa keyword in title", () => {
		expect(componentSource.toLowerCase()).toContain("hipaa");
	});

	it("includes comparison table", () => {
		expect(componentSource).toContain("comparisonTable");
	});

	it("includes recording modes section", () => {
		expect(componentSource).toContain("recordingModes");
	});

	it("mentions self-hosted storage", () => {
		expect(componentSource.toLowerCase()).toContain("self-host");
	});

	it("mentions AWS S3", () => {
		expect(componentSource).toContain("AWS S3");
	});

	it("includes migration guide", () => {
		expect(componentSource).toContain("migrationGuide");
	});

	it("mentions open source", () => {
		expect(componentSource.toLowerCase()).toContain("open source");
	});

	it("has badge set", () => {
		expect(componentSource).toContain("badge");
	});

	it("references the loom-alternative internal link", () => {
		expect(componentSource).toContain("/loom-alternative");
	});

	it("mentions PHI (protected health information)", () => {
		expect(componentSource).toContain("PHI");
	});
});

describe("HipaaCompliantScreenRecordingPage FAQ schema", () => {
	const faqs = [
		{
			question: "Can Cap be used for HIPAA-compliant screen recording?",
			answer:
				"Cap supports HIPAA-compliant workflows when configured with self-hosted storage.",
		},
		{
			question: "Does Cap store recordings on its own servers?",
			answer:
				"By default, Cap uploads recordings to Cap's cloud storage. However, Cap fully supports custom S3-compatible storage.",
		},
		{
			question:
				"Is Cap open source and auditable for HIPAA vendor assessments?",
			answer: "Yes. Cap is MIT-licensed and fully open source on GitHub.",
		},
		{
			question: "Can I disable AI transcription in Cap for HIPAA compliance?",
			answer:
				"Yes. Cap's AI auto-captions are optional and can be disabled entirely in settings.",
		},
		{
			question: "Does Cap support AWS S3 for HIPAA-eligible storage?",
			answer:
				"Yes. Cap supports AWS S3 as a storage backend. AWS S3 is HIPAA-eligible when covered by an AWS Business Associate Agreement (BAA).",
		},
		{
			question: "Can the entire Cap platform be self-hosted?",
			answer:
				"Yes. The complete Cap platform can be self-hosted on your own infrastructure.",
		},
		{
			question:
				"How do I restrict access to HIPAA screen recordings shared via Cap?",
			answer: "Cap supports password-protected sharing links.",
		},
		{
			question: "What screen recording tools are HIPAA-compliant?",
			answer:
				"A screen recorder can support HIPAA-compliant workflows if it allows you to control where recordings are stored.",
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
			name: "Can Cap be used for HIPAA-compliant screen recording?",
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

describe("HipaaCompliantScreenRecordingPage SEO registry", () => {
	it("is registered in seo-pages.ts", () => {
		const seoPagesSource = readFileSync(
			join(process.cwd(), "lib/seo-pages.ts"),
			"utf-8",
		);
		expect(seoPagesSource).toContain('"hipaa-compliant-screen-recording"');
	});

	it("is registered in seo-metadata.ts", () => {
		const seoMetadataSource = readFileSync(
			join(process.cwd(), "lib/seo-metadata.ts"),
			"utf-8",
		);
		expect(seoMetadataSource).toContain('"hipaa-compliant-screen-recording"');
	});
});
