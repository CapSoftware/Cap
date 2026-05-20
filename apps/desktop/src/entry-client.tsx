// @refresh reload
import { mount, StartClient } from "@solidjs/start/client";

function initPlatformClass() {
	import("@tauri-apps/plugin-os")
		.then(({ type }) => {
			const osType = type();
			document.documentElement.classList.add(`platform-${osType}`);
		})
		.catch((error) => {
			console.error("Failed to get OS type:", error);
		});
}

function initApp() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App root element not found");

	mount(() => <StartClient />, app);
	initPlatformClass();
}

initApp();
