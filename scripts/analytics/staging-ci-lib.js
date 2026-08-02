import { createHash } from "node:crypto";

export const STAGING_WORKSPACE_ID = "37b8fef9-817f-4c3c-b21f-218c36a6077d";
export const STAGING_DATABASE_FINGERPRINT =
	"fff37a9b160f31bfb82b8c5585829b8ee08f70b3645169dca6e7cb29033a039a";
export const STAGING_DATABASE_SCHEMA = "0042_lying_sharon_ventura";
export const FEATURE_BRANCH = "codex/first-party-analytics";
export const FEATURE_PULL_REQUEST = 2003;
export const STAGING_READ_ENDPOINTS = [
	"product_activation",
	"product_analytics_ci_assertions",
	"product_analytics_copy_assertions",
	"product_analytics_freshness",
	"product_attribution",
	"product_creator_activity",
	"product_creator_retention",
	"product_events_daily",
	"product_events_health",
	"product_experiment_outcomes",
	"product_feature_adoption",
	"product_identity_funnel",
	"product_traffic_countries",
	"product_traffic_overview",
	"product_traffic_pages",
	"product_traffic_sources",
	"product_traffic_technology",
	"product_traffic_totals",
];
export const STAGING_READ_TOKEN_MINIMUM_LIFETIME_MS = 6 * 60 * 60 * 1_000;
export const STAGING_READ_TOKEN_MAXIMUM_LIFETIME_MS = 45 * 24 * 60 * 60 * 1_000;
export const PREVIEW_TINYBIRD_TOKEN_NAMES = [
	"PRODUCT_ANALYTICS_TINYBIRD_TOKEN",
	"PRODUCT_ANALYTICS_TINYBIRD_READ_TOKEN",
	"PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN",
	"PRODUCT_ANALYTICS_TINYBIRD_ERASURE_LOOKUP_TOKEN",
	"PRODUCT_ANALYTICS_TINYBIRD_COPY_TOKEN",
	"PRODUCT_ANALYTICS_TINYBIRD_SCHEDULER_TOKEN",
];
export const COPY_PIPES = [
	"snapshot_product_event_id_states_v2",
	"snapshot_product_event_day_states_v2",
	"snapshot_product_events_canonical_v1",
	"snapshot_product_events_daily_exact",
	"snapshot_product_traffic_daily_exact",
	"snapshot_product_traffic_pages_daily_exact",
	"snapshot_product_activation_daily_exact",
	"snapshot_product_creator_retention_exact",
	"snapshot_product_identity_funnel_exact",
	"snapshot_product_attribution_daily_exact",
	"snapshot_product_experiment_outcomes_exact",
	"snapshot_product_events_health_hourly",
];
const COPY_MARKER_PIPES = new Set([
	"snapshot_product_events_daily_exact",
	"snapshot_product_traffic_daily_exact",
	"snapshot_product_traffic_pages_daily_exact",
	"snapshot_product_activation_daily_exact",
	"snapshot_product_creator_retention_exact",
	"snapshot_product_identity_funnel_exact",
	"snapshot_product_attribution_daily_exact",
	"snapshot_product_experiment_outcomes_exact",
	"snapshot_product_events_health_hourly",
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SYNTHETIC_RUN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const COPY_JOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const DEPLOYMENT_ID_PATTERN = /^[0-9]+$/;
const EVENT_SCHEMA_VERSIONS = new Map([
	["purchase_completed", 3],
	["subscription_renewed", 2],
	["trial_converted", 2],
	["subscription_changed", 2],
	["subscription_cancelled", 2],
	["subscription_refunded", 2],
	["subscription_payment_failed", 2],
]);

const eventSchemaVersion = (eventName) =>
	EVENT_SCHEMA_VERSIONS.get(eventName) ?? 1;

const errorMessage = (error) =>
	error instanceof Error ? error.message : String(error);

export const applyCopyScheduleAction = async ({
	pipes,
	action,
	setSchedule,
}) => {
	if (!["pause", "resume"].includes(action)) {
		throw new Error("Tinybird Copy schedule action must be pause or resume");
	}
	const completed = [];
	const failures = [];
	for (const pipe of pipes) {
		try {
			await setSchedule(pipe, action);
			completed.push(pipe);
		} catch (error) {
			failures.push({ pipe, error });
			if (action === "pause") break;
		}
	}
	if (failures.length === 0) return completed;
	if (action === "pause") {
		const compensationFailures = [];
		for (const pipe of completed) {
			try {
				await setSchedule(pipe, "resume");
			} catch (error) {
				compensationFailures.push({ pipe, error });
			}
		}
		const compensation = compensationFailures.length
			? `; resume compensation failed for ${compensationFailures
					.map(({ pipe, error }) => `${pipe}: ${errorMessage(error)}`)
					.join(", ")}`
			: "";
		throw new Error(
			`Failed to pause ${failures[0].pipe}: ${errorMessage(failures[0].error)}${compensation}`,
		);
	}
	throw new Error(
		`Failed to resume Copy schedules: ${failures
			.map(({ pipe, error }) => `${pipe}: ${errorMessage(error)}`)
			.join(", ")}`,
	);
};

export const copyScheduleMatchesAction = (value, action) => {
	const payload = value?.data ?? value;
	if (!payload?.schedule) return action === "resume";
	const status = String(payload?.schedule?.status ?? "").toLowerCase();
	return action === "pause"
		? status === "paused"
		: status === "scheduled" || status === "active";
};

export const isUnscheduledCopyMutation = (status, payload) =>
	status === 422 &&
	typeof payload?.error === "string" &&
	payload.error.startsWith("The copy Pipe is not scheduled");

export const formatTinybirdDateTime64 = (value) => {
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(value)) {
		return value;
	}
	if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
		throw new Error("Tinybird DateTime64 value must include a timezone");
	}
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) {
		throw new Error("Tinybird DateTime64 value is invalid");
	}
	return parsed.toISOString().replace("T", " ").replace(/Z$/, "");
};

export const tokenScopeProbeWindow = (startTime, endTime) => {
	const startMs = Date.parse(startTime);
	const endMs = Date.parse(endTime);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
		throw new Error("Token scope probe window is invalid");
	}
	return {
		start_time: formatTinybirdDateTime64(new Date(startMs).toISOString()),
		end_time: formatTinybirdDateTime64(
			new Date(Math.min(endMs, startMs + 86_400_000)).toISOString(),
		),
	};
};

const tinybirdFailureText = (value) =>
	[
		value?.error,
		value?.message,
		value?.detail,
		value?.error?.message,
		value?.job?.error,
		value?.job?.error?.message,
	]
		.filter((part) => typeof part === "string")
		.join(" ")
		.slice(0, 1_000)
		.toLowerCase();

const tinybirdCopyQuotaPattern =
	/(maximum number of copy jobs|copy jobs?.*(?:quota|limit|concurren)|(?:quota|limit|concurren).*copy jobs?)/;

const retryAfterMs = (value, now) => {
	if (!value) return 0;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(300_000, Math.round(seconds * 1_000));
	}
	const retryAt = Date.parse(value);
	return Number.isFinite(retryAt)
		? Math.min(300_000, Math.max(0, retryAt - now))
		: 0;
};

export const classifyTinybirdHttpFailure = ({
	status,
	payload,
	retryAfter,
	now = Date.now(),
}) => {
	const text = tinybirdFailureText(payload);
	const copyQuota = status === 403 && tinybirdCopyQuotaPattern.test(text);
	const rateLimited = status === 429;
	return {
		status,
		classification: copyQuota
			? "copy_quota"
			: rateLimited
				? "rate_limit"
				: status === 401 || status === 403
					? "permission"
					: status >= 500
						? "provider_failure"
						: "request_rejected",
		definitive: status < 500,
		retryable: copyQuota || rateLimited,
		retryAfterMs: retryAfterMs(retryAfter, now),
	};
};

export const classifyTinybirdCopyJobFailure = (value) => {
	const text = tinybirdFailureText(value);
	const copyQuota = tinybirdCopyQuotaPattern.test(text);
	const rateLimited = /rate limit|too many requests/.test(text);
	const transient = /temporar|service unavailable/.test(text);
	return {
		classification: copyQuota
			? "copy_quota"
			: rateLimited
				? "rate_limit"
				: transient
					? "provider_failure"
					: "copy_failed",
		definitive: true,
		retryable: copyQuota || rateLimited || transient,
		retryAfterMs: 0,
	};
};

export const waitForTinybirdCopyPipesQuiescent = async ({
	origin,
	token,
	pipes = COPY_PIPES,
	workspaceWide = false,
	request,
	assertMutationOwnership,
	requiredVisibleJobIds = [],
	now = () => Date.now(),
	wait = (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
	timeoutMs = 120_000,
	pollIntervalMs = 2_000,
}) => {
	if (typeof assertMutationOwnership !== "function") {
		throw new Error("Tinybird Copy quiescence requires an ownership check");
	}
	const startedAt = now();
	const deadline = startedAt + timeoutMs;
	let polls = 0;
	let missingRequiredJobs = false;
	const visibleJobIds = new Set();
	while (now() < deadline) {
		await assertMutationOwnership();
		const activeJobs = [];
		for (const pipe of workspaceWide ? [undefined] : pipes) {
			const url = new URL("/v0/jobs", origin);
			url.searchParams.set("kind", "copy");
			if (pipe) url.searchParams.set("pipe_name", pipe);
			const response = await request(url, { token, attempts: 3 });
			if (!Array.isArray(response.data?.jobs)) {
				throw new Error("Tinybird Jobs API returned an invalid Copy job list");
			}
			const jobs = response.data.jobs;
			for (const job of jobs) {
				if (typeof job?.id === "string") visibleJobIds.add(job.id);
				const status = String(job?.status ?? "").toLowerCase();
				if (
					![
						"done",
						"success",
						"finished",
						"completed",
						"failed",
						"error",
						"cancelled",
						"canceled",
					].includes(status)
				) {
					activeJobs.push({
						id: String(job?.id ?? ""),
						pipe: String(job?.pipe_name ?? pipe ?? ""),
						status,
					});
				}
			}
		}
		polls += 1;
		if (activeJobs.length === 0) {
			const missingJobIds = requiredVisibleJobIds.filter(
				(jobId) => !visibleJobIds.has(jobId),
			);
			missingRequiredJobs = missingJobIds.length > 0;
			if (!missingRequiredJobs) {
				return {
					activeJobs: 0,
					polls,
					quiescenceMs: Math.max(0, now() - startedAt),
					visibleRequiredJobs: requiredVisibleJobIds.length,
				};
			}
		}
		await wait(pollIntervalMs);
	}
	if (missingRequiredJobs) {
		throw new Error(
			"Tinybird Jobs API could not attest the Copy jobs created by this run",
		);
	}
	throw new Error("Timed out waiting for Tinybird Copy jobs to quiesce");
};

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

const tinybirdTokenPayload = (token) => {
	const segments = token.split(".");
	if (segments.length !== 3 || !segments[1]) {
		throw new Error("A Tinybird staging token has an unsupported format");
	}
	try {
		return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
	} catch {
		throw new Error("A Tinybird staging token cannot be decoded");
	}
};

export const tokenWorkspaceId = (token) => {
	const payload = tinybirdTokenPayload(token);
	const workspaceId = payload.u ?? payload.workspace_id ?? payload.workspaceId;
	if (typeof workspaceId !== "string") {
		throw new Error("A Tinybird staging token does not identify its workspace");
	}
	return workspaceId;
};

const validateStagingReadJwt = (token, now) => {
	const payload = tinybirdTokenPayload(token);
	if (
		!Number.isInteger(payload.exp) ||
		payload.exp * 1_000 < now + STAGING_READ_TOKEN_MINIMUM_LIFETIME_MS ||
		payload.exp * 1_000 > now + STAGING_READ_TOKEN_MAXIMUM_LIFETIME_MS
	) {
		throw new Error(
			"TINYBIRD_STAGING_READ_TOKEN must expire between six hours and 45 days from now",
		);
	}
	if (!Array.isArray(payload.scopes)) {
		throw new Error(
			"TINYBIRD_STAGING_READ_TOKEN must be an expiring resource-scoped JWT",
		);
	}
	const scopes = payload.scopes.map((scope) => {
		if (
			scope === null ||
			typeof scope !== "object" ||
			scope.type !== "PIPES:READ" ||
			typeof scope.resource !== "string" ||
			JSON.stringify(Object.keys(scope).sort()) !==
				JSON.stringify(["resource", "type"])
		) {
			throw new Error("TINYBIRD_STAGING_READ_TOKEN has an unauthorized scope");
		}
		return scope.resource;
	});
	const actual = [...new Set(scopes)].sort();
	if (
		actual.length !== scopes.length ||
		JSON.stringify(actual) !== JSON.stringify(STAGING_READ_ENDPOINTS)
	) {
		throw new Error(
			"TINYBIRD_STAGING_READ_TOKEN must grant only the reviewed decision endpoints",
		);
	}
};

export const validateTinybirdCredentials = ({
	url,
	tokens,
	now = Date.now(),
}) => {
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
		if (name === "TINYBIRD_STAGING_READ_TOKEN") {
			validateStagingReadJwt(token, now);
		}
	}
	return parsedUrl.origin;
};

export const assertPreviewTinybirdAttestation = ({
	attestation,
	expectedOrigin,
	expectedSha,
	expectedTokenHashes,
}) => {
	if (
		!attestation ||
		attestation.sha !== expectedSha ||
		attestation.host !== expectedOrigin ||
		attestation.databaseFingerprint !== STAGING_DATABASE_FINGERPRINT ||
		attestation.databaseSchema !== STAGING_DATABASE_SCHEMA ||
		!Array.isArray(attestation.workspaces)
	) {
		throw new Error(
			"The exact-SHA preview did not attest its Tinybird staging configuration",
		);
	}
	const workspaces = new Map(
		attestation.workspaces.map(({ name, tokenHash, workspaceId }) => [
			name,
			{ tokenHash, workspaceId },
		]),
	);
	const mismatchedTokens = PREVIEW_TINYBIRD_TOKEN_NAMES.filter((name) => {
		const workspace = workspaces.get(name);
		return (
			!workspace ||
			typeof workspace.workspaceId !== "string" ||
			workspace.workspaceId.toLowerCase() !==
				STAGING_WORKSPACE_ID.toLowerCase() ||
			!expectedTokenHashes ||
			workspace.tokenHash !== expectedTokenHashes[name]
		);
	});
	if (
		workspaces.size !== PREVIEW_TINYBIRD_TOKEN_NAMES.length ||
		mismatchedTokens.length > 0
	) {
		throw new Error(
			`The exact-SHA preview is not bound to the verified analytics staging tokens: ${mismatchedTokens.join(", ") || "unexpected token names"}`,
		);
	}
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

const deploymentsFromResponse = (value) => {
	const deployments = Array.isArray(value)
		? value
		: (value.deployments ?? value.data ?? value.results ?? []);
	if (!Array.isArray(deployments)) {
		throw new Error("Tinybird returned an unsupported deployment list");
	}
	return deployments;
};

export const createDeploymentBoundary = (value) => {
	const deployments = deploymentsFromResponse(value);
	const liveDeployments = deployments.filter(isLiveDeployment);
	if (liveDeployments.length !== 1) {
		throw new Error(
			"Tinybird deployment recovery requires exactly one current live deployment",
		);
	}
	const liveDeploymentId = String(deploymentId(liveDeployments[0]));
	if (!DEPLOYMENT_ID_PATTERN.test(liveDeploymentId)) {
		throw new Error("Tinybird returned an invalid live deployment ID");
	}
	const deploymentIds = deployments.map((deployment) =>
		String(deploymentId(deployment)),
	);
	if (
		deploymentIds.some((id) => !DEPLOYMENT_ID_PATTERN.test(id)) ||
		new Set(deploymentIds).size !== deploymentIds.length
	) {
		throw new Error("Tinybird returned invalid or duplicate deployment IDs");
	}
	return {
		deploymentIds: deploymentIds.sort((left, right) =>
			left.localeCompare(right, "en", { numeric: true }),
		),
		liveDeploymentId,
	};
};

export const selectRetiredStagingDeployment = (value) => {
	const deployments = deploymentsFromResponse(value);
	const liveDeployments = deployments.filter(isLiveDeployment);
	if (liveDeployments.length !== 1) {
		throw new Error(
			"Tinybird retired-deployment cleanup requires exactly one live deployment",
		);
	}
	const pendingDeployments = deployments.filter(isPendingDeployment);
	if (pendingDeployments.length > 0) {
		throw new Error(
			"Tinybird has an active deployment that cannot be retired automatically",
		);
	}
	const stagingDeployments = deployments.filter(isStagingDeployment);
	const liveDeployment = liveDeployments[0];
	const liveDeploymentId = String(deploymentId(liveDeployment));
	if (!DEPLOYMENT_ID_PATTERN.test(liveDeploymentId)) {
		throw new Error("Tinybird returned an invalid live deployment ID");
	}
	if (stagingDeployments.length === 0) {
		return { liveDeploymentId, retiredDeploymentId: undefined };
	}
	if (stagingDeployments.length !== 1) {
		throw new Error(
			"Tinybird has multiple staging deployments that cannot be retired automatically",
		);
	}
	const retiredDeployment = stagingDeployments[0];
	const retiredDeploymentId = String(deploymentId(retiredDeployment));
	const createdAt = (deployment) =>
		Date.parse(
			deployment.created_at ??
				deployment.createdAt ??
				deployment["Created at"] ??
				deployment.created ??
				"",
		);
	const liveCreatedAt = createdAt(liveDeployment);
	const retiredCreatedAt = createdAt(retiredDeployment);
	if (
		!DEPLOYMENT_ID_PATTERN.test(retiredDeploymentId) ||
		!Number.isFinite(liveCreatedAt) ||
		!Number.isFinite(retiredCreatedAt) ||
		retiredCreatedAt >= liveCreatedAt
	) {
		throw new Error(
			"Tinybird staging deployment is not a proven retired predecessor",
		);
	}
	return { liveDeploymentId, retiredDeploymentId };
};

export const resolveDeploymentCreatedAfterBoundary = (
	value,
	boundary,
	{ allowNone = false } = {},
) => {
	if (
		!boundary ||
		typeof boundary !== "object" ||
		!Array.isArray(boundary.deploymentIds) ||
		!DEPLOYMENT_ID_PATTERN.test(String(boundary.liveDeploymentId ?? "")) ||
		boundary.deploymentIds.some((id) => !DEPLOYMENT_ID_PATTERN.test(String(id)))
	) {
		throw new Error("Tinybird recovery boundary is invalid");
	}
	const deployments = deploymentsFromResponse(value);
	const liveDeployments = deployments.filter(isLiveDeployment);
	if (
		liveDeployments.length !== 1 ||
		String(deploymentId(liveDeployments[0])) !==
			String(boundary.liveDeploymentId)
	) {
		throw new Error(
			"Tinybird live deployment changed after the create boundary",
		);
	}
	const previousIds = new Set(boundary.deploymentIds.map(String));
	const created = deployments.filter((deployment) => {
		const id = String(deploymentId(deployment));
		const state = deploymentState(deployment);
		return (
			!previousIds.has(id) &&
			!isLiveDeployment(deployment) &&
			!state.includes("deleted") &&
			(isStagingDeployment(deployment) ||
				isPendingDeployment(deployment) ||
				state.includes("failed"))
		);
	});
	if (created.length === 0 && allowNone) return undefined;
	if (created.length !== 1) {
		throw new Error(
			"Tinybird uncertain create did not resolve to exactly one new deployment",
		);
	}
	const id = String(deploymentId(created[0]));
	if (!DEPLOYMENT_ID_PATTERN.test(id)) {
		throw new Error(
			"Tinybird uncertain create returned an invalid deployment ID",
		);
	}
	return { id, needsPromotion: true };
};

const isLiveDeployment = (deployment) =>
	deployment.live === true || deploymentState(deployment).includes("live");

const isStagingDeployment = (deployment) => {
	const state = deploymentState(deployment);
	return (
		!isLiveDeployment(deployment) &&
		(state === "data_ready" || state.includes("staging"))
	);
};

const isPendingDeployment = (deployment) => {
	const state = deploymentState(deployment);
	return (
		state.includes("in progress") ||
		state.includes("pending") ||
		state.includes("promot") ||
		["calculating", "creating_schema", "schema_ready", "deleting"].includes(
			state,
		)
	);
};

const exactDeployment = (value, expectedDeploymentId) => {
	const deployment = value.deployment ?? value;
	if (
		!deployment ||
		typeof deployment !== "object" ||
		String(deploymentId(deployment)) !== expectedDeploymentId
	) {
		throw new Error("Tinybird returned the wrong exact deployment");
	}
	return deployment;
};

export const selectStagingDeployment = (
	value,
	minimumCreatedAt,
	createdDeploymentId,
	noOpConfirmed = false,
) => {
	const candidates = deploymentsFromResponse(value);
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

export const resolveOwnedMutationTarget = (value, expectedDeploymentId) => {
	if (!DEPLOYMENT_ID_PATTERN.test(expectedDeploymentId)) {
		throw new Error("Tinybird mutation ownership requires a numeric ID");
	}
	const deployments = deploymentsFromResponse(value);
	const matches = deployments.filter(
		(deployment) => String(deploymentId(deployment)) === expectedDeploymentId,
	);
	if (matches.length !== 1) {
		throw new Error("The owned Tinybird deployment is missing or ambiguous");
	}
	if (isLiveDeployment(matches[0])) return "live";
	if (isPendingDeployment(matches[0])) return "pending";
	if (!isStagingDeployment(matches[0])) {
		throw new Error("The owned Tinybird deployment is not ready for mutation");
	}
	const stagingDeployments = deployments.filter(isStagingDeployment);
	if (
		stagingDeployments.length !== 1 ||
		String(deploymentId(stagingDeployments[0])) !== expectedDeploymentId
	) {
		throw new Error("The Tinybird staging alias is not owned by this run");
	}
	return "staging";
};

export const resolveExactPromotionPlan = (value, expectedDeploymentId) => {
	if (resolveOwnedMutationTarget(value, expectedDeploymentId) !== "staging") {
		throw new Error("The owned Tinybird deployment is not staging");
	}
	if (resolveOwnedDiscardTarget(value, expectedDeploymentId) !== "ready") {
		throw new Error("The owned Tinybird deployment is not ready for promotion");
	}
	const liveDeployments =
		deploymentsFromResponse(value).filter(isLiveDeployment);
	if (liveDeployments.length !== 1) {
		throw new Error(
			"Tinybird promotion requires exactly one current live deployment",
		);
	}
	const previousLiveDeploymentId = String(deploymentId(liveDeployments[0]));
	if (
		!DEPLOYMENT_ID_PATTERN.test(previousLiveDeploymentId) ||
		previousLiveDeploymentId === expectedDeploymentId
	) {
		throw new Error("Tinybird returned an invalid previous live deployment");
	}
	return { previousLiveDeploymentId };
};

export const resolveOwnedDiscardTarget = (value, expectedDeploymentId) => {
	if (!DEPLOYMENT_ID_PATTERN.test(expectedDeploymentId)) {
		throw new Error("Tinybird discard ownership requires a numeric ID");
	}
	const deployments = deploymentsFromResponse(value);
	const matches = deployments.filter(
		(deployment) => String(deploymentId(deployment)) === expectedDeploymentId,
	);
	if (matches.length !== 1 || isLiveDeployment(matches[0])) {
		throw new Error("The owned Tinybird deployment cannot be discarded");
	}
	const state = deploymentState(matches[0]);
	if (
		!isStagingDeployment(matches[0]) &&
		!isPendingDeployment(matches[0]) &&
		!state.includes("failed")
	) {
		throw new Error("The owned Tinybird deployment is not discardable");
	}
	const mutableDeployments = deployments.filter((deployment) => {
		const candidateState = deploymentState(deployment);
		return (
			!isLiveDeployment(deployment) &&
			!candidateState.includes("deleted") &&
			(isStagingDeployment(deployment) ||
				isPendingDeployment(deployment) ||
				candidateState.includes("failed"))
		);
	});
	if (
		mutableDeployments.length !== 1 ||
		String(deploymentId(mutableDeployments[0])) !== expectedDeploymentId
	) {
		throw new Error("The Tinybird discard candidate is not owned by this run");
	}
	return isPendingDeployment(matches[0]) ? "pending" : "ready";
};

export const resolveExactDeploymentLifecycle = (
	value,
	expectedDeploymentId,
) => {
	if (!DEPLOYMENT_ID_PATTERN.test(expectedDeploymentId)) {
		throw new Error("Tinybird exact deployment lookup requires a numeric ID");
	}
	const deployment = exactDeployment(value, expectedDeploymentId);
	const state = deploymentState(deployment);
	if (isLiveDeployment(deployment)) return "live";
	if (state.includes("deleted")) return "deleted";
	if (state.includes("deleting")) return "deleting";
	if (state.includes("failed")) return "failed";
	if (isPendingDeployment(deployment)) return "pending";
	if (isStagingDeployment(deployment)) return "ready";
	throw new Error(`The exact Tinybird deployment is ${state || "unknown"}`);
};

export const reconcileCleanupTarget = (currentTarget, resolvedTarget) => {
	if (currentTarget === resolvedTarget) return currentTarget;
	if (currentTarget === "staging" && resolvedTarget === "live") return "live";
	throw new Error("Tinybird cleanup target changed non-monotonically");
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
	return target === "staging" ? { __tb__deployment: "staging" } : {};
};

export const resolveDeploymentState = (value, expectedDeploymentId) => {
	if (!DEPLOYMENT_ID_PATTERN.test(expectedDeploymentId)) {
		throw new Error("Tinybird deployment state requires a numeric ID");
	}
	const deployments = deploymentsFromResponse(value);
	const matches = deployments.filter(
		(deployment) => String(deploymentId(deployment)) === expectedDeploymentId,
	);
	if (matches.length !== 1) {
		throw new Error("The exact Tinybird deployment state is ambiguous");
	}
	const state = deploymentState(matches[0]);
	if (state.includes("live")) {
		return {
			target: "live",
			discard: false,
			promoted: true,
			pending: false,
			state: "live",
		};
	}
	if (state.includes("staging")) {
		return {
			target: "staging",
			discard: true,
			promoted: false,
			pending: false,
			state: "staging",
		};
	}
	if (state.includes("in progress")) {
		return {
			target: "staging",
			discard: false,
			promoted: false,
			pending: true,
			state: "in_progress",
		};
	}
	if (state.includes("failed")) {
		return {
			target: "staging",
			discard: true,
			promoted: false,
			pending: false,
			state: "failed",
		};
	}
	if (state.includes("deleted")) {
		return {
			target: "staging",
			discard: false,
			promoted: false,
			pending: false,
			state: "deleted",
		};
	}
	throw new Error(`The exact Tinybird deployment is ${state || "unknown"}`);
};

export const submitTinybirdCopyJobs = async ({
	origin,
	token,
	deploymentId,
	request,
	now = () => Date.now(),
	pipes = COPY_PIPES,
	copyRunId = "",
	sourceCutoff = "",
	assertMutationOwnership,
}) => {
	if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
		throw new Error("Tinybird copy jobs require a numeric deployment ID");
	}
	if (copyRunId) validateSyntheticRunId(copyRunId);
	if (sourceCutoff && !Number.isFinite(Date.parse(sourceCutoff))) {
		throw new Error("Tinybird copy source cutoff must be an ISO timestamp");
	}
	const tinybirdSourceCutoff = sourceCutoff
		? new Date(sourceCutoff).toISOString().replace("T", " ").replace("Z", "")
		: "";
	if (typeof assertMutationOwnership !== "function") {
		throw new Error("Tinybird copies require an ownership check");
	}
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
		if (tinybirdSourceCutoff) {
			copyUrl.searchParams.set("source_cutoff", tinybirdSourceCutoff);
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
				attempts: 1,
				beforeAttempt: assertMutationOwnership,
			});
		} catch (error) {
			const detail = error instanceof Error ? `: ${error.message}` : "";
			throw new Error(`Tinybird copy submission failed for ${pipe}${detail}`, {
				cause: error,
			});
		}
		const jobId = String(
			created.data?.job?.id ??
				created.data?.job?.job_id ??
				created.data?.job_id ??
				"",
		);
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

export const waitForTinybirdCopyJob = async ({
	origin,
	token,
	pipe,
	jobId,
	request,
	assertMutationOwnership,
	now = () => Date.now(),
	wait = (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
	timeoutMs = 900_000,
	pollIntervalMs = 2_000,
}) => {
	if (!COPY_JOB_ID_PATTERN.test(jobId)) {
		throw new Error("Tinybird Copy status requires a valid job ID");
	}
	if (typeof assertMutationOwnership !== "function") {
		throw new Error("Tinybird Copy status requires an ownership check");
	}
	if (
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0 ||
		!Number.isFinite(pollIntervalMs) ||
		pollIntervalMs <= 0
	) {
		throw new Error("Tinybird Copy status polling bounds are invalid");
	}
	const startedAt = now();
	const deadline = startedAt + timeoutMs;
	let polls = 0;
	while (now() < deadline) {
		const job = await request(
			new URL(`/v0/jobs/${encodeURIComponent(jobId)}`, origin),
			{
				token,
				attempts: 3,
				beforeAttempt: assertMutationOwnership,
			},
		);
		polls += 1;
		const status = String(
			job.data.status ??
				job.data.state ??
				job.data.job?.status ??
				job.data.job?.state ??
				"",
		).toLowerCase();
		if (["done", "success", "finished", "completed"].includes(status)) {
			return {
				status,
				polls,
				completionMs: Math.max(0, now() - startedAt),
			};
		}
		if (["failed", "error", "cancelled", "canceled"].includes(status)) {
			const failure = classifyTinybirdCopyJobFailure(job.data);
			const error = new Error(`Tinybird Copy job ended in ${status}`);
			error.pipe = pipe;
			error.jobId = jobId;
			Object.assign(error, failure);
			throw error;
		}
		await wait(pollIntervalMs);
	}
	throw new Error("Timed out waiting for Tinybird Copy job");
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
		channel: "direct",
		traffic_class: "synthetic",
		synthetic_run_id: runId,
		properties: JSON.stringify({
			hostname: "preview.cap.so",
			is_session_entry: true,
			session_started_at: now.toISOString(),
		}),
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
			{
				...shared,
				event_id: conflictId,
				payload_hash: conflictHashB,
				properties: JSON.stringify({
					hostname: "preview.cap.so",
					is_session_entry: false,
					session_started_at: now.toISOString(),
				}),
			},
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
			properties: JSON.stringify({
				hostname: fixture.rows[0].hostname,
				is_session_entry: true,
				session_started_at: now.toISOString(),
			}),
		},
	};
};

export const SYNTHETIC_ERASURE_REMAINING_BUSINESS_ASSERTIONS = Object.freeze({
	receivedRows: 4,
	uniqueEvents: 4,
	uniquePayloads: 4,
	duplicateRows: 0,
	payloadConflicts: 0,
	canonicalEvents: 4,
	decisionEvents: 4,
	decisionRevenueMinor: 0,
	trafficVisitors: 2,
	trafficVisits: 2,
	trafficPageviews: 2,
	trafficBounces: 1,
	trafficDurationMs: 15_000,
	pageVisitors: 2,
	pageVisits: 2,
	pageviews: 2,
	pageLandings: 2,
	pageExits: 2,
	pageEngagedMs: 15_000,
	pageScrollDepth: 75,
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
});

export const createSyntheticDecisionEvents = ({ runId, now = new Date() }) => {
	const fixture = createSyntheticEvents({ runId, now });
	const decisionRunId = `${runId}_decisions`;
	validateSyntheticRunId(decisionRunId);
	const runHash = hashIdentifier(decisionRunId);
	const appVersion = `staging-decisions-${runHash.slice(0, 12)}`;
	const hostname = `synthetic-${runHash.slice(0, 12)}.preview.cap.so`;
	const pathname = `/analytics-synthetic-${runHash.slice(0, 12)}`;
	const pageViewId = `synthetic_decision_page_${runHash.slice(0, 20)}`;
	const guestAnonymousId = `synthetic_guest_${runHash.slice(0, 20)}`;
	const guestSessionId = `synthetic_guest_session_${runHash.slice(0, 16)}`;
	const abandonedGuestAnonymousId = `synthetic_abandoned_guest_${runHash.slice(0, 16)}`;
	const abandonedGuestSessionId = `synthetic_abandoned_session_${runHash.slice(0, 16)}`;
	const sharedAnonymousId = `synthetic_shared_${runHash.slice(0, 20)}`;
	const sharedSessionId = `synthetic_shared_session_${runHash.slice(0, 16)}`;
	const sessionStartedAt = (index) =>
		new Date(now.getTime() + index * 1_000).toISOString();
	const event = ({
		anonymousId = fixture.anonymousId,
		channel = "direct",
		device = "desktop",
		eventName,
		index,
		organizationId = fixture.organizationId,
		platform,
		properties,
		referrer = fixture.rows[0].referrer,
		schemaVersion,
		sessionId = fixture.rows[0].session_id,
		source,
		userId = fixture.userId,
	}) => {
		const eventId =
			index === 0
				? pageViewId
				: `synthetic_decision_${index}_${runHash.slice(0, 20)}`;
		const occurredAt = new Date(now.getTime() + index * 1_000)
			.toISOString()
			.replace("T", " ")
			.replace("Z", "");
		return {
			...fixture.rows[0],
			event_id: eventId,
			payload_hash: hashIdentifier(`${decisionRunId}:${eventId}`).slice(0, 32),
			occurred_at: occurredAt,
			received_at: occurredAt,
			event_name: eventName,
			schema_version: schemaVersion ?? eventSchemaVersion(eventName),
			source,
			platform,
			anonymous_id: anonymousId,
			session_id: sessionId,
			user_id: userId,
			organization_id: organizationId,
			app_version: appVersion,
			country: "US",
			referrer,
			device,
			browser: "Chrome",
			os: "macOS",
			channel,
			hostname,
			pathname,
			synthetic_run_id: decisionRunId,
			properties: JSON.stringify(properties),
		};
	};
	return {
		appVersion,
		hostname,
		pathname,
		runId: decisionRunId,
		date: now.toISOString().slice(0, 10),
		rows: [
			event({
				userId: "",
				organizationId: "",
				channel: "paid_search",
				eventName: "page_view",
				index: 0,
				platform: "web",
				properties: {
					hostname,
					is_session_entry: true,
					session_started_at: sessionStartedAt(0),
					first_touch_source: "first-touch",
					first_touch_medium: "first",
					first_touch_campaign: "first-campaign",
					session_touch_source: "google",
					session_touch_medium: "cpc",
					session_touch_campaign: "synthetic-campaign",
					session_touch_gclid: "synthetic-click-id",
					last_touch_source: "last-touch",
					last_touch_medium: "last",
					last_touch_campaign: "last-campaign",
				},
				source: "client",
			}),
			event({
				userId: "",
				organizationId: "",
				eventName: "page_engagement",
				index: 1,
				platform: "web",
				properties: {
					page_view_id: pageViewId,
					engaged_ms: 15_000,
					max_scroll_depth: 75,
					session_started_at: sessionStartedAt(0),
				},
				source: "client",
			}),
			event({
				eventName: "identity_linked",
				index: 2,
				platform: "server",
				properties: {},
				source: "server",
			}),
			event({
				eventName: "user_signed_up",
				index: 3,
				platform: "web",
				properties: {},
				source: "server",
			}),
			event({
				eventName: "share_link_created",
				index: 4,
				platform: "server",
				properties: {
					asset_type: "recording",
					recording_mode: "screen",
				},
				source: "server",
			}),
			event({
				eventName: "recording_completed",
				index: 5,
				platform: "desktop",
				properties: {
					mode: "screen",
					status: "success",
					duration_secs: 30,
					segment_count: 1,
					track_failure_count: 0,
				},
				source: "client",
			}),
			event({
				anonymousId: guestAnonymousId,
				channel: "paid_search",
				eventName: "page_view",
				index: 6,
				organizationId: "",
				platform: "web",
				properties: {
					hostname,
					is_session_entry: true,
					session_started_at: sessionStartedAt(6),
					first_touch_source: "first-touch",
					first_touch_medium: "first",
					first_touch_campaign: "first-campaign",
					session_touch_source: "google",
					session_touch_medium: "cpc",
					session_touch_campaign: "synthetic-campaign",
					session_touch_gclid: "synthetic-guest-click-id",
					last_touch_source: "last-touch",
					last_touch_medium: "last",
					last_touch_campaign: "last-campaign",
				},
				sessionId: guestSessionId,
				source: "client",
				userId: "",
			}),
			event({
				anonymousId: guestAnonymousId,
				eventName: "guest_checkout_started",
				index: 7,
				organizationId: "",
				platform: "web",
				properties: {
					price_id: "price_pro_annual",
					quantity: 1,
				},
				source: "server",
				sessionId: guestSessionId,
				userId: "",
			}),
			event({
				eventName: "checkout_started",
				index: 8,
				platform: "web",
				properties: {
					price_id: "price_pro_annual",
					quantity: 1,
					is_onboarding: false,
				},
				source: "server",
			}),
			event({
				anonymousId: `synthetic_desktop_${runHash.slice(0, 20)}`,
				eventName: "checkout_started",
				index: 9,
				platform: "desktop",
				properties: {
					price_id: "price_pro_annual",
					quantity: 1,
					is_onboarding: false,
				},
				sessionId: `synthetic_desktop_session_${runHash.slice(0, 16)}`,
				source: "server",
			}),
			event({
				anonymousId: `synthetic_mobile_${runHash.slice(0, 20)}`,
				device: "mobile",
				eventName: "checkout_started",
				index: 10,
				platform: "mobile",
				properties: {
					price_id: "price_pro_annual",
					quantity: 1,
					is_onboarding: false,
				},
				sessionId: `synthetic_mobile_session_${runHash.slice(0, 16)}`,
				source: "server",
			}),
			event({
				eventName: "trial_started",
				index: 11,
				platform: "web",
				properties: {
					subscription_status: "trialing",
					trial_end_at: 1_900_604_800,
					price_id: "price_pro_annual",
					quantity: 1,
					currency: "gbp",
					unit_amount_minor: 2_500,
					billing_interval: "year",
					billing_interval_count: 1,
					is_guest_checkout: false,
					is_onboarding: false,
				},
				source: "server",
			}),
			event({
				eventName: "purchase_completed",
				index: 12,
				platform: "web",
				properties: {
					payment_status: "paid",
					subscription_status: "active",
					amount_total_minor: 2_500,
					amount_subtotal_minor: 2_500,
					discount_amount_minor: 0,
					currency: "gbp",
					unit_amount_minor: 2_500,
					billing_interval: "year",
					billing_interval_count: 1,
					invite_quota: 1,
					price_id: "price_pro_annual",
					quantity: 1,
					is_first_purchase: true,
					is_guest_checkout: false,
					is_onboarding: false,
				},
				source: "server",
			}),
			event({
				eventName: "subscription_renewed",
				index: 13,
				platform: "server",
				properties: {
					amount_paid_minor: 2_500,
					currency: "gbp",
					price_id: "price_pro_annual",
					billing_reason: "subscription_cycle",
				},
				source: "server",
			}),
			event({
				anonymousId: abandonedGuestAnonymousId,
				eventName: "guest_checkout_started",
				index: 24,
				organizationId: "",
				platform: "web",
				properties: {
					price_id: "price_pro_annual",
					quantity: 1,
				},
				sessionId: abandonedGuestSessionId,
				source: "server",
				userId: "",
			}),
			event({
				eventName: "trial_converted",
				index: 14,
				platform: "server",
				properties: {
					previous_status: "trialing",
					new_status: "active",
					price_id: "price_pro_annual",
				},
				source: "server",
			}),
			event({
				eventName: "subscription_changed",
				index: 15,
				platform: "server",
				properties: {
					change_kind: "plan",
					previous_price_id: "price_pro_monthly",
					new_price_id: "price_pro_annual",
				},
				source: "server",
			}),
			event({
				eventName: "subscription_changed",
				index: 16,
				platform: "server",
				properties: {
					change_kind: "seats",
					previous_price_id: "price_pro_annual",
					new_price_id: "price_pro_annual",
					previous_quantity: 1,
					new_quantity: 3,
				},
				source: "server",
			}),
			event({
				eventName: "subscription_cancelled",
				index: 17,
				platform: "server",
				properties: {
					status: "canceled",
					price_id: "price_pro_annual",
					ended_at: 1_900_000_000,
					cancel_at_period_end: false,
				},
				source: "server",
			}),
			event({
				eventName: "subscription_refunded",
				index: 18,
				platform: "server",
				properties: {
					amount_refunded_minor: 500,
					currency: "gbp",
					price_id: "price_pro_annual",
					fully_refunded: false,
				},
				source: "server",
			}),
			event({
				eventName: "subscription_payment_failed",
				index: 19,
				platform: "server",
				properties: {
					amount_due_minor: 2_500,
					currency: "gbp",
					attempt_count: 2,
					price_id: "price_pro_annual",
				},
				source: "server",
			}),
			event({
				anonymousId: sharedAnonymousId,
				channel: "referral",
				eventName: "page_view",
				index: 20,
				organizationId: "",
				platform: "web",
				properties: {
					hostname,
					is_session_entry: true,
					session_started_at: sessionStartedAt(20),
					first_touch_source: "first-touch",
					first_touch_medium: "first",
					first_touch_campaign: "first-campaign",
					session_touch_source: "synthetic-partner",
					session_touch_medium: "referral",
					last_touch_source: "last-touch",
					last_touch_medium: "last",
					last_touch_campaign: "last-campaign",
				},
				referrer: "https://synthetic-partner.example/path",
				sessionId: sharedSessionId,
				source: "client",
				userId: "",
			}),
			event({
				anonymousId: sharedAnonymousId,
				eventName: "identity_linked",
				index: 21,
				platform: "server",
				properties: {},
				sessionId: sharedSessionId,
				source: "server",
				userId: `synthetic_shared_org_user_${runHash.slice(0, 16)}`,
			}),
			event({
				anonymousId: guestAnonymousId,
				eventName: "purchase_completed",
				index: 22,
				platform: "web",
				properties: {
					payment_status: "paid",
					subscription_status: "active",
					amount_total_minor: 1_500,
					amount_subtotal_minor: 1_500,
					discount_amount_minor: 0,
					currency: "gbp",
					unit_amount_minor: 1_500,
					billing_interval: "month",
					billing_interval_count: 1,
					invite_quota: 1,
					price_id: "price_guest_monthly",
					quantity: 1,
					is_first_purchase: true,
					is_guest_checkout: true,
					is_onboarding: false,
				},
				source: "server",
				sessionId: guestSessionId,
			}),
			event({
				eventName: "subscription_renewed",
				index: 23,
				platform: "server",
				properties: {
					amount_paid_minor: 1_000,
					currency: "gbp",
					billing_reason: "subscription_cycle",
				},
				schemaVersion: 1,
				source: "server",
			}),
			event({
				eventName: "experiment_exposed",
				index: 25,
				platform: "web",
				properties: {
					experiment_id: "synthetic-checkout-copy",
					variant: "treatment",
					assignment_version: "v1",
				},
				source: "client",
			}),
			event({
				eventName: "analytics_delivery_loss",
				index: 26,
				platform: "desktop",
				properties: {
					failure_class: "queue_overflow_unrecoverable",
					failed_event_name: "recording_completed",
					status: null,
					count: 3,
					first_sequence: 41,
					last_sequence: 43,
					first_failed_at_ms: now.getTime(),
					last_failed_at_ms: now.getTime() + 2_000,
				},
				source: "client",
			}),
			event({
				eventName: "share_link_created",
				index: 27,
				platform: "server",
				properties: {
					asset_type: "recording",
					recording_mode: "screen",
				},
				source: "server",
			}),
		],
	};
};

export const createSyntheticLoadEvents = ({
	runId,
	count,
	dimensionBucketCount = 64,
	daySpan = 1,
	now = new Date(),
}) => {
	if (
		!Number.isInteger(count) ||
		count < 100 ||
		count > 100_000 ||
		count % 10 !== 0
	) {
		throw new Error(
			"Synthetic load size must be a multiple of 10 between 100 and 100000 rows",
		);
	}
	if (
		!Number.isInteger(dimensionBucketCount) ||
		dimensionBucketCount < 1 ||
		dimensionBucketCount > 100
	) {
		throw new Error(
			"Synthetic load dimension buckets must be an integer between 1 and 100",
		);
	}
	if (!Number.isInteger(daySpan) || daySpan < 1 || daySpan > 400) {
		throw new Error(
			"Synthetic load day span must be an integer between 1 and 400",
		);
	}
	const fixture = createSyntheticEvents({ runId, now });
	const runHash = hashIdentifier(runId);
	const eventNamespace = runHash
		.slice(0, 12)
		.replace(/[0-9]/g, (digit) => String.fromCharCode(103 + Number(digit)));
	const appVersion = `staging-load-${runHash.slice(0, 12)}`;
	const loadRunId = `${runId}_load`;
	const effectiveDimensionBucketCount = Math.min(
		dimensionBucketCount,
		count / 10,
	);
	const currentUtcDayStartedAt = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate(),
	);
	validateSyntheticRunId(loadRunId);
	return {
		appVersion,
		daySpan,
		dimensionBucketCount: effectiveDimensionBucketCount,
		runId: loadRunId,
		rows: Array.from({ length: count }, (_, index) => {
			const cohort = Math.floor(index / 10);
			const dayOffset = cohort % daySpan;
			const dayStartedAt = currentUtcDayStartedAt - dayOffset * 86_400_000;
			const availableSeconds =
				dayOffset === 0
					? Math.floor((now.getTime() - currentUtcDayStartedAt) / 1_000)
					: 86_399;
			const cohortOccurredAt =
				dayStartedAt + (cohort % (availableSeconds + 1)) * 1_000;
			const dimensionBucket = cohort % effectiveDimensionBucketCount;
			const eventKind = index % 10;
			const eventId = `synthetic_load_${eventNamespace}_${cohort}_${eventKind}`;
			const pageViewId = `synthetic_load_${eventNamespace}_${cohort}_0`;
			const hostname = `load-${runHash.slice(0, 8)}-${dimensionBucket}.preview.cap.so`;
			const anonymousId = `synthetic_load_${runHash.slice(0, 8)}_${cohort}`;
			const userId = `synthetic_load_user_${runHash.slice(0, 8)}_${cohort}`;
			const organizationId = `synthetic_load_org_${runHash.slice(0, 8)}_${cohort}`;
			const sessionId = `synthetic_load_session_${runHash.slice(0, 8)}_${cohort}`;
			const checkoutPlatform = ["web", "desktop", "mobile"][
				dimensionBucket % 3
			];
			const occurredAt = new Date(cohortOccurredAt)
				.toISOString()
				.replace("T", " ")
				.replace("Z", "");
			const sessionStartedAt = new Date(cohortOccurredAt).toISOString();
			const shapes = [
				{
					eventName: "page_view",
					source: "client",
					platform: "web",
					properties: {
						hostname,
						is_session_entry: true,
						session_started_at: sessionStartedAt,
						session_touch_source: `source-${dimensionBucket}`,
						session_touch_medium: "cpc",
						session_touch_campaign: `campaign-${dimensionBucket}`,
					},
					channel: "paid_other",
				},
				{
					eventName: "page_engagement",
					source: "client",
					platform: "web",
					properties: {
						page_view_id: pageViewId,
						engaged_ms: 5_000,
						max_scroll_depth: 60,
						session_started_at: sessionStartedAt,
					},
				},
				{
					eventName: "identity_linked",
					source: "server",
					platform: "server",
					properties: {},
				},
				{
					eventName: "user_signed_up",
					source: "server",
					platform: "web",
					properties: {},
				},
				{
					eventName: "share_link_created",
					source: "server",
					platform: "server",
					properties: {
						asset_type: "recording",
						recording_mode: "screen",
					},
				},
				{
					eventName: "experiment_exposed",
					source: "client",
					platform: "web",
					properties: {
						experiment_id: `synthetic-load-${dimensionBucket}`,
						variant: dimensionBucket % 2 === 0 ? "control" : "treatment",
						assignment_version: "v1",
					},
				},
				{
					eventName: "checkout_started",
					source: "server",
					platform: checkoutPlatform,
					properties: {
						price_id: `price_load_${dimensionBucket}`,
						quantity: 1,
						is_onboarding: false,
					},
				},
				{
					eventName: "trial_started",
					source: "server",
					platform: checkoutPlatform,
					properties: {
						subscription_status: "trialing",
						price_id: `price_load_${dimensionBucket}`,
						quantity: 1,
						currency: "usd",
						unit_amount_minor: 1_000,
						billing_interval: "month",
						billing_interval_count: 1,
						is_guest_checkout: false,
						is_onboarding: false,
					},
				},
				{
					eventName: "purchase_completed",
					source: "server",
					platform: checkoutPlatform,
					properties: {
						payment_status: "paid",
						subscription_status: "active",
						amount_total_minor: 1_000,
						amount_subtotal_minor: 1_000,
						discount_amount_minor: 0,
						currency: "usd",
						unit_amount_minor: 1_000,
						billing_interval: "month",
						billing_interval_count: 1,
						invite_quota: 1,
						price_id: `price_load_${dimensionBucket}`,
						quantity: 1,
						is_first_purchase: true,
						is_guest_checkout: false,
						is_onboarding: false,
					},
				},
				{
					eventName: "subscription_renewed",
					source: "server",
					platform: "server",
					properties: {
						amount_paid_minor: 1_000,
						currency: "usd",
						price_id: `price_load_${dimensionBucket}`,
						billing_reason: "subscription_cycle",
					},
				},
			];
			const shape = shapes[eventKind];
			return {
				...fixture.rows[0],
				event_id: eventId,
				payload_hash: hashIdentifier(eventId).slice(0, 32),
				occurred_at: occurredAt,
				received_at: occurredAt,
				event_name: shape.eventName,
				schema_version: eventSchemaVersion(shape.eventName),
				source: shape.source,
				platform: shape.platform,
				anonymous_id: anonymousId,
				session_id: sessionId,
				user_id: eventKind < 2 ? "" : userId,
				organization_id: eventKind < 2 ? "" : organizationId,
				app_version: appVersion,
				hostname,
				pathname: `/analytics-load/${dimensionBucket}`,
				country: "US",
				device: shape.platform === "mobile" ? "mobile" : "desktop",
				browser: "Chrome",
				os: shape.platform === "mobile" ? "iOS" : "macOS",
				channel: shape.channel ?? "direct",
				synthetic_run_id: loadRunId,
				properties: JSON.stringify(shape.properties),
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
		decisionRevenueMinor: number(row.decision_revenue_minor),
		trafficVisitors: number(row.traffic_visitors),
		trafficVisits: number(row.traffic_visits),
		trafficPageviews: number(row.traffic_pageviews),
		trafficBounces: number(row.traffic_bounces),
		trafficDurationMs: number(row.traffic_duration_ms),
		pageVisitors: number(row.page_visitors),
		pageVisits: number(row.page_visits),
		pageviews: number(row.pageviews),
		pageLandings: number(row.page_landings),
		pageExits: number(row.page_exits),
		pageEngagedMs: number(row.page_engaged_ms),
		pageScrollDepth: number(row.page_scroll_depth),
		activationSignups: number(row.activation_signups),
		activatedCreators: number(row.activated_creators),
		retentionCreators: number(row.retention_creators),
		retentionOrganizations: number(row.retention_organizations),
		identityLinkedVisitors: number(row.identity_linked_visitors),
		identityLinkedUsers: number(row.identity_linked_users),
		identitySignupUsers: number(row.identity_signup_users),
		identityOrganizations: number(row.identity_organizations),
		identityGuestCheckoutVisitors: number(row.identity_guest_checkout_visitors),
		identityGuestPurchasers: number(row.identity_guest_purchasers),
		identityAuthenticatedCheckoutUsers: number(
			row.identity_authenticated_checkout_users,
		),
		identityWebCheckoutUsers: number(row.identity_web_checkout_users),
		identityDesktopCheckoutUsers: number(row.identity_desktop_checkout_users),
		identityMobileCheckoutUsers: number(row.identity_mobile_checkout_users),
		identityCrossDeviceCheckoutUsers: number(
			row.identity_cross_device_checkout_users,
		),
		identityTrialUsers: number(row.identity_trial_users),
		identityPurchasers: number(row.identity_purchasers),
	};
};

export const assertSyntheticBusinessDecisions = (assertions) => {
	const expected = {
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
	for (const [name, value] of Object.entries(expected)) {
		if (assertions[name] !== value) {
			throw new Error(
				`Synthetic business metric ${name} was ${assertions[name]}, expected ${value}`,
			);
		}
	}
};

export const assertSyntheticLoadDecisions = (
	assertions,
	expectedEvents,
	dimensionBucketCount = expectedEvents / 10,
) => {
	assertSyntheticLoadHealth(assertions, expectedEvents);
	const cohorts = expectedEvents / 10;
	if (
		!Number.isInteger(dimensionBucketCount) ||
		dimensionBucketCount < 1 ||
		dimensionBucketCount > cohorts
	) {
		throw new Error("Synthetic load dimension bucket count is invalid");
	}
	const effectiveDimensionBucketCount = Math.min(dimensionBucketCount, cohorts);
	const platformCohorts = [0, 0, 0];
	const completeBucketCycles = Math.floor(
		cohorts / effectiveDimensionBucketCount,
	);
	const remainingBuckets = cohorts % effectiveDimensionBucketCount;
	for (let bucket = 0; bucket < effectiveDimensionBucketCount; bucket += 1) {
		platformCohorts[bucket % 3] +=
			completeBucketCycles + (bucket < remainingBuckets ? 1 : 0);
	}
	const expected = {
		canonicalEvents: expectedEvents,
		decisionEvents: expectedEvents,
		decisionRevenueMinor: cohorts * 2_000,
		trafficVisitors: cohorts,
		trafficVisits: cohorts,
		trafficPageviews: cohorts,
		trafficBounces: 0,
		trafficDurationMs: cohorts * 5_000,
		pageVisitors: cohorts,
		pageVisits: cohorts,
		pageviews: cohorts,
		pageLandings: cohorts,
		pageExits: cohorts,
		pageEngagedMs: cohorts * 5_000,
		pageScrollDepth: cohorts * 60,
		activationSignups: cohorts,
		activatedCreators: cohorts,
		retentionCreators: cohorts,
		retentionOrganizations: cohorts,
		identityLinkedVisitors: cohorts,
		identityLinkedUsers: cohorts,
		identitySignupUsers: cohorts,
		identityOrganizations: cohorts,
		identityGuestCheckoutVisitors: 0,
		identityGuestPurchasers: 0,
		identityAuthenticatedCheckoutUsers: cohorts,
		identityWebCheckoutUsers: platformCohorts[0],
		identityDesktopCheckoutUsers: platformCohorts[1],
		identityMobileCheckoutUsers: platformCohorts[2],
		identityCrossDeviceCheckoutUsers: 0,
		identityTrialUsers: cohorts,
		identityPurchasers: cohorts,
	};
	for (const [name, value] of Object.entries(expected)) {
		if (assertions[name] !== value) {
			throw new Error(
				`Synthetic load metric ${name} was ${assertions[name]}, expected ${value}`,
			);
		}
	}
};

const endpointRows = (payloads, name) => {
	const rows = payloads[name]?.data;
	if (!Array.isArray(rows)) {
		throw new Error(`Synthetic endpoint ${name} returned an invalid payload`);
	}
	return rows;
};

const singleEndpointRow = (payloads, name) => {
	const rows = endpointRows(payloads, name);
	if (rows.length !== 1) {
		throw new Error(
			`Synthetic endpoint ${name} returned ${rows.length} rows, expected 1`,
		);
	}
	return rows[0];
};

const assertEndpointFields = (name, row, expected) => {
	for (const [field, value] of Object.entries(expected)) {
		const actual = typeof value === "number" ? Number(row[field]) : row[field];
		if (actual !== value) {
			throw new Error(
				`Synthetic endpoint ${name}.${field} was ${actual}, expected ${value}`,
			);
		}
	}
};

export const assertSyntheticEndpointDecisions = ({
	appVersion,
	date,
	hostname,
	pathname,
	payloads,
}) => {
	assertEndpointFields(
		"product_traffic_overview",
		singleEndpointRow(payloads, "product_traffic_overview"),
		{
			date,
			visitors: 3,
			visits: 3,
			pageviews: 3,
			views_per_visit: 1,
			bounce_rate: 66.67,
			visit_duration_ms: 5_000,
			engaged_ms: 15_000,
		},
	);
	assertEndpointFields(
		"product_traffic_totals",
		singleEndpointRow(payloads, "product_traffic_totals"),
		{
			visitors: 3,
			visits: 3,
			pageviews: 3,
			views_per_visit: 1,
			bounce_rate: 66.67,
			visit_duration_ms: 5_000,
			engaged_ms: 15_000,
		},
	);
	assertEndpointFields(
		"product_traffic_pages",
		singleEndpointRow(payloads, "product_traffic_pages"),
		{
			pathname,
			visitors: 3,
			visits: 3,
			pageviews: 3,
			landings: 3,
			exits: 3,
			time_on_page_ms: 5_000,
			average_scroll_depth: 25,
		},
	);
	const sourceRows = endpointRows(payloads, "product_traffic_sources");
	if (sourceRows.length !== 2) {
		throw new Error(
			`Synthetic endpoint product_traffic_sources returned ${sourceRows.length} rows, expected 2`,
		);
	}
	assertEndpointFields(
		"product_traffic_sources",
		sourceRows.find((row) => row.channel === "paid_search") ?? {},
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
	);
	const attributionRows = endpointRows(payloads, "product_attribution");
	if (attributionRows.length !== 4) {
		throw new Error(
			`Synthetic endpoint product_attribution returned ${attributionRows.length} rows, expected 4`,
		);
	}
	for (const [model, source, medium, campaign] of [
		["first", "first-touch", "first", "first-campaign"],
		["last", "last-touch", "last", "last-campaign"],
	]) {
		assertEndpointFields(
			"product_attribution",
			attributionRows.find(
				(row) => row.attribution_model === model && row.source === source,
			) ?? {},
			{
				attribution_model: model,
				source,
				medium,
				campaign,
				visitors: 3,
				visits: 3,
				pageviews: 3,
			},
		);
	}
	assertEndpointFields(
		"product_attribution",
		attributionRows.find(
			(row) => row.attribution_model === "session" && row.source === "google",
		) ?? {},
		{
			attribution_model: "session",
			source: "google",
			medium: "cpc",
			campaign: "synthetic-campaign",
			visitors: 2,
			visits: 2,
			pageviews: 2,
		},
	);
	assertEndpointFields(
		"product_attribution",
		attributionRows.find(
			(row) =>
				row.attribution_model === "session" &&
				row.source === "synthetic-partner",
		) ?? {},
		{
			attribution_model: "session",
			source: "synthetic-partner",
			medium: "referral",
			campaign: "",
			visitors: 1,
			visits: 1,
			pageviews: 1,
		},
	);
	assertEndpointFields(
		"product_traffic_sources",
		sourceRows.find((row) => row.channel === "referral") ?? {},
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
	);
	assertEndpointFields(
		"product_traffic_countries",
		singleEndpointRow(payloads, "product_traffic_countries"),
		{ country: "US", visitors: 3, visits: 3, pageviews: 3 },
	);
	assertEndpointFields(
		"product_traffic_technology",
		singleEndpointRow(payloads, "product_traffic_technology"),
		{
			device: "desktop",
			browser: "Chrome",
			os: "macOS",
			visitors: 3,
			visits: 3,
			pageviews: 3,
		},
	);
	assertEndpointFields(
		"product_activation",
		singleEndpointRow(payloads, "product_activation"),
		{
			cohort_date: date,
			signups: 1,
			activated_creators: 1,
			activation_rate: 100,
			average_time_to_activation_ms: 1_000,
		},
	);
	assertEndpointFields(
		"product_creator_activity",
		singleEndpointRow(payloads, "product_creator_activity"),
		{
			as_of_date: date,
			dau: 1,
			wau: 1,
			mau: 1,
			daily_active_organizations: 1,
			new_creators: 1,
			returning_creators: 0,
			dau_wau_stickiness: 100,
			dau_mau_stickiness: 100,
		},
	);
	assertEndpointFields(
		"product_creator_retention",
		singleEndpointRow(payloads, "product_creator_retention"),
		{
			cohort_date: date,
			activity_date: date,
			cohort_day: 0,
			platform: "all",
			creators: 1,
			organizations: 1,
		},
	);
	assertEndpointFields(
		"product_identity_funnel",
		singleEndpointRow(payloads, "product_identity_funnel"),
		{
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
		},
	);
	const eventRows = endpointRows(payloads, "product_events_daily");
	const eventKey = (
		eventName,
		platform,
		changeKind = "",
		planId = "",
		channel = "direct",
		schemaVersion = eventSchemaVersion(eventName),
	) =>
		`${eventName}:${platform}:${changeKind}:${planId}:${channel}:${schemaVersion}`;
	const expectedEvents = new Map(
		[
			{
				eventName: "page_view",
				source: "client",
				platform: "web",
				events: 2,
				actors: 2,
				channel: "paid_search",
				users: 0,
				organizations: 0,
			},
			{
				eventName: "page_view",
				source: "client",
				platform: "web",
				channel: "referral",
				users: 0,
				organizations: 0,
			},
			{
				eventName: "page_engagement",
				source: "client",
				platform: "web",
				users: 0,
				organizations: 0,
			},
			{
				eventName: "identity_linked",
				source: "server",
				platform: "server",
				events: 2,
				actors: 2,
				users: 2,
			},
			{ eventName: "user_signed_up", source: "server", platform: "web" },
			{
				eventName: "share_link_created",
				source: "server",
				platform: "server",
				events: 2,
			},
			{
				eventName: "recording_completed",
				source: "client",
				platform: "desktop",
				recordingStatus: "success",
			},
			{
				eventName: "guest_checkout_started",
				source: "server",
				platform: "web",
				planId: "price_pro_annual",
				events: 2,
				actors: 2,
				users: 0,
				organizations: 0,
				quantity: 1,
			},
			{
				eventName: "checkout_started",
				source: "server",
				platform: "web",
				planId: "price_pro_annual",
				quantity: 1,
				onboarding: "false",
			},
			{
				eventName: "checkout_started",
				source: "server",
				platform: "desktop",
				planId: "price_pro_annual",
				quantity: 1,
				onboarding: "false",
			},
			{
				eventName: "checkout_started",
				source: "server",
				platform: "mobile",
				planId: "price_pro_annual",
				quantity: 1,
				onboarding: "false",
			},
			{
				eventName: "trial_started",
				source: "server",
				platform: "web",
				planId: "price_pro_annual",
				subscriptionStatus: "trialing",
				currency: "GBP",
				billingInterval: "year",
				quantity: 1,
				guestCheckout: "false",
				onboarding: "false",
				trialEndAt: 1_900_604_800,
			},
			{
				eventName: "purchase_completed",
				source: "server",
				platform: "web",
				planId: "price_pro_annual",
				paymentStatus: "paid",
				subscriptionStatus: "active",
				currency: "GBP",
				billingInterval: "year",
				revenueMinor: 2_500,
				quantity: 1,
				firstPurchase: "true",
				guestCheckout: "false",
				onboarding: "false",
			},
			{
				eventName: "purchase_completed",
				source: "server",
				platform: "web",
				planId: "price_guest_monthly",
				paymentStatus: "paid",
				subscriptionStatus: "active",
				currency: "GBP",
				billingInterval: "month",
				revenueMinor: 1_500,
				quantity: 1,
				firstPurchase: "true",
				guestCheckout: "true",
				onboarding: "false",
			},
			{
				eventName: "subscription_renewed",
				source: "server",
				platform: "server",
				planId: "price_pro_annual",
				currency: "GBP",
				revenueMinor: 2_500,
				schemaVersion: 2,
			},
			{
				eventName: "subscription_renewed",
				source: "server",
				platform: "server",
				currency: "GBP",
				revenueMinor: 1_000,
				schemaVersion: 1,
			},
			{
				eventName: "trial_converted",
				source: "server",
				platform: "server",
				planId: "price_pro_annual",
				subscriptionStatus: "active",
				previousStatus: "trialing",
				newStatus: "active",
				schemaVersion: 2,
			},
			{
				eventName: "subscription_changed",
				source: "server",
				platform: "server",
				planId: "price_pro_annual",
				changeKind: "plan",
				previousPlanId: "price_pro_monthly",
				schemaVersion: 2,
			},
			{
				eventName: "subscription_changed",
				source: "server",
				platform: "server",
				planId: "price_pro_annual",
				changeKind: "seats",
				previousPlanId: "price_pro_annual",
				previousQuantity: 1,
				newQuantity: 3,
				seatDelta: 2,
				schemaVersion: 2,
			},
			{
				eventName: "subscription_cancelled",
				source: "server",
				platform: "server",
				planId: "price_pro_annual",
				subscriptionStatus: "canceled",
				cancelAtPeriodEnd: "false",
				endedAt: 1_900_000_000,
				schemaVersion: 2,
			},
			{
				eventName: "subscription_refunded",
				source: "server",
				platform: "server",
				planId: "price_pro_annual",
				currency: "GBP",
				revenueMinor: -500,
				fullyRefunded: "false",
				schemaVersion: 2,
			},
			{
				eventName: "subscription_payment_failed",
				source: "server",
				platform: "server",
				planId: "price_pro_annual",
				currency: "GBP",
				amountDueMinor: 2_500,
				attemptCount: 2,
				schemaVersion: 2,
			},
			{
				eventName: "experiment_exposed",
				source: "client",
				platform: "web",
				experimentId: "synthetic-checkout-copy",
				experimentVariant: "treatment",
				assignmentVersion: "v1",
			},
			{
				eventName: "analytics_delivery_loss",
				source: "client",
				platform: "desktop",
				deliveryLossCount: 3,
			},
		].map((expected) => [
			eventKey(
				expected.eventName,
				expected.platform,
				expected.changeKind,
				expected.planId,
				expected.channel,
				expected.schemaVersion,
			),
			expected,
		]),
	);
	if (eventRows.length !== expectedEvents.size) {
		throw new Error(
			`Synthetic endpoint product_events_daily returned ${eventRows.length} rows, expected ${expectedEvents.size}`,
		);
	}
	for (const row of eventRows) {
		const expected = expectedEvents.get(
			eventKey(
				row.event_name,
				row.platform,
				row.change_kind,
				row.plan_id,
				row.channel,
				Number(row.schema_version),
			),
		);
		if (!expected) {
			throw new Error(
				`Synthetic endpoint product_events_daily returned unexpected event ${row.event_name}`,
			);
		}
		assertEndpointFields("product_events_daily", row, {
			date,
			event_name: expected.eventName,
			source: expected.source,
			platform: expected.platform,
			schema_version:
				expected.schemaVersion ?? eventSchemaVersion(expected.eventName),
			app_version: appVersion,
			hostname,
			channel: expected.channel ?? "direct",
			events: expected.events ?? 1,
			actors: expected.actors ?? 1,
			users: expected.users ?? 1,
			organizations: expected.organizations ?? 1,
			plan_id: expected.planId ?? "",
			recording_status: expected.recordingStatus ?? "",
			payment_status: expected.paymentStatus ?? "",
			subscription_status: expected.subscriptionStatus ?? "",
			currency: expected.currency ?? "",
			billing_interval: expected.billingInterval ?? "",
			change_kind: expected.changeKind ?? "",
			previous_status: expected.previousStatus ?? "",
			new_status: expected.newStatus ?? "",
			previous_plan_id: expected.previousPlanId ?? "",
			quantity: expected.quantity ?? 0,
			previous_quantity: expected.previousQuantity ?? 0,
			new_quantity: expected.newQuantity ?? 0,
			seat_delta: expected.seatDelta ?? 0,
			first_purchase: expected.firstPurchase ?? "",
			guest_checkout: expected.guestCheckout ?? "",
			onboarding: expected.onboarding ?? "",
			cancel_at_period_end: expected.cancelAtPeriodEnd ?? "",
			fully_refunded: expected.fullyRefunded ?? "",
			ended_at: expected.endedAt ?? 0,
			trial_end_at: expected.trialEndAt ?? 0,
			amount_due_minor: expected.amountDueMinor ?? 0,
			attempt_count: expected.attemptCount ?? 0,
			experiment_id: expected.experimentId ?? "",
			experiment_variant: expected.experimentVariant ?? "",
			assignment_version: expected.assignmentVersion ?? "",
			delivery_loss_count: expected.deliveryLossCount ?? 0,
			revenue_minor: expected.revenueMinor ?? 0,
		});
	}
	const adoptionRows = endpointRows(payloads, "product_feature_adoption");
	const expectedAdoption = new Map(
		[
			["page_view", 3, 0, 0, 3],
			["page_engagement", 1, 0],
			["identity_linked", 2, 2, 1],
			["user_signed_up", 1, 1],
			["share_link_created", 2, 1],
			["recording_completed", 1, 1],
			["guest_checkout_started", 2, 0, 0, 2],
			["checkout_started", 3, 1],
			["trial_started", 1, 1],
			["purchase_completed", 2, 1],
			["subscription_renewed", 2, 1],
			["trial_converted", 1, 1],
			["subscription_changed", 2, 1],
			["subscription_cancelled", 1, 1],
			["subscription_refunded", 1, 1],
			["subscription_payment_failed", 1, 1],
			["experiment_exposed", 1, 1],
			["analytics_delivery_loss", 1, 1],
		].map(
			([
				eventName,
				events,
				authenticated,
				organizations = authenticated,
				actorDays = Math.max(1, authenticated),
			]) => [eventName, { events, authenticated, organizations, actorDays }],
		),
	);
	if (adoptionRows.length !== expectedAdoption.size) {
		throw new Error(
			`Synthetic endpoint product_feature_adoption returned ${adoptionRows.length} rows, expected ${expectedAdoption.size}`,
		);
	}
	for (const row of adoptionRows) {
		const expected = expectedAdoption.get(row.event_name);
		if (!expected) {
			throw new Error(
				`Synthetic endpoint product_feature_adoption returned unexpected event ${row.event_name}`,
			);
		}
		assertEndpointFields("product_feature_adoption", row, {
			event_name: row.event_name,
			events: expected.events,
			actor_days: expected.actorDays,
			user_days: expected.authenticated,
			organization_days: expected.organizations,
		});
	}
	const experimentRows = endpointRows(payloads, "product_experiment_outcomes");
	if (experimentRows.length !== 3) {
		throw new Error(
			`Synthetic endpoint product_experiment_outcomes returned ${experimentRows.length} rows, expected 3`,
		);
	}
	for (const [outcomeName, convertedActors] of [
		["signup", 0],
		["share_created", 1],
		["paid_purchase", 0],
	]) {
		assertEndpointFields(
			"product_experiment_outcomes",
			experimentRows.find((row) => row.outcome_name === outcomeName) ?? {},
			{
				experiment_id: "synthetic-checkout-copy",
				assignment_version: "v1",
				variant: "treatment",
				platform: "web",
				app_version: appVersion,
				outcome_name: outcomeName,
				exposed_actors: 1,
				converted_actors: convertedActors,
				conversion_rate: convertedActors * 100,
			},
		);
	}
	const freshness = singleEndpointRow(payloads, "product_analytics_freshness");
	for (const field of [
		"latest_received_hour",
		"product_calculated_at",
		"traffic_calculated_at",
		"retention_calculated_at",
		"identity_calculated_at",
		"attribution_calculated_at",
		"experiment_calculated_at",
	]) {
		if (typeof freshness[field] !== "string" || freshness[field].length === 0) {
			throw new Error(
				`Synthetic endpoint product_analytics_freshness.${field} is missing`,
			);
		}
	}
};

export const assertRepresentativeEndpointCoverage = ({
	daySpan = 1,
	dimensionBucketCount,
	expectedEvents,
	payloads,
}) => {
	const cohorts = expectedEvents / 10;
	const boundedDimensions = dimensionBucketCount ?? cohorts;
	if (
		!Number.isInteger(cohorts) ||
		cohorts < 1 ||
		!Number.isInteger(daySpan) ||
		daySpan < 1 ||
		daySpan > cohorts ||
		!Number.isInteger(boundedDimensions) ||
		boundedDimensions < 1 ||
		boundedDimensions > cohorts
	) {
		throw new Error("Representative endpoint fixture dimensions are invalid");
	}
	const activeDays = Math.min(daySpan, cohorts);
	const greatestCommonDivisor = (left, right) => {
		let dividend = left;
		let divisor = right;
		while (divisor !== 0) {
			const remainder = dividend % divisor;
			dividend = divisor;
			divisor = remainder;
		}
		return dividend;
	};
	const distinctDateDimensionPairs = Math.min(
		cohorts,
		(daySpan * boundedDimensions) /
			greatestCommonDivisor(daySpan, boundedDimensions),
	);
	const completeDailyEventRows = distinctDateDimensionPairs * 10;
	const sum = (rows, field) =>
		rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
	const expectedRows = {
		product_traffic_overview: activeDays,
		product_traffic_totals: 1,
		product_traffic_pages: boundedDimensions,
		product_traffic_sources: boundedDimensions,
		product_attribution: boundedDimensions + 2,
		product_traffic_countries: 1,
		product_traffic_technology: 1,
		product_activation: activeDays,
		product_creator_activity: 1,
		product_creator_retention: activeDays,
		product_identity_funnel: 1,
		product_events_daily: Math.min(1_000, completeDailyEventRows),
		product_feature_adoption: 10,
		product_experiment_outcomes: boundedDimensions * 3,
		product_analytics_freshness: 1,
	};
	for (const [name, count] of Object.entries(expectedRows)) {
		const rows = endpointRows(payloads, name);
		if (rows.length !== count) {
			throw new Error(
				`Representative endpoint ${name} returned ${rows.length} rows, expected ${count}`,
			);
		}
	}
	const exactTotals = [
		["product_traffic_overview", "pageviews", cohorts],
		["product_traffic_totals", "pageviews", cohorts],
		["product_traffic_pages", "pageviews", cohorts],
		["product_traffic_sources", "pageviews", cohorts],
		["product_attribution", "pageviews", cohorts * 3],
		["product_activation", "signups", cohorts],
		["product_creator_activity", "dau", Math.ceil(cohorts / daySpan)],
		["product_creator_retention", "creators", cohorts],
		["product_identity_funnel", "linked_users", cohorts],
		["product_identity_funnel", "purchasers", cohorts],
		["product_feature_adoption", "events", expectedEvents],
		["product_experiment_outcomes", "exposed_actors", cohorts * 3],
		["product_experiment_outcomes", "converted_actors", cohorts * 3],
	];
	for (const [name, field, expected] of exactTotals) {
		const actual = sum(endpointRows(payloads, name), field);
		if (actual !== expected) {
			throw new Error(
				`Representative endpoint ${name}.${field} totaled ${actual}, expected ${expected}`,
			);
		}
	}
	const dailyEventRows = endpointRows(payloads, "product_events_daily");
	if (completeDailyEventRows <= 1_000) {
		for (const [field, expected] of [
			["events", expectedEvents],
			["revenue_minor", cohorts * 2_000],
		]) {
			const actual = sum(dailyEventRows, field);
			if (actual !== expected) {
				throw new Error(
					`Representative endpoint product_events_daily.${field} totaled ${actual}, expected ${expected}`,
				);
			}
		}
	} else if (
		sum(dailyEventRows, "events") <= 0 ||
		sum(dailyEventRows, "revenue_minor") <= 0
	) {
		throw new Error(
			"Representative endpoint product_events_daily returned an empty truncated window",
		);
	}
};

export const syntheticMonetizationFilterQueries = ({
	date,
	deploymentId,
	syntheticRunId,
}) => {
	const base = {
		start_date: date,
		end_date: date,
		synthetic_run_id: syntheticRunId,
		__tb__deployment: deploymentId,
	};
	return [
		{
			label: "authenticated_paid_purchase",
			parameters: {
				...base,
				event_name: "purchase_completed",
				payment_status: "paid",
				currency: "gbp",
				plan_id: "price_pro_annual",
			},
			expectedRows: 1,
			expectedEvents: 1,
			expectedRevenueMinor: 2_500,
		},
		{
			label: "guest_paid_purchase",
			parameters: {
				...base,
				event_name: "purchase_completed",
				payment_status: "paid",
				currency: "gbp",
				plan_id: "price_guest_monthly",
			},
			expectedRows: 1,
			expectedEvents: 1,
			expectedRevenueMinor: 1_500,
		},
		{
			label: "unpaid_checkout_not_purchase",
			parameters: {
				...base,
				event_name: "purchase_completed",
				payment_status: "unpaid",
			},
			expectedRows: 0,
			expectedEvents: 0,
			expectedRevenueMinor: 0,
		},
		{
			label: "trial_without_revenue",
			parameters: {
				...base,
				event_name: "trial_started",
				subscription_status: "trialing",
				currency: "gbp",
				plan_id: "price_pro_annual",
			},
			expectedRows: 1,
			expectedEvents: 1,
			expectedRevenueMinor: 0,
		},
		{
			label: "renewal_revenue",
			parameters: {
				...base,
				event_name: "subscription_renewed",
				currency: "gbp",
				plan_id: "price_pro_annual",
			},
			expectedRows: 1,
			expectedEvents: 1,
			expectedRevenueMinor: 2_500,
			expectedFields: { schema_version: 2, plan_id: "price_pro_annual" },
		},
		{
			label: "legacy_renewal_without_plan",
			parameters: {
				...base,
				event_name: "subscription_renewed",
				schema_version: 1,
			},
			expectedRows: 1,
			expectedEvents: 1,
			expectedRevenueMinor: 1_000,
			expectedFields: { schema_version: 1, plan_id: "" },
		},
		{
			label: "refund_revenue",
			parameters: {
				...base,
				event_name: "subscription_refunded",
				currency: "gbp",
				plan_id: "price_pro_annual",
			},
			expectedRows: 1,
			expectedEvents: 1,
			expectedRevenueMinor: -500,
			expectedFields: { fully_refunded: "false" },
		},
		{
			label: "trial_conversion",
			parameters: {
				...base,
				event_name: "trial_converted",
				plan_id: "price_pro_annual",
				previous_status: "trialing",
				new_status: "active",
			},
			expectedRows: 1,
			expectedEvents: 1,
			expectedRevenueMinor: 0,
			expectedFields: { subscription_status: "active" },
		},
		{
			label: "plan_change",
			parameters: {
				...base,
				event_name: "subscription_changed",
				change_kind: "plan",
				plan_id: "price_pro_annual",
			},
			expectedRows: 1,
			expectedEvents: 1,
			expectedRevenueMinor: 0,
			expectedFields: { previous_plan_id: "price_pro_monthly" },
		},
		{
			label: "seat_change",
			parameters: {
				...base,
				event_name: "subscription_changed",
				change_kind: "seats",
				plan_id: "price_pro_annual",
			},
			expectedRows: 1,
			expectedEvents: 1,
			expectedRevenueMinor: 0,
			expectedFields: {
				previous_quantity: 1,
				new_quantity: 3,
				seat_delta: 2,
			},
		},
		{
			label: "cancellation",
			parameters: {
				...base,
				event_name: "subscription_cancelled",
				plan_id: "price_pro_annual",
				subscription_status: "canceled",
				cancel_at_period_end: "false",
			},
			expectedRows: 1,
			expectedEvents: 1,
			expectedRevenueMinor: 0,
			expectedFields: { ended_at: 1_900_000_000 },
		},
		{
			label: "payment_failure",
			parameters: {
				...base,
				event_name: "subscription_payment_failed",
				plan_id: "price_pro_annual",
				currency: "gbp",
			},
			expectedRows: 1,
			expectedEvents: 1,
			expectedRevenueMinor: 0,
			expectedFields: { amount_due_minor: 2_500, attempt_count: 2 },
		},
	];
};

export const syntheticIdentityFilterQueries = ({
	date,
	deploymentId,
	syntheticRunId,
}) => {
	const base = {
		start_date: date,
		end_date: date,
		synthetic_run_id: syntheticRunId,
		__tb__deployment: deploymentId,
	};
	return [
		{
			label: "paid_search_identity",
			parameters: { ...base, source: "google" },
			expected: {
				linked_visitors: 1,
				linked_users: 1,
				signup_users: 1,
				organizations: 1,
				guest_checkout_visitors: 1,
				guest_purchasers: 1,
				purchasers: 1,
			},
		},
		{
			label: "referral_identity",
			parameters: { ...base, source: "synthetic-partner" },
			expected: {
				linked_visitors: 1,
				linked_users: 1,
				signup_users: 0,
				organizations: 0,
				guest_checkout_visitors: 0,
				guest_purchasers: 0,
				purchasers: 0,
			},
		},
		{
			label: "missing_identity_source",
			parameters: { ...base, source: "does-not-exist" },
			expected: {
				linked_visitors: 0,
				linked_users: 0,
				signup_users: 0,
				organizations: 0,
				guest_checkout_visitors: 0,
				guest_purchasers: 0,
				purchasers: 0,
			},
		},
	];
};

export const assertSyntheticIdentityFilters = ({ payloads, queries }) => {
	for (const query of queries) {
		const rows = payloads[query.label]?.data;
		if (!Array.isArray(rows) || rows.length !== 1) {
			throw new Error(
				`Synthetic identity filter ${query.label} did not return one totals row`,
			);
		}
		assertEndpointFields(
			`synthetic identity filter ${query.label}`,
			rows[0],
			query.expected,
		);
	}
};

export const assertSyntheticMonetizationFilters = ({ payloads, queries }) => {
	for (const query of queries) {
		const rows = payloads[query.label]?.data;
		if (!Array.isArray(rows) || rows.length !== query.expectedRows) {
			throw new Error(
				`Synthetic monetization filter ${query.label} returned ${Array.isArray(rows) ? rows.length : "invalid"} rows, expected ${query.expectedRows}`,
			);
		}
		const events = rows.reduce(
			(total, row) => total + Number(row.events ?? 0),
			0,
		);
		const revenueMinor = rows.reduce(
			(total, row) => total + Number(row.revenue_minor ?? 0),
			0,
		);
		if (
			events !== query.expectedEvents ||
			revenueMinor !== query.expectedRevenueMinor
		) {
			throw new Error(
				`Synthetic monetization filter ${query.label} returned ${events} events and ${revenueMinor} revenue minor units`,
			);
		}
		if (query.expectedFields && rows.length === 1) {
			assertEndpointFields(
				`synthetic monetization filter ${query.label}`,
				rows[0],
				query.expectedFields,
			);
		}
	}
};

export const normalizeCopyAssertions = (payload) => {
	const row = payload?.data?.[0] ?? {};
	const number = (value) => Number(value ?? 0);
	return {
		decisionMarkers: number(row.decision_markers),
		trafficMarkers: number(row.traffic_markers),
		trafficPageMarkers: number(row.traffic_page_markers),
		activationMarkers: number(row.activation_markers),
		retentionMarkers: number(row.retention_markers),
		identityMarkers: number(row.identity_markers),
		attributionMarkers: number(row.attribution_markers),
		experimentMarkers: number(row.experiment_markers),
		healthMarkers: number(row.health_markers),
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

export const assertSyntheticLoadHealth = (health, expectedEvents) => {
	if (
		!Number.isInteger(expectedEvents) ||
		expectedEvents < 1 ||
		health.receivedRows < expectedEvents ||
		health.uniqueEvents !== expectedEvents ||
		health.uniquePayloads !== expectedEvents ||
		health.duplicateRows !== health.receivedRows - health.uniquePayloads ||
		health.payloadConflicts !== 0
	) {
		throw new Error("Synthetic load did not match the accepted event set");
	}
};

export const percentile = (samples, quantile) => {
	if (samples.length === 0) {
		throw new Error("At least one latency sample is required");
	}
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.ceil(quantile * sorted.length) - 1];
};

export const latencySummary = (samples) => {
	if (samples.length === 0) {
		throw new Error("At least one latency sample is required");
	}
	const meanMs =
		samples.reduce((total, sample) => total + sample, 0) / samples.length;
	const variance =
		samples.reduce((total, sample) => total + (sample - meanMs) ** 2, 0) /
		samples.length;
	const standardDeviationMs = Math.sqrt(variance);
	return {
		count: samples.length,
		minMs: Math.min(...samples),
		maxMs: Math.max(...samples),
		meanMs: Number(meanMs.toFixed(3)),
		standardDeviationMs: Number(standardDeviationMs.toFixed(3)),
		coefficientOfVariation:
			meanMs === 0 ? 0 : Number((standardDeviationMs / meanMs).toFixed(4)),
		p50Ms: percentile(samples, 0.5),
		p95Ms: percentile(samples, 0.95),
		p99Ms: percentile(samples, 0.99),
	};
};

export const evaluateIngestionPerformanceBudget = ({
	smoke,
	sustained,
	batchP95BudgetMs,
	smokeWallClockBudgetMs,
	minimumRowsPerSecond,
}) => {
	if (
		![batchP95BudgetMs, smokeWallClockBudgetMs, minimumRowsPerSecond].every(
			Number.isFinite,
		) ||
		batchP95BudgetMs <= 0 ||
		smokeWallClockBudgetMs <= 0 ||
		minimumRowsPerSecond <= 0
	) {
		throw new Error("Ingestion performance budget inputs are invalid");
	}
	const profile = {
		batchSize: 500,
		concurrency: 4,
		smokeRows: 1_000,
		smokeBatches: 2,
		sustainedRows: 100_000,
		sustainedBatches: 200,
	};
	const integrity = (measured, rows, batches) =>
		measured.rowsPlanned === rows &&
		measured.rowsAttempted === rows &&
		measured.rowsAccepted === rows &&
		measured.batchSize === profile.batchSize &&
		measured.concurrency === profile.concurrency &&
		measured.batches === batches &&
		measured.batchLatency?.count === batches &&
		measured.errorCount === 0 &&
		measured.errorRate === 0 &&
		measured.retryAttempts === 0 &&
		Number.isFinite(measured.wallClockMs) &&
		measured.wallClockMs > 0;
	const smokeIntegrity = integrity(
		smoke,
		profile.smokeRows,
		profile.smokeBatches,
	);
	const sustainedIntegrity = integrity(
		sustained,
		profile.sustainedRows,
		profile.sustainedBatches,
	);
	const sustainedRowsPerSecond = sustainedIntegrity
		? (sustained.rowsAccepted * 1_000) / sustained.wallClockMs
		: 0;
	const smokePassed =
		smokeIntegrity &&
		smoke.wallClockMs <= smokeWallClockBudgetMs &&
		smoke.batchLatency.maxMs <= batchP95BudgetMs;
	const sustainedPassed =
		sustainedIntegrity &&
		sustained.batchLatency.p95Ms <= batchP95BudgetMs &&
		sustainedRowsPerSecond >= minimumRowsPerSecond;
	return {
		profile,
		batchP95BudgetMs,
		smokeWallClockBudgetMs,
		minimumRowsPerSecond,
		smoke: {
			integrityPassed: smokeIntegrity,
			wallClockMs: smoke.wallClockMs,
			batchMaxMs: smoke.batchLatency?.maxMs,
			passed: smokePassed,
		},
		sustained: {
			integrityPassed: sustainedIntegrity,
			wallClockMs: sustained.wallClockMs,
			batchP95Ms: sustained.batchLatency?.p95Ms,
			rowsPerSecond: Number(sustainedRowsPerSecond.toFixed(3)),
			passed: sustainedPassed,
		},
		passed: smokePassed && sustainedPassed,
	};
};

export const evaluateIngestionVisibility = ({
	budgetMs,
	decisionPipelineMs,
	rawVisibilityMs,
}) => {
	for (const [name, value] of Object.entries({
		budgetMs,
		decisionPipelineMs,
		rawVisibilityMs,
	})) {
		if (!Number.isFinite(value) || value < 0) {
			throw new Error(`${name} must be a non-negative finite number`);
		}
	}
	const visibilityMs = Math.max(rawVisibilityMs, decisionPipelineMs);
	return {
		budgetMs,
		decisionPipelineMs,
		passed: visibilityMs <= budgetMs,
		rawVisibilityMs,
		visibilityMs,
	};
};

export const evaluateCopyPerformanceBudget = ({
	absolutePipelineMs,
	absoluteVisibilityP95Ms,
	baseline,
	measured,
	regressionFactor,
	regressionFloorMs,
}) => {
	const baselineValues = baseline
		? [baseline.pipelineWallClockMs, baseline.visibility.p95Ms]
		: [];
	if (
		![
			absolutePipelineMs,
			absoluteVisibilityP95Ms,
			measured.pipelineWallClockMs,
			measured.visibility.p95Ms,
			regressionFactor,
			regressionFloorMs,
			...baselineValues,
		].every(Number.isFinite) ||
		absolutePipelineMs <= 0 ||
		absoluteVisibilityP95Ms <= 0 ||
		measured.pipelineWallClockMs < 0 ||
		measured.visibility.p95Ms < 0 ||
		regressionFactor < 1 ||
		regressionFloorMs < 0 ||
		baselineValues.some((value) => value < 0)
	) {
		throw new Error("Copy performance budget inputs are invalid");
	}
	const pipelineRegressionLimitMs = baseline
		? Math.ceil(
				Math.max(
					baseline.pipelineWallClockMs * regressionFactor,
					baseline.pipelineWallClockMs + regressionFloorMs,
				),
			)
		: null;
	const visibilityRegressionLimitMs = baseline
		? Math.ceil(
				Math.max(
					baseline.visibility.p95Ms * regressionFactor,
					baseline.visibility.p95Ms + regressionFloorMs,
				),
			)
		: null;
	return {
		mode: baseline ? "baseline_comparison" : "baseline_capture",
		absolutePipelineMs,
		absoluteVisibilityP95Ms,
		regressionFactor,
		regressionFloorMs,
		pipelineRegressionLimitMs,
		visibilityRegressionLimitMs,
		pipelineRegressionRatio:
			baseline && baseline.pipelineWallClockMs > 0
				? measured.pipelineWallClockMs / baseline.pipelineWallClockMs
				: null,
		visibilityRegressionRatio:
			baseline && baseline.visibility.p95Ms > 0
				? measured.visibility.p95Ms / baseline.visibility.p95Ms
				: null,
		passed:
			measured.pipelineWallClockMs <= absolutePipelineMs &&
			measured.visibility.p95Ms <= absoluteVisibilityP95Ms &&
			(pipelineRegressionLimitMs === null ||
				measured.pipelineWallClockMs <= pipelineRegressionLimitMs) &&
			(visibilityRegressionLimitMs === null ||
				measured.visibility.p95Ms <= visibilityRegressionLimitMs),
	};
};

const DECISION_ENDPOINT_NAMES = [
	"product_traffic_overview",
	"product_traffic_totals",
	"product_traffic_pages",
	"product_traffic_sources",
	"product_attribution",
	"product_traffic_countries",
	"product_traffic_technology",
	"product_activation",
	"product_creator_activity",
	"product_creator_retention",
	"product_identity_funnel",
	"product_events_daily",
	"product_feature_adoption",
	"product_experiment_outcomes",
	"product_analytics_freshness",
];

export const decisionEndpointQueries = ({
	startDate,
	endDate,
	deploymentId = "",
	excludedEndpointNames = [],
	includeIdentityFunnel = true,
	syntheticRunId = "",
}) =>
	DECISION_ENDPOINT_NAMES.filter(
		(name) =>
			(includeIdentityFunnel || name !== "product_identity_funnel") &&
			!excludedEndpointNames.includes(name),
	).map((name) => ({
		name,
		parameters: {
			...(name === "product_analytics_freshness"
				? {}
				: name === "product_creator_activity"
					? { as_of_date: endDate }
					: { start_date: startDate, end_date: endDate }),
			__tb__deployment: deploymentId,
			...(syntheticRunId && name !== "product_analytics_freshness"
				? { synthetic_run_id: syntheticRunId }
				: {}),
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
		"cancel-in-progress: false",
		"analytics-staging-out-of-scope-",
		"pull_request.head.sha",
		"deployment create --allow-destructive-operations --check",
		"staging-ci.js promote-deployment",
		"staging-ci.js discard-deployment",
		"environment: staging",
		"TINYBIRD_STAGING_DEPLOY_TOKEN",
		"TINYBIRD_STAGING_COPY_TOKEN",
		"TINYBIRD_STAGING_ERASURE_LOOKUP_TOKEN",
		"TINYBIRD_STAGING_SCHEDULER_TOKEN",
		"TINYBIRD_STAGING_INGEST_TOKEN",
		"TINYBIRD_STAGING_READ_TOKEN",
		"TINYBIRD_STAGING_CLEANUP_TOKEN",
		"staging-ci.js verify-preseed",
		"staging-ci.js run-copies",
		"staging-ci.js set-copy-schedules",
		"steps.deployment-state.outputs.promoted == 'true'",
		"steps.deployment-state.outputs.target == 'staging' || steps.pause-copies.outcome == 'success'",
		"steps.seed.outcome == 'skipped' || steps.verify-cleanup.outcome == 'success'",
		"attest-preview",
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
	const candidateValidation = workflow.indexOf("staging-ci.js verify-preseed");
	const promotion = workflow.indexOf("staging-ci.js promote-deployment");
	const seed = workflow.indexOf("staging-ci.js seed");
	if (
		candidateValidation < 0 ||
		promotion < 0 ||
		seed < 0 ||
		candidateValidation > promotion ||
		promotion > seed
	) {
		throw new Error(
			"Workflow must validate, promote, and then seed the exact staging deployment",
		);
	}
};
