import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentQuery, runAgentQuery } from "../agent-query.js";

const env = {
	TINYBIRD_AGENT_TOKEN: "read-token",
	TINYBIRD_URL: "https://api.tinybird.co",
};

test("agent daily queries are restricted to the aggregate endpoint", () => {
	const { url, token } = buildAgentQuery(
		"daily",
		[
			"start_date=2026-07-01",
			"event_name=purchase_completed",
			"payment_status=paid",
		],
		env,
	);
	assert.equal(token, "read-token");
	assert.equal(url.pathname, "/v0/pipes/product_events_daily.json");
	assert.equal(url.searchParams.get("event_name"), "purchase_completed");
	assert.equal(url.searchParams.get("payment_status"), "paid");
	assert.throws(
		() => buildAgentQuery("daily", ["sql=DROP TABLE events"], env),
		/Unsupported daily parameter/,
	);
});

test("agent health queries require an explicit window", () => {
	assert.throws(
		() => buildAgentQuery("health", [], env),
		/start_time and end_time/,
	);
	assert.throws(
		() =>
			buildAgentQuery(
				"health",
				["start_time=2026-07-02", "end_time=2026-07-01"],
				env,
			),
		/invalid or reversed/,
	);
	assert.throws(
		() =>
			buildAgentQuery(
				"health",
				["start_time=2026-01-01", "end_time=2026-03-01"],
				env,
			),
		/cannot exceed 31 days/,
	);
});

test("agent health queries normalize ISO timestamps for Tinybird", () => {
	const { url } = buildAgentQuery(
		"health",
		["start_time=2026-07-01T00:00:00", "end_time=2026-07-02T01:30:00+01:00"],
		env,
	);
	assert.equal(url.searchParams.get("start_time"), "2026-07-01 00:00:00.000");
	assert.equal(url.searchParams.get("end_time"), "2026-07-02 00:30:00.000");
});

test("agent query sends only the read token", async () => {
	let authorization;
	const output = await runAgentQuery("daily", [], env, async (_url, init) => {
		authorization = new Headers(init?.headers).get("authorization");
		return new Response('{"data":[]}', { status: 200 });
	});
	assert.equal(authorization, "Bearer read-token");
	assert.equal(output, '{"data":[]}');
});
