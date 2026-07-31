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
	operationPlan,
	runProcessCapture,
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

test("local setup builds, tests and writes its deterministic environment", () => {
	const commands = operationPlan("local")
		.filter((step) => step.command)
		.map((step) => step.args.join(" "));
	assert.ok(commands.some((command) => command.endsWith("--local build")));
	assert.ok(commands.some((command) => command.endsWith("--local test run")));
	assert.ok(
		operationPlan("local").some((step) => step.type === "write-local-env"),
	);
	assert.ok(
		commands.some((command) =>
			command.includes("up -d --wait --wait-timeout 60 tinybird-local"),
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
		TINYBIRD_WORKSPACE_ID: "12345678-1234-4234-8234-123456789abc",
	});
	assert.equal(environment.TINYBIRD_TOKEN, "deploy-token");
	assert.equal(environment.TB_TOKEN, "deploy-token");
	assert.equal(environment.TINYBIRD_URL, "https://example.tinybird.co");
	assert.equal(environment.TB_HOST, "https://example.tinybird.co");
	assert.equal(
		environment.TINYBIRD_WORKSPACE_ID,
		"12345678-1234-4234-8234-123456789abc",
	);
});

test("cloud deploy verifies the token workspace before mutation", () => {
	const workspaceId = "12345678-1234-4234-8234-123456789abc";
	const env = {
		TINYBIRD_DEPLOY_TOKEN: "deploy-token",
		TINYBIRD_URL: "https://api.tinybird.co",
		TINYBIRD_WORKSPACE_ID: workspaceId,
	};
	assert.equal(
		verifyCloudWorkspace(env, (_command, args) => {
			assert.deepEqual(args.slice(-5), [
				"--cloud",
				"--output",
				"json",
				"workspace",
				"current",
			]);
			return JSON.stringify({ id: workspaceId, name: "production" });
		}),
		workspaceId,
	);
	assert.throws(
		() =>
			verifyCloudWorkspace(env, () =>
				JSON.stringify({
					id: "87654321-4321-4321-8321-cba987654321",
					metadata: workspaceId,
					name: "staging",
				}),
			),
		/does not target/,
	);
	assert.throws(
		() => verifyCloudWorkspace(env, () => "warning: invalid token"),
		/Unable to parse/,
	);
});

test("cloud workspace command failures retain bounded diagnostics", () => {
	assert.throws(
		() =>
			runProcessCapture("tb", [], {}, () => ({
				status: 1,
				stderr: "workspace lookup failed",
				stdout: "",
			})),
		/Unable to verify Tinybird workspace identity: workspace lookup failed/,
	);
});

test("local credentials are written to a private gitignored env file", () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cap-analytics-env-"));
	const filePath = path.join(tempRoot, ".env.analytics.local");
	try {
		writeLocalEnvironmentFile(filePath, localEnvironment({}));
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

test("fixture validation catches duplicate event IDs", () => {
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
		assert.ok(
			validateAnalyticsProject(projectDir).some((issue) =>
				issue.includes("is duplicated"),
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
			path.join(projectDir, "pipes", "materialize_product_events_daily.pipe"),
			path.join(projectDir, "pipes", "product_events_daily_mv.pipe"),
		);
		assert.ok(
			validateAnalyticsProject(projectDir).some((issue) =>
				issue.includes("resource name product_events_daily_mv is not unique"),
			),
		);
	} finally {
		fs.rmSync(tempRoot, { force: true, recursive: true });
	}
});

test("unknown analytics commands fail before executing anything", () => {
	assert.throws(() => operationPlan("unknown"), /Unknown analytics command/);
});
