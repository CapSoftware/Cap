import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
	assertExecutionScope,
	assertSyntheticDecisions,
	assertSyntheticHealth,
	assertWorkflowSafety,
	createSyntheticErasureControl,
	createSyntheticEvents,
	createSyntheticLoadEvents,
	decisionEndpointQueries,
	evaluateBundleBudget,
	evaluateLatencyBudget,
	extractSameOriginNextScriptUrls,
	FEATURE_BRANCH,
	FEATURE_PULL_REQUEST,
	latencySummary,
	normalizeCiAssertions,
	normalizeCopyAssertions,
	normalizeHealth,
	STAGING_WORKSPACE_ID,
	selectStagingDeployment,
	submitTinybirdCopyJobs,
	tokenWorkspaceId,
	validateSyntheticRunId,
	validateTinybirdCredentials,
} from "../staging-ci-lib.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const token = (workspaceId = STAGING_WORKSPACE_ID) =>
	`p.${Buffer.from(JSON.stringify({ u: workspaceId })).toString("base64url")}.signature`;

test("execution scope accepts only PR 2003 or manual feature branch runs", () => {
	assert.doesNotThrow(() =>
		assertExecutionScope({
			eventName: "pull_request",
			eventNumber: FEATURE_PULL_REQUEST,
			headRef: FEATURE_BRANCH,
			ref: "refs/pull/2003/merge",
			expectedSha: SHA,
			actualSha: SHA,
		}),
	);
	assert.doesNotThrow(() =>
		assertExecutionScope({
			eventName: "workflow_dispatch",
			eventNumber: "",
			headRef: "",
			ref: `refs/heads/${FEATURE_BRANCH}`,
			expectedSha: SHA,
			actualSha: SHA,
		}),
	);
	for (const invalid of [
		{ eventName: "push", ref: `refs/heads/${FEATURE_BRANCH}` },
		{
			eventName: "pull_request",
			eventNumber: 2004,
			headRef: FEATURE_BRANCH,
		},
		{
			eventName: "pull_request",
			eventNumber: FEATURE_PULL_REQUEST,
			headRef: "main",
		},
		{ eventName: "workflow_dispatch", ref: "refs/heads/main" },
	]) {
		assert.throws(() =>
			assertExecutionScope({
				eventNumber: "",
				headRef: "",
				ref: "",
				expectedSha: SHA,
				actualSha: SHA,
				...invalid,
			}),
		);
	}
	assert.throws(() =>
		assertExecutionScope({
			eventName: "workflow_dispatch",
			ref: `refs/heads/${FEATURE_BRANCH}`,
			expectedSha: SHA,
			actualSha: "0".repeat(40),
		}),
	);
});

test("Tinybird credentials must all decode to the hard-coded staging workspace", () => {
	assert.equal(tokenWorkspaceId(token()), STAGING_WORKSPACE_ID);
	assert.equal(
		validateTinybirdCredentials({
			url: "https://api.us-east.aws.tinybird.co",
			tokens: {
				deploy: token(),
				ingest: token(),
				read: token(),
				cleanup: token(),
			},
		}),
		"https://api.us-east.aws.tinybird.co",
	);
	assert.throws(() =>
		validateTinybirdCredentials({
			url: "https://api.tinybird.example.com",
			tokens: { deploy: token() },
		}),
	);
	assert.throws(() =>
		validateTinybirdCredentials({
			url: "https://api.tinybird.co",
			tokens: { deploy: token("00000000-0000-4000-8000-000000000000") },
		}),
	);
});

test("deployment selection rejects stale or ambiguous staging deployments", () => {
	const minimum = "2026-07-31T10:00:00.000Z";
	assert.deepEqual(
		selectStagingDeployment(
			{
				deployments: [
					{
						id: "old",
						status: "staging",
						created_at: "2026-07-31T09:59:59.000Z",
					},
					{
						id: "current",
						status: "staging",
						created_at: "2026-07-31T10:00:01.000Z",
					},
				],
			},
			minimum,
			"current",
		),
		{ id: "current", needsPromotion: true },
	);
	assert.deepEqual(
		selectStagingDeployment(
			[
				{
					ID: 42,
					Status: "Staging",
					"Created at": "2026-07-31T10:00:01.000Z",
				},
			],
			minimum,
			"42",
		),
		{ id: "42", needsPromotion: true },
	);
	assert.throws(() =>
		selectStagingDeployment(
			[
				{
					id: "one",
					state: "staging",
					createdAt: "2026-07-31T10:00:01.000Z",
				},
				{
					id: "two",
					state: "staging",
					createdAt: "2026-07-31T10:00:02.000Z",
				},
			],
			minimum,
		),
	);
	assert.deepEqual(
		selectStagingDeployment(
			[
				{
					id: "live",
					status: "Live",
					created_at: "2026-07-31T09:00:00.000Z",
				},
			],
			minimum,
			undefined,
			true,
		),
		{ id: "live", needsPromotion: false },
	);
	assert.throws(() =>
		selectStagingDeployment(
			[
				{
					id: "live",
					status: "Live",
					created_at: "2026-07-31T09:00:00.000Z",
				},
			],
			minimum,
		),
	);
	assert.throws(() =>
		selectStagingDeployment(
			[
				{
					id: "foreign",
					status: "Staging",
					created_at: "2026-07-31T10:00:01.000Z",
				},
			],
			minimum,
			"expected",
		),
	);
});

test("copy jobs use only approved resource-scoped submissions and bounded markers", async () => {
	const requests = [];
	const resourceToken = token();
	const responses = [
		{ data: { id: "copy_job_canonical" } },
		{ data: { id: "copy_job_traffic" } },
	];
	let now = 1_000;
	const results = await submitTinybirdCopyJobs({
		origin: "https://api.us-east.aws.tinybird.co",
		token: resourceToken,
		deploymentId: "6",
		pipes: [
			"snapshot_product_events_canonical_v1",
			"snapshot_product_traffic_daily_exact",
		],
		request: async (url, options) => {
			requests.push({ url: String(url), options });
			now += 10;
			return responses.shift();
		},
		now: () => now,
		useDeploymentParameter: true,
		copyRunId: "run_12345678_staged",
	});
	assert.deepEqual(results, [
		{
			pipe: "snapshot_product_events_canonical_v1",
			jobId: "copy_job_canonical",
			submissionLatencyMs: 10,
		},
		{
			pipe: "snapshot_product_traffic_daily_exact",
			jobId: "copy_job_traffic",
			submissionLatencyMs: 10,
		},
	]);
	assert.match(requests[0].url, /_mode=replace/);
	assert.match(requests[0].url, /__tb__deployment=6/);
	assert.doesNotMatch(requests[0].url, /copy_run_id/);
	assert.equal(requests[0].options.method, "POST");
	assert.equal(requests[0].options.token, resourceToken);
	assert.match(requests[1].url, /copy_run_id=run_12345678_staged/);
	assert.ok(requests.every(({ url }) => !url.includes("/v0/jobs/")));
	const liveRequests = [];
	await submitTinybirdCopyJobs({
		origin: "https://api.us-east.aws.tinybird.co",
		token: resourceToken,
		deploymentId: "6",
		pipes: ["snapshot_product_events_canonical_v1"],
		request: async (url, options) => {
			liveRequests.push({ url: String(url), options });
			return { data: { id: "copy_job_live" } };
		},
	});
	assert.doesNotMatch(liveRequests[0].url, /__tb__deployment/);
	await assert.rejects(() =>
		submitTinybirdCopyJobs({
			origin: "https://api.us-east.aws.tinybird.co",
			token: resourceToken,
			deploymentId: "live",
			request: async () => ({ data: {} }),
		}),
	);
	await assert.rejects(() =>
		submitTinybirdCopyJobs({
			origin: "https://api.us-east.aws.tinybird.co",
			token: resourceToken,
			deploymentId: "6",
			pipes: ["snapshot_product_traffic_daily_exact"],
			request: async () => ({ data: { id: "copy_job_missing_marker" } }),
		}),
	);
});

test("synthetic fixtures are deterministic, isolated, and model duplicates and conflicts", () => {
	const runId = "run_12345678";
	const fixture = createSyntheticEvents({
		runId,
		now: new Date("2026-07-31T10:00:00.000Z"),
	});
	assert.equal(fixture.rows.length, 4);
	assert.deepEqual(fixture.rows[0], fixture.rows[1]);
	assert.equal(fixture.rows[2].event_id, fixture.rows[3].event_id);
	assert.notEqual(fixture.rows[2].payload_hash, fixture.rows[3].payload_hash);
	assert.ok(fixture.rows.every((row) => row.traffic_class === "synthetic"));
	assert.ok(fixture.rows.every((row) => row.synthetic_run_id === runId));
	assert.ok(fixture.rows.every((row) => row.user_id === fixture.userId));
	assert.ok(
		fixture.rows.every((row) => row.organization_id === fixture.organizationId),
	);
	assert.throws(() => validateSyntheticRunId("' OR 1 = 1"));
	const load = createSyntheticLoadEvents({
		runId,
		count: 100,
		now: new Date("2026-07-31T10:00:00.000Z"),
	});
	assert.equal(load.rows.length, 100);
	assert.equal(load.runId, `${runId}_load`);
	assert.equal(new Set(load.rows.map((row) => row.event_id)).size, 100);
	assert.ok(load.rows.every((row) => row.app_version === load.appVersion));
	assert.ok(load.rows.every((row) => row.synthetic_run_id === load.runId));
	const control = createSyntheticErasureControl({
		runId,
		now: new Date("2026-07-31T10:00:00.000Z"),
	});
	assert.equal(control.row.anonymous_id, fixture.anonymousId);
	assert.notEqual(control.row.user_id, fixture.userId);
	assert.notEqual(control.row.organization_id, fixture.organizationId);
	assert.equal(control.row.synthetic_run_id, control.runId);
	assert.throws(() => createSyntheticLoadEvents({ runId, count: 99 }));
});

test("health normalization and latency percentiles use decision-facing assertions", () => {
	const health = normalizeHealth({
		data: [
			{
				received_rows: "4",
				unique_events: 2,
				unique_payloads: "3",
				duplicate_rows: 1,
				payload_conflicts: "1",
			},
		],
	});
	assert.doesNotThrow(() => assertSyntheticHealth(health));
	assert.doesNotThrow(() =>
		assertSyntheticHealth({ ...health, receivedRows: 5, duplicateRows: 2 }),
	);
	assert.throws(() => assertSyntheticHealth({ ...health, duplicateRows: 2 }));
	assert.deepEqual(latencySummary([5, 1, 4, 2, 3]), {
		count: 5,
		minMs: 1,
		maxMs: 5,
		p50Ms: 3,
		p95Ms: 5,
		p99Ms: 5,
	});
});

test("staging performance covers every typed decision endpoint", () => {
	const queries = decisionEndpointQueries({
		startDate: "2026-07-01",
		endDate: "2026-07-31",
		deploymentId: "deployment-1",
	});
	assert.equal(queries.length, 11);
	assert.equal(new Set(queries.map(({ name }) => name)).size, queries.length);
	assert.ok(
		queries.every(
			({ parameters }) => parameters.__tb__deployment === "deployment-1",
		),
	);
	assert.deepEqual(
		queries.find(({ name }) => name === "product_creator_activity")?.parameters,
		{ as_of_date: "2026-07-31", __tb__deployment: "deployment-1" },
	);
	assert.deepEqual(
		queries.find(({ name }) => name === "product_analytics_freshness")
			?.parameters,
		{ __tb__deployment: "deployment-1" },
	);
});

test("bundle measurement includes only unique same-origin Next.js scripts", () => {
	assert.deepEqual(
		extractSameOriginNextScriptUrls(
			'<script src="/_next/static/a.js"></script><script src="https://preview.vercel.app/_next/static/a.js"></script><script src="https://third-party.example/tracker.js"></script><script src="/other.js"></script>',
			"https://preview.vercel.app",
		),
		["https://preview.vercel.app/_next/static/a.js"],
	);
});

test("bundle budgets require absolute and live-baseline gates", () => {
	assert.deepEqual(
		evaluateBundleBudget({
			baselineBytes: 1_000_000,
			measuredBytes: 1_040_000,
			absoluteMaximumBytes: 5_000_000,
			regressionFactor: 1.05,
			regressionFloorBytes: 25_000,
		}),
		{
			absoluteMaximumBytes: 5_000_000,
			regressionLimitBytes: 1_050_000,
			deltaBytes: 40_000,
			regressionRatio: 1.04,
			passed: true,
		},
	);
	assert.equal(
		evaluateBundleBudget({
			baselineBytes: 1_000_000,
			measuredBytes: 1_200_000,
			absoluteMaximumBytes: 5_000_000,
			regressionFactor: 1.05,
			regressionFloorBytes: 25_000,
		}).passed,
		false,
	);
});

test("latency budgets require both absolute and measured-baseline gates", () => {
	const baseline = latencySummary([80, 90, 100, 110, 120]);
	assert.deepEqual(
		evaluateLatencyBudget({
			baseline,
			measured: latencySummary([90, 100, 110, 120, 130]),
			absoluteP95Ms: 2_500,
			regressionFactor: 2.5,
			regressionFloorMs: 250,
		}),
		{
			absoluteP95Ms: 2_500,
			regressionLimitMs: 370,
			regressionRatio: 130 / 120,
			passed: true,
		},
	);
	assert.equal(
		evaluateLatencyBudget({
			baseline,
			measured: latencySummary([500]),
			absoluteP95Ms: 2_500,
			regressionFactor: 2.5,
			regressionFloorMs: 250,
		}).passed,
		false,
	);
});

test("CI assertion normalization proves decision deduplication and conflict quarantine", () => {
	const assertions = normalizeCiAssertions({
		data: [
			{
				received_rows: "4",
				unique_events: "2",
				unique_payloads: "3",
				duplicate_rows: "1",
				payload_conflicts: "1",
				canonical_events: "1",
				decision_events: "1",
			},
		],
	});
	assert.doesNotThrow(() => assertSyntheticDecisions(assertions));
	assert.throws(() =>
		assertSyntheticDecisions({ ...assertions, decisionEvents: 2 }),
	);
});

test("copy assertion normalization exposes every marker independently", () => {
	assert.deepEqual(
		normalizeCopyAssertions({
			data: [
				{
					traffic_markers: "1",
					traffic_page_markers: "1",
					activation_markers: "1",
					retention_markers: "1",
				},
			],
		}),
		{
			trafficMarkers: 1,
			trafficPageMarkers: 1,
			activationMarkers: 1,
			retentionMarkers: 1,
		},
	);
});

test("the analytics workflow is statically restricted to staging", () => {
	const workflow = fs.readFileSync(
		new URL("../../../.github/workflows/analytics.yml", import.meta.url),
		"utf8",
	);
	assert.doesNotThrow(() => assertWorkflowSafety(workflow));
	assert.equal(
		workflow.match(
			/deployment create --allow-destructive-operations --(?:check|wait)/g,
		)?.length,
		2,
	);
	assert.equal(
		workflow.match(/node scripts\/analytics\/staging-ci\.js run-copies/g)
			?.length,
		4,
	);
	assert.equal(
		workflow.match(
			/--deployment-id "\$\{\{ steps\.tinybird\.outputs\.id \}\}"/g,
		)?.length,
		5,
	);
	assert.doesNotMatch(workflow, /tinybird-cloud-cli --cloud copy run/);
	assert.ok(
		workflow.indexOf(
			"Discard an unpromoted staging deployment before cleanup",
		) < workflow.indexOf("Delete strictly scoped synthetic raw rows"),
	);
});
