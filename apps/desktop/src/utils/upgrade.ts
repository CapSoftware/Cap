import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import * as shell from "@tauri-apps/plugin-shell";
import { generalSettingsStore } from "~/store";
import { clientEnv } from "./env";

export async function openUpgradePage() {
	const settings = await generalSettingsStore.get();
	const url = new URL(
		"/pricing",
		settings?.serverUrl ?? clientEnv.VITE_SERVER_URL,
	);
	url.searchParams.set("utm_source", "desktop");
	url.searchParams.set("utm_campaign", "upgrade");
	await shell.open(url.toString());
	await WebviewWindow.getByLabel("main")
		.then((window) => window?.hide())
		.catch(() => {});
}
