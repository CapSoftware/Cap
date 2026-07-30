import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Slack Events route contract", () => {
	it("verifies the raw request before parsing and acknowledges through waitUntil", () => {
		const route = readFileSync(
			join(process.cwd(), "app/api/integrations/slack/events/route.ts"),
			"utf8",
		);
		const bodyRead = route.indexOf("yield* request.text");
		const signatureCheck = route.indexOf("verifySlackSignature({", bodyRead);
		const jsonParse = route.indexOf("JSON.parse(body)", signatureCheck);
		const deferredWork = route.indexOf("waitUntil(", jsonParse);

		expect(bodyRead).toBeGreaterThan(-1);
		expect(signatureCheck).toBeGreaterThan(bodyRead);
		expect(jsonParse).toBeGreaterThan(signatureCheck);
		expect(deferredWork).toBeGreaterThan(jsonParse);
		expect(route).toContain("HttpServerRequest.withMaxBodySize");
	});
});
