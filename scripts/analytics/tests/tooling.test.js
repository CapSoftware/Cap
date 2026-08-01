import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	assertSafeStep,
	COMPOSE_FILE,
	cloudEnvironment,
	LOCAL_ENV_FILE,
	localEnvironment,
	localResourceToken,
	operationPlan,
	parseLocalStaticToken,
	prepareLocalFixture,
	redactProcessOutput,
	TINYBIRD_PROJECT_DIR,
	validateAnalyticsProject,
	verifyCloudWorkspace,
	writeLocalEnvironmentFile,
} from "../tooling.js";

test("analytics project passes deterministic static validation", () => {
	assert.deepEqual(validateAnalyticsProject(), []);
});

test("all routine operation plans reject destructive commands", () => {
	for (const operation of [
		"validate",
		"test",
		"compose-check",
		"local",
		"local-test",
		"local-tokens",
		"local-stop",
		"cloud-check",
		"cloud-deploy",
	]) {
		for (const step of operationPlan(operation)) {
			if (step.command) assert.doesNotThrow(() => assertSafeStep(step));
		}
	}
});

test("cloud deploy checks before deploying and waits for completion", () => {
	assert.ok(
		operationPlan("cloud-deploy").some(
			(step) => step.type === "verify-cloud-workspace",
		),
	);
	const commands = operationPlan("cloud-deploy")
		.filter((step) => step.command)
		.map((step) => step.args.slice(-4).join(" "));
	assert.deepEqual(commands, [
		"tinybird-cloud-cli --cloud deploy --check",
		"tinybird-cloud-cli --cloud deploy --wait",
	]);
});

test("local setup builds, verifies copied endpoints and writes its deterministic environment", () => {
	const steps = operationPlan("local");
	const commands = steps
		.filter((step) => step.command)
		.map((step) => step.args.join(" "));
	assert.ok(commands.some((command) => command.endsWith("--local build")));
	assert.ok(
		commands.some((command) =>
			command.endsWith(
				"--local datasource append product_events_v1 --file fixtures/product_events_v1.local.ndjson",
			),
		),
	);
	const appendIndex = steps.findIndex((step) =>
		step.args?.join(" ").includes("datasource append product_events_v1"),
	);
	const resetIndex = steps.findIndex(
		(step) => step.type === "reset-local-fixture",
	);
	const pauseIndexes = steps
		.map((step, index) => ({ index, command: step.args?.join(" ") ?? "" }))
		.filter(({ command }) => command.includes("--local copy pause"))
		.map(({ index }) => index);
	assert.equal(pauseIndexes.length, 19);
	assert.ok(pauseIndexes.every((index) => index < appendIndex));
	assert.ok(resetIndex > Math.max(...pauseIndexes));
	assert.ok(resetIndex < appendIndex);
	const copyCommands = commands.filter((command) =>
		command.includes("--local copy run"),
	);
	assert.equal(copyCommands.length, 16);
	assert.ok(
		copyCommands.every((command) =>
			command.includes(
				"--param copy_max_threads=1 --param copy_run_id=run_local_copy_assertions",
			),
		),
	);
	assert.equal(
		copyCommands.filter((command) => command.includes("source_cutoff=")).length,
		4,
	);
	assert.equal(
		copyCommands.filter((command) => command.includes("generation_id=")).length,
		4,
	);
	assert.equal(
		copyCommands.filter((command) => command.includes("generation_kind=hot"))
			.length,
		1,
	);
	assert.ok(steps.some((step) => step.type === "verify-local"));
	assert.ok(steps.some((step) => step.type === "write-local-env"));
	assert.ok(
		commands.some((command) =>
			command.includes("up -d --wait --wait-timeout 120 tinybird-local"),
		),
	);
	const first = localEnvironment({});
	const second = localEnvironment({});
	assert.equal(
		first.PRODUCT_ANALYTICS_TINYBIRD_TOKEN,
		second.PRODUCT_ANALYTICS_TINYBIRD_TOKEN,
	);
	assert.equal(first.PRODUCT_ANALYTICS_TINYBIRD_HOST, "http://127.0.0.1:7181");
	assert.equal(
		localEnvironment({ TINYBIRD_LOCAL_PORT: "17181" })
			.PRODUCT_ANALYTICS_TINYBIRD_HOST,
		"http://127.0.0.1:17181",
	);
	assert.match(
		first.PRODUCT_ANALYTICS_TINYBIRD_TOKEN,
		/^p\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
	);
	const compose = fs.readFileSync(COMPOSE_FILE, "utf8");
	assert.match(compose, /working_dir: \/workspace\/tinybird/);
	assert.match(
		compose,
		/tinybird:\/workspace\/tinybird:ro[\s\S]*tinybird-local-workspace\.json:\/workspace\/\.tinyb:ro/,
	);
});

test("local fixtures use bounded current dates", () => {
	const { dates, rows } = prepareLocalFixture(
		new Date("2026-07-31T12:00:00.000Z"),
	);
	assert.deepEqual(dates, {
		"2099-01-10": "2026-07-29",
		"2099-01-11": "2026-07-30",
		"2099-01-12": "2026-07-31",
	});
	const fixture = fs.readFileSync(
		path.join(
			TINYBIRD_PROJECT_DIR,
			"fixtures",
			"product_events_v1.local.ndjson",
		),
		"utf8",
	);
	assert.doesNotMatch(fixture, /2099-01-/);
	assert.match(fixture, /2026-07-31/);
	assert.ok(rows.every((row) => row.event_id.endsWith("_20260731")));
	assert.ok(
		rows.every(
			(row) => !row.anonymous_id || row.anonymous_id.endsWith("_20260731"),
		),
	);
	assert.ok(
		rows.every(
			(row) => !row.session_id || row.session_id.endsWith("_20260731"),
		),
	);
	assert.ok(
		rows.every((row) => !row.user_id || row.user_id.endsWith("_20260731")),
	);
	assert.ok(
		rows.every(
			(row) =>
				!row.organization_id || row.organization_id.endsWith("_20260731"),
		),
	);
	assert.ok(rows.every((row) => /^[0-9a-f]{32}$/.test(row.payload_hash)));
	const engagement = rows.find((row) => row.event_name === "page_engagement");
	assert.match(JSON.parse(engagement.properties).page_view_id, /_20260731$/);
});

test("local resource discovery returns only the named scoped token", async () => {
	const token = await localResourceToken(
		localEnvironment({}),
		"product_events_agent_read",
		async () =>
			new Response(
				JSON.stringify({
					tokens: [
						{ name: "workspace", token: "p.workspace-token-value" },
						{
							name: "product_events_agent_read",
							token: "p.resource-token-value",
						},
					],
				}),
				{ status: 200 },
			),
	);
	assert.equal(token, "p.resource-token-value");
});

test("local resource discovery falls back to the local user token", async () => {
	const authorizations = [];
	const token = await localResourceToken(
		localEnvironment({}),
		"product_events_ingest",
		async (_url, options) => {
			authorizations.push(options.headers.Authorization);
			if (authorizations.length === 1)
				return new Response(null, { status: 403 });
			return new Response(
				JSON.stringify({
					tokens: [
						{
							name: "product_events_ingest",
							token: "p.resource-token-value",
						},
					],
				}),
				{ status: 200 },
			);
		},
	);
	assert.equal(token, "p.resource-token-value");
	assert.equal(authorizations.length, 2);
});

test("local resource discovery uses the CLI when the token API is unsupported", async () => {
	const environment = localEnvironment({});
	const token = await localResourceToken(
		environment,
		"product_events_agent_read",
		async () => new Response(null, { status: 403 }),
		async (_environment, tokenName) => `p.${tokenName}.scoped`,
	);
	assert.equal(token, "p.product_events_agent_read.scoped");
});

test("local CLI token parsing returns only the exact named token", () => {
	const output = `
--------------------
name: product_events_ingest
token: p.ingest.secret
--------------------
name: product_events_agent_read
token: p.read.secret
--------------------
`;
	assert.equal(
		parseLocalStaticToken(output, "product_events_agent_read"),
		"p.read.secret",
	);
	assert.equal(parseLocalStaticToken(output, "missing"), undefined);
});

test("child process output redacts static and query-string tokens", () => {
	assert.equal(
		redactProcessOutput(
			"token=p.payload.signature Authorization: p.another.signature",
		),
		"token=[REDACTED] Authorization: [REDACTED]",
	);
});

test("unsafe analytics operations are blocked", () => {
	assert.throws(
		() =>
			assertSafeStep({
				command: "tb",
				args: ["deploy", "--allow-destructive-operations"],
			}),
		/Refusing destructive analytics command/,
	);
	assert.throws(
		() => assertSafeStep({ command: "tb", args: ["workspace", "clear"] }),
		/Refusing destructive analytics command/,
	);
});

test("cloud auth requires a dedicated deploy token", () => {
	assert.throws(() => cloudEnvironment({}), /TINYBIRD_DEPLOY_TOKEN/);
	assert.throws(
		() => cloudEnvironment({ TINYBIRD_DEPLOY_TOKEN: "deploy-token" }),
		/TINYBIRD_WORKSPACE_ID/,
	);
	const environment = cloudEnvironment({
		TINYBIRD_DEPLOY_TOKEN: "deploy-token",
		PRODUCT_ANALYTICS_TINYBIRD_HOST: "https://example.tinybird.co",
		TINYBIRD_WORKSPACE_ID: "37b8fef9-817f-4c3c-b21f-218c36a6077d",
	});
	assert.equal(environment.TINYBIRD_TOKEN, "deploy-token");
	assert.equal(environment.TB_TOKEN, "deploy-token");
	assert.equal(environment.TINYBIRD_URL, "https://example.tinybird.co");
	assert.equal(environment.TB_HOST, "https://example.tinybird.co");
	assert.equal(
		environment.TINYBIRD_WORKSPACE_ID,
		"37b8fef9-817f-4c3c-b21f-218c36a6077d",
	);
	assert.throws(
		() =>
			cloudEnvironment({
				TINYBIRD_DEPLOY_TOKEN: "deploy-token",
				TINYBIRD_WORKSPACE_ID: "12345678-1234-4234-8234-123456789abc",
			}),
		/only to the staging workspace/,
	);
});

test("cloud deploy verifies the token workspace before mutation", () => {
	const workspaceId = "37b8fef9-817f-4c3c-b21f-218c36a6077d";
	const token = `p.${Buffer.from(
		JSON.stringify({
			u: workspaceId,
			id: "87654321-4321-4321-8321-cba987654321",
			host: null,
		}),
	).toString("base64url")}.signature`;
	const env = {
		TINYBIRD_DEPLOY_TOKEN: token,
		TINYBIRD_URL: "https://api.tinybird.co",
		TINYBIRD_WORKSPACE_ID: workspaceId,
	};
	assert.equal(verifyCloudWorkspace(env), workspaceId);
	const wrongWorkspaceToken = `p.${Buffer.from(
		JSON.stringify({
			u: "87654321-4321-4321-8321-cba987654321",
			id: "87654321-4321-4321-8321-cba987654321",
			host: null,
		}),
	).toString("base64url")}.signature`;
	assert.throws(
		() =>
			verifyCloudWorkspace({
				...env,
				TINYBIRD_DEPLOY_TOKEN: wrongWorkspaceToken,
			}),
		/does not target/,
	);
	assert.throws(
		() =>
			verifyCloudWorkspace({
				...env,
				TINYBIRD_DEPLOY_TOKEN: "invalid-token",
			}),
		/Unable to parse Tinybird deploy token identity/,
	);
});

test("local credentials are written to a private gitignored env file", () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cap-analytics-env-"));
	const filePath = path.join(tempRoot, ".env.analytics.local");
	try {
		writeLocalEnvironmentFile(
			filePath,
			localEnvironment({}),
			"p.scoped-runtime-token",
		);
		const contents = fs.readFileSync(filePath, "utf8");
		assert.match(contents, /^PRODUCT_ANALYTICS_TINYBIRD_HOST=/m);
		assert.match(contents, /^PRODUCT_ANALYTICS_TINYBIRD_TOKEN=/m);
		if (process.platform !== "win32") {
			assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
		}
		assert.equal(path.basename(LOCAL_ENV_FILE), ".env.analytics.local");
	} finally {
		fs.rmSync(tempRoot, { force: true, recursive: true });
	}
});

test("fixture validation allows identical duplicate deliveries", () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cap-analytics-"));
	const projectDir = path.join(tempRoot, "tinybird");
	try {
		fs.cpSync(TINYBIRD_PROJECT_DIR, projectDir, { recursive: true });
		const fixturePath = path.join(
			projectDir,
			"fixtures",
			"product_events_v1.ndjson",
		);
		const firstRow = fs.readFileSync(fixturePath, "utf8").split(/\r?\n/)[0];
		fs.appendFileSync(fixturePath, `${firstRow}\n`);
		assert.deepEqual(validateAnalyticsProject(projectDir), []);
	} finally {
		fs.rmSync(tempRoot, { force: true, recursive: true });
	}
});

test("fixture validation rejects the same event ID with a different hash", () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cap-analytics-"));
	const projectDir = path.join(tempRoot, "tinybird");
	try {
		fs.cpSync(TINYBIRD_PROJECT_DIR, projectDir, { recursive: true });
		const fixturePath = path.join(
			projectDir,
			"fixtures",
			"product_events_v1.ndjson",
		);
		const fixtureContents = fs.readFileSync(fixturePath, "utf8");
		const firstRow = JSON.parse(fixtureContents.split(/\r?\n/)[0]);
		const conflictingRow = {
			...firstRow,
			payload_hash: "ffffffffffffffffffffffffffffffff",
		};
		fs.writeFileSync(
			fixturePath,
			`${fixtureContents.trimEnd()}\n${JSON.stringify(conflictingRow)}\n`,
		);
		assert.ok(
			validateAnalyticsProject(projectDir).some((issue) =>
				issue.includes("has conflicting payload hashes"),
			),
		);
	} finally {
		fs.rmSync(tempRoot, { force: true, recursive: true });
	}
});

test("project validation rejects agent access to raw product events", () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cap-analytics-"));
	const projectDir = path.join(tempRoot, "tinybird");
	try {
		fs.cpSync(TINYBIRD_PROJECT_DIR, projectDir, { recursive: true });
		const datasourcePath = path.join(
			projectDir,
			"datasources",
			"product_events_v1.datasource",
		);
		const contents = fs.readFileSync(datasourcePath, "utf8");
		fs.writeFileSync(
			datasourcePath,
			contents.replace(
				"TOKEN product_events_ingest APPEND",
				"TOKEN product_events_ingest APPEND\nTOKEN product_events_agent_read READ",
			),
		);
		assert.ok(
			validateAnalyticsProject(projectDir).some((issue) =>
				issue.includes("must not expose raw identity data to agents"),
			),
		);
	} finally {
		fs.rmSync(tempRoot, { force: true, recursive: true });
	}
});

test("project validation rejects the agent token on Copy Pipes", () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cap-analytics-"));
	const projectDir = path.join(tempRoot, "tinybird");
	try {
		fs.cpSync(TINYBIRD_PROJECT_DIR, projectDir, { recursive: true });
		const pipePath = path.join(
			projectDir,
			"pipes",
			"snapshot_product_events_canonical_v1.pipe",
		);
		const contents = fs.readFileSync(pipePath, "utf8");
		fs.writeFileSync(
			pipePath,
			contents.replace(
				"TOKEN product_events_copy_runner READ",
				"TOKEN product_events_agent_read READ",
			),
		);
		const issues = validateAnalyticsProject(projectDir);
		assert.ok(
			issues.some((issue) =>
				issue.includes("missing its execution-only Copy token"),
			),
		);
		assert.ok(
			issues.some((issue) =>
				issue.includes("must not grant Copy execution to the agent token"),
			),
		);
	} finally {
		fs.rmSync(tempRoot, { force: true, recursive: true });
	}
});

test("project validation rejects the Copy runner token on decision endpoints", () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cap-analytics-"));
	const projectDir = path.join(tempRoot, "tinybird");
	try {
		fs.cpSync(TINYBIRD_PROJECT_DIR, projectDir, { recursive: true });
		const pipePath = path.join(
			projectDir,
			"pipes",
			"product_events_health.pipe",
		);
		const contents = fs.readFileSync(pipePath, "utf8");
		fs.writeFileSync(
			pipePath,
			contents.replace(
				"\n\nNODE product_events_health_node",
				"\nTOKEN product_events_copy_runner READ\n\nNODE product_events_health_node",
			),
		);
		const issues = validateAnalyticsProject(projectDir);
		assert.ok(
			issues.some((issue) =>
				issue.includes(
					"must use an expiring resource-scoped JWT instead of static token grants",
				),
			),
		);
		assert.ok(
			issues.some((issue) =>
				issue.includes("must not be queryable by the Copy runner token"),
			),
		);
	} finally {
		fs.rmSync(tempRoot, { force: true, recursive: true });
	}
});

test("project validation rejects extra Copy and erasure lookup grants", () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cap-analytics-"));
	const projectDir = path.join(tempRoot, "tinybird");
	try {
		fs.cpSync(TINYBIRD_PROJECT_DIR, projectDir, { recursive: true });
		const datasourcePath = path.join(
			projectDir,
			"datasources",
			"product_events_v1.datasource",
		);
		const contents = fs.readFileSync(datasourcePath, "utf8");
		fs.writeFileSync(
			datasourcePath,
			contents.replace(
				"TOKEN product_events_ingest APPEND",
				"TOKEN product_events_ingest APPEND\nTOKEN product_events_copy_runner READ",
			),
		);
		const endpointPath = path.join(
			projectDir,
			"pipes",
			"product_events_health.pipe",
		);
		const endpoint = fs.readFileSync(endpointPath, "utf8");
		fs.writeFileSync(
			endpointPath,
			endpoint.replace(
				"\n\nNODE product_events_health_node",
				"\nTOKEN product_events_erasure_lookup READ\n\nNODE product_events_health_node",
			),
		);
		const issues = validateAnalyticsProject(projectDir);
		assert.ok(
			issues.some((issue) =>
				issue.includes(
					"product_events_copy_runner has unexpected datasource:product_events_v1:READ",
				),
			),
		);
		assert.ok(
			issues.some((issue) =>
				issue.includes(
					"product_events_erasure_lookup has unexpected pipe:product_events_health:READ",
				),
			),
		);
	} finally {
		fs.rmSync(tempRoot, { force: true, recursive: true });
	}
});

test("project validation rejects duplicate Tinybird resource names", () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cap-analytics-"));
	const projectDir = path.join(tempRoot, "tinybird");
	try {
		fs.cpSync(TINYBIRD_PROJECT_DIR, projectDir, { recursive: true });
		fs.copyFileSync(
			path.join(
				projectDir,
				"pipes",
				"snapshot_product_events_daily_exact.pipe",
			),
			path.join(projectDir, "pipes", "product_events_daily_exact.pipe"),
		);
		assert.ok(
			validateAnalyticsProject(projectDir).some((issue) =>
				issue.includes(
					"resource name product_events_daily_exact is not unique",
				),
			),
		);
	} finally {
		fs.rmSync(tempRoot, { force: true, recursive: true });
	}
});

test("unknown analytics commands fail before executing anything", () => {
	assert.throws(() => operationPlan("unknown"), /Unknown analytics command/);
});
