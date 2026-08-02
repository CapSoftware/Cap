import { createHmac } from "node:crypto";
import fs from "node:fs";
import process from "node:process";

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
	COPY_PIPES,
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
	formatTinybirdDateTime64,
	hashIdentifier,
	isUnscheduledCopyMutation,
	latencySummary,
	normalizeCiAssertions,
	normalizeCopyAssertions,
	normalizeHealth,
	reconcileCleanupTarget,
	resolveDeploymentCreatedAfterBoundary,
	resolveDeploymentState,
	resolveExactDeploymentLifecycle,
	resolveExactPromotionPlan,
	resolveOwnedDiscardTarget,
	resolveOwnedMutationTarget,
	STAGING_WORKSPACE_ID,
	selectRetiredStagingDeployment,
	selectStagingDeployment,
	submitTinybirdCopyJobs,
	syntheticIdentityFilterQueries,
	syntheticMonetizationFilterQueries,
	tokenScopeProbeWindow,
	validateSyntheticRunId,
	validateTinybirdCredentials,
	waitForTinybirdCopyJob,
	waitForTinybirdCopyPipesQuiescent,
} from "./staging-ci-lib.js";

const args = process.argv.slice(2);
const command = args.shift();
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
	const name = args[index];
	const value = args[index + 1];
	if (!name?.startsWith("--") || value === undefined) {
		throw new Error("Arguments must use --name value pairs");
	}
	options.set(name.slice(2), value);
}

const option = (name) => {
	const value = options.get(name);
	if (!value) {
		throw new Error(`--${name} is required`);
	}
	return value;
};

const environment = (name) => {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is required`);
	}
	return value;
};

const delay = (milliseconds) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

const writeOutput = (name, value) => {
	const outputPath = environment("GITHUB_OUTPUT");
	fs.appendFileSync(outputPath, `${name}=${value}\n`, { encoding: "utf8" });
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const writeJson = (filePath, value, mode = 0o644) => {
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode,
	});
};

const exactSha = (value, label) => {
	if (!/^[0-9a-f]{40}$/.test(value)) {
		throw new Error(`${label} must be an exact 40-character Git SHA`);
	}
	return value;
};

const recoveryIdentity = () => ({
	eventName: environment("GITHUB_EVENT_NAME"),
	expectedSha: exactSha(environment("EXPECTED_SHA"), "EXPECTED_SHA"),
	headRef: process.env.HEAD_REF ?? "",
	pullRequest: process.env.EVENT_NUMBER ?? "",
	ref: environment("GITHUB_REF"),
	repository: environment("GITHUB_REPOSITORY"),
	runAttempt: environment("GITHUB_RUN_ATTEMPT"),
	runId: environment("GITHUB_RUN_ID"),
	workspaceId: environment("TINYBIRD_WORKSPACE_ID"),
});

const assertRecoveryIdentity = (value) => {
	const expected = recoveryIdentity();
	for (const [name, expectedValue] of Object.entries(expected)) {
		if (String(value?.[name] ?? "") !== expectedValue) {
			throw new Error(`Recovery checkpoint ${name} does not match this run`);
		}
	}
	const pullRequestScope =
		expected.eventName === "pull_request" &&
		expected.pullRequest === "2003" &&
		expected.headRef === "codex/first-party-analytics";
	const dispatchScope =
		expected.eventName === "workflow_dispatch" &&
		expected.ref === "refs/heads/codex/first-party-analytics";
	if (
		(!pullRequestScope && !dispatchScope) ||
		expected.workspaceId !== STAGING_WORKSPACE_ID
	) {
		throw new Error(
			"Recovery is restricted to the analytics staging pull request",
		);
	}
	return expected;
};

const TINYBIRD_TOKEN_NAMES = [
	"TINYBIRD_STAGING_DEPLOY_TOKEN",
	"TINYBIRD_STAGING_COPY_TOKEN",
	"TINYBIRD_STAGING_ERASURE_LOOKUP_TOKEN",
	"TINYBIRD_STAGING_SCHEDULER_TOKEN",
	"TINYBIRD_STAGING_INGEST_TOKEN",
	"TINYBIRD_STAGING_READ_TOKEN",
	"TINYBIRD_STAGING_CLEANUP_TOKEN",
];

const PREVIEW_TINYBIRD_TOKEN_ENV = {
	PRODUCT_ANALYTICS_TINYBIRD_TOKEN: "TINYBIRD_STAGING_INGEST_TOKEN",
	PRODUCT_ANALYTICS_TINYBIRD_READ_TOKEN: "TINYBIRD_STAGING_READ_TOKEN",
	PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN: "TINYBIRD_STAGING_CLEANUP_TOKEN",
	PRODUCT_ANALYTICS_TINYBIRD_ERASURE_LOOKUP_TOKEN:
		"TINYBIRD_STAGING_ERASURE_LOOKUP_TOKEN",
	PRODUCT_ANALYTICS_TINYBIRD_COPY_TOKEN: "TINYBIRD_STAGING_COPY_TOKEN",
	PRODUCT_ANALYTICS_TINYBIRD_SCHEDULER_TOKEN:
		"TINYBIRD_STAGING_SCHEDULER_TOKEN",
};

const STAGING_PREVIEW_ACCESS_ORIGIN =
	"https://cap-web-git-codex-first-party-analytics-mc-ilroy.vercel.app";
const COPY_PIPELINE_DEADLINE_MS = 1_800_000;

const tinybirdEnvironment = (requiredTokenNames = TINYBIRD_TOKEN_NAMES) => {
	if (environment("TINYBIRD_WORKSPACE_ID") !== STAGING_WORKSPACE_ID) {
		throw new Error(
			"TINYBIRD_WORKSPACE_ID must be the fixed staging workspace",
		);
	}
	const tokens = Object.fromEntries(
		requiredTokenNames.map((name) => [name, environment(name)]),
	);
	const origin = validateTinybirdCredentials({
		url: environment("TINYBIRD_STAGING_URL"),
		tokens,
	});
	return { origin, tokens };
};

const request = async (
	url,
	{
		token,
		method = "GET",
		body,
		headers = {},
		attempts = 1,
		beforeAttempt,
	} = {},
) => {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const startedAt = performance.now();
		try {
			if (beforeAttempt) await beforeAttempt();
			const response = await fetch(url, {
				method,
				body,
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${token}`,
					...headers,
				},
				signal: AbortSignal.timeout(15_000),
			});
			const latencyMs = Math.round(performance.now() - startedAt);
			if (response.ok) {
				const text = await response.text();
				return {
					data: text ? JSON.parse(text) : {},
					latencyMs,
					attempt,
				};
			}
			const payload = await response.json().catch(() => ({}));
			const failure = classifyTinybirdHttpFailure({
				status: response.status,
				payload,
				retryAfter: response.headers.get("retry-after"),
			});
			if (response.status < 500 && response.status !== 429) {
				const error = new Error(
					`Tinybird request was rejected with HTTP ${response.status}`,
					{ cause: "permanent" },
				);
				Object.assign(error, failure);
				throw error;
			}
			lastError = Object.assign(
				new Error(`Tinybird request failed with HTTP ${response.status}`),
				failure,
			);
		} catch (error) {
			if (error instanceof Error && error.cause === "permanent") {
				throw error;
			}
			lastError = error;
		}
		if (attempt < attempts) {
			await delay(250 * 2 ** (attempt - 1));
		}
	}
	throw lastError;
};

const tinybirdUrl = (origin, pathname, parameters = {}) => {
	const url = new URL(pathname, origin);
	for (const [name, value] of Object.entries(parameters)) {
		if (value !== undefined && value !== "") {
			url.searchParams.set(
				name,
				["end_time", "source_cutoff", "start_time"].includes(name)
					? formatTinybirdDateTime64(String(value))
					: value,
			);
		}
	}
	return url;
};

const healthQuery = async ({ state, deploymentId = "", appVersion }) => {
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_READ_TOKEN",
	]);
	const previewWindow =
		appVersion === state.previewAppVersion &&
		state.previewStartTime &&
		state.previewEndTime;
	const allPlatformCorpus = [
		state.loadAppVersion,
		state.largeLoadAppVersion,
	].includes(appVersion);
	const startTime = previewWindow ? state.previewStartTime : state.startTime;
	const endTime = previewWindow ? state.previewEndTime : state.endTime;
	const windows = [];
	const endMs = Date.parse(endTime);
	for (let startMs = Date.parse(startTime); startMs <= endMs; ) {
		const endExclusiveMs = Math.min(startMs + 30 * 86_400_000, endMs + 1);
		windows.push({
			startTime: new Date(startMs).toISOString(),
			endTime: new Date(endExclusiveMs - 1).toISOString(),
		});
		startMs = endExclusiveMs;
	}
	const startedAt = performance.now();
	const results = await Promise.all(
		windows.map((window) =>
			request(
				tinybirdUrl(origin, "/v0/pipes/product_events_health.json", {
					start_time: window.startTime,
					end_time: window.endTime,
					platform: allPlatformCorpus ? undefined : "web",
					app_version: appVersion ?? state.appVersion,
					__tb__deployment: deploymentId,
				}),
				{ token: tokens.TINYBIRD_STAGING_READ_TOKEN, attempts: 3 },
			),
		),
	);
	if (results.length === 1) return results[0];
	const total = {
		received_rows: 0,
		unique_events: 0,
		unique_payloads: 0,
		duplicate_rows: 0,
		payload_conflicts: 0,
	};
	for (const result of results) {
		const row = result.data?.data?.[0] ?? {};
		for (const name of Object.keys(total)) {
			total[name] += Number(row[name] ?? 0);
		}
	}
	return {
		data: { data: [total] },
		latencyMs: Math.round(performance.now() - startedAt),
		attempt: Math.max(...results.map((result) => result.attempt)),
	};
};

const ciAssertionsQuery = async ({
	state,
	deploymentId = "",
	syntheticRunId = state.runId,
}) => {
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_READ_TOKEN",
	]);
	return request(
		tinybirdUrl(origin, "/v0/pipes/product_analytics_ci_assertions.json", {
			synthetic_run_id: syntheticRunId,
			__tb__deployment: deploymentId,
		}),
		{ token: tokens.TINYBIRD_STAGING_READ_TOKEN, attempts: 3 },
	);
};

const copyAssertionsQuery = async ({ copyRunId, deploymentId = "" }) => {
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_READ_TOKEN",
	]);
	return request(
		tinybirdUrl(origin, "/v0/pipes/product_analytics_copy_assertions.json", {
			copy_run_id: copyRunId,
			__tb__deployment: deploymentId,
		}),
		{ token: tokens.TINYBIRD_STAGING_READ_TOKEN, attempts: 3 },
	);
};

const ownedMutationTarget = async ({ state, origin, token }) => {
	const deployments = await request(tinybirdUrl(origin, "/v1/deployments"), {
		token,
		attempts: 3,
	});
	return resolveOwnedMutationTarget(
		deployments.data,
		String(state.deploymentId),
	);
};

const waitForOwnedMutationTarget = async ({ state, origin, token }) => {
	const deadline =
		Date.now() + Number(process.env.DEPLOYMENT_WAIT_MS ?? 300_000);
	let lastError;
	while (Date.now() < deadline) {
		const target = await ownedMutationTarget({ state, origin, token });
		if (target !== "pending") return target;
		lastError = new Error("The owned Tinybird deployment is still pending");
		await delay(2_000);
	}
	throw new Error("Timed out waiting for the owned Tinybird deployment", {
		cause: lastError,
	});
};

const deploymentList = async ({ origin, token }) =>
	request(tinybirdUrl(origin, "/v1/deployments"), {
		token,
		attempts: 3,
	});

const prepareDeploymentBoundary = async () => {
	const outputPath = option("output");
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
	]);
	const deployments = await deploymentList({
		origin,
		token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
	});
	const boundary = createDeploymentBoundary(deployments.data);
	writeJson(
		outputPath,
		{
			schemaVersion: 1,
			identity: recoveryIdentity(),
			phase: "precreate",
			preview: {
				deploymentId: environment("VERCEL_DEPLOYMENT_ID"),
				accessUrl: new URL(environment("VERCEL_PREVIEW_ACCESS_URL")).origin,
				url: new URL(environment("VERCEL_PREVIEW_URL")).origin,
			},
			tinybird: {
				...boundary,
				createStartedAt: new Date().toISOString(),
			},
		},
		0o600,
	);
};

const exactDeployment = async ({ origin, token, deploymentId }) =>
	request(
		tinybirdUrl(origin, `/v1/deployments/${encodeURIComponent(deploymentId)}`),
		{ token, attempts: 3 },
	);

const settledDeploymentLifecycle = async ({ origin, token, deploymentId }) => {
	const deadline =
		Date.now() + Number(process.env.DEPLOYMENT_WAIT_MS ?? 300_000);
	while (Date.now() < deadline) {
		try {
			const lifecycle = resolveExactDeploymentLifecycle(
				(await exactDeployment({ origin, token, deploymentId })).data,
				deploymentId,
			);
			if (lifecycle !== "deleting") return lifecycle;
		} catch (error) {
			if (error instanceof Error && error.status === 404) return "deleted";
			throw error;
		}
		await delay(2_000);
	}
	throw new Error("Timed out resolving a deleting Tinybird deployment");
};

const prepareOwnedPromotion = async () => {
	const deploymentId = option("deployment-id");
	const statePath = option("state");
	const state = readJson(statePath);
	if (
		String(state.deploymentId) !== deploymentId ||
		state.needsPromotion !== true
	) {
		throw new Error("Tinybird promotion checkpoint does not own the candidate");
	}
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
	]);
	const current = await deploymentList({
		origin,
		token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
	});
	const plan = resolveExactPromotionPlan(current.data, deploymentId);
	state.previousLiveDeploymentId = plan.previousLiveDeploymentId;
	state.recoveryPhase = "prepromote";
	writeJson(statePath, state, 0o600);
	writeOutput("previous_live_id", plan.previousLiveDeploymentId);
};

const promoteOwnedDeployment = async () => {
	const deploymentId = option("deployment-id");
	const state = readJson(option("state"));
	if (
		String(state.deploymentId) !== deploymentId ||
		state.recoveryPhase !== "prepromote" ||
		!/^\d+$/.test(String(state.previousLiveDeploymentId ?? ""))
	) {
		throw new Error("Tinybird promotion requires a persisted promotion plan");
	}
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
	]);
	const token = tokens.TINYBIRD_STAGING_DEPLOY_TOKEN;
	const initial = await deploymentList({ origin, token });
	const plan = resolveExactPromotionPlan(initial.data, deploymentId);
	if (plan.previousLiveDeploymentId !== state.previousLiveDeploymentId) {
		throw new Error("The persisted Tinybird promotion plan is stale");
	}
	writeOutput("previous_live_id", plan.previousLiveDeploymentId);
	const promotionDeadline =
		Date.now() + Number(process.env.DEPLOYMENT_WAIT_MS ?? 300_000);
	let lastPromotionError;
	let promotionAttempts = 0;
	while (Date.now() < promotionDeadline) {
		const current = await deploymentList({ origin, token });
		const target = resolveOwnedMutationTarget(current.data, deploymentId);
		if (target === "live") break;
		if (target === "pending") {
			await delay(2_000);
			continue;
		}
		if (promotionAttempts >= 3) {
			throw new Error("The exact Tinybird deployment remained staging", {
				cause: lastPromotionError,
			});
		}
		const currentPlan = resolveExactPromotionPlan(current.data, deploymentId);
		if (
			currentPlan.previousLiveDeploymentId !== plan.previousLiveDeploymentId
		) {
			throw new Error("The Tinybird live deployment changed before promotion");
		}
		try {
			promotionAttempts += 1;
			await request(
				tinybirdUrl(
					origin,
					`/v1/deployments/${encodeURIComponent(deploymentId)}/set-live`,
				),
				{ token, method: "POST" },
			);
		} catch (error) {
			lastPromotionError = error;
		}
		await delay(2_000);
	}
	const promoted = await deploymentList({ origin, token });
	if (resolveOwnedMutationTarget(promoted.data, deploymentId) !== "live") {
		throw new Error("The exact Tinybird deployment was not promoted", {
			cause: lastPromotionError,
		});
	}
	writeOutput("promoted", "true");
};

const deleteRetiredDeployment = async ({
	origin,
	token,
	liveDeploymentId,
	retiredDeploymentId,
}) => {
	const deadline =
		Date.now() + Number(process.env.DEPLOYMENT_WAIT_MS ?? 300_000);
	let lastDeletionError;
	while (Date.now() < deadline) {
		const previous = await exactDeployment({
			origin,
			token,
			deploymentId: retiredDeploymentId,
		});
		const lifecycle = resolveExactDeploymentLifecycle(
			previous.data,
			retiredDeploymentId,
		);
		if (lifecycle === "deleted") {
			return;
		}
		if (lifecycle === "live") {
			throw new Error("Refusing to delete a live Tinybird deployment");
		}
		if (lifecycle !== "deleting") {
			try {
				await request(
					tinybirdUrl(
						origin,
						`/v1/deployments/${encodeURIComponent(retiredDeploymentId)}`,
					),
					{
						token,
						method: "DELETE",
						beforeAttempt: async () => {
							const ownership = await deploymentList({ origin, token });
							if (
								resolveOwnedMutationTarget(ownership.data, liveDeploymentId) !==
								"live"
							) {
								throw new Error("The retained Tinybird deployment is not live");
							}
							const exactPrevious = await exactDeployment({
								origin,
								token,
								deploymentId: retiredDeploymentId,
							});
							if (
								resolveExactDeploymentLifecycle(
									exactPrevious.data,
									retiredDeploymentId,
								) === "live"
							) {
								throw new Error(
									"Refusing to delete a live Tinybird deployment",
								);
							}
						},
					},
				);
			} catch (error) {
				lastDeletionError = error;
			}
		}
		await delay(2_000);
	}
	throw new Error("Timed out deleting the previous Tinybird deployment", {
		cause: lastDeletionError,
	});
};

const discardRetiredStagingDeployment = async () => {
	const artifactPath = option("artifact");
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
	]);
	const token = tokens.TINYBIRD_STAGING_DEPLOY_TOKEN;
	const before = await deploymentList({ origin, token });
	const pair = selectRetiredStagingDeployment(before.data);
	if (pair.retiredDeploymentId) {
		await deleteRetiredDeployment({
			origin,
			token,
			liveDeploymentId: pair.liveDeploymentId,
			retiredDeploymentId: pair.retiredDeploymentId,
		});
	}
	const after = selectRetiredStagingDeployment(
		(await deploymentList({ origin, token })).data,
	);
	if (
		after.liveDeploymentId !== pair.liveDeploymentId ||
		after.retiredDeploymentId !== undefined
	) {
		throw new Error("Tinybird retired deployment cleanup did not settle");
	}
	writeJson(artifactPath, {
		liveDeploymentId: pair.liveDeploymentId,
		retiredDeploymentId: pair.retiredDeploymentId ?? null,
		retired: pair.retiredDeploymentId !== undefined,
		verifiedAt: new Date().toISOString(),
		workspaceId: STAGING_WORKSPACE_ID,
	});
	writeOutput("retired", pair.retiredDeploymentId ? "true" : "false");
};

const switchLiveDeployment = async ({
	origin,
	token,
	fromDeploymentId,
	toDeploymentId,
}) => {
	const before = await deploymentList({ origin, token });
	if (
		resolveOwnedMutationTarget(before.data, fromDeploymentId) !== "live" ||
		resolveOwnedMutationTarget(before.data, toDeploymentId) !== "staging"
	) {
		throw new Error(
			"Tinybird live switch did not match the exact deployment pair",
		);
	}
	let mutationError;
	try {
		await request(
			tinybirdUrl(
				origin,
				`/v1/deployments/${encodeURIComponent(toDeploymentId)}/set-live`,
			),
			{
				token,
				method: "POST",
				beforeAttempt: async () => {
					const ownership = await deploymentList({ origin, token });
					if (
						resolveOwnedMutationTarget(ownership.data, fromDeploymentId) !==
							"live" ||
						resolveOwnedMutationTarget(ownership.data, toDeploymentId) !==
							"staging"
					) {
						throw new Error("Tinybird live switch ownership changed");
					}
				},
			},
		);
	} catch (error) {
		mutationError = error;
	}
	const deadline =
		Date.now() + Number(process.env.DEPLOYMENT_WAIT_MS ?? 300_000);
	let lastOwnershipError;
	while (Date.now() < deadline) {
		try {
			const current = await deploymentList({ origin, token });
			const toTarget = resolveOwnedMutationTarget(current.data, toDeploymentId);
			const fromTarget = resolveOwnedMutationTarget(
				current.data,
				fromDeploymentId,
			);
			if (toTarget === "live" && fromTarget === "staging") return;
			if (
				mutationError instanceof Error &&
				mutationError.cause === "permanent" &&
				toTarget === "staging" &&
				fromTarget === "live"
			) {
				throw mutationError;
			}
		} catch (error) {
			if (error === mutationError) throw error;
			lastOwnershipError = error;
		}
		await delay(2_000);
	}
	throw new Error("Timed out reconciling the exact Tinybird live deployment", {
		cause: mutationError ?? lastOwnershipError,
	});
};

const finalizeOwnedPromotion = async () => {
	const deploymentId = option("deployment-id");
	const previousLiveDeploymentId = option("previous-live-id");
	const artifactPath = option("artifact");
	if (deploymentId === previousLiveDeploymentId) {
		throw new Error("Tinybird finalization requires distinct deployments");
	}
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
	]);
	await deleteRetiredDeployment({
		origin,
		token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
		liveDeploymentId: deploymentId,
		retiredDeploymentId: previousLiveDeploymentId,
	});
	const artifact = readJson(artifactPath);
	artifact.promotion = {
		deploymentId,
		previousLiveDeploymentId,
		finalized: true,
		verifiedAt: new Date().toISOString(),
	};
	writeJson(artifactPath, artifact);
	writeOutput("finalized", "true");
};

const drillOwnedRollback = async () => {
	const deploymentId = option("deployment-id");
	const previousLiveDeploymentId = option("previous-live-id");
	const state = readJson(option("state"));
	if (deploymentId === previousLiveDeploymentId) {
		throw new Error("Tinybird rollback drill requires distinct deployments");
	}
	if (String(state.deploymentId) !== deploymentId) {
		throw new Error(
			"Tinybird rollback drill does not match the seeded deployment",
		);
	}
	const artifactPath = option("artifact");
	const artifact = readJson(artifactPath);
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
		"TINYBIRD_STAGING_READ_TOKEN",
	]);
	const token = tokens.TINYBIRD_STAGING_DEPLOY_TOKEN;
	try {
		await switchLiveDeployment({
			origin,
			token,
			fromDeploymentId: deploymentId,
			toDeploymentId: previousLiveDeploymentId,
		});
	} catch (error) {
		let candidateRestored = false;
		try {
			const ownership = await deploymentList({ origin, token });
			const candidateTarget = resolveOwnedMutationTarget(
				ownership.data,
				deploymentId,
			);
			const previousTarget = resolveOwnedMutationTarget(
				ownership.data,
				previousLiveDeploymentId,
			);
			if (candidateTarget === "live" && previousTarget === "staging") {
				candidateRestored = true;
			} else if (candidateTarget === "staging" && previousTarget === "live") {
				await switchLiveDeployment({
					origin,
					token,
					fromDeploymentId: previousLiveDeploymentId,
					toDeploymentId: deploymentId,
				});
				candidateRestored = true;
			}
		} catch {
			candidateRestored = false;
		}
		if (candidateRestored) {
			writeOutput("rollback_target_usable", "false");
		}
		artifact.rollbackDrill = {
			passed: false,
			candidateRestored,
			rollbackTargetUsable: false,
			verifiedAt: new Date().toISOString(),
		};
		writeJson(artifactPath, artifact);
		throw error;
	}
	let rollbackEndpointSuite;
	let rollbackProbeError;
	let excludedRollbackEndpoints = [];
	try {
		excludedRollbackEndpoints = await unavailableDecisionEndpoints({
			deploymentId: previousLiveDeploymentId,
			origin,
			state,
			token: tokens.TINYBIRD_STAGING_READ_TOKEN,
		});
		rollbackEndpointSuite = await queryDecisionEndpointSuite({
			deploymentId: previousLiveDeploymentId,
			excludedEndpointNames: excludedRollbackEndpoints,
			origin,
			state,
			token: tokens.TINYBIRD_STAGING_READ_TOKEN,
		});
		assertDecisionEndpointSuiteReadable(rollbackEndpointSuite.payloads);
	} catch (error) {
		rollbackProbeError = error;
	}
	writeOutput("rollback_target_usable", rollbackProbeError ? "false" : "true");
	try {
		await switchLiveDeployment({
			origin,
			token,
			fromDeploymentId: previousLiveDeploymentId,
			toDeploymentId: deploymentId,
		});
	} catch (error) {
		artifact.rollbackDrill = {
			passed: false,
			candidateRestored: false,
			rollbackTargetUsable: !rollbackProbeError,
			verifiedAt: new Date().toISOString(),
		};
		writeJson(artifactPath, artifact);
		throw error;
	}
	if (rollbackProbeError) {
		artifact.rollbackDrill = {
			passed: false,
			candidateRestored: true,
			rollbackTargetUsable: false,
			verifiedAt: new Date().toISOString(),
		};
		writeJson(artifactPath, artifact);
		throw new Error("The prior Tinybird deployment data plane is not usable", {
			cause: rollbackProbeError,
		});
	}
	const restoredBusinessResult = await ciAssertionsQuery({
		state,
		deploymentId,
		syntheticRunId: state.decisionRunId,
	});
	const restoredBusinessAssertions = normalizeCiAssertions(
		restoredBusinessResult.data,
	);
	assertSyntheticLoadHealth(
		restoredBusinessAssertions,
		state.decisionEventCount,
	);
	if (
		restoredBusinessAssertions.canonicalEvents !== state.decisionEventCount ||
		restoredBusinessAssertions.decisionEvents !== state.decisionEventCount
	) {
		throw new Error(
			"Tinybird rollback restoration lost exact decision materialization",
		);
	}
	assertSyntheticBusinessDecisions(restoredBusinessAssertions);
	const restoredEndpointSuite = await queryDecisionEndpointSuite({
		deploymentId,
		origin,
		state,
		syntheticRunId: state.decisionRunId,
		token: tokens.TINYBIRD_STAGING_READ_TOKEN,
	});
	assertSyntheticEndpointDecisions({
		appVersion: state.decisionAppVersion,
		date: state.decisionDate,
		hostname: state.decisionHostname,
		pathname: state.decisionPathname,
		payloads: restoredEndpointSuite.payloads,
	});
	const restoredMonetizationFilters = await querySyntheticMonetizationFilters({
		deploymentId,
		origin,
		state,
		token: tokens.TINYBIRD_STAGING_READ_TOKEN,
	});
	const restoredIdentityFilters = await querySyntheticIdentityFilters({
		deploymentId,
		origin,
		state,
		token: tokens.TINYBIRD_STAGING_READ_TOKEN,
	});
	await readAndAssertPhaseHealth({
		state,
		phase: "promoted",
		deploymentId,
	});
	artifact.rollbackDrill = {
		passed: true,
		dataPlanePassed: true,
		candidateRestored: true,
		rollbackTargetUsable: true,
		rollbackDeploymentId: previousLiveDeploymentId,
		restoredDeploymentId: deploymentId,
		rollbackEndpointLatencyMs: rollbackEndpointSuite.latencyMs,
		restoredEndpointLatencyMs: restoredEndpointSuite.latencyMs,
		restoredMonetizationFilterLatencyMs: restoredMonetizationFilters.latencyMs,
		restoredIdentityFilterLatencyMs: restoredIdentityFilters.latencyMs,
		excludedRollbackEndpoints,
		verifiedAt: new Date().toISOString(),
	};
	writeJson(artifactPath, artifact);
};

const rollbackOwnedPromotion = async () => {
	const deploymentId = option("deployment-id");
	const previousLiveDeploymentId = option("previous-live-id");
	const state = readJson(option("state"));
	if (deploymentId === previousLiveDeploymentId) {
		throw new Error("Tinybird rollback requires distinct deployments");
	}
	if (String(state.deploymentId) !== deploymentId) {
		throw new Error("Tinybird rollback does not match the seeded deployment");
	}
	const artifactPath = options.get("artifact");
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
		"TINYBIRD_STAGING_READ_TOKEN",
	]);
	const token = tokens.TINYBIRD_STAGING_DEPLOY_TOKEN;
	const current = await deploymentList({ origin, token });
	const previousTarget = resolveOwnedMutationTarget(
		current.data,
		previousLiveDeploymentId,
	);
	const rejectedTarget = resolveOwnedMutationTarget(current.data, deploymentId);
	if (previousTarget !== "live") {
		if (rejectedTarget !== "live" || previousTarget !== "staging") {
			throw new Error("Tinybird rollback pair is not recoverable");
		}
		await switchLiveDeployment({
			origin,
			token,
			fromDeploymentId: deploymentId,
			toDeploymentId: previousLiveDeploymentId,
		});
	}
	let rollbackEndpointSuite;
	let excludedRollbackEndpoints = [];
	try {
		excludedRollbackEndpoints = await unavailableDecisionEndpoints({
			deploymentId: previousLiveDeploymentId,
			origin,
			state,
			token: tokens.TINYBIRD_STAGING_READ_TOKEN,
		});
		rollbackEndpointSuite = await queryDecisionEndpointSuite({
			deploymentId: previousLiveDeploymentId,
			excludedEndpointNames: excludedRollbackEndpoints,
			origin,
			state,
			token: tokens.TINYBIRD_STAGING_READ_TOKEN,
		});
		assertDecisionEndpointSuiteReadable(rollbackEndpointSuite.payloads);
	} catch (error) {
		const ownership = await deploymentList({ origin, token });
		if (
			resolveOwnedMutationTarget(ownership.data, previousLiveDeploymentId) ===
				"live" &&
			resolveOwnedMutationTarget(ownership.data, deploymentId) === "staging"
		) {
			await switchLiveDeployment({
				origin,
				token,
				fromDeploymentId: previousLiveDeploymentId,
				toDeploymentId: deploymentId,
			});
		}
		throw new Error("The Tinybird rollback destination is not usable", {
			cause: error,
		});
	}
	await deleteRetiredDeployment({
		origin,
		token,
		liveDeploymentId: previousLiveDeploymentId,
		retiredDeploymentId: deploymentId,
	});
	if (artifactPath && fs.existsSync(artifactPath)) {
		const artifact = readJson(artifactPath);
		artifact.rollback = {
			passed: true,
			dataPlanePassed: true,
			restoredDeploymentId: previousLiveDeploymentId,
			rejectedDeploymentId: deploymentId,
			endpointLatencyMs: rollbackEndpointSuite.latencyMs,
			excludedRollbackEndpoints,
			verifiedAt: new Date().toISOString(),
		};
		writeJson(artifactPath, artifact);
	}
};

const discardOwnedDeployment = async (parameters = {}) => {
	const deploymentId = parameters.deploymentId ?? option("deployment-id");
	const artifactPath = parameters.artifactPath ?? options.get("artifact");
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
	]);
	const token = tokens.TINYBIRD_STAGING_DEPLOY_TOKEN;
	const initial = await deploymentList({ origin, token });
	resolveOwnedDiscardTarget(initial.data, deploymentId);
	const deadline =
		Date.now() + Number(process.env.DEPLOYMENT_WAIT_MS ?? 300_000);
	let lastDeletionError;
	while (Date.now() < deadline) {
		const current = await exactDeployment({ origin, token, deploymentId });
		const lifecycle = resolveExactDeploymentLifecycle(
			current.data,
			deploymentId,
		);
		if (lifecycle === "deleted") {
			writeOutput("discarded", "true");
			if (artifactPath && fs.existsSync(artifactPath)) {
				const artifact = readJson(artifactPath);
				artifact.cleanup = {
					...artifact.cleanup,
					strategy: "deployment_discard",
					candidateDiscarded: true,
					passed: true,
					verifiedAt: new Date().toISOString(),
				};
				artifact.assertions = {
					...artifact.assertions,
					cleanupPassed: true,
				};
				writeJson(artifactPath, artifact);
			}
			return;
		}
		if (lifecycle === "live") {
			throw new Error("Refusing to discard a live Tinybird deployment");
		}
		if (lifecycle !== "deleting") {
			try {
				await request(
					tinybirdUrl(
						origin,
						`/v1/deployments/${encodeURIComponent(deploymentId)}`,
					),
					{
						token,
						method: "DELETE",
						beforeAttempt: async () => {
							const ownership = await deploymentList({ origin, token });
							resolveOwnedDiscardTarget(ownership.data, deploymentId);
						},
					},
				);
			} catch (error) {
				lastDeletionError = error;
			}
		}
		await delay(2_000);
	}
	throw new Error("Timed out discarding the exact Tinybird deployment", {
		cause: lastDeletionError,
	});
};

const decisionEndpointQuery = async ({ origin, token, name, parameters }) =>
	request(tinybirdUrl(origin, `/v0/pipes/${name}.json`, parameters), {
		token,
		attempts: 3,
	});

const ROLLBACK_OPTIONAL_DECISION_ENDPOINTS = [
	"product_traffic_totals",
	"product_attribution",
	"product_identity_funnel",
	"product_experiment_outcomes",
];

const decisionEndpointAvailable = async ({
	deploymentId,
	name,
	origin,
	state,
	token,
}) => {
	const query = decisionEndpointQueries({
		startDate: state.startTime.slice(0, 10),
		endDate: state.endTime.slice(0, 10),
		deploymentId,
	}).find((candidate) => candidate.name === name);
	if (!query) throw new Error(`Unknown decision endpoint ${name}`);
	try {
		await decisionEndpointQuery({ origin, token, ...query });
		return true;
	} catch (error) {
		if (error instanceof Error && error.status === 404) return false;
		throw error;
	}
};

const unavailableDecisionEndpoints = async ({
	deploymentId,
	origin,
	state,
	token,
}) => {
	const availability = await Promise.all(
		ROLLBACK_OPTIONAL_DECISION_ENDPOINTS.map(async (name) => ({
			available: await decisionEndpointAvailable({
				deploymentId,
				name,
				origin,
				state,
				token,
			}),
			name,
		})),
	);
	return availability
		.filter(({ available }) => !available)
		.map(({ name }) => name);
};

const queryDecisionEndpointSuite = async ({
	deploymentId,
	excludedEndpointNames = [],
	includeIdentityFunnel = true,
	origin,
	state,
	syntheticRunId = "",
	token,
}) => {
	const endDate = syntheticRunId
		? state.decisionDate
		: state.endTime.slice(0, 10);
	const queries = decisionEndpointQueries({
		startDate: state.startTime.slice(0, 10),
		endDate,
		deploymentId,
		excludedEndpointNames,
		includeIdentityFunnel,
		syntheticRunId,
	});
	const results = await Promise.all(
		queries.map((query) => decisionEndpointQuery({ origin, token, ...query })),
	);
	return {
		latencyMs: Object.fromEntries(
			results.map((result, index) => [queries[index].name, result.latencyMs]),
		),
		payloads: Object.fromEntries(
			results.map((result, index) => [queries[index].name, result.data]),
		),
	};
};

const assertDecisionEndpointSuiteReadable = (payloads) => {
	for (const [name, payload] of Object.entries(payloads)) {
		if (!Array.isArray(payload?.data)) {
			throw new Error(`Tinybird rollback endpoint ${name} was not readable`);
		}
	}
};

const querySyntheticMonetizationFilters = async ({
	deploymentId,
	origin,
	state,
	token,
}) => {
	const queries = syntheticMonetizationFilterQueries({
		date: state.decisionDate,
		deploymentId,
		syntheticRunId: state.decisionRunId,
	});
	const results = await Promise.all(
		queries.map((query) =>
			decisionEndpointQuery({
				origin,
				token,
				name: "product_events_daily",
				parameters: query.parameters,
			}),
		),
	);
	const payloads = Object.fromEntries(
		results.map((result, index) => [queries[index].label, result.data]),
	);
	assertSyntheticMonetizationFilters({ payloads, queries });
	return {
		latencyMs: Object.fromEntries(
			results.map((result, index) => [queries[index].label, result.latencyMs]),
		),
		payloads,
	};
};

const querySyntheticIdentityFilters = async ({
	deploymentId,
	origin,
	state,
	token,
}) => {
	const queries = syntheticIdentityFilterQueries({
		date: state.decisionDate,
		deploymentId,
		syntheticRunId: state.decisionRunId,
	});
	const results = await Promise.all(
		queries.map((query) =>
			decisionEndpointQuery({
				origin,
				token,
				name: "product_identity_funnel",
				parameters: query.parameters,
			}),
		),
	);
	const payloads = Object.fromEntries(
		results.map((result, index) => [queries[index].label, result.data]),
	);
	assertSyntheticIdentityFilters({ payloads, queries });
	return {
		latencyMs: Object.fromEntries(
			results.map((result, index) => [queries[index].label, result.latencyMs]),
		),
		payloads,
	};
};

const waitForVercel = async () => {
	const repository = environment("GITHUB_REPOSITORY");
	const sha = environment("EXPECTED_SHA");
	const token = environment("GITHUB_TOKEN");
	const apiOrigin = environment("GITHUB_API_URL");
	const timeoutMs = Number(process.env.VERCEL_WAIT_TIMEOUT_MS ?? 900_000);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const deploymentsUrl = new URL(
			`/repos/${repository}/deployments`,
			apiOrigin,
		);
		deploymentsUrl.searchParams.set("sha", sha);
		deploymentsUrl.searchParams.set("environment", "Preview");
		deploymentsUrl.searchParams.set("per_page", "100");
		const deploymentsResponse = await fetch(deploymentsUrl, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: AbortSignal.timeout(15_000),
		});
		if (!deploymentsResponse.ok) {
			throw new Error(
				`GitHub deployments lookup failed with HTTP ${deploymentsResponse.status}`,
			);
		}
		const deployments = await deploymentsResponse.json();
		for (const deployment of deployments) {
			if (deployment.sha !== sha || deployment.environment !== "Preview") {
				continue;
			}
			const statusesUrl = new URL(
				`/repos/${repository}/deployments/${deployment.id}/statuses`,
				apiOrigin,
			);
			const statusesResponse = await fetch(statusesUrl, {
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
				},
				signal: AbortSignal.timeout(15_000),
			});
			if (!statusesResponse.ok) {
				throw new Error(
					`GitHub deployment status lookup failed with HTTP ${statusesResponse.status}`,
				);
			}
			const statuses = await statusesResponse.json();
			const currentStatus = statuses[0];
			if (currentStatus?.state !== "success") {
				continue;
			}
			const previewUrl = new URL(
				currentStatus.environment_url ?? currentStatus.target_url,
			);
			if (
				previewUrl.protocol !== "https:" ||
				!previewUrl.hostname.endsWith(".vercel.app")
			) {
				throw new Error(
					"The exact-SHA deployment did not return a Vercel preview URL",
				);
			}
			writeOutput("deployment_id", String(deployment.id));
			writeOutput("url", previewUrl.origin);
			return;
		}
		await delay(10_000);
	}
	throw new Error(
		"Timed out waiting for an exact-SHA successful Vercel preview",
	);
};

const verifyFreshPullRequestHead = async () => {
	const repository = environment("GITHUB_REPOSITORY");
	const token = environment("GITHUB_TOKEN");
	const apiOrigin = environment("GITHUB_API_URL");
	const expectedSha = environment("EXPECTED_SHA");
	const pullRequestNumber = process.env.EVENT_NUMBER?.trim() || "2003";
	if (pullRequestNumber !== "2003") {
		throw new Error("Analytics staging promotion is restricted to PR 2003");
	}
	const response = await fetch(
		new URL(`/repos/${repository}/pulls/${pullRequestNumber}`, apiOrigin),
		{
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: AbortSignal.timeout(15_000),
		},
	);
	if (!response.ok) {
		throw new Error(
			`GitHub pull request lookup failed with HTTP ${response.status}`,
		);
	}
	const pullRequest = await response.json();
	if (
		pullRequest.state !== "open" ||
		pullRequest.head?.ref !== "codex/first-party-analytics" ||
		pullRequest.head?.sha !== expectedSha
	) {
		throw new Error(
			"The analytics pull request head changed after this staging run started",
		);
	}
};

const attestPreviewTinybird = async () => {
	const secret = environment("CAP_ANALYTICS_STAGING_TEST_SECRET");
	const previewOrigin = new URL(environment("ANALYTICS_PREVIEW_URL")).origin;
	if (previewOrigin !== STAGING_PREVIEW_ACCESS_ORIGIN) {
		throw new Error(
			"The preview access URL is not the analytics staging alias",
		);
	}
	const runId = validateSyntheticRunId(environment("ANALYTICS_TEST_RUN_ID"));
	const { origin: expectedOrigin, tokens } = tinybirdEnvironment(
		Object.values(PREVIEW_TINYBIRD_TOKEN_ENV),
	);
	const expectedTokenHashes = Object.fromEntries(
		Object.entries(PREVIEW_TINYBIRD_TOKEN_ENV).map(
			([runtimeName, environmentName]) => [
				runtimeName,
				createHmac("sha256", `${secret}:${runId}`)
					.update(tokens[environmentName])
					.digest("hex"),
			],
		),
	);
	const url = new URL("/api/analytics/staging-test/attest", previewOrigin);
	const body = (sha) => JSON.stringify({ runId, sha });
	const send = (
		authorization,
		sha = environment("EXPECTED_SHA"),
		headers = {},
	) =>
		previewRequest(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(authorization ? { Authorization: authorization } : {}),
				...headers,
			},
			body: body(sha),
		});
	const unauthorized = await send();
	if (unauthorized.status !== 401) {
		throw new Error(
			`The preview configuration attestation accepted missing authorization with HTTP ${unauthorized.status}`,
		);
	}
	const invalidSignature = await send(`Bearer ${secret}`, undefined, {
		"x-cap-analytics-staging-signature": "0".repeat(64),
	});
	if (invalidSignature.status !== 401) {
		throw new Error(
			`The preview configuration attestation accepted an invalid request signature with HTTP ${invalidSignature.status}`,
		);
	}
	const wrongSha = await send(
		`Bearer ${secret}`,
		"0000000000000000000000000000000000000000",
	);
	if (wrongSha.status !== 400) {
		throw new Error(
			`The preview configuration attestation accepted a wrong SHA with HTTP ${wrongSha.status}`,
		);
	}
	const response = await send(`Bearer ${secret}`);
	if (!response.ok) {
		throw new Error(
			`The preview configuration attestation failed with HTTP ${response.status}`,
		);
	}
	assertPreviewTinybirdAttestation({
		attestation: await response.json(),
		expectedOrigin,
		expectedSha: environment("EXPECTED_SHA"),
		expectedTokenHashes,
	});
};

const previewCookies = (headers) => {
	const values =
		typeof headers.getSetCookie === "function"
			? headers.getSetCookie()
			: [headers.get("set-cookie")].filter(Boolean);
	return values
		.map((value) => value.split(";", 1)[0])
		.filter(Boolean)
		.join("; ");
};

let previewShareCookie;

const previewRequest = async (url, init = {}) => {
	const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
	const shareSecret = process.env.VERCEL_PREVIEW_SHARE_SECRET?.trim();
	const stagingSignatureHeaders = (() => {
		const pathname = new URL(url).pathname;
		if (
			pathname !== "/api/analytics/staging-test" &&
			!pathname.startsWith("/api/analytics/staging-test/")
		) {
			return {};
		}
		if (typeof init.body !== "string") return {};
		let payload;
		try {
			payload = JSON.parse(init.body);
		} catch {
			return {};
		}
		if (
			typeof payload?.runId !== "string" ||
			typeof payload?.sha !== "string"
		) {
			return {};
		}
		const secret = process.env.CAP_ANALYTICS_STAGING_TEST_SECRET;
		if (!secret) return {};
		return {
			"x-cap-analytics-staging-signature": createHmac("sha256", secret)
				.update(`${payload.runId}:${payload.sha}`)
				.digest("hex"),
		};
	})();
	const headers = new Headers({
		...(bypass
			? {
					"x-vercel-protection-bypass": bypass,
					"x-vercel-set-bypass-cookie": "true",
				}
			: {}),
		...stagingSignatureHeaders,
		...init.headers,
	});
	if (previewShareCookie) {
		headers.set(
			"Cookie",
			[headers.get("Cookie"), previewShareCookie].filter(Boolean).join("; "),
		);
	}
	const requestInit = {
		...init,
		headers,
		signal: init.signal ?? AbortSignal.timeout(20_000),
	};
	if (!shareSecret || previewShareCookie) return fetch(url, requestInit);

	const shareUrl = new URL(url);
	shareUrl.searchParams.set("_vercel_share", shareSecret);
	const handshake = await fetch(shareUrl, {
		headers: { Accept: "text/html" },
		method: "GET",
		redirect: "manual",
		signal: requestInit.signal,
	});
	if (![302, 303, 307, 308].includes(handshake.status)) return handshake;
	const location = handshake.headers.get("location");
	const cookie = previewCookies(handshake.headers)
		.split("; ")
		.find((value) => value.startsWith("_vercel_jwt="));
	if (!location || !cookie) {
		throw new Error("The staging alias did not issue a Vercel share cookie");
	}
	const redirectUrl = new URL(location, shareUrl);
	if (redirectUrl.origin !== shareUrl.origin) {
		throw new Error("The Vercel share bootstrap left the staging alias");
	}
	previewShareCookie = cookie;
	headers.set(
		"Cookie",
		[headers.get("Cookie"), previewShareCookie].filter(Boolean).join("; "),
	);
	return fetch(redirectUrl, requestInit);
};

const artifactPreviewUrl = (artifact) =>
	artifact.vercel.accessUrl ?? artifact.vercel.url;

const attestExactPreviewSha = async ({ previewOrigin, runId }) => {
	const response = await previewRequest(
		new URL("/api/analytics/staging-test/attest", previewOrigin),
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${environment("CAP_ANALYTICS_STAGING_TEST_SECRET")}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				runId: validateSyntheticRunId(runId),
				sha: exactSha(environment("EXPECTED_SHA"), "EXPECTED_SHA"),
			}),
		},
	);
	if (!response.ok) {
		throw new Error(
			`The staging alias failed exact-SHA attestation with HTTP ${response.status}`,
		);
	}
	const payload = await response.json();
	if (payload.sha !== environment("EXPECTED_SHA")) {
		throw new Error("The staging alias moved to a different Vercel SHA");
	}
};

const cleanupPreviewDatabaseState = async ({
	anonymousIdentityHashes,
	artifact,
	runIds,
	secret,
}) => {
	const url = new URL(
		"/api/analytics/staging-test/cleanup-database",
		artifactPreviewUrl(artifact),
	);
	const response = await previewRequest(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${secret}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			anonymousIdentityHashes,
			runId: runIds[0],
			scopeRunIds: runIds,
			sha: artifact.sha,
		}),
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok) {
		throw new Error(
			`The scoped staging database cleanup failed with HTTP ${response.status}`,
		);
	}
	const result = await response.json();
	if (
		result.cleaned !== true ||
		Number(result.remaining) !== 0 ||
		Number(result.runIds) !== runIds.length ||
		Number(result.identityHashes) < anonymousIdentityHashes.length
	) {
		throw new Error("The scoped staging database cleanup was incomplete");
	}
	return {
		cleaned: true,
		identityHashes: Number(result.identityHashes),
		remaining: Number(result.remaining),
		runIds: Number(result.runIds),
	};
};

const measurePageBundle = async ({ landing, requestImpl }) => {
	const origin = new URL(landing.url).origin;
	const urls = extractSameOriginNextScriptUrls(await landing.text(), origin);
	if (urls.length === 0) {
		throw new Error(`No same-origin Next.js scripts were found at ${origin}`);
	}
	const assets = await Promise.all(
		urls.map(async (url) => {
			const response = await requestImpl(url);
			if (!response.ok) {
				throw new Error(
					`A measured Next.js asset returned HTTP ${response.status}`,
				);
			}
			return {
				url: new URL(url).pathname,
				bytes: (await response.arrayBuffer()).byteLength,
			};
		}),
	);
	return {
		assetCount: assets.length,
		totalBytes: assets.reduce((total, asset) => total + asset.bytes, 0),
		largestAssets: assets
			.sort((left, right) => right.bytes - left.bytes)
			.slice(0, 10),
	};
};

const probePreview = async () => {
	const statePath = option("state");
	const artifactPath = option("artifact");
	const state = readJson(statePath);
	const artifact = readJson(artifactPath);
	const previewOrigin = new URL(artifactPreviewUrl(artifact)).origin;
	const previewRunId = validateSyntheticRunId(state.previewRunId);
	await attestExactPreviewSha({
		previewOrigin,
		runId: `${state.runId}_preview_api`,
	});
	const landing = await previewRequest(previewOrigin, {
		headers: { "x-cap-analytics-test-run": previewRunId },
	});
	if (!landing.ok) {
		throw new Error(
			`The exact-SHA Vercel preview rejected the browser bootstrap with HTTP ${landing.status}`,
		);
	}
	const cookies = previewCookies(landing.headers);
	const previewBundle = await measurePageBundle({
		landing,
		requestImpl: previewRequest,
	});
	const baselineOrigin = new URL(
		process.env.BUNDLE_BASELINE_URL ?? "https://cap.so",
	).origin;
	const baselineLanding = await fetch(baselineOrigin, {
		signal: AbortSignal.timeout(20_000),
	});
	if (!baselineLanding.ok) {
		throw new Error(
			`The bundle baseline returned HTTP ${baselineLanding.status}`,
		);
	}
	const baselineBundle = await measurePageBundle({
		landing: baselineLanding,
		requestImpl: (url) => fetch(url, { signal: AbortSignal.timeout(20_000) }),
	});
	const bundleBudget = evaluateBundleBudget({
		baselineBytes: baselineBundle.totalBytes,
		measuredBytes: previewBundle.totalBytes,
		absoluteMaximumBytes: Number(
			process.env.BUNDLE_ABSOLUTE_MAX_BYTES ?? 6_000_000,
		),
		regressionFactor: Number(process.env.BUNDLE_REGRESSION_FACTOR ?? 1.08),
		regressionFloorBytes: Number(
			process.env.BUNDLE_REGRESSION_FLOOR_BYTES ?? 200_000,
		),
	});
	if (!bundleBudget.passed) {
		throw new Error(
			`The exact-SHA JavaScript bundle was ${previewBundle.totalBytes} bytes against a ${baselineBundle.totalBytes}-byte live baseline`,
		);
	}
	const anonymousId = cookies.match(
		/(?:^|; )cap_analytics_anonymous_id=([^;]+)/,
	)?.[1];
	if (!anonymousId || !cookies.includes("cap_analytics_browser_token=")) {
		throw new Error(
			"The Vercel preview did not issue analytics browser cookies",
		);
	}
	const previewAnonymousIdentityHash = hashIdentifier(
		`anonymous\0${anonymousId}`,
	);
	if (previewAnonymousIdentityHash !== state.previewAnonymousIdentityHash) {
		throw new Error(
			"The Vercel preview issued an unexpected analytics identity",
		);
	}
	const occurredAt = new Date().toISOString();
	const runHash = hashIdentifier(state.runId);
	const event = {
		eventId: `synthetic_preview_${runHash.slice(0, 24)}`,
		eventName: "page_view",
		occurredAt,
		anonymousId,
		sessionId: `synthetic_preview_${runHash.slice(24, 48)}`,
		platform: "web",
		appVersion: state.previewAppVersion,
		pathname: "/analytics-synthetic",
		properties: {
			hostname: new URL(previewOrigin).hostname,
			is_session_entry: true,
			session_started_at: occurredAt,
		},
	};
	const body = JSON.stringify({
		events: [event],
		delivery: {
			attempted: 1,
			accepted: 0,
			retried: 0,
			dropped: 0,
			queue_overflow: 0,
			oversize: 0,
			contract_rejected: 0,
		},
	});
	const post = async ({ cookieHeader = cookies, requestBody = body } = {}) => {
		const startedAt = performance.now();
		const response = await previewRequest(
			new URL("/api/events", previewOrigin),
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookieHeader,
					Origin: previewOrigin,
					"Sec-Fetch-Site": "same-origin",
					"User-Agent": "Cap-Analytics-Staging-E2E/1.0",
					"x-cap-analytics-test-run": previewRunId,
				},
				body: requestBody,
			},
		);
		return {
			latencyMs: Math.round(performance.now() - startedAt),
			response,
		};
	};
	const missingToken = await post({ cookieHeader: "" });
	if (missingToken.response.status !== 400) {
		throw new Error(
			`The preview collector accepted a missing browser token with HTTP ${missingToken.response.status}`,
		);
	}
	const expiredToken = await post({
		cookieHeader: `cap_analytics_anonymous_id=${anonymousId}; cap_analytics_browser_token=v1.0.${anonymousId}.expired`,
	});
	if (expiredToken.response.status !== 400) {
		throw new Error(
			`The preview collector accepted an expired browser token with HTTP ${expiredToken.response.status}`,
		);
	}
	const duplicateResponses = await Promise.all([post(), post()]);
	if (duplicateResponses.some(({ response }) => !response.ok)) {
		throw new Error(
			"The preview collector rejected a valid concurrent duplicate",
		);
	}
	const collectorRequestCount = Number(
		process.env.COLLECTOR_PERFORMANCE_REQUESTS ?? 20,
	);
	const collectorConcurrency = Number(
		process.env.COLLECTOR_PERFORMANCE_CONCURRENCY ?? 4,
	);
	if (
		!Number.isInteger(collectorRequestCount) ||
		collectorRequestCount < 10 ||
		collectorRequestCount > 40 ||
		!Number.isInteger(collectorConcurrency) ||
		collectorConcurrency < 1 ||
		collectorConcurrency > 8
	) {
		throw new Error("Collector performance configuration is invalid");
	}
	const collectorBatches = Array.from(
		{ length: collectorRequestCount },
		(_, batchIndex) =>
			JSON.stringify({
				events: Array.from({ length: 20 }, (_, eventIndex) => ({
					...event,
					eventId: `synthetic_preview_load_${runHash.slice(0, 16)}_${batchIndex}_${eventIndex}`,
					occurredAt: new Date(
						Date.parse(occurredAt) + batchIndex * 20 + eventIndex,
					).toISOString(),
					pathname: `/analytics-synthetic/load-${eventIndex}`,
					properties: {
						...event.properties,
						is_session_entry: batchIndex === 0 && eventIndex === 0,
					},
				})),
				delivery: {
					attempted: 20,
					accepted: 0,
					retried: 0,
					dropped: 0,
					queue_overflow: 0,
					oversize: 0,
					contract_rejected: 0,
				},
			}),
	);
	const collectorBenchmarkStartedAt = performance.now();
	const collectorLatencySamples = [];
	let collectorAcceptedEvents = 0;
	let collectorErrors = 0;
	for (
		let offset = 0;
		offset < collectorBatches.length;
		offset += collectorConcurrency
	) {
		const wave = await Promise.all(
			collectorBatches
				.slice(offset, offset + collectorConcurrency)
				.map((requestBody) => post({ requestBody })),
		);
		for (const result of wave) {
			collectorLatencySamples.push(result.latencyMs);
			if (!result.response.ok) {
				collectorErrors += 1;
				continue;
			}
			const payload = await result.response.json();
			if (Number(payload.accepted) !== 20) {
				collectorErrors += 1;
				continue;
			}
			collectorAcceptedEvents += 20;
		}
	}
	const collectorElapsedMs = Math.max(
		1,
		Math.round(performance.now() - collectorBenchmarkStartedAt),
	);
	const collectorLatency = latencySummary(collectorLatencySamples);
	const collectorP95BudgetMs = Number(
		process.env.COLLECTOR_P95_BUDGET_MS ?? 2_500,
	);
	const collectorP99BudgetMs = Number(
		process.env.COLLECTOR_P99_BUDGET_MS ?? 3_000,
	);
	const collectorMinimumEventsPerSecond = Number(
		process.env.COLLECTOR_MINIMUM_EVENTS_PER_SECOND ?? 50,
	);
	const collectorEventsPerSecond = Math.round(
		(collectorAcceptedEvents * 1_000) / collectorElapsedMs,
	);
	if (
		collectorErrors !== 0 ||
		collectorAcceptedEvents !== collectorBatches.length * 20 ||
		collectorLatency.p95Ms > collectorP95BudgetMs ||
		collectorLatency.p99Ms > collectorP99BudgetMs ||
		collectorEventsPerSecond < collectorMinimumEventsPerSecond
	) {
		throw new Error("The exact-SHA collector performance budget failed");
	}
	const minimumAccepted = Number(process.env.RATE_LIMIT_MIN_ACCEPTED ?? 20);
	const maximumAccepted = Number(process.env.RATE_LIMIT_MAX_ACCEPTED ?? 120);
	let replayAccepted = 0;
	let rateLimited = false;
	for (let index = 0; index <= maximumAccepted; index += 1) {
		const { response } = await post();
		if (response.status === 429) {
			rateLimited = true;
			break;
		}
		if (!response.ok) {
			throw new Error(
				`The preview replay probe failed with HTTP ${response.status}`,
			);
		}
		replayAccepted += 1;
	}
	if (!rateLimited || replayAccepted < minimumAccepted) {
		throw new Error(
			`The preview rate limit accepted ${replayAccepted} replay requests before ${rateLimited ? "limiting too aggressively" : "failing to limit"}`,
		);
	}
	state.previewAcceptedRows =
		duplicateResponses.length + replayAccepted + collectorAcceptedEvents;
	state.previewExpectedEvents =
		Number(state.browserExpectedEvents ?? 0) + 1 + collectorAcceptedEvents;
	state.previewAnonymousIdentityHash = previewAnonymousIdentityHash;
	state.previewStartTime = new Date(
		new Date(occurredAt).getTime() - 120_000,
	).toISOString();
	state.previewEndTime = new Date(Date.now() + 300_000).toISOString();
	writeJson(statePath, state, 0o600);
	artifact.previewApi = {
		bootstrapPassed: true,
		missingTokenRejected: true,
		expiredTokenRejected: true,
		concurrentDuplicateAccepted: true,
		collectorPerformance: {
			acceptedEvents: collectorAcceptedEvents,
			concurrency: collectorConcurrency,
			elapsedMs: collectorElapsedMs,
			errorCount: collectorErrors,
			eventsPerSecond: collectorEventsPerSecond,
			latency: collectorLatency,
			requestCount: collectorRequestCount,
		},
		replayAcceptedBeforeRateLimit: replayAccepted,
		rateLimitPassed: true,
		collectorLatency,
		collectorP95BudgetMs,
		collectorP99BudgetMs,
		collectorMinimumEventsPerSecond,
	};
	artifact.bundle = {
		baselineOrigin,
		baseline: baselineBundle,
		measured: previewBundle,
		budget: bundleBudget,
	};
	artifact.assertions = {
		...artifact.assertions,
		previewApiPassed: true,
		invalidTokenRejected: true,
		expiredTokenRejected: true,
		tokenReplayBounded: true,
		bundleBudgetPassed: true,
		collectorBudgetPassed: true,
	};
	await attestExactPreviewSha({
		previewOrigin,
		runId: `${state.runId}_preview_api_final`,
	});
	writeJson(artifactPath, artifact);
};

const probeDurableServerPath = async () => {
	const statePath = option("state");
	const artifactPath = option("artifact");
	const state = readJson(statePath);
	const artifact = readJson(artifactPath);
	const secret = environment("CAP_ANALYTICS_STAGING_TEST_SECRET");
	const serverRunId = validateSyntheticRunId(`${state.runId}_server`);
	const url = new URL(
		"/api/analytics/staging-test",
		artifactPreviewUrl(artifact),
	);
	const body = (sha) =>
		JSON.stringify({
			scenario: "business_lifecycle",
			runId: serverRunId,
			sha,
		});
	const send = (authorization, sha = artifact.sha) =>
		previewRequest(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(authorization ? { Authorization: authorization } : {}),
			},
			body: body(sha),
		});
	const unauthorized = await send();
	if (unauthorized.status !== 401) {
		throw new Error(
			`The durable staging route accepted missing authorization with HTTP ${unauthorized.status}`,
		);
	}
	const wrongSha = await send(
		`Bearer ${secret}`,
		"0000000000000000000000000000000000000000",
	);
	if (wrongSha.status !== 400) {
		throw new Error(
			`The durable staging route accepted a wrong SHA with HTTP ${wrongSha.status}`,
		);
	}
	const response = await send(`Bearer ${secret}`);
	if (!response.ok) {
		throw new Error(
			`The durable staging route failed with HTTP ${response.status}`,
		);
	}
	const result = await response.json();
	if (
		Number(result.accepted) !== 5 ||
		Number(result.uniqueEvents) !== 5 ||
		!Array.isArray(result.workflowRuns) ||
		result.workflowRuns.length !== 5
	) {
		throw new Error(
			"The durable staging route returned incomplete workflow proof",
		);
	}
	state.serverRunId = serverRunId;
	state.serverExpectedEvents = 4;
	state.serverExpectedRows = 5;
	writeJson(statePath, state, 0o600);
	const visibility = await waitForCopyVisibility({
		label: "Durable exact-SHA server delivery",
		read: async () =>
			normalizeCiAssertions(
				(
					await ciAssertionsQuery({
						state,
						deploymentId: state.deploymentId,
						syntheticRunId: serverRunId,
					})
				).data,
			),
		assert: (assertions) => {
			if (
				assertions.receivedRows < 5 ||
				assertions.uniqueEvents !== 4 ||
				assertions.uniquePayloads !== 4 ||
				assertions.duplicateRows < 1 ||
				assertions.payloadConflicts !== 0
			) {
				throw new Error("Durable server events are not fully visible");
			}
		},
	});
	const healthUrl = new URL(
		"/api/analytics/staging-test/health",
		artifactPreviewUrl(artifact),
	);
	const healthResponse = await previewRequest(healthUrl, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${secret}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ runId: serverRunId, sha: artifact.sha }),
	});
	if (!healthResponse.ok) {
		throw new Error(
			`The durable outbox health probe failed with HTTP ${healthResponse.status}`,
		);
	}
	const outboxHealth = await healthResponse.json();
	if (
		outboxHealth.healthy !== false ||
		Number(outboxHealth.activeEvents) !== 0 ||
		Number(outboxHealth.deadLetterEvents) !== 1 ||
		Number(outboxHealth.payloadConflictEvents) !== 0 ||
		Number(outboxHealth.receiptPayloadConflictEvents) !== 0 ||
		Number(outboxHealth.receiptPayloadConflictAttempts) !== 0 ||
		Number(outboxHealth.provider429Retries) !== 1 ||
		Number(outboxHealth.provider503Retries) !== 1 ||
		Number(outboxHealth.timeoutAfterAcceptRetries) !== 1 ||
		Number(outboxHealth.providerRejectedDeadLetters) !== 1
	) {
		throw new Error(
			"The durable staging outbox did not expose the expected retry and dead-letter evidence",
		);
	}
	const databaseCleanup = await cleanupPreviewDatabaseState({
		anonymousIdentityHashes: [],
		artifact,
		runIds: [serverRunId],
		secret,
	});
	const cleanHealthResponse = await previewRequest(healthUrl, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${secret}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ runId: serverRunId, sha: artifact.sha }),
	});
	if (!cleanHealthResponse.ok) {
		throw new Error(
			`The durable outbox cleanup health probe failed with HTTP ${cleanHealthResponse.status}`,
		);
	}
	const cleanHealth = await cleanHealthResponse.json();
	if (
		cleanHealth.healthy !== true ||
		Number(cleanHealth.activeEvents) !== 0 ||
		Number(cleanHealth.deadLetterEvents) !== 0 ||
		Number(cleanHealth.payloadConflictEvents) !== 0 ||
		Number(cleanHealth.receiptPayloadConflictEvents) !== 0 ||
		Number(cleanHealth.receiptPayloadConflictAttempts) !== 0
	) {
		throw new Error("The durable staging database cleanup was incomplete");
	}
	artifact.serverDelivery = {
		acceptedRows: visibility.value.receivedRows,
		uniqueEvents: 4,
		duplicateRows: visibility.value.duplicateRows,
		workflowRuns: 5,
		provider429RetryPassed: true,
		provider503RetryPassed: true,
		providerRejectionDeadLetterPassed: true,
		lostAcknowledgementRetryPassed: true,
		visibilityMs: visibility.visibilityMs,
		databaseCleanup,
		outboxHealth: {
			activeEvents: Number(outboxHealth.activeEvents),
			deadLetterEvents: Number(outboxHealth.deadLetterEvents),
			oldestActiveAgeSeconds: Number(outboxHealth.oldestActiveAgeSeconds),
			payloadConflictEvents: Number(outboxHealth.payloadConflictEvents),
			receiptPayloadConflictAttempts: Number(
				outboxHealth.receiptPayloadConflictAttempts,
			),
			receiptPayloadConflictEvents: Number(
				outboxHealth.receiptPayloadConflictEvents,
			),
		},
		unauthorizedRejected: true,
		wrongShaRejected: true,
	};
	artifact.assertions = {
		...artifact.assertions,
		durableServerPathPassed: true,
		durableOutboxHealthPassed: true,
		durableDatabaseCleanupPassed: true,
		serverDuplicateDeliveryPassed: true,
	};
	writeJson(artifactPath, artifact);
};

const prepareSeed = async () => {
	const runId = validateSyntheticRunId(option("run-id"));
	const deploymentId = option("deployment-id");
	const statePath = option("state");
	const artifactPath = option("artifact");
	const boundary = readJson(option("boundary"));
	assertRecoveryIdentity(boundary.identity);
	const needsPromotionValue = option("needs-promotion");
	if (!["true", "false"].includes(needsPromotionValue)) {
		throw new Error("--needs-promotion must be true or false");
	}
	const needsPromotion = needsPromotionValue === "true";
	if (
		needsPromotion &&
		String(boundary.tinybird?.liveDeploymentId ?? "") === deploymentId
	) {
		throw new Error(
			"A Tinybird candidate cannot equal the prior live deployment",
		);
	}
	if (
		!needsPromotion &&
		String(boundary.tinybird?.liveDeploymentId ?? "") !== deploymentId
	) {
		throw new Error("A Tinybird no-op must retain the prior live deployment");
	}
	const sha = exactSha(environment("EXPECTED_SHA"), "EXPECTED_SHA");
	const startedAt = new Date();
	const fixture = createSyntheticEvents({ runId, now: startedAt });
	const erasureControl = createSyntheticErasureControl({
		runId,
		now: startedAt,
	});
	const decisionFixture = createSyntheticDecisionEvents({
		runId,
		now: startedAt,
	});
	const loadFixture = createSyntheticLoadEvents({
		runId,
		count: Number(process.env.PERFORMANCE_EVENT_COUNT ?? 1_000),
		daySpan: Number(process.env.PERFORMANCE_DAY_SPAN ?? 30),
		dimensionBucketCount: Number(
			process.env.PERFORMANCE_DIMENSION_BUCKETS ?? 32,
		),
		now: startedAt,
	});
	const largeLoadFixture = createSyntheticLoadEvents({
		runId: `${runId}_large`,
		count: Number(process.env.LARGE_PERFORMANCE_EVENT_COUNT ?? 100_000),
		daySpan: Number(process.env.LARGE_PERFORMANCE_DAY_SPAN ?? 80),
		dimensionBucketCount: Number(
			process.env.LARGE_PERFORMANCE_DIMENSION_BUCKETS ?? 64,
		),
		now: startedAt,
	});
	if (largeLoadFixture.rows.length <= loadFixture.rows.length) {
		throw new Error(
			"The large performance corpus must exceed the baseline corpus",
		);
	}
	const previewRunId = validateSyntheticRunId(`${runId}_preview`);
	const previewAppVersion = `staging-preview-${hashIdentifier(runId).slice(0, 12)}`;
	const cutoffRunId = validateSyntheticRunId(`${runId}_cutoff`);
	const cutoffAppVersion = createSyntheticEvents({
		runId: cutoffRunId,
		now: startedAt,
	}).appVersion;
	const previewAnonymousId = `synthetic-${hashIdentifier(previewRunId)
		.match(/.{4}/g)
		.join("x")}`;
	const state = {
		recoveryIdentity: boundary.identity,
		recoveryPhase: "preseed",
		runId,
		cutoffRunId,
		cutoffAppVersion,
		previewRunId,
		previewAppVersion,
		previewAnonymousIdentityHash: hashIdentifier(
			`anonymous\0${previewAnonymousId}`,
		),
		deploymentId,
		liveBeforeDeploymentId: boundary.tinybird.liveDeploymentId,
		needsPromotion,
		appVersion: fixture.appVersion,
		loadAppVersion: loadFixture.appVersion,
		loadDaySpan: loadFixture.daySpan,
		loadRunId: loadFixture.runId,
		loadEventCount: loadFixture.rows.length,
		loadDimensionBucketCount: loadFixture.dimensionBucketCount,
		largeLoadAppVersion: largeLoadFixture.appVersion,
		largeLoadDaySpan: largeLoadFixture.daySpan,
		largeLoadRunId: largeLoadFixture.runId,
		largeLoadEventCount: largeLoadFixture.rows.length,
		largeLoadDimensionBucketCount: largeLoadFixture.dimensionBucketCount,
		decisionRunId: decisionFixture.runId,
		decisionAppVersion: decisionFixture.appVersion,
		decisionEventCount: decisionFixture.rows.length,
		decisionDate: decisionFixture.date,
		decisionHostname: decisionFixture.hostname,
		decisionPathname: decisionFixture.pathname,
		erasureLinkedAnonymousIds: [
			...new Set(
				decisionFixture.rows
					.filter((row) => row.user_id === fixture.userId && row.anonymous_id)
					.map((row) => row.anonymous_id),
			),
		].filter((anonymousId) => anonymousId !== fixture.anonymousId),
		erasureAnonymousId: fixture.anonymousId,
		erasureOrganizationId: fixture.organizationId,
		erasureUserId: fixture.userId,
		erasureControlRunId: erasureControl.runId,
		erasureControlAppVersion: erasureControl.appVersion,
		startedAt: startedAt.toISOString(),
		startTime: new Date(
			Math.floor(
				(startedAt.getTime() -
					(Math.max(loadFixture.daySpan, largeLoadFixture.daySpan) - 1) *
						86_400_000 -
					12 * 60 * 60 * 1_000) /
					3_600_000,
			) * 3_600_000,
		).toISOString(),
		endTime: new Date(startedAt.getTime() + 300_000).toISOString(),
	};
	writeJson(statePath, state, 0o600);
	const artifact = {
		schemaVersion: 1,
		sha,
		githubRun: {
			id: environment("GITHUB_RUN_ID"),
			attempt: environment("GITHUB_RUN_ATTEMPT"),
		},
		vercel: {
			deploymentId: environment("VERCEL_DEPLOYMENT_ID"),
			accessUrl: environment("VERCEL_PREVIEW_ACCESS_URL"),
			url: environment("VERCEL_PREVIEW_URL"),
		},
		tinybird: { deploymentId },
		syntheticRunHash: hashIdentifier(runId),
		startedAt: state.startedAt,
		delivery: {
			rowsPlanned: fixture.rows.length,
			rowsAttempted: 0,
			rowsAccepted: 0,
		},
		load: {
			rowsPlanned: loadFixture.rows.length,
			daySpan: loadFixture.daySpan,
			dimensionBucketCount: loadFixture.dimensionBucketCount,
			rowsAttempted: 0,
			rowsAccepted: 0,
		},
		largeLoad: {
			rowsPlanned: largeLoadFixture.rows.length,
			daySpan: largeLoadFixture.daySpan,
			dimensionBucketCount: largeLoadFixture.dimensionBucketCount,
			rowsAttempted: 0,
			rowsAccepted: 0,
		},
		erasure: {
			controlRunHash: hashIdentifier(erasureControl.runId),
			identityHash: hashIdentifier(
				`${fixture.userId}:${fixture.organizationId}:${fixture.anonymousId}`,
			),
			controlAttempted: false,
			controlAccepted: false,
		},
		decisions: {
			rowsPlanned: decisionFixture.rows.length,
			rowsAttempted: 0,
			rowsAccepted: 0,
		},
		assertions: { seedAccepted: false },
	};
	writeJson(artifactPath, artifact);
};

const seed = async () => {
	const runId = validateSyntheticRunId(option("run-id"));
	const deploymentId = option("deployment-id");
	const statePath = option("state");
	const artifactPath = option("artifact");
	const state = readJson(statePath);
	const artifact = readJson(artifactPath);
	assertRecoveryIdentity(state.recoveryIdentity);
	const expectedRecoveryPhase = state.needsPromotion ? "prepromote" : "preseed";
	if (
		state.recoveryPhase !== expectedRecoveryPhase ||
		state.runId !== runId ||
		String(state.deploymentId) !== deploymentId ||
		artifact.sha !== environment("EXPECTED_SHA") ||
		String(artifact.tinybird?.deploymentId ?? "") !== deploymentId
	) {
		throw new Error("Tinybird seed does not match its persisted checkpoint");
	}
	const startedAt = new Date(state.startedAt);
	if (!Number.isFinite(startedAt.getTime())) {
		throw new Error("Tinybird seed checkpoint has an invalid start time");
	}
	const fixture = createSyntheticEvents({ runId, now: startedAt });
	const erasureControl = createSyntheticErasureControl({
		runId,
		now: startedAt,
	});
	const decisionFixture = createSyntheticDecisionEvents({
		runId,
		now: startedAt,
	});
	const loadFixture = createSyntheticLoadEvents({
		runId,
		count: state.loadEventCount,
		daySpan: state.loadDaySpan,
		dimensionBucketCount: state.loadDimensionBucketCount,
		now: startedAt,
	});
	const largeLoadFixture = createSyntheticLoadEvents({
		runId: `${runId}_large`,
		count: state.largeLoadEventCount,
		daySpan: state.largeLoadDaySpan,
		dimensionBucketCount: state.largeLoadDimensionBucketCount,
		now: startedAt,
	});
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
		"TINYBIRD_STAGING_INGEST_TOKEN",
	]);
	const assertExactLiveOwnership = async () => {
		if (
			(await ownedMutationTarget({
				state,
				origin,
				token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
			})) !== "live"
		) {
			throw new Error(
				"Synthetic seed requires the exact live staging deployment",
			);
		}
	};
	await assertExactLiveOwnership();
	const deliver = async (row, fixtureRow = false) => {
		if (fixtureRow) {
			artifact.delivery.rowsAttempted += 1;
			writeJson(artifactPath, artifact);
		}
		const result = await request(
			tinybirdUrl(origin, "/v0/events", {
				name: "product_events_v1",
				wait: "true",
				__tb__min_deployment: deploymentId,
			}),
			{
				token: tokens.TINYBIRD_STAGING_INGEST_TOKEN,
				method: "POST",
				body: `${JSON.stringify(row)}\n`,
				headers: { "Content-Type": "application/x-ndjson" },
				attempts: 4,
			},
		);
		if (fixtureRow) {
			artifact.delivery.rowsAccepted += 1;
			artifact.delivery.retryAttempts =
				(artifact.delivery.retryAttempts ?? 0) + result.attempt - 1;
			writeJson(artifactPath, artifact);
		}
		return { attempts: result.attempt, latencyMs: result.latencyMs };
	};
	const concurrentDeliveries = await Promise.all(
		fixture.rows.slice(0, 2).map((row) => deliver(row, true)),
	);
	const separateBatchDeliveries = [];
	for (const row of fixture.rows.slice(2)) {
		separateBatchDeliveries.push(await deliver(row, true));
	}
	const deliveries = [...concurrentDeliveries, ...separateBatchDeliveries];
	const sendLoadFixture = async (fixture, artifactKey) => {
		const batchSize = Number(process.env.PERFORMANCE_INGEST_BATCH_SIZE ?? 500);
		const concurrency = Number(process.env.PERFORMANCE_INGEST_CONCURRENCY ?? 4);
		if (!Number.isInteger(batchSize) || batchSize < 100 || batchSize > 1_000) {
			throw new Error("Performance ingestion batch size must be 100 to 1000");
		}
		if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
			throw new Error("Performance ingestion concurrency must be 1 to 8");
		}
		artifact[artifactKey].rowsAttempted = fixture.rows.length;
		writeJson(artifactPath, artifact);
		const started = performance.now();
		const latencies = [];
		let accepted = 0;
		let errorCount = 0;
		let retryAttempts = 0;
		const batches = [];
		for (let offset = 0; offset < fixture.rows.length; offset += batchSize) {
			batches.push(fixture.rows.slice(offset, offset + batchSize));
		}
		for (let offset = 0; offset < batches.length; offset += concurrency) {
			const wave = await Promise.all(
				batches.slice(offset, offset + concurrency).map(async (batch) => {
					const batchStartedAt = performance.now();
					try {
						const delivery = await request(
							tinybirdUrl(origin, "/v0/events", {
								name: "product_events_v1",
								wait: "true",
								__tb__min_deployment: deploymentId,
							}),
							{
								token: tokens.TINYBIRD_STAGING_INGEST_TOKEN,
								method: "POST",
								body: `${batch.map((row) => JSON.stringify(row)).join("\n")}\n`,
								headers: { "Content-Type": "application/x-ndjson" },
								attempts: 1,
							},
						);
						return {
							accepted: batch.length,
							error: false,
							latencyMs: delivery.latencyMs,
							retryAttempts: delivery.attempt - 1,
						};
					} catch {
						return {
							accepted: 0,
							error: true,
							latencyMs: Math.round(performance.now() - batchStartedAt),
							retryAttempts: 0,
						};
					}
				}),
			);
			for (const result of wave) {
				latencies.push(result.latencyMs);
				accepted += result.accepted;
				retryAttempts += result.retryAttempts;
				if (result.error) errorCount += 1;
			}
		}
		const elapsedMs = Math.max(1, Math.round(performance.now() - started));
		artifact[artifactKey] = {
			...artifact[artifactKey],
			rows: fixture.rows.length,
			rowsPlanned: fixture.rows.length,
			rowsAttempted: fixture.rows.length,
			rowsAccepted: accepted,
			batchSize,
			concurrency,
			batches: batches.length,
			batchLatency: latencySummary(latencies),
			errorCount,
			errorRate: errorCount / batches.length,
			retryAttempts,
			wallClockMs: elapsedMs,
			rowsPerSecond: Math.round((accepted * 1_000) / elapsedMs),
		};
		writeJson(artifactPath, artifact);
	};
	await sendLoadFixture(loadFixture, "load");
	await sendLoadFixture(largeLoadFixture, "largeLoad");
	const ingestionBatchP95BudgetMs = Number(
		process.env.INGESTION_BATCH_P95_BUDGET_MS ?? 5_000,
	);
	const ingestionMinimumRowsPerSecond = Number(
		process.env.INGESTION_MINIMUM_ROWS_PER_SECOND ?? 500,
	);
	artifact.ingestionBudget = evaluateIngestionPerformanceBudget({
		smoke: artifact.load,
		sustained: artifact.largeLoad,
		batchP95BudgetMs: ingestionBatchP95BudgetMs,
		smokeWallClockBudgetMs: Number(
			process.env.INGESTION_SMOKE_WALL_CLOCK_BUDGET_MS ?? 10_000,
		),
		minimumRowsPerSecond: ingestionMinimumRowsPerSecond,
	});
	writeJson(artifactPath, artifact);
	artifact.erasure.controlAttempted = true;
	writeJson(artifactPath, artifact);
	const erasureControlDelivery = await deliver(erasureControl.row);
	artifact.decisions.rowsAttempted = decisionFixture.rows.length;
	writeJson(artifactPath, artifact);
	const decisionDeliveries = [];
	for (const row of decisionFixture.rows) {
		decisionDeliveries.push(await deliver(row));
	}
	artifact.decisions = {
		rowsPlanned: decisionFixture.rows.length,
		rowsAttempted: decisionFixture.rows.length,
		rowsAccepted: decisionDeliveries.length,
		requestLatency: latencySummary(
			decisionDeliveries.map((delivery) => delivery.latencyMs),
		),
		retryAttempts: decisionDeliveries.reduce(
			(total, delivery) => total + delivery.attempts - 1,
			0,
		),
	};
	artifact.delivery = {
		rowsPlanned: fixture.rows.length,
		rowsAttempted: fixture.rows.length,
		rowsAccepted: deliveries.length,
		requestLatency: latencySummary(
			deliveries.map((delivery) => delivery.latencyMs),
		),
		retryAttempts: deliveries.reduce(
			(total, delivery) => total + delivery.attempts - 1,
			0,
		),
	};
	artifact.erasure = {
		...artifact.erasure,
		controlAccepted: true,
		controlDeliveryLatencyMs: erasureControlDelivery.latencyMs,
		controlRetryAttempts: erasureControlDelivery.attempts - 1,
	};
	await assertExactLiveOwnership();
	artifact.assertions.seedAccepted = true;
	writeJson(artifactPath, artifact);
	state.recoveryPhase = "postseed";
	writeJson(statePath, state, 0o600);
};

const verifyIngestionBudget = (parameters = {}) => {
	const artifact = readJson(parameters.artifactPath ?? option("artifact"));
	if (artifact.assertions?.seedAccepted !== true) {
		throw new Error("Ingestion budget verification requires a completed seed");
	}
	if (artifact.ingestionBudget?.passed !== true) {
		throw new Error("Synthetic ingestion performance budget failed");
	}
};

const waitForCopyVisibility = async ({ label, read, assert }) => {
	const startedAt = Date.now();
	const deadline = startedAt + Number(process.env.INGESTION_SLO_MS ?? 180_000);
	let lastError;
	let polls = 0;
	while (Date.now() < deadline) {
		polls += 1;
		try {
			const value = await read();
			assert(value);
			return { value, polls, visibilityMs: Date.now() - startedAt };
		} catch (error) {
			lastError = error;
			await delay(2_000);
		}
	}
	throw new Error(
		`${label} did not become visible: ${lastError instanceof Error ? lastError.message : "unknown assertion failure"}`,
	);
};

const tinybirdCopyFailure = (error) => {
	const failure =
		error instanceof Error && error.cause instanceof Error
			? error.cause
			: error;
	return {
		classification:
			failure instanceof Error && typeof failure.classification === "string"
				? failure.classification
				: "unknown",
		definitive: failure instanceof Error && failure.definitive === true,
		retryable: failure instanceof Error && failure.retryable === true,
		retryAfterMs:
			failure instanceof Error && Number.isFinite(failure.retryAfterMs)
				? failure.retryAfterMs
				: 0,
		status:
			failure instanceof Error && Number.isInteger(failure.status)
				? failure.status
				: undefined,
	};
};

const remainingCopyPipelineMs = (deadlineMs) => {
	const remainingMs = Math.floor(deadlineMs - Date.now());
	if (!Number.isFinite(deadlineMs) || remainingMs <= 0) {
		throw new Error("Tinybird Copy pipeline deadline was exhausted");
	}
	return remainingMs;
};

const runTinybirdCopyPipe = async ({
	pipe,
	origin,
	copyToken,
	schedulerToken,
	deploymentId,
	copyRunId,
	sourceCutoff,
	deadlineMs,
	assertMutationOwnership,
	onUpdate,
}) => {
	const attempts = [];
	for (let attempt = 1; attempt <= 5; attempt += 1) {
		let job;
		const capacityQuiescence = await waitForTinybirdCopyPipesQuiescent({
			origin,
			token: schedulerToken,
			request,
			workspaceWide: true,
			assertMutationOwnership,
			timeoutMs: Math.min(120_000, remainingCopyPipelineMs(deadlineMs)),
		});
		try {
			[job] = await submitTinybirdCopyJobs({
				origin,
				token: copyToken,
				deploymentId,
				request,
				pipes: [pipe],
				copyRunId,
				sourceCutoff,
				assertMutationOwnership,
			});
			attempts.push({
				attempt,
				jobId: job.jobId,
				status: "submitted",
				submissionLatencyMs: job.submissionLatencyMs,
				capacityQuiescence,
			});
			await onUpdate(attempts);
		} catch (error) {
			const failure = tinybirdCopyFailure(error);
			attempts.push({
				attempt,
				status: failure.definitive ? "rejected" : "ambiguous",
				classification: failure.classification,
				capacityQuiescence,
				...(failure.status ? { httpStatus: failure.status } : {}),
			});
			await onUpdate(attempts);
			if (!failure.definitive || !failure.retryable || attempt === 5) {
				throw error;
			}
			const backoffMs = Math.max(
				failure.retryAfterMs,
				15_000 * 2 ** (attempt - 1),
			);
			const quiescence = await waitForTinybirdCopyPipesQuiescent({
				origin,
				token: schedulerToken,
				request,
				workspaceWide: true,
				assertMutationOwnership,
				timeoutMs: Math.min(120_000, remainingCopyPipelineMs(deadlineMs)),
			});
			attempts.at(-1).backoffMs = backoffMs;
			attempts.at(-1).quiescence = quiescence;
			await onUpdate(attempts);
			if (backoffMs >= remainingCopyPipelineMs(deadlineMs)) {
				throw new Error("Tinybird Copy retry exceeded the pipeline deadline");
			}
			await delay(backoffMs);
			await assertMutationOwnership();
			continue;
		}
		try {
			const completion = await waitForTinybirdCopyJob({
				origin,
				token: schedulerToken,
				pipe,
				jobId: job.jobId,
				request,
				assertMutationOwnership,
				timeoutMs: Math.min(900_000, remainingCopyPipelineMs(deadlineMs)),
			});
			Object.assign(attempts.at(-1), {
				status: completion.status,
				polls: completion.polls,
				completionMs: completion.completionMs,
			});
			await onUpdate(attempts);
			return {
				jobs: attempts
					.filter((entry) => entry.jobId)
					.map((entry) => ({
						pipe,
						jobId: entry.jobId,
						submissionLatencyMs: entry.submissionLatencyMs,
						attempt: entry.attempt,
					})),
				completion: { pipe, ...completion },
				attempts,
			};
		} catch (error) {
			const failure = tinybirdCopyFailure(error);
			Object.assign(attempts.at(-1), {
				status: "failed",
				classification: failure.classification,
			});
			await onUpdate(attempts);
			if (!failure.definitive || !failure.retryable || attempt === 5) {
				throw error;
			}
			const backoffMs = Math.max(
				failure.retryAfterMs,
				15_000 * 2 ** (attempt - 1),
			);
			const quiescence = await waitForTinybirdCopyPipesQuiescent({
				origin,
				token: schedulerToken,
				request,
				workspaceWide: true,
				assertMutationOwnership,
				requiredVisibleJobIds: [job.jobId],
				timeoutMs: Math.min(120_000, remainingCopyPipelineMs(deadlineMs)),
			});
			attempts.at(-1).backoffMs = backoffMs;
			attempts.at(-1).quiescence = quiescence;
			await onUpdate(attempts);
			if (backoffMs >= remainingCopyPipelineMs(deadlineMs)) {
				throw new Error("Tinybird Copy retry exceeded the pipeline deadline");
			}
			await delay(backoffMs);
			await assertMutationOwnership();
		}
	}
	throw new Error("Tinybird Copy submission attempts were exhausted");
};

const phaseRunExpectations = ({ state, phase }) => {
	const expectations = [
		{
			runId: state.runId,
			canonicalEvents: ["staged", "promoted"].includes(phase) ? 1 : 0,
			decisionEvents: ["staged", "promoted"].includes(phase) ? 1 : 0,
		},
		{
			runId: state.loadRunId,
			canonicalEvents: phase === "cleanup" ? 0 : state.loadEventCount,
			decisionEvents: phase === "cleanup" ? 0 : state.loadEventCount,
		},
		{
			runId: state.largeLoadRunId,
			canonicalEvents: phase === "cleanup" ? 0 : state.largeLoadEventCount,
			decisionEvents: phase === "cleanup" ? 0 : state.largeLoadEventCount,
		},
		{
			runId: state.decisionRunId,
			canonicalEvents:
				phase === "cleanup"
					? 0
					: phase === "erasure"
						? 2
						: state.decisionEventCount,
			decisionEvents:
				phase === "cleanup"
					? 0
					: phase === "erasure"
						? 2
						: state.decisionEventCount,
		},
		{
			runId: state.erasureControlRunId,
			canonicalEvents: phase === "cleanup" ? 0 : 1,
			decisionEvents: phase === "cleanup" ? 0 : 1,
		},
		{
			runId: state.cutoffRunId,
			canonicalEvents: 0,
			decisionEvents: 0,
		},
	];
	if (phase !== "staged" && phase !== "cleanup") {
		if (!state.previewRunId) {
			throw new Error("The promoted copy phase is missing its preview run ID");
		}
	}
	if (state.previewRunId && phase !== "staged") {
		expectations.push({
			runId: state.previewRunId,
			canonicalEvents:
				phase === "cleanup" ? 0 : Number(state.previewExpectedEvents ?? 1),
			decisionEvents:
				phase === "cleanup" ? 0 : Number(state.previewExpectedEvents ?? 1),
		});
	}
	if ((state.serverRunId || phase === "cleanup") && phase !== "staged") {
		expectations.push({
			runId: state.serverRunId ?? `${state.runId}_server`,
			canonicalEvents:
				phase === "cleanup" ? 0 : Number(state.serverExpectedEvents),
			decisionEvents:
				phase === "cleanup" ? 0 : Number(state.serverExpectedEvents),
		});
	}
	return expectations;
};

const readPhaseCiAssertions = async ({ state, deploymentId, expectations }) =>
	Promise.all(
		expectations.map(async (expectation) => ({
			...expectation,
			assertions: normalizeCiAssertions(
				(
					await ciAssertionsQuery({
						state,
						deploymentId,
						syntheticRunId: expectation.runId,
					})
				).data,
			),
		})),
	);

const assertPhaseCiAssertions = (results, fieldNames) => {
	for (const result of results) {
		for (const fieldName of fieldNames) {
			if (result.assertions[fieldName] !== result[fieldName]) {
				throw new Error(
					`Synthetic ${fieldName} was ${result.assertions[fieldName]}, expected ${result[fieldName]}`,
				);
			}
		}
	}
};

const assertZeroHealth = (health) => {
	if (Object.values(health).some((value) => value !== 0)) {
		throw new Error("Synthetic health was not fully retracted");
	}
};

const assertSingleHealth = (health) => {
	if (
		health.receivedRows < 1 ||
		health.uniqueEvents !== 1 ||
		health.uniquePayloads !== 1 ||
		health.payloadConflicts !== 0
	) {
		throw new Error("Synthetic single-event health is incomplete");
	}
};

const readAndAssertPhaseHealth = async ({ state, phase, deploymentId }) => {
	const [main, load, largeLoad, control, preview] = await Promise.all([
		healthQuery({ state, deploymentId }),
		healthQuery({
			state,
			deploymentId,
			appVersion: state.loadAppVersion,
		}),
		healthQuery({
			state,
			deploymentId,
			appVersion: state.largeLoadAppVersion,
		}),
		healthQuery({
			state,
			deploymentId,
			appVersion: state.erasureControlAppVersion,
		}),
		phase === "staged" || !state.previewAppVersion
			? Promise.resolve(null)
			: healthQuery({
					state,
					deploymentId,
					appVersion: state.previewAppVersion,
				}),
	]);
	const health = {
		main: normalizeHealth(main.data),
		load: normalizeHealth(load.data),
		largeLoad: normalizeHealth(largeLoad.data),
		control: normalizeHealth(control.data),
		preview: preview ? normalizeHealth(preview.data) : null,
	};
	if (["staged", "promoted"].includes(phase)) {
		assertSyntheticHealth(health.main);
		if (
			health.load.receivedRows < state.loadEventCount ||
			health.load.uniqueEvents !== state.loadEventCount ||
			health.load.uniquePayloads !== state.loadEventCount ||
			health.load.payloadConflicts !== 0
		) {
			throw new Error("Synthetic load health is incomplete");
		}
		if (
			health.largeLoad.receivedRows < state.largeLoadEventCount ||
			health.largeLoad.uniqueEvents !== state.largeLoadEventCount ||
			health.largeLoad.uniquePayloads !== state.largeLoadEventCount ||
			health.largeLoad.payloadConflicts !== 0
		) {
			throw new Error("Large synthetic load health is incomplete");
		}
	} else {
		assertZeroHealth(health.main);
		assertZeroHealth(health.load);
		assertZeroHealth(health.largeLoad);
	}
	if (phase === "cleanup") {
		assertZeroHealth(health.control);
		if (health.preview) assertZeroHealth(health.preview);
	} else {
		assertSingleHealth(health.control);
		if (health.preview) assertSingleHealth(health.preview);
	}
	return health;
};

const runCopies = async (parameters = {}) => {
	const state =
		parameters.state ?? readJson(parameters.statePath ?? option("state"));
	const artifactPath = parameters.artifactPath ?? option("artifact");
	const artifact = readJson(artifactPath);
	const enforcePerformanceBudget = parameters.enforcePerformanceBudget ?? true;
	const phase = parameters.phase ?? option("phase");
	const requestedTarget = parameters.target ?? option("target");
	const deploymentId = parameters.deploymentId ?? option("deployment-id");
	if (!["staged", "promoted", "erasure", "cleanup"].includes(phase)) {
		throw new Error("Tinybird copy phase is invalid");
	}
	if (requestedTarget !== "live") {
		throw new Error(
			"Tinybird Copy mutations are allowed only after staging promotion",
		);
	}
	if (String(state.deploymentId) !== deploymentId) {
		throw new Error("Tinybird copy deployment does not match the seeded run");
	}
	const requiredTokenNames = [
		"TINYBIRD_STAGING_COPY_TOKEN",
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
		"TINYBIRD_STAGING_SCHEDULER_TOKEN",
	];
	if (phase === "promoted") {
		requiredTokenNames.push("TINYBIRD_STAGING_INGEST_TOKEN");
	}
	const { origin, tokens } = tinybirdEnvironment(requiredTokenNames);
	const copyRunId = validateSyntheticRunId(`${state.runId}_${phase}`);
	const expectations = phaseRunExpectations({ state, phase });
	const executeCopies = async (target) => {
		const pipelineStartedAt = performance.now();
		const deadlineMs = Date.now() + COPY_PIPELINE_DEADLINE_MS;
		const assertMutationOwnership = async () => {
			if (
				(await ownedMutationTarget({
					state,
					origin,
					token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
				})) !== target
			) {
				throw new Error("The owned Tinybird deployment target changed");
			}
		};
		const preflightQuiescence = await waitForTinybirdCopyPipesQuiescent({
			origin,
			token: tokens.TINYBIRD_STAGING_SCHEDULER_TOKEN,
			request,
			workspaceWide: true,
			assertMutationOwnership,
			timeoutMs: Math.min(120_000, remainingCopyPipelineMs(deadlineMs)),
		});
		const sourceCutoff = new Date().toISOString();
		const copyAttempts = {};
		const recordCopyAttempts = (pipe, attempts, status) => {
			copyAttempts[pipe] = attempts.map((entry) => ({ ...entry }));
			const jobs = Object.entries(copyAttempts).flatMap(
				([attemptPipe, entries]) =>
					entries
						.filter((entry) => entry.jobId)
						.map((entry) => ({
							pipe: attemptPipe,
							jobId: entry.jobId,
							submissionLatencyMs: entry.submissionLatencyMs,
							attempt: entry.attempt,
						})),
			);
			artifact.copyJobs = {
				...artifact.copyJobs,
				[phase]: {
					...artifact.copyJobs?.[phase],
					status,
					target,
					copyRunHash: hashIdentifier(copyRunId),
					sourceCutoff,
					preflightQuiescence,
					jobs,
					attempts: copyAttempts,
				},
			};
			writeJson(artifactPath, artifact);
		};
		const stateJobs = [];
		const stateJobCompletions = [];
		for (const pipe of [
			"snapshot_product_event_id_states_v2",
			"snapshot_product_event_day_states_v2",
		]) {
			const copy = await runTinybirdCopyPipe({
				pipe,
				origin,
				copyToken: tokens.TINYBIRD_STAGING_COPY_TOKEN,
				schedulerToken: tokens.TINYBIRD_STAGING_SCHEDULER_TOKEN,
				deploymentId: state.deploymentId,
				sourceCutoff,
				deadlineMs,
				assertMutationOwnership,
				onUpdate: (attempts) =>
					recordCopyAttempts(pipe, attempts, "state_in_progress"),
			});
			stateJobs.push(...copy.jobs);
			stateJobCompletions.push(copy.completion);
		}
		if (phase === "promoted") {
			const cutoffReceivedAt = new Date(
				Math.max(Date.now(), Date.parse(sourceCutoff) + 1),
			);
			const cutoffFixture = createSyntheticEvents({
				runId: state.cutoffRunId,
				now: cutoffReceivedAt,
			});
			const delivery = await request(
				tinybirdUrl(origin, "/v0/events", {
					name: "product_events_v1",
					wait: "true",
					__tb__min_deployment: state.deploymentId,
				}),
				{
					token: tokens.TINYBIRD_STAGING_INGEST_TOKEN,
					method: "POST",
					body: `${JSON.stringify(cutoffFixture.rows[0])}\n`,
					headers: { "Content-Type": "application/x-ndjson" },
					attempts: 4,
				},
			);
			artifact.cutoffIsolation = {
				status: "post_cutoff_event_accepted",
				runHash: hashIdentifier(state.cutoffRunId),
				sourceCutoff,
				receivedAt: cutoffReceivedAt.toISOString(),
				requestLatencyMs: delivery.latencyMs,
				retryAttempts: delivery.attempt - 1,
			};
			writeJson(artifactPath, artifact);
		}
		const canonicalCopy = await runTinybirdCopyPipe({
			pipe: "snapshot_product_events_canonical_v1",
			origin,
			copyToken: tokens.TINYBIRD_STAGING_COPY_TOKEN,
			schedulerToken: tokens.TINYBIRD_STAGING_SCHEDULER_TOKEN,
			deploymentId: state.deploymentId,
			sourceCutoff,
			deadlineMs,
			assertMutationOwnership,
			onUpdate: (attempts) =>
				recordCopyAttempts(
					"snapshot_product_events_canonical_v1",
					attempts,
					"canonical_in_progress",
				),
		});
		const canonicalJobs = canonicalCopy.jobs;
		artifact.copyJobs = {
			...artifact.copyJobs,
			[phase]: {
				status: "in_progress",
				target,
				copyRunHash: hashIdentifier(copyRunId),
				sourceCutoff,
				preflightQuiescence,
				jobs: [...stateJobs, ...canonicalJobs],
				attempts: copyAttempts,
				stateJobCompletions,
			},
		};
		writeJson(artifactPath, artifact);
		const canonicalJobCompletions = [canonicalCopy.completion];
		const canonicalVisibility = await waitForCopyVisibility({
			label: "Tinybird canonical copy",
			read: () =>
				readPhaseCiAssertions({
					state,
					deploymentId: state.deploymentId,
					expectations,
				}),
			assert: (results) =>
				assertPhaseCiAssertions(results, ["canonicalEvents"]),
		});
		const downstreamJobs = [];
		const downstreamJobCompletions = [];
		const downstreamVisibility = {};
		const copySteps = [
			{
				pipe: "snapshot_product_events_daily_exact",
				marker: "decisionMarkers",
			},
			{
				pipe: "snapshot_product_traffic_daily_exact",
				marker: "trafficMarkers",
			},
			{
				pipe: "snapshot_product_traffic_pages_daily_exact",
				marker: "trafficPageMarkers",
			},
			{
				pipe: "snapshot_product_activation_daily_exact",
				marker: "activationMarkers",
			},
			{
				pipe: "snapshot_product_creator_retention_exact",
				marker: "retentionMarkers",
			},
			{
				pipe: "snapshot_product_identity_funnel_exact",
				marker: "identityMarkers",
			},
			{
				pipe: "snapshot_product_attribution_daily_exact",
				marker: "attributionMarkers",
			},
			{
				pipe: "snapshot_product_experiment_outcomes_exact",
				marker: "experimentMarkers",
			},
			{
				pipe: "snapshot_product_events_health_hourly",
				marker: "healthMarkers",
			},
		];
		for (const copyStep of copySteps) {
			const copy = await runTinybirdCopyPipe({
				pipe: copyStep.pipe,
				origin,
				copyToken: tokens.TINYBIRD_STAGING_COPY_TOKEN,
				schedulerToken: tokens.TINYBIRD_STAGING_SCHEDULER_TOKEN,
				deploymentId: state.deploymentId,
				copyRunId,
				sourceCutoff,
				deadlineMs,
				assertMutationOwnership,
				onUpdate: (attempts) =>
					recordCopyAttempts(copyStep.pipe, attempts, "in_progress"),
			});
			const copyJobs = copy.jobs;
			downstreamJobs.push(...copyJobs);
			downstreamJobCompletions.push(copy.completion);
			const visibility = await waitForCopyVisibility({
				label: `Tinybird ${copyStep.pipe} copy`,
				read:
					copyStep.read ??
					(async () =>
						normalizeCopyAssertions(
							(
								await copyAssertionsQuery({
									copyRunId,
									deploymentId: state.deploymentId,
								})
							).data,
						)),
				assert:
					copyStep.assert ??
					((markers) => {
						if (markers[copyStep.marker] !== 1) {
							throw new Error(
								`Tinybird ${copyStep.marker} was ${markers[copyStep.marker]}, expected 1`,
							);
						}
					}),
			});
			downstreamVisibility[copyStep.pipe] = {
				polls: visibility.polls,
				visibilityMs: visibility.visibilityMs,
				...(copyStep.marker ? { marker: copyStep.marker } : {}),
			};
		}
		const decisionVisibility = await waitForCopyVisibility({
			label: "Tinybird decision copies",
			read: () =>
				readPhaseCiAssertions({
					state,
					deploymentId: state.deploymentId,
					expectations,
				}),
			assert: (results) => assertPhaseCiAssertions(results, ["decisionEvents"]),
		});
		if (phase === "promoted") {
			const cutoffAssertions = normalizeCiAssertions(
				(
					await ciAssertionsQuery({
						state,
						deploymentId: state.deploymentId,
						syntheticRunId: state.cutoffRunId,
					})
				).data,
			);
			if (
				cutoffAssertions.receivedRows < 1 ||
				cutoffAssertions.uniqueEvents !== 1 ||
				cutoffAssertions.uniquePayloads !== 1 ||
				cutoffAssertions.payloadConflicts !== 0 ||
				cutoffAssertions.canonicalEvents !== 0 ||
				cutoffAssertions.decisionEvents !== 0
			) {
				throw new Error("Post-cutoff event leaked into the active generation");
			}
			artifact.cutoffIsolation = {
				...artifact.cutoffIsolation,
				status: "passed",
				receivedRows: cutoffAssertions.receivedRows,
				canonicalEvents: cutoffAssertions.canonicalEvents,
				decisionEvents: cutoffAssertions.decisionEvents,
			};
			artifact.assertions = {
				...artifact.assertions,
				cutoffIsolationPassed: true,
			};
			writeJson(artifactPath, artifact);
		}
		await assertMutationOwnership();
		const visibility = latencySummary([
			...stateJobCompletions.map((completion) => completion.completionMs),
			...canonicalJobCompletions.map((completion) => completion.completionMs),
			...downstreamJobCompletions.map((completion) => completion.completionMs),
			canonicalVisibility.visibilityMs,
			...Object.values(downstreamVisibility).map(
				(copyVisibility) => copyVisibility.visibilityMs,
			),
			decisionVisibility.visibilityMs,
		]);
		return {
			status: "passed",
			target,
			copyRunHash: hashIdentifier(copyRunId),
			preflightQuiescence,
			jobs: [...stateJobs, ...canonicalJobs, ...downstreamJobs],
			attempts: copyAttempts,
			stateJobCompletions,
			canonicalJobCompletions,
			downstreamJobCompletions,
			canonicalVisibility: {
				polls: canonicalVisibility.polls,
				visibilityMs: canonicalVisibility.visibilityMs,
			},
			downstreamVisibility: { copies: downstreamVisibility },
			decisionVisibility: {
				polls: decisionVisibility.polls,
				visibilityMs: decisionVisibility.visibilityMs,
			},
			performance: {
				pipelineWallClockMs: Math.round(performance.now() - pipelineStartedAt),
				visibility,
			},
		};
	};
	let target = requestedTarget;
	for (
		let transitionAttempt = 0;
		transitionAttempt < 2;
		transitionAttempt += 1
	) {
		try {
			const result = await executeCopies(target);
			const baseline = artifact.copyPerformance?.baseline ?? null;
			const budget = evaluateCopyPerformanceBudget({
				absolutePipelineMs: Number(
					process.env.COPY_PIPELINE_WALL_CLOCK_BUDGET_MS ?? 600_000,
				),
				absoluteVisibilityP95Ms: Number(
					process.env.COPY_VISIBILITY_P95_BUDGET_MS ?? 120_000,
				),
				baseline,
				measured: result.performance,
				regressionFactor: Number(process.env.COPY_REGRESSION_FACTOR ?? 2),
				regressionFloorMs: Number(
					process.env.COPY_REGRESSION_FLOOR_MS ?? 30_000,
				),
			});
			const phasePerformance = {
				...result.performance,
				budget: { ...budget, enforced: enforcePerformanceBudget },
			};
			artifact.copyPerformance = {
				providerResourceMetrics: {
					available: false,
					limitation:
						"Tinybird Copy job completion is polled for every rebuild, but provider resource metrics remain unavailable; CI measures job completion, marker visibility, and end-to-end pipeline wall-clock.",
				},
				baseline: baseline ?? {
					phase,
					pipelineWallClockMs: result.performance.pipelineWallClockMs,
					visibility: result.performance.visibility,
				},
				phases: {
					...artifact.copyPerformance?.phases,
					[phase]: phasePerformance,
				},
			};
			artifact.copyJobs = {
				...artifact.copyJobs,
				[phase]: {
					...result,
					performance: phasePerformance,
				},
			};
			if (phase === "cleanup") writeOutput("target", target);
			writeJson(artifactPath, artifact);
			if (!budget.passed && enforcePerformanceBudget) {
				throw new Error(
					`Tinybird Copy performance budget failed for ${phase}: pipeline ${result.performance.pipelineWallClockMs}ms, visibility p95 ${result.performance.visibility.p95Ms}ms`,
				);
			}
			return;
		} catch (error) {
			if (phase === "cleanup" && target === "staging") {
				const resolvedTarget = await waitForOwnedMutationTarget({
					state,
					origin,
					token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
				});
				const nextTarget = reconcileCleanupTarget(target, resolvedTarget);
				if (nextTarget !== target) {
					target = nextTarget;
					continue;
				}
			}
			artifact.copyJobs = {
				...artifact.copyJobs,
				[phase]: {
					...artifact.copyJobs?.[phase],
					status: "failed",
					error:
						error instanceof Error
							? error.message
							: "Unknown Tinybird copy error",
				},
			};
			writeJson(artifactPath, artifact);
			throw error;
		}
	}
	throw new Error("Tinybird cleanup copies changed target more than once");
};

const setCopySchedules = async (parameters = {}) => {
	const state = parameters.state ?? readJson(option("state"));
	const artifactPath = parameters.artifactPath ?? option("artifact");
	const artifact = readJson(artifactPath);
	const action = parameters.action ?? option("action");
	if (!["pause", "resume"].includes(action)) {
		throw new Error("Tinybird Copy schedule action must be pause or resume");
	}
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
		"TINYBIRD_STAGING_COPY_TOKEN",
		"TINYBIRD_STAGING_SCHEDULER_TOKEN",
	]);
	if (
		(await ownedMutationTarget({
			state,
			origin,
			token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
		})) !== "live"
	) {
		throw new Error(
			"Copy schedules can change only on the owned live deployment",
		);
	}
	const assertLiveOwnership = async () => {
		if (
			(await ownedMutationTarget({
				state,
				origin,
				token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
			})) !== "live"
		) {
			throw new Error(
				"The owned Tinybird deployment changed during Copy control",
			);
		}
	};
	const unscheduledPipes = new Set();
	await applyCopyScheduleAction({
		pipes: COPY_PIPES,
		action,
		setSchedule: async (pipe, scheduleAction) => {
			let mutationError;
			let unscheduled = false;
			try {
				const response = await tokenScopeProbe(
					tinybirdUrl(
						origin,
						`/v0/pipes/${encodeURIComponent(pipe)}/copy/${scheduleAction === "pause" ? "cancel" : "resume"}`,
					),
					tokens.TINYBIRD_STAGING_SCHEDULER_TOKEN,
					{ method: "POST" },
				);
				if (!response.ok) {
					const payload =
						response.status === 422
							? await response.json().catch(() => ({}))
							: {};
					if (isUnscheduledCopyMutation(response.status, payload)) {
						unscheduled = true;
						unscheduledPipes.add(pipe);
					} else {
						const error = new Error(
							`Tinybird request was rejected with HTTP ${response.status}`,
						);
						error.status = response.status;
						throw error;
					}
				}
			} catch (error) {
				mutationError = error;
			}
			if (unscheduled) return;
			if (scheduleAction === "pause") {
				if (!mutationError) return;
				if (
					mutationError instanceof Error &&
					[400, 404].includes(mutationError.status)
				) {
					await waitForTinybirdCopyPipesQuiescent({
						origin,
						token: tokens.TINYBIRD_STAGING_SCHEDULER_TOKEN,
						pipes: [pipe],
						request,
						assertMutationOwnership: assertLiveOwnership,
					});
					return;
				}
				throw mutationError;
			}
			const pipeState = await request(
				tinybirdUrl(origin, `/v0/pipes/${encodeURIComponent(pipe)}`),
				{
					token: tokens.TINYBIRD_STAGING_SCHEDULER_TOKEN,
					attempts: 4,
				},
			);
			if (
				copyScheduleMatchesAction(pipeState, scheduleAction) &&
				(!mutationError ||
					(mutationError instanceof Error &&
						[400, 404].includes(mutationError.status)))
			) {
				return;
			}
			if (mutationError) throw mutationError;
			throw new Error(
				`Tinybird did not attest the ${scheduleAction} state for ${pipe}`,
			);
		},
	});
	const quiescence =
		action === "pause"
			? await waitForTinybirdCopyPipesQuiescent({
					origin,
					token: tokens.TINYBIRD_STAGING_SCHEDULER_TOKEN,
					request,
					requiredVisibleJobIds: Object.values(artifact.copyJobs ?? {})
						.flatMap((phase) => (Array.isArray(phase?.jobs) ? phase.jobs : []))
						.map((job) => job?.jobId)
						.filter((jobId) => typeof jobId === "string"),
					assertMutationOwnership: assertLiveOwnership,
				})
			: undefined;
	artifact.copySchedule = {
		...(artifact.copySchedule ?? {}),
		[action]: {
			status: "passed",
			deploymentId: String(state.deploymentId),
			pipeCount: COPY_PIPES.length,
			unscheduledPipeCount: unscheduledPipes.size,
			...(quiescence ? { quiescence } : {}),
		},
	};
	writeJson(artifactPath, artifact);
};

const assertZeroCiAssertions = (assertions, label) => {
	if (Object.values(assertions).some((value) => value !== 0)) {
		throw new Error(`${label} contained synthetic rows before staging seed`);
	}
};

const verifyPreSeedDeployment = async ({
	state,
	artifact,
	artifactPath,
	target,
}) => {
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_READ_TOKEN",
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
	]);
	const deploymentId = String(state.deploymentId);
	const liveDeploymentId = String(
		target === "staging" ? state.liveBeforeDeploymentId : state.deploymentId,
	);
	if (
		!/^[0-9]+$/.test(deploymentId) ||
		!/^[0-9]+$/.test(liveDeploymentId) ||
		(target === "staging" && deploymentId === liveDeploymentId)
	) {
		throw new Error("Pre-seed validation has invalid Tinybird deployment IDs");
	}
	const resolvedTarget = await ownedMutationTarget({
		state,
		origin,
		token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
	});
	if (resolvedTarget !== target) {
		throw new Error("Pre-seed validation lost exact deployment ownership");
	}
	const runIds = [
		state.runId,
		state.cutoffRunId,
		state.loadRunId,
		state.largeLoadRunId,
		state.decisionRunId,
		state.erasureControlRunId,
	];
	for (const syntheticRunId of runIds) {
		const [exact, pinnedLive, defaultLive] = await Promise.all([
			ciAssertionsQuery({ state, deploymentId, syntheticRunId }),
			ciAssertionsQuery({
				state,
				deploymentId: liveDeploymentId,
				syntheticRunId,
			}),
			ciAssertionsQuery({ state, syntheticRunId }),
		]);
		assertZeroCiAssertions(
			normalizeCiAssertions(exact.data),
			"Exact Tinybird deployment",
		);
		assertZeroCiAssertions(
			normalizeCiAssertions(pinnedLive.data),
			"Pinned live Tinybird deployment",
		);
		assertZeroCiAssertions(
			normalizeCiAssertions(defaultLive.data),
			"Default live Tinybird deployment",
		);
	}
	const samples = {};
	const fanoutSamples = [];
	for (let round = 0; round < 5; round += 1) {
		const startedAt = performance.now();
		const suite = await queryDecisionEndpointSuite({
			deploymentId,
			origin,
			state,
			syntheticRunId: state.decisionRunId,
			token: tokens.TINYBIRD_STAGING_READ_TOKEN,
		});
		assertDecisionEndpointSuiteReadable(suite.payloads);
		fanoutSamples.push(Math.round(performance.now() - startedAt));
		for (const [name, latencyMs] of Object.entries(suite.latencyMs)) {
			samples[name] = [...(samples[name] ?? []), latencyMs];
		}
	}
	const endpointLatency = Object.fromEntries(
		Object.entries(samples).map(([name, values]) => [
			name,
			latencySummary(values),
		]),
	);
	const dashboardFanoutLatency = latencySummary(fanoutSamples);
	const endpointP95BudgetMs = Number(
		process.env.ENDPOINT_P95_BUDGET_MS ?? 2_500,
	);
	const fanoutP95BudgetMs = Number(
		process.env.DASHBOARD_FANOUT_P95_BUDGET_MS ?? 3_500,
	);
	const failedEndpoints = Object.entries(endpointLatency)
		.filter(([, latency]) => latency.p95Ms > endpointP95BudgetMs)
		.map(([name]) => name);
	artifact.candidateValidation = {
		strategy: "promote_then_seed",
		exactDeploymentId: deploymentId,
		liveDeploymentId,
		preSeedSyntheticRows: 0,
		endpointLatency,
		dashboardFanoutLatency,
	};
	artifact.assertions = {
		...artifact.assertions,
		candidateExactDeploymentPassed: true,
		candidatePreSeedCleanPassed: true,
		candidateEndpointsPassed:
			failedEndpoints.length === 0 &&
			dashboardFanoutLatency.p95Ms <= fanoutP95BudgetMs,
	};
	writeJson(artifactPath, artifact);
	if (
		failedEndpoints.length > 0 ||
		dashboardFanoutLatency.p95Ms > fanoutP95BudgetMs
	) {
		throw new Error(
			`Candidate endpoint budgets failed: ${[
				...failedEndpoints,
				...(dashboardFanoutLatency.p95Ms <= fanoutP95BudgetMs
					? []
					: ["dashboard_fanout"]),
			].join(", ")}`,
		);
	}
};

const verifyPreSeed = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	const artifact = readJson(artifactPath);
	const target = option("target");
	dataMutationDeploymentParameters({
		target,
		deploymentId: option("deployment-id"),
		expectedDeploymentId: String(state.deploymentId),
	});
	await verifyPreSeedDeployment({ state, artifact, artifactPath, target });
};

const verify = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	const artifact = readJson(artifactPath);
	const target = option("target");
	dataMutationDeploymentParameters({
		target,
		deploymentId: option("deployment-id"),
		expectedDeploymentId: String(state.deploymentId),
	});
	if (target === "staging") {
		throw new Error("Synthetic verification requires a promoted deployment");
	}
	const deadline = Date.now() + Number(process.env.INGESTION_SLO_MS ?? 180_000);
	let result;
	let health;
	while (Date.now() < deadline) {
		result = await healthQuery({ state, deploymentId: state.deploymentId });
		health = normalizeHealth(result.data);
		try {
			assertSyntheticHealth(health);
			break;
		} catch {
			await delay(5_000);
		}
	}
	assertSyntheticHealth(health);
	const decisionResult = await ciAssertionsQuery({
		state,
		deploymentId: state.deploymentId,
	});
	const decisionAssertions = normalizeCiAssertions(decisionResult.data);
	assertSyntheticDecisions(decisionAssertions);
	const loadResult = await healthQuery({
		state,
		deploymentId: state.deploymentId,
		appVersion: state.loadAppVersion,
	});
	const loadHealth = normalizeHealth(loadResult.data);
	if (
		loadHealth.uniqueEvents !== state.loadEventCount ||
		loadHealth.uniquePayloads !== state.loadEventCount ||
		loadHealth.receivedRows < state.loadEventCount ||
		loadHealth.payloadConflicts !== 0
	) {
		throw new Error(
			"Synthetic load health did not match the accepted event set",
		);
	}
	const loadDecisionResult = await ciAssertionsQuery({
		state,
		deploymentId: state.deploymentId,
		syntheticRunId: state.loadRunId,
	});
	const loadDecisionAssertions = normalizeCiAssertions(loadDecisionResult.data);
	assertSyntheticLoadDecisions(loadDecisionAssertions, state.loadEventCount);
	const largeLoadResult = await healthQuery({
		state,
		deploymentId: state.deploymentId,
		appVersion: state.largeLoadAppVersion,
	});
	const largeLoadHealth = normalizeHealth(largeLoadResult.data);
	assertSyntheticLoadHealth(largeLoadHealth, state.largeLoadEventCount);
	const largeLoadDecisionResult = await ciAssertionsQuery({
		state,
		deploymentId: state.deploymentId,
		syntheticRunId: state.largeLoadRunId,
	});
	const largeLoadDecisionAssertions = normalizeCiAssertions(
		largeLoadDecisionResult.data,
	);
	assertSyntheticLoadDecisions(
		largeLoadDecisionAssertions,
		state.largeLoadEventCount,
	);
	const samples = [result.latencyMs];
	for (let index = 1; index < 20; index += 1) {
		const sample = await healthQuery({
			state,
			deploymentId: state.deploymentId,
		});
		samples.push(sample.latencyMs);
	}
	const endpointLatency = latencySummary(samples);
	const endpointP95BudgetMs = Number(
		process.env.ENDPOINT_P95_BUDGET_MS ?? 2_500,
	);
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_READ_TOKEN",
	]);
	const baselineDeploymentId =
		options.get("baseline-deployment-id") || state.deploymentId;
	if (!/^[0-9]+$/.test(baselineDeploymentId)) {
		throw new Error(
			"Tinybird performance baseline must be a numeric deployment",
		);
	}
	const hasIndependentBaseline = baselineDeploymentId !== state.deploymentId;
	const excludedBaselineEndpoints = hasIndependentBaseline
		? await unavailableDecisionEndpoints({
				deploymentId: baselineDeploymentId,
				origin,
				state,
				token: tokens.TINYBIRD_STAGING_READ_TOKEN,
			})
		: [];
	const baselineQueries = hasIndependentBaseline
		? decisionEndpointQueries({
				startDate: state.startTime.slice(0, 10),
				endDate: state.endTime.slice(0, 10),
				deploymentId: baselineDeploymentId,
				excludedEndpointNames: excludedBaselineEndpoints,
			})
		: [];
	const measuredQueries = decisionEndpointQueries({
		startDate: state.startTime.slice(0, 10),
		endDate: state.endTime.slice(0, 10),
		deploymentId: state.deploymentId,
	});
	const representativeQueries = decisionEndpointQueries({
		startDate: state.startTime.slice(0, 10),
		endDate: state.decisionDate,
		deploymentId: state.deploymentId,
		syntheticRunId: state.loadRunId,
	});
	const largeQueries = decisionEndpointQueries({
		startDate: state.startTime.slice(0, 10),
		endDate: state.decisionDate,
		deploymentId: state.deploymentId,
		syntheticRunId: state.largeLoadRunId,
	});
	const representativeCoverage = await queryDecisionEndpointSuite({
		deploymentId: state.deploymentId,
		origin,
		state,
		syntheticRunId: state.loadRunId,
		token: tokens.TINYBIRD_STAGING_READ_TOKEN,
	});
	assertRepresentativeEndpointCoverage({
		dimensionBucketCount: state.loadDimensionBucketCount,
		expectedEvents: state.loadEventCount,
		payloads: representativeCoverage.payloads,
	});
	const largeCoverage = await queryDecisionEndpointSuite({
		deploymentId: state.deploymentId,
		origin,
		state,
		syntheticRunId: state.largeLoadRunId,
		token: tokens.TINYBIRD_STAGING_READ_TOKEN,
	});
	assertRepresentativeEndpointCoverage({
		dimensionBucketCount: state.largeLoadDimensionBucketCount,
		expectedEvents: state.largeLoadEventCount,
		payloads: largeCoverage.payloads,
	});
	const baselineSamples = Object.fromEntries(
		baselineQueries.map(({ name }) => [name, []]),
	);
	const measuredSamples = Object.fromEntries(
		measuredQueries.map(({ name }) => [name, []]),
	);
	const representativeSamples = Object.fromEntries(
		representativeQueries.map(({ name }) => [name, []]),
	);
	const largeSamples = Object.fromEntries(
		largeQueries.map(({ name }) => [name, []]),
	);
	const baselineFanoutSamples = [];
	const measuredFanoutSamples = [];
	const representativeFanoutSamples = [];
	const largeFanoutSamples = [];
	const sampleDecisionRound = async (
		queries,
		endpointSamples,
		fanoutSamples,
	) => {
		const startedAt = performance.now();
		const results = await Promise.all(
			queries.map((query) =>
				decisionEndpointQuery({
					origin,
					token: tokens.TINYBIRD_STAGING_READ_TOKEN,
					...query,
				}),
			),
		);
		fanoutSamples.push(Math.round(performance.now() - startedAt));
		for (let index = 0; index < results.length; index += 1) {
			endpointSamples[queries[index].name].push(results[index].latencyMs);
		}
	};
	const samplingWorkloads = [
		{
			queries: measuredQueries,
			samples: measuredSamples,
			fanout: measuredFanoutSamples,
		},
		{
			queries: representativeQueries,
			samples: representativeSamples,
			fanout: representativeFanoutSamples,
		},
		{
			queries: largeQueries,
			samples: largeSamples,
			fanout: largeFanoutSamples,
		},
	];
	if (hasIndependentBaseline) {
		samplingWorkloads.push({
			queries: baselineQueries,
			samples: baselineSamples,
			fanout: baselineFanoutSamples,
		});
	}
	for (let round = 0; round < 30; round += 1) {
		for (let offset = 0; offset < samplingWorkloads.length; offset += 1) {
			const workload =
				samplingWorkloads[(round + offset) % samplingWorkloads.length];
			await sampleDecisionRound(
				workload.queries,
				workload.samples,
				workload.fanout,
			);
		}
	}
	const regressionFactor = Number(process.env.ENDPOINT_REGRESSION_FACTOR ?? 2);
	const regressionFloorMs = Number(
		process.env.ENDPOINT_REGRESSION_FLOOR_MS ?? 250,
	);
	const decisionEndpointLatency = Object.fromEntries(
		measuredQueries.map(({ name }) => {
			const measured = latencySummary(measuredSamples[name]);
			const representative = latencySummary(representativeSamples[name]);
			const large = latencySummary(largeSamples[name]);
			const largeBudget = {
				absoluteP95Ms: endpointP95BudgetMs,
				maximumRepresentativeFactor: 2,
				passed:
					large.p95Ms <= endpointP95BudgetMs &&
					large.p95Ms <= Math.max(representative.p95Ms * 2, 250),
			};
			if (!baselineSamples[name]) {
				const noBaselineMode = hasIndependentBaseline
					? "endpoint_unavailable_on_baseline"
					: "absolute_only_no_independent_baseline";
				return [
					name,
					{
						baseline: null,
						measured,
						representative,
						large,
						budget: {
							mode: noBaselineMode,
							absoluteP95Ms: endpointP95BudgetMs,
							passed: measured.p95Ms <= endpointP95BudgetMs,
						},
						representativeBudget: {
							mode: noBaselineMode,
							absoluteP95Ms: endpointP95BudgetMs,
							passed: representative.p95Ms <= endpointP95BudgetMs,
						},
						largeBudget,
					},
				];
			}
			const baseline = latencySummary(baselineSamples[name]);
			return [
				name,
				{
					baseline,
					measured,
					representative,
					large,
					budget: evaluateLatencyBudget({
						baseline,
						measured,
						absoluteP95Ms: endpointP95BudgetMs,
						regressionFactor,
						regressionFloorMs,
					}),
					representativeBudget: evaluateLatencyBudget({
						baseline,
						measured: representative,
						absoluteP95Ms: endpointP95BudgetMs,
						regressionFactor,
						regressionFloorMs,
					}),
					largeBudget,
				},
			];
		}),
	);
	const fanoutP95BudgetMs = Number(
		process.env.DASHBOARD_FANOUT_P95_BUDGET_MS ?? 3_500,
	);
	const dashboardBaseline = hasIndependentBaseline
		? latencySummary(baselineFanoutSamples)
		: null;
	const dashboardMeasured = latencySummary(measuredFanoutSamples);
	const dashboardRepresentative = latencySummary(representativeFanoutSamples);
	const dashboardLarge = latencySummary(largeFanoutSamples);
	const dashboardBudget = dashboardBaseline
		? evaluateLatencyBudget({
				baseline: dashboardBaseline,
				measured: dashboardMeasured,
				absoluteP95Ms: fanoutP95BudgetMs,
				regressionFactor,
				regressionFloorMs,
			})
		: {
				mode: "absolute_only_no_independent_baseline",
				absoluteP95Ms: fanoutP95BudgetMs,
				passed: dashboardMeasured.p95Ms <= fanoutP95BudgetMs,
			};
	const dashboardRepresentativeBudget = dashboardBaseline
		? evaluateLatencyBudget({
				baseline: dashboardBaseline,
				measured: dashboardRepresentative,
				absoluteP95Ms: fanoutP95BudgetMs,
				regressionFactor,
				regressionFloorMs,
			})
		: {
				mode: "absolute_only_no_independent_baseline",
				absoluteP95Ms: fanoutP95BudgetMs,
				passed: dashboardRepresentative.p95Ms <= fanoutP95BudgetMs,
			};
	const dashboardLargeBudget = {
		absoluteP95Ms: fanoutP95BudgetMs,
		maximumRepresentativeFactor: 2,
		passed:
			dashboardLarge.p95Ms <= fanoutP95BudgetMs &&
			dashboardLarge.p95Ms <= Math.max(dashboardRepresentative.p95Ms * 2, 500),
	};
	const failedDecisionEndpoints = Object.entries(decisionEndpointLatency)
		.filter(
			([, value]) =>
				!value.budget.passed ||
				!value.representativeBudget.passed ||
				!value.largeBudget.passed,
		)
		.map(([name]) => name);
	artifact.health = health;
	artifact.decisionAssertions = decisionAssertions;
	artifact.load.health = loadHealth;
	artifact.load.decisionAssertions = loadDecisionAssertions;
	artifact.largeLoad.health = largeLoadHealth;
	artifact.largeLoad.decisionAssertions = largeLoadDecisionAssertions;
	const currentVisibilityMs = Date.now() - Date.parse(state.startedAt);
	artifact.visibilityMs = Math.min(
		artifact.visibilityMs ?? currentVisibilityMs,
		currentVisibilityMs,
	);
	artifact.endpointLatency = endpointLatency;
	artifact.decisionEndpointLatency = decisionEndpointLatency;
	artifact.performanceBaseline = {
		deploymentId: hasIndependentBaseline ? baselineDeploymentId : null,
		mode: hasIndependentBaseline
			? "retained_deployment"
			: "absolute_only_no_independent_baseline",
		representativeRows: state.loadEventCount,
		largeRows: state.largeLoadEventCount,
		newEndpointsWithoutBaseline: excludedBaselineEndpoints,
		representativeCoverageLatencyMs: representativeCoverage.latencyMs,
		largeCoverageLatencyMs: largeCoverage.latencyMs,
	};
	artifact.dashboardFanoutLatency = {
		baseline: dashboardBaseline,
		measured: dashboardMeasured,
		representative: dashboardRepresentative,
		large: dashboardLarge,
		budget: dashboardBudget,
		representativeBudget: dashboardRepresentativeBudget,
		largeBudget: dashboardLargeBudget,
	};
	const ingestionSloMs = Number(process.env.INGESTION_SLO_MS ?? 180_000);
	const ingestionSloPassed = artifact.visibilityMs <= ingestionSloMs;
	const endpointBudgetPassed = endpointLatency.p95Ms <= endpointP95BudgetMs;
	const decisionEndpointBudgetsPassed =
		failedDecisionEndpoints.length === 0 &&
		dashboardBudget.passed &&
		dashboardRepresentativeBudget.passed &&
		dashboardLargeBudget.passed;
	artifact.budgets = {
		ingestionVisibilityMs: ingestionSloMs,
		endpointP95Ms: endpointP95BudgetMs,
		dashboardFanoutP95Ms: fanoutP95BudgetMs,
		regressionFactor,
		regressionFloorMs,
	};
	artifact.assertions = {
		...artifact.assertions,
		duplicateVisible: true,
		payloadConflictVisible: true,
		decisionDeduplicationPassed: true,
		payloadConflictQuarantinePassed: true,
		concurrentDuplicateDeliveryPassed: true,
		separateBatchConflictDeliveryPassed: true,
		ingestionSloPassed,
		endpointBudgetPassed,
		decisionEndpointBudgetsPassed,
		representativePerformancePassed: decisionEndpointBudgetsPassed,
	};
	writeJson(artifactPath, artifact);
	if (!ingestionSloPassed) {
		throw new Error(
			`Synthetic events became visible in ${artifact.visibilityMs}ms, over ${ingestionSloMs}ms`,
		);
	}
	if (!endpointBudgetPassed) {
		throw new Error(
			`Tinybird health p95 was ${endpointLatency.p95Ms}ms, over ${endpointP95BudgetMs}ms`,
		);
	}
	if (!decisionEndpointBudgetsPassed) {
		throw new Error(
			`Tinybird decision endpoint budgets failed: ${[
				...failedDecisionEndpoints,
				...(dashboardBudget.passed &&
				dashboardRepresentative.p95Ms <= fanoutP95BudgetMs
					? []
					: ["dashboard_fanout"]),
			].join(", ")}`,
		);
	}
};

const deleteProductEventRows = async ({
	origin,
	token,
	condition,
	deploymentParameters = {},
	beforeAttempt,
}) => {
	const body = new URLSearchParams({ delete_condition: condition });
	const deletion = await request(
		tinybirdUrl(origin, "/v0/datasources/product_events_v1/delete", {
			...deploymentParameters,
		}),
		{
			token,
			method: "POST",
			body,
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			attempts: 3,
			beforeAttempt,
		},
	);
	const jobId =
		deletion.data.job_id ?? deletion.data.job?.id ?? deletion.data.id;
	if (!jobId) {
		throw new Error("Tinybird deletion did not return a cleanup job ID");
	}
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		const job = await request(
			tinybirdUrl(origin, `/v0/jobs/${encodeURIComponent(jobId)}`, {
				...deploymentParameters,
			}),
			{ token, attempts: 3, beforeAttempt },
		);
		const status = String(
			job.data.status ?? job.data.state ?? job.data.job?.status ?? "",
		).toLowerCase();
		if (["done", "success", "finished", "completed"].includes(status)) {
			return Number(job.data.rows_affected ?? 0);
		}
		if (["failed", "error", "cancelled"].includes(status)) {
			throw new Error(`Tinybird cleanup job ended in ${status}`);
		}
		await delay(2_000);
	}
	throw new Error("Timed out waiting for Tinybird synthetic cleanup");
};

const eraseSyntheticIdentity = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	const artifact = readJson(artifactPath);
	const secret = environment("CAP_ANALYTICS_STAGING_TEST_SECRET");
	const url = new URL(
		"/api/analytics/staging-test/erase",
		artifactPreviewUrl(artifact),
	);
	const body = JSON.stringify({ runId: state.runId, sha: artifact.sha });
	const send = (authorization) =>
		previewRequest(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(authorization ? { Authorization: authorization } : {}),
			},
			body,
			signal: AbortSignal.timeout(300_000),
		});
	const unauthorized = await send();
	if (unauthorized.status !== 401) {
		throw new Error(
			`The deployed erasure path accepted missing authorization with HTTP ${unauthorized.status}`,
		);
	}
	const startedAt = performance.now();
	const response = await send(`Bearer ${secret}`);
	if (!response.ok) {
		throw new Error(
			`The deployed erasure path failed with HTTP ${response.status}`,
		);
	}
	const result = await response.json();
	if (result.erased !== true) {
		throw new Error("The deployed erasure path returned incomplete proof");
	}
	state.erasureApplicationPath = true;
	writeJson(option("state"), state, 0o600);
	artifact.erasure = {
		...artifact.erasure,
		applicationPath: true,
		unauthorizedRejected: true,
		durationMs: Math.round(performance.now() - startedAt),
		deleteJobCompleted: true,
	};
	writeJson(artifactPath, artifact);
};

const verifySyntheticIdentityErasure = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	const artifact = readJson(artifactPath);
	if (state.erasureApplicationPath !== true) {
		throw new Error("The deployed application erasure path did not complete");
	}
	const erasedHealth = normalizeHealth(
		(await healthQuery({ state, deploymentId: state.deploymentId })).data,
	);
	const erasedLoadHealth = normalizeHealth(
		(
			await healthQuery({
				state,
				deploymentId: state.deploymentId,
				appVersion: state.loadAppVersion,
			})
		).data,
	);
	const erasedLargeLoadHealth = normalizeHealth(
		(
			await healthQuery({
				state,
				deploymentId: state.deploymentId,
				appVersion: state.largeLoadAppVersion,
			})
		).data,
	);
	const erasedDecisions = normalizeCiAssertions(
		(
			await ciAssertionsQuery({
				state,
				deploymentId: state.deploymentId,
			})
		).data,
	);
	const erasedBusinessDecisions = normalizeCiAssertions(
		(
			await ciAssertionsQuery({
				state,
				deploymentId: state.deploymentId,
				syntheticRunId: state.decisionRunId,
			})
		).data,
	);
	const previewHealth = normalizeHealth(
		(
			await healthQuery({
				state,
				deploymentId: state.deploymentId,
				appVersion: state.previewAppVersion,
			})
		).data,
	);
	const previewDecisions = normalizeCiAssertions(
		(
			await ciAssertionsQuery({
				state,
				deploymentId: state.deploymentId,
				syntheticRunId: state.previewRunId,
			})
		).data,
	);
	const serverDecisions = normalizeCiAssertions(
		(
			await ciAssertionsQuery({
				state,
				deploymentId: state.deploymentId,
				syntheticRunId: state.serverRunId,
			})
		).data,
	);
	if (
		Object.values(erasedHealth).some((value) => value !== 0) ||
		Object.values(erasedDecisions).some((value) => value !== 0)
	) {
		throw new Error(
			"Synthetic identity erasure left raw-health or decision-facing state",
		);
	}
	assertSyntheticLoadHealth(erasedLoadHealth, state.loadEventCount);
	assertSyntheticLoadHealth(erasedLargeLoadHealth, state.largeLoadEventCount);
	for (const [syntheticRunId, expectedEvents] of [
		[state.loadRunId, state.loadEventCount],
		[state.largeLoadRunId, state.largeLoadEventCount],
	]) {
		const decisions = normalizeCiAssertions(
			(
				await ciAssertionsQuery({
					state,
					deploymentId: state.deploymentId,
					syntheticRunId,
				})
			).data,
		);
		assertSyntheticLoadDecisions(decisions, expectedEvents);
	}
	const expectedRemainingBusiness = {
		receivedRows: 2,
		uniqueEvents: 2,
		uniquePayloads: 2,
		duplicateRows: 0,
		payloadConflicts: 0,
		canonicalEvents: 2,
		decisionEvents: 2,
		decisionRevenueMinor: 0,
		trafficVisitors: 1,
		trafficVisits: 1,
		trafficPageviews: 1,
		trafficBounces: 1,
		trafficDurationMs: 0,
		pageVisitors: 1,
		pageVisits: 1,
		pageviews: 1,
		pageLandings: 1,
		pageExits: 1,
		pageEngagedMs: 0,
		pageScrollDepth: 0,
		activationSignups: 0,
		activatedCreators: 0,
		retentionCreators: 0,
		retentionOrganizations: 0,
		identityLinkedVisitors: 0,
		identityLinkedUsers: 0,
		identitySignupUsers: 0,
		identityOrganizations: 0,
		identityGuestCheckoutVisitors: 1,
		identityGuestPurchasers: 0,
		identityAuthenticatedCheckoutUsers: 0,
		identityWebCheckoutUsers: 0,
		identityDesktopCheckoutUsers: 0,
		identityMobileCheckoutUsers: 0,
		identityCrossDeviceCheckoutUsers: 0,
		identityTrialUsers: 0,
		identityPurchasers: 0,
	};
	for (const [name, expected] of Object.entries(expectedRemainingBusiness)) {
		if (erasedBusinessDecisions[name] !== expected) {
			throw new Error(
				`Scoped erasure left ${name}=${erasedBusinessDecisions[name]}, expected ${expected}`,
			);
		}
	}
	assertSingleHealth(previewHealth);
	if (
		previewDecisions.canonicalEvents !== state.previewExpectedEvents ||
		previewDecisions.decisionEvents !== state.previewExpectedEvents
	) {
		throw new Error(
			"Synthetic identity erasure corrupted the unrelated preview control",
		);
	}
	if (
		serverDecisions.receivedRows < state.serverExpectedRows ||
		serverDecisions.uniqueEvents !== state.serverExpectedEvents ||
		serverDecisions.canonicalEvents !== state.serverExpectedEvents ||
		serverDecisions.decisionEvents !== state.serverExpectedEvents ||
		serverDecisions.decisionRevenueMinor !== 2_500 ||
		serverDecisions.activationSignups !== 1 ||
		serverDecisions.activatedCreators !== 1
	) {
		throw new Error(
			"Synthetic identity erasure corrupted the durable server control",
		);
	}
	const controlHealth = normalizeHealth(
		(
			await healthQuery({
				state,
				deploymentId: state.deploymentId,
				appVersion: state.erasureControlAppVersion,
			})
		).data,
	);
	if (
		controlHealth.uniqueEvents !== 1 ||
		controlHealth.uniquePayloads !== 1 ||
		controlHealth.receivedRows < 1 ||
		controlHealth.payloadConflicts !== 0
	) {
		throw new Error(
			"Synthetic identity erasure removed or corrupted the out-of-scope control",
		);
	}
	artifact.erasure = {
		...artifact.erasure,
		erasedHealth,
		erasedLoadHealth,
		erasedLargeLoadHealth,
		erasedDecisions,
		erasedBusinessDecisions,
		previewHealth,
		previewDecisions,
		serverDecisions,
		controlHealth,
		passed: true,
	};
	artifact.assertions = {
		...artifact.assertions,
		identityErasurePassed: true,
		erasureScopeControlPassed: true,
	};
	writeJson(artifactPath, artifact);
};

const cleanup = async (parameters = {}) => {
	const state = parameters.state ?? readJson(option("state"));
	const artifactPath = parameters.artifactPath ?? option("artifact");
	const requestedTarget = parameters.target ?? option("target");
	const deploymentId = parameters.deploymentId ?? option("deployment-id");
	if (!["live", "staging"].includes(requestedTarget)) {
		throw new Error("Tinybird cleanup target is invalid");
	}
	if (String(state.deploymentId) !== deploymentId) {
		throw new Error("Tinybird cleanup does not match the seeded deployment");
	}
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_CLEANUP_TOKEN",
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
		"TINYBIRD_STAGING_READ_TOKEN",
	]);
	let target = await waitForOwnedMutationTarget({
		state,
		origin,
		token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
	});
	if (target !== requestedTarget) {
		throw new Error("Tinybird cleanup target changed before scoped cleanup");
	}
	validateSyntheticRunId(state.runId);
	validateSyntheticRunId(state.cutoffRunId);
	validateSyntheticRunId(state.loadRunId);
	validateSyntheticRunId(state.largeLoadRunId);
	validateSyntheticRunId(state.decisionRunId);
	validateSyntheticRunId(state.erasureControlRunId);
	const serverRunId = validateSyntheticRunId(
		state.serverRunId ?? `${state.runId}_server`,
	);
	const runIds = [
		state.runId,
		state.cutoffRunId,
		state.loadRunId,
		state.largeLoadRunId,
		state.decisionRunId,
		state.erasureControlRunId,
	];
	if (state.previewRunId) {
		runIds.push(validateSyntheticRunId(state.previewRunId));
	}
	runIds.push(serverRunId);
	{
		const databaseArtifact = readJson(artifactPath);
		const anonymousIdentityHashes = [
			state.browserAnonymousIdentityHash,
			state.previewAnonymousIdentityHash,
		].filter(
			(identityHash) =>
				typeof identityHash === "string" && /^[0-9a-f]{64}$/.test(identityHash),
		);
		const databaseCleanup = await cleanupPreviewDatabaseState({
			anonymousIdentityHashes,
			artifact: databaseArtifact,
			runIds: [state.runId, serverRunId],
			secret: environment("CAP_ANALYTICS_STAGING_TEST_SECRET"),
		});
		databaseArtifact.cleanup = {
			...databaseArtifact.cleanup,
			database: databaseCleanup,
		};
		databaseArtifact.assertions = {
			...databaseArtifact.assertions,
			syntheticDatabaseCleanupPassed: true,
		};
		writeJson(artifactPath, databaseArtifact);
	}
	if (target === "staging") {
		const assertStagingLeakCleanupOwnership = async () => {
			if (
				(await ownedMutationTarget({
					state,
					origin,
					token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
				})) !== "staging"
			) {
				throw new Error("The staged Tinybird cleanup candidate changed");
			}
			const deployments = await deploymentList({
				origin,
				token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
			});
			if (
				createDeploymentBoundary(deployments.data).liveDeploymentId !==
				String(state.liveBeforeDeploymentId)
			) {
				throw new Error("The staged Tinybird cleanup live deployment changed");
			}
		};
		const rowsAffected = await deleteProductEventRows({
			origin,
			token: tokens.TINYBIRD_STAGING_CLEANUP_TOKEN,
			condition: `synthetic_run_id IN (${runIds.map((runId) => `'${runId}'`).join(", ")})`,
			beforeAttempt: assertStagingLeakCleanupOwnership,
		});
		const liveDeploymentId = String(state.liveBeforeDeploymentId);
		await waitForCopyVisibility({
			label: "Tinybird staged-write live cleanup",
			read: () =>
				Promise.all(
					runIds.flatMap((syntheticRunId) => [
						ciAssertionsQuery({ state, syntheticRunId }),
						ciAssertionsQuery({
							state,
							deploymentId: liveDeploymentId,
							syntheticRunId,
						}),
					]),
				),
			assert: (results) => {
				for (const result of results) {
					assertZeroCiAssertions(
						normalizeCiAssertions(result.data),
						"Live Tinybird cleanup",
					);
				}
			},
		});
		writeOutput("target", target);
		writeOutput("requires_copies", "false");
		writeOutput("requires_discard", "true");
		const artifact = readJson(artifactPath);
		artifact.cleanup = {
			...artifact.cleanup,
			strategy: "deployment_discard",
			candidateDiscarded: false,
			liveSyntheticRowsDeleted: true,
			rowsAffected,
		};
		writeJson(artifactPath, artifact);
		return;
	}
	let rowsAffected;
	for (
		let transitionAttempt = 0;
		transitionAttempt < 2;
		transitionAttempt += 1
	) {
		const deploymentParameters = dataMutationDeploymentParameters({
			target,
			deploymentId,
			expectedDeploymentId: String(state.deploymentId),
		});
		const assertMutationOwnership = async () => {
			if (
				(await ownedMutationTarget({
					state,
					origin,
					token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
				})) !== target
			) {
				throw new Error("The owned Tinybird cleanup target changed");
			}
		};
		try {
			rowsAffected = await deleteProductEventRows({
				origin,
				token: tokens.TINYBIRD_STAGING_CLEANUP_TOKEN,
				condition: `synthetic_run_id IN (${runIds.map((runId) => `'${runId}'`).join(", ")})`,
				deploymentParameters,
				beforeAttempt: assertMutationOwnership,
			});
			break;
		} catch (error) {
			if (target === "staging") {
				const resolvedTarget = await waitForOwnedMutationTarget({
					state,
					origin,
					token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
				});
				const nextTarget = reconcileCleanupTarget(target, resolvedTarget);
				if (nextTarget !== target) {
					target = nextTarget;
					continue;
				}
			}
			throw error;
		}
	}
	if (rowsAffected === undefined) {
		throw new Error("Tinybird cleanup changed target more than once");
	}
	writeOutput("target", target);
	writeOutput("requires_copies", "true");
	writeOutput("requires_discard", "false");
	const artifact = readJson(artifactPath);
	artifact.cleanup = {
		...artifact.cleanup,
		deleteJobCompleted: true,
		rowsAffected,
	};
	writeJson(artifactPath, artifact);
};

const verifyPromoted = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	const artifact = readJson(artifactPath);
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_READ_TOKEN",
	]);
	if (
		!state.previewAppVersion ||
		!state.previewAcceptedRows ||
		!state.previewRunId
	) {
		throw new Error("The exact-SHA preview probe did not complete");
	}
	const previewHealthResult = await healthQuery({
		state,
		deploymentId: state.deploymentId,
		appVersion: state.previewAppVersion,
	});
	const previewHealth = normalizeHealth(previewHealthResult.data);
	if (
		previewHealth.receivedRows < state.previewAcceptedRows ||
		previewHealth.uniqueEvents !== 1 ||
		previewHealth.uniquePayloads !== 1 ||
		previewHealth.payloadConflicts !== 0 ||
		previewHealth.duplicateRows !== previewHealth.receivedRows - 1
	) {
		throw new Error(
			"The promoted health snapshot did not preserve preview retry deliveries",
		);
	}
	const seedDecisionResult = await ciAssertionsQuery({
		state,
		deploymentId: state.deploymentId,
	});
	const seedDecisionAssertions = normalizeCiAssertions(seedDecisionResult.data);
	assertSyntheticDecisions(seedDecisionAssertions);
	const previewDecisionResult = await ciAssertionsQuery({
		state,
		deploymentId: state.deploymentId,
		syntheticRunId: state.previewRunId,
	});
	const previewDecisionAssertions = normalizeCiAssertions(
		previewDecisionResult.data,
	);
	if (
		previewDecisionAssertions.receivedRows < state.previewAcceptedRows ||
		previewDecisionAssertions.uniqueEvents !== state.previewExpectedEvents ||
		previewDecisionAssertions.uniquePayloads !== state.previewExpectedEvents ||
		previewDecisionAssertions.duplicateRows !==
			previewDecisionAssertions.receivedRows - state.previewExpectedEvents ||
		previewDecisionAssertions.payloadConflicts !== 0 ||
		previewDecisionAssertions.canonicalEvents !== state.previewExpectedEvents ||
		previewDecisionAssertions.decisionEvents !== state.previewExpectedEvents
	) {
		throw new Error(
			"The promoted preview run did not preserve exact retry-deduplicated decisions",
		);
	}
	if (!state.serverRunId || state.serverExpectedEvents !== 4) {
		throw new Error("The exact-SHA durable server probe did not complete");
	}
	const serverDecisionAssertions = normalizeCiAssertions(
		(
			await ciAssertionsQuery({
				state,
				deploymentId: state.deploymentId,
				syntheticRunId: state.serverRunId,
			})
		).data,
	);
	if (
		serverDecisionAssertions.receivedRows < state.serverExpectedRows ||
		serverDecisionAssertions.uniqueEvents !== state.serverExpectedEvents ||
		serverDecisionAssertions.uniquePayloads !== state.serverExpectedEvents ||
		serverDecisionAssertions.duplicateRows !==
			serverDecisionAssertions.receivedRows - state.serverExpectedEvents ||
		serverDecisionAssertions.payloadConflicts !== 0 ||
		serverDecisionAssertions.canonicalEvents !== state.serverExpectedEvents ||
		serverDecisionAssertions.decisionEvents !== state.serverExpectedEvents ||
		serverDecisionAssertions.decisionRevenueMinor !== 2_500 ||
		serverDecisionAssertions.activationSignups !== 1 ||
		serverDecisionAssertions.activatedCreators !== 1
	) {
		throw new Error(
			"The exact-SHA durable server path did not produce deduplicated business decisions",
		);
	}
	const businessDecisionResult = await ciAssertionsQuery({
		state,
		deploymentId: state.deploymentId,
		syntheticRunId: state.decisionRunId,
	});
	const businessDecisionAssertions = normalizeCiAssertions(
		businessDecisionResult.data,
	);
	assertSyntheticLoadHealth(
		businessDecisionAssertions,
		state.decisionEventCount,
	);
	if (
		businessDecisionAssertions.canonicalEvents !== state.decisionEventCount ||
		businessDecisionAssertions.decisionEvents !== state.decisionEventCount
	) {
		throw new Error(
			"The promoted decision fixture was not exactly deduplicated before materialization",
		);
	}
	assertSyntheticBusinessDecisions(businessDecisionAssertions);
	const businessEndpointSuite = await queryDecisionEndpointSuite({
		deploymentId: state.deploymentId,
		origin,
		state,
		syntheticRunId: state.decisionRunId,
		token: tokens.TINYBIRD_STAGING_READ_TOKEN,
	});
	assertSyntheticEndpointDecisions({
		appVersion: state.decisionAppVersion,
		date: state.decisionDate,
		hostname: state.decisionHostname,
		pathname: state.decisionPathname,
		payloads: businessEndpointSuite.payloads,
	});
	const monetizationFilterSuite = await querySyntheticMonetizationFilters({
		deploymentId: state.deploymentId,
		origin,
		state,
		token: tokens.TINYBIRD_STAGING_READ_TOKEN,
	});
	const identityFilterSuite = await querySyntheticIdentityFilters({
		deploymentId: state.deploymentId,
		origin,
		state,
		token: tokens.TINYBIRD_STAGING_READ_TOKEN,
	});
	const syntheticEndpointParameters = {
		start_date: state.startTime.slice(0, 10),
		end_date: state.endTime.slice(0, 10),
		hostname: state.decisionHostname,
		__tb__deployment: state.deploymentId,
	};
	const [trafficExclusion, pageExclusion] = await Promise.all([
		decisionEndpointQuery({
			origin,
			token: tokens.TINYBIRD_STAGING_READ_TOKEN,
			name: "product_traffic_overview",
			parameters: syntheticEndpointParameters,
		}),
		decisionEndpointQuery({
			origin,
			token: tokens.TINYBIRD_STAGING_READ_TOKEN,
			name: "product_traffic_pages",
			parameters: syntheticEndpointParameters,
		}),
	]);
	const trafficRows = trafficExclusion.data?.data;
	const pageRows = pageExclusion.data?.data;
	if (
		!Array.isArray(trafficRows) ||
		!Array.isArray(pageRows) ||
		trafficRows.length !== 0 ||
		pageRows.length !== 0
	) {
		throw new Error(
			"Synthetic decision rows leaked into normal traffic endpoints",
		);
	}
	artifact.previewApi.health = previewHealth;
	artifact.previewApi.decisionAssertions = {
		seed: seedDecisionAssertions,
		preview: previewDecisionAssertions,
	};
	artifact.previewApi.endpointLatencyMs = previewHealthResult.latencyMs;
	artifact.businessDecisions = {
		canonicalEvents: businessDecisionAssertions.canonicalEvents,
		decisionEvents: businessDecisionAssertions.decisionEvents,
		traffic: {
			visitors: businessDecisionAssertions.trafficVisitors,
			visits: businessDecisionAssertions.trafficVisits,
			pageviews: businessDecisionAssertions.trafficPageviews,
			bounces: businessDecisionAssertions.trafficBounces,
			durationMs: businessDecisionAssertions.trafficDurationMs,
		},
		pages: {
			visitors: businessDecisionAssertions.pageVisitors,
			visits: businessDecisionAssertions.pageVisits,
			pageviews: businessDecisionAssertions.pageviews,
			landings: businessDecisionAssertions.pageLandings,
			exits: businessDecisionAssertions.pageExits,
			engagedMs: businessDecisionAssertions.pageEngagedMs,
			scrollDepth: businessDecisionAssertions.pageScrollDepth,
		},
		activation: {
			signups: businessDecisionAssertions.activationSignups,
			activatedCreators: businessDecisionAssertions.activatedCreators,
		},
		retention: {
			creators: businessDecisionAssertions.retentionCreators,
			organizations: businessDecisionAssertions.retentionOrganizations,
		},
		identity: {
			linkedVisitors: businessDecisionAssertions.identityLinkedVisitors,
			linkedUsers: businessDecisionAssertions.identityLinkedUsers,
			organizations: businessDecisionAssertions.identityOrganizations,
			guestCheckoutVisitors:
				businessDecisionAssertions.identityGuestCheckoutVisitors,
			guestPurchasers: businessDecisionAssertions.identityGuestPurchasers,
			purchasers: businessDecisionAssertions.identityPurchasers,
		},
		revenueMinor: businessDecisionAssertions.decisionRevenueMinor,
		identityFilterLatencyMs: identityFilterSuite.latencyMs,
		monetizationFilterLatencyMs: monetizationFilterSuite.latencyMs,
		normalTrafficExcluded: true,
		endpointLatencyMs: businessEndpointSuite.latencyMs,
		exclusionLatencyMs: {
			overview: trafficExclusion.latencyMs,
			pages: pageExclusion.latencyMs,
		},
	};
	artifact.serverDelivery.decisionAssertions = {
		canonicalEvents: serverDecisionAssertions.canonicalEvents,
		decisionEvents: serverDecisionAssertions.decisionEvents,
		duplicateRows: serverDecisionAssertions.duplicateRows,
		revenueMinor: serverDecisionAssertions.decisionRevenueMinor,
		activationSignups: serverDecisionAssertions.activationSignups,
		activatedCreators: serverDecisionAssertions.activatedCreators,
	};
	artifact.assertions.promotedPreviewDataPassed = true;
	artifact.assertions.promotedBusinessDecisionsPassed = true;
	artifact.assertions.syntheticDecisionExclusionPassed = true;
	writeJson(artifactPath, artifact);
};

const verifyCleanup = async (parameters = {}) => {
	const state =
		parameters.state ?? readJson(parameters.statePath ?? option("state"));
	const artifactPath = parameters.artifactPath ?? option("artifact");
	const artifact = readJson(artifactPath);
	const target = parameters.target ?? option("target");
	if (!["live", "staging"].includes(target)) {
		throw new Error("Tinybird cleanup verification target is invalid");
	}
	const requestedDeploymentId =
		parameters.deploymentId ?? option("deployment-id");
	if (String(state.deploymentId) !== requestedDeploymentId) {
		throw new Error(
			"Tinybird cleanup deployment does not match the seeded run",
		);
	}
	const deploymentId = state.deploymentId;
	const result = await healthQuery({ state, deploymentId });
	const health = normalizeHealth(result.data);
	if (Object.values(health).some((value) => value !== 0)) {
		throw new Error(
			"Synthetic rows still affect Tinybird health after cleanup",
		);
	}
	const decisionResult = await ciAssertionsQuery({ state, deploymentId });
	const decisionAssertions = normalizeCiAssertions(decisionResult.data);
	if (Object.values(decisionAssertions).some((value) => value !== 0)) {
		throw new Error(
			"Synthetic rows still affect Tinybird decision assertions after cleanup",
		);
	}
	const businessDecisionResult = await ciAssertionsQuery({
		state,
		deploymentId,
		syntheticRunId: state.decisionRunId,
	});
	const businessDecisionAssertions = normalizeCiAssertions(
		businessDecisionResult.data,
	);
	if (Object.values(businessDecisionAssertions).some((value) => value !== 0)) {
		throw new Error(
			"Synthetic business rows still affect decisions after cleanup",
		);
	}
	const loadResult = await healthQuery({
		state,
		deploymentId,
		appVersion: state.loadAppVersion,
	});
	const loadHealth = normalizeHealth(loadResult.data);
	if (Object.values(loadHealth).some((value) => value !== 0)) {
		throw new Error(
			"Synthetic load rows still affect Tinybird health after cleanup",
		);
	}
	for (const syntheticRunId of [
		state.cutoffRunId,
		state.loadRunId,
		state.largeLoadRunId,
	]) {
		const decisions = normalizeCiAssertions(
			(await ciAssertionsQuery({ state, deploymentId, syntheticRunId })).data,
		);
		if (Object.values(decisions).some((value) => value !== 0)) {
			throw new Error(
				"Synthetic scoped rows still affect Tinybird decisions after cleanup",
			);
		}
	}
	const cutoffResult = await healthQuery({
		state,
		deploymentId,
		appVersion: state.cutoffAppVersion,
	});
	const cutoffHealth = normalizeHealth(cutoffResult.data);
	if (Object.values(cutoffHealth).some((value) => value !== 0)) {
		throw new Error(
			"Post-cutoff rows still affect Tinybird health after cleanup",
		);
	}
	const largeLoadResult = await healthQuery({
		state,
		deploymentId,
		appVersion: state.largeLoadAppVersion,
	});
	const largeLoadHealth = normalizeHealth(largeLoadResult.data);
	if (Object.values(largeLoadHealth).some((value) => value !== 0)) {
		throw new Error(
			"Large synthetic load rows still affect Tinybird health after cleanup",
		);
	}
	const controlResult = await healthQuery({
		state,
		deploymentId,
		appVersion: state.erasureControlAppVersion,
	});
	const controlHealth = normalizeHealth(controlResult.data);
	if (Object.values(controlHealth).some((value) => value !== 0)) {
		throw new Error(
			"Synthetic erasure control rows still affect Tinybird health after cleanup",
		);
	}
	if (state.previewAppVersion && state.previewRunId) {
		const previewResult = await healthQuery({
			state,
			deploymentId,
			appVersion: state.previewAppVersion,
		});
		const previewHealth = normalizeHealth(previewResult.data);
		if (Object.values(previewHealth).some((value) => value !== 0)) {
			throw new Error(
				"Synthetic preview rows still affect Tinybird health after cleanup",
			);
		}
		const previewDecisionResult = await ciAssertionsQuery({
			state,
			deploymentId,
			syntheticRunId: state.previewRunId,
		});
		const previewDecisionAssertions = normalizeCiAssertions(
			previewDecisionResult.data,
		);
		if (Object.values(previewDecisionAssertions).some((value) => value !== 0)) {
			throw new Error(
				"Synthetic preview rows still affect decisions after cleanup",
			);
		}
	}
	if (state.serverRunId) {
		const serverDecisionAssertions = normalizeCiAssertions(
			(
				await ciAssertionsQuery({
					state,
					deploymentId,
					syntheticRunId: state.serverRunId,
				})
			).data,
		);
		if (Object.values(serverDecisionAssertions).some((value) => value !== 0)) {
			throw new Error(
				"Synthetic server rows still affect decisions after cleanup",
			);
		}
	}
	artifact.cleanup = {
		...artifact.cleanup,
		businessDecisionAssertions,
		passed: true,
		verifiedAt: new Date().toISOString(),
	};
	artifact.assertions = { ...artifact.assertions, cleanupPassed: true };
	writeJson(artifactPath, artifact);
};

const tokenScopeProbe = (url, token, init = {}) =>
	fetch(url, {
		...init,
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
			...init.headers,
		},
		signal: AbortSignal.timeout(15_000),
	});

const assertScopeDenied = async (name, responsePromise) => {
	const response = await responsePromise;
	if (![401, 403].includes(response.status)) {
		throw new Error(
			`${name} unexpectedly returned HTTP ${response.status} instead of denying access`,
		);
	}
};

const verifyTokenScopes = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	const artifact = readJson(artifactPath);
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_INGEST_TOKEN",
		"TINYBIRD_STAGING_COPY_TOKEN",
		"TINYBIRD_STAGING_ERASURE_LOOKUP_TOKEN",
		"TINYBIRD_STAGING_SCHEDULER_TOKEN",
		"TINYBIRD_STAGING_READ_TOKEN",
		"TINYBIRD_STAGING_CLEANUP_TOKEN",
	]);
	const scopeWindow = tokenScopeProbeWindow(state.startTime, state.endTime);
	const aggregateReadProbeUrl = tinybirdUrl(
		origin,
		"/v0/pipes/product_events_health.json",
		scopeWindow,
	);
	await request(aggregateReadProbeUrl, {
		token: tokens.TINYBIRD_STAGING_READ_TOKEN,
	});
	await request(
		tinybirdUrl(origin, "/v0/sql", {
			q: "SELECT countIf(user_id != '') AS rows FROM product_events_v1 UNION ALL SELECT countIf(user_id != '') AS rows FROM product_events_canonical_v1 FORMAT JSON",
		}),
		{ token: tokens.TINYBIRD_STAGING_ERASURE_LOOKUP_TOKEN },
	);
	const copyJobsProbe = await tokenScopeProbe(
		tinybirdUrl(origin, "/v0/jobs", { kind: "copy" }),
		tokens.TINYBIRD_STAGING_SCHEDULER_TOKEN,
	);
	if (!copyJobsProbe.ok) {
		throw new Error(
			`The schedule-controller token cannot attest Copy job quiescence: HTTP ${copyJobsProbe.status}`,
		);
	}
	await assertScopeDenied(
		"The copy-runner token job-list probe",
		tokenScopeProbe(
			tinybirdUrl(origin, "/v0/jobs", { kind: "copy" }),
			tokens.TINYBIRD_STAGING_COPY_TOKEN,
		),
	);
	await assertScopeDenied(
		"The aggregate read token raw identity query",
		tokenScopeProbe(
			tinybirdUrl(origin, "/v0/sql", {
				q: "SELECT user_id, organization_id, anonymous_id FROM product_events_v1 LIMIT 1",
			}),
			tokens.TINYBIRD_STAGING_READ_TOKEN,
		),
	);
	await assertScopeDenied(
		"The aggregate read token append probe",
		tokenScopeProbe(
			tinybirdUrl(origin, "/v0/events", {
				name: "product_events_v1",
				wait: "true",
			}),
			tokens.TINYBIRD_STAGING_READ_TOKEN,
			{
				method: "POST",
				body: "\n",
				headers: { "Content-Type": "application/x-ndjson" },
			},
		),
	);
	await assertScopeDenied(
		"The aggregate read token job-list probe",
		tokenScopeProbe(
			tinybirdUrl(origin, "/v0/jobs", { kind: "copy" }),
			tokens.TINYBIRD_STAGING_READ_TOKEN,
		),
	);
	await assertScopeDenied(
		"The aggregate read token Copy mutation probe",
		tokenScopeProbe(
			tinybirdUrl(
				origin,
				"/v0/pipes/snapshot_product_events_canonical_v1/copy",
				{ _mode: "replace" },
			),
			tokens.TINYBIRD_STAGING_READ_TOKEN,
			{ method: "POST" },
		),
	);
	await assertScopeDenied(
		"The erasure lookup token append probe",
		tokenScopeProbe(
			tinybirdUrl(origin, "/v0/events", {
				name: "product_events_v1",
				wait: "true",
			}),
			tokens.TINYBIRD_STAGING_ERASURE_LOOKUP_TOKEN,
			{
				method: "POST",
				body: "\n",
				headers: { "Content-Type": "application/x-ndjson" },
			},
		),
	);
	await assertScopeDenied(
		"The erasure lookup token Copy mutation probe",
		tokenScopeProbe(
			tinybirdUrl(
				origin,
				"/v0/pipes/snapshot_product_events_canonical_v1/copy",
				{ _mode: "replace" },
			),
			tokens.TINYBIRD_STAGING_ERASURE_LOOKUP_TOKEN,
			{ method: "POST" },
		),
	);
	const ingestProbe = await tokenScopeProbe(
		tinybirdUrl(origin, "/v0/events", {
			name: "product_events_v1",
			wait: "true",
		}),
		tokens.TINYBIRD_STAGING_INGEST_TOKEN,
		{
			method: "POST",
			body: "\n",
			headers: { "Content-Type": "application/x-ndjson" },
		},
	);
	if ([401, 403].includes(ingestProbe.status) || ingestProbe.status >= 500) {
		throw new Error(
			`The append-only token failed its non-mutating append probe with HTTP ${ingestProbe.status}`,
		);
	}
	for (const [name, token] of [
		["append-only token", tokens.TINYBIRD_STAGING_INGEST_TOKEN],
		["cleanup token", tokens.TINYBIRD_STAGING_CLEANUP_TOKEN],
		["copy-runner token", tokens.TINYBIRD_STAGING_COPY_TOKEN],
		["erasure lookup token", tokens.TINYBIRD_STAGING_ERASURE_LOOKUP_TOKEN],
		["schedule-controller token", tokens.TINYBIRD_STAGING_SCHEDULER_TOKEN],
	]) {
		await assertScopeDenied(
			`The ${name} aggregate read probe`,
			tokenScopeProbe(aggregateReadProbeUrl, token),
		);
	}
	artifact.tokenScopes = {
		aggregateReadPassed: true,
		rawIdentityReadDenied: true,
		readTokenAppendDenied: true,
		readTokenCopyMutationDenied: true,
		readTokenJobListDenied: true,
		ingestTokenAppendAuthorized: true,
		ingestTokenAggregateReadDenied: true,
		cleanupTokenAggregateReadDenied: true,
		copyTokenAggregateReadDenied: true,
		copyTokenJobListDenied: true,
		erasureLookupRawReadPassed: true,
		erasureLookupAppendDenied: true,
		erasureLookupCopyMutationDenied: true,
		erasureLookupAggregateReadDenied: true,
		schedulerTokenJobsReadPassed: true,
	};
	artifact.assertions = {
		...artifact.assertions,
		tokenScopesPassed: true,
	};
	writeJson(artifactPath, artifact);
};

const checkpointFiles = (directory, fileName) => {
	const matches = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const entryPath = `${directory}/${entry.name}`;
		if (entry.isDirectory()) {
			matches.push(...checkpointFiles(entryPath, fileName));
		} else if (entry.isFile() && entry.name === fileName) {
			matches.push(entryPath);
		}
	}
	return matches;
};

const markRecoveryReadyToFinalize = async () => {
	const statePath = option("state");
	const artifact = readJson(option("artifact"));
	const state = readJson(statePath);
	assertRecoveryIdentity(state.recoveryIdentity);
	if (
		state.needsPromotion !== true ||
		state.recoveryPhase !== "postseed" ||
		artifact.assertions?.cleanupPassed !== true ||
		artifact.rollbackDrill?.passed !== true ||
		artifact.copySchedule?.pause?.status !== "passed" ||
		artifact.copySchedule?.pause?.quiescence?.activeJobs !== 0 ||
		artifact.copySchedule?.resume?.status !== "passed"
	) {
		throw new Error(
			"Tinybird finalization checkpoint requires cleanup, rollback, and schedule proof",
		);
	}
	state.recoveryPhase = "ready_to_finalize";
	writeJson(statePath, state, 0o600);
};

const recoveryCheckpoint = (directory) => {
	const stateCandidates = checkpointFiles(
		directory,
		"analytics-staging-state.json",
	).map((statePath) => {
		const state = readJson(statePath);
		assertRecoveryIdentity(state.recoveryIdentity);
		const phaseRank = {
			preseed: 1,
			prepromote: 2,
			postseed: 3,
			ready_to_finalize: 4,
		}[state.recoveryPhase];
		if (!phaseRank) {
			throw new Error("Recovery checkpoint has an unsupported phase");
		}
		const artifactPath = `${statePath.slice(0, -"analytics-staging-state.json".length)}analytics-staging-report.json`;
		if (!fs.existsSync(artifactPath)) {
			throw new Error("Recovery checkpoint is missing its staging report");
		}
		return { artifactPath, phaseRank, state, statePath };
	});
	if (stateCandidates.length > 0) {
		stateCandidates.sort((left, right) => right.phaseRank - left.phaseRank);
		const selected = stateCandidates[0];
		for (const candidate of stateCandidates.slice(1)) {
			if (
				candidate.state.runId !== selected.state.runId ||
				String(candidate.state.deploymentId) !==
					String(selected.state.deploymentId)
			) {
				throw new Error("Recovery checkpoints disagree on mutation ownership");
			}
		}
		return { kind: "seeded", ...selected };
	}
	const boundaries = checkpointFiles(
		directory,
		"analytics-deployment-boundary.json",
	);
	if (boundaries.length !== 1) {
		throw new Error("Recovery requires exactly one deployment boundary");
	}
	const boundary = readJson(boundaries[0]);
	assertRecoveryIdentity(boundary.identity);
	return { boundary, kind: "boundary" };
};

const recoverStaging = async () => {
	const recoveryArtifactPath = option("artifact");
	writeJson(recoveryArtifactPath, {
		recovered: false,
		strategy: "incomplete",
		workspaceId: STAGING_WORKSPACE_ID,
		verifiedAt: new Date().toISOString(),
	});
	const checkpoint = recoveryCheckpoint(option("checkpoint-directory"));
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_CLEANUP_TOKEN",
		"TINYBIRD_STAGING_COPY_TOKEN",
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
		"TINYBIRD_STAGING_READ_TOKEN",
		"TINYBIRD_STAGING_SCHEDULER_TOKEN",
	]);
	const deployToken = tokens.TINYBIRD_STAGING_DEPLOY_TOKEN;
	const currentDeployments = await deploymentList({
		origin,
		token: deployToken,
	});
	if (checkpoint.kind === "boundary") {
		const candidate = resolveDeploymentCreatedAfterBoundary(
			currentDeployments.data,
			checkpoint.boundary.tinybird,
			{ allowNone: true },
		);
		if (candidate) {
			await discardOwnedDeployment({ deploymentId: candidate.id });
		}
		writeJson(recoveryArtifactPath, {
			recovered: true,
			strategy: candidate ? "discard_uncertain_create" : "no_mutation",
			workspaceId: STAGING_WORKSPACE_ID,
			verifiedAt: new Date().toISOString(),
		});
		return;
	}
	const state = checkpoint.state;
	const artifact = readJson(checkpoint.artifactPath);
	if (
		artifact.sha !== state.recoveryIdentity.expectedSha ||
		String(artifact.tinybird?.deploymentId ?? "") !== String(state.deploymentId)
	) {
		throw new Error("Recovery report does not match its exact-SHA checkpoint");
	}
	const candidateId = String(state.deploymentId);
	const previousLiveDeploymentId = String(
		state.previousLiveDeploymentId ?? state.liveBeforeDeploymentId ?? "",
	);
	let retainedDeploymentId = candidateId;
	let strategy = "clean_noop_live";
	let databaseCleanup;
	let syntheticCleanupCompleted = false;
	const candidateLifecycle = await settledDeploymentLifecycle({
		origin,
		token: deployToken,
		deploymentId: candidateId,
	});
	if (state.needsPromotion === true) {
		if (!/^\d+$/.test(previousLiveDeploymentId)) {
			throw new Error("Recovery is missing the exact prior live deployment");
		}
		if (candidateLifecycle === "live") {
			const previousLifecycle = await settledDeploymentLifecycle({
				origin,
				token: deployToken,
				deploymentId: previousLiveDeploymentId,
			});
			if (previousLifecycle === "ready") {
				await setCopySchedules({
					action: "pause",
					artifactPath: checkpoint.artifactPath,
					state,
				});
				try {
					await cleanup({
						artifactPath: checkpoint.artifactPath,
						deploymentId: candidateId,
						state,
						target: "live",
					});
					databaseCleanup = readJson(checkpoint.artifactPath).cleanup?.database;
					if (!databaseCleanup?.cleaned) {
						throw new Error("Recovery did not attest staging database cleanup");
					}
					await runCopies({
						artifactPath: checkpoint.artifactPath,
						deploymentId: candidateId,
						enforcePerformanceBudget: false,
						phase: "cleanup",
						state,
						target: "live",
					});
					await verifyCleanup({
						artifactPath: checkpoint.artifactPath,
						deploymentId: candidateId,
						state,
						target: "live",
					});
					syntheticCleanupCompleted = true;
				} finally {
					await setCopySchedules({
						action: "resume",
						artifactPath: checkpoint.artifactPath,
						state,
					});
				}
				await switchLiveDeployment({
					origin,
					token: deployToken,
					fromDeploymentId: candidateId,
					toDeploymentId: previousLiveDeploymentId,
				});
				try {
					const excludedEndpoints = await unavailableDecisionEndpoints({
						deploymentId: previousLiveDeploymentId,
						origin,
						state,
						token: tokens.TINYBIRD_STAGING_READ_TOKEN,
					});
					assertDecisionEndpointSuiteReadable(
						(
							await queryDecisionEndpointSuite({
								deploymentId: previousLiveDeploymentId,
								excludedEndpointNames: excludedEndpoints,
								origin,
								state,
								token: tokens.TINYBIRD_STAGING_READ_TOKEN,
							})
						).payloads,
					);
				} catch (error) {
					await switchLiveDeployment({
						origin,
						token: deployToken,
						fromDeploymentId: previousLiveDeploymentId,
						toDeploymentId: candidateId,
					});
					throw new Error(
						"The prior Tinybird deployment failed recovery validation",
						{ cause: error },
					);
				}
				retainedDeploymentId = previousLiveDeploymentId;
				strategy = "rollback_and_discard";
			} else if (
				previousLifecycle === "deleted" &&
				state.recoveryPhase === "ready_to_finalize"
			) {
				strategy = "retain_finalized_candidate";
			} else {
				throw new Error(
					"The prior Tinybird deployment cannot safely receive rollback",
				);
			}
		} else if (["ready", "failed", "pending"].includes(candidateLifecycle)) {
			if (candidateLifecycle === "ready") {
				await cleanup({
					artifactPath: checkpoint.artifactPath,
					deploymentId: candidateId,
					state,
					target: "staging",
				});
				databaseCleanup = readJson(checkpoint.artifactPath).cleanup?.database;
				if (!databaseCleanup?.cleaned) {
					throw new Error("Recovery did not attest staging database cleanup");
				}
				syntheticCleanupCompleted = true;
			}
			retainedDeploymentId = previousLiveDeploymentId;
			strategy = "discard_rejected_candidate";
		} else if (candidateLifecycle === "deleted") {
			retainedDeploymentId = previousLiveDeploymentId;
			strategy = "already_discarded";
		} else {
			throw new Error("The exact Tinybird candidate is not recoverable");
		}
	}
	const serverRunId = validateSyntheticRunId(`${state.runId}_server`);
	if (
		state.needsPromotion !== true ||
		strategy === "retain_finalized_candidate"
	) {
		await setCopySchedules({
			action: "pause",
			artifactPath: checkpoint.artifactPath,
			state,
		});
		try {
			await cleanup({
				artifactPath: checkpoint.artifactPath,
				deploymentId: candidateId,
				state,
				target: "live",
			});
			databaseCleanup = readJson(checkpoint.artifactPath).cleanup?.database;
			if (!databaseCleanup?.cleaned) {
				throw new Error("Recovery did not attest staging database cleanup");
			}
			await runCopies({
				artifactPath: checkpoint.artifactPath,
				deploymentId: candidateId,
				enforcePerformanceBudget: false,
				phase: "cleanup",
				state,
				target: "live",
			});
			await verifyCleanup({
				artifactPath: checkpoint.artifactPath,
				deploymentId: candidateId,
				state,
				target: "live",
			});
		} finally {
			await setCopySchedules({
				action: "resume",
				artifactPath: checkpoint.artifactPath,
				state,
			});
		}
	} else {
		const retainedState = { ...state, deploymentId: retainedDeploymentId };
		const pausedDeploymentId = String(
			artifact.copySchedule?.pause?.deploymentId ?? "",
		);
		if (
			artifact.copySchedule?.pause?.status === "passed" &&
			pausedDeploymentId === retainedDeploymentId
		) {
			await setCopySchedules({
				action: "resume",
				artifactPath: checkpoint.artifactPath,
				state: retainedState,
			});
		}
		if (candidateLifecycle !== "deleted") {
			await discardOwnedDeployment({ deploymentId: candidateId });
		}
		if (!syntheticCleanupCompleted) {
			databaseCleanup = await cleanupPreviewDatabaseState({
				anonymousIdentityHashes: [
					state.browserAnonymousIdentityHash,
					state.previewAnonymousIdentityHash,
				].filter(
					(identityHash) =>
						typeof identityHash === "string" &&
						/^[0-9a-f]{64}$/.test(identityHash),
				),
				artifact,
				runIds: [state.runId, serverRunId],
				secret: environment("CAP_ANALYTICS_STAGING_TEST_SECRET"),
			});
		}
	}
	writeJson(recoveryArtifactPath, {
		databaseCleanup,
		recovered: true,
		retainedDeploymentId,
		strategy,
		workspaceId: STAGING_WORKSPACE_ID,
		verifiedAt: new Date().toISOString(),
	});
};

const handlers = {
	"verify-scope": async () =>
		assertExecutionScope({
			eventName: environment("GITHUB_EVENT_NAME"),
			eventNumber: process.env.EVENT_NUMBER ?? "",
			headRef: process.env.HEAD_REF ?? "",
			ref: environment("GITHUB_REF"),
			expectedSha: environment("EXPECTED_SHA"),
			actualSha: option("actual-sha"),
		}),
	"verify-credentials": async () => tinybirdEnvironment(),
	"verify-token-scopes": verifyTokenScopes,
	"prepare-deployment-boundary": prepareDeploymentBoundary,
	"prepare-promotion": prepareOwnedPromotion,
	"prepare-seed": prepareSeed,
	"promote-deployment": promoteOwnedDeployment,
	"drill-rollback": drillOwnedRollback,
	"discard-retired-deployment": discardRetiredStagingDeployment,
	"finalize-promotion": finalizeOwnedPromotion,
	"rollback-promotion": rollbackOwnedPromotion,
	"discard-deployment": discardOwnedDeployment,
	"select-deployment": async () => {
		const createOutput = readJson(option("create-output"));
		const output = String(createOutput.output ?? "");
		const createdDeploymentId = output.match(
			/Deployment URL:\s+\S+\/deployments\/(\d+)/,
		)?.[1];
		const noOpConfirmed =
			Number(createOutput.exitCode) === 0 &&
			output.includes("No changes to be deployed") &&
			output.includes("Not deploying. No changes.");
		const deployments = readJson(option("input"));
		const selection =
			createdDeploymentId || noOpConfirmed
				? selectStagingDeployment(
						deployments,
						option("minimum-created-at"),
						createdDeploymentId,
						noOpConfirmed,
					)
				: resolveDeploymentCreatedAfterBoundary(
						deployments,
						readJson(option("boundary")).tinybird,
					);
		writeOutput("id", selection.id);
		writeOutput("needs_promotion", String(selection.needsPromotion));
	},
	"resolve-deployment-state": async () => {
		const recoverPending = option("recover-pending");
		if (!["true", "false"].includes(recoverPending)) {
			throw new Error("--recover-pending must be true or false");
		}
		const resolution = resolveDeploymentState(
			readJson(option("input")),
			option("deployment-id"),
		);
		if (resolution.pending && recoverPending === "false") {
			process.exitCode = 75;
			return;
		}
		writeOutput("target", resolution.target);
		writeOutput("discard", resolution.pending || resolution.discard);
		writeOutput("promoted", resolution.promoted);
		writeOutput("state", resolution.state);
		writeOutput("pending_recovery", resolution.pending);
	},
	"wait-vercel": waitForVercel,
	"verify-pr-head": verifyFreshPullRequestHead,
	"attest-preview": attestPreviewTinybird,
	seed,
	"verify-ingestion-budget": verifyIngestionBudget,
	"run-copies": runCopies,
	"set-copy-schedules": setCopySchedules,
	"verify-preseed": verifyPreSeed,
	verify,
	"probe-preview": probePreview,
	"probe-server": probeDurableServerPath,
	"verify-promoted": verifyPromoted,
	"erase-synthetic-identity": eraseSyntheticIdentity,
	"verify-synthetic-identity-erasure": verifySyntheticIdentityErasure,
	"mark-recovery-ready": markRecoveryReadyToFinalize,
	recover: recoverStaging,
	cleanup,
	"verify-cleanup": verifyCleanup,
};

try {
	const handler = handlers[command];
	if (!handler) {
		throw new Error(`Unknown staging analytics command: ${command ?? ""}`);
	}
	await handler();
} catch (error) {
	const message =
		error instanceof Error ? error.message : "Unknown staging CI error";
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
}
