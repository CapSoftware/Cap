import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
	NEXT_PUBLIC_IS_CAP: "true" as string | undefined,
}));

vi.mock("@cap/env", () => ({ buildEnv: env }));

import { canUseInfra } from "@/lib/infra-access";

describe("Cap Infra preview access", () => {
	beforeEach(() => {
		env.NEXT_PUBLIC_IS_CAP = "true";
	});

	it("lets a preview account in, whatever the letter case", () => {
		expect(canUseInfra("richie@cap.so")).toBe(true);
		expect(canUseInfra("Richie@Cap.so")).toBe(true);
	});

	it("keeps everyone else out on Cap's own deployment", () => {
		expect(canUseInfra("someone@example.com")).toBe(false);
		expect(canUseInfra("richie@cap.so.example.com")).toBe(false);
		expect(canUseInfra("")).toBe(false);
		expect(canUseInfra(null)).toBe(false);
		expect(canUseInfra(undefined)).toBe(false);
	});

	it("stays open on self-hosted deployments", () => {
		for (const value of ["false", "", undefined]) {
			env.NEXT_PUBLIC_IS_CAP = value;
			expect(canUseInfra("someone@example.com")).toBe(true);
		}
	});
});
