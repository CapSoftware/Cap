import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import { organizationSettingsKeepingRowOwnedKeys } from "@/lib/organization-settings-write";

const render = (
	settings: Parameters<typeof organizationSettingsKeepingRowOwnedKeys>[0],
) =>
	new MySqlDialect().sqlToQuery(
		organizationSettingsKeepingRowOwnedKeys(settings),
	);

describe("organization settings writes", () => {
	it("reads the link override from the row instead of the submitted snapshot", () => {
		const query = render({
			disableComments: true,
			allowPublicLinkOverride: true,
		});

		expect(query.params).toEqual(['{"disableComments":true}']);
		expect(query.sql).toContain(
			"'allowPublicLinkOverride', JSON_EXTRACT(`organizations`.`settings`, '$.allowPublicLinkOverride')",
		);
	});

	it("reads the default call to action from the row instead of the submitted snapshot", () => {
		const query = render({
			disableComments: true,
			defaultCallToAction: {
				label: "Stale",
				url: "https://example.com/",
				enabledAt: "2026-01-01T00:00:00.000Z",
			},
		});

		expect(query.params).toEqual(['{"disableComments":true}']);
		expect(query.sql).toContain(
			"'defaultCallToAction', JSON_EXTRACT(`organizations`.`settings`, '$.defaultCallToAction')",
		);
	});

	it("writes every other submitted key", () => {
		expect(
			render({ disableSummary: false, defaultPlaybackSpeed: 1.5 }).params,
		).toEqual(['{"disableSummary":false,"defaultPlaybackSpeed":1.5}']);
	});
});
