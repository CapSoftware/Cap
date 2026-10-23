import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Organisation, User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => {
	const state = { rows: [] as unknown[] };
	const onDuplicateKeyUpdate = vi.fn(
		async (_input: { set: Record<string, unknown> }) => undefined,
	);
	const values = vi.fn(() => ({ onDuplicateKeyUpdate }));
	const insert = vi.fn(() => ({ values }));
	const orderBy = vi.fn(async () => state.rows);
	const limit = vi.fn(async () => state.rows);
	const forUpdate = vi.fn(async () => state.rows);
	const where = vi.fn(() => ({ orderBy, limit, for: forUpdate }));
	const from = vi.fn(() => ({ where }));
	const select = vi.fn(() => ({ from }));
	const updateWhere = vi.fn(async () => undefined);
	const set = vi.fn(() => ({ where: updateWhere }));
	const update = vi.fn(() => ({ set }));
	const transaction = vi.fn(
		async (
			callback: (tx: {
				insert: typeof insert;
				select: typeof select;
				update: typeof update;
			}) => Promise<unknown>,
		) => callback({ insert, select, update }),
	);
	const deleteWhere = vi.fn(async () => undefined);
	const deleteRows = vi.fn(() => ({ where: deleteWhere }));

	return {
		state,
		onDuplicateKeyUpdate,
		values,
		insert,
		orderBy,
		limit,
		forUpdate,
		where,
		from,
		select,
		updateWhere,
		set,
		update,
		transaction,
		deleteWhere,
		deleteRows,
	};
});

const cryptoMocks = vi.hoisted(() => ({
	decrypt: vi.fn(),
	encrypt: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		insert: databaseMocks.insert,
		select: databaseMocks.select,
		update: databaseMocks.update,
		delete: databaseMocks.deleteRows,
		transaction: databaseMocks.transaction,
	}),
}));

vi.mock("@cap/database/crypto", () => cryptoMocks);
vi.mock("@cap/database/helpers", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/database/helpers")>();
	return {
		...actual,
		nanoId: () => "installation123",
	};
});

import {
	deleteIntegrationInstallation,
	deleteIntegrationInstallationByExternalId,
	getIntegrationCredentials,
	listIntegrationInstallations,
	saveIntegrationInstallation,
} from "@/lib/integrations/installations";

const organizationId = Organisation.OrganisationId.make("org123");
const installedByUserId = User.UserId.make("user123");

describe("integration installation repository", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		databaseMocks.state.rows = [];
		cryptoMocks.encrypt.mockResolvedValue("encrypted-credentials");
		cryptoMocks.decrypt.mockResolvedValue("{}");
	});

	it("updates credentials only after locking the owning tenant installation", async () => {
		databaseMocks.state.rows = [
			{
				id: "existing-installation",
				organizationId,
			},
		];

		await saveIntegrationInstallation({
			provider: "slack",
			externalId: "T123",
			displayName: "Cap",
			organizationId,
			installedByUserId,
			credentials: { accessToken: "xoxb-token" },
			metadata: { scopes: ["links:read"] },
		});

		expect(cryptoMocks.encrypt).toHaveBeenCalledWith(
			JSON.stringify({ accessToken: "xoxb-token" }),
		);
		expect(databaseMocks.values).toHaveBeenCalledWith({
			id: "installation123",
			provider: "slack",
			externalId: "T123",
			displayName: "Cap",
			organizationId,
			installedByUserId,
			encryptedCredentials: "encrypted-credentials",
			metadata: { scopes: ["links:read"] },
		});

		expect(databaseMocks.onDuplicateKeyUpdate).toHaveBeenCalledOnce();
		const [upsert] = databaseMocks.onDuplicateKeyUpdate.mock.calls[0] ?? [];
		expect(upsert?.set).toEqual({
			externalId: expect.anything(),
		});
		expect(upsert?.set).not.toHaveProperty("organizationId");
		expect(databaseMocks.forUpdate).toHaveBeenCalledWith("update");
		expect(databaseMocks.set).toHaveBeenCalledWith({
			displayName: "Cap",
			installedByUserId,
			encryptedCredentials: "encrypted-credentials",
			metadata: { scopes: ["links:read"] },
			updatedAt: expect.any(Date),
		});
		expect(databaseMocks.updateWhere).toHaveBeenCalledOnce();
	});

	it("rejects an installation already owned by another organization", async () => {
		databaseMocks.state.rows = [
			{
				id: "existing-installation",
				organizationId: Organisation.OrganisationId.make("other-org"),
			},
		];

		await expect(
			saveIntegrationInstallation({
				provider: "slack",
				externalId: "T123",
				displayName: "Cap",
				organizationId,
				installedByUserId,
				credentials: { accessToken: "xoxb-token" },
				metadata: { scopes: ["links:read"] },
			}),
		).rejects.toThrow(
			"Integration is already connected to another organization",
		);
		expect(databaseMocks.set).not.toHaveBeenCalled();
	});

	it("ships a provider-agnostic schema with workload-matched indexes", () => {
		const migration = readFileSync(
			join(
				process.cwd(),
				"../../packages/database/migrations/0037_integration_installations.sql",
			),
			"utf8",
		);

		expect(migration).toContain("CREATE TABLE `integration_installations`");
		expect(migration).toContain(
			"CONSTRAINT `provider_external_id_idx` UNIQUE(`provider`,`externalId`)",
		);
		expect(migration).toContain(
			"CREATE INDEX `organization_provider_display_name_idx` ON `integration_installations` (`organizationId`,`provider`,`displayName`)",
		);
		expect(migration).not.toContain("slack_installations");
		expect(migration).not.toContain("encryptedBotToken");
	});

	it("lists only the non-secret installation summary shape", async () => {
		const rows = [
			{
				id: "installation123",
				externalId: "T123",
				displayName: "Cap",
				createdAt: new Date("2026-01-01T00:00:00Z"),
				updatedAt: new Date("2026-01-02T00:00:00Z"),
			},
		];
		databaseMocks.state.rows = rows;

		await expect(
			listIntegrationInstallations({
				organizationId,
				provider: "slack",
			}),
		).resolves.toEqual(rows);
		expect(databaseMocks.orderBy).toHaveBeenCalledOnce();
	});

	it("decrypts and parses credentials only after an exact lookup", async () => {
		databaseMocks.state.rows = [
			{ encryptedCredentials: "encrypted-credentials" },
		];
		cryptoMocks.decrypt.mockResolvedValue(
			JSON.stringify({ accessToken: "xoxb-token" }),
		);

		await expect(
			getIntegrationCredentials({
				provider: "slack",
				externalId: "T123",
			}),
		).resolves.toEqual({ accessToken: "xoxb-token" });
		expect(cryptoMocks.decrypt).toHaveBeenCalledWith("encrypted-credentials");
		expect(databaseMocks.limit).toHaveBeenCalledWith(1);

		databaseMocks.state.rows = [];
		await expect(
			getIntegrationCredentials({
				provider: "slack",
				externalId: "missing",
			}),
		).resolves.toBeNull();
	});

	it("fails closed when encrypted credentials are malformed", async () => {
		databaseMocks.state.rows = [
			{ encryptedCredentials: "encrypted-credentials" },
		];
		cryptoMocks.decrypt.mockResolvedValue("not-json");

		await expect(
			getIntegrationCredentials({
				provider: "slack",
				externalId: "T123",
			}),
		).rejects.toThrow();
	});

	it("supports tenant-scoped disconnects and provider-scoped uninstalls", async () => {
		await deleteIntegrationInstallation({
			provider: "slack",
			organizationId,
			installationId: "installation123",
		});
		await deleteIntegrationInstallationByExternalId({
			provider: "slack",
			externalId: "T123",
		});

		expect(databaseMocks.deleteRows).toHaveBeenCalledTimes(2);
		expect(databaseMocks.deleteWhere).toHaveBeenCalledTimes(2);
	});
});
