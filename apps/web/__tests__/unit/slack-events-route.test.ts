import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Slack Events route contract", () => {
	it("verifies the raw request and durably queues work before acknowledging", () => {
		const route = readFileSync(
			join(process.cwd(), "app/api/integrations/slack/events/route.ts"),
			"utf8",
		);
		const workflow = readFileSync(
			join(process.cwd(), "workflows/slack-event.ts"),
			"utf8",
		);
		const bodyRead = route.indexOf("yield* request.text");
		const signatureCheck = route.indexOf("verifySlackSignature({", bodyRead);
		const jsonParse = route.indexOf("JSON.parse(body)", signatureCheck);
		const queuedWork = route.indexOf("start(slackEventWorkflow", jsonParse);
		const acknowledgement = route.indexOf(
			"return jsonResponse({ ok: true })",
			queuedWork,
		);

		expect(bodyRead).toBeGreaterThan(-1);
		expect(signatureCheck).toBeGreaterThan(bodyRead);
		expect(jsonParse).toBeGreaterThan(signatureCheck);
		expect(queuedWork).toBeGreaterThan(jsonParse);
		expect(acknowledgement).toBeGreaterThan(queuedWork);
		expect(route).toContain("HttpServerRequest.withMaxBodySize");
		expect(route).toContain(
			'return jsonResponse({ error: "Could not queue Slack event" }, 503)',
		);
		expect(route).not.toContain("waitUntil(");
		expect(workflow).toContain('"use workflow"');
		expect(workflow).toContain('"use step"');
		expect(workflow).toContain("processSlackEvent({");
		expect(workflow).toContain("while (!processed)");
		expect(workflow).toContain('await sleep("5m")');
		expect(workflow).toContain("processSlackEventStep.maxRetries = 5");
	});
});
