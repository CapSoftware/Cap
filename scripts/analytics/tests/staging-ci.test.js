import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
	assertExecutionScope,
	assertPromotedSyntheticDecisions,
	assertSyntheticDecisions,
	assertSyntheticHealth,
	assertWorkflowSafety,
	createSyntheticEvents,
	createSyntheticLoadEvents,
	FEATURE_BRANCH,
	FEATURE_PULL_REQUEST,
	latencySummary,
	normalizeCiAssertions,
	normalizeHealth,
	STAGING_WORKSPACE_ID,
	selectStagingDeployment,
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
	assert.equal(
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
		),
		"current",
	);
	assert.equal(
		selectStagingDeployment(
			[
				{
					ID: 42,
					Status: "Staging",
					"Created at": "2026-07-31T10:00:01.000Z",
				},
			],
			minimum,
		),
		"42",
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

test("promoted assertions combine direct and exact-SHA preview duplicate paths", () => {
	const assertions = {
		receivedRows: 26,
		uniqueEvents: 3,
		uniquePayloads: 4,
		duplicateRows: 22,
		payloadConflicts: 1,
		canonicalEvents: 2,
		decisionEvents: 2,
	};
	assert.doesNotThrow(() => assertPromotedSyntheticDecisions(assertions));
	assert.throws(() =>
		assertPromotedSyntheticDecisions({ ...assertions, decisionEvents: 3 }),
	);
});

test("the analytics workflow is statically restricted to staging", () => {
	const workflow = fs.readFileSync(
		new URL("../../../.github/workflows/analytics.yml", import.meta.url),
		"utf8",
	);
	assert.doesNotThrow(() => assertWorkflowSafety(workflow));
});
