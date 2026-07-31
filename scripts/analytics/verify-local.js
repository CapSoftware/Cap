#!/usr/bin/env node

import assert from "node:assert/strict";
import process from "node:process";

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
	start_date: "2026-01-10",
	end_date: "2026-01-10",
	event_name: "recording_started",
	country: "US",
});
assert.equal(daily.length, 1);
assert.equal(Number(daily[0].events), 1);
assert.equal(Number(daily[0].users), 1);
assert.equal(Number(daily[0].organizations), 1);

const traffic = await query("product_traffic_overview", {
	start_date: "2026-01-10",
	end_date: "2026-01-10",
	hostname: "cap.so",
});
assert.equal(traffic.length, 1);
assert.equal(Number(traffic[0].visitors), 2);
assert.equal(Number(traffic[0].visits), 2);
assert.equal(Number(traffic[0].pageviews), 3);

const pages = await query("product_traffic_pages", {
	start_date: "2026-01-10",
	end_date: "2026-01-10",
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

const health = await query("product_events_health", {
	start_time: "2026-01-10 00:00:00.000",
	end_time: "2026-01-12 00:00:00.000",
});
assert.equal(health.length, 1);
assert.equal(Number(health[0].received_rows), 11);
assert.equal(Number(health[0].unique_events), 11);
assert.equal(Number(health[0].payload_conflicts), 0);

console.log(
	"Local Tinybird copies and typed endpoints match fixture semantics.",
);
