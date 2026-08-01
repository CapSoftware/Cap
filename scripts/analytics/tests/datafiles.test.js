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
	assert.equal(datasource.ttl, "toDateTime(received_at) + INTERVAL 800 DAY");
	assert.deepEqual(datasource.tokens, [
		{ name: "product_events_ingest", scope: "APPEND" },
		{ name: "product_events_erasure_lookup", scope: "READ" },
	]);
	assert.equal(
		datasource.tokens.some(
			(token) =>
				token.name === "product_events_agent_read" && token.scope === "READ",
		),
		false,
	);
	const retainedDatasources = [
		"product_events_canonical_v1",
		"product_events_daily_exact",
		"product_traffic_daily_exact",
		"product_traffic_pages_daily_exact",
		"product_activation_daily_exact",
		"product_creator_retention_exact",
		"product_identity_funnel_exact",
	];
	for (const name of retainedDatasources) {
		const retained = project.datasources.find(
			(candidate) => candidate.name === name,
		);
		assert.ok(retained);
		assert.match(retained.ttl ?? "", /\+ INTERVAL 800 DAY$/);
	}
	const copyTargets = [
		"product_events_canonical_v1",
		"product_events_daily_exact",
		"product_traffic_daily_exact",
		"product_traffic_pages_daily_exact",
		"product_activation_daily_exact",
		"product_creator_retention_exact",
		"product_identity_funnel_exact",
		"product_events_health_hourly_exact",
	];
	for (const name of copyTargets) {
		const target = project.datasources.find(
			(candidate) => candidate.name === name,
		);
		assert.ok(target);
		assert.ok(
			target.tokens.some(
				(token) =>
					token.name === "product_events_copy_runner" &&
					token.scope === "APPEND",
			),
		);
	}
	const canonical = project.datasources.find(
		(candidate) => candidate.name === "product_events_canonical_v1",
	);
	assert.ok(canonical);
	assert.ok(
		canonical.tokens.some(
			(token) =>
				token.name === "product_events_erasure_lookup" &&
				token.scope === "READ",
		),
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

test("feature adoption merges daily identities after applying filters", () => {
	const contents = fs.readFileSync(
		path.join(TINYBIRD_PROJECT_DIR, "pipes", "product_feature_adoption.pipe"),
		"utf8",
	);
	assert.match(contents, /FROM product_events_daily_exact/);
	assert.match(contents, /GROUP BY date, event_name/);
	assert.match(contents, /uniqExactMerge\(actors\) AS actors/);
	assert.match(contents, /toUInt64\(sum\(actors\)\) AS actor_days/);
	assert.match(contents, /platform = \{\{String\(platform\)\}\}/);
	assert.doesNotMatch(contents, /FROM product_events_v1/);
});

test("retention merges identities across activity platforms", () => {
	const contents = fs.readFileSync(
		path.join(TINYBIRD_PROJECT_DIR, "pipes", "product_creator_retention.pipe"),
		"utf8",
	);
	assert.match(contents, /'all' \{% end %\} AS platform/);
	assert.match(
		contents,
		/activity_date = cohort_date OR platform = \{\{String\(platform\)\}\}/,
	);
	assert.match(contents, /GROUP BY cohort_date, activity_date/);
	assert.match(contents, /uniqExactMerge\(creator_users\) AS creators/);
});

test("identity cohorts stitch acquisition and guest purchases without exposing mappings", () => {
	const snapshot = fs.readFileSync(
		path.join(
			TINYBIRD_PROJECT_DIR,
			"pipes",
			"snapshot_product_identity_funnel_exact.pipe",
		),
		"utf8",
	);
	const endpoint = fs.readFileSync(
		path.join(TINYBIRD_PROJECT_DIR, "pipes", "product_identity_funnel.pipe"),
		"utf8",
	);
	assert.match(snapshot, /event_name = 'identity_linked'/);
	assert.match(snapshot, /event_name = 'guest_checkout_started'/);
	assert.match(snapshot, /FROM guest_checkouts\n\s+LEFT JOIN guest_paths/);
	assert.match(snapshot, /JSONExtractBool\(properties, 'is_guest_checkout'\)/);
	assert.match(snapshot, /organization_first_links/);
	assert.match(snapshot, /sum\(linked_organization\)/);
	assert.match(snapshot, /cross_device_checkout_users/);
	assert.doesNotMatch(endpoint, /user_id|anonymous_id|organization_id/);
	assert.match(endpoint, /FROM product_identity_funnel_exact/);
	assert.doesNotMatch(endpoint, /GROUP BY|LIMIT/);
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

test("copy schedules serialize canonical and derived rebuilds", () => {
	const schedules = new Map([
		["snapshot_product_events_canonical_v1", "0-59/8 * * * *"],
		["snapshot_product_events_health_hourly", "1-59/8 * * * *"],
		["snapshot_product_events_daily_exact", "2-59/8 * * * *"],
		["snapshot_product_traffic_daily_exact", "3-59/8 * * * *"],
		["snapshot_product_traffic_pages_daily_exact", "4-59/8 * * * *"],
		["snapshot_product_activation_daily_exact", "5-59/8 * * * *"],
		["snapshot_product_creator_retention_exact", "6-59/8 * * * *"],
		["snapshot_product_identity_funnel_exact", "7-59/8 * * * *"],
	]);
	for (const [name, schedule] of schedules) {
		const contents = fs.readFileSync(
			path.join(TINYBIRD_PROJECT_DIR, "pipes", `${name}.pipe`),
			"utf8",
		);
		assert.ok(contents.split("\n").includes(`COPY_SCHEDULE ${schedule}`));
		assert.match(contents, /^TOKEN product_events_copy_runner READ$/m);
		assert.doesNotMatch(contents, /^TOKEN product_events_agent_read READ$/m);
		assert.match(contents, /\{\{max_threads\(Int32\(copy_max_threads\)\)\}\}/);
	}
	assert.equal(new Set(schedules.values()).size, schedules.size);
});

test("decision endpoints cannot be executed with the Copy runner token", () => {
	const project = loadTinybirdProject(TINYBIRD_PROJECT_DIR);
	for (const pipe of project.pipes.filter(
		(candidate) =>
			candidate.name.startsWith("product_") && candidate.type === "endpoint",
	)) {
		assert.deepEqual(pipe.tokens, [
			{ name: "product_events_agent_read", scope: "READ" },
		]);
	}
});

test("staging copy markers and synthetic rows are excluded from decision endpoints", () => {
	const syntheticEndpoints = [
		"product_traffic_overview",
		"product_traffic_pages",
		"product_traffic_sources",
		"product_traffic_countries",
		"product_traffic_technology",
		"product_activation",
		"product_creator_activity",
		"product_creator_retention",
		"product_events_daily",
		"product_feature_adoption",
		"product_identity_funnel",
	];
	for (const name of syntheticEndpoints) {
		const contents = fs.readFileSync(
			path.join(TINYBIRD_PROJECT_DIR, "pipes", `${name}.pipe`),
			"utf8",
		);
		assert.match(contents, /synthetic_run_id = ''/);
		assert.match(contents, /defined\(synthetic_run_id\)/);
		assert.match(contents, /synthetic_run_id has an invalid length/);
	}
	for (const name of [
		...syntheticEndpoints.slice(0, 8),
		"product_identity_funnel",
	]) {
		const contents = fs.readFileSync(
			path.join(TINYBIRD_PROJECT_DIR, "pipes", `${name}.pipe`),
			"utf8",
		);
		assert.match(contents, /copy_run_id = ''/);
	}
	for (const name of [
		"snapshot_product_traffic_daily_exact",
		"snapshot_product_traffic_pages_daily_exact",
		"snapshot_product_activation_daily_exact",
		"snapshot_product_creator_retention_exact",
		"snapshot_product_identity_funnel_exact",
	]) {
		const contents = fs.readFileSync(
			path.join(TINYBIRD_PROJECT_DIR, "pipes", `${name}.pipe`),
			"utf8",
		);
		assert.match(contents, /defined\(copy_run_id\)/);
		assert.match(contents, /AS copy_run_id/);
		assert.match(contents, /AS synthetic_run_id/);
	}
	const assertions = fs.readFileSync(
		path.join(
			TINYBIRD_PROJECT_DIR,
			"pipes",
			"product_analytics_copy_assertions.pipe",
		),
		"utf8",
	);
	assert.match(assertions, /copy_run_id is required/);
	assert.match(assertions, /traffic_markers/);
	assert.doesNotMatch(assertions, /requested_copy_run_id/);
	assert.match(assertions, /retention_markers/);
	assert.match(assertions, /identity_markers/);
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
	assert.match(contents, /FROM product_events_health_hourly_exact/);
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
	assert.match(contents, /FROM product_events_canonical_v1/);
	assert.match(contents, /FROM product_events_daily_exact/);
	assert.match(contents, /FROM product_traffic_daily_exact/);
	assert.match(contents, /FROM product_traffic_pages_daily_exact/);
	assert.match(contents, /FROM product_activation_daily_exact/);
	assert.match(contents, /FROM product_creator_retention_exact/);
	assert.match(contents, /canonical_events/);
	assert.match(contents, /decision_events/);
	assert.match(contents, /traffic_visitors/);
	assert.match(contents, /activated_creators/);
	assert.match(contents, /retention_organizations/);
	assert.match(contents, /FROM product_events_v1/);
	assert.doesNotMatch(contents, /event_id AS/);
	assert.doesNotMatch(contents, /TOKEN product_events_ingest READ/);
});
