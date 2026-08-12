const { BrowserWindow, nativeTheme, screen } = require("electron");

class WindowManager {
	constructor({ backend, devUrl, publicDir, preloadPath }) {
		this.backend = backend;
		this.devUrl = devUrl;
		this.publicDir = publicDir;
		this.preloadPath = preloadPath;
		this.windows = new Map();
		this.windowMetadata = new WeakMap();
		this.allowedToClose = new WeakSet();
		this.allowAllClose = false;
		backend.onMessage((message) => this.receive(message));
		this.nativeThemeListener = () => {
			const theme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
			for (const [label, window] of this.windows) {
				if (window.isDestroyed()) continue;
				window.webContents.send("cap:event", {
					type: "event",
					event: "tauri://theme-changed",
					payload: theme,
					target: label,
				});
			}
		};
		nativeTheme.on("updated", this.nativeThemeListener);
		this.lastCursorPosition = null;
		this.cursorTimer = setInterval(() => {
			const position = this.dipPointToPhysical(screen.getCursorScreenPoint());
			if (
				this.lastCursorPosition?.x === position.x &&
				this.lastCursorPosition?.y === position.y
			)
				return;
			this.lastCursorPosition = position;
			this.backend.send({
				type: "cursorPosition",
				x: position.x,
				y: position.y,
			});
		}, 50);
	}

	create(options) {
		const existing = this.windows.get(options.label);
		if (existing && !existing.isDestroyed()) {
			if (options.visible) existing.show();
			if (options.focus) existing.focus();
			return existing;
		}
		const bounds = this.initialBounds(options);
		const chrome = nativeWindowChrome(options.label);
		const transparent = shouldUseTransparentSurface(options);
		const window = new BrowserWindow({
			title: options.title ?? "Cap",
			x: finite(bounds.x),
			y: finite(bounds.y),
			width: Math.round(bounds.width ?? 800),
			height: Math.round(bounds.height ?? 600),
			minWidth: finite(options.minWidth),
			minHeight: finite(options.minHeight),
			show: false,
			transparent,
			backgroundColor: transparent
				? "#00000000"
				: nativeTheme.shouldUseDarkColors
					? "#141414"
					: "#ffffff",
			frame: chrome.frame,
			titleBarStyle: chrome.titleBarStyle,
			trafficLightPosition: chrome.trafficLightPosition,
			hasShadow: !isDisplaySurface(options.label),
			resizable: options.resizable ?? true,
			alwaysOnTop: options.alwaysOnTop ?? false,
			skipTaskbar: options.skipTaskbar ?? false,
			webPreferences: {
				preload: this.preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				additionalArguments: [
					`--cap-window-label=${options.label}`,
					`--cap-window-init=${Buffer.from(JSON.stringify(options.initialization ?? null)).toString("base64url")}`,
				],
			},
		});
		this.windowMetadata.set(window, {
			decorated: chrome.frame,
			loaded: false,
			pendingShow: options.visible === true,
			pendingFocus: options.focus === true,
		});
		window.setContentProtection(options.contentProtected ?? false);
		if (options.visibleOnAllWorkspaces) {
			window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		}
		this.windows.set(options.label, window);
		this.bind(options.label, window);
		this.load(window, options.route ?? "/");
		window.webContents.once("did-finish-load", () => {
			if (window.isDestroyed()) return;
			const metadata = this.windowMetadata.get(window);
			metadata.loaded = true;
			if (!metadata.pendingShow) return;
			window.show();
			if (metadata.pendingFocus) window.focus();
		});
		return window;
	}

	initialBounds(options) {
		const requestedDisplay = displayIdForOptions(options);
		if (requestedDisplay !== null && isDisplaySurface(options.label)) {
			const display = screen
				.getAllDisplays()
				.find(({ id }) => String(id) === requestedDisplay);
			// macOS refuses to position a normal BrowserWindow above the menu-bar
			// inset. Using full display bounds would therefore shift the window down
			// while retaining its full height, leaving the selection surface offset
			// and extending below the display.
			if (display)
				return {
					...(process.platform === "darwin"
						? display.workArea
						: display.bounds),
				};
		}
		return {
			x: options.x,
			y: options.y,
			width: options.width,
			height: options.height,
		};
	}

	load(window, route) {
		const normalized = route.startsWith("/") ? route : `/${route}`;
		if (this.devUrl) window.loadURL(`${this.devUrl}${normalized}`);
		else window.loadURL(`cap://app${normalized}`);
	}

	bind(label, window) {
		let lastScaleFactor = null;
		const update = () => {
			const state = this.sendState(label, window);
			if (
				state &&
				lastScaleFactor !== null &&
				state.scaleFactor !== lastScaleFactor
			) {
				this.sendWindowEvent(label, {
					type: "scaleFactorChanged",
					scaleFactor: state.scaleFactor,
				});
			}
			if (state) lastScaleFactor = state.scaleFactor;
		};
		window.on("ready-to-show", update);
		window.on("show", update);
		window.on("hide", update);
		window.on("focus", () => {
			update();
			this.sendWindowEvent(label, { type: "focused", focused: true });
		});
		window.on("blur", () => {
			update();
			this.sendWindowEvent(label, { type: "focused", focused: false });
		});
		window.on("move", () => {
			update();
			const { x, y } = this.physicalBounds(window);
			this.sendWindowEvent(label, { type: "moved", x, y });
		});
		window.on("resize", () => {
			update();
			const { width, height } = this.physicalBounds(window);
			this.sendWindowEvent(label, { type: "resized", width, height });
		});
		window.on("close", (event) => {
			if (this.allowAllClose || this.allowedToClose.has(window)) {
				this.allowedToClose.delete(window);
				return;
			}
			event.preventDefault();
			this.sendWindowEvent(label, { type: "closeRequested" });
		});
		window.on("closed", () => {
			this.windows.delete(label);
			this.sendWindowEvent(label, { type: "destroyed" });
		});
		window.webContents.on("did-finish-load", update);
	}

	sendState(label, window) {
		if (window.isDestroyed()) return null;
		const state = this.windowState(window);
		this.backend.send({
			type: "windowState",
			label,
			state,
		});
		return state;
	}

	sendWindowEvent(label, event) {
		this.backend.send({ type: "windowEvent", label, event });
		const window = this.windows.get(label);
		if (!window || window.isDestroyed()) return;
		const rendererEvent = rendererWindowEvent(event, window);
		if (rendererEvent) {
			window.webContents.send("cap:event", {
				type: "event",
				event: rendererEvent.name,
				payload: rendererEvent.payload,
				target: label,
			});
		}
	}

	receive(message) {
		if (message.type === "createWindow") this.create(message.options);
		if (message.type === "desktopOperation") {
			const window = this.windows.get(message.label);
			if (window && !window.isDestroyed())
				this.operation(window, message.operation);
		}
		if (message.type === "event") {
			for (const [label, window] of this.windows) {
				if (!message.target || message.target === label) {
					window.webContents.send("cap:event", message);
				}
			}
		}
		if (message.type === "channel") {
			for (const window of this.windows.values()) {
				window.webContents.send("cap:channel", message);
			}
		}
	}

	operation(window, operation) {
		const metadata = this.windowMetadata.get(window);
		switch (operation.type) {
			case "center":
				window.center();
				break;
			case "show":
				metadata.pendingShow = true;
				if (metadata.loaded) window.show();
				break;
			case "hide":
				metadata.pendingShow = false;
				metadata.pendingFocus = false;
				window.hide();
				break;
			case "close":
				this.allowedToClose.add(window);
				window.close();
				break;
			case "destroy":
				window.destroy();
				break;
			case "focus":
				metadata.pendingFocus = true;
				if (metadata.loaded) window.focus();
				break;
			case "minimize":
				window.minimize();
				break;
			case "unminimize":
				window.restore();
				break;
			case "maximize":
				window.maximize();
				break;
			case "unmaximize":
				window.unmaximize();
				break;
			case "setFullscreen":
				window.setFullScreen(operation.fullscreen);
				break;
			case "setAlwaysOnTop":
				window.setAlwaysOnTop(operation.alwaysOnTop);
				break;
			case "setContentProtected":
				window.setContentProtection(operation.enabled);
				break;
			case "setPosition": {
				const point = operation.physical
					? this.physicalPointToDip({ x: operation.x, y: operation.y }, window)
					: operation;
				window.setPosition(Math.round(point.x), Math.round(point.y));
				break;
			}
			case "setSize": {
				const size = operation.physical
					? this.physicalSizeToDip(operation, window)
					: operation;
				window.setSize(Math.round(size.width), Math.round(size.height));
				break;
			}
			case "setMinSize":
			case "setMinimumSize": {
				const size = operation.physical
					? this.physicalSizeToDip(operation, window)
					: operation;
				window.setMinimumSize(
					Math.round(size.width ?? 0),
					Math.round(size.height ?? 0),
				);
				break;
			}
			case "setTitle":
				window.setTitle(operation.title);
				break;
			case "setResizable":
				window.setResizable(operation.resizable);
				break;
			case "setSkipTaskbar":
				window.setSkipTaskbar(operation.skip);
				break;
			case "setIgnoreCursorEvents":
				window.setIgnoreMouseEvents(operation.ignore, { forward: true });
				break;
			case "setOpacity":
				window.setOpacity(operation.opacity);
				break;
			case "setTheme": {
				const source = ["system", "light", "dark"].includes(operation.theme)
					? operation.theme
					: "system";
				if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
				break;
			}
			case "setTrafficLightPosition":
				if (process.platform === "darwin")
					window.setWindowButtonPosition(
						operation.x === null || operation.x === undefined
							? null
							: { x: Math.round(operation.x), y: Math.round(operation.y) },
					);
				break;
			case "requestUserAttention":
				window.flashFrame(true);
				break;
			case "setProgress":
				window.setProgressBar(operation.progress ?? -1);
				break;
		}
	}

	get(label) {
		return this.windows.get(label);
	}

	cursorPosition() {
		return this.dipPointToPhysical(screen.getCursorScreenPoint());
	}

	windowState(window) {
		const dipBounds = window.getBounds();
		const display = screen.getDisplayMatching(dipBounds);
		const bounds = this.physicalBounds(window);
		const monitor = this.normalizeDisplay(display);
		return {
			nativeWindowId: nativeWindowId(window),
			...bounds,
			visible: window.isVisible(),
			focused: window.isFocused(),
			minimized: window.isMinimized(),
			maximized: window.isMaximized(),
			fullscreen: window.isFullScreen(),
			alwaysOnTop: window.isAlwaysOnTop(),
			resizable: window.isResizable(),
			decorated: this.windowMetadata.get(window)?.decorated ?? false,
			monitor: {
				name: monitor.name,
				x: monitor.position.x,
				y: monitor.position.y,
				width: monitor.size.width,
				height: monitor.size.height,
				workX: monitor.workArea.position.x,
				workY: monitor.workArea.position.y,
				workWidth: monitor.workArea.size.width,
				workHeight: monitor.workArea.size.height,
				scaleFactor: monitor.scaleFactor,
			},
		};
	}

	physicalBounds(window) {
		const bounds = window.getBounds();
		const display = screen.getDisplayMatching(bounds);
		const origin = physicalDisplayOrigin(display);
		return {
			x: Math.round(
				origin.x + (bounds.x - display.bounds.x) * display.scaleFactor,
			),
			y: Math.round(
				origin.y + (bounds.y - display.bounds.y) * display.scaleFactor,
			),
			width: Math.round(bounds.width * display.scaleFactor),
			height: Math.round(bounds.height * display.scaleFactor),
			scaleFactor: display.scaleFactor,
		};
	}

	physicalPointToDip(point, window) {
		const display =
			displayForPhysicalPoint(point) ??
			screen.getDisplayMatching(
				window?.getBounds() ?? screen.getPrimaryDisplay().bounds,
			);
		const origin = physicalDisplayOrigin(display);
		return {
			x: display.bounds.x + (point.x - origin.x) / display.scaleFactor,
			y: display.bounds.y + (point.y - origin.y) / display.scaleFactor,
		};
	}

	physicalSizeToDip(size, window) {
		const display = screen.getDisplayMatching(window.getBounds());
		return {
			width:
				size.width === null || size.width === undefined
					? size.width
					: size.width / display.scaleFactor,
			height:
				size.height === null || size.height === undefined
					? size.height
					: size.height / display.scaleFactor,
		};
	}

	dipPointToPhysical(point) {
		const display = screen.getDisplayNearestPoint(point);
		const origin = physicalDisplayOrigin(display);
		return {
			x: Math.round(
				origin.x + (point.x - display.bounds.x) * display.scaleFactor,
			),
			y: Math.round(
				origin.y + (point.y - display.bounds.y) * display.scaleFactor,
			),
		};
	}

	normalizeDisplay(display) {
		const bounds = displayRectToPhysical(display.bounds, display);
		const workArea = displayRectToPhysical(display.workArea, display);
		return {
			name: display.label || null,
			scaleFactor: display.scaleFactor,
			position: { x: bounds.x, y: bounds.y },
			size: { width: bounds.width, height: bounds.height },
			workArea: {
				position: { x: workArea.x, y: workArea.y },
				size: { width: workArea.width, height: workArea.height },
			},
		};
	}

	displayFromPhysicalPoint(point) {
		return displayForPhysicalPoint(point) ?? screen.getPrimaryDisplay();
	}

	beginQuit() {
		this.allowAllClose = true;
	}
}

function finite(value) {
	return Number.isFinite(value) ? Math.round(value) : undefined;
}

function nativeWindowId(window) {
	const sourceId = window.getMediaSourceId();
	const match = /^window:(\d+):/.exec(sourceId);
	return match ? Number(match[1]) : null;
}

function isDisplaySurface(label) {
	return (
		label.startsWith("target-select-overlay-") ||
		label.startsWith("window-capture-occluder-") ||
		label === "capture-area"
	);
}

function displayIdForOptions(options) {
	const prefixes = ["target-select-overlay-", "window-capture-occluder-"];
	for (const prefix of prefixes) {
		if (options.label.startsWith(prefix))
			return options.label.slice(prefix.length);
	}
	if (options.label !== "capture-area") return null;
	try {
		return new URL(options.route, "cap://app").searchParams.get("screenId");
	} catch {
		return null;
	}
}

function shouldUseTransparentSurface(options) {
	return (
		options.transparent === true &&
		!["main", "onboarding"].includes(options.label)
	);
}

function nativeWindowChrome(label) {
	if (process.platform !== "darwin") return { frame: false };
	if (label.startsWith("editor-") || label.startsWith("screenshot-editor-")) {
		return {
			frame: true,
			titleBarStyle: "hidden",
			trafficLightPosition: { x: 20, y: 24 },
		};
	}
	if (label === "settings") {
		return {
			frame: true,
			titleBarStyle: "hidden",
			trafficLightPosition: { x: 22, y: 14 },
		};
	}
	if (label === "teleprompter") {
		return {
			frame: true,
			titleBarStyle: "hidden",
			trafficLightPosition: { x: 14, y: 14 },
		};
	}
	if (["upgrade", "mode-select", "debug"].includes(label)) {
		return { frame: true, titleBarStyle: "hidden" };
	}
	return { frame: false };
}

function physicalDisplayOrigin(display) {
	if (
		Number.isFinite(display.nativeOrigin?.x) &&
		Number.isFinite(display.nativeOrigin?.y)
	) {
		return display.nativeOrigin;
	}
	return {
		x: Math.round(display.bounds.x * display.scaleFactor),
		y: Math.round(display.bounds.y * display.scaleFactor),
	};
}

function displayRectToPhysical(rect, display) {
	const origin = physicalDisplayOrigin(display);
	return {
		x: Math.round(origin.x + (rect.x - display.bounds.x) * display.scaleFactor),
		y: Math.round(origin.y + (rect.y - display.bounds.y) * display.scaleFactor),
		width: Math.round(rect.width * display.scaleFactor),
		height: Math.round(rect.height * display.scaleFactor),
	};
}

function displayForPhysicalPoint(point) {
	return screen.getAllDisplays().find((display) => {
		const bounds = displayRectToPhysical(display.bounds, display);
		return (
			point.x >= bounds.x &&
			point.x < bounds.x + bounds.width &&
			point.y >= bounds.y &&
			point.y < bounds.y + bounds.height
		);
	});
}

function rendererWindowEvent(event, window) {
	switch (event.type) {
		case "closeRequested":
			return { name: "tauri://close-requested", payload: null };
		case "destroyed":
			return { name: "tauri://destroyed", payload: null };
		case "focused":
			return { name: "tauri://focus", payload: event.focused };
		case "moved":
			return { name: "tauri://move", payload: { x: event.x, y: event.y } };
		case "resized":
			return {
				name: "tauri://resize",
				payload: { width: event.width, height: event.height },
			};
		case "scaleFactorChanged": {
			const [width, height] = window.getSize();
			return {
				name: "tauri://scale-change",
				payload: {
					scaleFactor: event.scaleFactor,
					size: {
						width: Math.round(width * event.scaleFactor),
						height: Math.round(height * event.scaleFactor),
					},
				},
			};
		}
		case "themeChanged":
			return { name: "tauri://theme-changed", payload: event.theme };
		case "dragDrop":
			return {
				name: "tauri://drag-drop",
				payload: { type: "drop", paths: event.paths },
			};
		default:
			return null;
	}
}

module.exports = { WindowManager };
