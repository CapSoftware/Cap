import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: null as {
		id: string;
		stripeSubscriptionStatus?: string | null;
	} | null,
	canManage: true,
	updates: [] as unknown[],
	revalidated: [] as string[],
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: true },
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));

vi.mock("next/cache", () => ({
	revalidatePath: (path: string) => {
		mocks.revalidated.push(path);
	},
}));

vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationSettingsManager: async () => {
		if (!mocks.canManage) {
			throw new Error(
				"Only admins and owners can manage organization settings",
			);
		}
		return { role: "admin" };
	},
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		update: () => ({
			set: (values: unknown) => ({
				where: async () => {
					mocks.updates.push(values);
				},
			}),
		}),
	}),
}));

import type { Organisation } from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { updateOrganizationCallToAction } from "@/actions/organization/default-call-to-action";

const organizationId = "org123" as Organisation.OrganisationId;

const render = (index = 0) =>
	new MySqlDialect().sqlToQuery(
		(mocks.updates[index] as { settings: SQL }).settings,
	);

describe("updateOrganizationCallToAction", () => {
	beforeEach(() => {
		mocks.user = { id: "admin", stripeSubscriptionStatus: "active" };
		mocks.canManage = true;
		mocks.updates = [];
		mocks.revalidated = [];
	});

	it("requires a signed-in user", async () => {
		mocks.user = null;
		await expect(
			updateOrganizationCallToAction(organizationId, {
				label: "Go",
				url: "example.com",
			}),
		).rejects.toThrow("Unauthorized");
		expect(mocks.updates).toHaveLength(0);
	});

	it.each([{ label: "Go", url: "example.com" }, null])(
		"only lets admins and owners change it: %j",
		async (input) => {
			mocks.canManage = false;
			await expect(
				updateOrganizationCallToAction(organizationId, input),
			).rejects.toThrow("admins and owners");
			expect(mocks.updates).toHaveLength(0);
		},
	);

	it("requires Pro to set a default", async () => {
		mocks.user = { id: "admin", stripeSubscriptionStatus: null };
		await expect(
			updateOrganizationCallToAction(organizationId, {
				label: "Go",
				url: "example.com",
			}),
		).resolves.toEqual({ success: false, errors: {}, upgradeRequired: true });
		expect(mocks.updates).toHaveLength(0);
	});

	it("lets anyone who manages settings remove it, Pro or not", async () => {
		mocks.user = { id: "admin", stripeSubscriptionStatus: null };
		await expect(
			updateOrganizationCallToAction(organizationId, null),
		).resolves.toEqual({ success: true, callToAction: null });
		const query = render();
		expect(query.sql).toContain(
			"JSON_REMOVE(CASE WHEN JSON_TYPE(`organizations`.`settings`) = 'OBJECT'",
		);
		expect(query.sql).toContain("'$.defaultCallToAction'");
		expect(mocks.revalidated).toContain(
			"/dashboard/settings/organization/preferences",
		);
	});

	it("returns field errors without writing invalid input", async () => {
		const result = await updateOrganizationCallToAction(organizationId, {
			label: "",
			url: "javascript:alert(1)",
		});
		expect(result.success).toBe(false);
		expect(mocks.updates).toHaveLength(0);
	});

	it("stores the normalized default and keeps the original start time", async () => {
		const result = await updateOrganizationCallToAction(organizationId, {
			label: "  Talk   to sales ",
			url: "example.com/sales",
			color: "#12a150",
			showWhilePlaying: false,
			includeExisting: true,
		});
		expect(result).toEqual({
			success: true,
			callToAction: {
				label: "Talk to sales",
				url: "https://example.com/sales",
				headline: null,
				color: "#12A150",
				showWhilePlaying: false,
			},
		});
		const query = render();
		expect(query.sql).toContain("JSON_SET(CASE WHEN JSON_TYPE(");
		expect(query.sql).toContain(
			"COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`organizations`.`settings`, '$.defaultCallToAction.enabledAt')), ?)",
		);
		expect(JSON.parse(String(query.params[0]))).toEqual({
			label: "Talk to sales",
			url: "https://example.com/sales",
			color: "#12A150",
			showWhilePlaying: false,
			includeExisting: true,
		});
		expect(Number.isNaN(Date.parse(String(query.params[1])))).toBe(false);
	});

	it("only covers new videos unless asked", async () => {
		await updateOrganizationCallToAction(organizationId, {
			label: "Go",
			url: "example.com",
		});
		expect(JSON.parse(String(render().params[0])).includeExisting).toBe(false);
	});
});
