import * as Db from "@cap/database/schema";
import {
	CurrentUser,
	DatabaseError,
	ImageUpload,
	Organisation,
	User,
} from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import {
	type AnyMySqlColumn,
	MySqlDialect,
	type MySqlTable,
} from "drizzle-orm/mysql-core";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
	Database,
	type DbClient,
} from "../../../../packages/web-backend/src/Database";
import { ImageUploads } from "../../../../packages/web-backend/src/ImageUploads";
import { UsersOnboarding } from "../../../../packages/web-backend/src/Users/UsersOnboarding";

const USER_ID = User.UserId.make("onboarding-user");
const OTHER_USER_ID = User.UserId.make("different-owner");
const ORGANIZATION_ID = Organisation.OrganisationId.make("sso-org");
const DEFAULT_ORGANIZATION_ID =
	Organisation.OrganisationId.make("personal-org");
const ICON_KEY = ImageUpload.ImageKey.make("organizations/onboarding-icon.png");
const ICON = {
	data: new Uint8Array([1, 2, 3]),
	contentType: "image/png",
	fileName: "icon.png",
};

type Row = Record<string, unknown>;

function matchesRow(condition: SQL | undefined, row: Row) {
	if (!condition) return true;
	const query = new MySqlDialect().sqlToQuery(condition);
	let parameterIndex = 0;
	return query.sql
		.replaceAll("(", "")
		.replaceAll(")", "")
		.split(" and ")
		.every((clause) => {
			const match = /^`[^`]+`\.`([^`]+)`( = \?| is null)$/.exec(clause);
			if (!match?.[1]) throw new Error(`Unsupported predicate: ${clause}`);
			return match[2] === " is null"
				? row[match[1]] == null
				: row[match[1]] === query.params[parameterIndex++];
		});
}

function makeFixture(
	options: {
		user?: Partial<
			Pick<
				typeof Db.users.$inferSelect,
				"activeOrganizationId" | "defaultOrgId" | "name" | "onboardingSteps"
			>
		>;
		organization?: Partial<
			Pick<
				typeof Db.organizations.$inferSelect,
				"name" | "ownerId" | "tombstoneAt"
			>
		>;
		organizationExists?: boolean;
		sessionOrganizationId?: Organisation.OrganisationId;
	} = {},
) {
	const user: Row = {
		id: USER_ID,
		email: "member@example.com",
		name: "Member",
		activeOrganizationId: ORGANIZATION_ID,
		defaultOrgId: DEFAULT_ORGANIZATION_ID,
		onboardingSteps: { welcome: true, inviteTeam: true },
		...options.user,
	};
	const organization: Row = {
		id: ORGANIZATION_ID,
		name: "Company",
		ownerId: OTHER_USER_ID,
		tombstoneAt: null,
		iconUrl: null,
		...options.organization,
	};
	const organizations =
		options.organizationExists === false ? [] : [organization];
	const memberships: Row[] = [];
	const tables = new Map<MySqlTable, Row[]>([
		[Db.users, [user]],
		[Db.organizations, organizations],
		[Db.organizationMembers, memberships],
	]);
	const hooks: {
		beforeOrganizationUpdate?: (patch: Row) => void;
		beforeIconUpdate?: () => void;
	} = {};
	const uploadedPrefixes: string[] = [];
	const rowsFor = (table: MySqlTable) => {
		const rows = tables.get(table);
		if (!rows) throw new Error("Unexpected table");
		return rows;
	};
	const database = {
		select: (columns?: Record<string, AnyMySqlColumn>) => ({
			from: (table: MySqlTable) => ({
				where: async (condition: SQL | undefined) =>
					rowsFor(table)
						.filter((row) => matchesRow(condition, row))
						.map((row) =>
							columns
								? Object.fromEntries(
										Object.entries(columns).map(([key, column]) => [
											key,
											row[column.name],
										]),
									)
								: { ...row },
						),
			}),
		}),
		update: (table: MySqlTable) => ({
			set: (patch: Row) => ({
				where: async (condition: SQL | undefined) => {
					if (table === Db.organizations)
						hooks.beforeOrganizationUpdate?.(patch);
					for (const row of rowsFor(table)) {
						if (matchesRow(condition, row)) Object.assign(row, patch);
					}
				},
			}),
		}),
		insert: (table: MySqlTable) => ({
			values: async (row: Row) => {
				rowsFor(table).push({ tombstoneAt: null, ...row });
			},
		}),
		transaction: <T>(callback: (client: DbClient) => Promise<T>) =>
			callback(database as unknown as DbClient),
	};
	const databaseService = Database.make({
		use: (callback) =>
			Effect.tryPromise({
				try: () => callback(database as unknown as DbClient),
				catch: (cause) => new DatabaseError({ cause }),
			}),
	});
	const imageUploads = ImageUploads.make({
		applyUpdate: (args) =>
			Effect.gen(function* () {
				uploadedPrefixes.push(args.keyPrefix);
				hooks.beforeIconUpdate?.();
				yield* databaseService.use((client) => args.update(client, ICON_KEY));
			}),
		resolveImageUrl: () =>
			Effect.succeed(ImageUpload.ImageUrl.make("https://example.com/icon.png")),
	});

	return {
		user,
		organization,
		organizations,
		memberships,
		hooks,
		uploadedPrefixes,
		run: <A, E>(
			operation: (service: UsersOnboarding) => Effect.Effect<A, E, CurrentUser>,
		) =>
			Effect.runPromise(
				Effect.flatMap(UsersOnboarding, operation).pipe(
					Effect.provide(UsersOnboarding.DefaultWithoutDependencies),
					Effect.provideService(Database, databaseService),
					Effect.provideService(ImageUploads, imageUploads),
					Effect.provideService(CurrentUser, {
						id: USER_ID,
						email: "member@example.com",
						activeOrganizationId:
							options.sessionOrganizationId ?? ORGANIZATION_ID,
						iconUrlOrKey: Option.none(),
					}),
				),
			),
	};
}

describe("onboarding organization authorization", () => {
	it("lets members complete setup without changing organization metadata or their default", async () => {
		const fixture = makeFixture();

		const result = await fixture.run((service) =>
			service.organizationSetup({
				organizationName: "Replacement",
				organizationIcon: ICON,
			}),
		);

		expect(result).toEqual({ organizationId: ORGANIZATION_ID });
		expect(fixture.organization).toMatchObject({
			name: "Company",
			iconUrl: null,
		});
		expect(fixture.user).toMatchObject({
			activeOrganizationId: ORGANIZATION_ID,
			defaultOrgId: DEFAULT_ORGANIZATION_ID,
			onboardingSteps: {
				welcome: true,
				inviteTeam: true,
				organizationSetup: true,
			},
		});
		expect(fixture.uploadedPrefixes).toEqual([]);
		expect(fixture.organizations).toHaveLength(1);
		expect(fixture.memberships).toEqual([]);
	});

	it("preserves owner name and icon setup", async () => {
		const fixture = makeFixture({ organization: { ownerId: USER_ID } });

		await fixture.run((service) =>
			service.organizationSetup({
				organizationName: " New Company ",
				organizationIcon: ICON,
			}),
		);

		expect(fixture.organization).toMatchObject({
			name: "New Company",
			iconUrl: ICON_KEY,
		});
		expect(fixture.user.defaultOrgId).toBe(ORGANIZATION_ID);
		expect(fixture.uploadedPrefixes).toEqual([
			`organizations/${ORGANIZATION_ID}`,
		]);
	});

	it.each([
		{
			ownerId: USER_ID,
			tombstoneAt: null,
			expectedName: "Jane's Organization",
		},
		{
			ownerId: OTHER_USER_ID,
			tombstoneAt: null,
			expectedName: "My Organization",
		},
		{
			ownerId: USER_ID,
			tombstoneAt: new Date("2026-09-01T00:00:00.000Z"),
			expectedName: "My Organization",
		},
	])(
		"personalizes only a live owner's organization ($ownerId, $tombstoneAt)",
		async (scenario) => {
			const fixture = makeFixture({
				organization: {
					name: "My Organization",
					ownerId: scenario.ownerId,
					tombstoneAt: scenario.tombstoneAt,
				},
			});

			await fixture.run((service) =>
				service.welcome({ firstName: " Jane ", lastName: " Doe " }),
			);

			expect(fixture.organization.name).toBe(scenario.expectedName);
			expect(fixture.user).toMatchObject({
				name: "Jane",
				lastName: "Doe",
				onboardingSteps: { welcome: true, inviteTeam: true },
			});
		},
	);

	it("preserves an owner's already configured name during welcome", async () => {
		const fixture = makeFixture({ organization: { ownerId: USER_ID } });

		await fixture.run((service) => service.welcome({ firstName: "Jane" }));

		expect(fixture.organization.name).toBe("Company");
	});

	it("does not mutate or replace a tombstoned organization during setup", async () => {
		const fixture = makeFixture({
			organization: { ownerId: USER_ID, tombstoneAt: new Date() },
		});

		await fixture.run((service) =>
			service.organizationSetup({
				organizationName: "Replacement",
				organizationIcon: ICON,
			}),
		);

		expect(fixture.organization).toMatchObject({
			name: "Company",
			iconUrl: null,
		});
		expect(fixture.user.defaultOrgId).toBe(DEFAULT_ORGANIZATION_ID);
		expect(fixture.user.onboardingSteps).toMatchObject({
			organizationSetup: true,
		});
		expect(fixture.uploadedPrefixes).toEqual([]);
		expect(fixture.organizations).toHaveLength(1);
	});

	it.each(["ownership", "deletion"] as const)(
		"rechecks %s when applying the organization name",
		async (change) => {
			const fixture = makeFixture({ organization: { ownerId: USER_ID } });
			fixture.hooks.beforeOrganizationUpdate = () => {
				if (change === "ownership")
					fixture.organization.ownerId = OTHER_USER_ID;
				else fixture.organization.tombstoneAt = new Date();
			};

			await fixture.run((service) =>
				service.organizationSetup({
					organizationName: "Replacement",
					organizationIcon: ICON,
				}),
			);

			expect(fixture.organization).toMatchObject({
				name: "Company",
				iconUrl: null,
			});
			expect(fixture.uploadedPrefixes).toEqual([]);
		},
	);

	it.each(["ownership", "deletion"] as const)(
		"rechecks %s after the icon upload",
		async (change) => {
			const fixture = makeFixture({ organization: { ownerId: USER_ID } });
			fixture.hooks.beforeIconUpdate = () => {
				if (change === "ownership")
					fixture.organization.ownerId = OTHER_USER_ID;
				else fixture.organization.tombstoneAt = new Date();
			};

			await fixture.run((service) =>
				service.organizationSetup({
					organizationName: "Owner's Update",
					organizationIcon: ICON,
				}),
			);

			expect(fixture.organization).toMatchObject({
				name: "Owner's Update",
				iconUrl: null,
			});
			expect(fixture.uploadedPrefixes).toHaveLength(1);
		},
	);

	it("creates an owned organization for a user without one", async () => {
		const fixture = makeFixture({
			organizationExists: false,
			user: {
				activeOrganizationId: Organisation.OrganisationId.make(""),
				defaultOrgId: null,
			},
		});

		const result = await fixture.run((service) =>
			service.organizationSetup({
				organizationName: "New Company",
				organizationIcon: ICON,
			}),
		);

		expect(fixture.organizations).toEqual([
			expect.objectContaining({
				id: result.organizationId,
				name: "New Company",
				ownerId: USER_ID,
				iconUrl: ICON_KEY,
			}),
		]);
		expect(fixture.memberships).toEqual([
			expect.objectContaining({
				organizationId: result.organizationId,
				userId: USER_ID,
				role: "owner",
			}),
		]);
		expect(fixture.user).toMatchObject({
			activeOrganizationId: result.organizationId,
			defaultOrgId: result.organizationId,
		});
	});

	it.each(["active", "default"] as const)(
		"uses a member's stored %s organization when skipping onboarding",
		async (source) => {
			const fixture = makeFixture({
				sessionOrganizationId:
					Organisation.OrganisationId.make("stale-session-org"),
				user:
					source === "default"
						? {
								activeOrganizationId: Organisation.OrganisationId.make(""),
								defaultOrgId: ORGANIZATION_ID,
							}
						: {},
			});

			await fixture.run((service) => service.skipToDashboard());

			expect(fixture.organizations).toHaveLength(1);
			expect(fixture.organization.name).toBe("Company");
			expect(fixture.memberships).toEqual([]);
			expect(fixture.user.defaultOrgId).toBe(
				source === "default" ? ORGANIZATION_ID : DEFAULT_ORGANIZATION_ID,
			);
			expect(fixture.user.onboardingSteps).toMatchObject({
				organizationSetup: true,
				download: true,
			});
		},
	);
});
