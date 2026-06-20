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

async function initApp() {
	if (
		import.meta.env.DEV &&
		import.meta.env.VITE_SOLID_DEVTOOLS &&
		window.location.pathname.startsWith("/editor")
	) {
		const { attachDevtoolsOverlay } = await import("@solid-devtools/overlay");
		attachDevtoolsOverlay();
	}

	const app = document.getElementById("app");
	if (!app) throw new Error("App root element not found");

	mount(() => <StartClient />, app);
	initPlatformClass();
}

void initApp();
