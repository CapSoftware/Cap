import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	syntheticStagingEventIds,
	syntheticStagingIdentities,
} from "@/lib/analytics/staging-test-identities";

describe("staging analytics synthetic identities", () => {
	it("scopes the generated Stripe purchase identifier", () => {
		const runId = "run_staging_server";
		const hash = createHash("sha256").update(runId).digest("hex");
		expect(syntheticStagingIdentities(runId).hash).toBe(hash);
		expect(syntheticStagingEventIds(runId)).toContain(
			`stripe:staging_ambiguous_${hash.slice(0, 24)}:purchase_completed`,
		);
		expect(syntheticStagingEventIds(runId)).not.toContain(
			`staging_ambiguous_${hash.slice(0, 24)}`,
		);
	});
});
