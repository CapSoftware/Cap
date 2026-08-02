import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
	applyCopyScheduleAction,
	assertExecutionScope,
	assertPreviewTinybirdAttestation,
	assertRepresentativeEndpointCoverage,
	assertSyntheticBusinessDecisions,
	assertSyntheticDecisions,
	assertSyntheticEndpointDecisions,
	assertSyntheticHealth,
	assertSyntheticIdentityFilters,
	assertSyntheticLoadDecisions,
	assertSyntheticLoadHealth,
	assertSyntheticMonetizationFilters,
	assertWorkflowSafety,
	classifyTinybirdCopyJobFailure,
	classifyTinybirdHttpFailure,
	copyScheduleMatchesAction,
	createDeploymentBoundary,
	createSyntheticDecisionEvents,
	createSyntheticErasureControl,
	createSyntheticEvents,
	createSyntheticLoadEvents,
	dataMutationDeploymentParameters,
	decisionEndpointQueries,
	evaluateBundleBudget,
	evaluateCopyPerformanceBudget,
	evaluateIngestionPerformanceBudget,
	evaluateLatencyBudget,
	extractSameOriginNextScriptUrls,
	FEATURE_BRANCH,
	FEATURE_PULL_REQUEST,
	formatTinybirdDateTime64,
	isUnscheduledCopyMutation,
	latencySummary,
	normalizeCiAssertions,
	normalizeCopyAssertions,
	normalizeHealth,
	PREVIEW_TINYBIRD_TOKEN_NAMES,
	reconcileCleanupTarget,
	resolveDeploymentCreatedAfterBoundary,
	resolveDeploymentState,
	resolveExactDeploymentLifecycle,
	resolveExactPromotionPlan,
	resolveOwnedDiscardTarget,
	resolveOwnedMutationTarget,
	STAGING_DATABASE_FINGERPRINT,
	STAGING_DATABASE_SCHEMA,
	STAGING_READ_ENDPOINTS,
	STAGING_READ_TOKEN_MAXIMUM_LIFETIME_MS,
	STAGING_READ_TOKEN_MINIMUM_LIFETIME_MS,
	STAGING_WORKSPACE_ID,
	selectRetiredStagingDeployment,
	selectStagingDeployment,
	submitTinybirdCopyJobs,
	syntheticIdentityFilterQueries,
	syntheticMonetizationFilterQueries,
	tokenScopeProbeWindow,
	tokenWorkspaceId,
	validateSyntheticRunId,
	validateTinybirdCredentials,
	waitForTinybirdCopyJob,
	waitForTinybirdCopyPipesQuiescent,
} from "../staging-ci-lib.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const token = (workspaceId = STAGING_WORKSPACE_ID) =>
	`p.${Buffer.from(JSON.stringify({ u: workspaceId })).toString("base64url")}.signature`;
const readJwt = ({
	workspaceId = STAGING_WORKSPACE_ID,
	expiresAt = Date.now() + STAGING_READ_TOKEN_MINIMUM_LIFETIME_MS + 1_000,
	scopes = STAGING_READ_ENDPOINTS.map((resource) => ({
		type: "PIPES:READ",
		resource,
	})),
} = {}) =>
	`ey.${Buffer.from(
		JSON.stringify({
			exp: Math.ceil(expiresAt / 1_000),
			scopes,
			workspace_id: workspaceId,
		}),
	).toString("base64url")}.signature`;

test("schedule pause compensates every schedule already paused", async () => {
	const calls = [];
	await assert.rejects(
		applyCopyScheduleAction({
			pipes: ["one", "two", "three"],
			action: "pause",
			setSchedule: async (pipe, action) => {
				calls.push([pipe, action]);
				if (pipe === "two" && action === "pause") {
					throw new Error("provider failure");
				}
			},
		}),
		/Failed to pause two: provider failure/,
	);
	assert.deepEqual(calls, [
		["one", "pause"],
		["two", "pause"],
		["one", "resume"],
	]);
});

test("schedule resume attempts every schedule before failing", async () => {
	const calls = [];
	await assert.rejects(
		applyCopyScheduleAction({
			pipes: ["one", "two", "three"],
			action: "resume",
			setSchedule: async (pipe, action) => {
				calls.push([pipe, action]);
				if (pipe !== "two") throw new Error(`${pipe} failed`);
			},
		}),
		/one: one failed, three: three failed/,
	);
	assert.deepEqual(calls, [
		["one", "resume"],
		["two", "resume"],
		["three", "resume"],
	]);
});

test("schedule state attestation distinguishes paused from active copies", () => {
	assert.equal(
		copyScheduleMatchesAction(
			{ data: { schedule: { status: "paused" } } },
			"pause",
		),
		true,
	);
	assert.equal(
		copyScheduleMatchesAction({ schedule: { status: "scheduled" } }, "resume"),
		true,
	);
	assert.equal(
		copyScheduleMatchesAction({ schedule: { status: "paused" } }, "resume"),
		false,
	);
	assert.equal(copyScheduleMatchesAction({}, "pause"), false);
	assert.equal(copyScheduleMatchesAction({}, "resume"), true);
});

test("on-demand Copy responses are distinguished from schedule failures", () => {
	assert.equal(
		isUnscheduledCopyMutation(422, {
			error: "The copy Pipe is not scheduled",
		}),
		true,
	);
	assert.equal(
		isUnscheduledCopyMutation(422, { error: "Another provider failure" }),
		false,
	);
	assert.equal(
		isUnscheduledCopyMutation(403, {
			error: "The copy Pipe is not scheduled",
		}),
		false,
	);
});

test("token scope probes stay inside the health endpoint window", () => {
	assert.deepEqual(
		tokenScopeProbeWindow(
			"2026-05-14T05:00:00.000Z",
			"2026-08-01T17:20:36.520Z",
		),
		{
			start_time: "2026-05-14 05:00:00.000",
			end_time: "2026-05-15 05:00:00.000",
		},
	);
	assert.deepEqual(
		tokenScopeProbeWindow(
			"2026-08-01T17:00:00.000Z",
			"2026-08-01T17:20:36.520Z",
		),
		{
			start_time: "2026-08-01 17:00:00.000",
			end_time: "2026-08-01 17:20:36.520",
		},
	);
	assert.throws(
		() =>
			tokenScopeProbeWindow(
				"2026-08-02T00:00:00.000Z",
				"2026-08-01T00:00:00.000Z",
			),
		/Token scope probe window is invalid/,
	);
});

test("Tinybird DateTime64 parameters are normalized to UTC without a suffix", () => {
	assert.equal(
		formatTinybirdDateTime64("2026-08-01T17:20:36.520Z"),
		"2026-08-01 17:20:36.520",
	);
	assert.equal(
		formatTinybirdDateTime64("2026-08-01T18:20:36.520+01:00"),
		"2026-08-01 17:20:36.520",
	);
	assert.equal(
		formatTinybirdDateTime64("2026-08-01 17:20:36.520"),
		"2026-08-01 17:20:36.520",
	);
	assert.throws(
		() => formatTinybirdDateTime64("2026-08-01 17:20:36"),
		/must include a timezone/,
	);
});

test("Copy quiescence waits until every approved pipe has no active jobs", async () => {
	let now = 1_000;
	let round = 0;
	const result = await waitForTinybirdCopyPipesQuiescent({
		origin: "https://api.us-east.aws.tinybird.co",
		token: token(),
		pipes: ["copy_one", "copy_two"],
		request: async (url) => {
			const pipe = new URL(url).searchParams.get("pipe_name");
			return {
				data: {
					jobs:
						round === 0 && pipe === "copy_one"
							? [{ id: "copy_job_active", status: "working" }]
							: [],
				},
			};
		},
		assertMutationOwnership: async () => undefined,
		now: () => now,
		wait: async (milliseconds) => {
			now += milliseconds;
			round += 1;
		},
		timeoutMs: 10_000,
		pollIntervalMs: 2_000,
	});
	assert.deepEqual(result, {
		activeJobs: 0,
		polls: 2,
		quiescenceMs: 2_000,
		visibleRequiredJobs: 0,
	});
});

test("workspace Copy quiescence treats unknown foreign job states as active", async () => {
	let now = 1_000;
	let round = 0;
	const urls = [];
	const result = await waitForTinybirdCopyPipesQuiescent({
		origin: "https://api.us-east.aws.tinybird.co",
		token: token(),
		workspaceWide: true,
		request: async (url) => {
			urls.push(String(url));
			return {
				data: {
					jobs:
						round === 0
							? [
									{
										id: "copy_job_foreign",
										pipe_name: "unrelated_copy",
										status: "queued",
									},
								]
							: [],
				},
			};
		},
		assertMutationOwnership: async () => undefined,
		now: () => now,
		wait: async (milliseconds) => {
			now += milliseconds;
			round += 1;
		},
	});
	assert.equal(result.polls, 2);
	assert.ok(urls.every((url) => !url.includes("pipe_name=")));
});

test("Tinybird failures retry only explicit rate and Copy quota rejections", () => {
	assert.deepEqual(
		classifyTinybirdHttpFailure({
			status: 403,
			payload: {
				error: "You have reached the maximum number of copy jobs (3).",
			},
			retryAfter: "12",
			now: 0,
		}),
		{
			status: 403,
			classification: "copy_quota",
			definitive: true,
			retryable: true,
			retryAfterMs: 12_000,
		},
	);
	assert.equal(
		classifyTinybirdHttpFailure({ status: 403, payload: {} }).retryable,
		false,
	);
	assert.equal(
		classifyTinybirdHttpFailure({ status: 429, payload: {} }).retryable,
		true,
	);
	assert.deepEqual(classifyTinybirdHttpFailure({ status: 503, payload: {} }), {
		status: 503,
		classification: "provider_failure",
		definitive: false,
		retryable: false,
		retryAfterMs: 0,
	});
	assert.equal(
		classifyTinybirdCopyJobFailure({
			error: "maximum number of copy jobs reached",
		}).retryable,
		true,
	);
	assert.equal(
		classifyTinybirdCopyJobFailure({ error: "query syntax failed" }).retryable,
		false,
	);
});

test("Copy quiescence rejects a malformed Jobs API payload", async () => {
	await assert.rejects(
		waitForTinybirdCopyPipesQuiescent({
			origin: "https://api.us-east.aws.tinybird.co",
			token: token(),
			pipes: ["copy_one"],
			request: async () => ({ data: {} }),
			assertMutationOwnership: async () => undefined,
		}),
		/invalid Copy job list/,
	);
});

test("Copy quiescence proves visibility of this run's completed jobs", async () => {
	let now = 1_000;
	let round = 0;
	const result = await waitForTinybirdCopyPipesQuiescent({
		origin: "https://api.us-east.aws.tinybird.co",
		token: token(),
		pipes: ["copy_one"],
		requiredVisibleJobIds: ["copy_job_expected"],
		request: async () => ({
			data: {
				jobs: round === 0 ? [] : [{ id: "copy_job_expected", status: "done" }],
			},
		}),
		assertMutationOwnership: async () => undefined,
		now: () => now,
		wait: async (milliseconds) => {
			now += milliseconds;
			round += 1;
		},
		timeoutMs: 10_000,
		pollIntervalMs: 2_000,
	});
	assert.deepEqual(result, {
		activeJobs: 0,
		polls: 2,
		quiescenceMs: 2_000,
		visibleRequiredJobs: 1,
	});

	await assert.rejects(
		waitForTinybirdCopyPipesQuiescent({
			origin: "https://api.us-east.aws.tinybird.co",
			token: token(),
			pipes: ["copy_one"],
			requiredVisibleJobIds: ["copy_job_missing"],
			request: async () => ({ data: { jobs: [] } }),
			assertMutationOwnership: async () => undefined,
			now: () => now,
			wait: async (milliseconds) => {
				now += milliseconds;
			},
			timeoutMs: 4_000,
			pollIntervalMs: 2_000,
		}),
		/could not attest the Copy jobs created by this run/,
	);
});

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
				TINYBIRD_STAGING_DEPLOY_TOKEN: token(),
				TINYBIRD_STAGING_INGEST_TOKEN: token(),
				TINYBIRD_STAGING_READ_TOKEN: readJwt(),
				TINYBIRD_STAGING_CLEANUP_TOKEN: token(),
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

test("staging read credentials require an exact, sufficiently-lived endpoint JWT", () => {
	for (const invalidToken of [
		token(),
		readJwt({ expiresAt: Date.now() + 60_000 }),
		readJwt({
			expiresAt: Date.now() + STAGING_READ_TOKEN_MAXIMUM_LIFETIME_MS + 60_000,
		}),
		readJwt({
			scopes: [
				...STAGING_READ_ENDPOINTS.map((resource) => ({
					type: "PIPES:READ",
					resource,
				})),
				{ type: "DATASOURCES:READ", resource: "product_events_v1" },
			],
		}),
		readJwt({ scopes: [] }),
		readJwt({
			scopes: STAGING_READ_ENDPOINTS.map((resource) => ({
				fixed_params: { hidden: "true" },
				type: "PIPES:READ",
				resource,
			})),
		}),
	]) {
		assert.throws(() =>
			validateTinybirdCredentials({
				url: "https://api.us-east.aws.tinybird.co",
				tokens: { TINYBIRD_STAGING_READ_TOKEN: invalidToken },
			}),
		);
	}
});

test("preview Tinybird attestation requires the exact SHA, host, and staging workspace", () => {
	const expectedTokenHashes = Object.fromEntries(
		PREVIEW_TINYBIRD_TOKEN_NAMES.map((name, index) => [
			name,
			String(index).padStart(64, "0"),
		]),
	);
	const attestation = {
		databaseFingerprint: STAGING_DATABASE_FINGERPRINT,
		databaseSchema: STAGING_DATABASE_SCHEMA,
		host: "https://api.us-east.aws.tinybird.co",
		sha: SHA,
		workspaces: PREVIEW_TINYBIRD_TOKEN_NAMES.map((name) => ({
			name,
			tokenHash: expectedTokenHashes[name],
			workspaceId: STAGING_WORKSPACE_ID,
		})),
	};
	assert.doesNotThrow(() =>
		assertPreviewTinybirdAttestation({
			attestation,
			expectedOrigin: attestation.host,
			expectedSha: SHA,
			expectedTokenHashes,
		}),
	);
	for (const invalid of [
		{ ...attestation, sha: "0".repeat(40) },
		{ ...attestation, host: "https://api.tinybird.co" },
		{ ...attestation, databaseFingerprint: "f".repeat(64) },
		{ ...attestation, databaseSchema: "0039_bumpy_phil_sheldon" },
		{ ...attestation, workspaces: attestation.workspaces.slice(1) },
		{
			...attestation,
			workspaces: attestation.workspaces.map((workspace, index) =>
				index === 0
					? {
							...workspace,
							workspaceId: "00000000-0000-4000-8000-000000000000",
						}
					: workspace,
			),
		},
		{
			...attestation,
			workspaces: attestation.workspaces.map((workspace, index) =>
				index === 0 ? { ...workspace, tokenHash: "f".repeat(64) } : workspace,
			),
		},
	]) {
		assert.throws(() =>
			assertPreviewTinybirdAttestation({
				attestation: invalid,
				expectedOrigin: attestation.host,
				expectedSha: SHA,
				expectedTokenHashes,
			}),
		);
	}
	assert.throws(
		() =>
			assertPreviewTinybirdAttestation({
				attestation: {
					...attestation,
					workspaces: attestation.workspaces.map((workspace, index) =>
						index === 0
							? { ...workspace, tokenHash: "f".repeat(64) }
							: workspace,
					),
				},
				expectedOrigin: attestation.host,
				expectedSha: SHA,
				expectedTokenHashes,
			}),
		new RegExp(PREVIEW_TINYBIRD_TOKEN_NAMES[0]),
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

test("deployment recovery resolves only one candidate created after its boundary", () => {
	const before = {
		deployments: [
			{ id: "6", status: "Live" },
			{ id: "5", status: "Deleted" },
		],
	};
	const boundary = createDeploymentBoundary(before);
	assert.deepEqual(boundary, {
		deploymentIds: ["5", "6"],
		liveDeploymentId: "6",
	});
	assert.deepEqual(
		resolveDeploymentCreatedAfterBoundary(
			{
				deployments: [
					...before.deployments,
					{ id: "7", status: "creating_schema" },
				],
			},
			boundary,
		),
		{ id: "7", needsPromotion: true },
	);
	assert.equal(
		resolveDeploymentCreatedAfterBoundary(before, boundary, {
			allowNone: true,
		}),
		undefined,
	);
	assert.throws(() =>
		resolveDeploymentCreatedAfterBoundary(
			{
				deployments: [
					...before.deployments,
					{ id: "7", status: "Staging" },
					{ id: "8", status: "failed" },
				],
			},
			boundary,
		),
	);
	assert.throws(() =>
		resolveDeploymentCreatedAfterBoundary(
			{
				deployments: [
					{ id: "6", status: "Staging" },
					{ id: "7", status: "Live" },
				],
			},
			boundary,
		),
	);
});

test("retired deployment cleanup selects only an older staging predecessor", () => {
	assert.deepEqual(
		selectRetiredStagingDeployment({
			deployments: [
				{
					id: "13",
					status: "Live",
					created_at: "2026-08-01T17:00:00.000Z",
				},
				{
					id: "10",
					status: "Staging",
					created_at: "2026-08-01T07:00:00.000Z",
				},
			],
		}),
		{ liveDeploymentId: "13", retiredDeploymentId: "10" },
	);
	assert.deepEqual(
		selectRetiredStagingDeployment({
			deployments: [
				{
					id: "13",
					status: "Live",
					created_at: "2026-08-01T17:00:00.000Z",
				},
			],
		}),
		{ liveDeploymentId: "13", retiredDeploymentId: undefined },
	);
	for (const deployments of [
		[
			{
				id: "13",
				status: "Live",
				created_at: "2026-08-01T17:00:00.000Z",
			},
			{
				id: "14",
				status: "Staging",
				created_at: "2026-08-01T18:00:00.000Z",
			},
		],
		[
			{
				id: "13",
				status: "Live",
				created_at: "2026-08-01T17:00:00.000Z",
			},
			{
				id: "14",
				status: "creating_schema",
				created_at: "2026-08-01T18:00:00.000Z",
			},
		],
	]) {
		assert.throws(() => selectRetiredStagingDeployment({ deployments }));
	}
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
		{
			data: {
				id: "t_canonical_pipe_node",
				job: { id: "copy_job_canonical", job_id: "copy_job_canonical" },
			},
		},
		{
			data: {
				id: "t_traffic_pipe_node",
				job: { job_id: "copy_job_traffic" },
			},
		},
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
		copyRunId: "run_12345678_staged",
		sourceCutoff: "2026-08-01T13:34:45.197Z",
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
	assert.equal(
		new URL(requests[0].url).searchParams.get("source_cutoff"),
		"2026-08-01 13:34:45.197",
	);
	assert.doesNotMatch(requests[0].url, /__tb__deployment/);
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
			return {
				data: {
					id: "t_live_pipe_node",
					job: { id: "copy_job_live" },
				},
			};
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
			pipes: ["snapshot_product_events_canonical_v1"],
			request: async () => ({ data: { id: "t_pipe_node_is_not_a_job" } }),
			assertMutationOwnership: async () => undefined,
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
	await assert.rejects(
		submitTinybirdCopyJobs({
			origin: "https://api.us-east.aws.tinybird.co",
			token: resourceToken,
			deploymentId: "6",
			pipes: ["snapshot_product_events_canonical_v1"],
			request: async () => {
				throw new Error("Tinybird request was rejected with HTTP 403");
			},
			assertMutationOwnership: async () => undefined,
		}),
		/Tinybird copy submission failed.*HTTP 403/,
	);
});

test("Copy prerequisite polling waits for a successful terminal job", async () => {
	let now = 1_000;
	let ownershipChecks = 0;
	const requests = [];
	const responses = [
		{ data: { status: "working" } },
		{ data: { job: { state: "completed" } } },
	];
	const result = await waitForTinybirdCopyJob({
		origin: "https://api.us-east.aws.tinybird.co",
		token: token(),
		jobId: "copy_job_state",
		request: async (url, options) => {
			await options.beforeAttempt();
			requests.push(String(url));
			return responses.shift();
		},
		assertMutationOwnership: async () => {
			ownershipChecks += 1;
		},
		now: () => now,
		wait: async (milliseconds) => {
			now += milliseconds;
		},
		timeoutMs: 10_000,
		pollIntervalMs: 2_000,
	});
	assert.deepEqual(result, {
		status: "completed",
		polls: 2,
		completionMs: 2_000,
	});
	assert.equal(ownershipChecks, 2);
	assert.equal(requests.length, 2);
	assert.ok(requests.every((url) => url.endsWith("/v0/jobs/copy_job_state")));
});

test("Copy prerequisite polling fails closed on rejection and timeout", async () => {
	await assert.rejects(
		waitForTinybirdCopyJob({
			origin: "https://api.us-east.aws.tinybird.co",
			token: token(),
			jobId: "copy_job_failed",
			request: async (_url, options) => {
				await options.beforeAttempt();
				return { data: { status: "failed" } };
			},
			assertMutationOwnership: async () => undefined,
		}),
		/Tinybird Copy job ended in failed/,
	);
	let now = 1_000;
	await assert.rejects(
		waitForTinybirdCopyJob({
			origin: "https://api.us-east.aws.tinybird.co",
			token: token(),
			jobId: "copy_job_timeout",
			request: async (_url, options) => {
				await options.beforeAttempt();
				return { data: { status: "working" } };
			},
			assertMutationOwnership: async () => undefined,
			now: () => now,
			wait: async (milliseconds) => {
				now += milliseconds;
			},
			timeoutMs: 2_000,
			pollIntervalMs: 2_000,
		}),
		/Timed out waiting for Tinybird Copy job/,
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
	const retainedLoad = createSyntheticLoadEvents({
		runId: `${runId}_retained`,
		count: 10_000,
		daySpan: 30,
		dimensionBucketCount: 8,
		now: new Date("2026-07-31T10:00:00.000Z"),
	});
	assert.equal(retainedLoad.dimensionBucketCount, 8);
	assert.equal(retainedLoad.daySpan, 30);
	assert.equal(
		new Set(retainedLoad.rows.map((row) => row.occurred_at.slice(0, 10))).size,
		30,
	);
	assert.ok(
		retainedLoad.rows.every(
			(row) =>
				Date.parse(`${row.occurred_at}Z`) <=
				Date.parse("2026-07-31T10:00:00.000Z"),
		),
	);
	assert.equal(new Set(retainedLoad.rows.map((row) => row.hostname)).size, 8);
	assert.equal(new Set(retainedLoad.rows.map((row) => row.pathname)).size, 8);
	assert.equal(
		new Set(retainedLoad.rows.map((row) => row.event_id)).size,
		10_000,
	);
	const midnightLoad = createSyntheticLoadEvents({
		runId: `${runId}_midnight`,
		count: 1_000,
		daySpan: 30,
		now: new Date("2026-07-31T00:01:00.000Z"),
	});
	assert.equal(
		new Set(midnightLoad.rows.map((row) => row.occurred_at.slice(0, 10))).size,
		30,
	);
	assert.ok(
		midnightLoad.rows.every(
			(row) =>
				Date.parse(`${row.occurred_at}Z`) <=
				Date.parse("2026-07-31T00:01:00.000Z"),
		),
	);
	const retainedPrices = new Set(
		retainedLoad.rows
			.map((row) => JSON.parse(row.properties).price_id)
			.filter(Boolean),
	);
	assert.equal(retainedPrices.size, 8);
	const retainedEndpointDimensions = new Set(
		retainedLoad.rows.map((row) => {
			const properties = JSON.parse(row.properties);
			return [
				row.event_name,
				row.platform,
				row.hostname,
				properties.price_id ?? "",
			].join(":");
		}),
	);
	assert.ok(retainedEndpointDimensions.size <= 80);
	const control = createSyntheticErasureControl({
		runId,
		now: new Date("2026-07-31T10:00:00.000Z"),
	});
	assert.equal(control.row.anonymous_id, fixture.anonymousId);
	assert.notEqual(control.row.user_id, fixture.userId);
	assert.notEqual(control.row.organization_id, fixture.organizationId);
	assert.equal(control.row.synthetic_run_id, control.runId);
	const decisions = createSyntheticDecisionEvents({
		runId,
		now: new Date("2026-07-31T10:00:00.000Z"),
	});
	assert.equal(decisions.rows.length, 28);
	assert.equal(decisions.runId, `${runId}_decisions`);
	assert.equal(new Set(decisions.rows.map((row) => row.event_id)).size, 28);
	assert.deepEqual(
		decisions.rows.map((row) => row.event_name),
		[
			"page_view",
			"page_engagement",
			"identity_linked",
			"user_signed_up",
			"share_link_created",
			"recording_completed",
			"page_view",
			"guest_checkout_started",
			"checkout_started",
			"checkout_started",
			"checkout_started",
			"trial_started",
			"purchase_completed",
			"subscription_renewed",
			"guest_checkout_started",
			"trial_converted",
			"subscription_changed",
			"subscription_changed",
			"subscription_cancelled",
			"subscription_refunded",
			"subscription_payment_failed",
			"page_view",
			"identity_linked",
			"purchase_completed",
			"subscription_renewed",
			"experiment_exposed",
			"analytics_delivery_loss",
			"share_link_created",
		],
	);
	assert.equal(decisions.rows[0].user_id, "");
	assert.equal(decisions.rows[1].user_id, "");
	assert.equal(decisions.rows[7].user_id, "");
	assert.equal(decisions.rows[2].anonymous_id, decisions.rows[0].anonymous_id);
	assert.notEqual(
		decisions.rows[2].anonymous_id,
		decisions.rows[23].anonymous_id,
	);
	assert.equal(decisions.rows[23].anonymous_id, decisions.rows[7].anonymous_id);
	assert.equal(
		JSON.parse(decisions.rows[23].properties).is_guest_checkout,
		true,
	);
	assert.ok(
		decisions.rows.every(
			(row) =>
				row.synthetic_run_id === decisions.runId &&
				row.hostname === decisions.hostname &&
				row.pathname === decisions.pathname,
		),
	);
	assert.match(
		decisions.hostname,
		/^synthetic-[0-9a-f]{12}\.preview\.cap\.so$/,
	);
	assert.match(decisions.pathname, /^\/analytics-synthetic-[0-9a-f]{12}$/);
	assert.throws(() => createSyntheticLoadEvents({ runId, count: 99 }));
	assert.throws(() => createSyntheticLoadEvents({ runId, count: 100_010 }));
	assert.throws(() =>
		createSyntheticLoadEvents({ runId, count: 100, daySpan: 0 }),
	);
	assert.throws(() =>
		createSyntheticLoadEvents({
			runId,
			count: 100,
			dimensionBucketCount: 101,
		}),
	);
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
		meanMs: 3,
		standardDeviationMs: Number(Math.SQRT2.toFixed(3)),
		coefficientOfVariation: 0.4714,
		p50Ms: 3,
		p95Ms: 5,
		p99Ms: 5,
	});
});

test("candidate load assertions require complete unique delivery", () => {
	assert.doesNotThrow(() =>
		assertSyntheticLoadHealth(
			{
				receivedRows: 1_000,
				uniqueEvents: 1_000,
				uniquePayloads: 1_000,
				duplicateRows: 0,
				payloadConflicts: 0,
			},
			1_000,
		),
	);
	for (const health of [
		{
			receivedRows: 999,
			uniqueEvents: 999,
			uniquePayloads: 999,
			duplicateRows: 0,
			payloadConflicts: 0,
		},
		{
			receivedRows: 1_001,
			uniqueEvents: 1_000,
			uniquePayloads: 1_000,
			duplicateRows: 0,
			payloadConflicts: 0,
		},
		{
			receivedRows: 1_000,
			uniqueEvents: 1_000,
			uniquePayloads: 1_000,
			duplicateRows: 0,
			payloadConflicts: 1,
		},
	]) {
		assert.throws(() => assertSyntheticLoadHealth(health, 1_000));
	}
});

test("business decision assertions require exact materialized metrics", () => {
	const assertions = {
		trafficVisitors: 3,
		trafficVisits: 3,
		trafficPageviews: 3,
		trafficBounces: 2,
		trafficDurationMs: 15_000,
		pageVisitors: 3,
		pageVisits: 3,
		pageviews: 3,
		pageLandings: 3,
		pageExits: 3,
		pageEngagedMs: 15_000,
		pageScrollDepth: 75,
		activationSignups: 1,
		activatedCreators: 1,
		retentionCreators: 1,
		retentionOrganizations: 1,
		identityLinkedVisitors: 2,
		identityLinkedUsers: 2,
		identitySignupUsers: 1,
		identityOrganizations: 1,
		identityGuestCheckoutVisitors: 2,
		identityGuestPurchasers: 1,
		identityAuthenticatedCheckoutUsers: 1,
		identityWebCheckoutUsers: 1,
		identityDesktopCheckoutUsers: 1,
		identityMobileCheckoutUsers: 1,
		identityCrossDeviceCheckoutUsers: 1,
		identityTrialUsers: 1,
		identityPurchasers: 1,
		decisionRevenueMinor: 7_000,
	};
	assert.doesNotThrow(() => assertSyntheticBusinessDecisions(assertions));
	assert.throws(() =>
		assertSyntheticBusinessDecisions({
			...assertions,
			activatedCreators: 0,
		}),
	);
});

test("load decision assertions require a high-cardinality materialization", () => {
	const expectedEvents = 1_000;
	const assertions = {
		receivedRows: expectedEvents,
		uniqueEvents: expectedEvents,
		uniquePayloads: expectedEvents,
		duplicateRows: 0,
		payloadConflicts: 0,
		canonicalEvents: expectedEvents,
		decisionEvents: expectedEvents,
		decisionRevenueMinor: 200_000,
		trafficVisitors: 100,
		trafficVisits: 100,
		trafficPageviews: 100,
		trafficBounces: 0,
		trafficDurationMs: 500_000,
		pageVisitors: 100,
		pageVisits: 100,
		pageviews: 100,
		pageLandings: 100,
		pageExits: 100,
		pageEngagedMs: 500_000,
		pageScrollDepth: 6_000,
		activationSignups: 100,
		activatedCreators: 100,
		retentionCreators: 100,
		retentionOrganizations: 100,
		identityLinkedVisitors: 100,
		identityLinkedUsers: 100,
		identitySignupUsers: 100,
		identityOrganizations: 100,
		identityGuestCheckoutVisitors: 0,
		identityGuestPurchasers: 0,
		identityAuthenticatedCheckoutUsers: 100,
		identityWebCheckoutUsers: 35,
		identityDesktopCheckoutUsers: 34,
		identityMobileCheckoutUsers: 31,
		identityCrossDeviceCheckoutUsers: 0,
		identityTrialUsers: 100,
		identityPurchasers: 100,
	};
	assert.doesNotThrow(() =>
		assertSyntheticLoadDecisions(assertions, expectedEvents, 32),
	);
	assert.throws(() =>
		assertSyntheticLoadDecisions(
			{ ...assertions, trafficVisits: expectedEvents - 1 },
			expectedEvents,
			32,
		),
	);
	assert.throws(
		() => assertSyntheticLoadDecisions(assertions, expectedEvents, 0),
		/dimension bucket count is invalid/,
	);
});

test("representative endpoint coverage requires mixed funnel and revenue data", () => {
	const row = (data) => ({ data });
	const cohorts = 10;
	const repeated = (count, value) =>
		Array.from({ length: count }, () => ({ ...value }));
	const payloads = {
		product_traffic_overview: row([{ pageviews: cohorts }]),
		product_traffic_totals: row([{ pageviews: cohorts }]),
		product_traffic_pages: row(repeated(cohorts, { pageviews: 1 })),
		product_traffic_sources: row(repeated(cohorts, { pageviews: 1 })),
		product_attribution: row([
			...repeated(cohorts + 1, { pageviews: 0 }),
			{ pageviews: cohorts * 3 },
		]),
		product_traffic_countries: row([{}]),
		product_traffic_technology: row([{}]),
		product_activation: row([{ signups: cohorts }]),
		product_creator_activity: row([{ dau: cohorts }]),
		product_creator_retention: row([{ creators: cohorts }]),
		product_identity_funnel: row([
			{ linked_users: cohorts, purchasers: cohorts },
		]),
		product_events_daily: row([
			...repeated(99, { events: 1, revenue_minor: 0 }),
			{ events: 1, revenue_minor: 20_000 },
		]),
		product_feature_adoption: row(repeated(10, { events: 10 })),
		product_experiment_outcomes: row([
			...repeated(cohorts * 3 - 1, {
				exposed_actors: 1,
				converted_actors: 0,
			}),
			{ exposed_actors: 1, converted_actors: cohorts },
		]),
		product_analytics_freshness: row([{}]),
	};
	assert.doesNotThrow(() =>
		assertRepresentativeEndpointCoverage({
			expectedEvents: 100,
			payloads,
		}),
	);
	const multiDayPayloads = {
		...payloads,
		product_traffic_overview: row([
			{ pageviews: cohorts / 2 },
			{ pageviews: cohorts / 2 },
		]),
		product_activation: row([
			{ signups: cohorts / 2 },
			{ signups: cohorts / 2 },
		]),
		product_creator_activity: row([{ dau: cohorts / 2 }]),
		product_creator_retention: row([
			{ creators: cohorts / 2 },
			{ creators: cohorts / 2 },
		]),
	};
	assert.doesNotThrow(() =>
		assertRepresentativeEndpointCoverage({
			daySpan: 2,
			dimensionBucketCount: 10,
			expectedEvents: 100,
			payloads: multiDayPayloads,
		}),
	);
	assert.throws(() =>
		assertRepresentativeEndpointCoverage({
			expectedEvents: 100,
			payloads: { ...payloads, product_identity_funnel: row([]) },
		}),
	);
	assert.throws(
		() =>
			assertRepresentativeEndpointCoverage({
				daySpan: 0,
				expectedEvents: 100,
				payloads,
			}),
		/fixture dimensions are invalid/,
	);
});

test("synthetic monetization filters prove lifecycle values and legacy coverage", () => {
	const queries = syntheticMonetizationFilterQueries({
		date: "2026-07-31",
		deploymentId: "7",
		syntheticRunId: "run_12345678_decisions",
	});
	const payloads = Object.fromEntries(
		queries.map((query) => [
			query.label,
			{
				data:
					query.expectedRows === 0
						? []
						: [
								{
									events: query.expectedEvents,
									revenue_minor: query.expectedRevenueMinor,
									...query.expectedFields,
								},
							],
			},
		]),
	);
	assert.doesNotThrow(() =>
		assertSyntheticMonetizationFilters({ payloads, queries }),
	);
	assert.throws(() =>
		assertSyntheticMonetizationFilters({
			payloads: {
				...payloads,
				renewal_revenue: {
					data: [{ events: 1, revenue_minor: 2_499 }],
				},
			},
			queries,
		}),
	);
});

test("synthetic identity filters prove source attribution and empty totals", () => {
	const queries = syntheticIdentityFilterQueries({
		date: "2026-07-31",
		deploymentId: "7",
		syntheticRunId: "run_12345678_decisions",
	});
	const payloads = Object.fromEntries(
		queries.map((query) => [query.label, { data: [query.expected] }]),
	);
	assert.doesNotThrow(() =>
		assertSyntheticIdentityFilters({ payloads, queries }),
	);
	assert.throws(() =>
		assertSyntheticIdentityFilters({
			payloads: {
				...payloads,
				referral_identity: {
					data: [{ ...queries[1].expected, organizations: 1 }],
				},
			},
			queries,
		}),
	);
});

test("typed endpoint assertions require exact public response semantics", () => {
	const row = (value) => ({ data: [value] });
	const date = "2026-07-31";
	const appVersion = "staging-decisions-123456789abc";
	const hostname = "synthetic-123456789abc.preview.cap.so";
	const pathname = "/analytics-synthetic-123456789abc";
	const event = (eventName, source, platform, overrides = {}) => ({
		date,
		event_name: eventName,
		schema_version: 1,
		source,
		platform,
		app_version: appVersion,
		hostname,
		channel: "direct",
		plan_id: "",
		recording_status: "",
		payment_status: "",
		subscription_status: "",
		currency: "",
		billing_interval: "",
		change_kind: "",
		previous_status: "",
		new_status: "",
		previous_plan_id: "",
		quantity: 0,
		previous_quantity: 0,
		new_quantity: 0,
		seat_delta: 0,
		first_purchase: "",
		guest_checkout: "",
		onboarding: "",
		cancel_at_period_end: "",
		fully_refunded: "",
		ended_at: 0,
		trial_end_at: 0,
		amount_due_minor: 0,
		attempt_count: 0,
		experiment_id: "",
		experiment_variant: "",
		assignment_version: "",
		delivery_loss_count: 0,
		events: 1,
		actors: 1,
		users: 1,
		organizations: 1,
		revenue_minor: 0,
		...overrides,
	});
	const eventShapes = [
		event("page_view", "client", "web", {
			events: 2,
			actors: 2,
			channel: "paid_search",
			users: 0,
			organizations: 0,
		}),
		event("page_view", "client", "web", {
			channel: "referral",
			users: 0,
			organizations: 0,
		}),
		event("page_engagement", "client", "web", {
			users: 0,
			organizations: 0,
		}),
		event("identity_linked", "server", "server", {
			events: 2,
			actors: 2,
			users: 2,
		}),
		event("user_signed_up", "server", "web"),
		event("share_link_created", "server", "server", { events: 2 }),
		event("recording_completed", "client", "desktop", {
			recording_status: "success",
		}),
		event("guest_checkout_started", "server", "web", {
			plan_id: "price_pro_annual",
			quantity: 1,
			events: 2,
			actors: 2,
			users: 0,
			organizations: 0,
		}),
		event("checkout_started", "server", "web", {
			plan_id: "price_pro_annual",
			quantity: 1,
			onboarding: "false",
		}),
		event("checkout_started", "server", "desktop", {
			plan_id: "price_pro_annual",
			quantity: 1,
			onboarding: "false",
		}),
		event("checkout_started", "server", "mobile", {
			plan_id: "price_pro_annual",
			quantity: 1,
			onboarding: "false",
		}),
		event("trial_started", "server", "web", {
			plan_id: "price_pro_annual",
			subscription_status: "trialing",
			currency: "GBP",
			billing_interval: "year",
			quantity: 1,
			guest_checkout: "false",
			onboarding: "false",
			trial_end_at: 1_900_604_800,
		}),
		event("purchase_completed", "server", "web", {
			schema_version: 3,
			plan_id: "price_pro_annual",
			payment_status: "paid",
			subscription_status: "active",
			currency: "GBP",
			billing_interval: "year",
			revenue_minor: 2_500,
			quantity: 1,
			first_purchase: "true",
			guest_checkout: "false",
			onboarding: "false",
		}),
		event("purchase_completed", "server", "web", {
			schema_version: 3,
			plan_id: "price_guest_monthly",
			payment_status: "paid",
			subscription_status: "active",
			currency: "GBP",
			billing_interval: "month",
			revenue_minor: 1_500,
			quantity: 1,
			first_purchase: "true",
			guest_checkout: "true",
			onboarding: "false",
		}),
		event("subscription_renewed", "server", "server", {
			schema_version: 2,
			plan_id: "price_pro_annual",
			currency: "GBP",
			revenue_minor: 2_500,
		}),
		event("subscription_renewed", "server", "server", {
			currency: "GBP",
			revenue_minor: 1_000,
		}),
		event("trial_converted", "server", "server", {
			schema_version: 2,
			plan_id: "price_pro_annual",
			subscription_status: "active",
			previous_status: "trialing",
			new_status: "active",
		}),
		event("subscription_changed", "server", "server", {
			schema_version: 2,
			plan_id: "price_pro_annual",
			change_kind: "plan",
			previous_plan_id: "price_pro_monthly",
		}),
		event("subscription_changed", "server", "server", {
			schema_version: 2,
			plan_id: "price_pro_annual",
			change_kind: "seats",
			previous_plan_id: "price_pro_annual",
			previous_quantity: 1,
			new_quantity: 3,
			seat_delta: 2,
		}),
		event("subscription_cancelled", "server", "server", {
			schema_version: 2,
			plan_id: "price_pro_annual",
			subscription_status: "canceled",
			cancel_at_period_end: "false",
			ended_at: 1_900_000_000,
		}),
		event("subscription_refunded", "server", "server", {
			schema_version: 2,
			plan_id: "price_pro_annual",
			currency: "GBP",
			revenue_minor: -500,
			fully_refunded: "false",
		}),
		event("subscription_payment_failed", "server", "server", {
			schema_version: 2,
			plan_id: "price_pro_annual",
			currency: "GBP",
			amount_due_minor: 2_500,
			attempt_count: 2,
		}),
		event("experiment_exposed", "client", "web", {
			experiment_id: "synthetic-checkout-copy",
			experiment_variant: "treatment",
			assignment_version: "v1",
		}),
		event("analytics_delivery_loss", "client", "desktop", {
			delivery_loss_count: 3,
		}),
	];
	const adoptionShapes = [
		["page_view", 3, 3, 0, 0],
		["page_engagement", 1, 1, 0, 0],
		["identity_linked", 2, 2, 2, 1],
		["user_signed_up", 1, 1, 1, 1],
		["share_link_created", 2, 1, 1, 1],
		["recording_completed", 1, 1, 1, 1],
		["guest_checkout_started", 2, 2, 0, 0],
		["checkout_started", 3, 1, 1, 1],
		["trial_started", 1, 1, 1, 1],
		["purchase_completed", 2, 1, 1, 1],
		["subscription_renewed", 2, 1, 1, 1],
		["trial_converted", 1, 1, 1, 1],
		["subscription_changed", 2, 1, 1, 1],
		["subscription_cancelled", 1, 1, 1, 1],
		["subscription_refunded", 1, 1, 1, 1],
		["subscription_payment_failed", 1, 1, 1, 1],
		["experiment_exposed", 1, 1, 1, 1],
		["analytics_delivery_loss", 1, 1, 1, 1],
	];
	const payloads = {
		product_traffic_overview: row({
			date,
			visitors: 3,
			visits: 3,
			pageviews: 3,
			views_per_visit: 1,
			bounce_rate: 66.67,
			visit_duration_ms: 5_000,
			engaged_ms: 15_000,
		}),
		product_traffic_totals: row({
			visitors: 3,
			visits: 3,
			pageviews: 3,
			views_per_visit: 1,
			bounce_rate: 66.67,
			visit_duration_ms: 5_000,
			engaged_ms: 15_000,
		}),
		product_traffic_pages: row({
			pathname,
			visitors: 3,
			visits: 3,
			pageviews: 3,
			landings: 3,
			exits: 3,
			time_on_page_ms: 5_000,
			average_scroll_depth: 25,
		}),
		product_traffic_sources: {
			data: [
				{
					channel: "paid_search",
					source: "google",
					medium: "cpc",
					campaign: "synthetic-campaign",
					visitors: 2,
					visits: 2,
					pageviews: 2,
					bounce_rate: 50,
				},
				{
					channel: "referral",
					source: "synthetic-partner",
					medium: "referral",
					campaign: "",
					visitors: 1,
					visits: 1,
					pageviews: 1,
					bounce_rate: 100,
				},
			],
		},
		product_attribution: {
			data: [
				{
					attribution_model: "first",
					source: "first-touch",
					medium: "first",
					campaign: "first-campaign",
					visitors: 3,
					visits: 3,
					pageviews: 3,
				},
				{
					attribution_model: "last",
					source: "last-touch",
					medium: "last",
					campaign: "last-campaign",
					visitors: 3,
					visits: 3,
					pageviews: 3,
				},
				{
					attribution_model: "session",
					source: "google",
					medium: "cpc",
					campaign: "synthetic-campaign",
					visitors: 2,
					visits: 2,
					pageviews: 2,
				},
				{
					attribution_model: "session",
					source: "synthetic-partner",
					medium: "referral",
					campaign: "",
					visitors: 1,
					visits: 1,
					pageviews: 1,
				},
			],
		},
		product_traffic_countries: row({
			country: "US",
			visitors: 3,
			visits: 3,
			pageviews: 3,
		}),
		product_traffic_technology: row({
			device: "desktop",
			browser: "Chrome",
			os: "macOS",
			visitors: 3,
			visits: 3,
			pageviews: 3,
		}),
		product_activation: row({
			cohort_date: date,
			signups: 1,
			activated_creators: 1,
			activation_rate: 100,
			average_time_to_activation_ms: 1_000,
		}),
		product_creator_activity: row({
			as_of_date: date,
			dau: 1,
			wau: 1,
			mau: 1,
			daily_active_organizations: 1,
			new_creators: 1,
			returning_creators: 0,
			dau_wau_stickiness: 100,
			dau_mau_stickiness: 100,
		}),
		product_creator_retention: row({
			cohort_date: date,
			activity_date: date,
			cohort_day: 0,
			platform: "all",
			creators: 1,
			organizations: 1,
		}),
		product_identity_funnel: row({
			linked_visitors: 2,
			linked_users: 2,
			signup_users: 1,
			organizations: 1,
			guest_checkout_visitors: 2,
			guest_purchasers: 1,
			authenticated_checkout_users: 1,
			web_checkout_users: 1,
			desktop_checkout_users: 1,
			mobile_checkout_users: 1,
			cross_device_checkout_users: 1,
			trial_users: 1,
			purchasers: 1,
			signup_rate: 50,
			purchase_rate: 50,
		}),
		product_events_daily: {
			data: eventShapes,
		},
		product_feature_adoption: {
			data: adoptionShapes.map(
				([eventName, events, actorDays, userDays, organizationDays]) => ({
					event_name: eventName,
					events,
					actor_days: actorDays,
					user_days: userDays,
					organization_days: organizationDays,
				}),
			),
		},
		product_experiment_outcomes: {
			data: [
				["signup", 0],
				["share_created", 1],
				["paid_purchase", 0],
			].map(([outcomeName, convertedActors]) => ({
				experiment_id: "synthetic-checkout-copy",
				assignment_version: "v1",
				variant: "treatment",
				platform: "web",
				app_version: appVersion,
				outcome_name: outcomeName,
				exposed_actors: 1,
				converted_actors: convertedActors,
				conversion_rate: convertedActors * 100,
			})),
		},
		product_analytics_freshness: row({
			latest_received_hour: "2026-07-31 10:00:00",
			product_calculated_at: "2026-07-31 10:01:00",
			traffic_calculated_at: "2026-07-31 10:01:00",
			retention_calculated_at: "2026-07-31 10:01:00",
			identity_calculated_at: "2026-07-31 10:01:00",
			attribution_calculated_at: "2026-07-31 10:01:00",
			experiment_calculated_at: "2026-07-31 10:01:00",
		}),
	};
	const input = { appVersion, date, hostname, pathname, payloads };
	assert.doesNotThrow(() => assertSyntheticEndpointDecisions(input));
	assert.throws(() =>
		assertSyntheticEndpointDecisions({
			...input,
			payloads: {
				...payloads,
				product_activation: row({
					...payloads.product_activation.data[0],
					activated_creators: 0,
				}),
			},
		}),
	);
});

test("staging performance covers every typed decision endpoint", () => {
	const queries = decisionEndpointQueries({
		startDate: "2026-07-01",
		endDate: "2026-07-31",
		deploymentId: "deployment-1",
	});
	assert.equal(queries.length, 15);
	assert.equal(new Set(queries.map(({ name }) => name)).size, queries.length);
	assert.ok(
		queries.every(
			({ parameters }) => parameters.__tb__deployment === "deployment-1",
		),
	);
	const retainedQueries = decisionEndpointQueries({
		startDate: "2026-07-01",
		endDate: "2026-07-31",
		deploymentId: "deployment-0",
		excludedEndpointNames: [
			"product_traffic_totals",
			"product_attribution",
			"product_identity_funnel",
			"product_experiment_outcomes",
		],
	});
	assert.equal(retainedQueries.length, 11);
	assert.ok(
		retainedQueries.every(
			({ name }) =>
				!{
					product_traffic_totals: true,
					product_attribution: true,
					product_identity_funnel: true,
					product_experiment_outcomes: true,
				}[name],
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
	const syntheticQueries = decisionEndpointQueries({
		startDate: "2026-07-01",
		endDate: "2026-07-31",
		deploymentId: "deployment-1",
		syntheticRunId: "run_12345678_load",
	});
	assert.ok(
		syntheticQueries.every(
			({ name, parameters }) =>
				name === "product_analytics_freshness" ||
				parameters.synthetic_run_id === "run_12345678_load",
		),
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

test("ingestion budgets separate startup smoke latency from sustained throughput", () => {
	const measured = ({ rows, batches, wallClockMs, p95Ms, maxMs = p95Ms }) => ({
		rowsPlanned: rows,
		rowsAttempted: rows,
		rowsAccepted: rows,
		batchSize: 500,
		concurrency: 4,
		batches,
		batchLatency: { count: batches, p95Ms, maxMs },
		errorCount: 0,
		errorRate: 0,
		retryAttempts: 0,
		wallClockMs,
	});
	const smoke = measured({
		rows: 1_000,
		batches: 2,
		wallClockMs: 3_460,
		p95Ms: 3_455,
	});
	const sustained = measured({
		rows: 100_000,
		batches: 200,
		wallClockMs: 128_700,
		p95Ms: 4_000,
		maxMs: 4_743,
	});
	const evaluate = (overrides = {}) =>
		evaluateIngestionPerformanceBudget({
			smoke,
			sustained,
			batchP95BudgetMs: 5_000,
			smokeWallClockBudgetMs: 10_000,
			minimumRowsPerSecond: 500,
			...overrides,
		});
	const passed = evaluate();
	assert.equal(passed.passed, true);
	assert.equal(passed.smoke.passed, true);
	assert.ok(passed.sustained.rowsPerSecond > 777);
	assert.equal(
		evaluate({ sustained: { ...sustained, wallClockMs: 250_000 } }).passed,
		false,
	);
	assert.equal(
		evaluate({
			sustained: {
				...sustained,
				batchLatency: { ...sustained.batchLatency, p95Ms: 5_001 },
			},
		}).passed,
		false,
	);
	assert.equal(
		evaluate({ sustained: { ...sustained, rowsAccepted: 99_999 } }).passed,
		false,
	);
	assert.equal(
		evaluate({ sustained: { ...sustained, retryAttempts: 1 } }).passed,
		false,
	);
	assert.equal(
		evaluate({
			sustained: {
				...sustained,
				batchLatency: { ...sustained.batchLatency, count: 199 },
			},
		}).passed,
		false,
	);
	assert.equal(
		evaluate({ sustained: { ...sustained, concurrency: 2 } }).passed,
		false,
	);
});

test("Copy performance budgets gate visibility and pipeline regressions", () => {
	const baseline = {
		pipelineWallClockMs: 80_000,
		visibility: latencySummary([5_000, 10_000, 20_000]),
	};
	assert.deepEqual(
		evaluateCopyPerformanceBudget({
			absolutePipelineMs: 600_000,
			absoluteVisibilityP95Ms: 120_000,
			baseline,
			measured: {
				pipelineWallClockMs: 100_000,
				visibility: latencySummary([10_000, 20_000, 30_000]),
			},
			regressionFactor: 2,
			regressionFloorMs: 30_000,
		}),
		{
			mode: "baseline_comparison",
			absolutePipelineMs: 600_000,
			absoluteVisibilityP95Ms: 120_000,
			regressionFactor: 2,
			regressionFloorMs: 30_000,
			pipelineRegressionLimitMs: 160_000,
			visibilityRegressionLimitMs: 50_000,
			pipelineRegressionRatio: 1.25,
			visibilityRegressionRatio: 1.5,
			passed: true,
		},
	);
	assert.equal(
		evaluateCopyPerformanceBudget({
			absolutePipelineMs: 600_000,
			absoluteVisibilityP95Ms: 120_000,
			baseline,
			measured: {
				pipelineWallClockMs: 200_000,
				visibility: latencySummary([60_000]),
			},
			regressionFactor: 2,
			regressionFloorMs: 30_000,
		}).passed,
		false,
	);
	assert.equal(
		evaluateCopyPerformanceBudget({
			absolutePipelineMs: 600_000,
			absoluteVisibilityP95Ms: 120_000,
			baseline: null,
			measured: {
				pipelineWallClockMs: 80_000,
				visibility: latencySummary([20_000]),
			},
			regressionFactor: 2,
			regressionFloorMs: 30_000,
		}).mode,
		"baseline_capture",
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
					decision_markers: "1",
					traffic_markers: "1",
					traffic_page_markers: "1",
					activation_markers: "1",
					retention_markers: "1",
					identity_markers: "1",
					attribution_markers: "1",
					experiment_markers: "1",
					health_markers: "1",
				},
			],
		}),
		{
			decisionMarkers: 1,
			trafficMarkers: 1,
			trafficPageMarkers: 1,
			activationMarkers: 1,
			retentionMarkers: 1,
			identityMarkers: 1,
			attributionMarkers: 1,
			experimentMarkers: 1,
			healthMarkers: 1,
		},
	);
});

test("the analytics workflow is statically restricted to staging", () => {
	const workflow = fs.readFileSync(
		new URL("../../../.github/workflows/analytics.yml", import.meta.url),
		"utf8",
	);
	assert.doesNotThrow(() => assertWorkflowSafety(workflow));
	const reorderedWorkflow = workflow
		.replace("staging-ci.js seed", "staging-ci.js __seed_placeholder__")
		.replace("staging-ci.js promote-deployment", "staging-ci.js seed")
		.replace(
			"staging-ci.js __seed_placeholder__",
			"staging-ci.js promote-deployment",
		);
	assert.throws(() => assertWorkflowSafety(reorderedWorkflow));
	assert.equal(
		workflow.match(
			/deployment create --allow-destructive-operations --(?:check|wait)/g,
		)?.length,
		2,
	);
	assert.equal(
		workflow.match(/node scripts\/analytics\/staging-ci\.js run-copies/g)
			?.length,
		2,
	);
	assert.equal(
		workflow.match(
			/--deployment-id "\$\{\{ steps\.tinybird\.outputs\.id \}\}"/g,
		)?.length,
		15,
	);
	assert.doesNotMatch(workflow, /tinybird-cloud-cli --cloud copy run/);
	assert.ok(
		workflow.indexOf("Refuse a preview bound outside Tinybird staging") <
			workflow.indexOf("Record Tinybird deployment boundary"),
	);
	assert.match(
		workflow,
		/Refuse a preview bound outside Tinybird staging[\s\S]*CAP_ANALYTICS_STAGING_TEST_SECRET[\s\S]*staging-ci\.js attest-preview/,
	);
	assert.match(
		workflow,
		/ANALYTICS_PREVIEW_ACCESS_URL: https:\/\/cap-web-git-codex-first-party-analytics-mc-ilroy\.vercel\.app/,
	);
	assert.match(
		workflow,
		/Refuse a preview bound outside Tinybird staging[\s\S]*VERCEL_PREVIEW_SHARE_SECRET[\s\S]*staging-ci\.js attest-preview/,
	);
	assert.ok(
		workflow.indexOf(
			"Prove promoted delivery, business values, and decision deduplication",
		) < workflow.indexOf("Prove exact staging rollback and restoration"),
	);
	assert.ok(
		workflow.indexOf("Prove exact staging rollback and restoration") <
			workflow.indexOf(
				"Delete the scoped identity through the exact-SHA application path",
			),
	);
	assert.ok(
		workflow.indexOf(
			"Delete the scoped identity through the exact-SHA application path",
		) <
			workflow.indexOf(
				"Prove identity erasure and out-of-scope control preservation",
			),
	);
	assert.ok(
		workflow.indexOf(
			"Prove identity erasure and out-of-scope control preservation",
		) <
			workflow.indexOf(
				"Quiesce scheduled and active Copy jobs before final cleanup",
			),
	);
	assert.match(
		workflow,
		/Delete the scoped identity through the exact-SHA application path[\s\S]*CAP_ANALYTICS_STAGING_TEST_SECRET[\s\S]*staging-ci\.js erase-synthetic-identity/,
	);
	assert.ok(
		workflow.indexOf("Prove synthetic cleanup no longer affects queries") <
			workflow.indexOf("Resume reviewed Copy schedules"),
	);
	assert.ok(
		workflow.indexOf("Resume reviewed Copy schedules") <
			workflow.indexOf("Finalize the fully verified staging promotion"),
	);
	assert.ok(
		workflow.indexOf("Finalize the fully verified staging promotion") <
			workflow.indexOf("Restore the previous staging deployment on failure"),
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
		/Discard an unpromoted staging deployment after cleanup\n {8}id: discard\n {8}if: always\(\) && steps\.rollback\.outcome != 'success' && \(steps\.deployment-state\.outputs\.discard == 'true' \|\| steps\.cleanup\.outputs\.requires_discard == 'true'\)/,
	);
	assert.match(
		workflow,
		/staging-ci\.js promote-deployment --deployment-id "\$\{\{ steps\.tinybird\.outputs\.id \}\}"/,
	);
	assert.match(workflow, /staging-ci\.js discard-deployment/);
	assert.match(workflow, /staging-ci\.js drill-rollback/);
	assert.match(
		workflow,
		/Prove exact staging rollback and restoration[\s\S]*TINYBIRD_STAGING_READ_TOKEN[\s\S]*--state "\$RUNNER_TEMP\/analytics-staging-state\.json"/,
	);
	assert.match(workflow, /staging-ci\.js finalize-promotion/);
	assert.match(workflow, /staging-ci\.js rollback-promotion/);
	assert.match(
		workflow,
		/steps\.promote\.outputs\.previous_live_id != '' && steps\.finalize\.outcome != 'success' && steps\.rollback-drill\.outputs\.rollback_target_usable != 'false' && \(steps\.seed\.outcome == 'skipped' \|\| steps\.verify-cleanup\.outcome == 'success'\)/,
	);
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
		1,
	);
	assert.match(
		workflow,
		/Prove exact candidate endpoints before promotion[\s\S]*staging-ci\.js verify-preseed/,
	);
	assert.ok(
		workflow.indexOf("Prove exact candidate endpoints before promotion") <
			workflow.indexOf("Promote the verified staging deployment"),
	);
	assert.ok(
		workflow.indexOf(
			"Refuse to proceed without an authoritative live deployment",
		) <
			workflow.indexOf(
				"Seed bounded duplicate and conflict probes into exact live staging",
			),
	);
	assert.ok(
		workflow.indexOf(
			"Seed bounded duplicate and conflict probes into exact live staging",
		) < workflow.indexOf("Prove least-privilege staging token scopes"),
	);
	assert.match(workflow, /35-postseed/);
	assert.match(workflow, /36-postbrowser/);
	assert.match(workflow, /37-postpreview/);
	assert.match(workflow, /38-postserver/);
	assert.ok(
		workflow.indexOf("Prove the exact-SHA deployed browser tracker") <
			workflow.indexOf(
				"Probe the exact-SHA Vercel browser collector and staging rate limit",
			),
	);
	assert.ok(
		workflow.indexOf(
			"Probe the exact-SHA Vercel browser collector and staging rate limit",
		) < workflow.indexOf("Prove exact-SHA durable server delivery"),
	);
	assert.ok(
		workflow.indexOf("Prove exact-SHA durable server delivery") <
			workflow.indexOf("Rebuild promoted decision and health copies"),
	);
	assert.match(
		workflow,
		/Prove exact-SHA durable server delivery[\s\S]*CAP_ANALYTICS_STAGING_TEST_SECRET[\s\S]*staging-ci\.js probe-server/,
	);
	assert.ok(
		workflow.indexOf("Rebuild promoted decision and health copies") <
			workflow.indexOf("Measure populated decision endpoint performance"),
	);
	assert.match(
		workflow,
		/Rebuild promoted decision and health copies[\s\S]{0,600}TINYBIRD_STAGING_SCHEDULER_TOKEN:[\s\S]{0,400}staging-ci\.js run-copies/,
	);
	assert.match(
		workflow,
		/Retract synthetic rows from every derived copy[\s\S]{0,600}TINYBIRD_STAGING_SCHEDULER_TOKEN:[\s\S]{0,400}staging-ci\.js run-copies/,
	);
	assert.ok(
		workflow.indexOf("Measure populated decision endpoint performance") <
			workflow.indexOf(
				"Prove promoted delivery, business values, and decision deduplication",
			),
	);
	assert.match(
		workflow,
		/Measure populated decision endpoint performance[\s\S]*staging-ci\.js verify[\s\S]*--target live/,
	);
	assert.match(
		workflow,
		/--baseline-deployment-id "\$\{\{ steps\.promote\.outputs\.previous_live_id \|\| steps\.tinybird\.outputs\.id \}\}"/,
	);
	assert.match(
		workflow,
		/Quiesce scheduled and active Copy jobs before final cleanup\n {8}id: pause-copies\n {8}if: always\(\) && steps\.seed\.outcome != 'skipped' && steps\.deployment-state\.outputs\.promoted == 'true'/,
	);
	assert.match(
		workflow,
		/Delete strictly scoped synthetic raw rows\n {8}id: cleanup\n {8}if: always\(\) && steps\.seed\.outcome != 'skipped' && \(steps\.deployment-state\.outputs\.target == 'staging' \|\| steps\.pause-copies\.outcome == 'success'\)/,
	);
	assert.match(
		workflow,
		/Resume reviewed Copy schedules\n {8}id: resume-copies\n {8}if: always\(\) && steps\.pause-copies\.outcome == 'success'/,
	);
	assert.match(workflow, /steps\.cleanup\.outputs\.requires_copies == 'true'/);
	assert.match(
		workflow,
		/Upload the immutable post-ingestion recovery checkpoint\n {8}if: steps\.seed\.outcome == 'success'/,
	);
	assert.match(workflow, /echo "required=false" >> "\$GITHUB_OUTPUT"/);
	assert.match(workflow, /echo "required=true" >> "\$GITHUB_OUTPUT"/);
	assert.match(
		workflow,
		/Upload redacted staging evidence\n {8}if: always\(\) && steps\.cleanup\.outputs\.required == 'true'/,
	);
	assert.ok(
		workflow.indexOf("Retire only a superseded Tinybird staging predecessor") <
			workflow.indexOf("Persist the pre-create Tinybird recovery boundary"),
	);
	assert.ok(
		workflow.indexOf("Upload the immutable pre-create recovery boundary") <
			workflow.indexOf("Create isolated Tinybird staging deployment"),
	);
	assert.match(
		workflow,
		/staging-ci\.js discard-retired-deployment[\s\S]*analytics-retired-deployment\.json/,
	);
	assert.ok(
		workflow.indexOf("Upload the immutable pre-ingestion recovery checkpoint") <
			workflow.indexOf("Seed bounded duplicate and conflict probes"),
	);
	assert.ok(
		workflow.indexOf("Upload the immutable pre-promotion recovery checkpoint") <
			workflow.indexOf("Promote the verified staging deployment"),
	);
	assert.match(
		workflow,
		/recover-staging:[\s\S]*needs: deploy-staging[\s\S]*if: always\(\) && needs\.deploy-staging\.result != 'success'/,
	);
	assert.match(workflow, /permissions:[\s\S]*actions: read/);
	assert.match(
		workflow,
		/actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/,
	);
	assert.doesNotMatch(workflow, /actions\/(?:upload|download)-artifact@v\d/);
	assert.match(workflow, /staging-ci\.js recover/);
});

test("the preview mutation route independently enforces Tinybird staging", () => {
	const route = fs.readFileSync(
		new URL(
			"../../../apps/web/app/api/analytics/staging-test/[[...route]]/route.ts",
			import.meta.url,
		),
		"utf8",
	);
	const workflow = fs.readFileSync(
		new URL("../../../.github/workflows/analytics.yml", import.meta.url),
		"utf8",
	);
	assert.match(
		route,
		/const TINYBIRD_STAGING_ORIGIN = "https:\/\/api\.us-east\.aws\.tinybird\.co"/,
	);
	assert.match(
		route,
		/const TINYBIRD_STAGING_WORKSPACE_ID =\s*"37b8fef9-817f-4c3c-b21f-218c36a6077d"/,
	);
	assert.match(route, /const authorize = [\s\S]*const attestation =/);
	assert.doesNotMatch(route, /CAP_ANALYTICS_STAGING_PREVIEW/);
	assert.doesNotMatch(route, /process\.env\.VERCEL_ENV/);
	assert.match(
		route,
		/process\.env\.VERCEL_GIT_COMMIT_REF !== STAGING_GIT_COMMIT_REF/,
	);
	assert.match(
		route,
		/!options\.allowHistoricalSha && payload\.sha !== attestation\.sha/,
	);
	assert.match(
		route,
		/handle\("cleanupDatabase"[\s\S]*allowHistoricalSha: true[\s\S]*runIds\[0\] !== authorizedRunId/,
	);
	assert.match(route, /"x-cap-analytics-staging-signature"/);
	assert.match(
		route,
		/createHmac\("sha256", secret\)[\s\S]*\.update\(`\$\{runId\}:\$\{payload\.sha\}`\)/,
	);
	assert.match(
		route,
		/const STAGING_DATABASE_FINGERPRINT =\s*"fff37a9b160f31bfb82b8c5585829b8ee08f70b3645169dca6e7cb29033a039a"/,
	);
	assert.match(
		route,
		/databaseSchema: Schema\.Literal\("0042_lying_sharon_ventura"\)/,
	);
	assert.match(route, /HttpApiEndpoint\.post\("health"/);
	assert.match(route, /const scopedDatabaseHealth = async/);
	assert.match(route, /FROM information_schema\.STATISTICS/);
	assert.match(route, /product_analytics_ingestion_leases:fencingToken/);
	assert.match(route, /product_analytics_refresh_leases:name/);
	assert.match(route, /product_analytics_outbox:delivery_idx:1:3:createdAt/);
	assert.match(route, /\/api\/analytics\/staging-test\/cleanup-database/);

	const runner = fs.readFileSync(
		new URL("../staging-ci.js", import.meta.url),
		"utf8",
	);
	assert.match(
		runner,
		/const STAGING_PREVIEW_ACCESS_ORIGIN =\s*"https:\/\/cap-web-git-codex-first-party-analytics-mc-ilroy\.vercel\.app"/,
	);
	assert.match(
		runner,
		/shareUrl\.searchParams\.set\("_vercel_share", shareSecret\)/,
	);
	assert.match(
		runner,
		/const handshake = await fetch\(shareUrl, \{[\s\S]*method: "GET",[\s\S]*redirect: "manual"/,
	);
	assert.match(runner, /value\.startsWith\("_vercel_jwt="\)/);
	assert.match(
		runner,
		/const artifactExactDeploymentUrl = \(artifact\) => artifact\.vercel\.url/,
	);
	assert.match(
		runner,
		/artifact\.vercel\.accessUrl \?\? artifactExactDeploymentUrl\(artifact\)/,
	);
	assert.match(runner, /"x-cap-analytics-staging-signature"/);
	assert.match(
		runner,
		/const scopedAnonymousIdentityHashes = \[[\s\S]*new Set\(anonymousIdentityHashes\)/,
	);
	assert.match(
		runner,
		/pathname !== "\/api\/analytics\/staging-test" &&[\s\S]*!pathname\.startsWith\("\/api\/analytics\/staging-test\/"\)/,
	);
	assert.match(runner, /accepted an invalid request signature with HTTP/);
	const previewProbe = runner.slice(
		runner.indexOf("const probePreview = async () => {"),
		runner.indexOf("const probeDurableServerPath = async () => {"),
	);
	assert.match(
		previewProbe,
		/artifactBranchAccessUrl\(artifact\)[\s\S]*const previewRunId = validateSyntheticRunId\(state\.previewRunId\)[\s\S]*const landing = await previewRequest\(previewOrigin, \{[\s\S]*"x-cap-analytics-test-run": previewRunId/,
	);
	assert.match(
		previewProbe,
		/const previewAnonymousIdentityHash = hashIdentifier\([\s\S]*previewAnonymousIdentityHash !== state\.previewAnonymousIdentityHash/,
	);
	assert.match(previewProbe, /state\.recoveryPhase = "postpreview"/);
	assert.match(
		previewProbe,
		/persistPreviewEvidence\(\{ rateLimitStatus: "not_run" \}\);[\s\S]*if \(!collectorBudgetPassed\)/,
	);
	assert.match(
		previewProbe,
		/collectorPerformance:[\s\S]*budget:[\s\S]*passed: collectorBudgetPassed/,
	);
	assert.match(
		previewProbe,
		/const previewRawVisibility = await waitForCopyVisibility\([\s\S]*stablePreviewPolls < 3[\s\S]*state\.previewExpectedEvents = previewRawVisibility\.value\.uniqueEvents/,
	);
	assert.match(
		previewProbe,
		/assertions\.uniquePayloads !== assertions\.uniqueEvents[\s\S]*assertions\.payloadConflicts !== 0/,
	);
	const previewStep = workflow.slice(
		workflow.indexOf("Probe the exact-SHA Vercel browser collector"),
		workflow.indexOf("Upload the immutable post-collector recovery checkpoint"),
	);
	assert.match(previewStep, /TINYBIRD_STAGING_READ_TOKEN/);
	assert.match(previewStep, /TINYBIRD_STAGING_URL/);
	const cleanupProbe = runner.slice(
		runner.indexOf("const cleanupPreviewDatabaseState = async"),
		runner.indexOf("const measurePageBundle = async"),
	);
	assert.match(cleanupProbe, /artifactBranchAccessUrl\(artifact\)/);
	assert.match(cleanupProbe, /sha: artifact\.sha/);
	const browserProbe = fs.readFileSync(
		new URL(
			"../../../apps/chrome-extension/e2e/analytics-staging.spec.ts",
			import.meta.url,
		),
		"utf8",
	);
	assert.equal(browserProbe.match(/await attestExactSha\(\)/g)?.length, 2);
	assert.match(browserProbe, /createHmac\("sha256", stagingSecret\)/);
	assert.match(browserProbe, /"x-cap-analytics-staging-signature"/);
	assert.match(
		browserProbe,
		/shareUrl\.searchParams\.set\("_vercel_share", shareSecret\)/,
	);
	const serverProbe = runner.slice(
		runner.indexOf("const probeDurableServerPath = async () => {"),
		runner.indexOf("const seed = async () => {"),
	);
	assert.match(serverProbe, /\/api\/analytics\/staging-test\/health/);
	assert.equal(
		serverProbe.match(/artifactBranchAccessUrl\(artifact\)/g)?.length,
		2,
	);
	assert.match(serverProbe, /state\.recoveryPhase = "postserver"/);
	assert.match(
		serverProbe,
		/artifact: \{ \.\.\.artifact, sha: "0"\.repeat\(40\) \}[\s\S]*_historical_cleanup/,
	);
	assert.match(serverProbe, /historicalCleanupAuthorizationPassed: true/);
	assert.match(serverProbe, /Number\(outboxHealth\.activeEvents\) !== 0/);
	assert.match(serverProbe, /Number\(outboxHealth\.deadLetterEvents\) !== 1/);
	assert.match(serverProbe, /durableOutboxHealthPassed: true/);
});

test("the seed checkpoint is persisted before ingestion", () => {
	const source = fs.readFileSync(
		new URL("../staging-ci.js", import.meta.url),
		"utf8",
	);
	const prepareSource = source.slice(
		source.indexOf("const prepareSeed = async () => {"),
		source.indexOf("const seed = async () => {"),
	);
	const seedSource = source.slice(
		source.indexOf("const seed = async () => {"),
		source.indexOf("const waitForCopyVisibility"),
	);
	const stateWrite = prepareSource.indexOf(
		"writeJson(statePath, state, 0o600)",
	);
	const artifactWrite = prepareSource.indexOf(
		"writeJson(artifactPath, artifact)",
	);
	const firstDelivery = seedSource.indexOf("const concurrentDeliveries");
	assert.ok(stateWrite >= 0);
	assert.ok(artifactWrite > stateWrite);
	assert.ok(firstDelivery >= 0);
	assert.match(prepareSource, /recoveryPhase: "preseed"/);
	assert.match(prepareSource, /assertions: \{ seedAccepted: false \}/);
	assert.match(prepareSource, /rowsPlanned: fixture\.rows\.length/);
	assert.match(prepareSource, /rowsAttempted: 0/);
	assert.match(
		seedSource,
		/tinybirdEnvironment\(\[\s*"TINYBIRD_STAGING_DEPLOY_TOKEN",\s*"TINYBIRD_STAGING_INGEST_TOKEN",?\s*\]\)/,
	);
	assert.doesNotMatch(seedSource, /TINYBIRD_STAGING_COPY_TOKEN/);
	assert.match(seedSource, /assertExactLiveOwnership/);
	assert.match(seedSource, /state\.recoveryPhase = "postseed"/);
	assert.ok(
		seedSource.indexOf('state.recoveryPhase = "postseed"') >
			seedSource.indexOf("artifact.assertions.seedAccepted = true"),
	);
	assert.ok(
		seedSource.indexOf("artifact.delivery.rowsAttempted += 1") <
			seedSource.indexOf("const result = await request"),
	);
	assert.match(
		seedSource,
		/artifact\.delivery\.rowsAccepted \+= 1;[\s\S]*writeJson\(artifactPath, artifact\);/,
	);
	const workflow = fs.readFileSync(
		new URL("../../../.github/workflows/analytics.yml", import.meta.url),
		"utf8",
	);
	assert.ok(
		workflow.indexOf(
			"Upload the immutable post-ingestion recovery checkpoint",
		) < workflow.indexOf("Verify representative ingestion performance"),
	);
	assert.ok(
		workflow.indexOf("Upload the immutable post-browser recovery checkpoint") <
			workflow.indexOf(
				"Probe the exact-SHA Vercel browser collector and staging rate limit",
			),
	);
	assert.ok(
		workflow.indexOf(
			"Upload the immutable post-collector recovery checkpoint",
		) < workflow.indexOf("Prove exact-SHA durable server delivery"),
	);
	assert.ok(
		workflow.indexOf("Upload the immutable post-server recovery checkpoint") <
			workflow.indexOf("Rebuild promoted decision and health copies"),
	);
});

test("candidate validation performs no synthetic writes before promotion", () => {
	const source = fs.readFileSync(
		new URL("../staging-ci.js", import.meta.url),
		"utf8",
	);
	const preSeedSource = source.slice(
		source.indexOf("const verifyPreSeedDeployment = async"),
		source.indexOf("const verify = async"),
	);
	assert.match(preSeedSource, /strategy: "promote_then_seed"/);
	assert.match(preSeedSource, /candidatePreSeedCleanPassed: true/);
	assert.doesNotMatch(preSeedSource, /\/v0\/events/);
	assert.doesNotMatch(preSeedSource, /TINYBIRD_STAGING_INGEST_TOKEN/);
});

test("recovery avoids unowned schedule changes and publishes failure evidence", () => {
	const source = fs.readFileSync(
		new URL("../staging-ci.js", import.meta.url),
		"utf8",
	);
	const recoverySource = source.slice(
		source.indexOf("const recoverStaging = async () => {"),
		source.indexOf("const handlers ="),
	);
	assert.ok(
		recoverySource.indexOf('strategy: "incomplete"') <
			recoverySource.indexOf("recoveryCheckpoint("),
	);
	assert.match(
		recoverySource,
		/artifact\.copySchedule\?\.pause\?\.status === "passed" &&[\s\S]*pausedDeploymentId === retainedDeploymentId[\s\S]*await setCopySchedules/,
	);
	assert.match(
		recoverySource,
		/previousLifecycle === "ready"[\s\S]*action: "pause"[\s\S]*await cleanup\([\s\S]*await runCopies\([\s\S]*await verifyCleanup\([\s\S]*action: "resume"[\s\S]*await switchLiveDeployment/,
	);
	assert.match(
		recoverySource,
		/candidateLifecycle === "ready"[\s\S]*target: "staging"[\s\S]*syntheticCleanupCompleted = true/,
	);
	assert.equal(
		recoverySource.match(/enforcePerformanceBudget: false/g)?.length,
		2,
	);
	assert.match(source, /const recoverAnonymousIdentityHashes = async/);
	assert.match(
		source,
		/SELECT DISTINCT anonymous_id FROM product_events_v1 WHERE synthetic_run_id/,
	);
	assert.match(recoverySource, /TINYBIRD_STAGING_ERASURE_LOOKUP_TOKEN/);
	assert.match(source, /if \(!budget\.passed && enforcePerformanceBudget\)/);
});

test("candidate cleanup refuses a live transition before any deletion", () => {
	const source = fs.readFileSync(
		new URL("../staging-ci.js", import.meta.url),
		"utf8",
	);
	const cleanupSource = source.slice(
		source.indexOf("const cleanup = async"),
		source.indexOf("const verifyPromoted = async"),
	);
	const targetGuard = cleanupSource.indexOf("if (target !== requestedTarget)");
	assert.ok(targetGuard >= 0);
	assert.ok(targetGuard < cleanupSource.indexOf("cleanupPreviewDatabaseState"));
	assert.ok(targetGuard < cleanupSource.indexOf("deleteProductEventRows"));
	assert.match(
		cleanupSource,
		/Tinybird cleanup target changed before scoped cleanup/,
	);
	assert.match(
		cleanupSource,
		/if \(target === "staging"\)[\s\S]*liveBeforeDeploymentId[\s\S]*deleteProductEventRows[\s\S]*liveSyntheticRowsDeleted: true/,
	);
});

test("event state reaches terminal success before canonical rebuilding", () => {
	const source = fs.readFileSync(
		new URL("../staging-ci.js", import.meta.url),
		"utf8",
	);
	const runCopiesSource = source.slice(
		source.indexOf("const runCopies = async"),
		source.indexOf("const verify = async"),
	);
	const stateCopy = runCopiesSource.indexOf(
		'"snapshot_product_event_id_states_v2"',
	);
	const stateWait = runCopiesSource.indexOf(
		"stateJobCompletions.push(copy.completion)",
	);
	const canonicalCopy = runCopiesSource.indexOf(
		'pipe: "snapshot_product_events_canonical_v1"',
	);
	const cutoffProbe = runCopiesSource.indexOf(
		'status: "post_cutoff_event_accepted"',
	);
	assert.ok(stateCopy >= 0);
	assert.ok(stateCopy < stateWait);
	assert.ok(stateWait < cutoffProbe);
	assert.ok(cutoffProbe < canonicalCopy);
	assert.ok(stateWait < canonicalCopy);
	assert.match(
		runCopiesSource,
		/preflightQuiescence = await waitForTinybirdCopyPipesQuiescent\([\s\S]*workspaceWide: true/,
	);
	const runnerSource = source.slice(
		source.indexOf("const runTinybirdCopyPipe = async"),
		source.indexOf("const phaseRunExpectations"),
	);
	assert.ok(
		runnerSource.indexOf("const capacityQuiescence") <
			runnerSource.indexOf("await submitTinybirdCopyJobs"),
	);
	assert.match(runnerSource, /capacityQuiescence[\s\S]*workspaceWide: true/);
	assert.match(source, /COPY_PIPELINE_DEADLINE_MS = 1_800_000/);
	assert.match(
		runnerSource,
		/timeoutMs: Math\.min\(900_000, remainingCopyPipelineMs\(deadlineMs\)\)/,
	);
	assert.match(
		runnerSource,
		/backoffMs >= remainingCopyPipelineMs\(deadlineMs\)/,
	);
	assert.ok(
		runnerSource.indexOf("await onUpdate(attempts)") <
			runnerSource.indexOf("await waitForTinybirdCopyJob"),
	);
	assert.match(
		runCopiesSource,
		/jobs: \[\.\.\.stateJobs, \.\.\.canonicalJobs, \.\.\.downstreamJobs\]/,
	);
	assert.match(runCopiesSource, /cutoffIsolationPassed: true/);
	assert.match(
		fs.readFileSync(
			new URL("../../../.github/workflows/analytics.yml", import.meta.url),
			"utf8",
		),
		/Rebuild promoted decision and health copies[\s\S]*TINYBIRD_STAGING_INGEST_TOKEN/,
	);
});

test("rollback drill proves old and restored deployment data planes", () => {
	const source = fs.readFileSync(
		new URL("../staging-ci.js", import.meta.url),
		"utf8",
	);
	const drillSource = source.slice(
		source.indexOf("const drillOwnedRollback"),
		source.indexOf("const rollbackOwnedPromotion"),
	);
	const recoverySource = source.slice(
		source.indexOf("const rollbackOwnedPromotion"),
		source.indexOf("const discardOwnedDeployment"),
	);
	assert.ok(
		(drillSource.match(/await switchLiveDeployment/g)?.length ?? 0) >= 2,
	);
	assert.equal(
		drillSource.match(/await queryDecisionEndpointSuite/g)?.length,
		2,
	);
	assert.match(drillSource, /previousLiveDeploymentId/);
	assert.match(drillSource, /assertDecisionEndpointSuiteReadable/);
	assert.match(drillSource, /excludedRollbackEndpoints/);
	assert.match(drillSource, /unavailableDecisionEndpoints/);
	assert.match(
		source,
		/unavailableDecisionEndpoints[\s\S]*await decisionEndpointAvailable[\s\S]*filter\(\(\{ available \}\) => !available\)/,
	);
	assert.match(drillSource, /assertSyntheticEndpointDecisions/);
	assert.match(drillSource, /assertSyntheticBusinessDecisions/);
	assert.match(drillSource, /readAndAssertPhaseHealth/);
	assert.match(drillSource, /dataPlanePassed: true/);
	assert.match(drillSource, /rollback_target_usable/);
	assert.ok(
		drillSource.indexOf("rollbackProbeError = error") <
			drillSource.lastIndexOf("await switchLiveDeployment"),
	);
	assert.match(recoverySource, /await queryDecisionEndpointSuite/);
	assert.match(recoverySource, /assertDecisionEndpointSuiteReadable/);
	assert.match(
		recoverySource,
		/The Tinybird rollback destination is not usable/,
	);
	assert.ok(
		recoverySource.indexOf("await queryDecisionEndpointSuite") <
			recoverySource.indexOf("await deleteRetiredDeployment"),
	);
});

test("performance compares the retained deployment and a larger synthetic volume", () => {
	const source = fs.readFileSync(
		new URL("../staging-ci.js", import.meta.url),
		"utf8",
	);
	const verifySource = source.slice(
		source.indexOf("const verify = async () =>"),
		source.indexOf("const safeSyntheticIdentifier"),
	);
	assert.match(verifySource, /options\.get\("baseline-deployment-id"\)/);
	assert.match(
		verifySource,
		/deploymentId: baselineDeploymentId[\s\S]*deploymentId: state\.deploymentId[\s\S]*syntheticRunId: state\.loadRunId/,
	);
	assert.match(verifySource, /representativeSamples/);
	assert.match(verifySource, /representativeRows: state\.loadEventCount/);
	assert.match(verifySource, /representativePerformancePassed/);
	assert.match(verifySource, /assertRepresentativeEndpointCoverage/);
	assert.match(verifySource, /representativeBudget/);
	assert.match(verifySource, /absolute_only_no_independent_baseline/);
	assert.match(verifySource, /round < 30/);
	assert.match(verifySource, /excludedBaselineEndpoints/);
	assert.match(verifySource, /unavailableDecisionEndpoints/);
	assert.match(
		verifySource,
		/newEndpointsWithoutBaseline: excludedBaselineEndpoints/,
	);
	assert.match(source, /LARGE_PERFORMANCE_EVENT_COUNT \?\? 100_000/);
	assert.match(source, /PERFORMANCE_DAY_SPAN \?\? 30/);
	assert.match(source, /LARGE_PERFORMANCE_DAY_SPAN \?\? 80/);
	assert.match(source, /COLLECTOR_PERFORMANCE_REQUESTS \?\? 20/);
	assert.match(source, /COLLECTOR_PERFORMANCE_CONCURRENCY \?\? 4/);
	assert.match(source, /LARGE_PERFORMANCE_DIMENSION_BUCKETS \?\? 64/);
	assert.match(source, /COPY_PIPELINE_WALL_CLOCK_BUDGET_MS \?\? 600_000/);
	assert.match(source, /COPY_VISIBILITY_P95_BUDGET_MS \?\? 120_000/);
	assert.match(source, /providerResourceMetrics/);
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
	const verifyCleanupSource = source.slice(
		source.indexOf("const verifyCleanup"),
		source.indexOf("const tokenScopeProbe"),
	);
	assert.doesNotMatch(deleteSource, /__tb__min_deployment/);
	assert.match(deleteSource, /\/v1\/datasources\/product_events_v1\/delete/);
	assert.match(deleteSource, /wait: "true"/);
	assert.match(deleteSource, /wait_max_seconds: "60"/);
	assert.match(deleteSource, /mutation\?\.is_done !== true/);
	assert.match(verifyCleanupSource, /syntheticRunId: state\.decisionRunId/);
	assert.match(
		verifyCleanupSource,
		/Object\.values\(businessDecisionAssertions\)\.some/,
	);
	assert.equal(deleteSource.match(/\.\.\.deploymentParameters/g)?.length, 1);
	assert.match(source, /const rawBeforeDelete = await readScopedRawAssertions/);
	assert.match(source, /Tinybird synthetic raw cleanup/);
	assert.match(source, /assert: assertScopedRawRowsDeleted/);
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
	assert.match(source, /requestedTarget !== "live"/);
	assert.doesNotMatch(source, /useDeploymentParameter/);
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
