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
	dataMutationDeploymentParameters,
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
	reconcileCleanupTarget,
	resolveDeploymentState,
	resolveExactDeploymentLifecycle,
	resolveExactPromotionPlan,
	resolveOwnedDiscardTarget,
	resolveOwnedMutationTarget,
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

test("data mutations validate the exact deployment before using the staging selector", () => {
	assert.deepEqual(
		dataMutationDeploymentParameters({
			target: "staging",
			deploymentId: "7",
			expectedDeploymentId: "7",
		}),
		{ __tb__deployment: "staging" },
	);
	assert.deepEqual(
		dataMutationDeploymentParameters({
			target: "live",
			deploymentId: "7",
			expectedDeploymentId: "7",
		}),
		{},
	);
	for (const input of [
		{ target: "production", deploymentId: "7", expectedDeploymentId: "7" },
		{ target: "staging", deploymentId: "8", expectedDeploymentId: "7" },
		{
			target: "staging",
			deploymentId: "latest",
			expectedDeploymentId: "latest",
		},
	]) {
		assert.throws(() => dataMutationDeploymentParameters(input));
	}
});

test("mutation ownership follows only the exact staging candidate or promoted live ID", () => {
	assert.equal(
		resolveOwnedMutationTarget(
			{
				deployments: [
					{ id: "6", status: "data_ready", live: true },
					{ id: "7", status: "data_ready", live: false },
				],
			},
			"7",
		),
		"staging",
	);
	assert.equal(
		resolveOwnedMutationTarget(
			{
				deployments: [
					{ id: "7", status: "data_ready", live: true },
					{ id: "8", status: "data_ready", live: false },
				],
			},
			"7",
		),
		"live",
	);
	assert.equal(
		resolveOwnedMutationTarget(
			{
				deployments: [
					{ id: "6", status: "data_ready", live: true },
					{ id: "7", status: "creating_schema", live: false },
				],
			},
			"7",
		),
		"pending",
	);
	assert.equal(
		resolveOwnedMutationTarget(
			{
				deployments: [
					{ id: "6", status: "data_ready", live: true },
					{ id: "7", status: "promoting", live: false },
				],
			},
			"7",
		),
		"pending",
	);
	for (const deployments of [
		[{ id: "8", status: "data_ready", live: false }],
		[
			{ id: "7", status: "data_ready", live: false },
			{ id: "8", status: "data_ready", live: false },
		],
	]) {
		assert.throws(() => resolveOwnedMutationTarget({ deployments }, "7"));
	}
});

test("cleanup target transitions only once from staging to the owned live deployment", () => {
	assert.equal(reconcileCleanupTarget("staging", "staging"), "staging");
	assert.equal(reconcileCleanupTarget("staging", "live"), "live");
	assert.equal(reconcileCleanupTarget("live", "live"), "live");
	assert.throws(() => reconcileCleanupTarget("live", "staging"));
	assert.throws(() => reconcileCleanupTarget("staging", "pending"));
});

test("promotion and discard plans stay bound to exact numeric deployments", () => {
	const deployments = {
		deployments: [
			{ id: "6", status: "data_ready", live: true },
			{ id: "7", status: "data_ready", live: false },
		],
	};
	assert.deepEqual(resolveExactPromotionPlan(deployments, "7"), {
		previousLiveDeploymentId: "6",
	});
	assert.equal(resolveOwnedDiscardTarget(deployments, "7"), "ready");
	assert.throws(() => resolveExactPromotionPlan(deployments, "6"));
	assert.throws(() => resolveOwnedDiscardTarget(deployments, "6"));
	assert.throws(() =>
		resolveOwnedDiscardTarget(
			{
				deployments: [
					...deployments.deployments,
					{ id: "8", status: "creating_schema", live: false },
				],
			},
			"7",
		),
	);
});

test("exact deployment lifecycle refuses wrong IDs and distinguishes deletion", () => {
	assert.equal(
		resolveExactDeploymentLifecycle(
			{ deployment: { id: "7", status: "data_ready", live: true } },
			"7",
		),
		"live",
	);
	for (const [status, expected] of [
		["data_ready", "ready"],
		["creating_schema", "pending"],
		["deleting", "deleting"],
		["deleted", "deleted"],
		["failed", "failed"],
	]) {
		assert.equal(
			resolveExactDeploymentLifecycle(
				{ deployment: { id: "7", status, live: false } },
				"7",
			),
			expected,
		);
	}
	assert.throws(() =>
		resolveExactDeploymentLifecycle(
			{ deployment: { id: "8", status: "deleted" } },
			"7",
		),
	);
});

test("deployment state resolution binds cleanup to the exact deployment", () => {
	assert.deepEqual(resolveDeploymentState([{ id: 7, status: "Live" }], "7"), {
		target: "live",
		discard: false,
		promoted: true,
		pending: false,
		state: "live",
	});
	assert.deepEqual(
		resolveDeploymentState([{ id: 7, status: "Staging" }], "7"),
		{
			target: "staging",
			discard: true,
			promoted: false,
			pending: false,
			state: "staging",
		},
	);
	assert.deepEqual(
		resolveDeploymentState([{ id: 7, status: "In progress" }], "7"),
		{
			target: "staging",
			discard: false,
			promoted: false,
			pending: true,
			state: "in_progress",
		},
	);
	assert.deepEqual(resolveDeploymentState([{ id: 7, status: "Failed" }], "7"), {
		target: "staging",
		discard: true,
		promoted: false,
		pending: false,
		state: "failed",
	});
	assert.throws(() => resolveDeploymentState([{ id: 8, status: "Live" }], "7"));
	assert.throws(() =>
		resolveDeploymentState(
			[
				{ id: 7, status: "Live" },
				{ id: 7, status: "Staging" },
			],
			"7",
		),
	);
	assert.deepEqual(
		resolveDeploymentState([{ id: 7, status: "Deleted" }], "7"),
		{
			target: "staging",
			discard: false,
			promoted: false,
			pending: false,
			state: "deleted",
		},
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
	let ownershipChecks = 0;
	const results = await submitTinybirdCopyJobs({
		origin: "https://api.us-east.aws.tinybird.co",
		token: resourceToken,
		deploymentId: "6",
		pipes: [
			"snapshot_product_events_canonical_v1",
			"snapshot_product_traffic_daily_exact",
		],
		request: async (url, options) => {
			await options.beforeAttempt();
			requests.push({ url: String(url), options });
			now += 10;
			return responses.shift();
		},
		now: () => now,
		useDeploymentParameter: true,
		copyRunId: "run_12345678_staged",
		assertMutationOwnership: async () => {
			ownershipChecks += 1;
		},
	});
	assert.equal(ownershipChecks, 2);
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
	assert.match(requests[0].url, /__tb__deployment=staging/);
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
			await options.beforeAttempt();
			liveRequests.push({ url: String(url), options });
			return { data: { id: "copy_job_live" } };
		},
		assertMutationOwnership: async () => undefined,
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
			assertMutationOwnership: async () => undefined,
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
		11,
	);
	assert.doesNotMatch(workflow, /tinybird-cloud-cli --cloud copy run/);
	assert.ok(
		workflow.indexOf("Prove synthetic cleanup no longer affects queries") <
			workflow.indexOf(
				"Discard an unpromoted staging deployment after cleanup",
			),
	);
	assert.match(workflow, /steps\.promote\.outcome == 'failure'/);
	assert.match(workflow, /continue-on-error: true/);
	assert.match(workflow, /staging-ci\.js resolve-deployment-state/);
	assert.match(workflow, /resolution_exit=\$\?/);
	assert.match(workflow, /"\$resolution_exit" -ne 75/);
	assert.match(workflow, /--recover-pending "\$recover_pending"/);
	assert.match(workflow, /recover_pending=true/);
	assert.match(
		workflow,
		/Refuse to proceed without an authoritative live deployment/,
	);
	assert.match(
		workflow,
		/Discard an unpromoted staging deployment after cleanup\n {8}id: discard\n {8}if: always\(\) && \(steps\.deployment-state\.outputs\.discard == 'true' \|\| steps\.cleanup\.outputs\.requires_discard == 'true'\)/,
	);
	assert.match(
		workflow,
		/staging-ci\.js promote-deployment --deployment-id "\$\{\{ steps\.tinybird\.outputs\.id \}\}"/,
	);
	assert.match(workflow, /staging-ci\.js discard-deployment/);
	assert.doesNotMatch(
		workflow,
		/tinybird-cloud-cli --cloud deployment promote/,
	);
	assert.doesNotMatch(
		workflow,
		/tinybird-cloud-cli --cloud deployment discard/,
	);
	assert.equal(
		workflow.match(
			/steps\.deployment-state\.outputs\.target \|\| \(steps\.tinybird\.outputs\.needs_promotion == 'true' && 'staging' \|\| 'live'\)/g,
		)?.length,
		1,
	);
	assert.equal(
		workflow.match(
			/--target "\$\{\{ steps\.tinybird\.outputs\.needs_promotion == 'true' && 'staging' \|\| 'live' \}\}"/g,
		)?.length,
		2,
	);
	assert.match(workflow, /steps\.seed\.outcome != 'skipped'/);
	assert.match(workflow, /steps\.cleanup\.outputs\.requires_copies == 'true'/);
	assert.doesNotMatch(workflow, /steps\.seed\.outcome == 'success'/);
	assert.match(workflow, /echo "required=false" >> "\$GITHUB_OUTPUT"/);
	assert.match(workflow, /echo "required=true" >> "\$GITHUB_OUTPUT"/);
	assert.match(
		workflow,
		/Upload redacted staging evidence\n {8}if: always\(\) && steps\.cleanup\.outputs\.required == 'true'/,
	);
});

test("the seed persists cleanup state and partial evidence before ingestion", () => {
	const source = fs.readFileSync(
		new URL("../staging-ci.js", import.meta.url),
		"utf8",
	);
	const seedSource = source.slice(
		source.indexOf("const seed = async () => {"),
		source.indexOf("const waitForCopyVisibility"),
	);
	const stateWrite = seedSource.indexOf("writeJson(statePath, state, 0o600)");
	const artifactWrite = seedSource.indexOf("writeJson(artifactPath, artifact)");
	const firstDelivery = seedSource.indexOf("const concurrentDeliveries");
	assert.ok(stateWrite >= 0);
	assert.ok(artifactWrite > stateWrite);
	assert.ok(firstDelivery > artifactWrite);
	assert.match(seedSource, /assertions: \{ seedAccepted: false \}/);
	assert.match(seedSource, /rowsPlanned: fixture\.rows\.length/);
	assert.match(seedSource, /rowsAttempted: 0/);
	assert.ok(
		seedSource.indexOf("artifact.delivery.rowsAttempted += 1") <
			seedSource.indexOf("const result = await request"),
	);
	assert.match(
		seedSource,
		/artifact\.delivery\.rowsAccepted \+= 1;[\s\S]*writeJson\(artifactPath, artifact\);/,
	);
});

test("synthetic deletion targets the deployment used for ingestion", () => {
	const source = fs.readFileSync(
		new URL("../staging-ci.js", import.meta.url),
		"utf8",
	);
	const workflow = fs.readFileSync(
		new URL("../../../.github/workflows/analytics.yml", import.meta.url),
		"utf8",
	);
	const deleteSource = source.slice(
		source.indexOf("const deleteProductEventRows"),
		source.indexOf("const eraseSyntheticIdentity"),
	);
	assert.doesNotMatch(deleteSource, /__tb__min_deployment/);
	assert.equal(deleteSource.match(/\.\.\.deploymentParameters/g)?.length, 2);
	assert.match(
		source,
		/writeOutput\("discard", resolution\.pending \|\| resolution\.discard\)/,
	);
	assert.match(workflow, /node scripts\/analytics\/staging-ci\.js cleanup/);
	assert.match(source, /let target = await waitForOwnedMutationTarget/);
	assert.match(source, /writeOutput\("target", target\)/);
	assert.match(
		source,
		/target === "staging"[\s\S]*strategy: "deployment_discard"/,
	);
	assert.match(source, /writeOutput\("requires_copies", "false"\)/);
	assert.match(source, /writeOutput\("requires_copies", "true"\)/);
	assert.match(source, /writeOutput\("requires_discard", "true"\)/);
	assert.match(source, /writeOutput\("requires_discard", "false"\)/);
	assert.match(
		source,
		/target === "staging"[\s\S]*tokens\.TINYBIRD_STAGING_DEPLOY_TOKEN[\s\S]*tokens\.TINYBIRD_STAGING_READ_TOKEN/,
	);
	assert.match(
		workflow,
		/steps\.deployment-state\.outputs\.target \|\| \(steps\.tinybird\.outputs\.needs_promotion == 'true' && 'staging' \|\| 'live'\)/,
	);
	assert.equal(
		workflow.match(/--target "\$\{\{ steps\.cleanup\.outputs\.target \}\}"/g)
			?.length,
		1,
	);
	assert.equal(
		workflow.match(
			/--target "\$\{\{ steps\.cleanup-copies\.outputs\.target \}\}"/g,
		)?.length,
		1,
	);
	assert.match(workflow, /analytics-staging-out-of-scope-/);
	assert.match(
		workflow,
		/analytics-staging-37b8fef9-817f-4c3c-b21f-218c36a6077d/,
	);
});
