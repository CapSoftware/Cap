import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { main, renderPrBody } from "./building.mjs";
import {
	assertOwnedSandbox,
	capture,
	readRecipe,
	shareCapture,
	shellQuote,
	validateCaptureProbe,
} from "./capture.mjs";
import {
	assertClean,
	assertDevBranch,
	cloneDirectory,
	context,
	createSession,
	ensureResume,
	executionEnvironment,
	git,
	lock,
	readSession,
	saveSession,
	sessionPath,
	writeEnvironment,
} from "./core.mjs";
import { fixtureIds } from "./database.mjs";

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "cap-building-test-"));
	const repo = join(directory, "repo");
	mkdirSync(repo);
	execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
	git(repo, "config", "user.email", "test@example.invalid");
	git(repo, "config", "user.name", "Building Test");
	writeFileSync(join(repo, "file.txt"), "base\n");
	git(repo, "add", "file.txt");
	git(repo, "commit", "-m", "test: base");
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return context(repo);
}

test("creating two sessions preserves a dirty checkout and assigns independent branches and ports", async (t) => {
	const ctx = fixture(t);
	writeFileSync(join(ctx.root, "file.txt"), "staged\n");
	git(ctx.root, "add", "file.txt");
	writeFileSync(join(ctx.root, "file.txt"), "unstaged\n");
	writeFileSync(join(ctx.root, "untracked"), "user work\n");
	const index = readFileSync(join(ctx.common, "index"));
	const before = git(ctx.root, "status", "--porcelain");
	const [a, b] = [
		await createSession(ctx, {
			name: "New folders",
			target: "web",
			base: "main",
		}),
		await createSession(ctx, {
			name: "New folders",
			target: "web",
			base: "main",
		}),
	];
	assert.notEqual(a.worktree, b.worktree);
	assert.notEqual(a.ports.web, b.ports.web);
	assert.notEqual(a.ports.desktop, b.ports.desktop);
	assert.equal(a.branch, `building/${a.id}`);
	assert.equal(b.branch, `building/${b.id}`);
	assert.equal(readFileSync(join(a.worktree, "file.txt"), "utf8"), "base\n");
	assert.equal(git(ctx.root, "status", "--porcelain"), before);
	assert.deepEqual(readFileSync(join(ctx.common, "index")), index);
	assert.equal(git(ctx.root, "symbolic-ref", "--short", "HEAD"), "main");
});

test("registry lock prevents a concurrent creation without stealing ownership", async (t) => {
	const ctx = fixture(t);
	const release = lock(join(ctx.state, "registry.lock"));
	await assert.rejects(
		createSession(ctx, {
			name: "blocked",
			target: "web",
			base: "main",
			lockWaitMs: 0,
		}),
		/locked/,
	);
	release();
	const session = await createSession(ctx, {
		name: "allowed",
		target: "web",
		base: "main",
	});
	assert.equal(session.status, "active");
});

test("20 concurrent sessions preserve main and edit the same file independently", async (t) => {
	const ctx = fixture(t);
	writeFileSync(join(ctx.root, "file.txt"), "main user changes");
	const index = readFileSync(join(ctx.common, "index"));
	const sessions = await Promise.all(
		Array.from({ length: 20 }, (_, index) =>
			createSession(ctx, {
				name: `feature-${index}`,
				target: "web",
				base: "main",
			}),
		),
	);
	assert.equal(new Set(sessions.map((session) => session.worktree)).size, 20);
	assert.equal(new Set(sessions.map((session) => session.branch)).size, 20);
	assert.equal(
		new Set(sessions.map((session) => session.database.name)).size,
		20,
	);
	assert.equal(
		new Set(sessions.flatMap((session) => Object.values(session.ports))).size,
		40,
	);
	for (const session of sessions)
		writeFileSync(join(session.worktree, "file.txt"), session.id);
	for (const session of sessions)
		assert.equal(
			readFileSync(join(session.worktree, "file.txt"), "utf8"),
			session.id,
		);
	assert.equal(
		readFileSync(join(ctx.root, "file.txt"), "utf8"),
		"main user changes",
	);
	assert.deepEqual(readFileSync(join(ctx.common, "index")), index);
	assert.equal(git(ctx.root, "symbolic-ref", "--short", "HEAD"), "main");
});

test("resuming a partial creation keeps the same branch and worktree identity", async (t) => {
	const ctx = fixture(t);
	const session = await createSession(ctx, {
		name: "resume",
		target: "web",
		base: "main",
	});
	git(ctx.root, "worktree", "remove", session.worktree);
	session.status = "creating";
	saveSession(ctx, session);
	await main(["resume", "--repo", ctx.root, "--session", session.id]);
	assert.equal(readSession(ctx, session.id).status, "active");
	assert.equal(
		git(session.worktree, "symbolic-ref", "--short", "HEAD"),
		session.branch,
	);
	assert.equal(ensureResume(ctx, session).id, session.id);
});

test("session identifiers cannot escape the state directory", (t) => {
	const ctx = fixture(t);
	assert.throws(
		() => sessionPath(ctx, "../../elsewhere"),
		/Invalid session ID/,
	);
});

test("database protection rejects production, renamed, replaced, and unready branches", () => {
	const session = {
		database: { name: "building-test", parent: "main", id: "owned" },
	};
	const branch = {
		name: "building-test",
		parent_branch: "main",
		id: "owned",
		ready: true,
		production: false,
	};
	assert.doesNotThrow(() => assertDevBranch(session, branch));
	for (const change of [
		{ production: true },
		{ ready: false },
		{ name: "main" },
		{ id: "other" },
		{ parent_branch: "staging" },
	]) {
		assert.throws(() => assertDevBranch(session, { ...branch, ...change }));
	}
});

test("session commands do not inherit production integration secrets", async (t) => {
	const ctx = fixture(t);
	const session = await createSession(ctx, {
		name: "env",
		target: "web",
		base: "main",
	});
	const previous = process.env.STRIPE_SECRET_KEY;
	process.env.STRIPE_SECRET_KEY = "sk_live_fixture";
	t.after(() => {
		if (previous === undefined) delete process.env.STRIPE_SECRET_KEY;
		else process.env.STRIPE_SECRET_KEY = previous;
	});
	writeEnvironment(ctx, session, {
		STRIPE_SECRET_KEY: "sk_live_other",
		RESEND_API_KEY: "fixture",
	});
	const env = executionEnvironment(ctx, session);
	assert.equal(env.STRIPE_SECRET_KEY, undefined);
	assert.equal(env.RESEND_API_KEY, undefined);
	assert.equal(env.CAP_AWS_ENDPOINT, "http://127.0.0.1:1");
	assert.equal(env.WEB_URL, `http://127.0.0.1:${session.ports.web}`);
	assert.equal(
		statSync(join(dirname(sessionPath(ctx, session.id)), "environment.json"))
			.mode & 0o777,
		0o600,
	);
});

test("database credentials must match the recorded session identity", async (t) => {
	const ctx = fixture(t);
	const session = await createSession(ctx, {
		name: "env-identity",
		target: "web",
		base: "main",
	});
	session.database = {
		...session.database,
		id: "owned",
		username: "dev",
		host: "db.test",
	};
	writeEnvironment(ctx, session, {
		DATABASE_URL: "mysql://prod:secret@db.test/cap-production",
	});
	assert.throws(() => executionEnvironment(ctx, session), /does not match/);
	writeEnvironment(ctx, session, {
		DATABASE_URL: "mysql://dev:secret@db.test/cap-production",
	});
	assert.equal(
		new URL(executionEnvironment(ctx, session).DATABASE_URL).username,
		"dev",
	);
});

test("copy-on-write clones remain independent when one worktree changes a dependency", (t) => {
	const ctx = fixture(t);
	const source = join(ctx.root, "deps");
	mkdirSync(source);
	writeFileSync(join(source, "library"), "original");
	const a = join(ctx.root, "clone-a");
	const b = join(ctx.root, "clone-b");
	cloneDirectory(source, a);
	cloneDirectory(source, b);
	writeFileSync(join(a, "library"), "changed");
	assert.equal(readFileSync(join(source, "library"), "utf8"), "original");
	assert.equal(readFileSync(join(b, "library"), "utf8"), "original");
	assert.throws(() => cloneDirectory(source, b), /already exists/);
});

test("capture rejects dirty source and untracked or escaping recipes", async (t) => {
	const ctx = fixture(t);
	const session = await createSession(ctx, {
		name: "recipe",
		target: "web",
		base: "main",
	});
	assert.throws(
		() => readRecipe(session, join(ctx.root, "file.txt")),
		/inside/,
	);
	writeFileSync(join(session.worktree, "demo.json"), "{}");
	assert.throws(() => assertClean(ctx, session), /Commit/);
	assert.throws(
		() => readRecipe(session, join(session.worktree, "demo.json")),
		/git failed/,
	);
});

test("checks execute with a held session lock and are tied to a clean commit", async (t) => {
	const ctx = fixture(t);
	const session = await createSession(ctx, {
		name: "check",
		target: "web",
		base: "main",
	});
	const operationLock = join(
		dirname(sessionPath(ctx, session.id)),
		"operation.lock",
	);
	await main([
		"check",
		"--repo",
		ctx.root,
		"--session",
		session.id,
		"--",
		process.execPath,
		"-e",
		`if(!require('fs').existsSync(${JSON.stringify(operationLock)})) process.exit(1)`,
	]);
	const state = readSession(ctx, session.id);
	assert.equal(state.checks.length, 1);
	assert.equal(state.checks[0].sha, git(session.worktree, "rev-parse", "HEAD"));
	assert.equal(existsSync(operationLock), false);
	await assert.rejects(
		main([
			"check",
			"--repo",
			ctx.root,
			"--session",
			session.id,
			"--",
			process.execPath,
			"-e",
			"process.exit(3)",
		]),
		/exited 3/,
	);
	assert.equal(readSession(ctx, session.id).checks.length, 2);
	assert.equal(readSession(ctx, session.id).checks.at(-1).passed, false);
});

test("PR body refuses stale recordings and checks", () => {
	const session = {
		target: "web",
		database: {},
		checks: [
			{ sha: "current", passed: true, label: "Feature assertions passed" },
		],
		capture: {
			sha: "old",
			status: "captured",
			upload: { link: "https://cap.so/s/demo", folderVerified: true },
		},
	};
	assert.throws(
		() => renderPrBody(session, "new", "Explanation", "Backend only"),
		/passing checks/,
	);
	assert.throws(
		() => renderPrBody(session, "current", "Explanation"),
		/recording is missing/,
	);
	assert.match(
		renderPrBody(
			session,
			"current",
			"Explanation",
			"Changes only build tooling",
		),
		/Changes only build tooling/,
	);
});

test("a failed repeat check supersedes a previous success at the same commit", () => {
	const session = {
		target: "web",
		database: {},
		checks: [
			{ sha: "current", passed: true, label: "tests" },
			{ sha: "current", passed: false, label: "tests" },
		],
	};
	assert.throws(
		() => renderPrBody(session, "current", "Explanation", "Infrastructure"),
		/latest check attempt failed/,
	);
});

test("PR summaries do not copy private command arguments or resource identifiers", () => {
	const session = {
		target: "web",
		database: { id: "private-resource-id", name: "private-resource-name" },
		checks: [
			{
				sha: "current",
				passed: true,
				label:
					"node /Users/synthetic-user/check.mjs --token synthetic-secret tester@example.invalid",
			},
		],
	};
	const body = renderPrBody(
		session,
		"current",
		"Build tooling",
		"Infrastructure only",
	);
	assert.match(body, /1 scoped verification checks passed/);
	for (const value of [
		"/Users/",
		"synthetic-secret",
		"tester@example.invalid",
		"private-resource-id",
		"private-resource-name",
	])
		assert.equal(body.includes(value), false);
});

test("a running server allows checks in the same session", async (t) => {
	const ctx = fixture(t);
	const session = await createSession(ctx, {
		name: "server",
		target: "web",
		base: "main",
	});
	const serving = main([
		"serve",
		"--repo",
		ctx.root,
		"--session",
		session.id,
		"--",
		process.execPath,
		"-e",
		"setTimeout(() => {}, 500)",
	]);
	await delay(100);
	await main([
		"check",
		"--repo",
		ctx.root,
		"--session",
		session.id,
		"--",
		process.execPath,
		"-e",
		"process.exit(0)",
	]);
	assert.equal(
		existsSync(join(dirname(sessionPath(ctx, session.id)), "server.lock")),
		true,
	);
	await serving;
});

test("terminating a launcher stops its descendants before releasing the runtime lease", async (t) => {
	const ctx = fixture(t);
	const session = await createSession(ctx, {
		name: "process",
		target: "desktop",
		base: "main",
	});
	const pidFile = join(ctx.state, "descendant.pid");
	const source = `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],{stdio:'ignore'}); require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid)); setInterval(()=>{},1000);`;
	const wrapper = spawn(
		process.execPath,
		[
			fileURLToPath(new URL("./building.mjs", import.meta.url)),
			"serve",
			"--repo",
			ctx.root,
			"--session",
			session.id,
			"--native",
			"--",
			process.execPath,
			"-e",
			source,
		],
		{ stdio: "ignore" },
	);
	const exited = new Promise((resolveExit) =>
		wrapper.once("exit", resolveExit),
	);
	for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++)
		await delay(20);
	assert.ok(existsSync(pidFile));
	const descendant = Number(readFileSync(pidFile, "utf8"));
	t.after(() => {
		try {
			process.kill(descendant, "SIGKILL");
		} catch {}
	});
	wrapper.kill("SIGTERM");
	await exited;
	assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
	assert.equal(existsSync(join(ctx.state, "native-runtime.lock")), false);
});

test("capture verification rejects missing, nonfinite, and empty video duration", () => {
	const streams = [{ codec_type: "video", width: 1920, height: 1080 }];
	for (const duration of [undefined, "N/A", "Infinity", "", "0", "-1"]) {
		assert.throws(
			() => validateCaptureProbe({ streams, format: { duration } }),
			/valid 1080p video/,
		);
	}
	assert.doesNotThrow(() =>
		validateCaptureProbe({ streams, format: { duration: "20.5" } }),
	);
	assert.throws(
		() => validateCaptureProbe({ streams: [], format: { duration: "20.5" } }),
		/valid 1080p video/,
	);
});

test("failed export preserves the raw project before deleting the sandbox", async (t) => {
	const ctx = fixture(t);
	writeFileSync(
		join(ctx.root, "demo.json"),
		JSON.stringify({
			version: 1,
			platform: "linux",
			setup: [],
			database: false,
			walkthrough: "true",
		}),
	);
	git(ctx.root, "add", "demo.json");
	git(ctx.root, "commit", "-m", "test: demo recipe");
	const session = await createSession(ctx, {
		name: "capture",
		target: "web",
		base: "main",
	});
	let downloaded = false;
	let deleted = false;
	const sandbox = {
		id: "fixture-sandbox",
		labels: {
			"cap.building.session": session.id,
			"cap.building.sha": git(session.worktree, "rev-parse", "HEAD"),
		},
		process: {
			executeCommand: async (command) => {
				if (command.startsWith("cap targets"))
					return {
						exitCode: 0,
						result: JSON.stringify({ screens: [{ id: 0 }] }),
					};
				if (command.startsWith("cap record start"))
					return {
						exitCode: 0,
						result: JSON.stringify({ recordingId: "fixture-recording" }),
					};
				if (command.startsWith("cap record stop"))
					return {
						exitCode: 0,
						result: JSON.stringify({ recordingMetaExists: true }),
					};
				if (command.startsWith("cap export"))
					return { exitCode: 3, result: "export failed" };
				return { exitCode: 0, result: "{}" };
			},
		},
		fs: {
			uploadFile: async () => {},
			downloadFile: async (_remote, local) => {
				writeFileSync(local, "project");
				downloaded = true;
			},
		},
		computerUse: {
			start: async () => {},
			display: {
				getInfo: async () => ({
					primary_display: { width: 1920, height: 1080 },
				}),
			},
		},
	};
	const daytona = {
		create: async () => sandbox,
		get: async () => sandbox,
		delete: async () => {
			assert.ok(downloaded);
			deleted = true;
		},
	};
	await assert.rejects(
		capture(ctx, session, join(session.worktree, "demo.json"), daytona),
		/Sandbox command failed/,
	);
	assert.equal(deleted, true);
	assert.equal(readFileSync(session.capture.failedProject, "utf8"), "project");
	assert.equal(session.capture.status, "failed");
	session.capture = undefined;
	sandbox.fs.downloadFile = async () => {
		throw new Error("network unavailable");
	};
	deleted = false;
	await assert.rejects(
		capture(ctx, session, join(session.worktree, "demo.json"), daytona),
		/Sandbox command failed/,
	);
	assert.equal(deleted, false);
	assert.equal(session.capture.preserveSandbox, true);
});

test("foreign sandboxes cannot be deleted", () => {
	const session = { id: "owned", capture: { sha: "abc" } };
	assert.throws(
		() =>
			assertOwnedSandbox(session, {
				labels: { "cap.building.session": "other", "cap.building.sha": "abc" },
			}),
		/ownership/,
	);
	assert.doesNotThrow(() =>
		assertOwnedSandbox(session, {
			labels: { "cap.building.session": "owned", "cap.building.sha": "abc" },
		}),
	);
});

test("Cap sharing accepts resource receipts and retries without another upload", async (t) => {
	const ctx = fixture(t);
	const session = await createSession(ctx, {
		name: "sharing",
		target: "web",
		base: "main",
	});
	const sha = git(session.worktree, "rev-parse", "HEAD");
	const file = join(ctx.state, "fixture.mp4");
	writeFileSync(file, "fixture-video");
	session.pr = { sha, number: 42 };
	session.capture = {
		sha,
		status: "captured",
		file,
		fileHash: createHash("sha256").update(readFileSync(file)).digest("hex"),
	};
	saveSession(ctx, session);
	const bin = join(ctx.state, "bin");
	mkdirSync(bin);
	const statePath = join(ctx.state, "cap-fixture.json");
	writeFileSync(statePath, JSON.stringify({ folder: false, uploads: 0 }));
	writeFileSync(
		join(bin, "cap"),
		`#!${process.execPath}\nconst fs = require("node:fs"), path = ${JSON.stringify(statePath)}, state = JSON.parse(fs.readFileSync(path)), args = process.argv.slice(2); let result; if (args[0] === "account") result = {defaultOrganizationId: "organization"}; else if (args[2] === "list") result = {folders: state.folder ? [{id: "folder", name: "PR's"}] : []}; else if (args[2] === "create") {state.folder = true; result = {action: "created", resource: {type: "folder", id: "folder"}};} else if (args[0] === "upload") {state.uploads++; result = {id: "video", link: "https://cap.so/s/video"};} else if (args[1] === "move") {state.moved = args[args.indexOf("--folder") + 1]; result = {action: "updated", resource: {id: "video"}};} else if (args[1] === "get") result = {folderId: state.moved}; else process.exit(99); fs.writeFileSync(path, JSON.stringify(state)); console.log(JSON.stringify(result));\n`,
		{ mode: 0o755 },
	);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	try {
		const first = await shareCapture(ctx, session);
		assert.equal(first.folderId, "folder");
		assert.equal(session.capture.upload.folderVerified, true);
		const second = await shareCapture(ctx, session);
		assert.equal(second.link, first.link);
		assert.equal(JSON.parse(readFileSync(statePath, "utf8")).uploads, 1);
	} finally {
		process.env.PATH = previousPath;
	}
});

test("fixture identities are deterministic and session-specific", () => {
	assert.deepEqual(fixtureIds("one"), fixtureIds("one"));
	assert.notDeepEqual(fixtureIds("one"), fixtureIds("two"));
	assert.ok(
		Object.values(fixtureIds("one")).every((value) => value.length === 15),
	);
});

test("shell arguments preserve metacharacters without executing them", () => {
	const input = "a'$(echo unexpected)`uname` b";
	const output = execFileSync("sh", ["-c", `printf %s ${shellQuote(input)}`], {
		encoding: "utf8",
	});
	assert.equal(output, input);
});
