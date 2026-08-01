import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadTinybirdProject } from "./datafiles.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..", "..");
const TINYBIRD_PROJECT_DIR = path.join(MODULE_DIR, "tinybird");
const LOCAL_VERIFY_SCRIPT = path.join(MODULE_DIR, "verify-local.js");
const LOCAL_FIXTURE_FILE = path.join(
	TINYBIRD_PROJECT_DIR,
	"fixtures",
	"product_events_v1.local.ndjson",
);
const LOCAL_FIXTURE_DATES_FILE = path.join(
	TINYBIRD_PROJECT_DIR,
	"fixtures",
	"local-dates.json",
);
const LOCAL_ENV_FILE = path.join(PROJECT_ROOT, ".env.analytics.local");
const COMPOSE_FILE = path.join(
	PROJECT_ROOT,
	"packages",
	"local-docker",
	"docker-compose.yml",
);
const TEST_FILES = fs
	.readdirSync(path.join(MODULE_DIR, "tests"))
	.filter((fileName) => fileName.endsWith(".test.js"))
	.sort()
	.map((fileName) => path.join(MODULE_DIR, "tests", fileName));
const CLOUD_URL_DEFAULT = "https://api.tinybird.co";
const STAGING_WORKSPACE_ID = "37b8fef9-817f-4c3c-b21f-218c36a6077d";
const LOCAL_COPY_RUN_ID = "run_local_copy_assertions";
const PRODUCT_COPY_PIPES = [
	"snapshot_product_events_canonical_v1",
	"snapshot_product_events_daily_exact",
	"snapshot_product_traffic_daily_exact",
	"snapshot_product_traffic_pages_daily_exact",
	"snapshot_product_activation_daily_exact",
	"snapshot_product_creator_retention_exact",
	"snapshot_product_identity_funnel_exact",
	"snapshot_product_events_health_hourly",
];
const PRODUCT_COPY_TARGETS = [
	"product_events_canonical_v1",
	"product_events_daily_exact",
	"product_traffic_daily_exact",
	"product_traffic_pages_daily_exact",
	"product_activation_daily_exact",
	"product_creator_retention_exact",
	"product_identity_funnel_exact",
	"product_events_health_hourly_exact",
];
const WORKSPACE_ID_SOURCE =
	"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const WORKSPACE_ID_PATTERN = new RegExp(`^${WORKSPACE_ID_SOURCE}$`, "i");
const LOCAL_TOKEN_SIGNING_KEY = "tinybird-local";
const LOCAL_IDENTIFIERS = {
	workspaceId: "00000000-0000-4000-8000-000000000001",
	workspaceTokenId: "00000000-0000-4000-8000-000000000002",
	userId: "00000000-0000-4000-8000-000000000003",
	userTokenId: "00000000-0000-4000-8000-000000000004",
};
const PRODUCT_COLUMNS = [
	["event_id", "String"],
	["payload_hash", "FixedString(32)"],
	["occurred_at", "DateTime64(3)"],
	["received_at", "DateTime64(3)"],
	["event_name", "LowCardinality(String)"],
	["schema_version", "UInt16"],
	["source", "LowCardinality(String)"],
	["platform", "LowCardinality(String)"],
	["anonymous_id", "String"],
	["session_id", "String"],
	["user_id", "String"],
	["organization_id", "String"],
	["app_version", "LowCardinality(String)"],
	["pathname", "String"],
	["referrer", "String"],
	["country", "LowCardinality(String)"],
	["region", "LowCardinality(String)"],
	["city", "LowCardinality(String)"],
	["hostname", "LowCardinality(String)"],
	["browser", "LowCardinality(String)"],
	["device", "LowCardinality(String)"],
	["os", "LowCardinality(String)"],
	["channel", "LowCardinality(String)"],
	["traffic_class", "LowCardinality(String)"],
	["synthetic_run_id", "String"],
	["properties", "String"],
];
const PRODUCT_SOURCES = new Set(["client", "server"]);
const PRODUCT_PLATFORMS = new Set([
	"web",
	"desktop",
	"mobile",
	"cli",
	"server",
]);
const SERVER_ONLY_EVENTS = new Set([
	"user_signed_up",
	"checkout_started",
	"guest_checkout_started",
	"purchase_completed",
	"trial_started",
	"subscription_renewed",
	"trial_converted",
	"subscription_changed",
	"subscription_cancelled",
	"subscription_refunded",
	"subscription_payment_failed",
	"share_link_created",
	"organization_invite_sent",
	"organization_member_joined",
	"collaboration_action_created",
	"seat_quantity_changed",
	"first_view_received",
	"loom_import_started",
	"loom_import_completed",
	"loom_import_failed",
]);

const composeArgs = (...args) => [
	"compose",
	"--file",
	COMPOSE_FILE,
	"--profile",
	"analytics",
	...args,
];

const localCliStep = (...args) => ({
	command: "docker",
	args: composeArgs("run", "--rm", "tinybird-cli", ...args),
	localAuth: true,
});

const cloudCliStep = (...args) => ({
	command: "docker",
	args: composeArgs("run", "--rm", "tinybird-cloud-cli", ...args),
	cloudAuth: true,
});

const operationPlan = (operation) => {
	const plans = {
		validate: [{ type: "validate" }],
		test: [{ type: "validate" }, { type: "node-test" }],
		"compose-check": [
			{ type: "validate" },
			{ command: "docker", args: composeArgs("config", "--quiet") },
		],
		local: [
			{ type: "validate" },
			{ type: "prepare-local-fixture" },
			{ command: "docker", args: composeArgs("config", "--quiet") },
			{
				command: "docker",
				args: composeArgs(
					"up",
					"-d",
					"--wait",
					"--wait-timeout",
					"120",
					"tinybird-local",
				),
				localAuth: true,
			},
			localCliStep("--local", "build"),
			...PRODUCT_COPY_PIPES.map((name) =>
				localCliStep("--local", "copy", "pause", name),
			),
			localCliStep(
				"--local",
				"datasource",
				"append",
				"product_events_v1",
				"--file",
				"fixtures/product_events_v1.local.ndjson",
			),
			...PRODUCT_COPY_PIPES.map((name) => ({
				...localCliStep(
					"--local",
					"copy",
					"run",
					name,
					"--param",
					"copy_max_threads=1",
					"--param",
					`copy_run_id=${LOCAL_COPY_RUN_ID}`,
					"--wait",
				),
				attempts: 8,
				retryPattern: /CANNOT_SCHEDULE_TASK|no free thread/i,
			})),
			{ type: "verify-local" },
			{ type: "write-local-env" },
		],
		"local-test": [
			{ type: "validate" },
			{ type: "prepare-local-fixture" },
			{ command: "docker", args: composeArgs("config", "--quiet") },
			{
				command: "docker",
				args: composeArgs(
					"up",
					"-d",
					"--wait",
					"--wait-timeout",
					"120",
					"tinybird-local",
				),
				localAuth: true,
			},
			...PRODUCT_COPY_PIPES.map((name) =>
				localCliStep("--local", "copy", "pause", name),
			),
			localCliStep(
				"--local",
				"datasource",
				"append",
				"product_events_v1",
				"--file",
				"fixtures/product_events_v1.local.ndjson",
			),
			...PRODUCT_COPY_PIPES.map((name) => ({
				...localCliStep(
					"--local",
					"copy",
					"run",
					name,
					"--param",
					"copy_max_threads=1",
					"--param",
					`copy_run_id=${LOCAL_COPY_RUN_ID}`,
					"--wait",
				),
				attempts: 8,
				retryPattern: /CANNOT_SCHEDULE_TASK|no free thread/i,
			})),
			{ type: "verify-local" },
		],
		"local-tokens": [{ type: "write-local-env" }],
		"local-stop": [
			{
				command: "docker",
				args: composeArgs("stop", "tinybird-local"),
			},
		],
		"cloud-check": [
			{ type: "validate" },
			{ type: "verify-cloud-workspace" },
			cloudCliStep("--cloud", "deploy", "--check"),
		],
		"cloud-deploy": [
			{ type: "validate" },
			{ type: "verify-cloud-workspace" },
			cloudCliStep("--cloud", "deploy", "--check"),
			cloudCliStep("--cloud", "deploy", "--wait"),
		],
	};
	const plan = plans[operation];
	if (!plan) {
		throw new Error(
			`Unknown analytics command ${operation}. Expected one of: ${Object.keys(plans).join(", ")}.`,
		);
	}
	return plan;
};

const hasToken = (resource, name, scope) =>
	resource.tokens.some((token) => token.name === name && token.scope === scope);

const tokenGrants = (project, tokenName) => [
	...project.datasources.flatMap((datasource) =>
		datasource.tokens
			.filter(({ name }) => name === tokenName)
			.map(({ scope }) => `datasource:${datasource.name}:${scope}`),
	),
	...project.pipes.flatMap((pipe) =>
		pipe.tokens
			.filter(({ name }) => name === tokenName)
			.map(({ scope }) => `pipe:${pipe.name}:${scope}`),
	),
];

const validateExactTokenGrants = (project, tokenName, expected, issues) => {
	const actual = new Set(tokenGrants(project, tokenName));
	for (const grant of expected) {
		if (!actual.has(grant)) issues.push(`${tokenName} is missing ${grant}`);
	}
	for (const grant of actual) {
		if (!expected.has(grant)) {
			issues.push(`${tokenName} has unexpected ${grant}`);
		}
	}
};

const validateFixtures = (projectDir, issues) => {
	const fixturePath = path.join(
		projectDir,
		"fixtures",
		"product_events_v1.ndjson",
	);
	if (!fs.existsSync(fixturePath)) {
		issues.push("Missing product_events_v1 fixture data");
		return;
	}
	const eventPayloads = new Map();
	const rows = fs
		.readFileSync(fixturePath, "utf8")
		.split(/\r?\n/)
		.filter(Boolean);
	for (const [index, line] of rows.entries()) {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			issues.push(`Fixture row ${index + 1} is not valid JSON`);
			continue;
		}
		for (const [name] of PRODUCT_COLUMNS) {
			if (!(name in event)) {
				issues.push(`Fixture row ${index + 1} is missing ${name}`);
			}
		}
		if (typeof event.event_id !== "string" || !event.event_id) {
			issues.push(`Fixture row ${index + 1} has an invalid event_id`);
		} else if (
			eventPayloads.has(event.event_id) &&
			eventPayloads.get(event.event_id) !== event.payload_hash
		) {
			issues.push(
				`Fixture event_id ${event.event_id} has conflicting payload hashes`,
			);
		} else {
			eventPayloads.set(event.event_id, event.payload_hash);
		}
		if (!/^[0-9a-f]{32}$/.test(event.payload_hash ?? "")) {
			issues.push(`Fixture row ${index + 1} has an invalid payload_hash`);
		}
		if (!/^[a-z][a-z0-9_]*$/.test(event.event_name ?? "")) {
			issues.push(`Fixture row ${index + 1} has an invalid event_name`);
		}
		if (!PRODUCT_SOURCES.has(event.source)) {
			issues.push(`Fixture row ${index + 1} has an invalid source`);
		}
		if (!PRODUCT_PLATFORMS.has(event.platform)) {
			issues.push(`Fixture row ${index + 1} has an invalid platform`);
		}
		if (SERVER_ONLY_EVENTS.has(event.event_name) && event.source !== "server") {
			issues.push(
				`Fixture row ${index + 1} uses a client source for a server-only event`,
			);
		}
		if (!event.user_id && !event.anonymous_id && !event.session_id) {
			issues.push(`Fixture row ${index + 1} has no stable identity`);
		}
		if (typeof event.properties !== "string") {
			issues.push(`Fixture row ${index + 1} properties must be a JSON string`);
		} else {
			try {
				JSON.parse(event.properties);
			} catch {
				issues.push(`Fixture row ${index + 1} properties is not valid JSON`);
			}
			if (Buffer.byteLength(event.properties) > 16_384) {
				issues.push(`Fixture row ${index + 1} properties exceeds 16 KiB`);
			}
		}
	}
};

const validateAnalyticsProject = (projectDir = TINYBIRD_PROJECT_DIR) => {
	const issues = [];
	const configPath = path.join(projectDir, "tinybird.config.json");
	if (!fs.existsSync(configPath)) {
		issues.push("Missing tinybird.config.json");
	} else {
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		if (config.dev_mode !== "manual") {
			issues.push("tinybird.config.json must use dev_mode=manual");
		}
		if (!Array.isArray(config.include) || !config.include.includes(".")) {
			issues.push(
				"tinybird.config.json must include the current project folder",
			);
		}
	}

	const project = loadTinybirdProject(projectDir);
	validateExactTokenGrants(
		project,
		"product_events_copy_runner",
		new Set([
			...PRODUCT_COPY_TARGETS.map((name) => `datasource:${name}:APPEND`),
			...PRODUCT_COPY_PIPES.map((name) => `pipe:${name}:READ`),
		]),
		issues,
	);
	validateExactTokenGrants(
		project,
		"product_events_erasure_lookup",
		new Set([
			"datasource:product_events_v1:READ",
			"datasource:product_events_canonical_v1:READ",
		]),
		issues,
	);
	const datasourceNames = new Set(
		project.datasources.map((datasource) => datasource.name),
	);
	for (const pipe of project.pipes) {
		if (datasourceNames.has(pipe.name)) {
			issues.push(`Tinybird resource name ${pipe.name} is not unique`);
		}
	}
	for (const name of [
		"analytics_events",
		"analytics_pages_mv",
		"analytics_sessions_mv",
	]) {
		if (!project.datasources.some((datasource) => datasource.name === name)) {
			issues.push(`Missing existing viewer datasource ${name}`);
		}
	}

	const product = project.datasources.find(
		(datasource) => datasource.name === "product_events_v1",
	);
	if (!product) {
		issues.push("Missing product_events_v1 datasource");
	} else {
		const actualColumns = product.columns.map(({ name, type }) => [name, type]);
		if (JSON.stringify(actualColumns) !== JSON.stringify(PRODUCT_COLUMNS)) {
			issues.push(
				"product_events_v1 columns do not match the runtime contract",
			);
		}
		if (product.engine !== "MergeTree") {
			issues.push("product_events_v1 must use append-optimized MergeTree");
		}
		if (product.sortingKey !== "(received_at, event_id)") {
			issues.push("product_events_v1 must sort by receipt time and event ID");
		}
		if (product.versionColumn !== null) {
			issues.push("product_events_v1 must preserve every delivery attempt");
		}
		if (product.partitionKey !== "toYYYYMM(received_at)") {
			issues.push("product_events_v1 must use monthly receipt-time partitions");
		}
		if (product.ttl !== "toDateTime(received_at) + INTERVAL 800 DAY") {
			issues.push("product_events_v1 must retain raw deliveries for 800 days");
		}
		if (!hasToken(product, "product_events_ingest", "APPEND")) {
			issues.push("product_events_v1 is missing its append-only token");
		}
		if (!hasToken(product, "product_events_erasure_lookup", "READ")) {
			issues.push("product_events_v1 is missing its erasure lookup token");
		}
		if (hasToken(product, "product_events_agent_read", "READ")) {
			issues.push(
				"product_events_v1 must not expose raw identity data to agents",
			);
		}
	}

	const daily = project.datasources.find(
		(datasource) => datasource.name === "product_events_daily_exact",
	);
	if (!daily || daily.engine !== "AggregatingMergeTree") {
		issues.push("Missing product_events_daily_exact snapshot datasource");
	} else {
		if (hasToken(daily, "product_events_agent_read", "READ")) {
			issues.push("Product event aggregate states must be endpoint-only");
		}
		if (daily.ttl !== "date + INTERVAL 800 DAY") {
			issues.push("Product event aggregates must retain 800 days");
		}
	}
	const canonical = project.datasources.find(
		(datasource) => datasource.name === "product_events_canonical_v1",
	);
	if (!canonical || canonical.engine !== "MergeTree") {
		issues.push("Missing product_events_canonical_v1 datasource");
	} else {
		if (hasToken(canonical, "product_events_agent_read", "READ")) {
			issues.push("Canonical product events must not be readable by agents");
		}
		if (canonical.ttl !== "toDateTime(received_at) + INTERVAL 800 DAY") {
			issues.push("Canonical product events must retain 800 days");
		}
		if (!hasToken(canonical, "product_events_erasure_lookup", "READ")) {
			issues.push("Canonical product events are missing erasure lookup access");
		}
	}
	for (const [name, engine] of [
		["product_traffic_daily_exact", "AggregatingMergeTree"],
		["product_traffic_pages_daily_exact", "AggregatingMergeTree"],
		["product_activation_daily_exact", "AggregatingMergeTree"],
		["product_creator_retention_exact", "AggregatingMergeTree"],
		["product_identity_funnel_exact", "SummingMergeTree"],
	]) {
		const datasource = project.datasources.find(
			(candidate) => candidate.name === name,
		);
		if (!datasource || datasource.engine !== engine) {
			issues.push(`Missing privacy-safe aggregate datasource ${name}`);
		} else {
			if (hasToken(datasource, "product_events_agent_read", "READ")) {
				issues.push(`${name} aggregate states must be endpoint-only`);
			}
			if (!datasource.ttl?.endsWith("+ INTERVAL 800 DAY")) {
				issues.push(`${name} must retain 800 days`);
			}
		}
	}
	const healthHourly = project.datasources.find(
		(datasource) => datasource.name === "product_events_health_hourly_exact",
	);
	if (!healthHourly || healthHourly.engine !== "AggregatingMergeTree") {
		issues.push(
			"Missing product_events_health_hourly_exact aggregate datasource",
		);
	} else if (hasToken(healthHourly, "product_events_agent_read", "READ")) {
		issues.push("Product event health states must be endpoint-only");
	}
	for (const name of PRODUCT_COPY_TARGETS) {
		const datasource = project.datasources.find(
			(candidate) => candidate.name === name,
		);
		if (
			!datasource ||
			!hasToken(datasource, "product_events_copy_runner", "APPEND")
		) {
			issues.push(`${name} is missing Copy runner append access`);
		}
	}
	for (const datasource of project.datasources) {
		if (
			!PRODUCT_COPY_TARGETS.includes(datasource.name) &&
			hasToken(datasource, "product_events_copy_runner", "APPEND")
		) {
			issues.push(`${datasource.name} grants unexpected Copy runner access`);
		}
		if (
			!["product_events_v1", "product_events_canonical_v1"].includes(
				datasource.name,
			) &&
			hasToken(datasource, "product_events_erasure_lookup", "READ")
		) {
			issues.push(`${datasource.name} grants unexpected erasure lookup access`);
		}
	}
	for (const name of PRODUCT_COPY_PIPES) {
		const pipe = project.pipes.find((candidate) => candidate.name === name);
		if (!pipe) {
			issues.push(`Missing product analytics pipe ${name}`);
			continue;
		}
		if (!hasToken(pipe, "product_events_copy_runner", "READ")) {
			issues.push(`${name} is missing its execution-only Copy token`);
		}
		if (hasToken(pipe, "product_events_agent_read", "READ")) {
			issues.push(`${name} must not grant Copy execution to the agent token`);
		}
	}
	for (const name of [
		"product_events_daily",
		"product_events_health",
		"product_traffic_overview",
		"product_traffic_pages",
		"product_traffic_sources",
		"product_traffic_countries",
		"product_traffic_technology",
		"product_activation",
		"product_creator_retention",
		"product_creator_activity",
		"product_feature_adoption",
		"product_identity_funnel",
		"product_analytics_freshness",
		"product_analytics_copy_assertions",
	]) {
		const pipe = project.pipes.find((candidate) => candidate.name === name);
		if (!pipe) {
			issues.push(`Missing product analytics pipe ${name}`);
			continue;
		}
		if (
			pipe.type !== "materialized" &&
			pipe.type !== "copy" &&
			!hasToken(pipe, "product_events_agent_read", "READ")
		) {
			issues.push(`${name} is missing its read-only agent token`);
		}
		if (hasToken(pipe, "product_events_copy_runner", "READ")) {
			issues.push(`${name} must not be queryable by the Copy runner token`);
		}
	}

	validateFixtures(projectDir, issues);
	for (const testName of [
		"product_creator_retention.yaml",
		"product_events_daily.yaml",
		"product_events_health.yaml",
		"product_feature_adoption.yaml",
		"product_traffic_overview.yaml",
		"product_traffic_pages.yaml",
	]) {
		if (!fs.existsSync(path.join(projectDir, "tests", testName))) {
			issues.push(`Missing Tinybird test ${testName}`);
		}
	}
	return issues;
};

const cloudEnvironment = (env = process.env) => {
	const token = env.TINYBIRD_DEPLOY_TOKEN?.trim();
	if (!token) {
		throw new Error(
			"TINYBIRD_DEPLOY_TOKEN is required and must have WORKSPACE:DEPLOY scope.",
		);
	}
	const workspaceId = env.TINYBIRD_WORKSPACE_ID?.trim();
	if (!workspaceId || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
		throw new Error(
			"TINYBIRD_WORKSPACE_ID must be the staging workspace UUID.",
		);
	}
	if (workspaceId.toLowerCase() !== STAGING_WORKSPACE_ID) {
		throw new Error(
			"Analytics automation may deploy only to the staging workspace.",
		);
	}
	const host =
		env.TINYBIRD_URL?.trim() ||
		env.PRODUCT_ANALYTICS_TINYBIRD_HOST?.trim() ||
		CLOUD_URL_DEFAULT;
	return {
		...env,
		TINYBIRD_TOKEN: token,
		TINYBIRD_URL: host,
		TB_TOKEN: token,
		TB_HOST: host,
		TINYBIRD_WORKSPACE_ID: workspaceId,
	};
};

const encodeLocalToken = (userId, tokenId) => {
	const payload = JSON.stringify({ u: userId, id: tokenId, host: null });
	const encodedPayload = Buffer.from(payload).toString("base64url");
	const signature = createHmac("sha256", LOCAL_TOKEN_SIGNING_KEY)
		.update(encodedPayload)
		.digest("base64url");
	return `p.${encodedPayload}.${signature}`;
};

const localEnvironment = (env = process.env) => {
	const workspaceToken = encodeLocalToken(
		LOCAL_IDENTIFIERS.workspaceId,
		LOCAL_IDENTIFIERS.workspaceTokenId,
	);
	const userToken = encodeLocalToken(
		LOCAL_IDENTIFIERS.userId,
		LOCAL_IDENTIFIERS.userTokenId,
	);
	const host = `http://127.0.0.1:${env.TINYBIRD_LOCAL_PORT || "7181"}`;
	return {
		...env,
		PRODUCT_ANALYTICS_TINYBIRD_HOST: host,
		PRODUCT_ANALYTICS_TINYBIRD_TOKEN: workspaceToken,
		TB_LOCAL_USER_TOKEN: userToken,
		TB_LOCAL_WORKSPACE_TOKEN: workspaceToken,
	};
};

const parseLocalStaticToken = (output, tokenName) => {
	const blocks = output.split(/^-{20,}\s*$/m);
	for (const block of blocks) {
		const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
		const token = block.match(
			/^token:\s*(p\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/m,
		)?.[1];
		if (name === tokenName && token) return token;
	}
	return undefined;
};

const listLocalStaticToken = (environment, tokenName) => {
	const result = spawnSync(
		"docker",
		composeArgs(
			"run",
			"--rm",
			"tinybird-cli",
			"--local",
			"token",
			"ls",
			"--match",
			tokenName,
		),
		{
			cwd: PROJECT_ROOT,
			encoding: "utf8",
			env: environment,
			maxBuffer: 1024 * 1024,
		},
	);
	if (result.error || result.status !== 0) {
		throw new Error(`Tinybird Local could not list static token ${tokenName}`);
	}
	const token = parseLocalStaticToken(result.stdout, tokenName);
	if (!token) {
		throw new Error(`Tinybird Local did not create static token ${tokenName}`);
	}
	return token;
};

const localResourceToken = async (
	environment,
	tokenName,
	fetcher = fetch,
	tokenLister = listLocalStaticToken,
) => {
	const statuses = [];
	for (const token of [
		environment.TB_LOCAL_WORKSPACE_TOKEN,
		environment.TB_LOCAL_USER_TOKEN,
	]) {
		const response = await fetcher(
			new URL("/v0/tokens", environment.PRODUCT_ANALYTICS_TINYBIRD_HOST),
			{
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(15_000),
			},
		);
		statuses.push(response.status);
		if (!response.ok) continue;
		const payload = await response.json();
		const resourceToken = Array.isArray(payload.tokens)
			? payload.tokens.find((candidate) => candidate.name === tokenName)?.token
			: undefined;
		if (typeof resourceToken === "string" && resourceToken.length >= 16) {
			return resourceToken;
		}
	}
	if (statuses.every((status) => status === 403)) {
		return tokenLister(environment, tokenName);
	}
	throw new Error(
		`Tinybird Local could not resolve ${tokenName}; token API statuses: ${statuses.join(", ")}`,
	);
};

const assertSafeStep = (step) => {
	const command = [step.command, ...(step.args ?? [])].join(" ");
	if (
		/allow-destructive|workspace\s+clear|datasource\s+(delete|truncate)/i.test(
			command,
		)
	) {
		throw new Error(`Refusing destructive analytics command: ${command}`);
	}
};

const redactProcessOutput = (value) =>
	value
		.replace(/p\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
		.replace(/([?&]token=)[^&\s]+/gi, "$1[REDACTED]");

const runProcess = async (command, args, options = {}) => {
	const { attempts = 1, retryPattern, ...spawnOptions } = options;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const result = spawnSync(command, args, {
			cwd: PROJECT_ROOT,
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
			...spawnOptions,
		});
		if (result.stdout) process.stdout.write(redactProcessOutput(result.stdout));
		if (result.stderr) process.stderr.write(redactProcessOutput(result.stderr));
		if (!result.error && result.status === 0) return;
		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
		if (
			attempt < attempts &&
			retryPattern instanceof RegExp &&
			retryPattern.test(output)
		) {
			await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
			continue;
		}
		throw new Error(
			result.error?.message ??
				`Command failed with exit code ${result.status}: ${command} ${args.join(" ")}`,
		);
	}
};

const verifyCloudWorkspace = (env = process.env) => {
	const environment = cloudEnvironment(env);
	const tokenParts = environment.TINYBIRD_DEPLOY_TOKEN.split(".");
	let tokenWorkspaceId;
	try {
		const tokenPayload = JSON.parse(
			Buffer.from(tokenParts[1] ?? "", "base64url").toString("utf8"),
		);
		tokenWorkspaceId = tokenPayload.u;
	} catch {
		throw new Error("Unable to parse Tinybird deploy token identity.");
	}
	if (
		tokenParts.length !== 3 ||
		typeof tokenWorkspaceId !== "string" ||
		!WORKSPACE_ID_PATTERN.test(tokenWorkspaceId)
	) {
		throw new Error("Unable to parse Tinybird deploy token identity.");
	}
	if (
		tokenWorkspaceId.toLowerCase() !==
		environment.TINYBIRD_WORKSPACE_ID.toLowerCase()
	) {
		throw new Error(
			"Tinybird deploy token does not target TINYBIRD_WORKSPACE_ID.",
		);
	}
	return environment.TINYBIRD_WORKSPACE_ID;
};

const writeLocalEnvironmentFile = (
	filePath = LOCAL_ENV_FILE,
	environment = localEnvironment(),
	runtimeToken,
) => {
	if (typeof runtimeToken !== "string" || runtimeToken.length < 16) {
		throw new Error("A scoped Tinybird Local runtime token is required");
	}
	fs.writeFileSync(
		filePath,
		[
			`PRODUCT_ANALYTICS_TINYBIRD_HOST=${environment.PRODUCT_ANALYTICS_TINYBIRD_HOST}`,
			`PRODUCT_ANALYTICS_TINYBIRD_TOKEN=${runtimeToken}`,
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	return filePath;
};

const prepareLocalFixture = (now = new Date()) => {
	const currentDay = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate(),
	);
	const dates = Object.fromEntries(
		["2099-01-10", "2099-01-11", "2099-01-12"].map((template, index) => [
			template,
			new Date(currentDay - (2 - index) * 86_400_000)
				.toISOString()
				.slice(0, 10),
		]),
	);
	const templateRows = fs
		.readFileSync(
			path.join(TINYBIRD_PROJECT_DIR, "fixtures", "product_events_v1.ndjson"),
			"utf8",
		)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const fixtureSuffix = dates["2099-01-12"].replaceAll("-", "");
	const eventIds = new Map(
		templateRows.map((row) => [
			row.event_id,
			`${row.event_id}_${fixtureSuffix}`,
		]),
	);
	const identityFields = [
		"anonymous_id",
		"session_id",
		"user_id",
		"organization_id",
	];
	const identityIds = new Map(
		templateRows.flatMap((row) =>
			identityFields
				.map((field) => row[field])
				.filter(Boolean)
				.map((value) => [value, `${value}_${fixtureSuffix}`]),
		),
	);
	const fixtureRows = templateRows.map((templateRow) => {
		const row = structuredClone(templateRow);
		for (const [template, replacement] of Object.entries(dates)) {
			row.occurred_at = row.occurred_at.replace(template, replacement);
			row.received_at = row.received_at.replace(template, replacement);
		}
		row.event_id = eventIds.get(row.event_id);
		for (const field of identityFields) {
			if (identityIds.has(row[field])) {
				row[field] = identityIds.get(row[field]);
			}
		}
		const properties = JSON.parse(row.properties);
		for (const [key, value] of Object.entries(properties)) {
			if (typeof value === "string" && eventIds.has(value)) {
				properties[key] = eventIds.get(value);
			} else if (typeof value === "string" && identityIds.has(value)) {
				properties[key] = identityIds.get(value);
			}
		}
		row.properties = JSON.stringify(properties);
		const hashPayload = { ...row };
		delete hashPayload.payload_hash;
		row.payload_hash = createHash("sha256")
			.update(JSON.stringify(hashPayload))
			.digest("hex")
			.slice(0, 32);
		return row;
	});
	fs.writeFileSync(
		LOCAL_FIXTURE_FILE,
		`${fixtureRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
	);
	fs.writeFileSync(LOCAL_FIXTURE_DATES_FILE, `${JSON.stringify(dates)}\n`);
	return { dates, rows: fixtureRows };
};

const runAnalyticsCommand = async (operation) => {
	for (const step of operationPlan(operation)) {
		if (step.type === "validate") {
			const issues = validateAnalyticsProject();
			if (issues.length > 0) {
				throw new Error(
					`Analytics project validation failed:\n- ${issues.join("\n- ")}`,
				);
			}
			console.log("Tinybird datafiles and fixtures are valid.");
			continue;
		}
		if (step.type === "node-test") {
			await runProcess(process.execPath, ["--test", ...TEST_FILES]);
			continue;
		}
		if (step.type === "prepare-local-fixture") {
			prepareLocalFixture();
			continue;
		}
		if (step.type === "verify-cloud-workspace") {
			verifyCloudWorkspace();
			continue;
		}
		if (step.type === "write-local-env") {
			const environment = localEnvironment();
			const runtimeToken = await localResourceToken(
				environment,
				"product_events_ingest",
			);
			console.log(
				`Wrote local analytics environment to ${writeLocalEnvironmentFile(
					LOCAL_ENV_FILE,
					environment,
					runtimeToken,
				)}`,
			);
			continue;
		}
		if (step.type === "verify-local") {
			const environment = localEnvironment();
			const readToken = await localResourceToken(
				environment,
				"product_events_agent_read",
			);
			await runProcess(process.execPath, [LOCAL_VERIFY_SCRIPT], {
				env: {
					...environment,
					PRODUCT_ANALYTICS_TINYBIRD_TOKEN: readToken,
				},
			});
			continue;
		}
		assertSafeStep(step);
		await runProcess(step.command, step.args, {
			attempts: step.attempts,
			retryPattern: step.retryPattern,
			env: step.cloudAuth
				? cloudEnvironment()
				: step.localAuth
					? localEnvironment()
					: process.env,
		});
	}
};

export {
	COMPOSE_FILE,
	LOCAL_ENV_FILE,
	PRODUCT_COLUMNS,
	TINYBIRD_PROJECT_DIR,
	assertSafeStep,
	cloudEnvironment,
	composeArgs,
	localEnvironment,
	localResourceToken,
	operationPlan,
	parseLocalStaticToken,
	prepareLocalFixture,
	redactProcessOutput,
	runAnalyticsCommand,
	validateAnalyticsProject,
	verifyCloudWorkspace,
	writeLocalEnvironmentFile,
};
