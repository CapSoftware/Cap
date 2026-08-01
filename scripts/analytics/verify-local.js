#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import process from "node:process";

const fixtureDates = JSON.parse(
	fs.readFileSync(
		new URL("tinybird/fixtures/local-dates.json", import.meta.url),
		"utf8",
	),
);
const firstDate = fixtureDates["2099-01-10"];
const secondDate = fixtureDates["2099-01-11"];
const thirdDate = fixtureDates["2099-01-12"];
if (!firstDate || !secondDate || !thirdDate) {
	throw new Error("Local Tinybird fixture dates are missing");
}

const origin = process.env.PRODUCT_ANALYTICS_TINYBIRD_HOST;
const token = process.env.PRODUCT_ANALYTICS_TINYBIRD_TOKEN;
if (!origin || !token) {
	throw new Error("Local Tinybird verification credentials are missing");
}

const query = async (pipe, parameters) => {
	const url = new URL(`/v0/pipes/${pipe}.json`, origin);
	for (const [name, value] of Object.entries(parameters)) {
		url.searchParams.set(name, value);
	}
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		throw new Error(`${pipe} returned HTTP ${response.status}`);
	}
	const payload = await response.json();
	return payload.data ?? [];
};

const daily = await query("product_events_daily", {
	start_date: firstDate,
	end_date: firstDate,
	event_name: "recording_started",
	country: "US",
});
assert.equal(daily.length, 1);
assert.equal(Number(daily[0].events), 1);
assert.equal(Number(daily[0].users), 1);
assert.equal(Number(daily[0].organizations), 1);

const traffic = await query("product_traffic_overview", {
	start_date: firstDate,
	end_date: firstDate,
	hostname: "cap.so",
});
assert.equal(traffic.length, 1);
assert.equal(Number(traffic[0].visitors), 2);
assert.equal(Number(traffic[0].visits), 2);
assert.equal(Number(traffic[0].pageviews), 3);

const pages = await query("product_traffic_pages", {
	start_date: firstDate,
	end_date: firstDate,
	hostname: "cap.so",
});
assert.deepEqual(pages.map((row) => row.pathname).sort(), [
	"/",
	"/download",
	"/pricing",
]);
assert.equal(
	pages.reduce((total, row) => total + Number(row.pageviews), 0),
	3,
);

const retention = await query("product_creator_retention", {
	start_date: firstDate,
	end_date: firstDate,
});
const normalizedRetention = retention.map((row) => ({
	cohortDay: Number(row.cohort_day),
	platform: row.platform,
	creators: Number(row.creators),
}));
assert.deepEqual(normalizedRetention, [
	{ cohortDay: 0, platform: "all", creators: 1 },
	{ cohortDay: 1, platform: "all", creators: 1 },
]);
assert.ok(normalizedRetention[1].creators <= normalizedRetention[0].creators);

const featureAdoption = await query("product_feature_adoption", {
	start_date: thirdDate,
	end_date: thirdDate,
	event_name: "checkout_started",
});
assert.deepEqual(
	featureAdoption.map((row) => ({
		eventName: row.event_name,
		events: Number(row.events),
		actorDays: Number(row.actor_days),
		userDays: Number(row.user_days),
		organizationDays: Number(row.organization_days),
	})),
	[
		{
			eventName: "checkout_started",
			events: 2,
			actorDays: 1,
			userDays: 1,
			organizationDays: 1,
		},
	],
);

const health = await query("product_events_health", {
	start_time: `${firstDate} 00:00:00.000`,
	end_time: `${thirdDate} 23:59:59.999`,
});
assert.equal(health.length, 1);
assert.ok(Number(health[0].received_rows) >= 15);
assert.equal(Number(health[0].unique_events), 15);
assert.equal(Number(health[0].unique_payloads), 15);
assert.equal(
	Number(health[0].duplicate_rows),
	Number(health[0].received_rows) - 15,
);
assert.equal(Number(health[0].payload_conflicts), 0);

const copyAssertions = await query("product_analytics_copy_assertions", {
	copy_run_id: "run_local_copy_assertions",
});
assert.deepEqual(copyAssertions, [
	{
		decision_markers: 1,
		traffic_markers: 1,
		traffic_page_markers: 1,
		activation_markers: 1,
		retention_markers: 1,
		identity_markers: 1,
		attribution_markers: 1,
		experiment_markers: 1,
		health_markers: 1,
	},
]);

console.log(
	"Local Tinybird copies and typed endpoints match fixture semantics.",
);
