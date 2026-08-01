import { describe, expect, it } from "vitest";
import {
	createSyntheticDecisionEvents,
	createSyntheticErasureControl,
	createSyntheticEvents,
	createSyntheticLoadEvents,
} from "../../../scripts/analytics/staging-ci-lib.js";
import {
	getProductEventDefinition,
	normalizeAcquisitionChannel,
	normalizeProductEventProperties,
} from "./index";

const validateRow = (row) => {
	const definition = getProductEventDefinition(row.event_name);
	const properties = JSON.parse(row.properties);
	if (row.schema_version < definition.version) {
		expect(row.event_name).toBe("subscription_renewed");
		expect(row.schema_version).toBe(1);
		expect(properties).toEqual({
			amount_paid_minor: 1_000,
			currency: "gbp",
			billing_reason: "subscription_cycle",
		});
		return;
	}
	const normalized = normalizeProductEventProperties(
		row.event_name,
		properties,
	);
	if (normalized === null) {
		throw new Error(
			`Invalid staging fixture properties for ${row.event_name} in ${row.app_version}: ${row.properties}`,
		);
	}

	expect(definition.version).toBe(row.schema_version);
	expect(definition.platforms).toContain(row.platform);
	expect(
		definition.authority === "both" || definition.authority === row.source,
	).toBe(true);
	expect(normalized ?? {}).toEqual(properties);
	expect(
		normalizeAcquisitionChannel(normalized, row.referrer),
		`${row.event_name}:${row.event_id}`,
	).toBe(row.channel);
};

describe("analytics staging fixtures", () => {
	it("uses only registry-valid production event shapes", () => {
		const runId = "run_12345678";
		const now = new Date("2026-07-31T10:00:00.000Z");
		const delivery = createSyntheticEvents({ runId, now });
		const control = createSyntheticErasureControl({ runId, now });
		const decisions = createSyntheticDecisionEvents({ runId, now });
		const load = createSyntheticLoadEvents({ runId, count: 100, now });

		for (const row of [
			...delivery.rows,
			control.row,
			...decisions.rows,
			...load.rows,
		]) {
			validateRow(row);
		}
	});
});
