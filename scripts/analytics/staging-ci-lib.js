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

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SYNTHETIC_RUN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

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

export const selectStagingDeployment = (value, minimumCreatedAt) => {
	const candidates = Array.isArray(value)
		? value
		: (value.deployments ?? value.data ?? value.results ?? []);
	if (!Array.isArray(candidates)) {
		throw new Error("Tinybird returned an unsupported deployment list");
	}
	const minimumTime = Date.parse(minimumCreatedAt);
	const deployments = candidates
		.filter((candidate) => {
			const state = String(
				candidate.status ??
					candidate.Status ??
					candidate.state ??
					candidate.environment ??
					"",
			).toLowerCase();
			const createdAt = Date.parse(
				candidate.created_at ??
					candidate.createdAt ??
					candidate["Created at"] ??
					candidate.created ??
					"",
			);
			return (
				state.includes("staging") &&
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
	if (deployments.length !== 1) {
		throw new Error(
			"Expected exactly one staging deployment created by this run",
		);
	}
	const id =
		deployments[0].id ?? deployments[0].ID ?? deployments[0].deployment_id;
	if (typeof id !== "string" && typeof id !== "number") {
		throw new Error("The staging deployment does not have an ID");
	}
	return String(id);
};

export const validateSyntheticRunId = (runId) => {
	if (!SYNTHETIC_RUN_PATTERN.test(runId)) {
		throw new Error("Synthetic run ID has an unsafe format");
	}
	return runId;
};

export const hashIdentifier = (value) =>
	createHash("sha256").update(value).digest("hex");

export const createSyntheticEvents = ({ runId, now = new Date() }) => {
	validateSyntheticRunId(runId);
	const runHash = hashIdentifier(runId);
	const timestamp = now.toISOString().replace("T", " ").replace("Z", "");
	const shared = {
		occurred_at: timestamp,
		received_at: timestamp,
		event_name: "page_view",
		schema_version: 1,
		source: "client",
		platform: "web",
		anonymous_id: `synthetic_${runHash.slice(0, 24)}`,
		session_id: `synthetic_${runHash.slice(24, 48)}`,
		user_id: "",
		organization_id: "",
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
		rows: [
			{ ...shared, event_id: duplicateId, payload_hash: duplicateHash },
			{ ...shared, event_id: duplicateId, payload_hash: duplicateHash },
			{ ...shared, event_id: conflictId, payload_hash: conflictHashA },
			{ ...shared, event_id: conflictId, payload_hash: conflictHashB },
		],
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

export const assertPromotedSyntheticDecisions = (assertions) => {
	const expected = {
		uniqueEvents: 3,
		uniquePayloads: 4,
		payloadConflicts: 1,
		canonicalEvents: 2,
		decisionEvents: 2,
	};
	for (const [name, value] of Object.entries(expected)) {
		if (assertions[name] !== value) {
			throw new Error(
				`Promoted synthetic ${name} was ${assertions[name]}, expected ${value}`,
			);
		}
	}
	if (
		assertions.receivedRows < 6 ||
		assertions.duplicateRows !==
			assertions.receivedRows - assertions.uniquePayloads
	) {
		throw new Error(
			"Promoted synthetic assertions did not preserve retry deliveries",
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
		"deployment create --check",
		"deployment promote",
		"deployment discard",
		"environment: staging",
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
		"TINYBIRD_STAGING_INGEST_TOKEN",
		"TINYBIRD_STAGING_READ_TOKEN",
		"TINYBIRD_STAGING_CLEANUP_TOKEN",
		"probe-preview",
		"verify-promoted",
		...COPY_PIPES,
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
