const {
	app,
	clipboard,
	dialog,
	globalShortcut,
	Menu,
	nativeImage,
	nativeTheme,
	Notification,
	screen,
	shell,
	Tray,
} = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");

class NativeBridge {
	constructor(windowManager) {
		this.windowManager = windowManager;
		this.stores = new Map();
		this.hotkeyAccelerators = new Set();
		this.escapeRegistered = false;
		this.tray = null;
		this.trayMode = "studio";
		this.trayRecording = false;
		this.updateChannel = "stable";
		autoUpdater.autoDownload = false;
		autoUpdater.autoInstallOnAppQuit = true;
		autoUpdater.on("download-progress", (progress) => {
			this.windowManager.backend.send({
				type: "event",
				event: "update-download-progress",
				payload: {
					downloaded: Math.min(progress.transferred, 0xffffffff),
					total: Math.min(progress.total, 0xffffffff),
				},
			});
		});
		autoUpdater.on("update-downloaded", (info) => {
			this.windowManager.backend.send({
				type: "event",
				event: "update-ready",
				payload: { version: info.version, installed: true },
			});
		});
	}

	async invoke(windowLabel, operation, payload = {}) {
		const window = this.windowManager.get(windowLabel);
		switch (operation) {
			case "app.exit":
				this.windowManager.beginQuit();
				app.exit(payload.exitCode ?? 0);
				return;
			case "app.dockVisibility":
				if (app.dock) payload.visible ? app.dock.show() : app.dock.hide();
				return;
			case "app.activationPolicy":
				if (process.platform === "darwin")
					app.setActivationPolicy(payload.policy);
				return;
			case "app.version":
				return app.getVersion();
			case "app.name":
				return app.getName();
			case "app.relaunch":
				app.relaunch();
				app.exit(0);
				return;
			case "clipboard.readText":
				return clipboard.readText();
			case "clipboard.writeText":
				clipboard.writeText(payload.text);
				return;
			case "dialog.open":
				return this.openDialog(window, payload);
			case "dialog.save":
				return this.saveDialog(window, payload);
			case "dialog.message":
				return this.messageDialog(window, payload);
			case "dialog.ask":
				return this.questionDialog(window, payload, false);
			case "dialog.confirm":
				return this.questionDialog(window, payload, true);
			case "fs.exists":
				return this.exists(resolveBaseDirectory(payload.path, payload.baseDir));
			case "fs.readFile":
				return Array.from(
					await fs.readFile(
						resolveBaseDirectory(payload.path, payload.baseDir),
					),
				);
			case "fs.readTextFile":
				return fs.readFile(
					resolveBaseDirectory(payload.path, payload.baseDir),
					"utf8",
				);
			case "fs.writeFile":
				await writeFile(payload);
				return;
			case "fs.writeTextFile":
				await writeTextFile(payload);
				return;
			case "fs.remove":
				await fs.rm(resolveBaseDirectory(payload.path, payload.baseDir), {
					recursive: payload.recursive ?? false,
					force: true,
				});
				return;
			case "fs.mkdir":
				await fs.mkdir(resolveBaseDirectory(payload.path, payload.baseDir), {
					recursive: payload.recursive ?? false,
				});
				return;
			case "fs.readDir":
				return readDir(resolveBaseDirectory(payload.path, payload.baseDir));
			case "fs.stat":
				return stat(resolveBaseDirectory(payload.path, payload.baseDir));
			case "hotkeys.configure":
				return this.configureHotkeys(payload.hotkeys ?? []);
			case "hotkeys.escapeEnabled":
				return this.setEscapeEnabled(payload.enabled);
			case "menu.popup":
				return this.popupMenu(window, payload.items, payload.position);
			case "notification.permission":
				return Notification.isSupported() ? "granted" : "denied";
			case "notification.requestPermission":
				return Notification.isSupported() ? "granted" : "denied";
			case "notification.show":
				new Notification(payload).show();
				return;
			case "opener.openPath":
				return shell.openPath(payload.path);
			case "opener.revealItemInDir":
				shell.showItemInFolder(payload.path);
				return;
			case "os.arch":
				return normalizeArch(process.arch);
			case "os.hostname":
				return os.hostname();
			case "os.locale":
				return app.getLocale();
			case "os.platform":
				return process.platform;
			case "os.type":
				return normalizeType(process.platform);
			case "os.version":
				return os.release();
			case "path.appDataDir":
				return withSeparator(app.getPath("userData"));
			case "path.appLocalDataDir":
				return withSeparator(app.getPath("userData"));
			case "path.audioDir":
				return withSeparator(app.getPath("music"));
			case "path.cacheDir":
				return withSeparator(app.getPath("sessionData"));
			case "path.configDir":
				return withSeparator(app.getPath("userData"));
			case "path.dataDir":
				return withSeparator(app.getPath("appData"));
			case "path.desktopDir":
				return withSeparator(app.getPath("desktop"));
			case "path.documentDir":
				return withSeparator(app.getPath("documents"));
			case "path.downloadDir":
				return withSeparator(app.getPath("downloads"));
			case "path.homeDir":
				return withSeparator(app.getPath("home"));
			case "path.pictureDir":
				return withSeparator(app.getPath("pictures"));
			case "path.resourceDir":
				return withSeparator(process.resourcesPath);
			case "path.tempDir":
				return withSeparator(app.getPath("temp"));
			case "path.videoDir":
				return withSeparator(app.getPath("videos"));
			case "path.join":
				return path.join(...payload.paths);
			case "path.resolve":
				return path.resolve(...payload.paths);
			case "shell.open":
				await shell.openExternal(payload.path);
				return;
			case "shell.openPath":
				return shell.openPath(payload.path);
			case "store.load":
				return this.loadStore(payload.path);
			case "store.save":
				return this.saveStore(payload.path, payload.value);
			case "theme.get":
				return nativeTheme.shouldUseDarkColors ? "dark" : "light";
			case "tray.configure":
				return this.configureTray(payload);
			case "tray.setMode":
				this.trayMode = payload.mode ?? "studio";
				return this.updateTrayIcon();
			case "tray.setRecording":
				this.trayRecording = payload.recording === true;
				return this.updateTrayIcon();
			case "updater.check":
				return this.checkForUpdates(payload.channel);
			case "updater.configure":
				return this.configureUpdater(payload.channel);
			case "updater.downloadAndInstall":
				return this.downloadAndInstall(payload.channel);
			case "updater.setChannel":
				this.updateChannel = payload.channel ?? "stable";
				return this.configureUpdater(this.updateChannel);
			case "window.action":
				return this.windowAction(windowLabel, payload);
			case "window.all":
				return [...this.windowManager.windows.keys()];
			case "window.create":
				this.windowManager.create(payload);
				return payload.label;
			case "window.currentMonitor":
				return this.windowManager.normalizeDisplay(
					window
						? screen.getDisplayMatching(window.getBounds())
						: screen.getPrimaryDisplay(),
				);
			case "window.primaryMonitor":
				return this.windowManager.normalizeDisplay(screen.getPrimaryDisplay());
			case "window.availableMonitors":
				return screen
					.getAllDisplays()
					.map((display) => this.windowManager.normalizeDisplay(display));
			case "window.monitorFromPoint":
				return this.windowManager.normalizeDisplay(
					this.windowManager.displayFromPhysicalPoint(payload),
				);
			case "window.teardownVisualEffects":
				return;
			default:
				throw new Error(`Unknown Electron native operation '${operation}'`);
		}
	}

	async openDialog(window, options) {
		const result = await dialog.showOpenDialog(window, {
			title: options.title,
			defaultPath: options.defaultPath,
			buttonLabel: options.buttonLabel,
			filters: normalizeFilters(options.filters),
			properties: [
				options.directory ? "openDirectory" : "openFile",
				...(options.multiple ? ["multiSelections"] : []),
				...(options.recursive ? ["showHiddenFiles"] : []),
			],
		});
		if (result.canceled) return null;
		return options.multiple ? result.filePaths : result.filePaths[0];
	}

	async saveDialog(window, options) {
		const result = await dialog.showSaveDialog(window, {
			title: options.title,
			defaultPath: options.defaultPath,
			buttonLabel: options.buttonLabel,
			filters: normalizeFilters(options.filters),
		});
		return result.canceled ? null : result.filePath;
	}

	async messageDialog(window, options) {
		const normalized =
			typeof options === "string" ? { message: options } : options;
		const buttons = Array.isArray(normalized.buttons)
			? normalized.buttons
			: normalized.buttons
				? Object.values(normalized.buttons).filter(Boolean)
				: [normalized.okLabel ?? "OK"];
		const result = await dialog.showMessageBox(window, {
			type: normalized.kind ?? "info",
			title: normalized.title,
			message: normalized.message,
			detail: normalized.detail,
			buttons,
		});
		return buttons[result.response];
	}

	async questionDialog(window, options, isConfirm) {
		const normalized =
			typeof options === "string" ? { message: options } : options;
		const result = await dialog.showMessageBox(window, {
			type: normalized.kind ?? "question",
			title: normalized.title,
			message: normalized.message,
			detail: normalized.detail,
			buttons: [
				normalized.okLabel ?? (isConfirm ? "OK" : "Yes"),
				normalized.cancelLabel ?? (isConfirm ? "Cancel" : "No"),
			],
			defaultId: 0,
			cancelId: 1,
		});
		return result.response === 0;
	}

	async exists(filePath) {
		try {
			await fs.access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	popupMenu(window, items, position) {
		const menu = Menu.buildFromTemplate(items.map(normalizeMenuItem));
		menu.popup({
			window,
			x: position ? Math.round(position.x) : undefined,
			y: position ? Math.round(position.y) : undefined,
		});
	}

	async loadStore(name) {
		const storePath = this.storePath(name);
		if (this.stores.has(storePath)) return this.stores.get(storePath);
		let value = {};
		try {
			value = JSON.parse(await fs.readFile(storePath, "utf8"));
		} catch {}
		this.stores.set(storePath, value);
		return value;
	}

	async saveStore(name, value) {
		const storePath = this.storePath(name);
		this.stores.set(storePath, value);
		await fs.mkdir(path.dirname(storePath), { recursive: true });
		await fs.writeFile(storePath, JSON.stringify(value, null, 2));
	}

	storePath(name) {
		return path.join(app.getPath("userData"), "stores", path.basename(name));
	}

	windowAction(label, payload) {
		const window = this.windowManager.get(payload.label ?? label);
		if (!window || window.isDestroyed())
			throw new Error(`Window '${payload.label ?? label}' does not exist`);
		if (payload.action === "state")
			return this.windowManager.windowState(window);
		if (payload.action === "cursorPosition")
			return this.windowManager.cursorPosition?.() ?? { x: 0, y: 0 };
		this.windowManager.operation(window, {
			type: payload.action,
			...payload.value,
		});
	}

	configureHotkeys(hotkeys) {
		for (const accelerator of this.hotkeyAccelerators)
			globalShortcut.unregister(accelerator);
		this.hotkeyAccelerators.clear();
		for (const hotkey of hotkeys) {
			if (
				!hotkey.accelerator ||
				this.hotkeyAccelerators.has(hotkey.accelerator)
			)
				continue;
			if (
				globalShortcut.register(hotkey.accelerator, () => {
					this.windowManager.backend.send({
						type: "event",
						event: "hotkey://trigger",
						payload: hotkey.action,
					});
				})
			)
				this.hotkeyAccelerators.add(hotkey.accelerator);
		}
		const settingsAccelerator = "CommandOrControl+,";
		if (
			!this.hotkeyAccelerators.has(settingsAccelerator) &&
			globalShortcut.register(settingsAccelerator, () => {
				this.windowManager.backend.send({
					type: "event",
					event: "hotkey://settings",
					payload: null,
				});
			})
		)
			this.hotkeyAccelerators.add(settingsAccelerator);
	}

	setEscapeEnabled(enabled) {
		if (enabled && !this.escapeRegistered) {
			this.escapeRegistered = globalShortcut.register("Escape", () => {
				this.windowManager.backend.send({
					type: "event",
					event: "hotkey://escape",
					payload: null,
				});
			});
		} else if (!enabled && this.escapeRegistered) {
			globalShortcut.unregister("Escape");
			this.escapeRegistered = false;
		}
	}

	configureTray(payload) {
		this.trayMode = payload.mode ?? this.trayMode;
		if (!this.tray) {
			this.tray = new Tray(this.trayIconPath());
			this.tray.setToolTip("Cap");
			this.tray.on("click", () => {
				if (this.trayRecording) this.emitTrayClick("stop_recording");
				else this.tray.popUpContextMenu();
			});
		}
		this.tray.setContextMenu(
			Menu.buildFromTemplate(
				(payload.items ?? []).map((item) => this.trayMenuItem(item)),
			),
		);
		this.updateTrayIcon();
	}

	trayMenuItem(item) {
		if (item.type === "separator") return { type: "separator" };
		return {
			id: item.id,
			label: item.text,
			type: item.checked === undefined ? "normal" : "checkbox",
			checked: item.checked,
			enabled: item.enabled ?? true,
			submenu: item.items?.map((child) => this.trayMenuItem(child)),
			click: () => item.id && this.emitTrayClick(item.id),
		};
	}

	emitTrayClick(id) {
		this.windowManager.backend.send({
			type: "event",
			event: "tray://click",
			payload: id,
		});
	}

	updateTrayIcon() {
		if (!this.tray) return;
		const image = nativeImage.createFromPath(this.trayIconPath());
		if (process.platform === "darwin") image.setTemplateImage(true);
		this.tray.setImage(image);
	}

	trayIconPath() {
		const filename = this.trayRecording
			? "tray-stop-icon.png"
			: this.trayMode === "instant"
				? "tray-default-icon-instant.png"
				: this.trayMode === "screenshot"
					? "tray-default-icon-screenshot.png"
					: "tray-default-icon.png";
		const iconsDir = app.isPackaged
			? path.join(process.resourcesPath, "tray-icons")
			: path.join(__dirname, "..", "src-backend", "icons");
		return path.join(iconsDir, filename);
	}

	configureUpdater(channel = "stable") {
		this.updateChannel = channel;
		this.setUpdaterFeed(channel);
		if (this.updateTimer) clearInterval(this.updateTimer);
		if (!app.isPackaged || channel !== "nightly") return;
		this.updateTimer = setInterval(
			() => void this.checkForUpdates(channel).catch(console.error),
			2 * 60 * 60 * 1000,
		);
	}

	setUpdaterFeed(channel) {
		if (!app.isPackaged) return;
		autoUpdater.channel = channel === "nightly" ? "nightly" : "latest";
		const baseUrl = process.env.CAP_ELECTRON_UPDATE_URL;
		if (baseUrl)
			autoUpdater.setFeedURL({
				provider: "generic",
				url: `${baseUrl}/${channel}`,
			});
		else
			autoUpdater.setFeedURL({
				provider: "github",
				owner: "CapSoftware",
				repo: "Cap",
			});
	}

	async checkForUpdates(channel = this.updateChannel) {
		if (!app.isPackaged) return null;
		this.setUpdaterFeed(channel);
		const result = await autoUpdater.checkForUpdates();
		if (!result?.updateInfo || result.updateInfo.version === app.getVersion())
			return null;
		return {
			version: result.updateInfo.version,
			notes:
				typeof result.updateInfo.releaseNotes === "string"
					? result.updateInfo.releaseNotes
					: null,
			channel,
		};
	}

	async downloadAndInstall(channel = this.updateChannel) {
		const update = await this.checkForUpdates(channel);
		if (!update) throw new Error("No update available");
		await autoUpdater.downloadUpdate();
		return { version: update.version, installed: true };
	}
}

function normalizeMenuItem(item) {
	if (item.type === "separator") return { type: "separator" };
	return {
		id: item.id,
		label: item.text,
		type: item.checked === undefined ? "normal" : "checkbox",
		checked: item.checked,
		enabled: item.enabled ?? true,
		accelerator: item.accelerator,
		role: item.role,
		submenu: item.items?.map(normalizeMenuItem),
		click: () => item.id && globalThis.__capMenuSelection?.(item.id),
	};
}

function normalizeFilters(filters) {
	return filters?.map((filter) => ({
		name: filter.name,
		extensions: filter.extensions,
	}));
}

function normalizeArch(arch) {
	return { x64: "x86_64", arm64: "aarch64", ia32: "x86" }[arch] ?? arch;
}

function normalizeType(platform) {
	return (
		{ darwin: "macos", win32: "windows", linux: "linux" }[platform] ?? platform
	);
}

function resolveBaseDirectory(filePath, baseDir) {
	if (!baseDir || path.isAbsolute(filePath)) return filePath;
	const names = {
		1: "audioDir",
		2: "cacheDir",
		3: "configDir",
		4: "dataDir",
		6: "localDataDir",
		7: "desktop",
		8: "documents",
		9: "downloads",
		11: "home",
		15: "pictures",
		18: "public",
		20: "resource",
		21: "temp",
		22: "templates",
		24: "videos",
	};
	const name = names[baseDir];
	if (name === "resource") return path.join(process.resourcesPath, filePath);
	if (name === "temp") return path.join(app.getPath("temp"), filePath);
	if (name === "home") return path.join(app.getPath("home"), filePath);
	if (name === "localDataDir" || name === "configDir")
		return path.join(app.getPath("userData"), filePath);
	if (!name) throw new Error(`Unsupported base directory '${baseDir}'`);
	return path.join(app.getPath(name), filePath);
}

async function writeFile(payload) {
	const filePath = resolveBaseDirectory(payload.path, payload.baseDir);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, Buffer.from(payload.data));
}

async function writeTextFile(payload) {
	const filePath = resolveBaseDirectory(payload.path, payload.baseDir);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, payload.contents, "utf8");
}

async function readDir(filePath) {
	const entries = await fs.readdir(filePath, { withFileTypes: true });
	return entries.map((entry) => ({
		name: entry.name,
		isDirectory: entry.isDirectory(),
		isFile: entry.isFile(),
		isSymlink: entry.isSymbolicLink(),
	}));
}

async function stat(filePath) {
	const value = await fs.stat(filePath);
	return {
		size: value.size,
		isFile: value.isFile(),
		isDirectory: value.isDirectory(),
		isSymlink: value.isSymbolicLink(),
		mtime: value.mtime,
		atime: value.atime,
		birthtime: value.birthtime,
	};
}

function withSeparator(value) {
	return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

module.exports = { NativeBridge };
