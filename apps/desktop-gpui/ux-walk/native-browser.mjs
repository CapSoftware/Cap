import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
	redactBrowserText,
	sanitizeBrowserEvent,
} from "./browser-evidence.mjs";
import { durableJson } from "./checkpoint-store.mjs";

const local = new URL("./src/config.mjs", import.meta.url);
const engine = fs.existsSync(local)
	? new URL("./src/", import.meta.url)
	: new URL("../../../vendor/ux-walk/src/", import.meta.url);

function save(file, value) {
	durableJson(file, value);
}

export class NativeBrowserEvidence {
	constructor(captureId, workDir, clock = Date.now) {
		this.captureId = captureId;
		this.workDir = workDir;
		this.clock = clock;
		this.windowId = null;
		this.mode = "prepared";
		this.preRoll = [];
		this.preRollBytes = 0;
		this.bytes = 0;
		this.active = null;
		this.flushTimer = setInterval(() => {
			try {
				this.flush();
			} catch (error) {
				if (this.active)
					this.active.metadata.durabilityError = String(error.message).slice(
						0,
						200,
					);
			}
		}, 1000);
		this.flushTimer.unref();
		fs.mkdirSync(path.join(workDir, "notes"), { recursive: true, mode: 0o700 });
	}

	notesDir() {
		return path.join(this.active?.directory ?? this.workDir, "notes");
	}

	write(raw, receivedAt = this.clock()) {
		if (!["prepared", "recording"].includes(this.mode)) return;
		const event = sanitizeBrowserEvent(raw, receivedAt);
		if (!event) return;
		const line = `${JSON.stringify(event)}\n`;
		if (this.mode === "prepared") {
			this.preRoll.push(line);
			this.preRollBytes += Buffer.byteLength(line);
			while (this.preRollBytes > 2 * 1024 * 1024)
				this.preRollBytes -= Buffer.byteLength(this.preRoll.shift());
			return;
		}
		if (event.observedAt < this.active.metadata.startedAtMs) {
			const file = path.join(this.active.directory, "browser-preroll.jsonl");
			if (fs.statSync(file).size + Buffer.byteLength(line) <= 2 * 1024 * 1024)
				fs.appendFileSync(file, line, { mode: 0o600 });
			else this.active.metadata.dropped++;
			return;
		}
		const anchor = this.active.metadata.anchors.findLast(
			(entry) => entry.wallMs <= event.observedAt,
		);
		if (!anchor || anchor.paused) return;
		if (this.bytes + Buffer.byteLength(line) > 100 * 1024 * 1024) {
			this.active.metadata.dropped++;
			return;
		}
		this.bytes += Buffer.byteLength(line);
		fs.appendFileSync(
			path.join(this.active.directory, "browser-evidence.jsonl"),
			line,
			{ mode: 0o600 },
		);
	}

	start(file, windowId) {
		if (this.active || !this.windowId || windowId !== this.windowId)
			throw new Error("Browser window does not match the recording target");
		const journal = JSON.parse(fs.readFileSync(file, "utf8"));
		const directory = path.dirname(fs.realpathSync(file));
		if (
			journal.schemaVersion !== 1 ||
			journal.state !== "recording" ||
			fs.realpathSync(journal.request.directory) !== directory ||
			!path.isAbsolute(journal.sourceProject) ||
			!Number.isSafeInteger(journal.startedAtMs)
		)
			throw new Error("Browser collector requires its active native journal");
		if (fs.existsSync(path.join(directory, "browser-evidence.json")))
			throw new Error("This walk already has a browser collector");
		const metadata = {
			schemaVersion: 1,
			captureId: this.captureId,
			journal: fs.realpathSync(file),
			sourceProject: fs.realpathSync(journal.sourceProject),
			windowId,
			state: "recording",
			startedAtMs: journal.startedAtMs,
			dropped: 0,
			anchors: [{ wallMs: journal.startedAtMs, offsetMs: 0, paused: false }],
		};
		fs.mkdirSync(path.join(directory, "notes"), {
			recursive: true,
			mode: 0o700,
		});
		for (const name of fs.readdirSync(path.join(this.workDir, "notes"))) {
			if (/^[\w-]+\.png$/.test(name))
				fs.copyFileSync(
					path.join(this.workDir, "notes", name),
					path.join(directory, "notes", name),
				);
		}
		fs.writeFileSync(
			path.join(directory, "browser-preroll.jsonl"),
			this.preRoll.join(""),
			{ mode: 0o600 },
		);
		fs.writeFileSync(path.join(directory, "browser-evidence.jsonl"), "", {
			mode: 0o600,
			flag: "wx",
		});
		this.active = { directory, metadata };
		this.bytes = 0;
		this.preRoll = [];
		this.preRollBytes = 0;
		this.mode = "recording";
		this.save();
		return metadata;
	}

	owned(file) {
		let actual;
		try {
			actual = fs.realpathSync(file);
		} catch {}
		if (!this.active || this.active.metadata.journal !== actual)
			throw new Error("Browser collector belongs to another walk");
		return this.active;
	}

	anchor(file, wallMs, offsetMs, paused) {
		const { metadata } = this.owned(file);
		const previous = metadata.anchors.at(-1);
		if (
			!Number.isSafeInteger(wallMs) ||
			!Number.isSafeInteger(offsetMs) ||
			wallMs < previous.wallMs ||
			offsetMs < previous.offsetMs ||
			typeof paused !== "boolean"
		)
			throw new Error("Invalid native recording clock anchor");
		metadata.anchors.push({ wallMs, offsetMs, paused });
		this.save();
	}

	save() {
		if (this.active)
			save(
				path.join(this.active.directory, "browser-evidence.json"),
				this.active.metadata,
			);
	}

	flush() {
		if (!this.active) return;
		const fd = fs.openSync(
			path.join(this.active.directory, "browser-evidence.jsonl"),
			"r",
		);
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		this.save();
	}

	finish(file, state = "complete", reason) {
		const { metadata, directory } = this.owned(file);
		metadata.state = state;
		if (reason) metadata.reason = redactBrowserText(reason, 500);
		const fd = fs.openSync(path.join(directory, "browser-evidence.jsonl"), "r");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		this.save();
		this.active = null;
		this.mode = "stopped";
		clearInterval(this.flushTimer);
	}
}

export class OwnedWindowEvents {
	constructor(evidence) {
		this.evidence = evidence;
		this.sessions = new WeakMap();
		this.pending = new Set();
		this.initial = null;
	}

	async windowId(page) {
		let session = this.sessions.get(page);
		if (!session) {
			session = page.context().newCDPSession(page);
			this.sessions.set(page, session);
		}
		return (await (await session).send("Browser.getWindowForTarget")).windowId;
	}

	async accepts(page) {
		if (!page) return false;
		this.initial ??= this.windowId(page.context().pages()[0] ?? page);
		return (await this.initial) === (await this.windowId(page));
	}

	canCapturePage(page) {
		return (
			this.evidence.mode === "recording" &&
			!this.evidence.active?.metadata.anchors.at(-1)?.paused &&
			this.accepts(page)
		);
	}

	write(event, page) {
		if (this.pending.size >= 512) {
			if (this.evidence.active) this.evidence.active.metadata.dropped++;
			return Promise.resolve();
		}
		const receivedAt = Date.now();
		const task = this.accepts(page)
			.then((accepted) => {
				if (accepted) this.evidence.write(event, receivedAt);
			})
			.catch(() => {
				if (this.evidence.active) {
					this.evidence.active.metadata.reason =
						"Some browser events could not be matched to the recorded window";
					this.evidence.active.metadata.dropped++;
				}
			});
		this.pending.add(task);
		task.finally(() => this.pending.delete(task));
		return task;
	}

	async flush() {
		while (this.pending.size) await Promise.all([...this.pending]);
	}
}

const CHROME_EXECUTABLE =
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function launchWalkChrome(
	browserType,
	options,
	{
		launcher = fileURLToPath(
			new URL("./bin/walk-chrome-launcher", import.meta.url),
		),
		chrome = CHROME_EXECUTABLE,
		log = console.error,
	} = {},
) {
	try {
		fs.accessSync(launcher, fs.constants.X_OK);
	} catch {
		log(
			"walk-chrome-launcher is missing; starting Chrome normally, so macOS may ask for App Management in this app's name",
		);
		return browserType.launch(options);
	}
	try {
		return await browserType.launch({
			...options,
			executablePath: launcher,
			env: { ...process.env, UXW_CHROME_EXECUTABLE: chrome },
		});
	} catch (error) {
		log(
			`walk-chrome-launcher failed (${redactBrowserText(error.message.split("\n")[0], 300)}); starting Chrome normally, so macOS may ask for App Management in this app's name`,
		);
		return browserType.launch(options);
	}
}

export async function flushNativeNotes(browser, evidence, events, throughMs) {
	await browser.flushPendingNotes({
		fromMs: evidence.active.metadata.startedAtMs,
		throughMs,
		allowPage: (page) => events.accepts(page),
	});
	await events.flush();
}

export async function runNativeBrowser(captureId, workDir) {
	if (
		!/^[a-f\d-]{36}$/i.test(captureId) ||
		!path.isAbsolute(workDir) ||
		path.basename(workDir) !== captureId ||
		path.basename(path.dirname(workDir)) !== "walk-browser"
	)
		throw new Error("Invalid browser owner");
	const { loadConfig } = await import(new URL("config.mjs", engine));
	const { openBrowser } = await import(new URL("browser.mjs", engine));
	const cfg = loadConfig();
	const evidence = new NativeBrowserEvidence(captureId, workDir);
	const events = new OwnedWindowEvents(evidence);
	const marker = `UX Walk ${captureId}`;
	const bootstrap = http.createServer((request, response) => {
		if (request.url !== `/walk/${captureId}`) {
			response.writeHead(404);
			response.end();
			return;
		}
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		});
		response.end(
			`<!doctype html><title>${marker}</title><body style="font:18px system-ui;padding:48px">Opening your UX Walk…`,
		);
	});
	await new Promise((resolve) => bootstrap.listen(0, "127.0.0.1", resolve));
	let launched = null;
	const browser = await openBrowser({
		launch: async (browserType, options) => {
			launched = await launchWalkChrome(browserType, options);
			return launched;
		},
		url: `http://127.0.0.1:${bootstrap.address().port}/walk/${captureId}`,
		metadataOnly: false,
		authFile: cfg.authFile,
		windowSize: cfg.windowSize,
		trace: false,
		ignoreWrites: cfg.ignoreWrites,
		write: (event, page) => events.write(event, page),
		notesDir: () => evidence.notesDir(),
		contextSelectors: cfg.contextSelectors,
		canCapturePage: (page) => events.canCapturePage(page),
		genericTestids: cfg.genericTestids,
		onCommand: () =>
			"Use the recording controls for notes, chapters and pause.",
	}).catch(async (error) => {
		bootstrap.closeAllConnections();
		bootstrap.close();
		await launched?.close().catch(() => {});
		throw error;
	});
	const saveAuth = browser.saveAuth.bind(browser);
	browser.saveAuth = () =>
		evidence.active && evidence.mode === "recording"
			? saveAuth()
			: Promise.resolve();
	let closing = false;
	const close = async () => {
		if (closing) return;
		closing = true;
		evidence.mode = "closing";
		try {
			if (evidence.active) {
				await saveAuth();
				evidence.finish(
					evidence.active.metadata.journal,
					"failed",
					"The app or browser collector closed before collection completed",
				);
			}
		} finally {
			try {
				await browser.close();
			} finally {
				bootstrap.closeAllConnections();
				bootstrap.close();
				fs.rmSync(workDir, { recursive: true, force: true });
			}
		}
	};
	const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
	const input = readline.createInterface({ input: process.stdin });
	let commands = Promise.resolve();
	let noteFlush = Promise.resolve();
	input.on("line", (line) => {
		commands = commands
			.then(async () => {
				let message;
				try {
					if (line.length > 65536) throw new Error("Browser command too large");
					message = JSON.parse(line);
					if (message.captureId !== captureId)
						throw new Error("Browser owner mismatch");
					switch (message.op) {
						case "bind":
							if (evidence.windowId || !/^\d+$/.test(message.windowId))
								throw new Error("Browser window is already bound or invalid");
							evidence.windowId = message.windowId;
							break;
						case "navigate": {
							if (!evidence.windowId)
								throw new Error("Select the browser window before navigation");
							const url = new URL(message.url);
							if (!["http:", "https:"].includes(url.protocol))
								throw new Error("Use an http or https start page");
							await browser.context
								.pages()[0]
								.goto(url.href, {
									waitUntil: "domcontentloaded",
									timeout: 10000,
								})
								.catch((error) =>
									evidence.write({ ev: "pageerror", text: error.message }),
								);
							bootstrap.closeAllConnections();
							bootstrap.close();
							break;
						}
						case "start":
							evidence.start(message.file, message.windowId);
							break;
						case "clock": {
							const wasPaused = evidence
								.owned(message.file)
								.metadata.anchors.at(-1).paused;
							evidence.anchor(
								message.file,
								message.wallMs,
								message.offsetMs,
								message.paused,
							);
							if (message.paused && !wasPaused) {
								noteFlush = noteFlush
									.then(() =>
										flushNativeNotes(browser, evidence, events, message.wallMs),
									)
									.catch((error) => {
										if (evidence.active) {
											evidence.active.metadata.dropped++;
											evidence.active.metadata.reason = `Open browser note could not be saved: ${redactBrowserText(error.message, 300)}`;
											evidence.save();
										}
									});
							}
							break;
						}
						case "stop":
							evidence.owned(message.file);
							await noteFlush;
							await new Promise((resolve) => setTimeout(resolve, 3200));
							await events.flush();
							await browser.saveAuth();
							evidence.finish(message.file);
							break;
						case "abort":
							evidence.finish(
								message.file,
								"failed",
								"Native capture was interrupted",
							);
							break;
						case "close":
							await close();
							input.close();
							break;
						default:
							throw new Error("Unknown browser command");
					}
					reply({ id: message.id, ok: true });
				} catch (error) {
					reply({
						id: message?.id,
						ok: false,
						error: redactBrowserText(error.message, 500),
					});
				}
			})
			.catch(() => {});
	});
	input.on("close", () => {
		commands.finally(close).finally(() => process.exit());
	});
	const parent = process.ppid;
	const guard = setInterval(() => {
		try {
			process.kill(parent, 0);
		} catch {
			input.close();
		}
	}, 1000);
	guard.unref();
	browser.browser.once("disconnected", () => input.close());
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
		process.once(signal, () => input.close());
	await events.flush();
	if (!events.initial) {
		await close();
		throw new Error(
			"The bundled browser engine cannot identify the recorded page",
		);
	}
	reply({ ready: true, captureId, marker });
}

function isMainModule() {
	try {
		return (
			fs.realpathSync(process.argv[1]) ===
			fs.realpathSync(fileURLToPath(import.meta.url))
		);
	} catch {
		return false;
	}
}

if (isMainModule()) {
	runNativeBrowser(process.argv[2], process.argv[3]).catch((error) => {
		process.stdout.write(
			`${JSON.stringify({ ready: false, error: redactBrowserText(error.message, 500) })}\n`,
		);
		process.exit(1);
	});
}
