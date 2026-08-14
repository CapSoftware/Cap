const { contextBridge, ipcRenderer, webUtils } = require("electron");

const labelArgument = process.argv.find((argument) =>
	argument.startsWith("--cap-window-label="),
);
const initArgument = process.argv.find((argument) =>
	argument.startsWith("--cap-window-init="),
);
const windowLabel =
	labelArgument?.slice("--cap-window-label=".length) ?? "main";
const encodedInitialization = initArgument?.slice("--cap-window-init=".length);
const normalizedInitialization = encodedInitialization
	?.replaceAll("-", "+")
	.replaceAll("_", "/")
	.padEnd(Math.ceil(encodedInitialization.length / 4) * 4, "=");
const initialization = initArgument
	? JSON.parse(Buffer.from(normalizedInitialization, "base64").toString("utf8"))
	: null;

const eventListeners = new Map();
const channelListeners = new Set();

ipcRenderer.on("cap:event", (_event, message) => {
	const listeners = eventListeners.get(message.event);
	if (!listeners) return;
	for (const listener of listeners) listener(message);
});
ipcRenderer.on("cap:channel", (_event, message) => {
	for (const listener of channelListeners) listener(message);
});

window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => {
	event.preventDefault();
	const paths = [...(event.dataTransfer?.files ?? [])]
		.map((file) => webUtils.getPathForFile(file))
		.filter(Boolean);
	if (paths.length > 0)
		ipcRenderer.send("cap:window-drop", { windowLabel, paths });
});

contextBridge.exposeInMainWorld("capElectron", {
	windowLabel,
	initialization,
	os: {
		arch:
			{ x64: "x86_64", arm64: "aarch64", ia32: "x86" }[process.arch] ??
			process.arch,
		platform: process.platform,
		type:
			{ darwin: "macos", win32: "windows", linux: "linux" }[process.platform] ??
			process.platform,
		version: process.getSystemVersion?.() ?? "",
	},
	invoke: (command, arguments_) =>
		ipcRenderer.invoke("cap:invoke", {
			windowLabel,
			command,
			arguments: arguments_,
		}),
	native: (operation, payload) =>
		ipcRenderer.invoke("cap:native", { windowLabel, operation, payload }),
	emit: (event, payload) =>
		ipcRenderer.send("cap:emit", { windowLabel, event, payload }),
	onEvent: (event, listener) => {
		let listeners = eventListeners.get(event);
		if (!listeners) {
			listeners = new Set();
			eventListeners.set(event, listeners);
			ipcRenderer.send("cap:event-subscribe", { windowLabel, event });
		}
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size > 0) return;
			eventListeners.delete(event);
			ipcRenderer.send("cap:event-unsubscribe", { windowLabel, event });
		};
	},
	onChannel: (listener) => {
		channelListeners.add(listener);
		return () => channelListeners.delete(listener);
	},
});
contextBridge.exposeInMainWorld("__CAP__", initialization ?? {});
contextBridge.exposeInMainWorld("COUNTDOWN", initialization?.countdown ?? 0);
contextBridge.exposeInMainWorld("FLAGS", { captions: false });
