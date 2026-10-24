import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let allowInvoiceRequest: typeof import("@/lib/billing/request-limit").allowInvoiceRequest;
beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers();
	vi.setSystemTime(0);
	({ allowInvoiceRequest } = await import("@/lib/billing/request-limit"));
});
afterEach(() => vi.useRealTimers());
describe("invoice request backstop", () => {
	it("limits repeated requests while keeping separate users independent", () => {
		for (let i = 0; i < 30; i++)
			expect(allowInvoiceRequest("owner")).toBe(true);
		expect(allowInvoiceRequest("owner")).toBe(false);
		expect(allowInvoiceRequest("other")).toBe(true);
	});
	it("allows requests again after the window expires", () => {
		for (let i = 0; i < 30; i++) allowInvoiceRequest("owner");
		vi.advanceTimersByTime(60_000);
		expect(allowInvoiceRequest("owner")).toBe(true);
	});
	it("bounds retained user counters and clears expired entries", () => {
		for (let i = 0; i < 10_000; i++)
			expect(allowInvoiceRequest(`user_${i}`)).toBe(true);
		expect(allowInvoiceRequest("overflow")).toBe(false);
		vi.advanceTimersByTime(60_000);
		expect(allowInvoiceRequest("overflow")).toBe(true);
	});
});
