import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	agentMutationRequestHash,
	isAgentIdempotencyKey,
	isAgentWriteAccessEnabled,
} from "@/lib/agent-write";

vi.mock("server-only", () => ({}));

describe("agent write safety", () => {
	it("requires a separate production write switch", () => {
		expect(
			isAgentWriteAccessEnabled({
				nodeEnv: "production",
				enabled: undefined,
			}),
		).toBe(false);
		expect(
			isAgentWriteAccessEnabled({
				nodeEnv: "production",
				enabled: "true",
			}),
		).toBe(true);
		expect(
			isAgentWriteAccessEnabled({ nodeEnv: "test", enabled: undefined }),
		).toBe(true);
	});

	it("accepts bounded opaque idempotency keys", () => {
		expect(isAgentIdempotencyKey("0f64ed31-88d5-48bf-b364-a2af210dfa90")).toBe(
			true,
		);
		expect(isAgentIdempotencyKey("short")).toBe(false);
		expect(isAgentIdempotencyKey("contains a secret")).toBe(false);
	});

	it("keeps mutation identity independent of credential rotation", () => {
		const request = { videoId: "cap_test", title: "Updated" };
		const requestHash = agentMutationRequestHash("update_cap", request);
		expect(agentMutationRequestHash("update_cap", request)).toBe(requestHash);
		expect(
			agentMutationRequestHash("update_cap", {
				...request,
				title: "Different",
			}),
		).not.toBe(requestHash);
		expect(agentMutationRequestHash("delete_cap", request)).not.toBe(
			requestHash,
		);
	});

	it("completes the mutation and idempotency record in one transaction", () => {
		const source = readFileSync(
			join(process.cwd(), "lib/agent-write.ts"),
			"utf8",
		);
		expect(source).toContain('.for("update")');
		expect(source).toContain("completeIdempotency(tx");
		expect(source).toContain("releaseIdempotency(tx");
		expect(source).toContain('state: "complete"');
		expect(source).toContain("titleManuallyEdited: true");
		expect(source).not.toContain("console.log");
	});

	it("serializes external retries and releases failed attempts", () => {
		const source = readFileSync(
			join(process.cwd(), "lib/agent-write.ts"),
			"utf8",
		);
		expect(source).toContain('return { state: "pending" as const }');
		expect(source).toContain("Effect.tapErrorCause");
		expect(source).toContain(".delete(Db.agentApiIdempotency)");
		expect(source).toContain("record.expiresAt.getTime() <= Date.now()");
		expect(source).toContain('Schedule.exponential("25 millis")');
	});
});
