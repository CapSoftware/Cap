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

	mount(() => <StartClient />, document.getElementById("app")!);
}

initApp();
