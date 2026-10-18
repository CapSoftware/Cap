import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { main } from "./building.mjs";
import {
	context,
	createSession,
	environmentPath,
	git,
	readSession,
	saveSession,
	withSessionStartup,
	writeEnvironment,
} from "./core.mjs";
import { previewProfile } from "./preview.mjs";

async function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "cap-building-lifecycle-"));
	const repo = join(directory, "repo");
	mkdirSync(repo);
	execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
	git(repo, "config", "user.email", "test@example.invalid");
	git(repo, "config", "user.name", "Building Test");
	writeFileSync(join(repo, "file"), "base");
	git(repo, "add", "file");
	git(repo, "commit", "-m", "test: base");
	const ctx = context(repo);
	const session = await createSession(ctx, {
		name: "finish",
		target: "web",
		base: "main",
	});
	const sha = git(session.worktree, "rev-parse", "HEAD");
	const provider = join(directory, "provider.json");
	const state = {
		sha,
		state: "OPEN",
		branches: [
			{
				id: "owned",
				name: session.database.name,
				parent_branch: "main",
				production: false,
				ready: true,
			},
		],
		deleted: [],
	};
	writeFileSync(provider, JSON.stringify(state));
	const bin = join(directory, "bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "gh"),
		`#!${process.execPath}\nconst fs = require("node:fs"); const state = JSON.parse(fs.readFileSync(${JSON.stringify(provider)})); console.log(JSON.stringify({state: state.state, headRefOid: state.sha}));\n`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(bin, "pscale"),
		`#!${process.execPath}\nconst fs = require("node:fs"), path = ${JSON.stringify(provider)}, state = JSON.parse(fs.readFileSync(path)), args = process.argv.slice(2); if (args[1] === "list") console.log(JSON.stringify(state.branches)); else if (args[1] === "show") console.log(JSON.stringify(state.branches.find(branch => branch.name === args[3]))); else if (args[1] === "delete") {state.deleted.push(args[3]); state.branches = state.branches.filter(branch => branch.name !== args[3]); fs.writeFileSync(path, JSON.stringify(state)); console.log("{}");} else process.exit(99);\n`,
		{ mode: 0o755 },
	);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	t.after(() => {
		process.env.PATH = previousPath;
		rmSync(directory, { recursive: true, force: true });
	});
	session.database.id = "owned";
	session.database.status = "ready";
	session.pr = { url: "https://github.com/fixture/repo/pull/1" };
	session.checks = [{ sha, label: "tests", passed: true }];
	saveSession(ctx, session);
	return { ctx, session, provider, state, sha };
}

async function serve(ctx, session) {
	const ready = join(ctx.state, `${session.id}-ready`);
	const child = spawn(
		process.execPath,
		[
			fileURLToPath(new URL("./building.mjs", import.meta.url)),
			"serve",
			"--repo",
			ctx.root,
			"--session",
			session.id,
			"--",
			process.execPath,
			"-e",
			`require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready"); setInterval(() => {}, 1000);`,
		],
		{ stdio: "ignore" },
	);
	const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
	for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++)
		await delay(20);
	assert.ok(existsSync(ready));
	return { child, exited };
}

test("finish cleans only its published resources and resume restores the retained feature", async (t) => {
	const { ctx, session, provider, sha } = await fixture(t);
	const other = await createSession(ctx, {
		name: "other",
		target: "web",
		base: "main",
	});
	writeFileSync(join(ctx.root, "file"), "staged");
	git(ctx.root, "add", "file");
	writeFileSync(join(ctx.root, "file"), "unstaged");
	writeFileSync(join(other.worktree, "file"), "other feature");
	const index = readFileSync(join(ctx.common, "index"));
	const status = git(ctx.root, "status", "--porcelain");
	const a = await serve(ctx, session);
	const b = await serve(ctx, other);
	try {
		const result = await main([
			"finish",
			"--repo",
			ctx.root,
			"--session",
			session.id,
			"--no-visual",
			"Build tooling only",
		]);
		await a.exited;
		assert.equal(result.status, "published");
		assert.equal(existsSync(session.worktree), false);
		assert.doesNotThrow(() => process.kill(b.child.pid, 0));
		assert.equal(
			readFileSync(join(other.worktree, "file"), "utf8"),
			"other feature",
		);
		assert.deepEqual(readFileSync(join(ctx.common, "index")), index);
		assert.equal(git(ctx.root, "status", "--porcelain"), status);
		assert.deepEqual(JSON.parse(readFileSync(provider, "utf8")).deleted, [
			session.database.name,
		]);
		writeEnvironment(ctx, session, { DATABASE_URL: "obsolete" });
		const resumed = await main([
			"resume",
			"--repo",
			ctx.root,
			"--session",
			session.id,
		]);
		assert.equal(git(resumed.worktree, "rev-parse", "HEAD"), sha);
		assert.equal(resumed.database.id, undefined);
		assert.equal(resumed.database.status, "planned");
		assert.equal(existsSync(environmentPath(ctx, session)), false);
		assert.equal(resumed.noVisual, undefined);
		assert.notEqual(previewProfile(ctx, session), previewProfile(ctx, other));
	} finally {
		a.child.kill("SIGTERM");
		b.child.kill("SIGTERM");
		await Promise.all([a.exited, b.exited]);
	}
});

test("resume recovers after worktree creation but before the final checkpoint", async (t) => {
	const { ctx, session } = await fixture(t);
	await main([
		"finish",
		"--repo",
		ctx.root,
		"--session",
		session.id,
		"--no-visual",
		"Build tooling only",
	]);
	const published = readSession(ctx, session.id);
	const bin = join(ctx.state, "interruption-bin");
	mkdirSync(bin);
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	writeFileSync(
		join(bin, "git"),
		`#!${process.execPath}\nconst args = process.argv.slice(2); const output = require("node:child_process").execFileSync(${JSON.stringify(realGit)}, args); process.stdout.write(output); if (args.includes("add") && args.includes("worktree")) process.exit(3);\n`,
		{ mode: 0o755 },
	);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	try {
		await assert.rejects(
			main(["resume", "--repo", ctx.root, "--session", session.id]),
			/git failed/,
		);
	} finally {
		process.env.PATH = previousPath;
	}
	assert.equal(readSession(ctx, session.id).status, "resuming");
	assert.equal(existsSync(published.worktree), true);
	const recovered = await main([
		"resume",
		"--repo",
		ctx.root,
		"--session",
		session.id,
	]);
	assert.equal(recovered.status, "active");
	assert.equal(recovered.databaseHistory.length, 1);
});

test("a prior nonvisual exemption cannot authorize cleanup of a later commit", async (t) => {
	const { ctx, session, provider, state, sha } = await fixture(t);
	session.noVisual = { sha, reason: "Build tooling only" };
	writeFileSync(join(session.worktree, "feature"), "new visual behavior");
	git(session.worktree, "add", "feature");
	git(session.worktree, "commit", "-m", "feat: visual feature");
	state.sha = git(session.worktree, "rev-parse", "HEAD");
	writeFileSync(provider, JSON.stringify(state));
	session.checks.push({ sha: state.sha, label: "tests", passed: true });
	saveSession(ctx, session);
	await assert.rejects(
		main(["finish", "--repo", ctx.root, "--session", session.id]),
		/recording is missing/,
	);
	assert.equal(existsSync(session.worktree), true);
	assert.equal(JSON.parse(readFileSync(provider, "utf8")).deleted.length, 0);
});

test("a nonvisual exemption cannot bypass verification of an uploaded recording", async (t) => {
	const { ctx, session, provider, sha } = await fixture(t);
	session.capture = {
		sha,
		status: "captured",
		sandboxDeleted: true,
		upload: { link: "https://cap.so/s/fixture", folderVerified: false },
	};
	const args = [
		"finish",
		"--repo",
		ctx.root,
		"--session",
		session.id,
		"--no-visual",
		"Build tooling only",
	];
	saveSession(ctx, session);
	await assert.rejects(main(args), /recording is missing/);
	session.capture.upload.folderVerified = true;
	saveSession(ctx, session);
	await assert.rejects(main(args), /Verify playback and reviewer access/);
	assert.equal(existsSync(session.worktree), true);
	assert.equal(JSON.parse(readFileSync(provider, "utf8")).deleted.length, 0);
	assert.equal(readSession(ctx, session.id).status, "active");
	session.capture.upload.playbackVerified = true;
	saveSession(ctx, session);
	assert.equal((await main(args)).status, "published");
	assert.equal(readSession(ctx, session.id).noVisual, undefined);
});

test("cleanup checkpoints prevent process startup and support closing a published PR", async (t) => {
	const { ctx, session, provider, state } = await fixture(t);
	await main([
		"finish",
		"--repo",
		ctx.root,
		"--session",
		session.id,
		"--no-visual",
		"Build tooling only",
	]);
	await assert.rejects(
		withSessionStartup(ctx, session, () => assert.fail("Must not start")),
		/active session/,
	);
	state.state = "MERGED";
	state.branches = [];
	writeFileSync(provider, JSON.stringify(state));
	assert.equal(
		(await main(["close", "--repo", ctx.root, "--session", session.id])).status,
		"closed",
	);
});
