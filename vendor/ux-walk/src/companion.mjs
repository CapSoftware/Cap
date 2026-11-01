import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const COMPANION_PROTOCOL = 2;
export const COMPANION_HOST = "com.onc4ll.uxwalk";
export const COMPANION_EXTENSION = "lcdckhfbhjchfjnnnkmcbjnefdnapelh";
export const MAX_COMPANION_BYTES = 128 * 1024;
const need = (ok, message) => {
	if (!ok) throw new Error(message);
};
const identifier = (value) =>
	typeof value === "string" && /^[\w:.-]{1,160}$/.test(value);
const digest = (value) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bounded = (value, limit, label) => {
	need(typeof value === "string" && value.length <= limit, `Invalid ${label}.`);
	return value;
};
export const processAlive = (pid) => {
	try {
		if (!Number.isSafeInteger(pid) || pid < 1) return false;
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
export function assertCompanionAvailable(configDir) {
	for (const name of ["companion-session.json", "active.json"]) {
		let owner;
		try {
			owner = JSON.parse(fs.readFileSync(path.join(configDir, name)));
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		need(
			!processAlive(owner?.pid) ||
				(name === "companion-session.json" &&
					!processAlive(owner?.recorderPid)),
			"Companion ownership conflict: another recording is active. Stop it before starting a new recording.",
		);
	}
}
export function durableCompanionJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`,
		fd = fs.openSync(temporary, "w", 0o600);
	try {
		fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(temporary, file);
	const parent = fs.openSync(path.dirname(file), "r");
	try {
		fs.fsyncSync(parent);
	} finally {
		fs.closeSync(parent);
	}
}
function target(message) {
	need(
		typeof message.clientId === "string" &&
			message.clientId.length >= 16 &&
			identifier(message.clientId),
		"Invalid profile identity.",
	);
	need(
		Number.isSafeInteger(message.tabId) &&
			message.tabId >= 0 &&
			Number.isSafeInteger(message.windowId) &&
			message.windowId >= 0 &&
			identifier(message.documentId),
		"Invalid tab or document identity.",
	);
	need(
		["walkthrough", "meet"].includes(message.role),
		"Invalid companion role.",
	);
	const url = new URL(message.url);
	need(["http:", "https:"].includes(url.protocol), "Select an HTTP/HTTPS tab.");
	const meeting = message.role === "meet" ? url.pathname : undefined;
	if (meeting)
		need(
			url.origin === "https://meet.google.com" &&
				/^\/[\w-]{1,128}$/.test(meeting),
			"Select the joined Google Meet tab.",
		);
	return {
		clientId: message.clientId,
		tabId: message.tabId,
		windowId: message.windowId,
		documentId: message.documentId,
		role: message.role,
		origin: url.origin,
		url: `${url.origin}${url.pathname}`,
		title: String(message.title ?? "").slice(0, 200),
		...(meeting ? { meeting } : {}),
	};
}
export function normalizeCompanionEvent(raw, binding, receivedAt) {
	need(
		identifier(raw?.eventId) &&
			Number.isSafeInteger(raw.observedAt) &&
			raw.observedAt >= 0,
		"Invalid observation time or event identity.",
	);
	const base = {
		eventId: raw.eventId,
		observedAt: raw.observedAt,
		timingUncertain:
			raw.observedAt > receivedAt + 1000 || receivedAt - raw.observedAt > 30000,
		source: "chrome-extension",
		companion: {
			role: binding.role,
			bindingId: binding.bindingId,
			clientId: binding.clientId,
			tabId: binding.tabId,
			documentId: binding.documentId,
			recordingId: binding.recordingId,
			generation: binding.generation,
			...(binding.meeting ? { meeting: binding.meeting } : {}),
		},
	};
	let event;
	if (binding.role === "meet") {
		if (raw.kind === "caption") {
			need(
				identifier(raw.captionId) &&
					Number.isSafeInteger(raw.revision) &&
					raw.revision >= 1,
				"Invalid caption revision.",
			);
			event = {
				...base,
				ev: "meet-caption",
				name: bounded(raw.name, 128, "speaker name"),
				text: bounded(raw.text, 8000, "caption text"),
				captionId: raw.captionId,
				revision: raw.revision,
				localSpeaker: raw.localSpeaker === true,
				truncated: raw.truncated === true,
				identity: "Meet caption display name; unconfirmed",
			};
			need(event.name.trim() && event.text.trim(), "Empty caption.");
		} else if (raw.kind === "participants") {
			need(
				Array.isArray(raw.names) && raw.names.length <= 64,
				"Invalid participant list.",
			);
			event = {
				...base,
				ev: "meet-participants",
				names: raw.names.map((name) => bounded(name, 128, "participant name")),
			};
		} else if (raw.kind === "health") {
			need(
				["on", "off", "unknown"].includes(raw.captions),
				"Invalid caption health.",
			);
			event = {
				...base,
				ev: "meet-health",
				captions: raw.captions,
				visible: raw.visible === true,
			};
		}
	} else {
		const context = raw.context ?? {},
			url = new URL(context.url);
		need(url.origin === binding.origin, "Observation origin changed.");
		const viewport = context.viewport ?? {};
		need(
			[viewport.width, viewport.height].every(
				(value) => Number.isFinite(value) && value > 0 && value <= 50000,
			),
			"Invalid viewport.",
		);
		const page = {
			url: `${url.origin}${url.pathname}`,
			title: String(context.title ?? "").slice(0, 200),
			viewport: { width: viewport.width, height: viewport.height },
		};
		if (raw.kind === "click") {
			const element = raw.element ?? {};
			event = {
				...base,
				ev: "click",
				...page,
				el: {
					tag: String(element.tag ?? "").slice(0, 30),
					role: String(element.role ?? "").slice(0, 30),
					text: String(element.name ?? "").slice(0, 160),
					testid: String(element.testid ?? "").slice(0, 100),
				},
			};
		} else if (raw.kind === "checkpoint")
			event = {
				...base,
				ev: "text",
				...page,
				text: bounded(raw.text, 64000, "visible text"),
				truncated: raw.truncated === true,
			};
	}
	need(event, "Unsupported companion event.");
	need(
		Buffer.byteLength(JSON.stringify(event)) <= MAX_COMPANION_BYTES - 4096,
		"Observation is too large.",
	);
	return event;
}

export class CompanionSession {
	constructor(options) {
		this.options = options;
		this.metadata = options.metadata ?? {};
		this.metadata.roles ??= {};
		this.metadata.receipts ??= [];
	}
	identity(message) {
		need(
			message.recordingId === this.options.recordingId &&
				message.generation === this.options.generation,
			"Recording generation changed; select the tab again.",
		);
	}
	async handle(message) {
		need(
			message &&
				Buffer.byteLength(JSON.stringify(message)) <= MAX_COMPANION_BYTES,
			"Companion message is too large.",
		);
		const { options, metadata } = this,
			state = options.state();
		const clockEpoch = options.epoch?.() ?? 0;
		if (message.type === "companion-hello")
			return {
				type: "status",
				protocolVersion: COMPANION_PROTOCOL,
				backend: options.backend,
				state,
				recording: state === "recording",
				recordingId: options.recordingId,
				generation: options.generation,
				clockEpoch,
				browserMode: options.mode,
				meet: metadata.meet ?? {},
				roles: Object.fromEntries(
					Object.entries(metadata.roles).filter(
						([, role]) => role.clientId === message.clientId,
					),
				),
				...options.details?.(),
			};
		this.identity(message);
		const selected = target(message);
		const old = metadata.roles[selected.role];
		if (message.type === "companion-attach") {
			need(
				state === "recording",
				"Recorder must be recording, not paused or finishing.",
			);
			if (old) {
				need(
					[
						"clientId",
						"tabId",
						"windowId",
						"documentId",
						"origin",
						"meeting",
					].every((key) => old[key] === selected[key]),
					"This role is already bound. Stop its collection first.",
				);
				return old;
			}
			const binding = {
				...selected,
				recordingId: options.recordingId,
				generation: options.generation,
				clockEpoch,
				bindingId: randomUUID(),
			};
			metadata.roles[selected.role] = binding;
			try {
				await options.persist?.();
			} catch (error) {
				delete metadata.roles[selected.role];
				throw error;
			}
			return binding;
		}
		need(
			old &&
				[
					"clientId",
					"tabId",
					"windowId",
					"documentId",
					"origin",
					"meeting",
				].every((key) => old[key] === selected[key]) &&
				old.bindingId === message.bindingId,
			"This tab/document is not bound to the selected role.",
		);
		if (message.type === "companion-detach") {
			delete metadata.roles[selected.role];
			await options.persist?.();
			return { stopped: true };
		}
		need(
			message.type === "companion-events" && state === "recording",
			"Recorder must be recording, not paused or finishing.",
		);
		need(
			message.clockEpoch === clockEpoch,
			"Recording pause epoch changed; discard stale observations.",
		);
		need(
			Array.isArray(message.events) &&
				message.events.length > 0 &&
				message.events.length <= 16,
			"Invalid event batch.",
		);
		const events = message.events.map((raw) =>
			normalizeCompanionEvent(raw, old, options.clock?.() ?? Date.now()),
		);
		const ids = [];
		for (const event of events) {
			const hash = digest({ ...event, timingUncertain: undefined }),
				receipt = metadata.receipts.find((item) => item.id === event.eventId);
			if (receipt)
				need(receipt.hash === hash, "An event identity changed during retry.");
			else {
				const accepted = await options.write(event);
				need(accepted === true, "Recorder did not accept this observation.");
				metadata.receipts.push({ id: event.eventId, hash });
				if (event.ev === "meet-caption")
					metadata.meet = {
						...metadata.meet,
						lastCaptionAt: options.clock?.() ?? Date.now(),
					};
				if (event.ev === "meet-health")
					metadata.meet = { ...metadata.meet, captions: event.captions };
				if (event.ev === "meet-participants")
					metadata.meet = {
						...metadata.meet,
						participantCount: event.names.length,
					};
				while (metadata.receipts.length > 1024) metadata.receipts.shift();
			}
			ids.push(event.eventId);
		}
		await options.flush();
		await options.persist?.();
		return {
			acknowledged: true,
			recordingId: options.recordingId,
			generation: options.generation,
			eventIds: ids,
		};
	}
}

export async function startCompanionServer({
	configDir,
	session,
	recorderPid = process.pid,
	dispatch = (message) => session.handle(message),
}) {
	const descriptorFile = path.join(configDir, "companion-session.json");
	fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
	assertCompanionAvailable(configDir);
	const token = randomBytes(32).toString("hex");
	const port =
		20000 +
		(createHash("sha256")
			.update(fs.realpathSync(configDir))
			.digest()
			.readUInt16BE(0) %
			20000);
	let pending = 0,
		commands = Promise.resolve();
	const connections = new Set();
	const server = net.createServer((socket) => {
		if (connections.size >= 64) {
			socket.destroy();
			return;
		}
		connections.add(socket);
		socket.setEncoding("utf8");
		socket.on("close", () => connections.delete(socket));
		let buffer = "",
			consumed = false;
		socket.setTimeout(5000, () => socket.destroy());
		socket.on("error", () => {});
		socket.on("data", (bytes) => {
			if (consumed) {
				socket.destroy();
				return;
			}
			buffer += bytes.toString("utf8");
			if (Buffer.byteLength(buffer) > MAX_COMPANION_BYTES + 256) {
				socket.destroy();
				return;
			}
			if (!buffer.includes("\n")) return;
			consumed = true;
			if (pending >= 64) {
				socket.end(
					`${JSON.stringify({ ok: false, error: "Companion queue is full." })}\n`,
				);
				return;
			}
			pending++;
			commands = commands.then(async () => {
				try {
					const request = JSON.parse(buffer);
					need(
						typeof request.token === "string" &&
							request.token.length === token.length &&
							timingSafeEqual(Buffer.from(request.token), Buffer.from(token)),
						"Companion authentication failed.",
					);
					need(processAlive(recorderPid), "The native recording owner ended.");
					socket.end(
						`${JSON.stringify({ ok: true, result: await dispatch(request.message) })}\n`,
					);
				} catch (error) {
					socket.end(
						`${JSON.stringify({ ok: false, error: error.message })}\n`,
					);
				} finally {
					pending--;
				}
			});
		});
	});
	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
		});
		const descriptor = {
			protocolVersion: COMPANION_PROTOCOL,
			pid: process.pid,
			recorderPid,
			recordingId: session.options.recordingId,
			generation: session.options.generation,
			backend: session.options.backend,
			host: "127.0.0.1",
			port,
			token,
		};
		durableCompanionJson(descriptorFile, descriptor);
		const cleanup = () => {
			try {
				if (JSON.parse(fs.readFileSync(descriptorFile)).token === token)
					fs.unlinkSync(descriptorFile);
			} catch {}
		};
		return {
			descriptor,
			cleanup,
			close: async () => {
				for (const socket of connections) socket.destroy();
				await new Promise((resolve) => server.close(resolve));
				cleanup();
			},
		};
	} catch (error) {
		server.close();
		if (error.code === "EADDRINUSE")
			throw new Error(
				"Companion ownership conflict: an active owner or another local application holds this configuration's evidence port.",
			);
		throw error;
	}
}

export function requestCompanion(descriptor, message) {
	return new Promise((resolve, reject) => {
		need(
			descriptor.host === "127.0.0.1" &&
				Number.isSafeInteger(descriptor.port) &&
				descriptor.port >= 20000 &&
				descriptor.port < 40000,
			"Invalid local companion endpoint.",
		);
		const socket = net.createConnection({
			host: "127.0.0.1",
			port: descriptor.port,
		});
		socket.setEncoding("utf8");
		let data = "";
		socket.setTimeout(5000, () =>
			socket.destroy(new Error("Companion owner timed out.")),
		);
		socket.on("connect", () =>
			socket.write(`${JSON.stringify({ token: descriptor.token, message })}\n`),
		);
		socket.on("error", reject);
		socket.on("data", (bytes) => {
			data += bytes.toString("utf8");
			if (Buffer.byteLength(data) > MAX_COMPANION_BYTES) {
				socket.destroy(new Error("Companion reply is too large."));
				return;
			}
			if (!data.includes("\n")) return;
			try {
				const response = JSON.parse(data);
				if (!response.ok) throw new Error(response.error);
				resolve(response.result);
			} catch (error) {
				reject(error);
			}
			socket.destroy();
		});
		socket.on("end", () => {
			if (!data.includes("\n"))
				reject(new Error("Companion owner disconnected before acknowledging."));
		});
	});
}
