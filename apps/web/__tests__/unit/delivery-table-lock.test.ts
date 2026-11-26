import { beforeEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => ({
	query: vi.fn(),
	end: vi.fn(async () => {}),
}));

vi.mock("mysql2/promise", () => ({
	createConnection: vi.fn(async () => connection),
}));

const { lockDeliveryTable } = await import("../fixtures/delivery-table-lock");

describe("lockDeliveryTable", () => {
	beforeEach(() => {
		connection.query.mockReset();
		connection.end.mockClear();
	});

	it("closes its connection when the lock query fails", async () => {
		connection.query.mockRejectedValue(new Error("connection lost"));

		await expect(lockDeliveryTable("mysql://test")).rejects.toThrow(
			"connection lost",
		);
		expect(connection.end).toHaveBeenCalledTimes(1);
	});

	it("closes its connection and says so when the lock is not acquired", async () => {
		connection.query.mockResolvedValue([[{ acquired: 0 }]]);

		await expect(lockDeliveryTable("mysql://test")).rejects.toThrow(
			/held the infra_delivery_daily_table lock/,
		);
		expect(connection.end).toHaveBeenCalledTimes(1);
	});

	it("keeps the connection until the lock is released", async () => {
		connection.query.mockResolvedValue([[{ acquired: 1 }]]);

		const release = await lockDeliveryTable("mysql://test");
		expect(connection.end).not.toHaveBeenCalled();

		await release();
		expect(connection.query).toHaveBeenLastCalledWith(
			"SELECT RELEASE_LOCK(?)",
			["infra_delivery_daily_table"],
		);
		expect(connection.end).toHaveBeenCalledTimes(1);
	});
});
