import { createHash } from "node:crypto";

export const STAGING_WORKSPACE_ID = "37b8fef9-817f-4c3c-b21f-218c36a6077d";
export const FEATURE_BRANCH = "codex/first-party-analytics";
export const FEATURE_PULL_REQUEST = 2003;
export const COPY_PIPES = [
	"snapshot_product_events_canonical_v1",
	"snapshot_product_events_daily_exact",
	"snapshot_product_traffic_daily_exact",
	"snapshot_product_traffic_pages_daily_exact",
	"snapshot_product_activation_daily_exact",
	"snapshot_product_creator_retention_exact",
	"snapshot_product_events_health_hourly",
];
const COPY_MARKER_PIPES = new Set([
	"snapshot_product_traffic_daily_exact",
	"snapshot_product_traffic_pages_daily_exact",
	"snapshot_product_activation_daily_exact",
	"snapshot_product_creator_retention_exact",
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SYNTHETIC_RUN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const COPY_JOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const DEPLOYMENT_ID_PATTERN = /^[0-9]+$/;

export const assertExecutionScope = ({
	eventName,
	eventNumber,
	headRef,
	ref,
	expectedSha,
	actualSha,
}) => {
	if (!SHA_PATTERN.test(expectedSha) || expectedSha !== actualSha) {
		throw new Error(
			"The checked-out commit does not match the requested Git SHA",
		);
	}
	if (eventName === "pull_request") {
		if (
			Number(eventNumber) !== FEATURE_PULL_REQUEST ||
			headRef !== FEATURE_BRANCH
		) {
			throw new Error(
				"This workflow is restricted to the analytics pull request",
			);
		}
		return;
	}
	if (eventName === "workflow_dispatch") {
		if (ref !== `refs/heads/${FEATURE_BRANCH}`) {
			throw new Error(
				"Manual staging runs must use the analytics feature branch",
			);
		}
		return;
	}
	throw new Error("This event cannot deploy analytics staging");
};

export const tokenWorkspaceId = (token) => {
	const segments = token.split(".");
	if (segments.length < 3 || !segments[1]) {
		throw new Error("A Tinybird staging token has an unsupported format");
	}
	let payload;
	try {
		payload = JSON.parse(
			Buffer.from(segments[1], "base64url").toString("utf8"),
		);
	} catch {
		throw new Error("A Tinybird staging token cannot be decoded");
	}
	const workspaceId = payload.u ?? payload.workspace_id ?? payload.workspaceId;
	if (typeof workspaceId !== "string") {
		throw new Error("A Tinybird staging token does not identify its workspace");
	}
	return workspaceId;
};

export const validateTinybirdCredentials = ({ url, tokens }) => {
	let parsedUrl;
	try {
		parsedUrl = new URL(url);
	} catch {
		throw new Error("TINYBIRD_STAGING_URL must be a valid URL");
	}
	if (
		parsedUrl.protocol !== "https:" ||
		parsedUrl.username ||
		parsedUrl.password ||
		parsedUrl.pathname !== "/" ||
		parsedUrl.search ||
		parsedUrl.hash ||
		!parsedUrl.hostname.endsWith(".tinybird.co")
	) {
		throw new Error("TINYBIRD_STAGING_URL must be an HTTPS Tinybird API host");
	}
	for (const [name, token] of Object.entries(tokens)) {
		if (!token) {
			throw new Error(`${name} is required`);
		}
		if (
			tokenWorkspaceId(token).toLowerCase() !==
			STAGING_WORKSPACE_ID.toLowerCase()
		) {
			throw new Error(
				`${name} is not scoped to the analytics staging workspace`,
			);
		}
	}
	return parsedUrl.origin;
};

const deploymentId = (deployment) =>
	deployment.id ?? deployment.ID ?? deployment.deployment_id;

const deploymentState = (deployment) =>
	String(
		deployment.status ??
			deployment.Status ??
			deployment.state ??
			deployment.environment ??
			"",
	).toLowerCase();

export const selectStagingDeployment = (
	value,
	minimumCreatedAt,
	createdDeploymentId,
	noOpConfirmed = false,
) => {
	const candidates = Array.isArray(value)
		? value
		: (value.deployments ?? value.data ?? value.results ?? []);
	if (!Array.isArray(candidates)) {
		throw new Error("Tinybird returned an unsupported deployment list");
	}
	const minimumTime = Date.parse(minimumCreatedAt);
	const stagingDeployments = candidates
		.filter((candidate) => {
			const createdAt = Date.parse(
				candidate.created_at ??
					candidate.createdAt ??
					candidate["Created at"] ??
					candidate.created ??
					"",
			);
			return (
				deploymentState(candidate).includes("staging") &&
				Number.isFinite(createdAt) &&
				createdAt >= minimumTime
			);
		})
		.sort(
			(a, b) =>
				Date.parse(
					b.created_at ?? b.createdAt ?? b["Created at"] ?? b.created,
				) -
				Date.parse(a.created_at ?? a.createdAt ?? a["Created at"] ?? a.created),
		);
	if (createdDeploymentId) {
		const matching = stagingDeployments.filter(
			(deployment) => String(deploymentId(deployment)) === createdDeploymentId,
		);
		if (matching.length !== 1) {
			throw new Error(
				"The created Tinybird deployment is missing, stale, or ambiguous",
			);
		}
		return { id: createdDeploymentId, needsPromotion: true };
	}
	if (stagingDeployments.length > 0) {
		throw new Error(
			"Tinybird reported a staging deployment that was not created by this run",
		);
	}
	if (!noOpConfirmed) {
		throw new Error("Tinybird did not prove that this was a no-op deployment");
	}
	const liveDeployments = candidates.filter((candidate) =>
		deploymentState(candidate).includes("live"),
	);
	if (liveDeployments.length !== 1) {
		throw new Error(
			"Expected exactly one live Tinybird deployment for a no-op",
		);
	}
	const id = deploymentId(liveDeployments[0]);
	if (typeof id !== "string" && typeof id !== "number") {
		throw new Error("The live Tinybird deployment does not have an ID");
	}
	return { id: String(id), needsPromotion: false };
};

export const dataMutationDeploymentParameters = ({
	target,
	deploymentId,
	expectedDeploymentId,
}) => {
	if (!["live", "staging"].includes(target)) {
		throw new Error("Tinybird data mutation target is invalid");
	}
	if (
		!DEPLOYMENT_ID_PATTERN.test(deploymentId) ||
		deploymentId !== expectedDeploymentId
	) {
		throw new Error("Tinybird data mutation deployment is invalid");
	}
	return target === "staging" ? { __tb__deployment: deploymentId } : {};
};

export const submitTinybirdCopyJobs = async ({
	origin,
	token,
	deploymentId,
	request,
	now = () => Date.now(),
	pipes = COPY_PIPES,
	useDeploymentParameter = false,
	copyRunId = "",
}) => {
	if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
		throw new Error("Tinybird copy jobs require a numeric deployment ID");
	}
	if (copyRunId) validateSyntheticRunId(copyRunId);
	const results = [];
	for (const pipe of pipes) {
		if (!COPY_PIPES.includes(pipe)) {
			throw new Error("Tinybird copy job requested an unapproved pipe");
		}
		const startedAt = now();
		const copyUrl = new URL(
			`/v0/pipes/${encodeURIComponent(pipe)}/copy`,
			origin,
		);
		copyUrl.searchParams.set("_mode", "replace");
		if (useDeploymentParameter) {
			copyUrl.searchParams.set("__tb__deployment", deploymentId);
		}
		if (COPY_MARKER_PIPES.has(pipe)) {
			if (!copyRunId) {
				throw new Error(`Tinybird copy marker is required for ${pipe}`);
			}
			copyUrl.searchParams.set("copy_run_id", copyRunId);
		}
		let created;
		try {
			created = await request(copyUrl, {
				token,
				method: "POST",
				attempts: 3,
			});
		} catch (error) {
			throw new Error(`Tinybird copy submission failed for ${pipe}`, {
				cause: error,
			});
		}
		const jobId = String(created.data.id ?? created.data.job_id ?? "");
		if (!COPY_JOB_ID_PATTERN.test(jobId)) {
			throw new Error(`Tinybird did not return a valid copy job for ${pipe}`);
		}
		results.push({
			pipe,
			jobId,
			submissionLatencyMs: Math.max(0, now() - startedAt),
		});
	}
	return results;
};

export const validateSyntheticRunId = (runId) => {
	if (!SYNTHETIC_RUN_PATTERN.test(runId)) {
		throw new Error("Synthetic run ID has an unsafe format");
	}
	return runId;
};

export const hashIdentifier = (value) =>
	createHash("sha256").update(value).digest("hex");

export const extractSameOriginNextScriptUrls = (html, origin) => {
	const urls = new Set();
	const pattern = /<script\b[^>]*\bsrc=(['"])(.*?)\1/gi;
	for (const match of html.matchAll(pattern)) {
		try {
			const url = new URL(match[2], origin);
			if (url.origin === origin && url.pathname.startsWith("/_next/static/")) {
				urls.add(url.href);
			}
		} catch {}
	}
	return [...urls].sort();
};

export const evaluateBundleBudget = ({
	baselineBytes,
	measuredBytes,
	absoluteMaximumBytes,
	regressionFactor,
	regressionFloorBytes,
}) => {
	if (
		![
			baselineBytes,
			measuredBytes,
			absoluteMaximumBytes,
			regressionFactor,
			regressionFloorBytes,
		].every(Number.isFinite) ||
		baselineBytes <= 0 ||
		measuredBytes <= 0 ||
		absoluteMaximumBytes <= 0 ||
		regressionFactor < 1 ||
		regressionFloorBytes < 0
	) {
		throw new Error("Bundle budget inputs must be finite and positive");
	}
	const regressionLimitBytes = Math.ceil(
		Math.max(
			baselineBytes * regressionFactor,
			baselineBytes + regressionFloorBytes,
		),
	);
	return {
		absoluteMaximumBytes,
		regressionLimitBytes,
		deltaBytes: measuredBytes - baselineBytes,
		regressionRatio: measuredBytes / baselineBytes,
		passed:
			measuredBytes <= absoluteMaximumBytes &&
			measuredBytes <= regressionLimitBytes,
	};
};

export const createSyntheticEvents = ({ runId, now = new Date() }) => {
	validateSyntheticRunId(runId);
	const runHash = hashIdentifier(runId);
	const timestamp = now.toISOString().replace("T", " ").replace("Z", "");
	const userId = `synthetic_user_${runHash.slice(0, 24)}`;
	const organizationId = `synthetic_org_${runHash.slice(24, 48)}`;
	const anonymousId = `synthetic_${runHash.slice(0, 24)}`;
	const shared = {
		occurred_at: timestamp,
		received_at: timestamp,
		event_name: "page_view",
		schema_version: 1,
		source: "client",
		platform: "web",
		anonymous_id: anonymousId,
		session_id: `synthetic_${runHash.slice(24, 48)}`,
		user_id: userId,
		organization_id: organizationId,
		app_version: `staging-e2e-${runHash.slice(0, 12)}`,
		pathname: "/analytics-synthetic",
		referrer: "",
		country: "",
		region: "",
		city: "",
		hostname: "preview.cap.so",
		browser: "synthetic",
		device: "synthetic",
		os: "synthetic",
		channel: "synthetic",
		traffic_class: "synthetic",
		synthetic_run_id: runId,
		properties: JSON.stringify({ test_case: "staging_delivery" }),
	};
	const duplicateId = `synthetic_duplicate_${runHash.slice(0, 24)}`;
	const conflictId = `synthetic_conflict_${runHash.slice(0, 24)}`;
	const duplicateHash = hashIdentifier(`${runId}:duplicate`).slice(0, 32);
	const conflictHashA = hashIdentifier(`${runId}:conflict:a`).slice(0, 32);
	const conflictHashB = hashIdentifier(`${runId}:conflict:b`).slice(0, 32);
	return {
		appVersion: shared.app_version,
		anonymousId,
		organizationId,
		userId,
		rows: [
			{ ...shared, event_id: duplicateId, payload_hash: duplicateHash },
			{ ...shared, event_id: duplicateId, payload_hash: duplicateHash },
			{ ...shared, event_id: conflictId, payload_hash: conflictHashA },
			{ ...shared, event_id: conflictId, payload_hash: conflictHashB },
		],
	};
};

export const createSyntheticErasureControl = ({ runId, now = new Date() }) => {
	const fixture = createSyntheticEvents({ runId, now });
	const controlRunId = `${runId}_erasure_control`;
	validateSyntheticRunId(controlRunId);
	const controlHash = hashIdentifier(controlRunId);
	const eventId = `synthetic_erasure_control_${controlHash.slice(0, 24)}`;
	return {
		appVersion: `staging-erasure-control-${controlHash.slice(0, 12)}`,
		runId: controlRunId,
		row: {
			...fixture.rows[0],
			event_id: eventId,
			payload_hash: hashIdentifier(eventId).slice(0, 32),
			user_id: `synthetic_control_user_${controlHash.slice(0, 16)}`,
			organization_id: `synthetic_control_org_${controlHash.slice(16, 32)}`,
			app_version: `staging-erasure-control-${controlHash.slice(0, 12)}`,
			synthetic_run_id: controlRunId,
			properties: JSON.stringify({ test_case: "staging_erasure_control" }),
		},
	};
};

export const createSyntheticLoadEvents = ({
	runId,
	count,
	now = new Date(),
}) => {
	if (!Number.isInteger(count) || count < 100 || count > 10_000) {
		throw new Error("Synthetic load size must be between 100 and 10000 rows");
	}
	const fixture = createSyntheticEvents({ runId, now });
	const runHash = hashIdentifier(runId);
	const appVersion = `staging-load-${runHash.slice(0, 12)}`;
	const loadRunId = `${runId}_load`;
	validateSyntheticRunId(loadRunId);
	return {
		appVersion,
		runId: loadRunId,
		rows: Array.from({ length: count }, (_, index) => {
			const eventId = `synthetic_load_${hashIdentifier(`${runId}:${index}`).slice(0, 24)}`;
			return {
				...fixture.rows[0],
				event_id: eventId,
				payload_hash: hashIdentifier(eventId).slice(0, 32),
				app_version: appVersion,
				synthetic_run_id: loadRunId,
				properties: JSON.stringify({ test_case: "staging_load" }),
			};
		}),
	};
};

export const normalizeHealth = (payload) => {
	const row = payload?.data?.[0] ?? {};
	const number = (value) => Number(value ?? 0);
	return {
		receivedRows: number(row.received_rows),
		uniqueEvents: number(row.unique_events),
		uniquePayloads: number(row.unique_payloads),
		duplicateRows: number(row.duplicate_rows),
		payloadConflicts: number(row.payload_conflicts),
	};
};

export const normalizeCiAssertions = (payload) => {
	const row = payload?.data?.[0] ?? {};
	const number = (value) => Number(value ?? 0);
	return {
		receivedRows: number(row.received_rows),
		uniqueEvents: number(row.unique_events),
		uniquePayloads: number(row.unique_payloads),
		duplicateRows: number(row.duplicate_rows),
		payloadConflicts: number(row.payload_conflicts),
		canonicalEvents: number(row.canonical_events),
		decisionEvents: number(row.decision_events),
	};
};

export const normalizeCopyAssertions = (payload) => {
	const row = payload?.data?.[0] ?? {};
	const number = (value) => Number(value ?? 0);
	return {
		trafficMarkers: number(row.traffic_markers),
		trafficPageMarkers: number(row.traffic_page_markers),
		activationMarkers: number(row.activation_markers),
		retentionMarkers: number(row.retention_markers),
	};
};

export const assertSyntheticDecisions = (assertions) => {
	assertSyntheticHealth(assertions);
	if (assertions.decisionEvents !== 1) {
		throw new Error(
			`Synthetic decision events were ${assertions.decisionEvents}, expected 1`,
		);
	}
	if (assertions.canonicalEvents !== 1) {
		throw new Error(
			`Synthetic canonical events were ${assertions.canonicalEvents}, expected 1`,
		);
	}
};

export const assertSyntheticHealth = (health) => {
	const expected = {
		uniqueEvents: 2,
		uniquePayloads: 3,
		payloadConflicts: 1,
	};
	for (const [name, value] of Object.entries(expected)) {
		if (health[name] !== value) {
			throw new Error(
				`Synthetic health ${name} was ${health[name]}, expected ${value}`,
			);
		}
	}
	if (
		health.receivedRows < 4 ||
		health.duplicateRows !== health.receivedRows - health.uniquePayloads
	) {
		throw new Error("Synthetic health did not preserve retry duplicate counts");
	}
};

export const percentile = (samples, quantile) => {
	if (samples.length === 0) {
		throw new Error("At least one latency sample is required");
	}
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.ceil(quantile * sorted.length) - 1];
};

export const latencySummary = (samples) => ({
	count: samples.length,
	minMs: Math.min(...samples),
	maxMs: Math.max(...samples),
	p50Ms: percentile(samples, 0.5),
	p95Ms: percentile(samples, 0.95),
	p99Ms: percentile(samples, 0.99),
});

const DECISION_ENDPOINT_NAMES = [
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
	"product_analytics_freshness",
];

export const decisionEndpointQueries = ({
	startDate,
	endDate,
	deploymentId = "",
}) =>
	DECISION_ENDPOINT_NAMES.map((name) => ({
		name,
		parameters: {
			...(name === "product_analytics_freshness"
				? {}
				: name === "product_creator_activity"
					? { as_of_date: endDate }
					: { start_date: startDate, end_date: endDate }),
			__tb__deployment: deploymentId,
		},
	}));

export const evaluateLatencyBudget = ({
	baseline,
	measured,
	absoluteP95Ms,
	regressionFactor,
	regressionFloorMs,
}) => {
	const regressionLimitMs = Math.max(
		baseline.p95Ms * regressionFactor,
		baseline.p95Ms + regressionFloorMs,
	);
	return {
		absoluteP95Ms,
		regressionLimitMs,
		regressionRatio:
			baseline.p95Ms === 0 ? null : measured.p95Ms / baseline.p95Ms,
		passed:
			measured.p95Ms <= absoluteP95Ms && measured.p95Ms <= regressionLimitMs,
	};
};

export const assertWorkflowSafety = (workflow) => {
	const forbidden = [
		"\n  push:",
		"branches:\n      - main",
		"environment: production",
		"analytics-production",
		"TINYBIRD_PRODUCTION",
		"Deploy the checked Tinybird project to production",
	];
	for (const text of forbidden) {
		if (workflow.includes(text)) {
			throw new Error(`Workflow contains forbidden production path: ${text}`);
		}
	}
	for (const required of [
		STAGING_WORKSPACE_ID,
		FEATURE_BRANCH,
		String(FEATURE_PULL_REQUEST),
		"cancel-in-progress: true",
		"pull_request.head.sha",
		"deployment create --allow-destructive-operations --check",
		"deployment promote",
		"deployment discard",
		"environment: staging",
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
		"TINYBIRD_STAGING_INGEST_TOKEN",
		"TINYBIRD_STAGING_READ_TOKEN",
		"TINYBIRD_STAGING_CLEANUP_TOKEN",
		"staging-ci.js run-copies",
		"probe-preview",
		"verify-promoted",
	]) {
		if (!workflow.includes(required)) {
			throw new Error(`Workflow is missing staging safeguard: ${required}`);
		}
	}
	const workspaceIds = workflow.match(
		/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
	);
	if (
		!workspaceIds ||
		workspaceIds.some(
			(workspaceId) =>
				workspaceId.toLowerCase() !== STAGING_WORKSPACE_ID.toLowerCase(),
		)
	) {
		throw new Error("Workflow contains a non-staging Tinybird workspace ID");
	}
};
