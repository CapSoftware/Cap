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
		"product_attribution_daily_exact",
		"product_experiment_outcomes_exact",
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
		"product_attribution_daily_exact",
		"product_experiment_outcomes_exact",
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

test("Tinybird node names do not conflict with resource names", () => {
	const project = loadTinybirdProject(TINYBIRD_PROJECT_DIR);
	const resourceNames = new Set([
		...project.datasources.map((datasource) => datasource.name),
		...project.pipes.map((pipe) => pipe.name),
	]);
	for (const pipe of project.pipes) {
		for (const nodeName of pipe.nodeNames) {
			assert.equal(
				resourceNames.has(nodeName),
				false,
				`${pipe.name} node ${nodeName} conflicts with a resource name`,
			);
		}
	}
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
	assert.match(
		contents,
		/recording_status = \{\{String\(recording_status\)\}\}/,
	);
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

test("traffic totals merge visitor states across the selected range", () => {
	const contents = fs.readFileSync(
		path.join(TINYBIRD_PROJECT_DIR, "pipes", "product_traffic_totals.pipe"),
		"utf8",
	);
	assert.match(contents, /uniqExactMerge\(visitors\) AS visitors/);
	assert.match(contents, /FROM product_traffic_daily_exact/);
	assert.match(contents, /platform = \{\{String\(platform\)\}\}/);
	assert.match(contents, /app_version = \{\{String\(app_version\)\}\}/);
	assert.doesNotMatch(contents, /GROUP BY date/);
	assert.doesNotMatch(contents, /FROM product_events_v1/);
});

test("traffic endpoints apply platform and app-version filters consistently", () => {
	const project = loadTinybirdProject(TINYBIRD_PROJECT_DIR);
	for (const name of [
		"product_traffic_daily_exact",
		"product_traffic_pages_daily_exact",
	]) {
		const datasource = project.datasources.find(
			(candidate) => candidate.name === name,
		);
		assert.ok(datasource);
		const columnNames = new Set(datasource.columns.map(({ name }) => name));
		assert.ok(columnNames.has("platform"));
		assert.ok(columnNames.has("app_version"));
	}
	const trafficSnapshot = fs.readFileSync(
		path.join(
			TINYBIRD_PROJECT_DIR,
			"pipes",
			"snapshot_product_traffic_daily_exact.pipe",
		),
		"utf8",
	);
	const pagesSnapshot = fs.readFileSync(
		path.join(
			TINYBIRD_PROJECT_DIR,
			"pipes",
			"snapshot_product_traffic_pages_daily_exact.pipe",
		),
		"utf8",
	);
	assert.match(
		trafficSnapshot,
		/argMin\(platform, tuple\(occurred_at, event_id\)\) AS platform/,
	);
	assert.match(
		trafficSnapshot,
		/argMin\(app_version, tuple\(occurred_at, event_id\)\) AS app_version/,
	);
	assert.match(
		pagesSnapshot,
		/argMin\(event_id, tuple\(occurred_at, event_id\)\) AS landing_event_id/,
	);
	assert.match(
		pagesSnapshot,
		/argMax\(event_id, tuple\(occurred_at, event_id\)\) AS exit_event_id/,
	);
	assert.match(pagesSnapshot, /\n\s+platform,\n\s+app_version,/);
	for (const name of [
		"product_traffic_overview",
		"product_traffic_totals",
		"product_traffic_pages",
		"product_traffic_sources",
		"product_traffic_countries",
		"product_traffic_technology",
	]) {
		const contents = fs.readFileSync(
			path.join(TINYBIRD_PROJECT_DIR, "pipes", `${name}.pipe`),
			"utf8",
		);
		assert.match(contents, /platform = \{\{String\(platform\)\}\}/);
		assert.match(contents, /app_version = \{\{String\(app_version\)\}\}/);
	}
});

test("campaign attribution materializes explicit first, session, and last models", () => {
	const snapshot = fs.readFileSync(
		path.join(
			TINYBIRD_PROJECT_DIR,
			"pipes",
			"snapshot_product_attribution_daily_exact.pipe",
		),
		"utf8",
	);
	const endpoint = fs.readFileSync(
		path.join(TINYBIRD_PROJECT_DIR, "pipes", "product_attribution.pipe"),
		"utf8",
	);
	assert.match(snapshot, /ARRAY JOIN \['first', 'session', 'last'\]/);
	assert.match(
		snapshot,
		/attribution_model = 'last'.*argMax\(attribution_source, tuple\(occurred_at, event_id\)\).*argMin\(attribution_source, tuple\(occurred_at, event_id\)\)/,
	);
	for (const prefix of ["first_touch", "session_touch", "last_touch"]) {
		assert.match(snapshot, new RegExp(`${prefix}_source`));
		assert.match(snapshot, new RegExp(`${prefix}_medium`));
		assert.match(snapshot, new RegExp(`${prefix}_campaign`));
	}
	assert.match(snapshot, /uniqExactState\(visitor_id\) AS visitors/);
	assert.match(endpoint, /uniqExactMerge\(visitors\) AS visitors/);
	assert.match(endpoint, /FROM product_attribution_daily_exact/);
	assert.doesNotMatch(
		endpoint,
		/anonymous_id|session_id|user_id|organization_id/,
	);
});

test("experiment outcomes are aggregate-only and anchored to explicit exposures", () => {
	const snapshot = fs.readFileSync(
		path.join(
			TINYBIRD_PROJECT_DIR,
			"pipes",
			"snapshot_product_experiment_outcomes_exact.pipe",
		),
		"utf8",
	);
	const endpoint = fs.readFileSync(
		path.join(
			TINYBIRD_PROJECT_DIR,
			"pipes",
			"product_experiment_outcomes.pipe",
		),
		"utf8",
	);
	assert.match(snapshot, /event_name = 'experiment_exposed'/);
	assert.match(snapshot, /HAVING uniqExact\(user_id\) = 1/);
	assert.match(snapshot, /HAVING uniqExact\(variant\) = 1/);
	assert.match(snapshot, /outcome_candidates AS/);
	assert.match(
		snapshot,
		/minIf\(outcomes\.occurred_at, outcomes\.event_name = 'share_link_created' AND outcomes\.occurred_at >= exposures\.exposed_at/,
	);
	assert.match(snapshot, /outcome_at >= exposed_at/);
	assert.match(snapshot, /outcome_at < exposed_at \+ INTERVAL 30 DAY/);
	assert.match(
		snapshot,
		/JSONExtractString\(properties, 'payment_status'\) = 'paid'/,
	);
	assert.match(endpoint, /FROM product_experiment_outcomes_exact/);
	assert.match(endpoint, /sum\(converted_actors\)/);
	assert.doesNotMatch(
		endpoint,
		/anonymous_id|session_id|user_id|organization_id/,
	);
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
	const materializedState = project.pipes.find(
		(pipe) => pipe.name === "materialize_product_event_id_states_v2",
	);
	const canonicalCurrent = project.pipes.find(
		(pipe) => pipe.name === "product_events_canonical_current",
	);
	const canonical = project.pipes.find(
		(pipe) => pipe.name === "snapshot_product_events_canonical_v1",
	);
	const snapshot = project.pipes.find(
		(pipe) => pipe.name === "snapshot_product_events_daily_exact",
	);
	assert.ok(snapshot);
	assert.ok(canonical);
	assert.ok(materializedState);
	assert.ok(canonicalCurrent);
	assert.equal(materializedState.type, "materialized");
	assert.equal(
		materializedState.targetDatasource,
		"product_event_id_states_v2",
	);
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
	assert.match(canonicalContents, /FROM product_events_canonical_current/);
	assert.doesNotMatch(canonicalContents, /FROM product_events_v1/);
	assert.match(canonicalContents, /^COPY_MODE replace$/m);
	const stateContents = fs.readFileSync(
		path.join(
			TINYBIRD_PROJECT_DIR,
			"pipes",
			"materialize_product_event_id_states_v2.pipe",
		),
		"utf8",
	);
	assert.match(stateContents, /uniqExactState\(payload_hash\)/);
	assert.match(stateContents, /GROUP BY event_id/);
	assert.match(stateContents, /^TYPE MATERIALIZED$/m);
	const currentContents = fs.readFileSync(
		path.join(
			TINYBIRD_PROJECT_DIR,
			"pipes",
			"product_events_canonical_current.pipe",
		),
		"utf8",
	);
	assert.match(currentContents, /uniqExactMerge\(payload_hashes\) = 1/);
	assert.match(currentContents, /GROUP BY event_id/);

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
	assert.match(contents, /FROM product_events_canonical_current/);
	assert.match(contents, /toUInt64\(count\(\)\) AS events/);
	assert.match(contents, /uniqExactState\(/);
	assert.match(contents, /AS recording_status/);
	assert.match(contents, /'success', 'success'/);
	assert.match(contents, /'degraded', 'degraded'/);
	assert.match(contents, /'failed', 'failed'/);
	assert.match(contents, /JSONExtractString\(properties, 'payment_status'\)/);
	assert.match(
		contents,
		/JSONExtractString\(properties, 'subscription_status'\)/,
	);
	assert.match(contents, /revenue_minor/);
	assert.doesNotMatch(contents, /uniqState\(/);
});

test("bounded v2 aggregates publish one common generation without historical scans", () => {
	const project = loadTinybirdProject(TINYBIRD_PROJECT_DIR);
	const dayState = project.datasources.find(
		(datasource) => datasource.name === "product_event_day_states_v2",
	);
	assert.ok(dayState);
	assert.equal(dayState.engine, "AggregatingMergeTree");
	assert.equal(dayState.partitionKey, "toYYYYMM(occurred_date)");
	assert.equal(dayState.sortingKey, "(occurred_date, event_id)");
	assert.equal(dayState.ttl, "occurred_date + INTERVAL 807 DAY");
	const dayMaterialization = project.pipes.find(
		(pipe) => pipe.name === "materialize_product_event_day_states_v2",
	);
	assert.ok(dayMaterialization);
	assert.equal(dayMaterialization.type, "materialized");
	assert.equal(
		dayMaterialization.targetDatasource,
		"product_event_day_states_v2",
	);

	for (const prefix of [
		"product_events_daily",
		"product_traffic_daily",
		"product_traffic_pages_daily",
	]) {
		const bounded = fs.readFileSync(
			path.join(TINYBIRD_PROJECT_DIR, "pipes", `${prefix}_bounded_v2.pipe`),
			"utf8",
		);
		assert.match(bounded, /source_cutoff is required/);
		assert.match(bounded, /generation_id is required/);
		assert.match(bounded, /FROM product_events_canonical_window/);
		assert.match(bounded, /INTERVAL 8 DAY/);
		assert.doesNotMatch(bounded, /INTERVAL 800 DAY|FROM product_events_v1/);

		for (const [temperature, mode] of [
			["hot", "replace"],
			["cold", "append"],
		]) {
			const copy = fs.readFileSync(
				path.join(
					TINYBIRD_PROJECT_DIR,
					"pipes",
					`snapshot_${prefix}_${temperature}_v2.pipe`,
				),
				"utf8",
			);
			assert.match(copy, new RegExp(`^COPY_MODE ${mode}$`, "m"));
			assert.match(copy, /^COPY_SCHEDULE @on-demand$/m);
			assert.match(copy, /^TOKEN product_events_copy_runner READ$/m);
		}

		const current = fs.readFileSync(
			path.join(TINYBIRD_PROJECT_DIR, "pipes", `${prefix}_current_v2.pipe`),
			"utf8",
		);
		assert.match(current, /FROM product_analytics_generations_v2/);
		assert.match(current, /generation_kind = 'hot'/);
		assert.match(current, /generation_kind = 'cold'/);
		assert.match(current, /is_marker = 0/);
		assert.match(current, /INTERVAL 8 DAY/);
	}

	const publication = fs.readFileSync(
		path.join(
			TINYBIRD_PROJECT_DIR,
			"pipes",
			"publish_product_analytics_generation_v2.pipe",
		),
		"utf8",
	);
	assert.match(publication, /event hot generation is incomplete/);
	assert.match(publication, /traffic hot generation is incomplete/);
	assert.match(publication, /page hot generation is incomplete/);
	assert.match(publication, /event cold generation is incomplete/);
	assert.match(publication, /traffic cold generation is incomplete/);
	assert.match(publication, /page cold generation is incomplete/);
	assert.match(publication, /^COPY_MODE append$/m);
	assert.match(publication, /^COPY_SCHEDULE @on-demand$/m);
});

test("copy rebuilds are on-demand and require the sequential controller", () => {
	const copies = [
		"snapshot_product_events_canonical_v1",
		"snapshot_product_events_health_hourly",
		"snapshot_product_events_daily_exact",
		"snapshot_product_traffic_daily_exact",
		"snapshot_product_traffic_pages_daily_exact",
		"snapshot_product_activation_daily_exact",
		"snapshot_product_creator_retention_exact",
		"snapshot_product_identity_funnel_exact",
		"snapshot_product_attribution_daily_exact",
		"snapshot_product_experiment_outcomes_exact",
	];
	for (const name of copies) {
		const contents = fs.readFileSync(
			path.join(TINYBIRD_PROJECT_DIR, "pipes", `${name}.pipe`),
			"utf8",
		);
		assert.ok(contents.split("\n").includes("COPY_SCHEDULE @on-demand"));
		assert.match(contents, /^TOKEN product_events_copy_runner READ$/m);
		assert.doesNotMatch(contents, /^TOKEN product_events_agent_read READ$/m);
		assert.match(contents, /\{\{max_threads\(Int32\(copy_max_threads\)\)\}\}/);
	}
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
		"product_traffic_totals",
		"product_attribution",
		"product_experiment_outcomes",
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
		"snapshot_product_attribution_daily_exact",
		"snapshot_product_experiment_outcomes_exact",
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
	assert.match(assertions, /attribution_markers/);
	assert.match(assertions, /experiment_markers/);
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
