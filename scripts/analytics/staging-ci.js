import fs from "node:fs";
import process from "node:process";

import {
	applyCopyScheduleAction,
	assertExecutionScope,
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
	copyScheduleMatchesAction,
	createSyntheticDecisionEvents,
	createSyntheticErasureControl,
	createSyntheticEvents,
	createSyntheticLoadEvents,
	dataMutationDeploymentParameters,
	decisionEndpointQueries,
	evaluateBundleBudget,
	evaluateLatencyBudget,
	extractSameOriginNextScriptUrls,
	hashIdentifier,
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
	syntheticIdentityFilterQueries,
	syntheticMonetizationFilterQueries,
	validateSyntheticRunId,
	validateTinybirdCredentials,
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

const TINYBIRD_TOKEN_NAMES = [
	"TINYBIRD_STAGING_DEPLOY_TOKEN",
	"TINYBIRD_STAGING_COPY_TOKEN",
	"TINYBIRD_STAGING_ERASURE_LOOKUP_TOKEN",
	"TINYBIRD_STAGING_SCHEDULER_TOKEN",
	"TINYBIRD_STAGING_INGEST_TOKEN",
	"TINYBIRD_STAGING_READ_TOKEN",
	"TINYBIRD_STAGING_CLEANUP_TOKEN",
];

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
			if (response.status < 500 && response.status !== 429) {
				const error = new Error(
					`Tinybird request was rejected with HTTP ${response.status}`,
					{ cause: "permanent" },
				);
				error.status = response.status;
				throw error;
			}
			lastError = new Error(
				`Tinybird request failed with HTTP ${response.status}`,
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
			url.searchParams.set(name, value);
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
	return request(
		tinybirdUrl(origin, "/v0/pipes/product_events_health.json", {
			start_time: previewWindow ? state.previewStartTime : state.startTime,
			end_time: previewWindow ? state.previewEndTime : state.endTime,
			platform: "web",
			app_version: appVersion ?? state.appVersion,
			__tb__deployment: deploymentId,
		}),
		{ token: tokens.TINYBIRD_STAGING_READ_TOKEN, attempts: 3 },
	);
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

const exactDeployment = async ({ origin, token, deploymentId }) =>
	request(
		tinybirdUrl(origin, `/v1/deployments/${encodeURIComponent(deploymentId)}`),
		{ token, attempts: 3 },
	);

const promoteOwnedDeployment = async () => {
	const deploymentId = option("deployment-id");
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
	]);
	const token = tokens.TINYBIRD_STAGING_DEPLOY_TOKEN;
	const initial = await deploymentList({ origin, token });
	const plan = resolveExactPromotionPlan(initial.data, deploymentId);
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
	let retainedIdentityFunnelAvailable = false;
	try {
		retainedIdentityFunnelAvailable = await decisionEndpointAvailable({
			deploymentId: previousLiveDeploymentId,
			name: "product_identity_funnel",
			origin,
			state,
			token: tokens.TINYBIRD_STAGING_READ_TOKEN,
		});
		rollbackEndpointSuite = await queryDecisionEndpointSuite({
			deploymentId: previousLiveDeploymentId,
			includeIdentityFunnel: retainedIdentityFunnelAvailable,
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
		retainedIdentityFunnelAvailable,
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
	let retainedIdentityFunnelAvailable = false;
	try {
		retainedIdentityFunnelAvailable = await decisionEndpointAvailable({
			deploymentId: previousLiveDeploymentId,
			name: "product_identity_funnel",
			origin,
			state,
			token: tokens.TINYBIRD_STAGING_READ_TOKEN,
		});
		rollbackEndpointSuite = await queryDecisionEndpointSuite({
			deploymentId: previousLiveDeploymentId,
			includeIdentityFunnel: retainedIdentityFunnelAvailable,
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
			retainedIdentityFunnelAvailable,
			verifiedAt: new Date().toISOString(),
		};
		writeJson(artifactPath, artifact);
	}
};

const discardOwnedDeployment = async () => {
	const deploymentId = option("deployment-id");
	const artifactPath = options.get("artifact");
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

const queryDecisionEndpointSuite = async ({
	deploymentId,
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

const previewRequest = async (url, init = {}) => {
	const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
	return fetch(url, {
		...init,
		headers: {
			...(bypass
				? {
						"x-vercel-protection-bypass": bypass,
						"x-vercel-set-bypass-cookie": "true",
					}
				: {}),
			...init.headers,
		},
		signal: init.signal ?? AbortSignal.timeout(20_000),
	});
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
	const previewOrigin = new URL(artifact.vercel.url).origin;
	const landing = await previewRequest(previewOrigin);
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
	const occurredAt = new Date().toISOString();
	const runHash = hashIdentifier(state.runId);
	const previewRunId = validateSyntheticRunId(state.previewRunId);
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
	const collectorLatencySamples = [];
	const post = async (cookieHeader = cookies) => {
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
				body,
			},
		);
		collectorLatencySamples.push(Math.round(performance.now() - startedAt));
		return response;
	};
	const missingToken = await post("");
	if (missingToken.status !== 400) {
		throw new Error(
			`The preview collector accepted a missing browser token with HTTP ${missingToken.status}`,
		);
	}
	const expiredToken = await post(
		`cap_analytics_anonymous_id=${anonymousId}; cap_analytics_browser_token=v1.0.${anonymousId}.expired`,
	);
	if (expiredToken.status !== 400) {
		throw new Error(
			`The preview collector accepted an expired browser token with HTTP ${expiredToken.status}`,
		);
	}
	const duplicateResponses = await Promise.all([post(), post()]);
	if (duplicateResponses.some((response) => !response.ok)) {
		throw new Error(
			"The preview collector rejected a valid concurrent duplicate",
		);
	}
	const minimumAccepted = Number(process.env.RATE_LIMIT_MIN_ACCEPTED ?? 20);
	const maximumAccepted = Number(process.env.RATE_LIMIT_MAX_ACCEPTED ?? 80);
	let replayAccepted = 0;
	let rateLimited = false;
	for (let index = 0; index <= maximumAccepted; index += 1) {
		const response = await post();
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
	const collectorLatency = latencySummary(collectorLatencySamples);
	const collectorP95BudgetMs = Number(
		process.env.COLLECTOR_P95_BUDGET_MS ?? 3_000,
	);
	if (collectorLatency.p95Ms > collectorP95BudgetMs) {
		throw new Error(
			`The exact-SHA collector p95 was ${collectorLatency.p95Ms}ms, over ${collectorP95BudgetMs}ms`,
		);
	}
	state.previewAcceptedRows = duplicateResponses.length + replayAccepted;
	state.previewExpectedEvents = Number(state.browserExpectedEvents ?? 0) + 1;
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
		replayAcceptedBeforeRateLimit: replayAccepted,
		rateLimitPassed: true,
		collectorLatency,
		collectorP95BudgetMs,
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
	writeJson(artifactPath, artifact);
};

const probeDurableServerPath = async () => {
	const statePath = option("state");
	const artifactPath = option("artifact");
	const state = readJson(statePath);
	const artifact = readJson(artifactPath);
	const secret = environment("CAP_ANALYTICS_STAGING_TEST_SECRET");
	const serverRunId = validateSyntheticRunId(`${state.runId}_server`);
	const url = new URL("/api/analytics/staging-test", artifact.vercel.url);
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
		Number(result.uniqueEvents) !== 4 ||
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
	artifact.serverDelivery = {
		acceptedRows: 5,
		uniqueEvents: 4,
		duplicateRows: visibility.value.duplicateRows,
		workflowRuns: 5,
		visibilityMs: visibility.visibilityMs,
		unauthorizedRejected: true,
		wrongShaRejected: true,
	};
	artifact.assertions = {
		...artifact.assertions,
		durableServerPathPassed: true,
		serverDuplicateDeliveryPassed: true,
	};
	writeJson(artifactPath, artifact);
};

const seed = async () => {
	const runId = validateSyntheticRunId(option("run-id"));
	const deploymentId = option("deployment-id");
	const statePath = option("state");
	const artifactPath = option("artifact");
	const sha = environment("EXPECTED_SHA");
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_COPY_TOKEN",
		"TINYBIRD_STAGING_INGEST_TOKEN",
	]);
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
		now: startedAt,
	});
	const largeLoadFixture = createSyntheticLoadEvents({
		runId: `${runId}_large`,
		count: Number(process.env.LARGE_PERFORMANCE_EVENT_COUNT ?? 10_000),
		now: startedAt,
	});
	if (largeLoadFixture.rows.length <= loadFixture.rows.length) {
		throw new Error(
			"The large performance corpus must exceed the baseline corpus",
		);
	}
	const previewRunId = validateSyntheticRunId(`${runId}_preview`);
	const previewAppVersion = `staging-preview-${hashIdentifier(runId).slice(0, 12)}`;
	const state = {
		runId,
		previewRunId,
		previewAppVersion,
		deploymentId,
		appVersion: fixture.appVersion,
		loadAppVersion: loadFixture.appVersion,
		loadRunId: loadFixture.runId,
		loadEventCount: loadFixture.rows.length,
		largeLoadAppVersion: largeLoadFixture.appVersion,
		largeLoadRunId: largeLoadFixture.runId,
		largeLoadEventCount: largeLoadFixture.rows.length,
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
		startTime: new Date(startedAt.getTime() - 120_000).toISOString(),
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
			rowsAttempted: 0,
			rowsAccepted: 0,
		},
		largeLoad: {
			rowsPlanned: largeLoadFixture.rows.length,
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
		if (!Number.isInteger(batchSize) || batchSize < 100 || batchSize > 1_000) {
			throw new Error("Performance ingestion batch size must be 100 to 1000");
		}
		artifact[artifactKey].rowsAttempted = fixture.rows.length;
		writeJson(artifactPath, artifact);
		const started = performance.now();
		const latencies = [];
		let accepted = 0;
		let retryAttempts = 0;
		for (let offset = 0; offset < fixture.rows.length; offset += batchSize) {
			const batch = fixture.rows.slice(offset, offset + batchSize);
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
			latencies.push(delivery.latencyMs);
			retryAttempts += delivery.attempt - 1;
			accepted += batch.length;
		}
		const elapsedMs = Math.max(1, Math.round(performance.now() - started));
		artifact[artifactKey] = {
			rows: fixture.rows.length,
			rowsPlanned: fixture.rows.length,
			rowsAttempted: fixture.rows.length,
			rowsAccepted: accepted,
			batchSize,
			batches: latencies.length,
			batchLatency: latencySummary(latencies),
			errorRate: 0,
			retryAttempts,
			rowsPerSecond: Math.round((fixture.rows.length * 1_000) / elapsedMs),
		};
	};
	await sendLoadFixture(loadFixture, "load");
	await sendLoadFixture(largeLoadFixture, "largeLoad");
	const ingestionBatchP95BudgetMs = Number(
		process.env.INGESTION_BATCH_P95_BUDGET_MS ?? 5_000,
	);
	const ingestionMinimumRowsPerSecond = Number(
		process.env.INGESTION_MINIMUM_ROWS_PER_SECOND ?? 500,
	);
	artifact.ingestionBudget = {
		batchP95Ms: ingestionBatchP95BudgetMs,
		minimumRowsPerSecond: ingestionMinimumRowsPerSecond,
		passed:
			artifact.load.batchLatency.p95Ms <= ingestionBatchP95BudgetMs &&
			artifact.largeLoad.batchLatency.p95Ms <= ingestionBatchP95BudgetMs &&
			artifact.load.rowsPerSecond >= ingestionMinimumRowsPerSecond &&
			artifact.largeLoad.rowsPerSecond >= ingestionMinimumRowsPerSecond &&
			artifact.load.errorRate === 0 &&
			artifact.largeLoad.errorRate === 0,
	};
	writeJson(artifactPath, artifact);
	if (!artifact.ingestionBudget.passed) {
		throw new Error("Synthetic ingestion performance budget failed");
	}
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
	artifact.assertions.seedAccepted = true;
	writeJson(artifactPath, artifact);
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
	if (state.serverRunId && phase !== "staged") {
		expectations.push({
			runId: state.serverRunId,
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

const runCopies = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	const artifact = readJson(artifactPath);
	const phase = option("phase");
	const requestedTarget = option("target");
	if (!["staged", "promoted", "erasure", "cleanup"].includes(phase)) {
		throw new Error("Tinybird copy phase is invalid");
	}
	if (requestedTarget !== "live") {
		throw new Error(
			"Tinybird Copy mutations are allowed only after staging promotion",
		);
	}
	if (String(state.deploymentId) !== option("deployment-id")) {
		throw new Error("Tinybird copy deployment does not match the seeded run");
	}
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_COPY_TOKEN",
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
	]);
	const copyRunId = validateSyntheticRunId(`${state.runId}_${phase}`);
	const expectations = phaseRunExpectations({ state, phase });
	const executeCopies = async (target) => {
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
		const canonicalJobs = await submitTinybirdCopyJobs({
			origin,
			token: tokens.TINYBIRD_STAGING_COPY_TOKEN,
			deploymentId: state.deploymentId,
			request,
			pipes: ["snapshot_product_events_canonical_v1"],
			assertMutationOwnership,
		});
		artifact.copyJobs = {
			...artifact.copyJobs,
			[phase]: {
				status: "in_progress",
				target,
				copyRunHash: hashIdentifier(copyRunId),
				jobs: canonicalJobs,
			},
		};
		writeJson(artifactPath, artifact);
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
				pipe: "snapshot_product_events_health_hourly",
				marker: "healthMarkers",
			},
		];
		for (const copyStep of copySteps) {
			downstreamJobs.push(
				...(await submitTinybirdCopyJobs({
					origin,
					token: tokens.TINYBIRD_STAGING_COPY_TOKEN,
					deploymentId: state.deploymentId,
					request,
					pipes: [copyStep.pipe],
					copyRunId,
					assertMutationOwnership,
				})),
			);
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
		await assertMutationOwnership();
		return {
			status: "passed",
			target,
			copyRunHash: hashIdentifier(copyRunId),
			jobs: [...canonicalJobs, ...downstreamJobs],
			canonicalVisibility: {
				polls: canonicalVisibility.polls,
				visibilityMs: canonicalVisibility.visibilityMs,
			},
			downstreamVisibility: { copies: downstreamVisibility },
		};
	};
	let target = requestedTarget;
	for (
		let transitionAttempt = 0;
		transitionAttempt < 2;
		transitionAttempt += 1
	) {
		try {
			artifact.copyJobs = {
				...artifact.copyJobs,
				[phase]: await executeCopies(target),
			};
			if (phase === "cleanup") writeOutput("target", target);
			writeJson(artifactPath, artifact);
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

const setCopySchedules = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	const artifact = readJson(artifactPath);
	const action = option("action");
	if (!["pause", "resume"].includes(action)) {
		throw new Error("Tinybird Copy schedule action must be pause or resume");
	}
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
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
	await applyCopyScheduleAction({
		pipes: COPY_PIPES,
		action,
		setSchedule: async (pipe, scheduleAction) => {
			let mutationError;
			try {
				await request(
					tinybirdUrl(
						origin,
						`/v0/pipes/${encodeURIComponent(pipe)}/copy/${scheduleAction === "pause" ? "cancel" : "resume"}`,
					),
					{
						token: tokens.TINYBIRD_STAGING_SCHEDULER_TOKEN,
						method: "POST",
						attempts: 1,
					},
				);
			} catch (error) {
				mutationError = error;
			}
			const pipeState = await request(
				tinybirdUrl(origin, `/v0/pipes/${encodeURIComponent(pipe)}`),
				{
					token: tokens.TINYBIRD_STAGING_SCHEDULER_TOKEN,
					attempts: 4,
				},
			);
			if (copyScheduleMatchesAction(pipeState, scheduleAction)) return;
			if (mutationError) throw mutationError;
			throw new Error(
				`Tinybird did not attest the ${scheduleAction} state for ${pipe}`,
			);
		},
	});
	artifact.copySchedule = {
		...(artifact.copySchedule ?? {}),
		[action]: {
			status: "passed",
			deploymentId: String(state.deploymentId),
			pipeCount: COPY_PIPES.length,
		},
	};
	writeJson(artifactPath, artifact);
};

const rawAssertionMetrics = (assertions) => ({
	receivedRows: assertions.receivedRows,
	uniqueEvents: assertions.uniqueEvents,
	uniquePayloads: assertions.uniquePayloads,
	duplicateRows: assertions.duplicateRows,
	payloadConflicts: assertions.payloadConflicts,
});

const verifyCandidate = async ({ state, artifact, artifactPath }) => {
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_READ_TOKEN",
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
	]);
	if (
		(await ownedMutationTarget({
			state,
			origin,
			token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
		})) !== "staging"
	) {
		throw new Error("Candidate validation lost exact deployment ownership");
	}
	const visibility = await waitForCopyVisibility({
		label: "Tinybird candidate raw delivery",
		read: async () =>
			Promise.all(
				[
					state.runId,
					state.loadRunId,
					state.largeLoadRunId,
					state.decisionRunId,
					state.erasureControlRunId,
				].map(async (syntheticRunId) =>
					normalizeCiAssertions(
						(
							await ciAssertionsQuery({
								state,
								deploymentId: state.deploymentId,
								syntheticRunId,
							})
						).data,
					),
				),
			),
		assert: ([main, load, largeLoad, decisions, control]) => {
			assertSyntheticHealth(main);
			assertSyntheticLoadHealth(load, state.loadEventCount);
			assertSyntheticLoadHealth(largeLoad, state.largeLoadEventCount);
			assertSyntheticLoadHealth(decisions, state.decisionEventCount);
			assertSingleHealth(control);
		},
	});
	const ingestionVisibilityMs = Date.now() - Date.parse(state.startedAt);
	const [main, load, largeLoad, decisions, control] = visibility.value;
	const liveAssertions = await Promise.all(
		[
			state.runId,
			state.loadRunId,
			state.largeLoadRunId,
			state.decisionRunId,
			state.erasureControlRunId,
		].map(async (syntheticRunId) =>
			normalizeCiAssertions(
				(await ciAssertionsQuery({ state, syntheticRunId })).data,
			),
		),
	);
	if (
		liveAssertions.some((assertions) =>
			Object.values(assertions).some((value) => value !== 0),
		)
	) {
		throw new Error("Candidate-only synthetic events affected live analytics");
	}
	const queries = decisionEndpointQueries({
		startDate: state.startTime.slice(0, 10),
		endDate: state.endTime.slice(0, 10),
		deploymentId: state.deploymentId,
	});
	const samples = Object.fromEntries(queries.map(({ name }) => [name, []]));
	const fanoutSamples = [];
	for (let round = 0; round < 5; round += 1) {
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
			samples[queries[index].name].push(results[index].latencyMs);
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
	const ingestionSloMs = Number(process.env.INGESTION_SLO_MS ?? 180_000);
	artifact.candidateValidation = {
		raw: {
			main: rawAssertionMetrics(main),
			load: rawAssertionMetrics(load),
			largeLoad: rawAssertionMetrics(largeLoad),
			decisions: rawAssertionMetrics(decisions),
			control: rawAssertionMetrics(control),
		},
		liveIsolated: true,
		polls: visibility.polls,
		ingestionVisibilityMs,
		endpointLatency,
		dashboardFanoutLatency,
	};
	artifact.assertions = {
		...artifact.assertions,
		candidateRawDeliveryPassed: true,
		candidateDuplicateVisible: true,
		candidatePayloadConflictVisible: true,
		candidateIsolationPassed: true,
		candidateEndpointsPassed:
			failedEndpoints.length === 0 &&
			dashboardFanoutLatency.p95Ms <= fanoutP95BudgetMs,
		candidateIngestionSloPassed: ingestionVisibilityMs <= ingestionSloMs,
	};
	artifact.visibilityMs = ingestionVisibilityMs;
	writeJson(artifactPath, artifact);
	if (ingestionVisibilityMs > ingestionSloMs) {
		throw new Error(
			`Candidate events became visible in ${ingestionVisibilityMs}ms, over ${ingestionSloMs}ms`,
		);
	}
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
		await verifyCandidate({ state, artifact, artifactPath });
		return;
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
	const retainedIdentityFunnelAvailable =
		baselineDeploymentId === state.deploymentId ||
		(await decisionEndpointAvailable({
			deploymentId: baselineDeploymentId,
			name: "product_identity_funnel",
			origin,
			state,
			token: tokens.TINYBIRD_STAGING_READ_TOKEN,
		}));
	const baselineQueries = decisionEndpointQueries({
		startDate: state.startTime.slice(0, 10),
		endDate: state.endTime.slice(0, 10),
		deploymentId: baselineDeploymentId,
		includeIdentityFunnel: retainedIdentityFunnelAvailable,
	});
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
	for (let index = 0; index < 10; index += 1) {
		await sampleDecisionRound(
			baselineQueries,
			baselineSamples,
			baselineFanoutSamples,
		);
	}
	for (let index = 0; index < 10; index += 1) {
		await sampleDecisionRound(largeQueries, largeSamples, largeFanoutSamples);
	}
	for (let index = 0; index < 15; index += 1) {
		await sampleDecisionRound(
			measuredQueries,
			measuredSamples,
			measuredFanoutSamples,
		);
	}
	for (let index = 0; index < 10; index += 1) {
		await sampleDecisionRound(
			representativeQueries,
			representativeSamples,
			representativeFanoutSamples,
		);
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
				return [
					name,
					{
						baseline: null,
						measured,
						representative,
						large,
						budget: {
							mode: "new_endpoint_no_baseline",
							absoluteP95Ms: endpointP95BudgetMs,
							passed: measured.p95Ms <= endpointP95BudgetMs,
						},
						representativeBudget: {
							mode: "new_endpoint_no_baseline",
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
	const dashboardBaseline = latencySummary(baselineFanoutSamples);
	const dashboardMeasured = latencySummary(measuredFanoutSamples);
	const dashboardRepresentative = latencySummary(representativeFanoutSamples);
	const dashboardLarge = latencySummary(largeFanoutSamples);
	const dashboardBudget = evaluateLatencyBudget({
		baseline: dashboardBaseline,
		measured: dashboardMeasured,
		absoluteP95Ms: fanoutP95BudgetMs,
		regressionFactor,
		regressionFloorMs,
	});
	const dashboardRepresentativeBudget = evaluateLatencyBudget({
		baseline: dashboardBaseline,
		measured: dashboardRepresentative,
		absoluteP95Ms: fanoutP95BudgetMs,
		regressionFactor,
		regressionFloorMs,
	});
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
		deploymentId: baselineDeploymentId,
		mode:
			baselineDeploymentId === state.deploymentId
				? "same_deployment_noop"
				: "retained_deployment",
		representativeRows: state.loadEventCount,
		largeRows: state.largeLoadEventCount,
		newEndpointsWithoutBaseline: retainedIdentityFunnelAvailable
			? []
			: ["product_identity_funnel"],
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
	const url = new URL("/api/analytics/staging-test/erase", artifact.vercel.url);
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

const cleanup = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	const requestedTarget = option("target");
	if (!["live", "staging"].includes(requestedTarget)) {
		throw new Error("Tinybird cleanup target is invalid");
	}
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_CLEANUP_TOKEN",
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
	]);
	let target = await waitForOwnedMutationTarget({
		state,
		origin,
		token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
	});
	if (requestedTarget === "live" && target !== "live") {
		throw new Error("Tinybird cleanup target regressed from live to staging");
	}
	validateSyntheticRunId(state.runId);
	validateSyntheticRunId(state.loadRunId);
	validateSyntheticRunId(state.largeLoadRunId);
	validateSyntheticRunId(state.decisionRunId);
	validateSyntheticRunId(state.erasureControlRunId);
	if (state.serverRunId) validateSyntheticRunId(state.serverRunId);
	const runIds = [
		state.runId,
		state.loadRunId,
		state.largeLoadRunId,
		state.decisionRunId,
		state.erasureControlRunId,
	];
	if (state.previewRunId) {
		runIds.push(validateSyntheticRunId(state.previewRunId));
	}
	if (state.serverRunId) runIds.push(state.serverRunId);
	if (target === "staging") {
		writeOutput("target", target);
		writeOutput("requires_copies", "false");
		writeOutput("requires_discard", "true");
		const artifact = readJson(artifactPath);
		artifact.cleanup = {
			...artifact.cleanup,
			strategy: "deployment_discard",
			candidateDiscarded: false,
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
			deploymentId: option("deployment-id"),
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

const verifyCleanup = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	const artifact = readJson(artifactPath);
	const target = option("target");
	if (!["live", "staging"].includes(target)) {
		throw new Error("Tinybird cleanup verification target is invalid");
	}
	if (String(state.deploymentId) !== option("deployment-id")) {
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
	for (const syntheticRunId of [state.loadRunId, state.largeLoadRunId]) {
		const decisions = normalizeCiAssertions(
			(await ciAssertionsQuery({ state, deploymentId, syntheticRunId })).data,
		);
		if (Object.values(decisions).some((value) => value !== 0)) {
			throw new Error(
				"Synthetic load rows still affect Tinybird decisions after cleanup",
			);
		}
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
	await request(
		tinybirdUrl(origin, "/v0/pipes/product_events_health.json", {
			start_time: state.startTime,
			end_time: state.endTime,
		}),
		{ token: tokens.TINYBIRD_STAGING_READ_TOKEN },
	);
	await request(
		tinybirdUrl(origin, "/v0/sql", {
			q: "SELECT countIf(user_id != '') AS rows FROM product_events_v1 UNION ALL SELECT countIf(user_id != '') AS rows FROM product_events_canonical_v1",
		}),
		{ token: tokens.TINYBIRD_STAGING_ERASURE_LOOKUP_TOKEN },
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
			tokenScopeProbe(
				tinybirdUrl(origin, "/v0/pipes/product_events_health.json", {
					start_time: state.startTime,
					end_time: state.endTime,
				}),
				token,
			),
		);
	}
	artifact.tokenScopes = {
		aggregateReadPassed: true,
		rawIdentityReadDenied: true,
		readTokenAppendDenied: true,
		readTokenCopyMutationDenied: true,
		ingestTokenAppendAuthorized: true,
		ingestTokenAggregateReadDenied: true,
		cleanupTokenAggregateReadDenied: true,
		copyTokenAggregateReadDenied: true,
		erasureLookupRawReadPassed: true,
		erasureLookupAppendDenied: true,
		erasureLookupCopyMutationDenied: true,
		erasureLookupAggregateReadDenied: true,
	};
	artifact.assertions = {
		...artifact.assertions,
		tokenScopesPassed: true,
	};
	writeJson(artifactPath, artifact);
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
	"promote-deployment": promoteOwnedDeployment,
	"drill-rollback": drillOwnedRollback,
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
			output.includes("No changes to be deployed") &&
			output.includes("Not deploying. No changes.");
		const selection = selectStagingDeployment(
			readJson(option("input")),
			option("minimum-created-at"),
			createdDeploymentId,
			noOpConfirmed,
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
	seed,
	"run-copies": runCopies,
	"set-copy-schedules": setCopySchedules,
	verify,
	"probe-preview": probePreview,
	"probe-server": probeDurableServerPath,
	"verify-promoted": verifyPromoted,
	"erase-synthetic-identity": eraseSyntheticIdentity,
	"verify-synthetic-identity-erasure": verifySyntheticIdentityErasure,
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
