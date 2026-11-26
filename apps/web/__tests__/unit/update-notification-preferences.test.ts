import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ values: [] as Record<string, unknown>[] }));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({
		id: "usr_synthetic",
		preferences: { mediaInputPolicy: { strikes: [], suspendedAt: "x" } },
	}),
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		update: () => ({
			set: (values: Record<string, unknown>) => {
				state.values.push(values);
				return { where: async () => undefined };
			},
		}),
	}),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { updatePreferences } from "@/actions/notifications/update-preferences";

describe("updatePreferences", () => {
	it("writes only the notification settings path", async () => {
		const notifications = {
			pauseComments: true,
			pauseReplies: false,
			pauseViews: false,
			pauseReactions: false,
		};
		await updatePreferences({ notifications });

		const query = new MySqlDialect().sqlToQuery(
			state.values[0]?.preferences as SQL,
		);
		expect(query.sql).toContain("JSON_SET");
		expect(query.sql).toContain("'$.notifications'");
		expect(query.params).toContain(JSON.stringify(notifications));
		expect(JSON.stringify(query.params)).not.toContain("mediaInputPolicy");
	});
});
