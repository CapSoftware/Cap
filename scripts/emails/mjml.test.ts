import { describe, expect, test } from "bun:test";
import { contactFallbacks, footer, logo } from "../../emails/brand";
import { freeWelcome } from "../../emails/marketing/free-welcome";
import { renderMjml } from "../../emails/mjml";
import { marketingEmails } from "./catalog";

describe("marketing delivery templates", () => {
	test("every email retains its links and has one concise unsubscribe footer", () => {
		for (const email of marketingEmails) {
			const mjml = renderMjml(email);
			expect(mjml.match(/href="\{unsubscribe_link\}"/g)).toHaveLength(1);
			expect(mjml).toContain(footer.address);
			expect(mjml).not.toContain("You are receiving");
			expect(mjml).not.toContain("{contact.");
			expect(mjml).not.toContain("Hey {firstName},");
			expect(mjml).toContain("<mj-preview>");
			for (const [, href] of email.body.matchAll(/href="([^"]+)"/g))
				expect(mjml).toContain(`href="${href}"`);
		}
	});
	test("greeting fallback contains the complete salutation", () => {
		expect(contactFallbacks.capGreeting).toBe("Hey,");
		expect(renderMjml(freeWelcome)).toContain(
			"<mj-text>{capGreeting}</mj-text>",
		);
	});
	test("logo and text share the same zero left padding", () => {
		const mjml = renderMjml(freeWelcome);
		expect(mjml).toContain(`width="${logo.width}px" align="left"`);
		expect(mjml).toContain('src="img/cap-logo.png" alt="Cap"');
		expect(mjml).toContain('padding="0 0 24px"');
		expect(mjml).toContain('padding="0 0 16px"');
	});
	test("unsupported new content blocks fail instead of silently disappearing", () => {
		expect(() =>
			renderMjml({ ...freeWelcome, body: "<Columns>Unsupported</Columns>" }),
		).toThrow("Unsupported marketing content tag");
	});
});
