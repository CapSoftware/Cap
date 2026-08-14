const crypto = require("node:crypto");
const net = require("node:net");

const PROTOCOL_VERSION = 1;
const MAX_FRAME_SIZE = 128 * 1024 * 1024;

class RustBackend {
	constructor({ binaryPath, resourceDir, spawn }) {
		this.binaryPath = binaryPath;
		this.resourceDir = resourceDir;
		this.spawn = spawn;
		this.buffer = Buffer.alloc(0);
		this.nextInvokeId = 1;
		this.pending = new Map();
		this.listeners = new Set();
		this.startupMessages = [];
		this.ready = new Promise((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
	}

	async start() {
		const token = crypto.randomBytes(32).toString("hex");
		this.server = net.createServer((socket) => this.accept(socket, token));
		await new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", resolve);
		});
		const address = this.server.address();
		if (!address || typeof address === "string")
			throw new Error("Invalid backend address");
		this.child = this.spawn(this.binaryPath, [], {
			cwd: this.resourceDir,
			env: {
				...process.env,
				CAP_ELECTRON_IPC_ADDR: `127.0.0.1:${address.port}`,
				CAP_ELECTRON_IPC_TOKEN: token,
				CAP_ELECTRON_RESOURCE_DIR: this.resourceDir,
				CAP_ELECTRON_APP_DATA_DIR: require("electron").app.getPath("userData"),
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child.stdout.on("data", (data) => process.stdout.write(data));
		this.child.stderr.on("data", (data) => process.stderr.write(data));
		this.child.once("error", (error) => this.fail(error));
		this.child.once("exit", (code, signal) => {
			if (!this.stopping)
				this.fail(new Error(`Rust backend exited (${code ?? signal})`));
		});
		return this.ready;
	}

	accept(socket, token) {
		if (this.socket) {
			socket.destroy();
			return;
		}
		this.socket = socket;
		this.server.close();
		socket.setNoDelay(true);
		socket.on("data", (data) => this.read(data));
		socket.once("error", (error) => this.fail(error));
		socket.once("close", () => {
			if (!this.stopping)
				this.fail(new Error("Rust backend connection closed"));
		});
		this.send({ type: "hello", token, protocolVersion: PROTOCOL_VERSION });
	}

	read(data) {
		this.buffer = Buffer.concat([this.buffer, data]);
		while (this.buffer.length >= 4) {
			const length = this.buffer.readUInt32BE(0);
			if (length > MAX_FRAME_SIZE) {
				this.fail(
					new Error(`Rust backend frame exceeded ${MAX_FRAME_SIZE} bytes`),
				);
				return;
			}
			if (this.buffer.length < length + 4) return;
			const payload = this.buffer.subarray(4, length + 4);
			this.buffer = this.buffer.subarray(length + 4);
			try {
				this.receive(JSON.parse(payload.toString("utf8")));
			} catch (error) {
				this.fail(error);
				return;
			}
		}
	}

	receive(message) {
		if (!this.commands && message.type !== "ready")
			this.startupMessages.push(message);
		if (message.type === "ready") {
			if (message.protocolVersion !== PROTOCOL_VERSION) {
				this.fail(new Error("Rust backend protocol version mismatch"));
				return;
			}
			this.commands = new Set(message.commands);
			this.resolveReady();
		}
		if (message.type === "invokeResult") {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.response.status === "ok")
				pending.resolve(message.response.value);
			else pending.reject(new Error(message.response.error));
		}
		for (const listener of this.listeners) listener(message);
	}

	invoke(windowLabel, command, arguments_) {
		return this.ready.then(
			() =>
				new Promise((resolve, reject) => {
					const id = this.nextInvokeId++;
					this.pending.set(id, { resolve, reject });
					const sent = this.send({
						type: "invoke",
						id,
						windowLabel,
						command,
						arguments: arguments_ ?? {},
					});
					if (!sent) {
						this.pending.delete(id);
						reject(this.failure ?? new Error("Rust backend is disconnected"));
					}
				}),
		);
	}

	send(message) {
		if (!this.socket || this.socket.destroyed || this.failure) return false;
		const payload = Buffer.from(JSON.stringify(message));
		if (payload.length > MAX_FRAME_SIZE) {
			throw new Error(`Rust backend frame exceeded ${MAX_FRAME_SIZE} bytes`);
		}
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32BE(payload.length);
		this.socket.cork();
		this.socket.write(header);
		this.socket.write(payload);
		this.socket.uncork();
		return true;
	}

	onMessage(listener) {
		this.listeners.add(listener);
		for (const message of this.startupMessages) listener(message);
		return () => this.listeners.delete(listener);
	}

	async stop() {
		this.stopping = true;
		if (this.socket && !this.socket.destroyed) this.send({ type: "shutdown" });
		if (this.child && this.child.exitCode === null) {
			await Promise.race([
				new Promise((resolve) => this.child.once("exit", resolve)),
				new Promise((resolve) => setTimeout(resolve, 3000)),
			]);
		}
		if (this.child && this.child.exitCode === null) this.child.kill();
		this.socket?.destroy();
		this.server?.close();
	}

	fail(error) {
		if (this.failure || this.stopping) return;
		this.failure = error instanceof Error ? error : new Error(String(error));
		this.rejectReady(error);
		for (const pending of this.pending.values()) pending.reject(this.failure);
		this.pending.clear();
		for (const listener of this.listeners) {
			try {
				listener({ type: "backendError", error: String(this.failure) });
			} catch (listenerError) {
				console.error(listenerError);
			}
		}
	}
}

module.exports = { RustBackend };
