import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getInfraBilling: vi.fn() }));

vi.mock("@/lib/infra-standing", () => ({
	getInfraBilling: mocks.getInfraBilling,
	infraBillingJson: (billing: unknown) => ({ json: billing }),
}));

import {
	BILLING_ACCESS_HINT,
	developerAppBillingSection,
} from "@/lib/agent-developer-billing";

const credits = {
	balanceMicroCredits: 500_000,
	autoTopUpEnabled: true,
	autoTopUpThresholdMicroCredits: 100_000,
	autoTopUpAmountCents: 2500,
	cardSaved: true,
};

const section = (scopes: string[]) =>
	developerAppBillingSection({
		scopes: new Set(scopes),
		appId: "app-1",
		credits,
	});

beforeEach(() => {
	mocks.getInfraBilling.mockReset();
	mocks.getInfraBilling.mockResolvedValue("billing");
});

describe("billing data in the developer app context", () => {
	it("is withheld from a token with developer:read only, without reading it", async () => {
		expect(await section(["developer:read"])).toEqual({
			credits: null,
			billing: null,
			billingHint: BILLING_ACCESS_HINT,
		});
		expect(mocks.getInfraBilling).not.toHaveBeenCalled();
	});

	it("is returned to a token that also holds billing:read", async () => {
		expect(await section(["developer:read", "billing:read"])).toEqual({
			credits,
			billing: { json: "billing" },
			billingHint: null,
		});
		expect(mocks.getInfraBilling).toHaveBeenCalledWith("app-1");
	});

	it("is not granted by billing:write alone", async () => {
		expect((await section(["developer:read", "billing:write"])).billing).toBe(
			null,
		);
	});

	it("is the only way the app context handler returns credits or billing", () => {
		const route = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const start = route.indexOf('.handle("getDeveloperAppContext"');
		const handler = route.slice(start, route.indexOf(".handle(", start + 10));

		expect(handler).toContain("developerAppBillingSection({");
		expect(handler).toContain("scopes: principal.scopes");
		expect(handler).not.toMatch(/credits: context\.credits,\s*\n\s*billing/);
		expect(handler).not.toContain("getInfraBilling(");
	});
});
