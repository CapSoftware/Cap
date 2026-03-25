// @refresh reload
import { mount, StartClient } from "@solidjs/start/client";

async function initApp() {
	try {
		const { type } = await import("@tauri-apps/plugin-os");
		const osType = type();
		document.documentElement.classList.add(`platform-${osType}`);
	} catch (error) {
		console.error("Failed to get OS type:", error);
	}

	const app = document.getElementById("app");
	if (!app) throw new Error("App root element not found");

	mount(() => <StartClient />, app);
}

initApp();
