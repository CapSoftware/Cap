import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getInfraBilling: vi.fn() }));

vi.mock("@/lib/infra-standing", () => ({
	getInfraBilling: mocks.getInfraBilling,
	infraBillingJson: (billing: unknown) => ({ json: billing }),
}));

import { Agent } from "@cap/web-domain";
import { Schema } from "effect";
import {
	BILLING_ACCESS_HINT,
	developerAppBillingSection,
} from "@/lib/agent-developer-billing";
import { developerOpenApiSpec } from "@/lib/developer-openapi";

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

	it("returns the same storage fields as GET /usage", () => {
		const tiers = { "1080p": 87.5, "1440p": 0, "2160p": 0 };
		const restStorage =
			developerOpenApiSpec("https://cap.so").components.schemas.Usage.properties
				.storage;
		const storage = Object.fromEntries(
			restStorage.required.map((field: string) => [
				field,
				field.endsWith("ByTier") ? tiers : 170,
			]),
		);
		const billing = Schema.encodeSync(
			Agent.AgentDeveloperAppContextResponse.fields.billing,
		)({
			standing: { state: "active", pausesAt: null },
			upload: {
				allowed: true,
				reason: null,
				requiredMicroCredits: 1190,
				shortfallMicroCredits: 0,
				message: null,
			},
			storage: storage as never,
		});

		expect(Object.keys(billing?.storage ?? {}).sort()).toEqual(
			[...restStorage.required].sort(),
		);
		expect(restStorage.required).toContain("dailyChargeMinutesByTier");
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
