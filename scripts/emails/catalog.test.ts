import { describe, expect, test } from "bun:test";
import { components, emailContent } from "../../emails/brand";
import { journeys } from "../../emails/flows";
import { freeWelcome } from "../../emails/marketing/free-welcome";
import {
	flowSteps,
	renderCatalog,
	validateCatalog,
	validateEmail,
	validateTheme,
} from "./catalog";
import { assertEmailContent, normalizeLmx } from "./content";

describe("email library", () => {
	test("every template and known application send source is registered", async () => {
		expect(await validateCatalog()).toEqual([]);
	});
	test("line heights reject pixel values that collapse the Loops footer", () => {
		expect(validateTheme({ textBaseLineHeight: 26 })).toEqual([
			"textBaseLineHeight must be a percentage from 100 to 300",
		]);
		expect(
			validateTheme({ textBaseLineHeight: 160, heading1LineHeight: 130 }),
		).toEqual([]);
		expect(validateTheme({ textBaseLineHeight: Number.NaN })).toHaveLength(1);
	});
	test("variables in subjects require a declared contract and fallback", () => {
		expect(
			validateEmail({ ...freeWelcome, subject: "Hello {contact.company}" }),
		).toContain("Undeclared contact variable: contact.company");
		expect(
			validateEmail({ ...freeWelcome, subject: "Hello {data.firstName}" }),
		).toContain("Undeclared contact variable: data.firstName");
	});
	test("per-email branding overrides and template references are rejected", () => {
		expect(
			validateEmail({
				...freeWelcome,
				body: `${freeWelcome.body}<Style themeId="other" />`,
			}),
		).toContain(
			"Use shared branding; do not embed Style or Component in email bodies",
		);
		expect(
			validateEmail({
				...freeWelcome,
				body: freeWelcome.body.replace(
					"<Paragraph>",
					'<Paragraph textColor="#ff0000">',
				),
			}),
		).toContain("Put visual branding in emails/brand.ts");
	});
	test("relative delays become cumulative days, including skipped reminders", () => {
		expect(flowSteps(journeys[0]).map((step) => step.day)).toEqual([
			0, 2, 5, 9,
		]);
		const catalogue = renderCatalog();
		expect(catalogue).toContain("branch1 -->|No: skip| next1((Continue))");
		expect(catalogue).toContain('next1 --> wait2["Wait 3 days"]');
	});
});

describe("Loops content comparison", () => {
	const ids = { theme: "theme", header: "header", signature: "signature" };
	const content = emailContent(freeWelcome, ids);
	test("accepts editor formatting while retaining semantic whitespace", () => {
		expect(
			normalizeLmx('<Button align="left" href="https://cap.so">Go</Button>'),
		).toBe(normalizeLmx('<Button href="https://cap.so">Go</Button>'));
		expect(
			normalizeLmx("<Paragraph><Strong>A</Strong> B</Paragraph>"),
		).not.toBe(normalizeLmx("<Paragraph><Strong>A</Strong>B</Paragraph>"));
		const expanded = content.lmx
			.replace(
				'<Component componentId="header" />',
				`<Component componentId="header">\n${components[0].lmx}\n</Component>`,
			)
			.replace(
				'<Component componentId="signature" />',
				`<Component componentId="signature">\n${components[1].lmx}\n</Component>`,
			);
		expect(() =>
			assertEmailContent({ ...content, lmx: expanded }, freeWelcome, ids),
		).not.toThrow();
	});
	test("detects added content, changed links, styling and component overrides", () => {
		for (const lmx of [
			`${content.lmx}<Paragraph>Unexpected promotion</Paragraph>`,
			content.lmx.replace("https://cap.so/download", "https://example.com"),
			content.lmx.replace("<Paragraph ", '<Paragraph textColor="#ff0000" '),
			content.lmx.replace(
				'<Component componentId="header" />',
				'<Component componentId="header"><Paragraph>Changed header</Paragraph></Component>',
			),
		]) {
			expect(lmx).not.toBe(content.lmx);
			expect(() =>
				assertEmailContent({ ...content, lmx }, freeWelcome, ids),
			).toThrow();
		}
	});
	test("detects changed sender metadata and fallbacks", () => {
		expect(() =>
			assertEmailContent(
				{ ...content, fromName: "Another sender" },
				freeWelcome,
				ids,
			),
		).toThrow();
		expect(() =>
			assertEmailContent(
				{ ...content, contactPropertiesFallbacks: {} },
				freeWelcome,
				ids,
			),
		).toThrow();
	});
});
