import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	capture,
	deleteSandbox,
	recordCaptureReview,
	shareCapture,
} from "./capture.mjs";
import {
	assertClean,
	assertIdle,
	assertWorktree,
	context,
	createSession,
	databaseCredentials,
	ensureResume,
	execInSession,
	git,
	inspectDatabase,
	jsonCommand,
	lock,
	pscale,
	readSession,
	saveSession,
	stopSessionProcesses,
	waitForLock,
	warmDependencies,
} from "./core.mjs";
import { createDatabase, loginFixture, seedDatabase } from "./database.mjs";
import { preview } from "./preview.mjs";

const help = `Cap building workflow

new --name <feature> --target web|desktop|gpui|fullstack [--base origin/main]
status|resume --session <id>
database-create|database-attach|credentials|seed|login --session <id>
warm --session <id> --source <idle-checkout> [--rust]
run --session <id> [--native] -- <command> [args...]
serve --session <id> [--native] -- <server-command> [args...]
preview --session <id>
stop --session <id>
check --session <id> -- <command> [args...]
capture-review --session <id> --recipe <tracked-recipe.json> --evidence <review.json>
capture --session <id> --recipe <tracked-recipe.json>
sandbox-cleanup --session <id>
share --session <id>
pr --session <id> --url <pull-request-url>
pr-body --session <id> --eli5 <text-file> [--no-visual <reason>]
video-verified --session <id> --evidence <browser-check.json>
finish --session <id> [--no-visual <reason>]
close --session <id>

All commands accept --repo <checkout>. State and secrets stay in the Git common
directory. Secrets are never printed. Prefer PlanetScale MCP creation followed
by database-attach; database-create is the authenticated CLI fallback.
`;

export function renderPrBody(session, sha, eli5, noVisual) {
	if (!eli5.trim()) throw new Error("An ELI5 explanation is required");
	const latest = new Map();
	for (const check of session.checks) {
		if (check.sha === sha) latest.set(check.label, check);
	}
	const currentChecks = [...latest.values()];
	if (currentChecks.some((check) => !check.passed))
		throw new Error(
			"The latest check attempt failed; resolve it before preparing the PR body",
		);
	if (!currentChecks.length)
		throw new Error("Record passing checks for the current commit first");
	const upload =
		session.capture?.sha === sha && session.capture?.status === "captured"
			? session.capture.upload
			: undefined;
	if (upload) noVisual = undefined;
	if (!upload?.folderVerified && !noVisual?.trim())
		throw new Error(
			"Current-commit recording is missing; supply a concrete nonvisual reason only when appropriate",
		);
	const visual = upload?.folderVerified
		? `[Watch the change in Cap](${upload.link})\n\nRecorded on Linux at 1920×1080 from \`${sha}\`. ${upload.playbackVerified ? "Playback and reviewer access verified in a browser." : "Playback and reviewer access require a separate browser check."}`
		: `Not applicable: ${noVisual.trim()}`;
	return `## ELI5\n\n${eli5.trim()}\n\n## Demo\n\n${visual}\n\n## Verification\n\n${currentChecks.length} scoped verification checks passed for this commit.\n\nVerified commit: \`${sha}\`.\n\n## Limits and deployment\n\n${session.target === "web" ? "Native desktop platforms were not exercised by this workflow." : "Linux sandbox evidence does not verify macOS or Windows behavior. Record native checks separately."}\n\n${session.database.id ? "An isolated development database was used. Production schema deployment is separate from merging application code." : "No database branch was used."}\n`;
}

export function recordPr(ctx, session, url) {
	const sha = assertClean(ctx, session);
	const parsed = new URL(url);
	if (
		parsed.hostname !== "github.com" ||
		!/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(parsed.pathname)
	)
		throw new Error("Expected a GitHub PR URL");
	const remote = git(ctx.root, "remote", "get-url", "origin");
	const repository = remote.match(
		/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/,
	)?.[1];
	if (
		!repository ||
		parsed.pathname.split("/").slice(1, 3).join("/").toLowerCase() !==
			repository.toLowerCase()
	)
		throw new Error("PR repository does not match the origin remote");
	const pr = jsonCommand(
		"gh",
		[
			"pr",
			"view",
			url,
			"--json",
			"number,url,headRefOid,headRefName,state,baseRefName",
		],
		{ cwd: session.worktree },
	);
	if (pr.headRefOid !== sha || pr.headRefName !== session.branch)
		throw new Error("PR head does not match the session branch and commit");
	session.pr = { number: pr.number, url: pr.url, sha, base: pr.baseRefName };
	saveSession(ctx, session);
	return session.pr;
}

export async function closeSession(
	ctx,
	session,
	{ publication = false, noVisual } = {},
) {
	publication ||=
		session.status === "closing" && session.cleanupMode === "published";
	if (publication && session.status === "published")
		return { id: session.id, status: "published" };
	if (session.status === "closed") return { id: session.id, status: "closed" };
	const worktreeExists = existsSync(session.worktree);
	const sha = worktreeExists ? assertClean(ctx, session) : session.closeSha;
	if (
		!worktreeExists &&
		(!["closing", "published"].includes(session.status) ||
			!sha ||
			git(ctx.root, "rev-parse", session.branch) !== sha)
	)
		throw new Error("Missing worktree without a matching cleanup checkpoint");
	if (!session.pr)
		throw new Error(
			"Keep unpublished work; close requires a recorded merged or closed PR",
		);
	const pr = jsonCommand(
		"gh",
		["pr", "view", session.pr.url, "--json", "state,headRefOid"],
		{ cwd: ctx.root },
	);
	if (
		(!publication && !["MERGED", "CLOSED"].includes(pr.state)) ||
		pr.headRefOid !== sha
	)
		throw new Error("PR is still open or local commits are unpublished");
	if (publication) {
		const upload =
			session.capture?.sha === sha ? session.capture.upload : undefined;
		const reason = upload
			? undefined
			: noVisual?.trim() ||
				(session.noVisual?.sha === sha ? session.noVisual.reason : undefined);
		renderPrBody(session, sha, "Publication cleanup", reason);
		if (!reason && !upload?.playbackVerified)
			throw new Error(
				"Verify playback and reviewer access before publication cleanup",
			);
		session.noVisual = reason ? { sha, reason } : undefined;
	}
	if (session.capture && !session.capture.sandboxDeleted)
		throw new Error("Reconcile the owned sandbox before closing");
	if (session.database.createAttempted && !session.database.id)
		throw new Error("Reconcile database creation before cleanup");
	const releaseLifecycle = await waitForLock(
		join(ctx.state, "sessions", session.id, "lifecycle.lock"),
	);
	try {
		session.status = "closing";
		session.cleanupMode = publication ? "published" : "closed";
		session.closeSha = sha;
		saveSession(ctx, session);
	} finally {
		releaseLifecycle();
	}
	await stopSessionProcesses(ctx, session);
	if (worktreeExists) {
		if (assertClean(ctx, session) !== sha)
			throw new Error(
				"Source changed during cleanup; preserve unpublished work",
			);
		assertIdle(session.worktree);
	}
	if (session.database.id && session.database.status !== "deleted") {
		const branches = pscale(session, [
			"branch",
			"list",
			session.database.database,
		]);
		if (branches.some((branch) => branch.name === session.database.name)) {
			inspectDatabase(session);
			pscale(session, [
				"branch",
				"delete",
				session.database.database,
				session.database.name,
				"--force",
			]);
		}
		session.database.status = "deleted";
		saveSession(ctx, session);
	}
	if (worktreeExists) git(ctx.root, "worktree", "remove", session.worktree);
	session.status = publication ? "published" : "closed";
	saveSession(ctx, session);
	return {
		id: session.id,
		status: session.status,
		retained: "Git branch, receipts, recordings, and shared caches",
	};
}

export async function main(argv = process.argv.slice(2)) {
	const separator = argv.indexOf("--");
	const commandArgs = separator < 0 ? [] : argv.slice(separator + 1);
	const { values, positionals } = parseArgs({
		args: separator < 0 ? argv : argv.slice(0, separator),
		allowPositionals: true,
		options: {
			repo: { type: "string", default: process.cwd() },
			session: { type: "string" },
			name: { type: "string" },
			target: { type: "string", default: "web" },
			base: { type: "string" },
			source: { type: "string" },
			rust: { type: "boolean", default: false },
			native: { type: "boolean", default: false },
			recipe: { type: "string" },
			url: { type: "string" },
			eli5: { type: "string" },
			"no-visual": { type: "string" },
			evidence: { type: "string" },
			help: { type: "boolean", default: false },
		},
	});
	const command = positionals[0];
	if (!command || values.help || command === "help") return help;
	if (positionals.length > 1)
		throw new Error("Unexpected positional arguments");
	const ctx = context(values.repo);
	if (command === "new") return createSession(ctx, values);
	if (!values.session) throw new Error("--session is required");
	let session = readSession(ctx, values.session);
	if (command === "status") return session;
	if (command === "preview") return preview(ctx, session);
	if (command === "serve") {
		const releaseServer = lock(
			join(ctx.state, "sessions", session.id, "server.lock"),
		);
		let retainLease = false;
		try {
			return await execInSession(ctx, session, commandArgs, {
				runtime: values.native,
			});
		} catch (error) {
			retainLease = error.retainLease === true;
			throw error;
		} finally {
			if (!retainLease) releaseServer();
		}
	}
	const release = lock(
		join(ctx.state, "sessions", session.id, "operation.lock"),
	);
	try {
		session = readSession(ctx, values.session);
		if (
			!["resume", "close", "finish", "stop", "sandbox-cleanup"].includes(
				command,
			)
		)
			assertWorktree(ctx, session);
		switch (command) {
			case "stop":
				await stopSessionProcesses(ctx, session);
				return { stopped: true };
			case "resume":
				return ensureResume(ctx, session);
			case "database-create":
				return createDatabase(ctx, session);
			case "database-attach": {
				const branch = inspectDatabase(session);
				session.database.id = branch.id;
				session.database.status = "ready";
				saveSession(ctx, session);
				return session.database;
			}
			case "credentials":
				return databaseCredentials(ctx, session);
			case "seed":
				return await seedDatabase(ctx, session);
			case "login":
				return await loginFixture(ctx, session);
			case "warm": {
				if (!values.source) throw new Error("--source is required");
				return await warmDependencies(ctx, session, values.source, values.rust);
			}
			case "run":
				return await execInSession(ctx, session, commandArgs, {
					runtime: values.native,
				});
			case "check": {
				const sha = assertClean(ctx, session);
				let passed = false;
				try {
					await execInSession(ctx, session, commandArgs, {
						runtime: values.native,
					});
					if (assertClean(ctx, session) !== sha)
						throw new Error("Source changed during verification");
					passed = true;
				} finally {
					session.checks.push({
						sha,
						label: commandArgs.join(" "),
						passed,
						at: new Date().toISOString(),
					});
					saveSession(ctx, session);
				}
				return { sha, passed: true };
			}
			case "capture-review": {
				if (!values.recipe || !values.evidence)
					throw new Error("--recipe and --evidence are required");
				return recordCaptureReview(
					ctx,
					session,
					resolve(values.recipe),
					JSON.parse(readFileSync(values.evidence, "utf8")),
				);
			}
			case "capture": {
				if (!values.recipe) throw new Error("--recipe is required");
				const { Daytona } = await import("@daytonaio/sdk");
				return await capture(
					ctx,
					session,
					resolve(values.recipe),
					new Daytona(),
				);
			}
			case "sandbox-cleanup": {
				const { Daytona } = await import("@daytonaio/sdk");
				const daytona = new Daytona();
				if (session.capture && !session.capture.sandboxId) {
					try {
						const sandbox = await daytona.get(session.capture.name);
						session.capture.sandboxId = sandbox.id;
					} catch (error) {
						if (error.statusCode !== 404 && error.response?.status !== 404)
							throw error;
						session.capture.sandboxDeleted = true;
					}
					saveSession(ctx, session);
				}
				await deleteSandbox(ctx, session, daytona);
				return { deleted: session.capture?.sandboxDeleted };
			}
			case "share":
				return await shareCapture(ctx, session);
			case "pr":
				return recordPr(ctx, session, values.url);
			case "pr-body": {
				if (!values.eli5) throw new Error("--eli5 is required");
				return renderPrBody(
					session,
					assertClean(ctx, session),
					readFileSync(values.eli5, "utf8"),
					values["no-visual"],
				);
			}
			case "video-verified": {
				if (!values.evidence) throw new Error("--evidence is required");
				const evidence = JSON.parse(readFileSync(values.evidence, "utf8"));
				const sha = assertClean(ctx, session);
				if (
					evidence.sha !== sha ||
					evidence.url !== session.capture?.upload?.link ||
					evidence.played !== true ||
					evidence.reviewerAccess !== true ||
					!evidence.observedAt
				)
					throw new Error(
						"Expected browser evidence of playback and reviewer access for this commit and Cap URL",
					);
				session.capture.upload.playbackVerified = true;
				session.capture.upload.browserEvidence = evidence;
				saveSession(ctx, session);
				return { verified: true, sha };
			}
			case "finish":
				return await closeSession(ctx, session, {
					publication: true,
					noVisual: values["no-visual"],
				});
			case "close":
				return await closeSession(ctx, session);
			default:
				throw new Error(`Unknown command: ${command}`);
		}
	} finally {
		release();
	}
}

if (
	process.argv[1] &&
	existsSync(process.argv[1]) &&
	realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
	main()
		.then((result) => {
			if (result !== undefined)
				process.stdout.write(
					`${typeof result === "string" ? result : JSON.stringify(result, null, "\t")}\n`,
				);
		})
		.catch((error) => {
			process.stderr.write(`${error.message}\n`);
			process.exitCode = 1;
		});
}
