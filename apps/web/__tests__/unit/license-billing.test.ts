import { getLicenseCustomerIds } from "@cap/database/billing/license-customers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	connect: vi.fn(),
	execute: vi.fn(),
	destroy: vi.fn(),
}));
vi.mock("mysql2/promise", () => ({ createConnection: mocks.connect }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		LICENSE_DATABASE_URL: "mysql://reader:example@database.example.com/license",
	}),
}));
beforeEach(() => {
	vi.useFakeTimers();
	mocks.connect.mockResolvedValue({
		execute: mocks.execute,
		destroy: mocks.destroy,
	});
	mocks.execute.mockResolvedValue([[{ stripeId: "cus_license" }], []]);
});
afterEach(() => vi.useRealTimers());
describe("license invoice database reader", () => {
	it("binds the email, verifies TLS and releases successful connections", async () => {
		expect(await getLicenseCustomerIds("owner@example.com")).toEqual([
			"cus_license",
		]);
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.stringContaining("WHERE u.email = ?"),
			["owner@example.com"],
		);
		expect(mocks.connect).toHaveBeenCalledWith(
			expect.objectContaining({
				ssl: { rejectUnauthorized: true },
				connectTimeout: 5000,
			}),
		);
		expect(mocks.destroy).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("bounds a stalled read and destroys its connection", async () => {
		mocks.execute.mockReturnValueOnce(new Promise(() => {}));
		const result = expect(
			getLicenseCustomerIds("owner@example.com"),
		).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(5000);
		await result;
		expect(mocks.destroy).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("releases the connection after a query error", async () => {
		mocks.execute.mockRejectedValueOnce(new Error("Unavailable"));
		await expect(getLicenseCustomerIds("owner@example.com")).rejects.toThrow(
			"Unavailable",
		);
		expect(mocks.destroy).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});
