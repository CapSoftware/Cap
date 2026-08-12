const { app, ipcMain, net: electronNet, protocol, session } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { RustBackend } = require("./backend.cjs");
const { NativeBridge } = require("./native.cjs");
const { WindowManager } = require("./windows.cjs");

protocol.registerSchemesAsPrivileged([
	{ scheme: "cap", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
	{ scheme: "cap-asset", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const development = !app.isPackaged;
let backend;
let quitting = false;
const pendingOpenUrls = [];

app.setName(development ? "Cap - Development" : "Cap");
app.setAppUserModelId(development ? "so.cap.desktop.dev" : "so.cap.desktop");
app.setPath(
	"userData",
	process.env.CAP_ELECTRON_USER_DATA_DIR
		? path.resolve(process.env.CAP_ELECTRON_USER_DATA_DIR)
		: path.join(app.getPath("appData"), development ? "Cap Development" : "so.cap.desktop"),
);
if (!development) app.setAsDefaultProtocolClient("cap-desktop");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

if (hasSingleInstanceLock) {
	app.whenReady().then(start).catch((error) => {
		console.error(error);
		app.exit(1);
	});
}

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
	const mainWindow = globalThis.capWindowManager?.get("main");
	if (mainWindow) {
		mainWindow.show();
		mainWindow.focus();
	}
	backend?.send({ type: "event", event: "electron://reopen", payload: null });
});

app.on("second-instance", (_event, commandLine, workingDirectory) => {
	queueOpenUrls(commandLine, workingDirectory);
	const mainWindow = globalThis.capWindowManager?.get("main");
	if (mainWindow) {
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.show();
		mainWindow.focus();
	}
});

app.on("open-url", (event, url) => {
	event.preventDefault();
	queueOpenUrls([url]);
});

app.on("open-file", (event, filePath) => {
	event.preventDefault();
	queueOpenUrls([filePath]);
});

app.on("before-quit", (event) => {
	if (quitting || !backend) return;
	event.preventDefault();
	quitting = true;
	globalThis.capWindowManager?.beginQuit();
	backend.stop().finally(() => app.quit());
});

async function start() {
	const publicDir = path.join(__dirname, "..", ".output", "public");
	registerProtocols(publicDir);
	configureSecurity();

	const backendFilename = `cap-desktop-${rustTargetTriple()}${process.platform === "win32" ? ".exe" : ""}`;
	const binaryPath = development
		? path.resolve(__dirname, "../../../target/debug/cap-desktop")
		: process.platform === "darwin"
			? path.join(path.dirname(process.execPath), backendFilename)
			: path.join(process.resourcesPath, "bin", backendFilename);
	if (!fs.existsSync(binaryPath)) {
		throw new Error(`Rust backend is missing at ${binaryPath}. Run pnpm build:backend first.`);
	}
	backend = new RustBackend({ binaryPath, resourceDir: process.resourcesPath, spawn });
	await backend.start();

	const windowManager = new WindowManager({
		backend,
		devUrl: development ? process.env.CAP_DESKTOP_DEV_URL ?? "http://localhost:3002" : null,
		publicDir,
		preloadPath: path.join(__dirname, "preload.cjs"),
	});
	globalThis.capWindowManager = windowManager;
	const nativeBridge = new NativeBridge(windowManager);
	backend.onMessage((message) => {
		if (message.type === "backendError") {
			console.error(message.error);
			if (!quitting) app.quit();
			return;
		}
		if (message.type === "nativeOperation") {
			void nativeBridge.invoke("main", message.operation, message.payload).catch(console.error);
		}
		if (message.type === "nativeRequest") {
			void nativeBridge.invoke("main", message.operation, message.payload).then(
				(value) => backend.send({ type: "nativeResult", id: message.id, result: { Ok: value ?? null } }),
				(error) => backend.send({ type: "nativeResult", id: message.id, result: { Err: String(error) } }),
			);
		}
	});

	ipcMain.handle("cap:invoke", (_event, request) =>
		backend.invoke(request.windowLabel, request.command, request.arguments),
	);
	ipcMain.handle("cap:native", (_event, request) =>
		nativeBridge.invoke(request.windowLabel, request.operation, request.payload),
	);
	ipcMain.on("cap:emit", (_event, request) => {
		backend.send({ type: "event", event: request.event, payload: request.payload ?? null });
	});
	ipcMain.on("cap:window-drop", (_event, request) => {
		windowManager.sendWindowEvent(request.windowLabel, { type: "dragDrop", paths: request.paths });
	});
	globalThis.__capMenuSelection = (id) => {
		for (const window of windowManager.windows.values()) {
			window.webContents.send("cap:event", { type: "event", event: `menu:${id}`, payload: null });
		}
	};
	queueOpenUrls(process.argv, process.cwd());
}

function queueOpenUrls(values, workingDirectory = process.cwd()) {
	for (const value of values) {
		if (typeof value !== "string" || value.startsWith("--")) continue;
		if (value.startsWith("cap-desktop://") || value.startsWith("file://")) {
			pendingOpenUrls.push(value);
			continue;
		}
		const candidate = path.isAbsolute(value) ? value : path.resolve(workingDirectory, value);
		if (path.extname(candidate).toLowerCase() === ".cap" && fs.existsSync(candidate)) {
			pendingOpenUrls.push(pathToFileURL(candidate).toString());
		}
	}
	if (backend?.socket && pendingOpenUrls.length > 0) {
		backend.send({ type: "event", event: "electron://open-urls", payload: pendingOpenUrls.splice(0) });
	}
}

function rustTargetTriple() {
	const triple = {
		"darwin-arm64": "aarch64-apple-darwin",
		"darwin-x64": "x86_64-apple-darwin",
		"win32-arm64": "aarch64-pc-windows-msvc",
		"win32-x64": "x86_64-pc-windows-msvc",
		"linux-arm64": "aarch64-unknown-linux-gnu",
		"linux-x64": "x86_64-unknown-linux-gnu",
	}[`${process.platform}-${process.arch}`];
	if (!triple) throw new Error(`Unsupported Electron target ${process.platform}-${process.arch}`);
	return triple;
}

function registerProtocols(publicDir) {
	protocol.handle("cap", (request) => {
		const url = new URL(request.url);
		let relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
		if (!relativePath || !path.extname(relativePath)) relativePath = "index.html";
		const filePath = path.resolve(publicDir, relativePath);
		if (!filePath.startsWith(`${path.resolve(publicDir)}${path.sep}`) && filePath !== path.join(publicDir, "index.html")) {
			return new Response("Not found", { status: 404 });
		}
		return electronNet.fetch(pathToFileURL(filePath).toString());
	});
	protocol.handle("cap-asset", (request) => {
		const url = new URL(request.url);
		try {
			const encoded = url.pathname.replace(/^\/+/, "");
			const filePath = Buffer.from(encoded, "base64url").toString("utf8");
			if (!path.isAbsolute(filePath)) return new Response("Invalid asset path", { status: 400 });
			return electronNet.fetch(pathToFileURL(filePath).toString());
		} catch {
			return new Response("Invalid asset URL", { status: 400 });
		}
	});
}

function configureSecurity() {
	session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
		callback(["media", "notifications", "clipboard-sanitized-write"].includes(permission));
	});
	app.on("web-contents-created", (_event, contents) => {
		contents.setWindowOpenHandler(({ url }) => {
			require("electron").shell.openExternal(url);
			return { action: "deny" };
		});
		contents.on("will-navigate", (event, url) => {
			if (!url.startsWith("cap://") && !url.startsWith("http://localhost:3002")) event.preventDefault();
		});
	});
}
