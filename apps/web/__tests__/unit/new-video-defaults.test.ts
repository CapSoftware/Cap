import { type DbClient, resolveNewVideoDefaults } from "@cap/web-backend";
import type { Organisation } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ defaultPublic: true }));

vi.mock("@cap/env", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/env")>()),
	serverEnv: () => ({ CAP_VIDEOS_DEFAULT_PUBLIC: env.defaultPublic }),
}));

type OrganizationRow = {
	settings: { defaultVideoPublic?: boolean } | null;
	defaultVideoPassword: string | null;
};

const dbReturning = (rows: OrganizationRow[]) =>
	({
		select: () => ({ from: () => ({ where: async () => rows }) }),
	}) as unknown as DbClient;

const orgId = "org-1" as Organisation.OrganisationId;

describe("resolveNewVideoDefaults", () => {
	beforeEach(() => {
		env.defaultPublic = true;
	});

	it("falls back to the env default when the organization row is missing", async () => {
		expect(await resolveNewVideoDefaults(dbReturning([]), orgId)).toEqual({
			public: true,
			password: null,
		});

		env.defaultPublic = false;

		expect(await resolveNewVideoDefaults(dbReturning([]), orgId)).toEqual({
			public: false,
			password: null,
		});
	});

	it("prefers the organization setting over the env default", async () => {
		const db = dbReturning([
			{ settings: { defaultVideoPublic: false }, defaultVideoPassword: null },
		]);

		expect(await resolveNewVideoDefaults(db, orgId)).toEqual({
			public: false,
			password: null,
		});
	});

	it("passes the stored password hash through", async () => {
		const db = dbReturning([
			{ settings: null, defaultVideoPassword: "hashed-password" },
		]);

		expect(await resolveNewVideoDefaults(db, orgId)).toEqual({
			public: true,
			password: "hashed-password",
		});
	});
});
