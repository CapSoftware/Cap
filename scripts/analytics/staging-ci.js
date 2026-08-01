import fs from "node:fs";
import process from "node:process";

import {
	assertExecutionScope,
	assertSyntheticDecisions,
	assertSyntheticHealth,
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
				throw new Error(
					`Tinybird request was rejected with HTTP ${response.status}`,
					{ cause: "permanent" },
				);
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
	return request(
		tinybirdUrl(origin, "/v0/pipes/product_events_health.json", {
			start_time: state.startTime,
			end_time: state.endTime,
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
	const deadline =
		Date.now() + Number(process.env.DEPLOYMENT_WAIT_MS ?? 300_000);
	let lastDeletionError;
	while (Date.now() < deadline) {
		const previous = await exactDeployment({
			origin,
			token,
			deploymentId: plan.previousLiveDeploymentId,
		});
		const lifecycle = resolveExactDeploymentLifecycle(
			previous.data,
			plan.previousLiveDeploymentId,
		);
		if (lifecycle === "deleted") {
			writeOutput("promoted", "true");
			return;
		}
		if (lifecycle === "live") {
			throw new Error("The previous Tinybird deployment became live again");
		}
		if (lifecycle !== "deleting") {
			try {
				await request(
					tinybirdUrl(
						origin,
						`/v1/deployments/${encodeURIComponent(plan.previousLiveDeploymentId)}`,
					),
					{
						token,
						method: "DELETE",
						beforeAttempt: async () => {
							const ownership = await deploymentList({ origin, token });
							if (
								resolveOwnedMutationTarget(ownership.data, deploymentId) !==
								"live"
							) {
								throw new Error(
									"The promoted Tinybird deployment is no longer live",
								);
							}
							const exactPrevious = await exactDeployment({
								origin,
								token,
								deploymentId: plan.previousLiveDeploymentId,
							});
							if (
								resolveExactDeploymentLifecycle(
									exactPrevious.data,
									plan.previousLiveDeploymentId,
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

const discardOwnedDeployment = async () => {
	const deploymentId = option("deployment-id");
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
		signal: AbortSignal.timeout(20_000),
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

const seed = async () => {
	const runId = validateSyntheticRunId(option("run-id"));
	const deploymentId = option("deployment-id");
	const statePath = option("state");
	const artifactPath = option("artifact");
	const sha = environment("EXPECTED_SHA");
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_INGEST_TOKEN",
	]);
	const startedAt = new Date();
	const fixture = createSyntheticEvents({ runId, now: startedAt });
	const erasureControl = createSyntheticErasureControl({
		runId,
		now: startedAt,
	});
	const loadFixture = createSyntheticLoadEvents({
		runId,
		count: Number(process.env.PERFORMANCE_EVENT_COUNT ?? 1_000),
		now: startedAt,
	});
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
		erasure: {
			controlRunHash: hashIdentifier(erasureControl.runId),
			identityHash: hashIdentifier(
				`${fixture.userId}:${fixture.organizationId}:${fixture.anonymousId}`,
			),
			controlAttempted: false,
			controlAccepted: false,
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
	artifact.load.rowsAttempted = loadFixture.rows.length;
	writeJson(artifactPath, artifact);
	const loadStartedAt = performance.now();
	const loadDelivery = await request(
		tinybirdUrl(origin, "/v0/events", {
			name: "product_events_v1",
			wait: "true",
			__tb__min_deployment: deploymentId,
		}),
		{
			token: tokens.TINYBIRD_STAGING_INGEST_TOKEN,
			method: "POST",
			body: `${loadFixture.rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
			headers: { "Content-Type": "application/x-ndjson" },
			attempts: 4,
		},
	);
	const loadElapsedMs = Math.max(
		1,
		Math.round(performance.now() - loadStartedAt),
	);
	artifact.load = {
		rows: loadFixture.rows.length,
		rowsPlanned: loadFixture.rows.length,
		rowsAttempted: loadFixture.rows.length,
		rowsAccepted: loadFixture.rows.length,
		requestLatencyMs: loadDelivery.latencyMs,
		retryAttempts: loadDelivery.attempt - 1,
		rowsPerSecond: Math.round(
			(loadFixture.rows.length * 1_000) / loadElapsedMs,
		),
	};
	writeJson(artifactPath, artifact);
	artifact.erasure.controlAttempted = true;
	writeJson(artifactPath, artifact);
	const erasureControlDelivery = await deliver(erasureControl.row);
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
			canonicalEvents: ["staged", "promoted"].includes(phase)
				? state.loadEventCount
				: 0,
			decisionEvents: ["staged", "promoted"].includes(phase)
				? state.loadEventCount
				: 0,
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
			canonicalEvents: phase === "cleanup" ? 0 : 1,
			decisionEvents: phase === "cleanup" ? 0 : 1,
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
	const [main, load, control, preview] = await Promise.all([
		healthQuery({ state, deploymentId }),
		healthQuery({
			state,
			deploymentId,
			appVersion: state.loadAppVersion,
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
	} else {
		assertZeroHealth(health.main);
		assertZeroHealth(health.load);
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
	if (!["live", "staging"].includes(requestedTarget)) {
		throw new Error("Tinybird copy target is invalid");
	}
	if (requestedTarget === "staging" && !["staged", "cleanup"].includes(phase)) {
		throw new Error("Only staged and cleanup copy phases can target staging");
	}
	if (String(state.deploymentId) !== option("deployment-id")) {
		throw new Error("Tinybird copy deployment does not match the seeded run");
	}
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_READ_TOKEN",
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
			token: tokens.TINYBIRD_STAGING_READ_TOKEN,
			deploymentId: state.deploymentId,
			request,
			pipes: ["snapshot_product_events_canonical_v1"],
			useDeploymentParameter: target === "staging",
			assertMutationOwnership,
		});
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
				read: () =>
					readPhaseCiAssertions({
						state,
						deploymentId: state.deploymentId,
						expectations,
					}),
				assert: (results) =>
					assertPhaseCiAssertions(results, ["decisionEvents"]),
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
				pipe: "snapshot_product_events_health_hourly",
				read: () =>
					readAndAssertPhaseHealth({
						state,
						phase,
						deploymentId: state.deploymentId,
					}),
				assert: () => undefined,
			},
		];
		for (const copyStep of copySteps) {
			downstreamJobs.push(
				...(await submitTinybirdCopyJobs({
					origin,
					token: tokens.TINYBIRD_STAGING_READ_TOKEN,
					deploymentId: state.deploymentId,
					request,
					pipes: [copyStep.pipe],
					useDeploymentParameter: target === "staging",
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
	if (target === "staging") {
		const [liveHealthResult, liveLoadResult, liveControlResult, liveDecisions] =
			await Promise.all([
				healthQuery({ state }),
				healthQuery({ state, appVersion: state.loadAppVersion }),
				healthQuery({ state, appVersion: state.erasureControlAppVersion }),
				ciAssertionsQuery({ state }),
			]);
		for (const liveHealth of [
			normalizeHealth(liveHealthResult.data),
			normalizeHealth(liveLoadResult.data),
			normalizeHealth(liveControlResult.data),
		]) {
			assertZeroHealth(liveHealth);
		}
		if (
			Object.values(normalizeCiAssertions(liveDecisions.data)).some(
				(value) => value !== 0,
			)
		) {
			throw new Error(
				"Candidate-only synthetic events affected live decisions",
			);
		}
		artifact.candidateIsolation = {
			candidateDeploymentId: state.deploymentId,
			candidateVisible: true,
			liveVisible: false,
		};
		artifact.assertions.candidateIsolationPassed = true;
	}
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
	const decisionQueries = decisionEndpointQueries({
		startDate: state.startTime.slice(0, 10),
		endDate: state.endTime.slice(0, 10),
		deploymentId: state.deploymentId,
	});
	const baselineSamples = Object.fromEntries(
		decisionQueries.map(({ name }) => [name, []]),
	);
	const measuredSamples = Object.fromEntries(
		decisionQueries.map(({ name }) => [name, []]),
	);
	const baselineFanoutSamples = [];
	const measuredFanoutSamples = [];
	const sampleDecisionRound = async (endpointSamples, fanoutSamples) => {
		const startedAt = performance.now();
		const results = await Promise.all(
			decisionQueries.map((query) =>
				decisionEndpointQuery({
					origin,
					token: tokens.TINYBIRD_STAGING_READ_TOKEN,
					...query,
				}),
			),
		);
		fanoutSamples.push(Math.round(performance.now() - startedAt));
		for (let index = 0; index < results.length; index += 1) {
			endpointSamples[decisionQueries[index].name].push(
				results[index].latencyMs,
			);
		}
	};
	for (let index = 0; index < 5; index += 1) {
		await sampleDecisionRound(baselineSamples, baselineFanoutSamples);
	}
	for (let index = 0; index < 15; index += 1) {
		await sampleDecisionRound(measuredSamples, measuredFanoutSamples);
	}
	const regressionFactor = Number(process.env.ENDPOINT_REGRESSION_FACTOR ?? 3);
	const regressionFloorMs = Number(
		process.env.ENDPOINT_REGRESSION_FLOOR_MS ?? 500,
	);
	const decisionEndpointLatency = Object.fromEntries(
		decisionQueries.map(({ name }) => {
			const baseline = latencySummary(baselineSamples[name]);
			const measured = latencySummary(measuredSamples[name]);
			return [
				name,
				{
					baseline,
					measured,
					budget: evaluateLatencyBudget({
						baseline,
						measured,
						absoluteP95Ms: endpointP95BudgetMs,
						regressionFactor,
						regressionFloorMs,
					}),
				},
			];
		}),
	);
	const fanoutP95BudgetMs = Number(
		process.env.DASHBOARD_FANOUT_P95_BUDGET_MS ?? 3_500,
	);
	const dashboardBaseline = latencySummary(baselineFanoutSamples);
	const dashboardMeasured = latencySummary(measuredFanoutSamples);
	const dashboardBudget = evaluateLatencyBudget({
		baseline: dashboardBaseline,
		measured: dashboardMeasured,
		absoluteP95Ms: fanoutP95BudgetMs,
		regressionFactor,
		regressionFloorMs,
	});
	const failedDecisionEndpoints = Object.entries(decisionEndpointLatency)
		.filter(([, value]) => !value.budget.passed)
		.map(([name]) => name);
	artifact.health = health;
	artifact.decisionAssertions = decisionAssertions;
	artifact.load.health = loadHealth;
	artifact.visibilityMs = Date.now() - Date.parse(state.startedAt);
	artifact.endpointLatency = endpointLatency;
	artifact.decisionEndpointLatency = decisionEndpointLatency;
	artifact.dashboardFanoutLatency = {
		baseline: dashboardBaseline,
		measured: dashboardMeasured,
		budget: dashboardBudget,
	};
	const ingestionSloMs = Number(process.env.INGESTION_SLO_MS ?? 180_000);
	const ingestionSloPassed = artifact.visibilityMs <= ingestionSloMs;
	const endpointBudgetPassed = endpointLatency.p95Ms <= endpointP95BudgetMs;
	const decisionEndpointBudgetsPassed =
		failedDecisionEndpoints.length === 0 && dashboardBudget.passed;
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
				...(dashboardBudget.passed ? [] : ["dashboard_fanout"]),
			].join(", ")}`,
		);
	}
};

const safeSyntheticIdentifier = (value, name) => {
	if (!/^synthetic_[A-Za-z0-9_-]{8,128}$/.test(value)) {
		throw new Error(`${name} is not a safe synthetic identifier`);
	}
	return value;
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
	const userId = safeSyntheticIdentifier(
		state.erasureUserId,
		"Synthetic erasure user ID",
	);
	const organizationId = safeSyntheticIdentifier(
		state.erasureOrganizationId,
		"Synthetic erasure organization ID",
	);
	const anonymousId = safeSyntheticIdentifier(
		state.erasureAnonymousId,
		"Synthetic erasure anonymous ID",
	);
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_CLEANUP_TOKEN",
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
	]);
	const assertLiveOwnership = async () => {
		if (
			(await ownedMutationTarget({
				state,
				origin,
				token: tokens.TINYBIRD_STAGING_DEPLOY_TOKEN,
			})) !== "live"
		) {
			throw new Error("The owned Tinybird deployment is no longer live");
		}
	};
	const rowsAffected = await deleteProductEventRows({
		origin,
		token: tokens.TINYBIRD_STAGING_CLEANUP_TOKEN,
		condition: `organization_id = '${organizationId}' OR user_id = '${userId}' OR (anonymous_id = '${anonymousId}' AND (user_id = '' OR user_id = '${userId}'))`,
		beforeAttempt: assertLiveOwnership,
	});
	artifact.erasure = {
		...artifact.erasure,
		deleteJobCompleted: true,
		rowsAffected,
	};
	writeJson(artifactPath, artifact);
};

const verifySyntheticIdentityErasure = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	const artifact = readJson(artifactPath);
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
	const erasedDecisions = normalizeCiAssertions(
		(
			await ciAssertionsQuery({
				state,
				deploymentId: state.deploymentId,
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
	if (
		Object.values(erasedHealth).some((value) => value !== 0) ||
		Object.values(erasedLoadHealth).some((value) => value !== 0) ||
		Object.values(erasedDecisions).some((value) => value !== 0)
	) {
		throw new Error(
			"Synthetic identity erasure left raw-health or decision-facing state",
		);
	}
	assertSingleHealth(previewHealth);
	if (
		previewDecisions.canonicalEvents !== 1 ||
		previewDecisions.decisionEvents !== 1
	) {
		throw new Error(
			"Synthetic identity erasure corrupted the unrelated preview control",
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
		erasedDecisions,
		previewHealth,
		previewDecisions,
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
	validateSyntheticRunId(state.erasureControlRunId);
	const runIds = [state.runId, state.loadRunId, state.erasureControlRunId];
	if (state.previewRunId) {
		runIds.push(validateSyntheticRunId(state.previewRunId));
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
		previewDecisionAssertions.uniqueEvents !== 1 ||
		previewDecisionAssertions.uniquePayloads !== 1 ||
		previewDecisionAssertions.duplicateRows !==
			previewDecisionAssertions.receivedRows - 1 ||
		previewDecisionAssertions.payloadConflicts !== 0 ||
		previewDecisionAssertions.canonicalEvents !== 1 ||
		previewDecisionAssertions.decisionEvents !== 1
	) {
		throw new Error(
			"The promoted preview run did not preserve exact retry-deduplicated decisions",
		);
	}
	artifact.previewApi.health = previewHealth;
	artifact.previewApi.decisionAssertions = {
		seed: seedDecisionAssertions,
		preview: previewDecisionAssertions,
	};
	artifact.previewApi.endpointLatencyMs = previewHealthResult.latencyMs;
	artifact.assertions.promotedPreviewDataPassed = true;
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
	artifact.cleanup = {
		...artifact.cleanup,
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
		ingestTokenAppendAuthorized: true,
		ingestTokenAggregateReadDenied: true,
		cleanupTokenAggregateReadDenied: true,
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
	verify,
	"probe-preview": probePreview,
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
