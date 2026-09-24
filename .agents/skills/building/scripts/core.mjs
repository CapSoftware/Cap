import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function run(command, args, options = {}) {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			...options,
		}).trim();
	} catch (error) {
		throw new Error(`${command} failed (exit ${error.status ?? "unknown"})`, {
			cause: error,
		});
	}
}

export function git(repo, ...args) {
	return run("git", ["-C", repo, ...args]);
}

export function jsonCommand(command, args, options) {
	return JSON.parse(run(command, args, options));
}

export function atomicJson(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	renameSync(temp, path);
}

export function lock(path) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if (error.code === "EEXIST") {
			const held = new Error(
				`Resource is locked: ${path}. Inspect its owner before recovery.`,
			);
			held.code = "LOCK_HELD";
			throw held;
		}
		throw error;
	}
	const token = randomUUID();
	atomicJson(join(path, "owner.json"), {
		token,
		pid: process.pid,
		host: hostname(),
		createdAt: new Date().toISOString(),
	});
	return () => {
		const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
		if (owner.token !== token) throw new Error("Lock ownership changed");
		rmSync(path, { recursive: true });
	};
}

export async function waitForLock(path, timeoutMs = 120000) {
	const start = Date.now();
	for (;;) {
		try {
			return lock(path);
		} catch (error) {
			if (error.code !== "LOCK_HELD" || Date.now() - start >= timeoutMs)
				throw error;
			const ownerPath = join(path, "owner.json");
			if (existsSync(ownerPath)) {
				let owner;
				try {
					owner = JSON.parse(readFileSync(ownerPath, "utf8"));
				} catch (readError) {
					if (readError.code === "ENOENT") continue;
					throw readError;
				}
				if (owner.host === hostname()) {
					try {
						process.kill(owner.pid, 0);
					} catch (processError) {
						if (processError.code === "ESRCH")
							throw new Error(
								`Inactive lock owner at ${path}; reconcile its recorded operation before resuming`,
							);
						throw processError;
					}
				}
			}
			await new Promise((resolveWait) =>
				setTimeout(resolveWait, 50 + Math.floor(Math.random() * 100)),
			);
		}
	}
}

export function context(repo) {
	const root = git(resolve(repo), "rev-parse", "--show-toplevel");
	const common = realpathSync(
		git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
	);
	return { root, common, state: join(common, "building") };
}

export function sessionPath(ctx, id) {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id))
		throw new Error("Invalid session ID");
	return join(ctx.state, "sessions", id, "session.json");
}

export function readSession(ctx, id) {
	const session = JSON.parse(readFileSync(sessionPath(ctx, id), "utf8"));
	if (
		session.id !== id ||
		session.common !== ctx.common ||
		session.version !== 1
	) {
		throw new Error("Session identity mismatch");
	}
	return session;
}

export function saveSession(ctx, session) {
	session.updatedAt = new Date().toISOString();
	atomicJson(sessionPath(ctx, session.id), session);
}

export function assertWorktree(ctx, session) {
	if (context(session.worktree).common !== ctx.common) {
		throw new Error("Worktree belongs to another repository");
	}
	if (
		git(session.worktree, "symbolic-ref", "--short", "HEAD") !== session.branch
	) {
		throw new Error("Worktree branch changed");
	}
}

export function assertClean(ctx, session) {
	assertWorktree(ctx, session);
	if (git(session.worktree, "status", "--porcelain", "--untracked-files=all")) {
		throw new Error("Commit session changes before capturing or publishing");
	}
	return git(session.worktree, "rev-parse", "HEAD");
}

export async function availablePort(start, excluded = new Set()) {
	for (let port = start; port < start + 1000; port++) {
		if (excluded.has(port)) continue;
		const free = await new Promise((resolvePort) => {
			const server = createServer();
			server.once("error", () => resolvePort(false));
			server.listen(port, "127.0.0.1", () =>
				server.close(() => resolvePort(true)),
			);
		});
		if (free) return port;
	}
	throw new Error("No available building ports");
}

export async function createSession(ctx, options) {
	if (!["web", "desktop", "gpui", "fullstack"].includes(options.target)) {
		throw new Error("Target must be web, desktop, gpui, or fullstack");
	}
	if (!options.name?.trim()) throw new Error("A feature name is required");
	const release = await waitForLock(
		join(ctx.state, "registry.lock"),
		options.lockWaitMs ?? 120000,
	);
	try {
		const slug =
			options.name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "")
				.slice(0, 24) || "feature";
		const id = `${slug}-${randomBytes(4).toString("hex")}`;
		const base = options.base ?? "origin/main";
		const baseSha = git(ctx.root, "rev-parse", "--verify", `${base}^{commit}`);
		const branch = `building/${id}`;
		const worktree = join(dirname(ctx.common), "..", "Cap-building", id);
		const sessionsDir = join(ctx.state, "sessions");
		const ports = new Set();
		if (existsSync(sessionsDir)) {
			for (const entry of readdirSync(sessionsDir)) {
				const path = join(sessionsDir, entry, "session.json");
				if (!existsSync(path)) continue;
				const other = JSON.parse(readFileSync(path, "utf8"));
				if (other.status !== "closed") {
					for (const value of Object.values(other.ports ?? {}))
						ports.add(value);
				}
			}
		}
		const web = await availablePort(4100, ports);
		ports.add(web);
		const desktop = await availablePort(5100, ports);
		const session = {
			version: 1,
			id,
			name: options.name,
			target: options.target,
			common: ctx.common,
			worktree: resolve(worktree),
			branch,
			base,
			baseSha,
			ports: { web, desktop },
			status: "creating",
			createdAt: new Date().toISOString(),
			database: {
				organization: "cap",
				database: "cap-production",
				name: `building-${id}`,
				parent: "main",
				status: "planned",
			},
			checks: [],
		};
		saveSession(ctx, session);
		git(ctx.root, "worktree", "add", "-b", branch, session.worktree, baseSha);
		session.status = "active";
		saveSession(ctx, session);
		return session;
	} finally {
		release();
	}
}

export function ensureResume(ctx, session) {
	if (!["active", "creating", "published", "resuming"].includes(session.status))
		throw new Error("Complete pending cleanup before resuming this session");
	if (session.status === "published") {
		if (existsSync(session.worktree))
			throw new Error(
				"Published worktree unexpectedly exists; inspect before resuming",
			);
		session.resumeSha = git(ctx.root, "rev-parse", session.branch);
		session.status = "resuming";
		session.databaseHistory ??= [];
		session.databaseHistory.push(session.database);
		session.database = {
			organization: session.database.organization,
			database: session.database.database,
			name: session.database.name,
			parent: session.database.parent,
			status: "planned",
		};
		delete session.noVisual;
		delete session.cleanupMode;
		saveSession(ctx, session);
	}
	if (session.status === "resuming") {
		if (git(ctx.root, "rev-parse", session.branch) !== session.resumeSha)
			throw new Error(
				"Branch changed during resume; inspect before continuing",
			);
		if (!existsSync(session.worktree))
			git(ctx.root, "worktree", "add", session.worktree, session.branch);
		if (assertClean(ctx, session) !== session.resumeSha)
			throw new Error("Worktree changed during resume");
		rmSync(environmentPath(ctx, session), { force: true });
		rmSync(join(dirname(sessionPath(ctx, session.id)), "browser-state.json"), {
			force: true,
		});
	}
	if (!existsSync(session.worktree) && session.status === "creating") {
		let branchExists = false;
		try {
			git(ctx.root, "show-ref", "--verify", `refs/heads/${session.branch}`);
			branchExists = true;
		} catch {}
		if (branchExists) {
			if (git(ctx.root, "rev-parse", session.branch) !== session.baseSha) {
				throw new Error("Partially created branch has changed");
			}
			git(ctx.root, "worktree", "add", session.worktree, session.branch);
		} else {
			git(
				ctx.root,
				"worktree",
				"add",
				"-b",
				session.branch,
				session.worktree,
				session.baseSha,
			);
		}
	}
	assertWorktree(ctx, session);
	session.status = "active";
	saveSession(ctx, session);
	return session;
}

export function assertDevBranch(session, branch) {
	if (
		branch.name !== session.database.name ||
		!branch.name.startsWith("building-") ||
		branch.production !== false ||
		branch.ready !== true
	) {
		throw new Error(
			"Expected the ready session-owned PlanetScale development branch",
		);
	}
	if (branch.parent_branch !== session.database.parent) {
		throw new Error("PlanetScale parent branch mismatch");
	}
	if (session.database.id && branch.id !== session.database.id) {
		throw new Error("PlanetScale branch identity changed");
	}
}

export function pscale(session, args) {
	return jsonCommand("pscale", [
		...args,
		"--org",
		session.database.organization,
		"--format",
		"json",
	]);
}

export function inspectDatabase(session) {
	const branch = pscale(session, [
		"branch",
		"show",
		session.database.database,
		session.database.name,
	]);
	assertDevBranch(session, branch);
	return branch;
}

export function attachDatabase(ctx, session) {
	const branch = inspectDatabase(session);
	session.database = { ...session.database, id: branch.id, status: "ready" };
	saveSession(ctx, session);
	return session.database;
}

export function environmentPath(ctx, session) {
	return join(dirname(sessionPath(ctx, session.id)), "environment.json");
}

export function readEnvironment(ctx, session) {
	return readEnvironmentSnapshot(ctx, session).environment;
}

export function readEnvironmentSnapshot(ctx, session) {
	const path = environmentPath(ctx, session);
	const serialized = existsSync(path) ? readFileSync(path, "utf8") : "{}";
	return {
		environment: JSON.parse(serialized),
		fingerprint: createHash("sha256").update(serialized).digest("hex"),
	};
}

export function writeEnvironment(ctx, session, env) {
	atomicJson(environmentPath(ctx, session), env);
}

export function databaseCredentials(ctx, session) {
	inspectDatabase(session);
	const path = environmentPath(ctx, session);
	const env = existsSync(path) ? readEnvironment(ctx, session) : {};
	if (env.DATABASE_URL) return { reused: true };
	if (session.database.passwordAttempted) {
		throw new Error(
			"Credential creation was interrupted. Revoke the recorded password name before explicitly retrying.",
		);
	}
	session.database.passwordName = `building-${session.id}`;
	session.database.passwordAttempted = true;
	saveSession(ctx, session);
	const password = pscale(session, [
		"password",
		"create",
		session.database.database,
		session.database.name,
		session.database.passwordName,
		"--role",
		"admin",
		"--ttl",
		"168h",
	]);
	if (
		!password.username ||
		!password.plain_text ||
		!password.access_host_url ||
		!password.id
	) {
		throw new Error(
			"PlanetScale returned an incomplete password; secret output was withheld",
		);
	}
	const url = new URL(
		`mysql://${password.access_host_url}/${session.database.database}`,
	);
	url.username = password.username;
	url.password = password.plain_text;
	url.searchParams.set("sslaccept", "strict");
	session.database.passwordId = password.id;
	session.database.username = password.username;
	session.database.host = password.access_host_url;
	saveSession(ctx, session);
	writeEnvironment(ctx, session, {
		...env,
		DATABASE_URL: url.href,
		NEXTAUTH_SECRET: randomBytes(32).toString("base64"),
		DATABASE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
	});
	session.database.expiresAt = password.expires_at ?? null;
	saveSession(ctx, session);
	return { created: true, passwordId: password.id };
}

export function executionEnvironment(
	ctx,
	session,
	{ credentials = true, expectedHash } = {},
) {
	const snapshot = credentials
		? readEnvironmentSnapshot(ctx, session)
		: undefined;
	if (expectedHash && snapshot?.fingerprint !== expectedHash)
		throw new Error("Credential configuration changed since capture review");
	const stored = snapshot?.environment ?? {};
	if (stored.DATABASE_URL) {
		const database = new URL(stored.DATABASE_URL);
		if (
			!session.database.id ||
			decodeURIComponent(database.username) !== session.database.username ||
			database.hostname !== session.database.host ||
			database.pathname !== `/${session.database.database}`
		) {
			throw new Error("Database credential does not match the session branch");
		}
	}
	const url = `http://127.0.0.1:${session.ports.web}`;
	const env = {};
	for (const key of [
		"PATH",
		"HOME",
		"USER",
		"TMPDIR",
		"SHELL",
		"LANG",
		"LC_ALL",
		"SYSTEMROOT",
	]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	const allowed = new Set([
		"DATABASE_URL",
		"NEXTAUTH_SECRET",
		"DATABASE_ENCRYPTION_KEY",
		"CAP_AWS_BUCKET",
		"CAP_AWS_REGION",
		"CAP_AWS_ACCESS_KEY",
		"CAP_AWS_SECRET_KEY",
		"CAP_AWS_ENDPOINT",
		"S3_PUBLIC_ENDPOINT",
		"S3_INTERNAL_ENDPOINT",
		"MEDIA_SERVER_URL",
		"MEDIA_SERVER_WEBHOOK_SECRET",
	]);
	for (const [key, value] of Object.entries(stored)) {
		if (allowed.has(key)) env[key] = value;
	}
	return {
		...env,
		NODE_ENV: "development",
		WEB_URL: url,
		NEXTAUTH_URL: url,
		NEXT_PUBLIC_WEB_URL: url,
		VITE_SERVER_URL: url,
		PORT: String(session.ports.web),
		CAP_BUILDING_SESSION: session.id,
		CAP_AWS_BUCKET: stored.CAP_AWS_BUCKET ?? `building-${session.id}`,
		CAP_AWS_REGION: stored.CAP_AWS_REGION ?? "us-east-1",
		CAP_AWS_ENDPOINT: stored.CAP_AWS_ENDPOINT ?? "http://127.0.0.1:1",
		S3_PUBLIC_ENDPOINT:
			stored.S3_PUBLIC_ENDPOINT ??
			stored.CAP_AWS_ENDPOINT ??
			"http://127.0.0.1:1",
		S3_INTERNAL_ENDPOINT:
			stored.S3_INTERNAL_ENDPOINT ??
			stored.CAP_AWS_ENDPOINT ??
			"http://127.0.0.1:1",
		AWS_EC2_METADATA_DISABLED: "true",
		AWS_SHARED_CREDENTIALS_FILE: join(ctx.state, "no-aws-credentials"),
		AWS_CONFIG_FILE: join(ctx.state, "no-aws-config"),
	};
}

export async function execInSession(
	ctx,
	session,
	args,
	{ runtime = false } = {},
) {
	if (process.platform === "win32")
		throw new Error(
			"Local process ownership is supported on macOS/Linux; use a dedicated Windows runner",
		);
	assertWorktree(ctx, session);
	if (session.database.id) inspectDatabase(session);
	if (!args.length) throw new Error("Expected a command after --");
	for (const path of [
		".env",
		".env.local",
		".env.development",
		".env.development.local",
		"apps/web/.env",
		"apps/web/.env.local",
		"apps/web/.env.development",
		"apps/web/.env.development.local",
	]) {
		if (existsSync(join(session.worktree, path)))
			throw new Error(`Remove or review unmanaged environment file: ${path}`);
	}
	const release = runtime
		? await waitForLock(join(ctx.state, "native-runtime.lock"), 3600000)
		: () => {};
	let released = true;
	try {
		const env = executionEnvironment(ctx, session);
		let processPath;
		let completion;
		const child = await withSessionStartup(ctx, session, () => {
			const child = spawn(args[0], args.slice(1), {
				cwd: session.worktree,
				env,
				stdio: "inherit",
				detached: true,
			});
			completion = new Promise((resolveExit, reject) => {
				child.once("error", reject);
				child.once("exit", (status) => resolveExit(status ?? 1));
			});
			if (child.pid)
				processPath = recordProcess(ctx, session, {
					processGroup: child.pid,
					native: runtime,
				});
			return child;
		});
		let termination;
		const forward = () => {
			termination ??= terminateGroup(child.pid).catch(() => false);
		};
		process.once("SIGINT", forward);
		process.once("SIGTERM", forward);
		let commandError;
		try {
			const code = await completion;
			if (code !== 0) throw new Error(`Session command exited ${code}`);
		} catch (error) {
			commandError = error;
		} finally {
			process.removeListener("SIGINT", forward);
			process.removeListener("SIGTERM", forward);
			if (child.pid) {
				released = false;
				released = await (termination ?? terminateGroup(child.pid)).catch(
					() => false,
				);
				if (released) rmSync(processPath, { force: true });
			}
		}
		if (!released) {
			const error = new Error(
				`Process group ${child.pid} remains active; retain its runtime lease and inspect ${processPath}`,
			);
			error.retainLease = true;
			throw error;
		}
		if (commandError) throw commandError;
	} finally {
		if (released) release();
	}
}

export async function withSessionStartup(ctx, session, start) {
	const release = await waitForLock(
		join(dirname(sessionPath(ctx, session.id)), "lifecycle.lock"),
	);
	try {
		if (readSession(ctx, session.id).status !== "active")
			throw new Error("Resume an active session before starting processes");
		return await start();
	} finally {
		release();
	}
}

export function recordProcess(ctx, session, metadata) {
	const path = join(
		dirname(sessionPath(ctx, session.id)),
		`process-${process.pid}.json`,
	);
	atomicJson(path, {
		...metadata,
		host: hostname(),
		wrapperPid: process.pid,
		wrapperStarted: run("ps", ["-p", String(process.pid), "-o", "lstart="]),
	});
	return path;
}

export async function stopSessionProcesses(ctx, session) {
	const directory = dirname(sessionPath(ctx, session.id));
	for (const entry of readdirSync(directory)) {
		if (!/^process-\d+\.json$/.test(entry)) continue;
		const path = join(directory, entry);
		const owner = JSON.parse(readFileSync(path, "utf8"));
		if (owner.host !== hostname() || owner.wrapperPid === process.pid)
			throw new Error(
				"Cannot stop a process owned by another host or the current command",
			);
		let started;
		try {
			started = run("ps", ["-p", String(owner.wrapperPid), "-o", "lstart="]);
		} catch {
			if (signalGroup(owner.processGroup, 0))
				throw new Error(
					`Orphaned process group ${owner.processGroup} needs identity reconciliation`,
				);
			rmSync(path);
			continue;
		}
		if (started !== owner.wrapperStarted)
			throw new Error("Process ID was reused; refusing to stop it");
		process.kill(owner.wrapperPid, "SIGTERM");
		for (let attempt = 0; attempt < 100 && existsSync(path); attempt++)
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		if (existsSync(path))
			throw new Error(
				"Owned process has not confirmed shutdown; cleanup remains pending",
			);
	}
}

function signalGroup(pid, signal) {
	if (!pid) return false;
	try {
		process.kill(-pid, signal);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
}

async function terminateGroup(pid) {
	for (const signal of ["SIGTERM", "SIGKILL"]) {
		if (!signalGroup(pid, signal)) return true;
		for (let attempt = 0; attempt < 20; attempt++) {
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
			if (!signalGroup(pid, 0)) return true;
		}
	}
	return false;
}

export function hashFiles(root, files) {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file);
		if (existsSync(join(root, file)))
			hash.update(readFileSync(join(root, file)));
	}
	return hash.digest("hex");
}

export function rustBuildFingerprint(root) {
	const hash = createHash("sha256");
	hash.update(git(root, "rev-parse", "HEAD^{tree}"));
	hash.update(
		git(root, "diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"),
	);
	const localFiles = git(
		root,
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	)
		.split("\0")
		.filter(Boolean);
	hash.update(
		hashFiles(
			root,
			[
				...new Set([
					...localFiles,
					".cargo/config",
					".cargo/config.toml",
					"apps/desktop-gpui/.cargo/config",
					"apps/desktop-gpui/.cargo/config.toml",
				]),
			].sort(),
		),
	);
	return hash.digest("hex");
}

export function cloneDirectory(source, destination) {
	if (lstatSync(source).isSymbolicLink())
		throw new Error("Clone source must be a real directory");
	if (existsSync(destination))
		throw new Error("Clone destination already exists");
	mkdirSync(dirname(destination), { recursive: true });
	const args =
		process.platform === "darwin"
			? ["-cR", source, destination]
			: ["--reflink=always", "-R", source, destination];
	run("cp", args);
}

export function assertIdle(path) {
	try {
		const output = execFileSync("lsof", ["-t", "+D", path], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (output.trim()) throw new Error(`Open files in cache source: ${path}`);
	} catch (error) {
		if (error.status === 1 && !String(error.stderr ?? "").trim()) return;
		throw error;
	}
}

export async function warmDependencies(ctx, session, source, rust = false) {
	assertWorktree(ctx, session);
	source = realpathSync(source);
	if (context(source).common !== ctx.common)
		throw new Error("Cache source must belong to this repository");
	const files = [
		"scripts/setup.js",
		"Cargo.lock",
		"rust-toolchain.toml",
		"apps/desktop-gpui/Cargo.lock",
		"apps/desktop-gpui/rust-toolchain.toml",
	];
	const fingerprint = hashFiles(session.worktree, files);
	if (fingerprint !== hashFiles(source, files))
		throw new Error(
			"Dependency/toolchain versions differ; prepare a matching cache",
		);
	const rustFingerprint = rust
		? rustBuildFingerprint(session.worktree)
		: undefined;
	if (rust && rustFingerprint !== rustBuildFingerprint(source))
		throw new Error(
			"Rust source or Cargo configuration differs; prepare matching build inputs before warming compiled artifacts",
		);
	const release = await waitForLock(join(ctx.state, "cache.lock"));
	try {
		const directories = [
			"target/native-deps",
			...(rust ? ["target/debug", "apps/desktop-gpui/target/debug"] : []),
		];
		for (const directory of directories) {
			const origin = join(source, directory);
			if (!existsSync(origin)) continue;
			const destination = join(session.worktree, directory);
			if (existsSync(destination))
				throw new Error(`Refusing to overwrite ${directory}`);
			assertIdle(origin);
			const cache = join(
				ctx.state,
				"cache",
				`${process.platform}-${process.arch}-${directory === "target/native-deps" ? fingerprint : rustFingerprint}`,
				directory,
			);
			if (!existsSync(cache)) {
				const staging = `${cache}.${randomUUID()}.tmp`;
				cloneDirectory(origin, staging);
				assertIdle(origin);
				renameSync(staging, cache);
			}
			cloneDirectory(cache, destination);
		}
		session.dependencies = {
			fingerprint,
			rustFingerprint,
			strategy: "copy-on-write",
			rust,
		};
		saveSession(ctx, session);
		return session.dependencies;
	} finally {
		release();
	}
}

export function artifactDirectory(ctx, session) {
	const path = join(dirname(sessionPath(ctx, session.id)), "artifacts");
	mkdirSync(path, { recursive: true, mode: 0o700 });
	return path;
}

export function temporaryPath(name) {
	return join(tmpdir(), `cap-building-${randomUUID()}-${name}`);
}
