import { Storage } from "@cap/web-domain";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { StorageRepo } from "../../../../packages/web-backend/src/Storage/StorageRepo";

const mocks = vi.hoisted(() => ({
	queries: [] as string[],
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	return {
		db: () =>
			drizzle(async (sql) => {
				mocks.queries.push(sql);
				return { rows: [{ affectedRows: 1 }] };
			}),
	};
});
vi.mock("@cap/database/crypto", () => ({
	encrypt: async (value: string) => `encrypted:${value}`,
}));

it("keeps updatedAt on Google Drive token cache writes so pickers still prefer the newest connection", async () => {
	const integrationId = Storage.StorageIntegrationId.make("integration-1");

	await Effect.gen(function* () {
		const repo = yield* StorageRepo;
		yield* repo.claimGoogleDriveTokenRefreshLease(
			integrationId,
			"lease-1",
			new Date("2026-11-02T00:00:15.000Z"),
		);
		yield* repo.saveGoogleDriveAccessTokenCache(integrationId, "lease-1", {
			accessToken: "access-token",
			expiresAt: new Date("2026-11-02T01:00:00.000Z"),
		});
		yield* repo.releaseGoogleDriveTokenRefreshLease(integrationId, "lease-1");
	}).pipe(Effect.provide(StorageRepo.Default), Effect.runPromise);

	expect(mocks.queries).toHaveLength(3);
	for (const sql of mocks.queries) {
		expect(sql).toMatch(/^update `storage_integrations` set /);
		expect(sql).toContain("`updatedAt` = `storage_integrations`.`updatedAt`");
	}
});
