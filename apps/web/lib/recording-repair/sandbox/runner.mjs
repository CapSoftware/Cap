import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";

const PORT = Number(process.env.BRIDGE_PORT ?? 8787);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN ?? "";
const MODEL = process.env.REPAIR_MODEL ?? "";
const OPENCODE_CONFIG = process.env.REPAIR_OPENCODE_CONFIG ?? "{}";
const AGENT_UID = Number(process.env.AGENT_UID ?? 0);
const AGENT_GID = Number(process.env.AGENT_GID ?? 0);
const AGENT_HOME = process.env.AGENT_HOME ?? "/home/agent";
const WORK = process.env.REPAIR_WORK ?? "/vercel/sandbox/work";
const DEADLINE =
	Date.now() + Number(process.env.REPAIR_DEADLINE_MS ?? 25 * 60_000);
const COST_LIMIT = Number(process.env.REPAIR_COST_LIMIT_USD ?? 15);
const INTERNAL_TOKEN = randomBytes(32).toString("hex");

const RECORDING_DIR = path.join(WORK, "recording");
const OUT_DIR = path.join(WORK, "out");
const POLL_HOLD_MS = 25_000;
const DESKTOP_GONE_MS = 120_000;
const MAX_POLL_BODY = 24 * 1024 * 1024;
const MAX_TOOL_BODY = 256 * 1024;
const MAX_PULL_FILE = 4 * 1024 ** 3;
const MAX_PULL_TOTAL = 8 * 1024 ** 3;

const DESKTOP_TOOLS = new Map([
	["describe_recording", 120_000],
	["list_files", 120_000],
	["read_file", 120_000],
	["read_files", 120_000],
	["inspect_media", 300_000],
	["pull_file", 1_200_000],
	["stage_json_edit", 120_000],
	["stage_truncate", 300_000],
	["stage_remove", 300_000],
	["stage_replace", 1_200_000],
	["list_staged", 120_000],
	["discard_staged", 120_000],
	["apply_and_verify", 1_200_000],
]);

const PROMPT =
	"Repair the Cap recording that is connected through the cap-recording tools. Follow AGENTS.md exactly. Start by calling describe_recording.";

if (!BRIDGE_TOKEN || BRIDGE_TOKEN.length < 32 || !MODEL || !AGENT_UID) {
	console.error("runner: missing configuration");
	process.exit(2);
}

const events = [];
let nextSeq = 1;
let done = false;
let finishing = false;
let agent = null;
let agentStarted = false;
let lastPoll = Date.now();
let costUsd = 0;
let pulledBytes = 0;
let requestCounter = 0;
const queue = [];
const pending = new Map();
const waiters = new Set();

const wake = () => {
	for (const waiter of waiters) waiter();
	waiters.clear();
};

const clip = (value, max) => {
	const text = typeof value === "string" ? value : "";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const pushEvent = (event) => {
	if (done) return;
	events.push({ seq: nextSeq++, ...event });
	if (events.length > 2000) events.splice(0, events.length - 2000);
	wake();
};

const markDone = () => {
	if (done) return;
	done = true;
	for (const [id, entry] of pending) {
		clearTimeout(entry.timer);
		entry.resolve({ ok: false, error: "The session ended." });
		pending.delete(id);
	}
	wake();
	setTimeout(() => process.exit(0), 60_000).unref();
};

const fail = (message) => {
	pushEvent({ type: "error", message: clip(message, 400) });
	stopAgent();
	markDone();
};

const stopAgent = () => {
	if (agent && agent.exitCode === null) {
		agent.kill("SIGTERM");
		setTimeout(
			() => agent?.exitCode === null && agent.kill("SIGKILL"),
			5_000,
		).unref();
	}
};

const authorized = (req) => {
	const header = req.headers.authorization ?? "";
	const expected = Buffer.from(`Bearer ${BRIDGE_TOKEN}`);
	const given = Buffer.from(header);
	return given.length === expected.length && timingSafeEqual(given, expected);
};

const sendJson = (res, status, body) => {
	const data = Buffer.from(JSON.stringify(body));
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": data.length,
		"cache-control": "no-store",
	});
	res.end(data);
};

const readBody = (req, limit) =>
	new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

const relativePath = (value) => {
	if (typeof value !== "string" || value.length === 0 || value.length > 512)
		return null;
	const segments = value.split("/");
	if (
		!segments.every(
			(segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..",
		)
	)
		return null;
	return segments.join("/");
};

const REDELIVER_MS = 45_000;
const deliverable = (request) =>
	Date.now() - request.deliveredAt > REDELIVER_MS;
const dequeue = (id) => {
	const index = queue.findIndex((request) => request.id === id);
	if (index !== -1) queue.splice(index, 1);
};

const handlePoll = async (req, res) => {
	let body;
	try {
		body = JSON.parse((await readBody(req, MAX_POLL_BODY)).toString("utf8"));
	} catch {
		return sendJson(res, 400, { error: "invalid body" });
	}
	lastPoll = Date.now();
	const cursor = Number.isSafeInteger(body?.cursor) ? body.cursor : 0;
	for (const result of Array.isArray(body?.results) ? body.results : []) {
		const entry =
			typeof result?.id === "string" ? pending.get(result.id) : undefined;
		if (!entry) continue;
		pending.delete(result.id);
		dequeue(result.id);
		clearTimeout(entry.timer);
		entry.resolve(
			result.ok === true
				? { ok: true, result: result.result ?? null }
				: { ok: false, error: clip(String(result.error ?? "failed"), 4000) },
		);
	}
	if (!agentStarted && !done) startAgent();

	const ready = () =>
		queue.some(deliverable) ||
		done ||
		events.some((event) => event.seq > cursor);
	if (!ready()) {
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, POLL_HOLD_MS);
			waiters.add(() => {
				clearTimeout(timer);
				resolve();
			});
			req.on("close", resolve);
		});
	}
	if (res.writableEnded || res.destroyed) return;
	const now = Date.now();
	const requests = queue.filter(deliverable).map((request) => {
		request.deliveredAt = now;
		return { id: request.id, tool: request.tool, args: request.args };
	});
	sendJson(res, 200, {
		cursor: nextSeq - 1,
		requests,
		events: events.filter((event) => event.seq > cursor),
		done,
	});
};

const handlePulled = async (req, res, url) => {
	const rel = relativePath(url.searchParams.get("path"));
	const declared = Number(req.headers["content-length"] ?? Number.NaN);
	if (!rel) return sendJson(res, 400, { error: "invalid path" });
	if (
		!Number.isSafeInteger(declared) ||
		declared < 0 ||
		declared > MAX_PULL_FILE
	)
		return sendJson(res, 413, { error: "file too large" });
	if (pulledBytes + declared > MAX_PULL_TOTAL)
		return sendJson(res, 413, { error: "session transfer limit reached" });
	const target = path.join(RECORDING_DIR, rel);
	const temp = `${target}.part-${randomBytes(6).toString("hex")}`;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	let written = 0;
	try {
		await new Promise((resolve, reject) => {
			const out = fs.createWriteStream(temp, { mode: 0o640 });
			req.on("data", (chunk) => {
				written += chunk.length;
				if (written > declared) {
					req.destroy();
					reject(new Error("body exceeds content-length"));
				}
			});
			req.pipe(out);
			out.on("finish", resolve);
			out.on("error", reject);
			req.on("error", reject);
		});
		if (written !== declared) throw new Error("short upload");
		fs.renameSync(temp, target);
		chownTree(RECORDING_DIR);
		pulledBytes += written;
		sendJson(res, 200, { size: written });
	} catch (error) {
		fs.rmSync(temp, { force: true });
		sendJson(res, 400, { error: clip(String(error?.message ?? error), 200) });
	}
};

const chownTree = (dir) => {
	fs.chownSync(dir, AGENT_UID, AGENT_GID);
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) chownTree(full);
		else if (entry.isFile()) {
			fs.chownSync(full, AGENT_UID, AGENT_GID);
			fs.chmodSync(full, 0o440);
		}
	}
};

const handleOut = (res, url) => {
	const requested = url.searchParams.get("path") ?? "";
	let real;
	try {
		real = fs.realpathSync(requested);
	} catch {
		return sendJson(res, 404, { error: "not found" });
	}
	const root = fs.realpathSync(OUT_DIR);
	if (!real.startsWith(`${root}${path.sep}`))
		return sendJson(res, 403, { error: "outside out dir" });
	const stat = fs.statSync(real);
	if (!stat.isFile() || stat.nlink !== 1)
		return sendJson(res, 403, { error: "not a regular file" });
	if (stat.size > MAX_PULL_FILE)
		return sendJson(res, 413, { error: "file too large" });
	res.writeHead(200, {
		"content-type": "application/octet-stream",
		"content-length": stat.size,
		"cache-control": "no-store",
	});
	fs.createReadStream(real).pipe(res);
};

const callDesktop = (tool, args) =>
	new Promise((resolve) => {
		if (done) return resolve({ ok: false, error: "The session ended." });
		const id = `req_${++requestCounter}`;
		const timer = setTimeout(() => {
			pending.delete(id);
			dequeue(id);
			resolve({ ok: false, error: "The desktop app did not answer in time." });
		}, DESKTOP_TOOLS.get(tool));
		pending.set(id, { resolve, timer });
		queue.push({ id, tool, args, deliveredAt: 0 });
		wake();
	});

const STEP_STATES = new Set(["running", "done", "failed"]);

const handleTool = async (req, res) => {
	if (req.headers["x-internal-token"] !== INTERNAL_TOKEN)
		return sendJson(res, 403, { error: "forbidden" });
	let body;
	try {
		body = JSON.parse((await readBody(req, MAX_TOOL_BODY)).toString("utf8"));
	} catch {
		return sendJson(res, 400, { ok: false, error: "invalid tool call" });
	}
	const tool = typeof body?.tool === "string" ? body.tool : "";
	const args =
		body?.args && typeof body.args === "object" && !Array.isArray(body.args)
			? body.args
			: {};

	if (tool === "report_progress") {
		const state = STEP_STATES.has(args.state) ? args.state : "running";
		const id =
			typeof args.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(args.id)
				? args.id
				: "step";
		pushEvent({
			type: "step",
			id,
			title: clip(args.title, 200),
			...(typeof args.detail === "string"
				? { detail: clip(args.detail, 400) }
				: {}),
			state,
		});
		return sendJson(res, 200, { ok: true, result: { shown: true } });
	}
	if (tool === "finish") {
		const outcome = args.outcome === "fixed" ? "fixed" : "cant_fix";
		if (!finishing) {
			finishing = true;
			pushEvent({ type: "finish", outcome, summary: clip(args.summary, 1200) });
			setTimeout(() => {
				stopAgent();
				markDone();
			}, 2_000).unref();
		}
		return sendJson(res, 200, { ok: true, result: { finished: true } });
	}
	if (!DESKTOP_TOOLS.has(tool))
		return sendJson(res, 200, { ok: false, error: `Unknown tool ${tool}` });
	if (finishing)
		return sendJson(res, 200, {
			ok: false,
			error: "The session is finishing.",
		});
	sendJson(res, 200, await callDesktop(tool, args));
};

const ACTIVITY = {
	read: "read",
	grep: "search",
	glob: "search",
	list: "search",
	bash: "run",
	edit: "edit",
	write: "edit",
	patch: "edit",
	multiedit: "edit",
};

const activityTarget = (input) => {
	const value =
		input?.filePath ??
		input?.path ??
		input?.pattern ??
		input?.command ??
		input?.description ??
		"";
	const text = String(value);
	return clip(
		text.startsWith(`${WORK}/`) ? text.slice(WORK.length + 1) : text,
		200,
	);
};

const handleAgentEvent = (event) => {
	const part = event?.part ?? {};
	if (event.type === "text" || event.type === "reasoning") {
		const text = typeof part.text === "string" ? part.text.trim() : "";
		if (text) pushEvent({ type: "thought", text: clip(text, 2000) });
	} else if (event.type === "tool_use") {
		const tool = String(part.tool ?? "");
		if (tool.startsWith("cap-recording_")) return;
		const verb = ACTIVITY[tool];
		if (verb)
			pushEvent({
				type: "activity",
				verb,
				target: activityTarget(part.state?.input),
			});
	} else if (event.type === "step_finish") {
		costUsd += Number(part.cost ?? 0) || 0;
		if (costUsd > COST_LIMIT)
			fail("The repair reached its budget before finishing.");
	} else if (event.type === "error") {
		const message =
			event.error?.data?.message ??
			event.error?.name ??
			"The repair agent failed.";
		console.error("agent error:", message);
	}
};

const startAgent = () => {
	agentStarted = true;
	const config = JSON.parse(OPENCODE_CONFIG);
	config.mcp = {
		"cap-recording": {
			type: "local",
			command: [
				"node",
				path.join(path.dirname(new URL(import.meta.url).pathname), "mcp.mjs"),
			],
			enabled: true,
			timeout: 1_260_000,
			environment: {
				CAP_REPAIR_INTERNAL_TOKEN: INTERNAL_TOKEN,
				CAP_REPAIR_PORT: String(PORT),
			},
		},
	};
	agent = spawn(
		"opencode",
		["run", "--format", "json", "--auto", "--thinking", "-m", MODEL, PROMPT],
		{
			cwd: WORK,
			uid: AGENT_UID,
			gid: AGENT_GID,
			env: {
				HOME: AGENT_HOME,
				PATH: "/usr/local/bin:/usr/bin:/bin",
				LANG: "C.UTF-8",
				OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
				OPENCODE_DISABLE_AUTOUPDATE: "1",
				OPENCODE_DISABLE_MODELS_FETCH: "1",
				OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	readline.createInterface({ input: agent.stdout }).on("line", (line) => {
		try {
			handleAgentEvent(JSON.parse(line));
		} catch {}
	});
	readline.createInterface({ input: agent.stderr }).on("line", (line) => {
		console.error(`opencode: ${line.slice(0, 500)}`);
	});
	agent.on("exit", (code) => {
		if (finishing || done) return;
		fail(
			code === 0
				? "The repair agent stopped without a result."
				: "The repair agent stopped unexpectedly.",
		);
	});
};

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://runner");
	const local =
		req.socket.remoteAddress === "127.0.0.1" ||
		req.socket.remoteAddress === "::ffff:127.0.0.1";
	if (url.pathname === "/internal/tool" && req.method === "POST" && local) {
		handleTool(req, res).catch(() =>
			sendJson(res, 500, { ok: false, error: "tool failed" }),
		);
		return;
	}
	if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
	if (url.pathname === "/v1/poll" && req.method === "POST") {
		handlePoll(req, res).catch(() =>
			sendJson(res, 500, { error: "poll failed" }),
		);
	} else if (url.pathname === "/v1/files/pulled" && req.method === "PUT") {
		handlePulled(req, res, url).catch(() =>
			sendJson(res, 500, { error: "upload failed" }),
		);
	} else if (url.pathname === "/v1/files/out" && req.method === "GET") {
		try {
			handleOut(res, url);
		} catch {
			sendJson(res, 500, { error: "download failed" });
		}
	} else {
		sendJson(res, 404, { error: "not found" });
	}
});
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 30_000;
server.listen(PORT, "0.0.0.0");

setInterval(() => {
	if (done) return;
	if (Date.now() > DEADLINE) fail("The repair ran out of time.");
	else if (Date.now() - lastPoll > DESKTOP_GONE_MS) {
		stopAgent();
		markDone();
	}
}, 5_000).unref();

process.on("SIGTERM", () => {
	stopAgent();
	process.exit(0);
});
