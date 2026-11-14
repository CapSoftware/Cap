import { describe, expect, it } from "vitest";

import { canUseInfra } from "@/lib/infra-access";

describe("Cap Infra access", () => {
	it("is open to every signed-in account", () => {
		expect(canUseInfra("richie@cap.so")).toBe(true);
		expect(canUseInfra("someone@example.com")).toBe(true);
		expect(canUseInfra("Someone@Example.com")).toBe(true);
	});

	it("reports open access when asked without an account", () => {
		expect(canUseInfra(null)).toBe(true);
		expect(canUseInfra(undefined)).toBe(true);
		expect(canUseInfra("")).toBe(true);
	});
});
