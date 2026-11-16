import type { Organisation } from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	readOrganizationIds: [] as unknown[],
	updates: [] as { organizationId: unknown; values: unknown }[],
	requireOrganizationSettingsManager: vi.fn(async () => ({})),
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
	...(await importOriginal<typeof import("drizzle-orm")>()),
	eq: (_column: unknown, value: unknown) => value,
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({
		id: "user",
		activeOrganizationId: "org-switched-to",
	}),
}));

vi.mock("@cap/utils", () => ({ userIsPro: () => true }));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: async (organizationId: unknown) => {
					mocks.readOrganizationIds.push(organizationId);
					return [{ id: organizationId, settings: {} }];
				},
			}),
		}),
		update: () => ({
			set: (values: unknown) => ({
				where: async (organizationId: unknown) => {
					mocks.updates.push({ organizationId, values });
				},
			}),
		}),
	}),
}));

vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationSettingsManager: mocks.requireOrganizationSettingsManager,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { updateDefaultVideoVisibility } from "@/actions/organization/default-video-visibility";
import { updateOrganizationSettings } from "@/actions/organization/settings";

const editedOrganizationId = "org-on-screen" as Organisation.OrganisationId;

describe("organization preference actions", () => {
	beforeEach(() => {
		mocks.readOrganizationIds = [];
		mocks.updates = [];
		mocks.requireOrganizationSettingsManager.mockClear();
	});

	it("saves viewer settings to the organization being edited after the active organization changes", async () => {
		await updateOrganizationSettings(
			{ disableComments: true },
			editedOrganizationId,
		);

		expect(mocks.requireOrganizationSettingsManager).toHaveBeenCalledWith(
			"user",
			editedOrganizationId,
		);
		expect(mocks.readOrganizationIds).toEqual([editedOrganizationId]);
		expect(mocks.updates).toHaveLength(1);
		expect(mocks.updates[0]?.organizationId).toBe(editedOrganizationId);
		expect(
			new MySqlDialect().sqlToQuery(
				(mocks.updates[0]?.values as { settings: SQL }).settings,
			).params,
		).toEqual(['{"disableComments":true}']);
	});

	it("saves the sharing default to the organization being edited after the active organization changes", async () => {
		await updateDefaultVideoVisibility(true, editedOrganizationId);

		expect(mocks.requireOrganizationSettingsManager).toHaveBeenCalledWith(
			"user",
			editedOrganizationId,
		);
		expect(mocks.updates).toEqual([
			{
				organizationId: editedOrganizationId,
				values: { defaultVideoVisibility: "private" },
			},
		]);
	});
});
