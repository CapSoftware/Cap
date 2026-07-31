import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
	loadTinybirdProject,
	parseColumns,
	readBlock,
	splitTopLevel,
} from "../datafiles.js";
import { PRODUCT_COLUMNS, TINYBIRD_PROJECT_DIR } from "../tooling.js";

test("splitTopLevel preserves nested aggregate types", () => {
	assert.deepEqual(
		splitTopLevel(
			"date Date, unique_events AggregateFunction(uniqExact, String), unique_payloads AggregateFunction(uniqExact, Tuple(String, FixedString(32)))",
		),
		[
			"date Date",
			"unique_events AggregateFunction(uniqExact, String)",
			"unique_payloads AggregateFunction(uniqExact, Tuple(String, FixedString(32)))",
		],
	);
});

test("readBlock stops at the next Tinybird directive", () => {
	const contents = [
		"SCHEMA >",
		"\tevent_id String `json:$.event_id`,",
		"\toccurred_at DateTime64(3) `json:$.occurred_at`",
		"",
		"ENGINE ReplacingMergeTree",
	].join("\n");
	assert.equal(
		readBlock(contents, "SCHEMA"),
		"event_id String `json:$.event_id`,\noccurred_at DateTime64(3) `json:$.occurred_at`",
	);
});

test("parseColumns removes JSON paths and defaults", () => {
	assert.deepEqual(
		parseColumns(
			"event_id String `json:$.event_id`, properties String `json:$.properties` DEFAULT '{}'",
		),
		[
			{ name: "event_id", type: "String" },
			{ name: "properties", type: "String" },
		],
	);
});

test("product datasource matches the runtime event contract", () => {
	const project = loadTinybirdProject(TINYBIRD_PROJECT_DIR);
	const datasource = project.datasources.find(
		(candidate) => candidate.name === "product_events_v1",
	);
	assert.ok(datasource);
	assert.deepEqual(
		datasource.columns.map(({ name, type }) => [name, type]),
		PRODUCT_COLUMNS,
	);
	assert.equal(datasource.engine, "MergeTree");
	assert.equal(datasource.sortingKey, "(received_at, event_id)");
	assert.equal(datasource.versionColumn, null);
	assert.equal(datasource.partitionKey, "toYYYYMM(received_at)");
	assert.equal(datasource.ttl, "toDateTime(received_at) + INTERVAL 90 DAY");
	assert.deepEqual(datasource.tokens, [
		{ name: "product_events_ingest", scope: "APPEND" },
	]);
	assert.equal(
		datasource.tokens.some(
			(token) =>
				token.name === "product_events_agent_read" && token.scope === "READ",
		),
		false,
	);
});

test("existing viewer resources remain in the Tinybird project", () => {
	const project = loadTinybirdProject(TINYBIRD_PROJECT_DIR);
	const names = project.datasources.map(({ name }) => name);
	assert.ok(names.includes("analytics_events"));
	assert.ok(names.includes("analytics_pages_mv"));
	assert.ok(names.includes("analytics_sessions_mv"));
	assert.ok(
		project.pipes.some(
			(pipe) =>
				pipe.name === "analytics_pages_mv_pipe" &&
				pipe.targetDatasource === "analytics_pages_mv",
		),
	);
	assert.ok(path.isAbsolute(project.datasources[0].filePath));
});

test("daily product queries read the exact snapshot instead of raw deliveries", () => {
	const contents = fs.readFileSync(
		path.join(TINYBIRD_PROJECT_DIR, "pipes", "product_events_daily.pipe"),
		"utf8",
	);
	assert.match(contents, /FROM product_events_daily_exact/);
	assert.match(contents, /today\(\) - INTERVAL 30 DAY/);
	assert.match(
		contents,
		/LIMIT greatest\(1, least\(\{\{Int32\(limit, 1000\)\}\}, 1000\)\)/,
	);
	assert.match(contents, /ORDER BY date DESC/);
	assert.match(contents, /payment_status = \{\{String\(payment_status\)\}\}/);
	assert.match(
		contents,
		/subscription_status = \{\{String\(subscription_status\)\}\}/,
	);
	assert.match(contents, /app_version = \{\{String\(app_version\)\}\}/);
	assert.match(contents, /currency = upper\(\{\{String\(currency\)\}\}\)/);
	assert.match(contents, /revenue_minor/);
	assert.doesNotMatch(contents, /FROM product_events_v1/);
	assert.doesNotMatch(contents, /FROM product_events_daily_mv/);
});

test("daily snapshot quarantines payload conflicts and rebuilds exact metrics", () => {
	const project = loadTinybirdProject(TINYBIRD_PROJECT_DIR);
	const canonical = project.pipes.find(
		(pipe) => pipe.name === "snapshot_product_events_canonical_v1",
	);
	const snapshot = project.pipes.find(
		(pipe) => pipe.name === "snapshot_product_events_daily_exact",
	);
	assert.ok(snapshot);
	assert.ok(canonical);
	assert.equal(snapshot.type, "copy");
	assert.equal(snapshot.targetDatasource, "product_events_daily_exact");

	const canonicalContents = fs.readFileSync(
		path.join(
			TINYBIRD_PROJECT_DIR,
			"pipes",
			"snapshot_product_events_canonical_v1.pipe",
		),
		"utf8",
	);
	assert.match(canonicalContents, /GROUP BY event_id/);
	assert.match(canonicalContents, /HAVING uniqExact\(raw_payload_hash\) = 1/);
	assert.match(canonicalContents, /^COPY_MODE replace$/m);

	const contents = fs.readFileSync(
		path.join(
			TINYBIRD_PROJECT_DIR,
			"pipes",
			"snapshot_product_events_daily_exact.pipe",
		),
		"utf8",
	);
	assert.match(contents, /^TYPE COPY$/m);
	assert.match(contents, /^COPY_MODE replace$/m);
	assert.match(contents, /FROM product_events_canonical_v1/);
	assert.match(contents, /toUInt64\(count\(\)\) AS events/);
	assert.match(contents, /uniqExactState\(/);
	assert.match(contents, /JSONExtractString\(properties, 'payment_status'\)/);
	assert.match(
		contents,
		/JSONExtractString\(properties, 'subscription_status'\)/,
	);
	assert.match(contents, /revenue_minor/);
	assert.doesNotMatch(contents, /uniqState\(/);
});

test("health queries use stable hourly aggregates and a bounded window", () => {
	const contents = fs.readFileSync(
		path.join(TINYBIRD_PROJECT_DIR, "pipes", "product_events_health.pipe"),
		"utf8",
	);
	assert.match(contents, /error\('start_time is required'\)/);
	assert.match(contents, /error\('end_time is required'\)/);
	assert.match(
		contents,
		/toStartOfHour\(toDateTime64\(\{\{DateTime64\(start_time\)\}\}, 3\)\)/,
	);
	assert.match(contents, /FROM product_events_health_hourly/);
	assert.match(contents, /uniqExactMerge\(unique_events\)/);
	assert.match(contents, /uniqExactMerge\(unique_payloads\)/);
	assert.match(contents, /payload_conflicts/);
	assert.match(contents, /ingestion_lag_ms/);
	assert.match(contents, /INTERVAL 31 DAY/);
	assert.match(contents, /throwIf\(/);
	assert.doesNotMatch(contents, /FROM product_events_v1/);
	assert.doesNotMatch(contents, /SELECT\s+\*/i);
});

test("staging assertions prove canonical decisions without returning raw IDs", () => {
	const contents = fs.readFileSync(
		path.join(
			TINYBIRD_PROJECT_DIR,
			"pipes",
			"product_analytics_ci_assertions.pipe",
		),
		"utf8",
	);
	assert.match(contents, /synthetic_run_id is required/);
	assert.match(contents, /uniqExact\(payload_hash\) AS payloads/);
	assert.match(contents, /countIf\(payloads = 1\) AS decision_events/);
	assert.match(contents, /FROM product_events_v1/);
	assert.doesNotMatch(contents, /event_id AS/);
	assert.doesNotMatch(contents, /TOKEN product_events_ingest READ/);
});
