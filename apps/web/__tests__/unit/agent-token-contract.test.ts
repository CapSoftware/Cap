import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("agent token storage contract", () => {
	const source = readFileSync(
		join(process.cwd(), "lib/agent-token.ts"),
		"utf8",
	);

	it("consumes authorization codes atomically before issuing a token", () => {
		expect(source).toContain("verifyAgentCodeChallenge");
		expect(source).toContain(
			"isNull(Db.agentApiAuthorizationCodes.consumedAt)",
		);
		expect(source).toContain(
			"gt(Db.agentApiAuthorizationCodes.expiresAt, now)",
		);
		expect(source).toContain("getAffectedRows(consumed) !== 1");
		expect(source.indexOf("getAffectedRows(consumed) !== 1")).toBeLessThan(
			source.indexOf("createAgentAccessToken()"),
		);
	});

	it("stores only hashes of grants and access tokens", () => {
		expect(source).toMatch(/codeHash,\s+hashAgentSecret\(payload\.code\)/);
		expect(source).toContain("tokenHash: hashAgentSecret(accessToken)");
		expect(source).not.toContain("accessToken: Db.agentApiKeys");
		expect(source).not.toContain("code: Db.agentApiAuthorizationCodes");
	});

	it("never revokes a legacy desktop credential", () => {
		expect(source).toContain('principal.tokenKind !== "agent"');
		expect(source).not.toContain("Db.authApiKeys");
	});
});
