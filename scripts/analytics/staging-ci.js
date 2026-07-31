import fs from "node:fs";
import process from "node:process";

import {
	assertExecutionScope,
	assertPromotedSyntheticDecisions,
	assertSyntheticDecisions,
	assertSyntheticHealth,
	createSyntheticEvents,
	createSyntheticLoadEvents,
	hashIdentifier,
	latencySummary,
	normalizeCiAssertions,
	normalizeHealth,
	STAGING_WORKSPACE_ID,
	selectStagingDeployment,
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
	{ token, method = "GET", body, headers = {}, attempts = 1 } = {},
) => {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const startedAt = performance.now();
		try {
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

const ciAssertionsQuery = async ({ state, deploymentId = "" }) => {
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_READ_TOKEN",
	]);
	return request(
		tinybirdUrl(origin, "/v0/pipes/product_analytics_ci_assertions.json", {
			synthetic_run_id: state.runId,
			__tb__deployment: deploymentId,
		}),
		{ token: tokens.TINYBIRD_STAGING_READ_TOKEN, attempts: 3 },
	);
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
		signal: AbortSignal.timeout(20_000),
	});
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
	const event = {
		eventId: `synthetic_preview_${runHash.slice(0, 24)}`,
		eventName: "page_view",
		occurredAt,
		anonymousId,
		sessionId: `synthetic_preview_${runHash.slice(24, 48)}`,
		platform: "web",
		appVersion: `staging-preview-${runHash.slice(0, 12)}`,
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
		},
	});
	const post = (cookieHeader = cookies) =>
		previewRequest(new URL("/api/events", previewOrigin), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: cookieHeader,
				Origin: previewOrigin,
				"Sec-Fetch-Site": "same-origin",
				"User-Agent": "Cap-Analytics-Staging-E2E/1.0",
				"x-cap-analytics-test-run": state.runId,
			},
			body,
		});
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
	state.previewAppVersion = event.appVersion;
	state.previewAcceptedRows = duplicateResponses.length + replayAccepted;
	writeJson(statePath, state, 0o600);
	artifact.previewApi = {
		bootstrapPassed: true,
		missingTokenRejected: true,
		expiredTokenRejected: true,
		concurrentDuplicateAccepted: true,
		replayAcceptedBeforeRateLimit: replayAccepted,
		rateLimitPassed: true,
	};
	artifact.assertions = {
		...artifact.assertions,
		previewApiPassed: true,
		invalidTokenRejected: true,
		expiredTokenRejected: true,
		tokenReplayBounded: true,
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
	const loadFixture = createSyntheticLoadEvents({
		runId,
		count: Number(process.env.PERFORMANCE_EVENT_COUNT ?? 1_000),
		now: startedAt,
	});
	const state = {
		runId,
		deploymentId,
		appVersion: fixture.appVersion,
		loadAppVersion: loadFixture.appVersion,
		loadRunId: loadFixture.runId,
		loadEventCount: loadFixture.rows.length,
		startedAt: startedAt.toISOString(),
		startTime: new Date(startedAt.getTime() - 120_000).toISOString(),
		endTime: new Date(startedAt.getTime() + 300_000).toISOString(),
	};
	writeJson(statePath, state, 0o600);
	const deliver = async (row) => {
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
		return { attempts: result.attempt, latencyMs: result.latencyMs };
	};
	const concurrentDeliveries = await Promise.all(
		fixture.rows.slice(0, 2).map(deliver),
	);
	const separateBatchDeliveries = [];
	for (const row of fixture.rows.slice(2)) {
		separateBatchDeliveries.push(await deliver(row));
	}
	const deliveries = [...concurrentDeliveries, ...separateBatchDeliveries];
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
	writeJson(artifactPath, {
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
			rowsAttempted: fixture.rows.length,
			rowsAccepted: deliveries.length,
			requestLatency: latencySummary(
				deliveries.map((delivery) => delivery.latencyMs),
			),
			retryAttempts: deliveries.reduce(
				(total, delivery) => total + delivery.attempts - 1,
				0,
			),
		},
		load: {
			rows: loadFixture.rows.length,
			requestLatencyMs: loadDelivery.latencyMs,
			retryAttempts: loadDelivery.attempt - 1,
			rowsPerSecond: Math.round(
				(loadFixture.rows.length * 1_000) / loadElapsedMs,
			),
		},
		assertions: { seedAccepted: true },
	});
};

const verify = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	const artifact = readJson(artifactPath);
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
	artifact.health = health;
	artifact.decisionAssertions = decisionAssertions;
	artifact.load.health = loadHealth;
	artifact.visibilityMs = Date.now() - Date.parse(state.startedAt);
	artifact.endpointLatency = endpointLatency;
	const ingestionSloMs = Number(process.env.INGESTION_SLO_MS ?? 180_000);
	const ingestionSloPassed = artifact.visibilityMs <= ingestionSloMs;
	const endpointBudgetPassed = endpointLatency.p95Ms <= endpointP95BudgetMs;
	artifact.budgets = {
		ingestionVisibilityMs: ingestionSloMs,
		endpointP95Ms: endpointP95BudgetMs,
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
};

const cleanup = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	validateSyntheticRunId(state.runId);
	const { origin, tokens } = tinybirdEnvironment([
		"TINYBIRD_STAGING_CLEANUP_TOKEN",
	]);
	validateSyntheticRunId(state.loadRunId);
	const body = new URLSearchParams({
		delete_condition: `synthetic_run_id IN ('${state.runId}', '${state.loadRunId}')`,
	});
	const deletion = await request(
		tinybirdUrl(origin, "/v0/datasources/product_events_v1/delete"),
		{
			token: tokens.TINYBIRD_STAGING_CLEANUP_TOKEN,
			method: "POST",
			body,
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			attempts: 3,
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
			tinybirdUrl(origin, `/v0/jobs/${encodeURIComponent(jobId)}`),
			{ token: tokens.TINYBIRD_STAGING_CLEANUP_TOKEN, attempts: 3 },
		);
		const status = String(
			job.data.status ?? job.data.state ?? job.data.job?.status ?? "",
		).toLowerCase();
		if (["done", "success", "finished", "completed"].includes(status)) {
			const artifact = readJson(artifactPath);
			artifact.cleanup = {
				deleteJobCompleted: true,
				rowsAffected: Number(job.data.rows_affected ?? 0),
			};
			writeJson(artifactPath, artifact);
			return;
		}
		if (["failed", "error", "cancelled"].includes(status)) {
			throw new Error(`Tinybird cleanup job ended in ${status}`);
		}
		await delay(2_000);
	}
	throw new Error("Timed out waiting for Tinybird synthetic cleanup");
};

const verifyPromoted = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	const artifact = readJson(artifactPath);
	if (!state.previewAppVersion || !state.previewAcceptedRows) {
		throw new Error("The exact-SHA preview probe did not complete");
	}
	const previewHealthResult = await healthQuery({
		state,
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
	const decisionResult = await ciAssertionsQuery({ state });
	const decisionAssertions = normalizeCiAssertions(decisionResult.data);
	assertPromotedSyntheticDecisions(decisionAssertions);
	artifact.previewApi.health = previewHealth;
	artifact.previewApi.decisionAssertions = decisionAssertions;
	artifact.previewApi.endpointLatencyMs = previewHealthResult.latencyMs;
	artifact.assertions.promotedPreviewDataPassed = true;
	writeJson(artifactPath, artifact);
};

const verifyCleanup = async () => {
	const state = readJson(option("state"));
	const artifactPath = option("artifact");
	const artifact = readJson(artifactPath);
	const result = await healthQuery({ state });
	const health = normalizeHealth(result.data);
	if (Object.values(health).some((value) => value !== 0)) {
		throw new Error(
			"Synthetic rows still affect Tinybird health after cleanup",
		);
	}
	const decisionResult = await ciAssertionsQuery({ state });
	const decisionAssertions = normalizeCiAssertions(decisionResult.data);
	if (Object.values(decisionAssertions).some((value) => value !== 0)) {
		throw new Error(
			"Synthetic rows still affect Tinybird decision assertions after cleanup",
		);
	}
	const loadResult = await healthQuery({
		state,
		appVersion: state.loadAppVersion,
	});
	const loadHealth = normalizeHealth(loadResult.data);
	if (Object.values(loadHealth).some((value) => value !== 0)) {
		throw new Error(
			"Synthetic load rows still affect Tinybird health after cleanup",
		);
	}
	artifact.cleanup = {
		...artifact.cleanup,
		passed: true,
		verifiedAt: new Date().toISOString(),
	};
	artifact.assertions = { ...artifact.assertions, cleanupPassed: true };
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
	"select-deployment": async () => {
		const id = selectStagingDeployment(
			readJson(option("input")),
			option("minimum-created-at"),
		);
		writeOutput("id", id);
	},
	"wait-vercel": waitForVercel,
	seed,
	verify,
	"probe-preview": probePreview,
	"verify-promoted": verifyPromoted,
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
