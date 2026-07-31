import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadTinybirdProject } from "./datafiles.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..", "..");
const TINYBIRD_PROJECT_DIR = path.join(MODULE_DIR, "tinybird");
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
const WORKSPACE_ID_SOURCE =
	"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const WORKSPACE_ID_PATTERN = new RegExp(`^${WORKSPACE_ID_SOURCE}$`, "i");
const WORKSPACE_ID_OUTPUT_PATTERN = new RegExp(
	`\\b${WORKSPACE_ID_SOURCE}\\b`,
	"gi",
);
const LOCAL_TOKEN_SIGNING_KEY = "tinybird-local";
const LOCAL_IDENTIFIERS = {
	workspaceId: "00000000-0000-4000-8000-000000000001",
	workspaceTokenId: "00000000-0000-4000-8000-000000000002",
	userId: "00000000-0000-4000-8000-000000000003",
	userTokenId: "00000000-0000-4000-8000-000000000004",
};
const PRODUCT_COLUMNS = [
	["event_id", "String"],
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
	["properties", "String"],
];
const PRODUCT_SOURCES = new Set(["client", "server"]);
const PRODUCT_PLATFORMS = new Set(["web", "desktop", "mobile", "server"]);
const SERVER_ONLY_EVENTS = new Set([
	"user_signed_up",
	"checkout_started",
	"guest_checkout_started",
	"purchase_completed",
	"organization_invite_sent",
	"organization_member_joined",
	"seat_quantity_changed",
	"first_view_received",
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
			{ command: "docker", args: composeArgs("config", "--quiet") },
			{
				command: "docker",
				args: composeArgs(
					"up",
					"-d",
					"--wait",
					"--wait-timeout",
					"60",
					"tinybird-local",
				),
				localAuth: true,
			},
			localCliStep("--local", "build"),
			localCliStep("--local", "test", "run"),
			{ type: "write-local-env" },
		],
		"local-test": [
			{ type: "validate" },
			{ command: "docker", args: composeArgs("config", "--quiet") },
			{
				command: "docker",
				args: composeArgs(
					"up",
					"-d",
					"--wait",
					"--wait-timeout",
					"60",
					"tinybird-local",
				),
				localAuth: true,
			},
			localCliStep("--local", "test", "run"),
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
	const ids = new Set();
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
		} else if (ids.has(event.event_id)) {
			issues.push(`Fixture event_id ${event.event_id} is duplicated`);
		} else {
			ids.add(event.event_id);
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
		if (product.engine !== "ReplacingMergeTree") {
			issues.push("product_events_v1 must use ReplacingMergeTree");
		}
		if (product.sortingKey !== "event_id") {
			issues.push("product_events_v1 must deduplicate by event_id");
		}
		if (product.versionColumn !== "received_at") {
			issues.push("product_events_v1 must version retries by received_at");
		}
		if (product.partitionKey !== "toYYYYMM(occurred_at)") {
			issues.push("product_events_v1 must use monthly event-time partitions");
		}
		if (product.ttl !== "toDateTime(occurred_at) + INTERVAL 400 DAY") {
			issues.push("product_events_v1 must retain events for 400 days");
		}
		if (!hasToken(product, "product_events_ingest", "APPEND")) {
			issues.push("product_events_v1 is missing its append-only token");
		}
		if (!hasToken(product, "product_events_agent_read", "READ")) {
			issues.push("product_events_v1 is missing its read-only agent token");
		}
	}

	const daily = project.datasources.find(
		(datasource) => datasource.name === "product_events_daily_mv",
	);
	if (!daily || daily.engine !== "AggregatingMergeTree") {
		issues.push("Missing product_events_daily_mv aggregate datasource");
	}
	const healthHourly = project.datasources.find(
		(datasource) => datasource.name === "product_events_health_hourly",
	);
	if (!healthHourly || healthHourly.engine !== "AggregatingMergeTree") {
		issues.push("Missing product_events_health_hourly aggregate datasource");
	}
	for (const name of [
		"materialize_product_events_daily",
		"product_events_health_hourly_mv",
		"product_events_daily",
		"product_events_health",
	]) {
		const pipe = project.pipes.find((candidate) => candidate.name === name);
		if (!pipe) {
			issues.push(`Missing product analytics pipe ${name}`);
			continue;
		}
		if (
			pipe.type !== "materialized" &&
			!hasToken(pipe, "product_events_agent_read", "READ")
		) {
			issues.push(`${name} is missing its read-only agent token`);
		}
	}

	validateFixtures(projectDir, issues);
	for (const testName of [
		"product_events_daily.yaml",
		"product_events_health.yaml",
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
			"TINYBIRD_WORKSPACE_ID must be the production workspace UUID.",
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

const runProcess = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		cwd: PROJECT_ROOT,
		stdio: "inherit",
		...options,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			result.error?.message ??
				`Command failed with exit code ${result.status}: ${command} ${args.join(" ")}`,
		);
	}
};

const runProcessCapture = (command, args, options = {}, spawn = spawnSync) => {
	const result = spawn(command, args, {
		cwd: PROJECT_ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
	if (result.error || result.status !== 0) {
		const detail =
			result.error?.message?.trim() ||
			[result.stderr, result.stdout]
				.map((output) => output?.toString().trim())
				.filter(Boolean)
				.join("\n")
				.slice(0, 2_000);
		throw new Error(
			detail
				? `Unable to verify Tinybird workspace identity: ${detail}`
				: "Unable to verify Tinybird workspace identity.",
		);
	}
	return result.stdout ?? "";
};

const verifyCloudWorkspace = (env = process.env, run = runProcessCapture) => {
	const environment = cloudEnvironment(env);
	const step = cloudCliStep(
		"--no-version-warning",
		"--cloud",
		"workspace",
		"current",
	);
	assertSafeStep(step);
	const output = run(step.command, step.args, { env: environment });
	const workspaceIds = output.match(WORKSPACE_ID_OUTPUT_PATTERN) ?? [];
	if (workspaceIds.length === 0) {
		throw new Error("Unable to parse Tinybird workspace identity.");
	}
	if (
		workspaceIds.length !== 1 ||
		workspaceIds[0]?.toLowerCase() !==
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
) => {
	fs.writeFileSync(
		filePath,
		[
			`PRODUCT_ANALYTICS_TINYBIRD_HOST=${environment.PRODUCT_ANALYTICS_TINYBIRD_HOST}`,
			`PRODUCT_ANALYTICS_TINYBIRD_TOKEN=${environment.PRODUCT_ANALYTICS_TINYBIRD_TOKEN}`,
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	return filePath;
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
			runProcess(process.execPath, ["--test", ...TEST_FILES]);
			continue;
		}
		if (step.type === "verify-cloud-workspace") {
			verifyCloudWorkspace();
			continue;
		}
		if (step.type === "write-local-env") {
			console.log(
				`Wrote local analytics environment to ${writeLocalEnvironmentFile()}`,
			);
			continue;
		}
		assertSafeStep(step);
		runProcess(step.command, step.args, {
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
	operationPlan,
	runAnalyticsCommand,
	runProcessCapture,
	validateAnalyticsProject,
	verifyCloudWorkspace,
	writeLocalEnvironmentFile,
};
