import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import { organizationSettingsKeepingLinkOverride } from "@/lib/organization-settings-write";

const render = (
	settings: Parameters<typeof organizationSettingsKeepingLinkOverride>[0],
) =>
	new MySqlDialect().sqlToQuery(
		organizationSettingsKeepingLinkOverride(settings),
	);

describe("organization settings writes", () => {
	it("reads the link override from the row instead of the submitted snapshot", () => {
		const query = render({
			disableComments: true,
			allowPublicLinkOverride: true,
		});

		expect(query.params).toEqual(['{"disableComments":true}']);
		expect(query.sql).toContain(
			"JSON_OBJECT('allowPublicLinkOverride', JSON_EXTRACT(`organizations`.`settings`, '$.allowPublicLinkOverride'))",
		);
	});

	it("writes every other submitted key", () => {
		expect(
			render({ disableSummary: false, defaultPlaybackSpeed: 1.5 }).params,
		).toEqual(['{"disableSummary":false,"defaultPlaybackSpeed":1.5}']);
	});
});
