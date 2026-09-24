import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	artifactDirectory,
	assertClean,
	executionEnvironment,
	git,
	inspectDatabase,
	jsonCommand,
	readEnvironmentSnapshot,
	run,
	saveSession,
	sessionPath,
	temporaryPath,
	waitForLock,
} from "./core.mjs";

export function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function readRecipe(session, path) {
	const absolute = resolve(path);
	const local = relative(session.worktree, absolute);
	if (local.startsWith("..") || local.startsWith("/"))
		throw new Error("Recipe must be inside the session worktree");
	git(session.worktree, "ls-files", "--error-unmatch", "--", local);
	const recipe = JSON.parse(readFileSync(absolute, "utf8"));
	if (recipe.version !== 1 || recipe.platform !== "linux")
		throw new Error(
			"This runner supports Linux recipes; use a native runner for macOS/Windows evidence",
		);
	if (
		!Array.isArray(recipe.setup) ||
		!recipe.setup.every((command) => typeof command === "string")
	)
		throw new Error("Recipe setup must be an array of shell commands");
	if (!recipe.walkthrough || typeof recipe.walkthrough !== "string")
		throw new Error("Recipe requires a walkthrough command with assertions");
	if (recipe.start && typeof recipe.start !== "string")
		throw new Error("Invalid start command");
	if (recipe.snapshot && typeof recipe.snapshot !== "string")
		throw new Error("Invalid snapshot");
	return {
		...recipe,
		path: local,
		hash: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
	};
}

export function recordCaptureReview(ctx, session, recipePath, evidence) {
	const sha = assertClean(ctx, session);
	const recipe = readRecipe(session, recipePath);
	const { fingerprint: environmentHash } = readEnvironmentSnapshot(
		ctx,
		session,
	);
	if (
		evidence.sha !== sha ||
		evidence.recipeHash !== recipe.hash ||
		evidence.environmentHash !== environmentHash ||
		evidence.sourceTrusted !== true ||
		evidence.commandsReviewed !== true ||
		evidence.credentialScopesReviewed !== true ||
		!Number.isFinite(Date.parse(evidence.reviewedAt))
	)
		throw new Error(
			"Expected trusted source, command, and credential-scope review for this commit and recipe",
		);
	session.captureReview = {
		sha,
		recipeHash: recipe.hash,
		environmentHash,
		sourceTrusted: true,
		commandsReviewed: true,
		credentialScopesReviewed: true,
		reviewedAt: evidence.reviewedAt,
	};
	saveSession(ctx, session);
	return { sha, recipe: recipe.path, reviewed: true };
}

function assertCaptureReviewed(ctx, session, sha, recipe) {
	if (recipe.database === false) return;
	const review = session.captureReview;
	if (
		review?.sha !== sha ||
		review?.recipeHash !== recipe.hash ||
		review?.environmentHash !==
			readEnvironmentSnapshot(ctx, session).fingerprint ||
		review.sourceTrusted !== true ||
		review.commandsReviewed !== true ||
		review.credentialScopesReviewed !== true
	)
		throw new Error(
			"Credentialed capture requires a trusted review of this exact commit and recipe; use capture-review first",
		);
}

export async function remoteCommand(sandbox, command, env = {}, timeout = 300) {
	const result = await sandbox.process.executeCommand(
		command,
		"/home/daytona/feature",
		env,
		timeout,
	);
	if (result.exitCode !== 0) {
		const error = new Error(
			`Sandbox command failed (exit ${result.exitCode}); inspect retained private failure evidence`,
		);
		error.remoteOutput = result.result;
		throw error;
	}
	return result.result;
}

export function assertOwnedSandbox(session, sandbox) {
	if (
		sandbox.labels?.["cap.building.session"] !== session.id ||
		sandbox.labels?.["cap.building.sha"] !== session.capture?.sha
	) {
		throw new Error("Sandbox ownership or source commit mismatch");
	}
}

export function validateCaptureProbe(probe) {
	const duration = Number(probe.format?.duration);
	if (
		!probe.streams?.some(
			(stream) =>
				stream.codec_type === "video" &&
				stream.width === 1920 &&
				stream.height === 1080,
		) ||
		!Number.isFinite(duration) ||
		duration <= 0
	)
		throw new Error("Export did not contain a valid 1080p video");
}

export async function deleteSandbox(ctx, session, daytona) {
	if (!session.capture?.sandboxId || session.capture.sandboxDeleted) return;
	let sandbox;
	try {
		sandbox = await daytona.get(session.capture.sandboxId);
	} catch (error) {
		if (error.statusCode !== 404 && error.response?.status !== 404) throw error;
		session.capture.sandboxDeleted = true;
		saveSession(ctx, session);
		return;
	}
	assertOwnedSandbox(session, sandbox);
	await daytona.delete(sandbox, 60, true);
	session.capture.sandboxDeleted = true;
	saveSession(ctx, session);
}

export async function capture(ctx, session, recipePath, daytona) {
	const sha = assertClean(ctx, session);
	const recipe = readRecipe(session, recipePath);
	assertCaptureReviewed(ctx, session, sha, recipe);
	if (session.capture?.uploadAttempted && !session.capture.upload)
		throw new Error(
			"Reconcile the prior uncertain upload before creating another capture",
		);
	if (session.capture && !session.capture.sandboxDeleted) {
		throw new Error(
			"Reconcile or delete the previous owned sandbox before starting another capture",
		);
	}
	if (
		session.capture?.sha === sha &&
		session.capture?.recipeHash === recipe.hash &&
		session.capture?.status === "captured" &&
		existsSync(session.capture.file)
	) {
		return session.capture;
	}
	const release = await waitForLock(join(ctx.state, "capture.lock"), 3600000);
	const archive = temporaryPath("source.tar");
	try {
		if (assertClean(ctx, session) !== sha)
			throw new Error("Source changed while waiting for the recording slot");
		const tracked = git(session.worktree, "ls-files", "-z").split("\0");
		if (
			tracked.some(
				(path) =>
					/(^|\/)\.env($|\.)/.test(path) &&
					!/\.(example|sample|template)$/.test(path),
			)
		) {
			throw new Error(
				"Tracked environment files must be reviewed before sandbox upload",
			);
		}
		git(session.worktree, "archive", "--format=tar", "--output", archive, sha);
		if (recipe.database !== false) inspectDatabase(session);
		const env = executionEnvironment(ctx, session, { credentials: false });
		const runtimeEnv = executionEnvironment(ctx, session, {
			credentials: recipe.database !== false,
			expectedHash:
				recipe.database !== false
					? session.captureReview.environmentHash
					: undefined,
		});
		for (const key of [
			"PATH",
			"HOME",
			"USER",
			"TMPDIR",
			"SHELL",
			"SYSTEMROOT",
		]) {
			delete env[key];
			delete runtimeEnv[key];
		}
		if (session.capture) {
			session.captureHistory ??= [];
			session.captureHistory.push(session.capture);
		}
		session.capture = {
			sha,
			recipeHash: recipe.hash,
			status: "creating",
			name: `cap-building-${session.id}-${Date.now()}`,
			sandboxDeleted: false,
		};
		saveSession(ctx, session);
		let sandbox;
		try {
			sandbox = await daytona.create(
				{
					name: session.capture.name,
					snapshot: recipe.snapshot ?? "daytona-small",
					labels: {
						"cap.building.session": session.id,
						"cap.building.sha": sha,
					},
					envVars: { ...env, VNC_RESOLUTION: "1920x1080" },
					autoStopInterval: 15,
					autoDeleteInterval: 60,
					ttlMinutes: 45,
				},
				{ timeout: 120 },
			);
		} catch (error) {
			session.capture.status = "failed";
			try {
				const existing = await daytona.get(session.capture.name);
				assertOwnedSandbox(session, existing);
				session.capture.sandboxId = existing.id;
				saveSession(ctx, session);
				await deleteSandbox(ctx, session, daytona);
			} catch (cleanupError) {
				if (
					cleanupError.statusCode === 404 ||
					cleanupError.response?.status === 404
				)
					session.capture.sandboxDeleted = true;
				else session.capture.cleanupPending = true;
			}
			saveSession(ctx, session);
			throw error;
		}
		session.capture.sandboxId = sandbox.id;
		saveSession(ctx, session);
		try {
			const mkdir = await sandbox.process.executeCommand(
				"mkdir -p /home/daytona/feature",
				undefined,
				undefined,
				30,
			);
			if (mkdir.exitCode !== 0)
				throw new Error("Could not prepare sandbox workspace");
			await sandbox.fs.uploadFile(archive, "/home/daytona/source.tar");
			await remoteCommand(
				sandbox,
				"tar -xf /home/daytona/source.tar -C /home/daytona/feature",
			);
			await sandbox.computerUse.start();
			const display = await sandbox.computerUse.display.getInfo();
			if (
				display.primary_display?.width !== 1920 ||
				display.primary_display?.height !== 1080
			)
				throw new Error("Sandbox did not provide a 1920x1080 display");
			for (const command of recipe.setup)
				await remoteCommand(sandbox, command, env, 600);
			await remoteCommand(sandbox, "cap guide --json", env, 30);
			session.capture.recorder = JSON.parse(
				await remoteCommand(sandbox, "cap version --json", env, 30),
			);
			const targets = JSON.parse(
				await remoteCommand(sandbox, "cap targets --json", env, 30),
			);
			const screen = targets.screens?.[0];
			if (screen?.id === undefined || screen?.id === null)
				throw new Error("Cap CLI could not find the sandbox screen");
			const browserState = join(
				dirname(sessionPath(ctx, session.id)),
				"browser-state.json",
			);
			if (recipe.database !== false && existsSync(browserState)) {
				await sandbox.fs.uploadFile(
					browserState,
					"/home/daytona/browser-state.json",
				);
			}
			if (recipe.start) {
				await remoteCommand(
					sandbox,
					`nohup sh -c ${shellQuote(recipe.start)} > /home/daytona/feature.log 2>&1 < /dev/null &`,
					runtimeEnv,
					30,
				);
			}
			if (recipe.ready) await remoteCommand(sandbox, recipe.ready, env, 180);
			session.capture.recordingAttempted = true;
			saveSession(ctx, session);
			const started = JSON.parse(
				await remoteCommand(
					sandbox,
					`cap record start --screen ${shellQuote(screen.id)} --detach --path /home/daytona/demo.cap --json`,
					env,
					30,
				),
			);
			if (!started.recordingId)
				throw new Error("Cap CLI did not return a recording ID");
			session.capture.recordingId = started.recordingId;
			session.capture.status = "recording";
			saveSession(ctx, session);
			let walkthroughError;
			try {
				await remoteCommand(sandbox, recipe.walkthrough, env, 180);
			} catch (error) {
				walkthroughError = error;
			}
			const stopped = JSON.parse(
				await remoteCommand(
					sandbox,
					`cap record stop --id ${shellQuote(started.recordingId)} --json`,
					env,
					60,
				),
			);
			if (stopped.recordingMetaExists !== true)
				throw new Error("Recording did not finalize");
			await remoteCommand(
				sandbox,
				"cap project validate /home/daytona/demo.cap --json",
				env,
				30,
			);
			await remoteCommand(
				sandbox,
				"cap export /home/daytona/demo.cap --output /home/daytona/demo.mp4 --json",
				env,
				300,
			);
			const file = join(
				artifactDirectory(ctx, session),
				`${session.capture.name}.mp4`,
			);
			await sandbox.fs.downloadFile("/home/daytona/demo.mp4", file, 120);
			const probe = jsonCommand("ffprobe", [
				"-v",
				"error",
				"-show_streams",
				"-show_format",
				"-of",
				"json",
				file,
			]);
			validateCaptureProbe(probe);
			session.capture.file = file;
			session.capture.fileHash = createHash("sha256")
				.update(readFileSync(file))
				.digest("hex");
			session.capture.status = walkthroughError ? "failed" : "captured";
			saveSession(ctx, session);
			if (walkthroughError) throw walkthroughError;
			return session.capture;
		} catch (error) {
			session.capture.status = "failed";
			let output = String(error.remoteOutput ?? error.message);
			for (const [key, value] of Object.entries(runtimeEnv)) {
				if (/SECRET|KEY|TOKEN|DATABASE_URL/.test(key) && value)
					output = output.replaceAll(value, "[redacted]");
			}
			const log = join(
				artifactDirectory(ctx, session),
				`${session.capture.name}-failure.txt`,
			);
			writeFileSync(log, output, { mode: 0o600 });
			session.capture.failureLog = log;
			if (session.capture.recordingAttempted) {
				try {
					await sandbox.process.executeCommand(
						`cap record stop ${session.capture.recordingId ? `--id ${shellQuote(session.capture.recordingId)}` : ""} --json`,
						undefined,
						env,
						60,
					);
					await remoteCommand(
						sandbox,
						"tar -czf /home/daytona/demo-project.tar.gz -C /home/daytona demo.cap",
						env,
						60,
					);
					const project = join(
						artifactDirectory(ctx, session),
						`${session.capture.name}-failed-project.tar.gz`,
					);
					await sandbox.fs.downloadFile(
						"/home/daytona/demo-project.tar.gz",
						project,
						120,
					);
					session.capture.failedProject = project;
				} catch {
					session.capture.preserveSandbox = true;
				}
			}
			saveSession(ctx, session);
			throw error;
		} finally {
			if (!session.capture.preserveSandbox)
				await deleteSandbox(ctx, session, daytona);
		}
	} finally {
		rmSync(archive, { force: true });
		release();
	}
}

export async function shareCapture(ctx, session) {
	const sha = assertClean(ctx, session);
	if (!session.pr || session.pr.sha !== sha)
		throw new Error("Record the current published PR head before uploading");
	if (session.capture?.sha !== sha || session.capture.status !== "captured")
		throw new Error("A successful capture of the current commit is required");
	if (
		createHash("sha256")
			.update(readFileSync(session.capture.file))
			.digest("hex") !== session.capture.fileHash
	)
		throw new Error("Capture file changed");
	const release = await waitForLock(join(ctx.state, "cap-library.lock"));
	try {
		const account = jsonCommand("cap", ["account", "get", "--json"]);
		const organization =
			session.cap?.organization ?? account.defaultOrganizationId;
		if (!organization)
			throw new Error("Choose a Cap organization for PR recordings");
		if (
			!session.capture.upload &&
			organization !== account.defaultOrganizationId
		)
			throw new Error("Restore the selected Cap organization before uploading");
		const folders = jsonCommand("cap", [
			"library",
			"folders",
			"list",
			organization,
			"--root",
			"--json",
		]);
		const matching = folders.folders.filter((folder) => folder.name === "PR's");
		if (matching.length > 1)
			throw new Error(
				"Multiple PR's folders exist; resolve the folder identity first",
			);
		let folder = matching[0];
		if (!folder)
			folder = jsonCommand("cap", [
				"library",
				"folders",
				"create",
				organization,
				"PR's",
				"--yes",
				"--json",
			]);
		const folderId = folder.id ?? folder.resource?.id ?? folder.folder?.id;
		if (!folderId) throw new Error("Cap did not return a folder ID");
		session.cap = { organization, folderId };
		saveSession(ctx, session);
		if (!session.capture.upload) {
			if (session.capture.uploadAttempted)
				throw new Error(
					"Upload result is uncertain. Reconcile the named Cap before retrying; do not create a duplicate.",
				);
			session.capture.uploadAttempted = true;
			session.capture.uploadTitle = `${session.pr?.number ? `#${session.pr.number} — ` : ""}${session.name} — ${sha.slice(0, 8)}`;
			saveSession(ctx, session);
			const upload = jsonCommand("cap", [
				"upload",
				session.capture.file,
				"--name",
				session.capture.uploadTitle,
				"--json",
			]);
			if (!upload.id || !upload.link)
				throw new Error("Cap upload returned an incomplete receipt");
			session.capture.upload = { id: upload.id, link: upload.link };
			saveSession(ctx, session);
		}
		const { id, link } = session.capture.upload;
		run("cap", [
			"caps",
			"move",
			id,
			"--container",
			"personal",
			"--organization",
			organization,
			"--folder",
			folderId,
			"--yes",
			"--json",
		]);
		const metadata = jsonCommand("cap", ["caps", "get", id, "--json"]);
		const cap = metadata.cap ?? metadata;
		if (
			cap.id !== id ||
			cap.folderId !== folderId ||
			cap.organizationId !== organization
		)
			throw new Error("Cap folder placement could not be verified");
		session.capture.upload.folderVerified = true;
		saveSession(ctx, session);
		return { id, link, folderId, playbackVerificationRequired: true };
	} finally {
		release();
	}
}
