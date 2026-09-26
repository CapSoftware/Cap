import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { S3, s3ConfigFromEnv } from "./s3";

// With RF_HOT_SWAP=1 the engine binary, app bundle and tuning are pulled from
// the bucket's bin/ pointers and swapped in place when they change (fast fleet
// iteration). Anyone who can write that prefix can run code on the fleet, so
// production images run the app and engine they were built with instead.
const HOT_SWAP = process.env.RF_HOT_SWAP === "1";
const DRAIN_MS = Number(process.env.RF_DRAIN_MS ?? 15 * 60_000);

const s3 = new S3(s3ConfigFromEnv());
const DIR = process.env.RF_BIN_DIR ?? "/opt/rf";

type Pointer = { key: string };

async function pointer(name: string) {
	try {
		return JSON.parse(
			new TextDecoder().decode(await s3.get(`bin/${name}.json`)),
		) as Pointer;
	} catch {
		return null;
	}
}

async function download(key: string, path: string, executable: boolean) {
	const bytes = await s3.get(key);
	writeFileSync(`${path}.tmp`, bytes);
	if (executable) chmodSync(`${path}.tmp`, 0o755);
	renameSync(`${path}.tmp`, path);
}

let current = "";
let child: ReturnType<typeof Bun.spawn> | null = null;
let tuning: Record<string, string> = {};
let stopping = false;

async function loadTuning() {
	try {
		const all = JSON.parse(
			new TextDecoder().decode(await s3.get("bin/env.json")),
		) as Record<string, Record<string, string>>;
		return { ...(all["*"] ?? {}), ...(all[process.env.RF_ROLE ?? ""] ?? {}) };
	} catch {
		return {};
	}
}

async function sync() {
	const [engine, app, nextTuning] = await Promise.all([
		pointer("engine"),
		pointer("app"),
		loadTuning(),
	]);
	if (!engine || !app) return false;
	const version = `${engine.key}|${app.key}|${JSON.stringify(nextTuning)}`;
	if (version === current) return false;
	await Promise.all([
		download(engine.key, `${DIR}/cap-render-farm`, true),
		download(app.key, `${DIR}/app.js`, false),
	]);
	current = version;
	tuning = nextTuning;
	return true;
}

function command() {
	if (HOT_SWAP) {
		return {
			argv: ["bun", `${DIR}/app.js`],
			engine: `${DIR}/cap-render-farm`,
		};
	}
	return {
		argv: ["bun", fileURLToPath(new URL("./main.ts", import.meta.url))],
		engine: process.env.RF_ENGINE_BIN ?? "cap-render-farm",
	};
}

async function start() {
	child?.kill();
	await child?.exited;
	const { argv, engine } = command();
	child = Bun.spawn(argv, {
		stdout: "inherit",
		stderr: "inherit",
		env: { ...process.env, ...tuning, RF_ENGINE_BIN: engine },
	});
	console.log(`[boot] started ${HOT_SWAP ? current : "bundled app"}`);
	const started = child;
	started.exited.then((code) => {
		console.log(`[boot] app exited ${code}`);
		if (stopping) process.exit(0);
		setTimeout(() => {
			if (child === started) start();
		}, 2000);
	});
}

// Deploys and instance retirement send SIGTERM: pass it on so a worker can
// finish the chunks it is rendering instead of dropping them mid-export.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		if (stopping) return;
		stopping = true;
		console.log(`[boot] ${signal}: draining`);
		if (!child) process.exit(0);
		child.kill(signal);
		setTimeout(() => {
			child?.kill("SIGKILL");
			process.exit(0);
		}, DRAIN_MS);
	});
}

if (HOT_SWAP) {
	mkdirSync(DIR, { recursive: true });
	while (
		!(await sync().catch((error) => {
			console.error(`[boot] ${error}`);
			return false;
		}))
	) {
		console.log("[boot] waiting for bin/engine.json and bin/app.json");
		await Bun.sleep(5000);
	}
	await start();
	setInterval(async () => {
		if (stopping) return;
		try {
			if (await sync()) await start();
		} catch (error) {
			console.error(`[boot] sync failed: ${error}`);
		}
	}, 10_000);
} else {
	await start();
}
